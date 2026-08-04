// ============================================================================
// OPERATION BLACKOUT - LEVEL 9 "ZUBAIR REFINERY" - set dressing
// Module owner: props_refinery.  Exports GAME.PropsRefinery.
//
// level_refinery.js builds a petrochemical PLANT: racks, columns, tanks, a
// flare, a pump house.  What it cannot build - because it is process
// equipment, not housekeeping - is the evidence that people work there.  That
// is this file: the drums stacked against a rack leg because that is where the
// forklift could reach, the cones taped round a lifted floor plate, the pipe
// spools waiting on dunnage in the laydown yard, the sand that has been
// blowing against the same bund wall for nine years.
//
// Design constraints that shaped the code:
//
//   * < 80 draw calls for ALL props.  Everything repeated is an InstancedMesh;
//     everything one-off is merged per material into a handful of static
//     batches.  Counted in _commit and published on this.stats.
//
//   * NOTHING FLOATS AND NOTHING SITS LEVEL ON A SLOPE.  The site falls 0.45 m
//     to the south, is crowned over the carriageway, dished inside the bunds
//     and stepped 0.3-0.4 m onto six kerbed plinths.  Every placement measures
//     the ground across ITS OWN FOOTPRINT (_surface) and settles to the
//     measured normal; a footprint spanning more relief than the prop can
//     bridge is rejected outright, which is what keeps a drum off a kerb line.
//
//   * PLACEMENT IS CAUSAL, never uniform scatter.  Sand drifts on the windward
//     faces of walls and in the wind shadow of every rack leg; litter collects
//     in corners and against kerbs; wear and stains follow the walking lines
//     between the door, the pump row and the road; heavy plant stands where a
//     truck could reach it; safety kit stands where the process is, at the head
//     of a stair or beside a manifold.
//
//   * THIS LEVEL IS BONE DRY.  The vertex wear contract is R grime, G wetness,
//     B edge wear, and G is written near 1.0 everywhere except the handful of
//     hydrocarbon spills that are meant to look wet.  A refinery at dusk in the
//     desert reads as DUST: grime heavy at every base, sand-coloured, worst on
//     up-faces and in the lee of things.
//
//   * ENV PROBE IS NEARLY DEAD.  The sun is 6.8 degrees below the horizon, so
//     metalness above ~0.6 renders as a black cut-out with two specular dots.
//     Every prop metal here sits at 0.30-0.58 with envMapIntensity lifted,
//     exactly as level_refinery.js does, so the practicals have a diffuse term
//     to land on.
//
//   * lighting.js is at its 24-practical cap and the level owns all 24.  This
//     file therefore adds NO scene lights - only emissive fixture faces
//     (beacons, the tanker's marker lamps, the tell-tales on the MCC), which
//     cost nothing and read as sources under the bloom.
//
//   * Every cross-module call is guarded.  ctx.level, ctx.materials and
//     ctx.weather may be missing or broken; we degrade, never throw.
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  if (!GAME || !THREE) return;

  var M = GAME.Math;
  var Geo = GAME.Geo;

  // --------------------------------------------------------------------------
  // Scratch.  A few thousand placements run through here at build time; one
  // Matrix4 per placement is a measurable slice of the boot budget.
  // --------------------------------------------------------------------------
  var _m4 = new THREE.Matrix4();
  var _m4b = new THREE.Matrix4();
  var _qt = new THREE.Quaternion();
  var _qs = new THREE.Quaternion();
  var _eu = new THREE.Euler();
  var _vp = new THREE.Vector3();
  var _vs = new THREE.Vector3();
  var _va = new THREE.Vector3();
  var _vb = new THREE.Vector3();
  var _vc = new THREE.Vector3();
  var _vd = new THREE.Vector3();
  var _vn = new THREE.Vector3();
  var _col = new THREE.Color();
  var _bmin = new THREE.Vector3();
  var _bmax = new THREE.Vector3();
  var _rayO = new THREE.Vector3();
  var _rayD = new THREE.Vector3(0, -1, 0);

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

  // A prop standing on ground whose normal is `n`.  The tilt is applied in
  // WORLD space and the yaw in the prop's own, which is the only order that
  // stays correct for a rotated prop - composing them the other way round
  // leans a barrel downhill in one heading and uphill in the opposite one.
  function settleT(px, py, pz, yaw, n, sx, sy, sz) {
    _vd.copy(n);
    if (!(_vd.lengthSq() > 1e-9)) _vd.set(0, 1, 0);
    _vd.normalize();
    _qs.setFromUnitVectors(UP, _vd);
    _eu.set(0, yaw || 0, 0, 'YXZ');
    _qt.setFromEuler(_eu);
    _qs.multiply(_qt);
    _vp.set(px, py, pz);
    _vs.set(sx === undefined ? 1 : sx, sy === undefined ? 1 : sy, sz === undefined ? 1 : sz);
    return _m4.compose(_vp, _qs, _vs);
  }

  // Unit-height Y-up primitive mapped onto the segment a->b.  "From here to
  // there" is how a brace, a conduit or a stay is actually described.
  function strutT(ax, ay, az, bx, by, bz) {
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
    catch (e) { GAME.logError('propsR.merge', e); return null; }
    return g;
  }

  function disposeParts(parts) {
    var seen = new Set();
    for (var i = 0; i < parts.length; i++) {
      var g = parts[i].geometry;
      if (g && !seen.has(g) && g.dispose) { seen.add(g); g.dispose(); }
    }
    parts.length = 0;
  }

  // --------------------------------------------------------------------------
  // Primitive cache.  A drum is 14 primitives and there are nine kit items that
  // want a 12-segment cylinder; generating each one fresh costs more than the
  // whole placement pass.  Entries are CLONED out, because mergeAll consumes
  // (and may convert) what it is handed.
  // --------------------------------------------------------------------------
  var _geoCache = new Map();
  function cached(key, make) {
    var g = _geoCache.get(key);
    if (!g) { g = make(); _geoCache.set(key, g); }
    return g.clone();
  }
  function box(w, h, d, bevel) {
    return cached('b' + w + '_' + h + '_' + d + '_' + (bevel || 0), function () {
      return bevel ? Geo.bevelBox(w, h, d, bevel, 1) : new THREE.BoxGeometry(w, h, d);
    });
  }
  function cyl(r0, r1, h, seg, open) {
    return cached('c' + r0 + '_' + r1 + '_' + h + '_' + seg + '_' + (open ? 1 : 0), function () {
      return new THREE.CylinderGeometry(r0, r1, h, seg || 12, 1, !!open);
    });
  }
  function tor(r, tube, seg, tub) {
    return cached('t' + r + '_' + tube + '_' + seg + '_' + tub, function () {
      return new THREE.TorusGeometry(r, tube, seg || 6, tub || 14);
    });
  }
  function sph(r, wseg, hseg, phiLen, thetaStart, thetaLen) {
    return cached('s' + r + '_' + wseg + '_' + hseg + '_' + (phiLen || 0) + '_' +
      (thetaStart || 0) + '_' + (thetaLen || 0), function () {
      return new THREE.SphereGeometry(r, wseg || 12, hseg || 8,
        0, phiLen === undefined ? Math.PI * 2 : phiLen,
        thetaStart || 0, thetaLen === undefined ? Math.PI : thetaLen);
    });
  }
  function plane(w, h) {
    return cached('p' + w + '_' + h, function () { return new THREE.PlaneGeometry(w, h); });
  }
  function clearGeoCache() {
    _geoCache.forEach(function (g) { if (g.dispose) g.dispose(); });
    _geoCache.clear();
  }

  // --------------------------------------------------------------------------
  // Displace every vertex by fbm.  The cheapest way to stop a primitive reading
  // as a primitive: a drum that has been rolled round a plant for a decade does
  // not have a circular section, and a sand drift is not a hemisphere.
  // --------------------------------------------------------------------------
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
          p.setXYZ(i, x * s, y + n1 * amount * 0.18, z * s);
        }
      } else if (mode === 'dome') {
        var n2 = noise.fbm3(x * freq * 1.7 + 9.1, y * freq, z * freq * 1.7 - 4.4, 3, 2.2, 0.5);
        p.setXYZ(i, x * (1 + n1 * amount), y * (1 + n2 * amount * 1.6), z * (1 + n2 * amount));
      } else {
        var m2 = noise.fbm3(x * freq + 31.7, y * freq - 11.3, z * freq + 5.1, 3, 2.1, 0.55);
        var m3 = noise.fbm3(x * freq - 7.9, y * freq + 23.4, z * freq - 17.2, 3, 2.1, 0.55);
        p.setXYZ(i, x + n1 * amount, y + m2 * amount, z + m3 * amount);
      }
    }
    p.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
  }

  // A closed 2D profile extruded along Z with fan caps.  Jersey barriers, kerb
  // sections, channel steel, the tanker's chassis rails.
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

  // --------------------------------------------------------------------------
  // THE WEAR / DUST VERTEX CHANNEL
  //
  // materials.js get(name, {vertexColors:true}) reads the geometry `color`
  // attribute as a wear mask, white = pristine:
  //
  //     R -> grime / dust    G -> wetness    B -> edge wear / bare substrate
  //
  // so each channel is written as 1 - amount.  On THIS level G stays at 1
  // (bone dry) unless a caller asks for a hydrocarbon film; what carries the
  // level is R, and it is written PHYSICALLY: dust settles on up-faces, banks
  // up at the base of everything, and is scoured off the edges that get
  // handled - which is also where B comes up.
  //
  // Geo.mergeAll keeps only position/normal/uv, so merged geometry must be
  // painted AFTER the merge.  Every caller here does.
  // --------------------------------------------------------------------------
  function paintWear(geo, o) {
    var p = geo.attributes.position, n = geo.attributes.normal;
    if (!p || !n) return geo;
    o = o || {};
    var grime = o.grime === undefined ? 0.34 : o.grime;
    var edge = o.edge === undefined ? 0.20 : o.edge;
    var wet = o.wet === undefined ? 0.0 : o.wet;
    var dust = o.dust === undefined ? 0.55 : o.dust;   // extra on up-faces
    var noise = o.noise || null;
    var ph = o.seed || 0;
    var loY = o.loY === undefined ? 0 : o.loY;
    var hiY = o.hiY === undefined ? 1.4 : o.hiY;
    var c = new Float32Array(p.count * 3);
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      var ny = n.getY(i);
      var up = M.saturate(ny);
      // dust lands on horizontals and rolls off verticals and undersides
      var expo = 0.28 + 0.72 * up * up;
      // and it banks at the base, where the wind drops it and boots kick it up
      var lowness = 1 - M.saturate((y - loY) / Math.max(0.2, hiY - loY));
      var gr = grime * (0.30 + 0.85 * lowness * lowness) + dust * grime * expo;
      // edge wear rides the up-facing extremities: the rim of a drum, the lip
      // of a crate, the corners a fork truck actually hits
      var reach = M.saturate((Math.sqrt(x * x + z * z) - 0.08) * 1.5);
      var ed = edge * (0.22 + 0.88 * reach) * (0.30 + 0.80 * up);
      var w = wet * (0.35 + 0.65 * expo);
      if (noise) {
        var nv = noise.fbm3(x * 2.6 + ph, y * 2.6, z * 2.6 - ph, 3, 2.1, 0.55);
        gr = gr * (1 + nv * 0.95);
        ed = ed * (1 + nv * 1.15);
        w = w * (1 + nv * 0.35);
      }
      c[i * 3] = M.saturate(1 - M.saturate(gr));
      c[i * 3 + 1] = M.saturate(1 - M.saturate(w));
      c[i * 3 + 2] = M.saturate(1 - M.saturate(ed));
    }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return geo;
  }

  // Per-instance modulation of the same three channels: this multiplies the
  // vertex mask, so 1.0 leaves a channel alone.  It is jitter, not a second
  // coat, and it is the difference between 60 drums and one drum 60 times.
  function wearTint(rng, out, extraGrime) {
    out = out || _col;
    out.setRGB(
      1 - rng.range(0, 0.26) - (extraGrime || 0),
      1 - rng.range(0, 0.05),
      1 - rng.range(0, 0.22));
    out.r = M.clamp(out.r, 0.25, 1);
    return out;
  }

  // ==========================================================================
  // Batch - InstancedMesh that counts up as you place, and SHOUTS if it fills.
  // An overflowing batch silently drops everything after the cap, which is
  // invisible until somebody counts; this counts.
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
    // slot can render black depending on three's fill policy.
    this.mesh.setColorAt(this.n, color || WHITE);
    this.n++;
    return true;
  };
  Batch.prototype.finish = function (parent, name) {
    if (this.n === 0) { this.mesh.dispose(); return null; }
    this.mesh.count = this.n;
    this.mesh.name = name || 'refinery_inst';
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
  // fixes.  What is generated here is props-specific ART the shared library
  // cannot know about: the hazard diagonals, the site's invented signage, the
  // ground marks (oil, scuff, sprayed inspection crosses), a barrier-tape
  // alpha and a soft puff for the vent steam.
  // ==========================================================================
  var TX = {};

  TX.canvas = function (w, h) {
    if (typeof document === 'undefined') return null;
    var c = document.createElement('canvas');
    c.width = w; c.height = h || w;
    return c;
  };

  TX.tex = function (canvas, srgb, rx, ry, aniso) {
    if (!canvas) return null;
    var t = new THREE.CanvasTexture(canvas);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx || 1, ry || rx || 1);
    t.anisotropy = aniso || 8;
    t.needsUpdate = true;
    return t;
  };

  // Tileable grunge, composited as a multiply layer under everything local.
  TX.grunge = function (size, seed, contrast) {
    var c = TX.canvas(size);
    if (!c) return null;
    var g = c.getContext('2d');
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
        var w = noise.worley2(x * inv * 6 + 3, y * inv * 6 - 2, 1.0);
        n = n * 0.74 + (w.edge - 0.34) * 0.26;
        var val = M.saturate(0.5 + n * (contrast || 1.1));
        var i = (y * size + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = val * 255;
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  };

  // ---- invented script -----------------------------------------------------
  // Deliberately NOT any real alphabet, operator or logo: connected baseline
  // strokes with ascenders and diacritic dots, which reads as "plant signage in
  // a language I do not speak" without impersonating anybody.
  TX.scriptRun = function (g, x, y, size, width, rng, weight) {
    g.lineWidth = Math.max(1, size * (weight || 0.16));
    g.lineCap = 'round';
    g.lineJoin = 'round';
    var cx = x, end = x + width, dots = [], guard = 0;
    g.beginPath();
    g.moveTo(cx, y);
    while (cx < end && guard++ < 48) {
      var w = size * rng.range(0.40, 0.92);
      if (cx + w > end) w = end - cx;
      var mode = rng.int(0, 5);
      if (mode === 0) g.quadraticCurveTo(cx + w * 0.5, y - size * 0.60, cx + w, y);
      else if (mode === 1) { g.lineTo(cx + w * 0.32, y - size * 0.72); g.lineTo(cx + w, y); }
      else if (mode === 2) g.quadraticCurveTo(cx + w * 0.5, y + size * 0.40, cx + w, y);
      else if (mode === 3) g.bezierCurveTo(cx + w * 0.15, y - size * 0.82, cx + w * 0.85, y - size * 0.18, cx + w, y);
      else if (mode === 4) {
        g.lineTo(cx + w * 0.5, y); g.lineTo(cx + w * 0.5, y - size * 0.55);
        g.moveTo(cx + w * 0.5, y); g.lineTo(cx + w, y);
      } else g.lineTo(cx + w, y);
      if (rng.bool(0.32)) dots.push([cx + w * 0.5, y - size * (rng.bool(0.6) ? 0.92 : -0.32), size * 0.085]);
      cx += w;
      if (rng.bool(0.13)) { cx += size * 0.32; g.moveTo(cx, y); }
    }
    g.stroke();
    for (var i = 0; i < dots.length; i++) {
      g.beginPath();
      g.arc(dots[i][0], dots[i][1], dots[i][2], 0, Math.PI * 2);
      g.fill();
    }
  };

  // Stencilled equipment numbers: invented, monospaced, sprayed through a plate.
  TX.stencilRun = function (g, x, y, cell, count, rng) {
    for (var i = 0; i < count; i++) {
      var ox = x + i * cell * 1.18;
      var seg = rng.int(0, 63) | 1;
      g.lineWidth = Math.max(1, cell * 0.20);
      g.lineCap = 'butt';
      var h = cell * 1.5, w = cell * 0.80;
      var S = [
        [0, 0, 1, 0], [1, 0, 1, 0.5], [1, 0.5, 1, 1], [0, 1, 1, 1],
        [0, 0.5, 0, 1], [0, 0, 0, 0.5], [0.14, 0.5, 0.86, 0.5]
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

  // ---- hazard diagonals ----------------------------------------------------
  // Yellow/black, worn through to primer where boots, forks and hoses hit it.
  TX.hazard = function (size, seed, grunge) {
    var c = TX.canvas(size, size);
    if (!c) return null;
    var g = c.getContext('2d');
    var rng = new GAME.RNG(seed);
    g.fillStyle = '#b89a3a';
    g.fillRect(0, 0, size, size);
    g.save();
    g.translate(size * 0.5, size * 0.5);
    g.rotate(-Math.PI / 4);
    g.translate(-size, -size);
    var band = size * 0.185;
    g.fillStyle = '#1d1c1b';
    for (var i = 0; i < 16; i++) g.fillRect(i * band * 2, 0, band, size * 2);
    g.restore();
    g.globalAlpha = 0.55;
    for (var k = 0; k < 110; k++) {
      var x = rng.range(0, size), y = rng.range(0, size);
      var r = rng.range(1, 6);
      g.fillStyle = rng.bool(0.5) ? '#5a5b5c' : '#6d5b42';
      g.beginPath();
      g.ellipse(x, y, r, r * rng.range(0.5, 1.4), rng.range(0, 3.14), 0, 6.2832);
      g.fill();
    }
    g.globalAlpha = 1;
    if (grunge) {
      g.globalCompositeOperation = 'multiply';
      g.globalAlpha = 0.52;
      g.drawImage(grunge, 0, 0, size, size);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
    }
    return c;
  };

  // ---- barrier tape --------------------------------------------------------
  // Red/white chevrons on a translucent polythene ribbon, with the tears and
  // the stretched-out sag a tape that has been up for a fortnight has.
  TX.tape = function (w, h, seed) {
    var c = TX.canvas(w, h);
    if (!c) return null;
    var g = c.getContext('2d');
    var rng = new GAME.RNG(seed);
    g.fillStyle = '#d8d3c6';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#a8322a';
    var band = w * 0.085;
    g.save();
    for (var i = -2; i < 24; i++) {
      g.beginPath();
      g.moveTo(i * band * 2, 0);
      g.lineTo(i * band * 2 + band, 0);
      g.lineTo(i * band * 2 + band + h * 0.6, h);
      g.lineTo(i * band * 2 + h * 0.6, h);
      g.closePath();
      g.fill();
    }
    g.restore();
    // creases and dirt
    g.globalAlpha = 0.30;
    g.strokeStyle = '#4a463c';
    for (var k = 0; k < 26; k++) {
      g.lineWidth = rng.range(0.6, 2.0);
      g.beginPath();
      var x = rng.range(0, w);
      g.moveTo(x, 0); g.lineTo(x + rng.range(-6, 6), h);
      g.stroke();
    }
    g.globalAlpha = 1;
    return c;
  };

  // ---- ground / prop mark atlas -------------------------------------------
  // 4 x 4 alpha cells.  On a site made of grey concrete and grey steel this is
  // most of the legibility below eye level, and it is the only high-frequency
  // chroma on the apron.
  var MARK = {
    oil: 0, scuff: 1, cross: 2, drip: 3,
    danger: 4, flam: 5, nosmoke: 6, unitno: 7,
    band: 8, sand: 9, arrow: 10, ppe: 11,
    logo: 12, grime: 13, tread: 14, plate: 15
  };
  var MARK_N = 4;

  TX.markAtlas = function (px, seed, grunge) {
    var c = TX.canvas(px, px);
    if (!c) return null;
    var g = c.getContext('2d');
    var rng = new GAME.RNG(seed);
    var cell = px / MARK_N;
    g.clearRect(0, 0, px, px);

    function at(idx) {
      return { x: (idx % MARK_N) * cell, y: Math.floor(idx / MARK_N) * cell };
    }
    function blob(o, cx, cy, r, fill, wob, alpha) {
      g.globalAlpha = alpha === undefined ? 1 : alpha;
      g.fillStyle = fill;
      g.beginPath();
      for (var a = 0; a <= 40; a++) {
        var th = a / 40 * Math.PI * 2;
        var rr = r * (1 + Math.sin(th * 3.1 + wob) * 0.22 + Math.sin(th * 7.3 - wob * 2) * 0.13);
        var px2 = o.x + cx + Math.cos(th) * rr, py2 = o.y + cy + Math.sin(th) * rr * 0.86;
        if (a === 0) g.moveTo(px2, py2); else g.lineTo(px2, py2);
      }
      g.closePath();
      g.fill();
      g.globalAlpha = 1;
    }

    // ---- 0 oil stain: a soaked-in pool with a darker core and a sheen rim ----
    var o = at(MARK.oil);
    blob(o, cell * 0.5, cell * 0.5, cell * 0.40, 'rgba(38,31,26,0.44)', 0.4);
    blob(o, cell * 0.47, cell * 0.52, cell * 0.27, 'rgba(20,16,13,0.58)', 2.1);
    blob(o, cell * 0.52, cell * 0.46, cell * 0.13, 'rgba(10,9,8,0.70)', 5.0);
    g.globalAlpha = 0.14;
    for (var d0 = 0; d0 < 22; d0++) {
      blob(o, cell * rng.range(0.15, 0.85), cell * rng.range(0.15, 0.85),
        cell * rng.range(0.012, 0.05), 'rgba(24,20,17,0.85)', rng.range(0, 6));
    }
    g.globalAlpha = 1;

    // ---- 1 tyre scuff --------------------------------------------------------
    o = at(MARK.scuff);
    g.save();
    g.beginPath(); g.rect(o.x, o.y, cell, cell); g.clip();
    for (var s1 = 0; s1 < 2; s1++) {
      g.strokeStyle = 'rgba(30,27,24,0.34)';
      g.lineWidth = cell * 0.085;
      g.beginPath();
      for (var t1 = 0; t1 <= 20; t1++) {
        var f = t1 / 20;
        var xx = o.x + cell * (0.08 + f * 0.86);
        var yy = o.y + cell * (0.32 + s1 * 0.30 + Math.sin(f * 2.6) * 0.10 * (1 - f));
        if (t1 === 0) g.moveTo(xx, yy); else g.lineTo(xx, yy);
      }
      g.stroke();
    }
    g.restore();

    // ---- 2 sprayed inspection cross -----------------------------------------
    o = at(MARK.cross);
    g.strokeStyle = 'rgba(216,196,120,0.80)';
    g.lineWidth = cell * 0.05;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(o.x + cell * 0.28, o.y + cell * 0.30); g.lineTo(o.x + cell * 0.70, o.y + cell * 0.68);
    g.moveTo(o.x + cell * 0.70, o.y + cell * 0.30); g.lineTo(o.x + cell * 0.30, o.y + cell * 0.68);
    g.stroke();
    g.fillStyle = 'rgba(216,196,120,0.70)';
    TX.stencilRun(g, o.x + cell * 0.30, o.y + cell * 0.72, cell * 0.10, 3, rng);
    g.strokeStyle = 'rgba(216,196,120,0.70)';
    TX.stencilRun(g, o.x + cell * 0.30, o.y + cell * 0.74, cell * 0.10, 3, rng);

    // ---- 3 vertical hydrocarbon drip / weep ---------------------------------
    o = at(MARK.drip);
    for (var d3 = 0; d3 < 16; d3++) {
      var dx3 = o.x + cell * rng.range(0.10, 0.90);
      var dl = cell * rng.range(0.25, 0.86);
      var gr3 = g.createLinearGradient(dx3, o.y + cell * 0.05, dx3, o.y + cell * 0.05 + dl);
      gr3.addColorStop(0, 'rgba(46,34,24,0.72)');
      gr3.addColorStop(0.5, 'rgba(34,26,20,0.45)');
      gr3.addColorStop(1, 'rgba(28,22,18,0)');
      g.fillStyle = gr3;
      var wgt = cell * rng.range(0.012, 0.045);
      g.fillRect(dx3 - wgt, o.y + cell * 0.05, wgt * 2, dl);
    }

    // ---- 4 DANGER placard ----------------------------------------------------
    o = at(MARK.danger);
    g.fillStyle = '#c8c2b2';
    g.fillRect(o.x + cell * 0.08, o.y + cell * 0.20, cell * 0.84, cell * 0.60);
    g.fillStyle = '#96302a';
    g.fillRect(o.x + cell * 0.08, o.y + cell * 0.20, cell * 0.84, cell * 0.18);
    g.fillStyle = '#e7e0d0';
    TX.scriptRun(g, o.x + cell * 0.14, o.y + cell * 0.315, cell * 0.10, cell * 0.72, rng, 0.20);
    g.strokeStyle = '#e7e0d0';
    TX.scriptRun(g, o.x + cell * 0.14, o.y + cell * 0.315, cell * 0.10, cell * 0.72, rng, 0.20);
    g.strokeStyle = '#26231f';
    g.fillStyle = '#26231f';
    TX.scriptRun(g, o.x + cell * 0.14, o.y + cell * 0.50, cell * 0.09, cell * 0.74, rng, 0.16);
    TX.scriptRun(g, o.x + cell * 0.14, o.y + cell * 0.66, cell * 0.09, cell * 0.60, rng, 0.16);
    g.strokeStyle = 'rgba(40,36,30,0.7)';
    g.lineWidth = cell * 0.012;
    g.strokeRect(o.x + cell * 0.08, o.y + cell * 0.20, cell * 0.84, cell * 0.60);

    // ---- 5 flammable diamond -------------------------------------------------
    o = at(MARK.flam);
    g.save();
    g.translate(o.x + cell * 0.5, o.y + cell * 0.5);
    g.rotate(Math.PI / 4);
    g.fillStyle = '#b23a24';
    g.fillRect(-cell * 0.30, -cell * 0.30, cell * 0.60, cell * 0.60);
    g.strokeStyle = '#e9e2d2';
    g.lineWidth = cell * 0.022;
    g.strokeRect(-cell * 0.26, -cell * 0.26, cell * 0.52, cell * 0.52);
    g.restore();
    g.fillStyle = '#f0e8d6';
    g.beginPath();
    g.moveTo(o.x + cell * 0.50, o.y + cell * 0.26);
    g.quadraticCurveTo(o.x + cell * 0.62, o.y + cell * 0.44, o.x + cell * 0.55, o.y + cell * 0.56);
    g.quadraticCurveTo(o.x + cell * 0.50, o.y + cell * 0.48, o.x + cell * 0.45, o.y + cell * 0.56);
    g.quadraticCurveTo(o.x + cell * 0.38, o.y + cell * 0.42, o.x + cell * 0.50, o.y + cell * 0.26);
    g.fill();
    g.fillStyle = '#f0e8d6';
    TX.stencilRun(g, o.x + cell * 0.42, o.y + cell * 0.64, cell * 0.07, 1, rng);

    // ---- 6 no smoking --------------------------------------------------------
    o = at(MARK.nosmoke);
    g.fillStyle = '#ddd7c8';
    g.beginPath(); g.arc(o.x + cell * 0.5, o.y + cell * 0.5, cell * 0.36, 0, 6.2832); g.fill();
    g.strokeStyle = '#a8322a';
    g.lineWidth = cell * 0.075;
    g.beginPath(); g.arc(o.x + cell * 0.5, o.y + cell * 0.5, cell * 0.32, 0, 6.2832); g.stroke();
    g.beginPath();
    g.moveTo(o.x + cell * 0.28, o.y + cell * 0.28); g.lineTo(o.x + cell * 0.72, o.y + cell * 0.72);
    g.stroke();
    g.fillStyle = '#3a3630';
    g.fillRect(o.x + cell * 0.32, o.y + cell * 0.47, cell * 0.30, cell * 0.06);

    // ---- 7 stencilled unit number -------------------------------------------
    o = at(MARK.unitno);
    g.strokeStyle = 'rgba(226,216,190,0.86)';
    TX.stencilRun(g, o.x + cell * 0.10, o.y + cell * 0.24, cell * 0.16, 4, rng);
    g.strokeStyle = 'rgba(226,216,190,0.72)';
    TX.stencilRun(g, o.x + cell * 0.10, o.y + cell * 0.58, cell * 0.11, 5, rng);

    // ---- 8 service colour band + line tag -----------------------------------
    o = at(MARK.band);
    g.fillStyle = '#3f6f52';
    g.fillRect(o.x, o.y + cell * 0.30, cell, cell * 0.40);
    g.fillStyle = '#d8d0bc';
    g.fillRect(o.x, o.y + cell * 0.30, cell, cell * 0.05);
    g.fillRect(o.x, o.y + cell * 0.65, cell, cell * 0.05);
    g.strokeStyle = '#e6dfcc';
    TX.stencilRun(g, o.x + cell * 0.16, o.y + cell * 0.40, cell * 0.09, 4, rng);

    // ---- 9 windblown sand smear ---------------------------------------------
    o = at(MARK.sand);
    for (var s9 = 0; s9 < 34; s9++) {
      var a9 = rng.range(0, Math.PI * 2);
      var r9 = Math.pow(rng.next(), 0.6) * cell * 0.46;
      blob(o, cell * 0.5 + Math.cos(a9) * r9 * 0.9, cell * 0.5 + Math.sin(a9) * r9 * 0.55,
        cell * rng.range(0.06, 0.19), 'rgba(150,128,92,0.19)', rng.range(0, 6),
        0.5 - r9 / (cell * 0.9));
    }

    // ---- 10 flow arrow -------------------------------------------------------
    o = at(MARK.arrow);
    g.fillStyle = 'rgba(226,216,190,0.88)';
    g.beginPath();
    g.moveTo(o.x + cell * 0.16, o.y + cell * 0.42);
    g.lineTo(o.x + cell * 0.62, o.y + cell * 0.42);
    g.lineTo(o.x + cell * 0.62, o.y + cell * 0.30);
    g.lineTo(o.x + cell * 0.88, o.y + cell * 0.50);
    g.lineTo(o.x + cell * 0.62, o.y + cell * 0.70);
    g.lineTo(o.x + cell * 0.62, o.y + cell * 0.58);
    g.lineTo(o.x + cell * 0.16, o.y + cell * 0.58);
    g.closePath();
    g.fill();

    // ---- 11 PPE pictogram ----------------------------------------------------
    o = at(MARK.ppe);
    g.fillStyle = '#2a4d86';
    g.beginPath(); g.arc(o.x + cell * 0.5, o.y + cell * 0.5, cell * 0.34, 0, 6.2832); g.fill();
    g.fillStyle = '#e8e2d2';
    g.beginPath();
    g.arc(o.x + cell * 0.5, o.y + cell * 0.56, cell * 0.20, Math.PI, 0);
    g.fill();
    g.fillRect(o.x + cell * 0.24, o.y + cell * 0.54, cell * 0.52, cell * 0.055);

    // ---- 12 operator's mark --------------------------------------------------
    o = at(MARK.logo);
    g.strokeStyle = 'rgba(210,198,170,0.80)';
    g.lineWidth = cell * 0.035;
    g.beginPath();
    g.arc(o.x + cell * 0.30, o.y + cell * 0.50, cell * 0.18, 0.4, 5.6);
    g.stroke();
    g.fillStyle = 'rgba(210,198,170,0.80)';
    TX.scriptRun(g, o.x + cell * 0.52, o.y + cell * 0.58, cell * 0.16, cell * 0.40, rng, 0.19);
    g.strokeStyle = 'rgba(210,198,170,0.80)';
    TX.scriptRun(g, o.x + cell * 0.52, o.y + cell * 0.58, cell * 0.16, cell * 0.40, rng, 0.19);

    // ---- 13 generic grime patch ---------------------------------------------
    o = at(MARK.grime);
    for (var g13 = 0; g13 < 26; g13++) {
      blob(o, cell * rng.range(0.2, 0.8), cell * rng.range(0.2, 0.8),
        cell * rng.range(0.08, 0.26), 'rgba(42,36,29,0.15)', rng.range(0, 6), 0.5);
    }

    // ---- 14 TYRE TRACK PAIR, TILING VERTICALLY -------------------------------
    // REPLACED. This was eleven boot ellipses, and the pump-house floor was
    // dressed with five of them stretched into a hard-edged "ladder" of evenly
    // spaced rungs at constant apparent width from the lens to the far wall -
    // railway sleepers, not rubber on dust.
    //
    // The cell is now a PAIR OF TREAD BANDS that runs the full height of the
    // cell and MATCHES AT TOP AND BOTTOM, so a chain of quads laid end to end
    // in world metres tiles seamlessly and the rung pitch is fixed in METRES.
    // Perspective then shortens it on its own, which is the whole point. The
    // lug edges are drawn at about 30% alpha so the track sits in the dust
    // instead of on it, and a pale displaced berm runs down each outer edge.
    o = at(MARK.tread);
    var TW = cell * 0.185;                  // tread width
    var TC = [cell * 0.295, cell * 0.705];  // the two track centres
    var LUG = cell / 9;                     // lug pitch: divides the cell, so it tiles
    for (var tk = 0; tk < 2; tk++) {
      var tcx = o.x + TC[tk];
      // the pale berm of displaced dust outside each track
      for (var bs = 0; bs < 2; bs++) {
        var bgx = tcx + (bs ? 1 : -1) * TW * 0.62;
        var bg2 = g.createLinearGradient(bgx - TW * 0.34, 0, bgx + TW * 0.34, 0);
        bg2.addColorStop(0, 'rgba(196,180,148,0.00)');
        bg2.addColorStop(0.5, 'rgba(196,180,148,0.30)');
        bg2.addColorStop(1, 'rgba(196,180,148,0.00)');
        g.fillStyle = bg2;
        g.fillRect(bgx - TW * 0.34, o.y, TW * 0.68, cell);
      }
      // the soft contact band, darkest at the centre of the tread
      var tg2 = g.createLinearGradient(tcx - TW * 0.5, 0, tcx + TW * 0.5, 0);
      tg2.addColorStop(0.00, 'rgba(30,26,22,0.00)');
      tg2.addColorStop(0.16, 'rgba(30,26,22,0.30)');
      tg2.addColorStop(0.50, 'rgba(26,22,19,0.46)');
      tg2.addColorStop(0.84, 'rgba(30,26,22,0.30)');
      tg2.addColorStop(1.00, 'rgba(30,26,22,0.00)');
      g.fillStyle = tg2;
      g.fillRect(tcx - TW * 0.5, o.y, TW, cell);
      // the lugs: darker in the valleys, skewed, and every few missing where
      // the tyre lifted
      for (var lg = 0; lg < 9; lg++) {
        if (rng.bool(0.13)) continue;
        var ly2 = o.y + lg * LUG + LUG * 0.16;
        var skew = (tk ? 1 : -1) * TW * 0.18;
        g.save();
        g.beginPath();
        g.moveTo(tcx - TW * 0.42, ly2);
        g.lineTo(tcx + TW * 0.42, ly2 + skew * 0.5);
        g.lineTo(tcx + TW * 0.42, ly2 + LUG * 0.52 + skew * 0.5);
        g.lineTo(tcx - TW * 0.42, ly2 + LUG * 0.52);
        g.closePath();
        g.fillStyle = 'rgba(20,17,15,' + rng.range(0.16, 0.30).toFixed(3) + ')';
        g.fill();
        g.restore();
      }
    }

    // ---- 15 manufacturer's data plate ---------------------------------------
    o = at(MARK.plate);
    g.fillStyle = 'rgba(168,166,158,0.95)';
    g.fillRect(o.x + cell * 0.14, o.y + cell * 0.28, cell * 0.72, cell * 0.44);
    g.strokeStyle = 'rgba(70,68,62,0.9)';
    g.lineWidth = cell * 0.014;
    g.strokeRect(o.x + cell * 0.14, o.y + cell * 0.28, cell * 0.72, cell * 0.44);
    g.strokeStyle = 'rgba(52,50,46,0.85)';
    TX.stencilRun(g, o.x + cell * 0.20, o.y + cell * 0.34, cell * 0.055, 6, rng);
    TX.stencilRun(g, o.x + cell * 0.20, o.y + cell * 0.50, cell * 0.055, 5, rng);
    for (var b15 = 0; b15 < 4; b15++) {
      g.fillStyle = 'rgba(96,94,88,0.9)';
      g.beginPath();
      g.arc(o.x + cell * (0.18 + (b15 % 2) * 0.64), o.y + cell * (0.32 + Math.floor(b15 / 2) * 0.36),
        cell * 0.018, 0, 6.2832);
      g.fill();
    }

    if (grunge) {
      g.globalCompositeOperation = 'multiply';
      g.globalAlpha = 0.30;
      g.drawImage(grunge, 0, 0, px, px);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
    }
    return c;
  };

  // ---- soft puff, for the vent steam --------------------------------------
  TX.puff = function (size, seed) {
    var c = TX.canvas(size, size);
    if (!c) return null;
    var g = c.getContext('2d');
    var noise = new GAME.Noise(seed);
    var img = g.createImageData(size, size);
    var d = img.data;
    var inv = 1 / size;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var u = (x * inv - 0.5) * 2, v = (y * inv - 0.5) * 2;
        var r = Math.sqrt(u * u + v * v);
        var n = noise.fbm3(u * 2.6 + 4.1, v * 2.6 - 2.7, 0.7, 4, 2.2, 0.55);
        var a = M.saturate(1 - r * (1.0 + n * 0.55));
        a = a * a * (0.62 + n * 0.38);
        var i = (y * size + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = 255;
        d[i + 3] = M.saturate(a) * 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  };

  // ---- sacking / bulk-bag weave -------------------------------------------
  TX.sack = function (size, seed, grunge) {
    var c = TX.canvas(size, size);
    if (!c) return null;
    var g = c.getContext('2d');
    var rng = new GAME.RNG(seed);
    g.fillStyle = '#b6a684';
    g.fillRect(0, 0, size, size);
    g.globalAlpha = 0.20;
    for (var i = 0; i < size; i += 4) {
      g.fillStyle = (i % 8) ? '#6d6046' : '#d8cbaa';
      g.fillRect(i, 0, 2, size);
      g.fillRect(0, i, size, 2);
    }
    g.globalAlpha = 1;
    // a printed band of invented script across the middle
    g.fillStyle = 'rgba(60,72,96,0.85)';
    g.fillRect(0, size * 0.40, size, size * 0.03);
    g.fillRect(0, size * 0.60, size, size * 0.03);
    g.fillStyle = 'rgba(52,62,86,0.9)';
    g.strokeStyle = 'rgba(52,62,86,0.9)';
    TX.scriptRun(g, size * 0.10, size * 0.545, size * 0.10, size * 0.78, rng, 0.20);
    if (grunge) {
      g.globalCompositeOperation = 'multiply';
      g.globalAlpha = 0.55;
      g.drawImage(grunge, 0, 0, size, size);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
    }
    return c;
  };

  // ==========================================================================
  // THE KIT
  //
  // Every builder returns ONE merged BufferGeometry with its origin at the
  // point that touches the ground, +Z forward where a prop has a front.  That
  // convention is what lets the placement passes treat "settle this on the
  // measured ground normal" as a single call for all thirty items.
  //
  // Silhouette is the budget these are written against: a drum is not a
  // cylinder, it is a cylinder with two rolling hoops, two chimes, a bung
  // plate and a dent, because a cylinder at 40 m reads as a bollard and a drum
  // reads as a drum.
  // ==========================================================================
  var K = {};

  // ---- atlas quad ----------------------------------------------------------
  // Lies in the XZ plane facing +Y (a ground mark).  Callers wanting a wall
  // placard rotate it at placement time.
  function markQuad(cell, w, h, flip) {
    var g = new THREE.PlaneGeometry(w, h, 1, 1);
    g.rotateX(-Math.PI * 0.5);
    var inv = 1 / MARK_N;
    var u0 = (cell % MARK_N) * inv;
    var v0 = 1 - (Math.floor(cell / MARK_N) + 1) * inv;
    var uv = g.attributes.uv;
    for (var i = 0; i < uv.count; i++) {
      var u = uv.getX(i), v = uv.getY(i);
      if (flip) { var t = u; u = 1 - t; }
      uv.setXY(i, u0 + u * inv, v0 + v * inv);
    }
    uv.needsUpdate = true;
    return g;
  }

  // ---- 205 litre drum ------------------------------------------------------
  K.drum = function (N, rng) {
    var p = [];
    var r = 0.292, h = 0.885;
    var body = cyl(r, r, h - 0.10, 20, true);
    roughen(body, N, 0.018, 2.4, 'radial');
    p.push(part(body, T(0, h * 0.5, 0)));
    // domed heads, recessed inside the chimes
    p.push(part(cyl(r - 0.012, r - 0.004, 0.055, 20), T(0, h - 0.055, 0)));
    p.push(part(cyl(r - 0.004, r - 0.012, 0.055, 20), T(0, 0.055, 0)));
    // top and bottom chime rings - the bit that rusts first
    p.push(part(tor(r + 0.006, 0.024, 6, 18), T(0, h - 0.016, 0, Math.PI * 0.5)));
    p.push(part(tor(r + 0.006, 0.024, 6, 18), T(0, 0.016, 0, Math.PI * 0.5)));
    // two rolling hoops
    p.push(part(cyl(r + 0.020, r + 0.020, 0.062, 20, true), T(0, h * 0.335, 0)));
    p.push(part(cyl(r + 0.020, r + 0.020, 0.062, 20, true), T(0, h * 0.665, 0)));
    // bungs on the top head
    p.push(part(cyl(0.041, 0.041, 0.024, 8), T(0.150, h - 0.030, 0.030)));
    p.push(part(cyl(0.026, 0.026, 0.020, 8), T(-0.115, h - 0.032, -0.095)));
    var g = mergeParts(p);
    disposeParts(p);
    return g;
  };

  // ---- IBC tote: caged 1000 litre --------------------------------------------
  K.ibc = function (N) {
    var p = [];
    var w = 1.00, d = 1.16, tankH = 1.02, palH = 0.14;
    // steel pallet base
    p.push(part(box(w + 0.04, 0.05, d + 0.04, 0.008), T(0, palH - 0.025, 0)));
    for (var f = 0; f < 4; f++) {
      p.push(part(box(0.10, palH - 0.05, 0.10, 0.01),
        T((f & 1 ? 1 : -1) * (w * 0.42), (palH - 0.05) * 0.5, (f & 2 ? 1 : -1) * (d * 0.42))));
    }
    // the poly tank, slightly barrelled
    var tank = Geo.bevelBox(w - 0.06, tankH, d - 0.06, 0.055, 3);
    roughen(tank, N, 0.008, 2.0);
    p.push(part(tank, T(0, palH + tankH * 0.5, 0)));
    // fill cap and the discharge valve
    p.push(part(cyl(0.10, 0.10, 0.08, 12), T(0, palH + tankH + 0.02, 0)));
    p.push(part(cyl(0.115, 0.10, 0.03, 12), T(0, palH + tankH + 0.075, 0)));
    p.push(part(cyl(0.055, 0.055, 0.20, 10), T(0, palH + 0.16, d * 0.48, Math.PI * 0.5)));
    p.push(part(box(0.16, 0.05, 0.05, 0.008), T(0, palH + 0.16, d * 0.52)));
    // the cage: verticals at the corners, six horizontals, and the mesh wires
    var bar = 0.022;
    var i, k;
    for (i = 0; i < 4; i++) {
      var sx = (i & 1 ? 1 : -1) * w * 0.5, sz = (i & 2 ? 1 : -1) * d * 0.5;
      p.push(part(box(bar * 1.6, tankH + 0.10, bar * 1.6, 0.004),
        T(sx, palH + (tankH + 0.10) * 0.5, sz)));
    }
    for (k = 0; k < 6; k++) {
      var y = palH + 0.06 + k * (tankH - 0.02) / 5;
      p.push(part(box(w + bar, bar, bar, 0.004), T(0, y, -d * 0.5)));
      p.push(part(box(w + bar, bar, bar, 0.004), T(0, y, d * 0.5)));
      p.push(part(box(bar, bar, d + bar, 0.004), T(-w * 0.5, y, 0)));
      p.push(part(box(bar, bar, d + bar, 0.004), T(w * 0.5, y, 0)));
    }
    for (k = 0; k < 4; k++) {
      var t = -0.30 + k * 0.20;
      p.push(part(box(bar * 0.8, tankH, bar * 0.8, 0), T(t * w, palH + tankH * 0.5, -d * 0.5)));
      p.push(part(box(bar * 0.8, tankH, bar * 0.8, 0), T(t * w, palH + tankH * 0.5, d * 0.5)));
      p.push(part(box(bar * 0.8, tankH, bar * 0.8, 0), T(-w * 0.5, palH + tankH * 0.5, t * d)));
      p.push(part(box(bar * 0.8, tankH, bar * 0.8, 0), T(w * 0.5, palH + tankH * 0.5, t * d)));
    }
    var g = mergeParts(p);
    disposeParts(p);
    return g;
  };

  // ---- timber pallet -------------------------------------------------------
  K.pallet = function (N, rng) {
    var p = [];
    var w = 1.20, d = 1.00;
    var i;
    for (i = 0; i < 3; i++) {
      var z = (i - 1) * (d * 0.42);
      p.push(part(box(w, 0.095, 0.098, 0.008), T(0, 0.048, z)));
      p.push(part(box(w, 0.020, 0.098, 0.004), T(0, 0.008, z)));
    }
    for (i = 0; i < 6; i++) {
      var x = -w * 0.5 + 0.06 + i * ((w - 0.12) / 5);
      var jog = rng ? rng.range(-0.008, 0.008) : 0;
      p.push(part(box(0.098, 0.022, d, 0.004), T(x, 0.107, jog)));
    }
    var g = mergeParts(p);
    disposeParts(p);
    if (g && N) roughen(g, N, 0.004, 5.0);
    return g;
  };

  // ---- pallet of bagged product ---------------------------------------------
  K.sackPallet = function (N, rng) {
    var p = [];
    var base = K.pallet(N, rng);
    if (base) p.push(part(base, null));
    var layers = 3;
    for (var L = 0; L < layers; L++) {
      var y = 0.118 + L * 0.185;
      for (var i = 0; i < 4; i++) {
        var rot = (L % 2) ? Math.PI * 0.5 : 0;
        var ox = ((i & 1) ? 0.28 : -0.28), oz = ((i & 2) ? 0.22 : -0.22);
        var s = Geo.bevelBox(0.56, 0.175, 0.44, 0.075, 2);
        roughen(s, N, 0.020, 3.4);
        p.push(part(s, T(ox, y + 0.088, oz, 0, rot + (rng ? rng.range(-0.08, 0.08) : 0), 0)));
      }
    }
    var g = mergeParts(p);
    disposeParts(p);
    return g;
  };

  // ---- traffic cone --------------------------------------------------------
  K.cone = function () {
    var p = [];
    p.push(part(box(0.34, 0.030, 0.34, 0.010), T(0, 0.015, 0)));
    p.push(part(cyl(0.155, 0.20, 0.045, 12), T(0, 0.050, 0)));
    p.push(part(cyl(0.036, 0.150, 0.560, 12, true), T(0, 0.352, 0)));
    p.push(part(cyl(0.060, 0.060, 0.045, 10), T(0, 0.645, 0)));
    // the retro band, proud of the cone so it catches a lamp
    p.push(part(cyl(0.088, 0.100, 0.085, 12, true), T(0, 0.455, 0)));
    var g = mergeParts(p);
    disposeParts(p);
    return g;
  };

  // ---- jersey barrier ------------------------------------------------------
  K.barrier = function (N) {
    var prof = [
      { x: -0.300, y: 0.000 }, { x: 0.300, y: 0.000 }, { x: 0.300, y: 0.085 },
      { x: 0.155, y: 0.310 }, { x: 0.115, y: 0.820 }, { x: -0.115, y: 0.820 },
      { x: -0.155, y: 0.310 }, { x: -0.300, y: 0.085 }
    ];
    var p = [];
    var body = extrudeProfile(prof, 2.30, 1.0);
    roughen(body, N, 0.008, 3.0);
    p.push(part(body, null));
    // lifting pockets and the connector lugs at each end
    p.push(part(box(0.13, 0.09, 0.13, 0.01), T(-0.55, 0.845, 0)));
    p.push(part(box(0.13, 0.09, 0.13, 0.01), T(0.55, 0.845, 0)));
    p.push(part(box(0.10, 0.36, 0.06, 0.008), T(0, 0.42, 1.175)));
    p.push(part(box(0.10, 0.36, 0.06, 0.008), T(0, 0.42, -1.175)));
    var g = mergeParts(p);
    disposeParts(p);
    return g;
  };

  // ---- a length of process pipe, axis along X ------------------------------
  K.pipeLength = function (N, r, len) {
    var p = [];
    r = r || 0.16; len = len || 6.0;
    var body = cyl(r, r, len, 14, true);
    p.push(part(body, T(0, 0, 0, 0, 0, Math.PI * 0.5)));
    for (var s = 0; s < 2; s++) {
      var x = (s ? 1 : -1) * len * 0.5;
      p.push(part(cyl(r * 1.55, r * 1.55, 0.038, 14), T(x - (s ? 0.019 : -0.019), 0, 0, 0, 0, Math.PI * 0.5)));
      p.push(part(cyl(r * 1.10, r * 1.10, 0.05, 14), T(x - (s ? 0.06 : -0.06), 0, 0, 0, 0, Math.PI * 0.5)));
      for (var b = 0; b < 6; b++) {
        var a = b / 6 * Math.PI * 2;
        p.push(part(cyl(0.016, 0.016, 0.055, 5),
          T(x - (s ? 0.02 : -0.02), Math.sin(a) * r * 1.32, Math.cos(a) * r * 1.32, 0, 0, Math.PI * 0.5)));
      }
    }
    var g = mergeParts(p);
    disposeParts(p);
    if (g && N) roughen(g, N, 0.004, 2.0);
    return g;
  };

  // ---- timber dunnage baulk ------------------------------------------------
  K.dunnage = function (N) {
    var g = Geo.bevelBox(2.40, 0.145, 0.145, 0.012, 1);
    roughen(g, N, 0.006, 6.0);
    g.translate(0, 0.0725, 0);
    return g;
  };

  // ---- cable drum, resting on its flanges ---------------------------------
  // `full` winds actual cable onto it and leaves a tail hanging over the flange
  // with a taped end; `full` false is the empty barrel a drum looks like when
  // the cable has been pulled. Two identical drums standing side by side, both
  // apparently empty, is the exact "props that scatter uniformly" tell.
  K.cableDrum = function (N, full) {
    var p = [];
    var R = 0.72, w = 0.78;
    var s, b, a, x;
    for (s = 0; s < 2; s++) {
      x = (s ? 1 : -1) * w * 0.5;
      p.push(part(cyl(R, R, 0.055, 20), T(x, R, 0, 0, 0, Math.PI * 0.5)));
      // the radial battens that stop a drum rolling off a lorry
      for (b = 0; b < 8; b++) {
        a = b / 8 * Math.PI * 2;
        p.push(part(box(0.05, R * 0.9, 0.075, 0.006),
          T(x + (s ? 0.04 : -0.04), R + Math.sin(a) * R * 0.5, Math.cos(a) * R * 0.5, 0, 0, a)));
      }
    }
    p.push(part(cyl(0.28, 0.28, w - 0.09, 14), T(0, R, 0, 0, 0, Math.PI * 0.5)));
    if (full !== false) {
      // the wound cable: out to 0.62 m, so it fills the flange instead of
      // hiding inside the shadow of it
      for (var k = 0; k < 7; k++) {
        var rr = 0.31 + k * 0.048;
        p.push(part(cyl(rr, rr, w - 0.13 - k * 0.010, 18, true), T(0, R, 0, 0, 0, Math.PI * 0.5)));
      }
      // the tail: over the flange, down the outside and coiled on the ground
      p.push(part(cyl(0.030, 0.030, 0.34, 7), T(0.30, R + 0.60, 0.30, 0.9, 0.5, 0)));
      p.push(part(cyl(0.030, 0.030, 0.68, 7), T(0.44, R * 0.55, 0.52, 0.25, 0.4, 0.15)));
      for (var c2 = 0; c2 < 3; c2++) {
        p.push(part(tor(0.16 + c2 * 0.05, 0.030, 5, 12),
          T(0.52 + c2 * 0.02, 0.032 + c2 * 0.010, 0.74, Math.PI * 0.5, c2 * 0.4, 0)));
      }
      // the taped end
      p.push(part(cyl(0.042, 0.030, 0.11, 8), T(0.30, 0.05, 0.86, Math.PI * 0.42, 0.7, 0)));
    } else {
      // bare barrel with the drive slots and the last few turns still on it
      for (var d2 = 0; d2 < 4; d2++) {
        var da = d2 / 4 * Math.PI * 2 + 0.3;
        p.push(part(box(0.06, 0.10, 0.10, 0.008),
          T(w * 0.5 - 0.02, R + Math.sin(da) * 0.20, Math.cos(da) * 0.20)));
      }
      p.push(part(cyl(0.315, 0.315, w * 0.30, 16, true), T(-w * 0.22, R, 0, 0, 0, Math.PI * 0.5)));
    }
    // hub bore
    p.push(part(cyl(0.075, 0.075, w + 0.06, 10), T(0, R, 0, 0, 0, Math.PI * 0.5)));
    var g = mergeParts(p);
    disposeParts(p);
    if (g && N) roughen(g, N, 0.005, 2.4);
    return g;
  };

  // ---- timber crate --------------------------------------------------------
  K.crate = function (N, rng) {
    var p = [];
    var w = 1.15, h = 0.86, d = 0.92;
    var i;
    for (i = 0; i < 4; i++) {
      p.push(part(box(0.075, h, 0.075, 0.008),
        T((i & 1 ? 1 : -1) * (w * 0.5 - 0.04), h * 0.5, (i & 2 ? 1 : -1) * (d * 0.5 - 0.04))));
    }
    for (i = 0; i < 4; i++) {
      var y = 0.08 + i * ((h - 0.16) / 3);
      p.push(part(box(w, 0.115, 0.026, 0.004), T(0, y, -d * 0.5)));
      p.push(part(box(w, 0.115, 0.026, 0.004), T(0, y, d * 0.5)));
      p.push(part(box(0.026, 0.115, d, 0.004), T(-w * 0.5, y, 0)));
      p.push(part(box(0.026, 0.115, d, 0.004), T(w * 0.5, y, 0)));
    }
    for (i = 0; i < 4; i++) {
      p.push(part(box(w, 0.024, 0.19, 0.004), T(0, h + 0.012, -d * 0.5 + 0.12 + i * ((d - 0.24) / 3))));
    }
    // steel banding
    p.push(part(box(w + 0.02, 0.022, 0.012, 0), T(0, h * 0.62, -d * 0.28)));
    p.push(part(box(0.012, 0.022, d + 0.02, 0), T(-w * 0.28, h * 0.62, 0)));
    var g = mergeParts(p);
    disposeParts(p);
    if (g && N) roughen(g, N, 0.005, 5.0);
    return g;
  };

  // ---- tool chest ----------------------------------------------------------
  K.toolChest = function () {
    var p = [];
    var w = 0.92, h = 0.86, d = 0.52;
    p.push(part(Geo.bevelBox(w, h - 0.10, d, 0.018, 1), T(0, 0.10 + (h - 0.10) * 0.5, 0)));
    p.push(part(box(w + 0.03, 0.055, d + 0.03, 0.012), T(0, h + 0.005, 0)));
    for (var i = 0; i < 4; i++) {
      var y = 0.18 + i * 0.165;
      p.push(part(box(w - 0.06, 0.145, 0.022, 0.006), T(0, y, d * 0.5 + 0.006)));
      p.push(part(box(w * 0.42, 0.026, 0.030, 0.004), T(0, y, d * 0.5 + 0.026)));
    }
    for (var k = 0; k < 4; k++) {
      p.push(part(cyl(0.045, 0.045, 0.045, 8),
        T((k & 1 ? 1 : -1) * (w * 0.40), 0.045, (k & 2 ? 1 : -1) * (d * 0.34), Math.PI * 0.5)));
    }
    p.push(part(box(0.30, 0.05, 0.05, 0.008), T(w * 0.5 + 0.02, h * 0.7, 0, 0, 0, 0)));
    var g = mergeParts(p);
    disposeParts(p);
    return g;
  };

  // ---- hose reel on a stand ------------------------------------------------
  K.hoseReel = function (N) {
    var p = [];
    var H = 1.05;
    p.push(part(box(0.62, 0.045, 0.50, 0.008), T(0, 0.022, 0)));
    for (var s = 0; s < 2; s++) {
      var x = (s ? 1 : -1) * 0.28;
      p.push(part(box(0.055, H, 0.055, 0.008), T(x, H * 0.5, -0.16)));
      p.push(part(box(0.055, H * 0.7, 0.055, 0.008), T(x, H * 0.35, 0.16)));
      p.push(part(cyl(0.40, 0.40, 0.035, 16), T(x, H - 0.06, 0, 0, 0, Math.PI * 0.5)));
    }
    p.push(part(cyl(0.10, 0.10, 0.60, 10), T(0, H - 0.06, 0, 0, 0, Math.PI * 0.5)));
    for (var k = 0; k < 4; k++) {
      var rr = 0.14 + k * 0.062;
      p.push(part(cyl(rr, rr, 0.50 - k * 0.02, 14, true), T(0, H - 0.06, 0, 0, 0, Math.PI * 0.5)));
    }
    // the crank and the loose end of hose hanging down
    p.push(part(box(0.035, 0.26, 0.035, 0.005), T(0.34, H - 0.06, 0.10, 0, 0, 0.4)));
    p.push(part(cyl(0.030, 0.030, 0.55, 8), T(0.10, H - 0.42, 0.26, 0.22, 0, 0.10)));
    p.push(part(cyl(0.035, 0.022, 0.14, 8), T(0.14, H - 0.72, 0.30, 0.3, 0, 0.1)));
    var g = mergeParts(p);
    disposeParts(p);
    if (g && N) roughen(g, N, 0.004, 3.0);
    return g;
  };

  // ---- fire monitor (water/foam cannon) -----------------------------------
  K.fireMonitor = function () {
    var p = [];
    p.push(part(cyl(0.24, 0.28, 0.06, 12), T(0, 0.03, 0)));
    p.push(part(cyl(0.11, 0.11, 0.86, 12), T(0, 0.49, 0)));
    p.push(part(cyl(0.16, 0.16, 0.14, 12), T(0, 0.96, 0)));
    p.push(part(box(0.20, 0.22, 0.24, 0.02), T(0, 1.11, 0)));
    // the barrel, raked up and out
    p.push(part(cyl(0.075, 0.095, 1.05, 12), T(0, 1.44, 0.30, -0.62, 0, 0)));
    p.push(part(cyl(0.055, 0.075, 0.20, 12), T(0, 1.72, 0.80, -0.62, 0, 0)));
    // handwheel for elevation
    p.push(part(tor(0.19, 0.018, 6, 14), T(0.22, 1.10, 0, 0, 0, Math.PI * 0.5)));
    for (var s = 0; s < 4; s++) {
      var a = s / 4 * Math.PI * 2;
      p.push(part(box(0.016, 0.19, 0.016, 0),
        T(0.22, 1.10 + Math.sin(a) * 0.095, Math.cos(a) * 0.095, 0, 0, a)));
    }
    p.push(part(box(0.05, 0.05, 0.42, 0.006), T(-0.16, 1.20, -0.16, 0.3, 0.5, 0)));
    var g = mergeParts(p);
    disposeParts(p);
    return g;
  };

  // ---- extinguisher station ------------------------------------------------
  K.extStation = function () {
    var p = [];
    p.push(part(box(0.09, 1.55, 0.09, 0.01), T(-0.50, 0.775, 0)));
    p.push(part(box(0.09, 1.55, 0.09, 0.01), T(0.50, 0.775, 0)));
    p.push(part(box(1.15, 0.055, 0.06, 0.008), T(0, 1.10, 0)));
    p.push(part(box(1.15, 0.055, 0.06, 0.008), T(0, 0.42, 0)));
    p.push(part(box(1.20, 0.035, 0.42, 0.008), T(0, 0.045, 0.02)));
    for (var s = 0; s < 2; s++) {
      var x = (s ? 0.26 : -0.26);
      p.push(part(cyl(0.115, 0.115, 0.60, 14), T(x, 0.36, 0.03)));
      p.push(part(cyl(0.105, 0.045, 0.10, 12), T(x, 0.71, 0.03)));
      p.push(part(cyl(0.028, 0.028, 0.09, 8), T(x, 0.79, 0.03)));
      p.push(part(box(0.045, 0.030, 0.13, 0.006), T(x, 0.83, 0.03)));
      p.push(part(cyl(0.020, 0.020, 0.34, 6), T(x + 0.11, 0.55, 0.03, 0.3, 0, 0.25)));
    }
    var g = mergeParts(p);
    disposeParts(p);
    return g;
  };

  // ---- safety shower + eyewash --------------------------------------------
  K.safetyShower = function () {
    var p = [];
    p.push(part(box(0.30, 0.04, 0.30, 0.008), T(0, 0.02, 0)));
    p.push(part(cyl(0.055, 0.065, 2.28, 12), T(0, 1.16, 0)));
    p.push(part(cyl(0.045, 0.045, 0.34, 10), T(0, 2.28, 0.17, Math.PI * 0.5)));
    p.push(part(cyl(0.010, 0.185, 0.16, 14), T(0, 2.20, 0.33)));
    // triangular pull handle on a rod
    p.push(part(cyl(0.012, 0.012, 0.95, 6), T(0.16, 1.86, 0.20)));
    p.push(part(box(0.28, 0.030, 0.030, 0.004), T(0.16, 1.40, 0.20)));
    // the eyewash bowl and its paddle
    p.push(part(cyl(0.20, 0.13, 0.11, 14), T(0.05, 1.06, 0.24)));
    p.push(part(cyl(0.022, 0.022, 0.24, 8), T(0.05, 1.02, 0.10, Math.PI * 0.5)));
    p.push(part(box(0.20, 0.022, 0.13, 0.004), T(0.05, 1.14, -0.04, 0.25, 0, 0)));
    p.push(part(cyl(0.035, 0.035, 0.28, 8), T(0, 0.30, 0.12, Math.PI * 0.5)));
    var g = mergeParts(p);
    disposeParts(p);
    return g;
  };

  // ---- sign on a post ------------------------------------------------------
  // `bend` builds the variant every yard actually has: the post caught by a
  // reversing truck years ago, kinked at knee height, with the board leaning
  // out of plumb and one of its two fixing straps sprung.  Every sign in the
  // level used to be the same dead-plumb instance, and a row of identical
  // vertical rectangles is the "perfectly straight, perfectly uniform anything"
  // on the instant-fail list.
  // How far the bent variant's board sits off the post's own base, in the
  // sign's local +X. `_signPost` needs it to put the printed placard on the
  // board rather than in the air beside it.
  var SIGN_BEND_DX = 0.115;

  K.signPost = function (w, h, y, bend) {
    var p = [];
    w = w || 0.78; h = h || 0.56; y = y || 1.55;
    if (bend) {
      var kink = 0.54;
      var dxB = SIGN_BEND_DX;                       // where the board ends up
      var lean = Math.atan2(dxB, y - kink);
      var upper = Math.sqrt(dxB * dxB + (y - kink) * (y - kink));
      p.push(part(box(0.07, kink, 0.07, 0.008), T(0, kink * 0.5, 0)));
      p.push(part(box(0.07, upper, 0.07, 0.008),
        T(dxB * 0.5, kink + (y - kink) * 0.5, 0, 0, 0, -lean)));
      // the board, hanging off the leaning post and out of plumb with it
      p.push(part(box(w, h, 0.028, 0.008),
        T(dxB * 0.92, y - h * 0.5, 0.048, 0, 0, -0.075)));
      p.push(part(box(w * 0.28, 0.045, 0.055, 0.006),
        T(dxB * 0.92, y - 0.07, 0.02, 0, 0, -lean)));
      // one strap sprung off its fixing, which is why the board hangs skew
      p.push(part(box(w * 0.22, 0.038, 0.048, 0.006),
        T(dxB * 0.92 - 0.09, y - h + 0.12, 0.030, 0, 0, -lean + 0.62)));
      p.push(part(box(0.16, 0.05, 0.16, 0.01), T(0, 0.025, 0)));
    } else {
      p.push(part(box(0.07, y, 0.07, 0.008), T(0, y * 0.5, 0)));
      p.push(part(box(w, h, 0.028, 0.008), T(0, y - h * 0.5, 0.048)));
      p.push(part(box(w * 0.28, 0.045, 0.055, 0.006), T(0, y - 0.06, 0.02)));
      p.push(part(box(w * 0.28, 0.045, 0.055, 0.006), T(0, y - h + 0.06, 0.02)));
      p.push(part(box(0.16, 0.05, 0.16, 0.01), T(0, 0.025, 0)));
    }
    var g = mergeParts(p);
    disposeParts(p);
    return g;
  };

  // ---- protective bollard --------------------------------------------------
  K.bollard = function () {
    var p = [];
    p.push(part(cyl(0.108, 0.118, 0.98, 12), T(0, 0.49, 0)));
    p.push(part(sph(0.108, 12, 6, undefined, 0, Math.PI * 0.5), T(0, 0.98, 0)));
    p.push(part(cyl(0.20, 0.22, 0.055, 12), T(0, 0.027, 0)));
    var g = mergeParts(p);
    disposeParts(p);
    return g;
  };

  // ---- waste skip ----------------------------------------------------------
  K.skip = function (N) {
    var p = [];
    var L = 3.40, W = 1.72, H = 1.22, rake = 0.34;
    p.push(part(box(L - rake * 2, 0.05, W, 0.01), T(0, 0.025, 0)));
    // raked ends
    p.push(part(box(0.05, H, W, 0.008), T(-(L * 0.5 - rake * 0.5), H * 0.5, 0, 0, 0, -0.27)));
    p.push(part(box(0.05, H, W, 0.008), T((L * 0.5 - rake * 0.5), H * 0.5, 0, 0, 0, 0.27)));
    p.push(part(box(L - rake, H, 0.05, 0.008), T(0, H * 0.5, -W * 0.5)));
    p.push(part(box(L - rake, H, 0.05, 0.008), T(0, H * 0.5, W * 0.5)));
    // rim, corner posts, hook pockets, rubbing rails
    p.push(part(box(L + 0.06, 0.08, 0.10, 0.012), T(0, H + 0.02, -W * 0.5)));
    p.push(part(box(L + 0.06, 0.08, 0.10, 0.012), T(0, H + 0.02, W * 0.5)));
    p.push(part(box(0.10, 0.08, W + 0.06, 0.012), T(-(L * 0.5 - rake), H + 0.02, 0)));
    p.push(part(box(0.10, 0.08, W + 0.06, 0.012), T((L * 0.5 - rake), H + 0.02, 0)));
    for (var s = 0; s < 2; s++) {
      var z = (s ? 1 : -1) * W * 0.5;
      p.push(part(box(L * 0.9, 0.10, 0.06, 0.008), T(0, H * 0.52, z)));
      for (var k = 0; k < 4; k++) {
        p.push(part(box(0.09, H, 0.05, 0.008), T(-L * 0.34 + k * (L * 0.68 / 3), H * 0.5, z)));
      }
    }
    p.push(part(box(0.14, 0.55, 0.12, 0.012), T(-L * 0.5 + rake * 0.4, H * 0.72, -W * 0.32, 0, 0, -0.27)));
    p.push(part(box(0.14, 0.55, 0.12, 0.012), T(-L * 0.5 + rake * 0.4, H * 0.72, W * 0.32, 0, 0, -0.27)));
    var g = mergeParts(p);
    disposeParts(p);
    if (g && N) roughen(g, N, 0.010, 2.0);
    return g;
  };

  // ---- 20 ft site container / store ---------------------------------------
  K.container = function (N, doors) {
    var p = [];
    var L = 6.06, W = 2.44, H = 2.59;
    var i;
    // corrugated side and end walls, built rib by rib so the profile is real
    var ribs = 26;
    for (i = 0; i < ribs; i++) {
      var x = -L * 0.5 + 0.14 + i * ((L - 0.28) / (ribs - 1));
      var dpt = (i % 2) ? 0.045 : 0.0;
      p.push(part(box((L - 0.28) / ribs * 0.92, H - 0.30, 0.05 + dpt, 0.004),
        T(x, 0.15 + (H - 0.30) * 0.5, -W * 0.5 + dpt * 0.5)));
      p.push(part(box((L - 0.28) / ribs * 0.92, H - 0.30, 0.05 + dpt, 0.004),
        T(x, 0.15 + (H - 0.30) * 0.5, W * 0.5 - dpt * 0.5)));
    }
    p.push(part(box(L, 0.22, W, 0.02), T(0, H - 0.08, 0)));
    p.push(part(box(L - 0.2, 0.30, W - 0.2, 0.02), T(0, 0.15, 0)));
    if (doors) {
      // cargo doors at one end with the four locking bars
      for (i = 0; i < 2; i++) {
        var zz = (i ? 1 : -1) * W * 0.24;
        p.push(part(box(0.07, H - 0.34, W * 0.47, 0.008), T(L * 0.5, 0.17 + (H - 0.34) * 0.5, zz)));
        for (var b = 0; b < 2; b++) {
          var bz = zz + (b ? 0.24 : -0.24) * W * 0.4;
          p.push(part(cyl(0.028, 0.028, H - 0.46, 8), T(L * 0.5 + 0.05, 0.23 + (H - 0.46) * 0.5, bz)));
          p.push(part(box(0.09, 0.10, 0.06, 0.008), T(L * 0.5 + 0.08, 1.05, bz)));
          p.push(part(box(0.05, 0.05, 0.24, 0.006), T(L * 0.5 + 0.10, 1.05, bz + 0.10, 0, 0.5, 0)));
        }
      }
    } else {
      p.push(part(box(0.07, H - 0.30, W, 0.008), T(L * 0.5, 0.15 + (H - 0.30) * 0.5, 0)));
      // a personnel door and a louvre, so it reads as a site office
      p.push(part(box(0.05, 1.98, 0.86, 0.006), T(L * 0.5 + 0.04, 1.14, -0.55)));
      p.push(part(box(0.04, 0.09, 0.09, 0.006), T(L * 0.5 + 0.07, 1.05, -0.20)));
      for (var lv = 0; lv < 4; lv++) {
        p.push(part(box(0.04, 0.05, 0.52, 0.004), T(L * 0.5 + 0.05, 1.62 + lv * 0.09, 0.62, 0, 0, 0.35)));
      }
    }
    p.push(part(box(0.07, H - 0.30, W, 0.008), T(-L * 0.5, 0.15 + (H - 0.30) * 0.5, 0)));
    // corner castings
    for (i = 0; i < 8; i++) {
      p.push(part(box(0.18, 0.16, 0.17, 0.012),
        T((i & 1 ? 1 : -1) * (L * 0.5 - 0.09), (i & 4 ? H - 0.08 : 0.08),
          (i & 2 ? 1 : -1) * (W * 0.5 - 0.085))));
    }
    var g = mergeParts(p);
    disposeParts(p);
    if (g && N) roughen(g, N, 0.006, 1.6);
    return g;
  };

  // ---- valve stand: a riser out of the paving with a gate valve on it ------
  K.valveStand = function (N) {
    var p = [];
    p.push(part(cyl(0.24, 0.26, 0.06, 12), T(0, 0.03, 0)));
    p.push(part(cyl(0.105, 0.105, 0.86, 12), T(0, 0.46, 0)));
    p.push(part(cyl(0.16, 0.16, 0.045, 12), T(0, 0.90, 0)));
    // the valve body: two cones back to back, which is what a gate valve is
    p.push(part(cyl(0.15, 0.21, 0.20, 12), T(0, 1.02, 0)));
    p.push(part(cyl(0.21, 0.15, 0.20, 12), T(0, 1.22, 0)));
    p.push(part(cyl(0.115, 0.115, 0.16, 10), T(0, 1.40, 0)));
    p.push(part(cyl(0.16, 0.16, 0.04, 10), T(0, 1.50, 0)));
    p.push(part(cyl(0.022, 0.022, 0.30, 8), T(0, 1.64, 0)));
    // handwheel
    p.push(part(tor(0.21, 0.020, 6, 16), T(0, 1.80, 0, Math.PI * 0.5)));
    for (var s = 0; s < 4; s++) {
      var a = s / 4 * Math.PI * 2;
      p.push(part(box(0.021, 0.021, 0.21, 0),
        T(Math.sin(a) * 0.105, 1.80, Math.cos(a) * 0.105, 0, a, 0)));
    }
    // the run away to the process, and a drain with a plug
    p.push(part(cyl(0.105, 0.105, 0.70, 12), T(0.35, 1.12, 0, 0, 0, Math.PI * 0.5)));
    p.push(part(cyl(0.155, 0.155, 0.035, 12), T(0.68, 1.12, 0, 0, 0, Math.PI * 0.5)));
    p.push(part(cyl(0.045, 0.045, 0.24, 8), T(0, 0.30, 0.16, Math.PI * 0.5)));
    var g = mergeParts(p);
    disposeParts(p);
    if (g && N) roughen(g, N, 0.004, 2.6);
    return g;
  };

  // ---- gas cylinder --------------------------------------------------------
  K.gasBottle = function () {
    var p = [];
    p.push(part(cyl(0.115, 0.118, 1.25, 12), T(0, 0.625, 0)));
    p.push(part(sph(0.115, 12, 6, undefined, 0, Math.PI * 0.52), T(0, 1.25, 0)));
    p.push(part(cyl(0.038, 0.038, 0.11, 8), T(0, 1.38, 0)));
    p.push(part(cyl(0.062, 0.062, 0.05, 8), T(0, 1.45, 0)));
    p.push(part(box(0.13, 0.05, 0.05, 0.006), T(0.05, 1.44, 0)));
    p.push(part(cyl(0.128, 0.128, 0.16, 12, true), T(0, 1.36, 0)));
    p.push(part(cyl(0.122, 0.122, 0.05, 12), T(0, 0.025, 0)));
    var g = mergeParts(p);
    disposeParts(p);
    return g;
  };

  // ---- a quad pack of cylinders in a stillage ------------------------------
  K.bottlePack = function () {
    var p = [];
    var bottle = K.gasBottle();
    for (var i = 0; i < 4; i++) {
      var ox = (i & 1 ? 0.15 : -0.15), oz = (i & 2 ? 0.15 : -0.15);
      p.push(part(bottle.clone(), T(ox, 0, oz, 0, i * 1.1, 0)));
    }
    bottle.dispose();
    var w = 0.78;
    p.push(part(box(w, 0.06, w, 0.008), T(0, 0.03, 0)));
    for (var k = 0; k < 4; k++) {
      p.push(part(box(0.05, 1.50, 0.05, 0.006),
        T((k & 1 ? 1 : -1) * w * 0.46, 0.75, (k & 2 ? 1 : -1) * w * 0.46)));
    }
    p.push(part(box(w, 0.05, 0.05, 0.006), T(0, 1.05, -w * 0.46)));
    p.push(part(box(w, 0.05, 0.05, 0.006), T(0, 1.05, w * 0.46)));
    p.push(part(box(0.05, 0.05, w, 0.006), T(-w * 0.46, 1.05, 0)));
    p.push(part(box(0.05, 0.05, w, 0.006), T(w * 0.46, 1.05, 0)));
    p.push(part(box(w + 0.06, 0.07, w + 0.06, 0.008), T(0, 1.50, 0)));
    var g = mergeParts(p);
    disposeParts(p);
    return g;
  };

  // ---- windblown sand drift ------------------------------------------------
  // A half dome with the leeward slip face steeper than the windward ramp.
  // Instanced with heavy scale variance and always placed against something.
  K.sandDrift = function (N, seed) {
    var g = sph(1.0, 16, 7, undefined, 0, Math.PI * 0.5);
    var p = g.attributes.position;
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      var n = N.fbm3(x * 1.9 + seed, y * 1.9, z * 1.9 - seed, 3, 2.2, 0.55);
      // ramp up on -Z, slip face on +Z
      var lee = M.saturate((z + 0.2) * 0.9);
      var s = (1 + n * 0.30) * (1 - lee * 0.24);
      p.setXYZ(i, x * s * (1 + n * 0.12), Math.max(0, y * (0.30 + n * 0.09)), z * s);
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  };

  // ---- dry desert scrub ----------------------------------------------------
  // Twelve woody stems from one crown.  No alpha card: at this hour an
  // alpha-tested bush is a grey smear, but a twiggy MASS catches the sodium on
  // its top edge and reads.
  K.scrub = function (N, rng) {
    var p = [];
    var n = 11;
    for (var i = 0; i < n; i++) {
      var a = (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
      var lean = rng.range(0.55, 1.15);
      var len = rng.range(0.34, 0.78);
      var r0 = rng.range(0.010, 0.020);
      var x1 = Math.cos(a) * len * Math.sin(lean);
      var z1 = Math.sin(a) * len * Math.sin(lean);
      var y1 = len * Math.cos(lean) + 0.10;
      p.push(part(cyl(r0 * 0.35, r0, 1, 3), strutT(0, 0.02, 0, x1, y1, z1)));
      // one fork per stem
      var fx = x1 + Math.cos(a + rng.range(-1.0, 1.0)) * len * 0.45;
      var fz = z1 + Math.sin(a + rng.range(-1.0, 1.0)) * len * 0.45;
      var fy = y1 + rng.range(0.02, 0.20);
      p.push(part(cyl(r0 * 0.25, r0 * 0.6, 1, 3), strutT(x1, y1, z1, fx, fy, fz)));
    }
    p.push(part(sph(0.09, 8, 5, undefined, 0, Math.PI * 0.6), T(0, 0.0, 0)));
    var g = mergeParts(p);
    disposeParts(p);
    return g;
  };

  // ---- tumbleweed ----------------------------------------------------------
  K.tumbleweed = function (N, rng) {
    var p = [];
    for (var i = 0; i < 16; i++) {
      var r = rng.range(0.24, 0.40);
      var a = rng.range(0, Math.PI * 2), b = rng.range(0, Math.PI);
      var t = tor(r, rng.range(0.008, 0.016), 3, 9);
      p.push(part(t, T(rng.range(-0.06, 0.06), rng.range(-0.06, 0.06), rng.range(-0.06, 0.06), b, a, rng.range(0, 3))));
    }
    var g = mergeParts(p);
    disposeParts(p);
    return g;
  };

  // ---- small ground litter -------------------------------------------------
  K.offcut = function (N, rng) {
    var p = [];
    var len = rng.range(0.28, 0.75), r = rng.range(0.035, 0.075);
    p.push(part(cyl(r, r, len, 8, true), T(0, r, 0, 0, 0, Math.PI * 0.5)));
    p.push(part(cyl(r, r * 0.6, 0.02, 8), T(len * 0.5, r, 0, 0, 0, Math.PI * 0.5)));
    p.push(part(cyl(r, r * 0.6, 0.02, 8), T(-len * 0.5, r, 0, 0, 0, Math.PI * 0.5)));
    var g = mergeParts(p);
    disposeParts(p);
    if (g && N) roughen(g, N, 0.006, 4.0);
    return g;
  };

  K.plank = function (N, rng) {
    var g = Geo.bevelBox(rng.range(0.7, 1.5), 0.035, rng.range(0.12, 0.22), 0.006, 1);
    roughen(g, N, 0.010, 5.0);
    g.translate(0, 0.018, 0);
    return g;
  };

  K.rag = function (N, rng) {
    var g = new THREE.PlaneGeometry(rng.range(0.28, 0.52), rng.range(0.22, 0.42), 4, 4);
    g.rotateX(-Math.PI * 0.5);
    var p = g.attributes.position;
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), z = p.getZ(i);
      var n = N.fbm3(x * 7 + 3, 0.5, z * 7 - 2, 3, 2.1, 0.55);
      p.setXYZ(i, x, 0.02 + Math.abs(n) * 0.10, z);
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  };

  K.hardHat = function () {
    var p = [];
    p.push(part(sph(0.135, 12, 7, undefined, 0, Math.PI * 0.55), T(0, 0.02, 0)));
    p.push(part(cyl(0.175, 0.185, 0.022, 14), T(0, 0.028, 0)));
    p.push(part(box(0.04, 0.045, 0.24, 0.008), T(0, 0.10, 0)));
    var g = mergeParts(p);
    disposeParts(p);
    return g;
  };

  // ---- electrical junction box + conduit stubs ----------------------------
  K.junctionBox = function () {
    var p = [];
    p.push(part(Geo.bevelBox(0.26, 0.34, 0.15, 0.012, 1), T(0, 0.17, 0)));
    p.push(part(box(0.22, 0.30, 0.02, 0.004), T(0, 0.17, 0.085)));
    for (var i = 0; i < 4; i++) {
      p.push(part(cyl(0.010, 0.010, 0.03, 6),
        T((i & 1 ? 1 : -1) * 0.085, 0.17 + (i & 2 ? 0.12 : -0.12), 0.095)));
    }
    p.push(part(cyl(0.028, 0.028, 0.16, 8), T(0, 0.36, 0)));
    p.push(part(cyl(0.028, 0.028, 0.14, 8), T(0, 0.03, -0.02, Math.PI * 0.5)));
    var g = mergeParts(p);
    disposeParts(p);
    return g;
  };

  // ---- flat-coiled hose ----------------------------------------------------
  // MEASURED: "a set of mathematically perfect concentric rings with no loose
  // end and no crossing loops". Nobody coils a hose concentrically - it goes
  // down in overlapping loops that wander, the last turn crosses the ones under
  // it, and there is always a tail with a coupling on it lying clear of the
  // stack. The rings are now offset, tilted and unequally spaced, one of them
  // rides up over its neighbours, and the tail runs out to a real branch.
  K.coilHose = function () {
    var p = [];
    var off = [[0, 0], [0.028, -0.019], [-0.022, 0.031], [0.041, 0.024], [-0.015, -0.036]];
    for (var k = 0; k < 5; k++) {
      var r = 0.195 + k * 0.071 + (k % 2 ? 0.012 : -0.008);
      p.push(part(tor(r, 0.032, 5, 16),
        T(off[k][0], 0.032 + k * 0.011, off[k][1],
          Math.PI * 0.5 + (k % 2 ? 0.055 : -0.038), k * 0.7, (k % 3 === 1) ? 0.05 : -0.03)));
    }
    // the crossing turn: it rides up and over the stack instead of nesting
    p.push(part(tor(0.315, 0.032, 5, 16), T(0.03, 0.098, -0.02, Math.PI * 0.5 - 0.20, 1.1, 0.10)));
    // the tail: out of the coil, a slack bight, then the coupling
    p.push(part(cyl(0.032, 0.032, 0.30, 6), T(0.33, 0.052, 0.22, 0, 0.62, Math.PI * 0.5)));
    p.push(part(cyl(0.032, 0.032, 0.34, 6), T(0.56, 0.040, 0.40, 0, 1.05, Math.PI * 0.5)));
    p.push(part(cyl(0.032, 0.032, 0.26, 6), T(0.72, 0.036, 0.62, 0, 0.30, Math.PI * 0.5)));
    p.push(part(cyl(0.048, 0.030, 0.14, 8), T(0.80, 0.036, 0.76, 0, 0.30, Math.PI * 0.5)));
    p.push(part(tor(0.052, 0.010, 4, 10), T(0.755, 0.036, 0.715, 0, 0.30, Math.PI * 0.5)));
    var g = mergeParts(p);
    disposeParts(p);
    return g;
  };

  // ---- gully grating -------------------------------------------------------
  // The level cuts a 95 mm drainage channel down each side of the carriageway.
  // A channel with no gullies in it is a groove; a channel with a cast frame
  // and a grating every twelve metres is DRAINAGE, and because they sit on the
  // kerb line they lay a rhythm of hard small-scale detail straight up both
  // edges of the level's leading line.
  K.gully = function (N) {
    var p = [];
    var w = 0.52, d = 0.78;
    p.push(part(box(w + 0.14, 0.10, d + 0.14, 0.012), T(0, -0.05, 0)));
    for (var i = 0; i < 7; i++) {
      p.push(part(box(w - 0.06, 0.035, 0.038, 0.004),
        T(0, 0.008, -d * 0.5 + 0.08 + i * ((d - 0.16) / 6))));
    }
    p.push(part(box(0.045, 0.045, d - 0.04, 0.006), T(-w * 0.42, 0.008, 0)));
    p.push(part(box(0.045, 0.045, d - 0.04, 0.006), T(w * 0.42, 0.008, 0)));
    p.push(part(box(0.05, 0.05, 0.05, 0.006), T(w * 0.30, 0.030, d * 0.36)));
    var g = mergeParts(p);
    disposeParts(p);
    if (g && N) roughen(g, N, 0.004, 6.0);
    return g;
  };

  // ---- cable-tray section, for the rack deck ------------------------------
  K.cableTray = function (len) {
    var p = [];
    len = len || 2.40;
    p.push(part(box(0.035, 0.11, len, 0.006), T(-0.22, 0.055, 0)));
    p.push(part(box(0.035, 0.11, len, 0.006), T(0.22, 0.055, 0)));
    var rungs = Math.max(3, Math.round(len / 0.30));
    for (var i = 0; i < rungs; i++) {
      p.push(part(box(0.44, 0.02, 0.035, 0.004), T(0, 0.012, -len * 0.5 + 0.1 + i * ((len - 0.2) / (rungs - 1)))));
    }
    for (var c = 0; c < 3; c++) {
      p.push(part(cyl(0.032, 0.032, len, 6, true), T(-0.12 + c * 0.12, 0.055, 0, Math.PI * 0.5)));
    }
    var g = mergeParts(p);
    disposeParts(p);
    return g;
  };

  // ==========================================================================
  // ONE-OFF PLANT.  These are merged into the shared static buckets rather than
  // instanced - there is one of each - and they are here because a site with no
  // vehicle on it is a model of a refinery rather than a refinery.  Each
  // returns { parts: {bucket:[part,...]}, colliders:[...] } in its own local
  // frame, +Z forward, origin on the ground under the front axle line.
  // ==========================================================================

  // Bucket keys match the static merge table in _commit, and the SPLIT between
  // paintA and paintB is deliberate: a tanker is pale enamel and a fork-lift is
  // contractor's yellow, and merging them into one bucket would paint one of
  // the two the wrong colour for the sake of a draw call nobody is short of.
  function bag() {
    return { steel: [], paintA: [], paintB: [], rust: [], rubber: [], glass: [],
             lamp: [], timber: [], marks: [] };
  }

  // ---- fork-lift truck -----------------------------------------------------
  K.forklift = function (N) {
    var B = bag();
    var W = 1.16;
    function P(k, g, m) { B[k].push(part(g, m)); }
    // body: counterweight, engine bay, step
    P('paintB', Geo.bevelBox(W, 0.62, 1.35, 0.05, 1), T(0, 0.62, -0.62));
    P('paintB', Geo.bevelBox(W - 0.10, 0.42, 0.55, 0.04, 1), T(0, 1.10, -1.05));
    P('paintB', cyl(0.34, 0.34, W - 0.04, 12), T(0, 0.62, -1.30, 0, 0, Math.PI * 0.5));
    P('steel', box(0.44, 0.05, 0.34, 0.008), T(-W * 0.5 - 0.10, 0.42, -0.30));
    // seat and column
    P('paintB', box(0.46, 0.10, 0.44, 0.02), T(0, 0.96, -0.42));
    P('paintB', box(0.46, 0.46, 0.09, 0.02), T(0, 1.18, -0.64));
    P('steel', cyl(0.045, 0.045, 0.52, 8), T(0, 1.14, -0.02, -0.42));
    P('steel', tor(0.15, 0.020, 5, 12), T(0, 1.40, 0.08, 1.15));
    // overhead guard
    var gy1 = 2.16;
    P('steel', box(0.07, gy1 - 0.7, 0.07, 0.008), T(-W * 0.44, 0.70 + (gy1 - 0.7) * 0.5, -0.15));
    P('steel', box(0.07, gy1 - 0.7, 0.07, 0.008), T(W * 0.44, 0.70 + (gy1 - 0.7) * 0.5, -0.15));
    P('steel', box(0.07, gy1 - 1.0, 0.07, 0.008), T(-W * 0.44, 1.00 + (gy1 - 1.0) * 0.5, -1.05));
    P('steel', box(0.07, gy1 - 1.0, 0.07, 0.008), T(W * 0.44, 1.00 + (gy1 - 1.0) * 0.5, -1.05));
    for (var r = 0; r < 5; r++) {
      P('steel', box(W, 0.035, 0.05, 0.006), T(0, gy1, -0.15 - r * 0.225));
    }
    for (var c = 0; c < 3; c++) {
      P('steel', box(0.05, 0.035, 0.95, 0.006), T(-0.36 + c * 0.36, gy1, -0.60));
    }
    // mast: two channels, a carriage, two forks, a lift chain and a ram
    for (var s = 0; s < 2; s++) {
      var x = (s ? 1 : -1) * 0.30;
      P('steel', box(0.09, 2.42, 0.13, 0.010), T(x, 1.24, 0.28));
      P('steel', box(0.06, 2.05, 0.09, 0.008), T(x * 0.72, 1.12, 0.36));
    }
    P('steel', box(0.78, 0.10, 0.07, 0.008), T(0, 2.42, 0.28));
    P('steel', box(0.78, 0.10, 0.07, 0.008), T(0, 0.30, 0.28));
    P('steel', box(0.80, 0.30, 0.06, 0.008), T(0, 0.42, 0.36));
    P('steel', cyl(0.055, 0.055, 1.55, 10), T(0, 1.10, 0.24));
    P('steel', cyl(0.035, 0.035, 0.95, 8), T(0, 1.95, 0.24));
    for (var f = 0; f < 2; f++) {
      var fx = (f ? 1 : -1) * 0.26;
      P('steel', box(0.11, 0.045, 1.10, 0.006), T(fx, 0.09, 0.92));
      P('steel', box(0.11, 0.34, 0.045, 0.006), T(fx, 0.24, 0.40));
    }
    // wheels
    for (var w = 0; w < 4; w++) {
      var wx = (w & 1 ? 1 : -1) * (W * 0.5 - 0.02);
      var wz = (w & 2) ? -1.12 : 0.10;
      var rr = (w & 2) ? 0.22 : 0.30;
      P('rubber', cyl(rr, rr, 0.22, 14), T(wx, rr, wz, 0, 0, Math.PI * 0.5));
      P('steel', cyl(rr * 0.5, rr * 0.5, 0.24, 10), T(wx, rr, wz, 0, 0, Math.PI * 0.5));
    }
    // amber beacon and the plate
    B.lamp.push(part(sph(0.075, 10, 6, undefined, 0, Math.PI * 0.6), T(0, gy1 + 0.03, -0.60)));
    B.steel.push(part(cyl(0.055, 0.055, 0.05, 8), T(0, gy1 + 0.02, -0.60)));
    B.marks.push(part(markQuad(MARK.unitno, 0.42, 0.26), T(0, 1.35, -1.63, Math.PI * 0.5, 0, 0)));
    var out = { parts: B, colliders: [[0, 0.9, -0.55, W * 0.5 + 0.08, 0.9, 1.35]] };
    if (N) {
      for (var k in B) {
        for (var i = 0; i < B[k].length; i++) { /* geometry already jittered by bevel */ }
      }
    }
    return out;
  };

  // ---- road tanker ---------------------------------------------------------
  K.tanker = function (N) {
    var B = bag();
    function P(k, g, m) { B[k].push(part(g, m)); }
    var TR = 1.18;                 // tank radius
    var axleR = 0.52;
    // chassis rails run the length of it
    P('steel', box(0.14, 0.22, 10.6, 0.012), T(-0.42, 0.86, -1.60));
    P('steel', box(0.14, 0.22, 10.6, 0.012), T(0.42, 0.86, -1.60));
    for (var xm = 0; xm < 7; xm++) {
      P('steel', box(0.98, 0.10, 0.10, 0.008), T(0, 0.86, 2.9 - xm * 1.5));
    }
    // ---- cab ---------------------------------------------------------------
    P('paintA', Geo.bevelBox(2.30, 1.45, 1.95, 0.10, 2), T(0, 1.78, 3.10));
    P('paintA', Geo.bevelBox(2.26, 0.55, 1.10, 0.09, 1), T(0, 1.05, 3.70));
    P('glass', box(2.02, 0.86, 0.05, 0.01), T(0, 1.95, 4.06));
    P('glass', box(0.05, 0.66, 0.98, 0.01), T(-1.14, 1.88, 3.18));
    P('glass', box(0.05, 0.66, 0.98, 0.01), T(1.14, 1.88, 3.18));
    P('steel', box(2.34, 0.20, 0.28, 0.02), T(0, 0.78, 4.16));
    P('steel', box(1.60, 0.42, 0.08, 0.01), T(0, 1.20, 4.14));
    P('paintA', box(2.26, 0.22, 0.60, 0.03), T(0, 2.52, 3.28));
    P('steel', box(0.06, 0.52, 0.06, 0.006), T(-1.24, 2.20, 3.86));
    P('paintA', box(0.16, 0.34, 0.06, 0.01), T(-1.32, 2.42, 3.86));
    P('steel', box(0.06, 0.52, 0.06, 0.006), T(1.24, 2.20, 3.86));
    P('paintA', box(0.16, 0.34, 0.06, 0.01), T(1.32, 2.42, 3.86));
    P('steel', cyl(0.11, 0.11, 2.30, 10), T(-1.10, 2.40, 2.28));
    P('steel', cyl(0.13, 0.13, 0.20, 10), T(-1.10, 3.58, 2.28));
    P('steel', box(0.60, 0.05, 0.34, 0.008), T(-1.20, 0.72, 3.30));
    P('steel', box(0.60, 0.05, 0.34, 0.008), T(1.20, 0.72, 3.30));
    B.lamp.push(part(cyl(0.115, 0.115, 0.06, 12), T(-0.78, 1.18, 4.19, Math.PI * 0.5)));
    B.lamp.push(part(cyl(0.115, 0.115, 0.06, 12), T(0.78, 1.18, 4.19, Math.PI * 0.5)));
    // ---- the tank ----------------------------------------------------------
    P('paintA', cyl(TR, TR, 7.4, 22, true), T(0, 0.96 + TR, -1.70, 0, 0, Math.PI * 0.5));
    P('paintA', sph(TR, 20, 8, undefined, 0, Math.PI * 0.5), T(0, 0.96 + TR, 2.00, 0, 0, -Math.PI * 0.5));
    P('paintA', sph(TR, 20, 8, undefined, 0, Math.PI * 0.5), T(0, 0.96 + TR, -5.40, 0, 0, Math.PI * 0.5));
    for (var b = 0; b < 5; b++) {
      P('steel', cyl(TR + 0.035, TR + 0.035, 0.075, 22, true),
        T(0, 0.96 + TR, 1.4 - b * 1.55, 0, 0, Math.PI * 0.5));
    }
    // the catwalk, rail and manway hatches on top
    P('steel', box(0.72, 0.05, 6.8, 0.008), T(0, 0.96 + TR * 2 - 0.03, -1.70));
    for (var st = 0; st < 8; st++) {
      var sz = 1.5 - st * 0.95;
      P('steel', cyl(0.022, 0.022, 0.52, 6), T(-0.40, 0.96 + TR * 2 + 0.26, sz));
      P('steel', cyl(0.022, 0.022, 0.52, 6), T(0.40, 0.96 + TR * 2 + 0.26, sz));
    }
    P('steel', cyl(0.022, 0.022, 6.8, 6), T(-0.40, 0.96 + TR * 2 + 0.52, -1.70, Math.PI * 0.5));
    P('steel', cyl(0.022, 0.022, 6.8, 6), T(0.40, 0.96 + TR * 2 + 0.52, -1.70, Math.PI * 0.5));
    for (var mh = 0; mh < 3; mh++) {
      var mz = 0.9 - mh * 2.3;
      P('steel', cyl(0.30, 0.30, 0.14, 12), T(0, 0.96 + TR * 2 - 0.02, mz));
      P('steel', cyl(0.34, 0.30, 0.05, 12), T(0, 0.96 + TR * 2 + 0.09, mz));
      P('steel', box(0.42, 0.04, 0.05, 0.006), T(0.12, 0.96 + TR * 2 + 0.13, mz, 0, 0.5, 0));
    }
    // discharge cabinet, valves and the coiled delivery hose
    P('paintA', Geo.bevelBox(1.10, 0.72, 0.62, 0.04, 1), T(0, 1.16, -5.10));
    P('steel', cyl(0.085, 0.085, 0.55, 10), T(-0.30, 1.05, -5.46, Math.PI * 0.5));
    P('steel', cyl(0.085, 0.085, 0.55, 10), T(0.30, 1.05, -5.46, Math.PI * 0.5));
    P('steel', tor(0.13, 0.016, 5, 12), T(-0.30, 1.42, -5.30));
    P('steel', tor(0.13, 0.016, 5, 12), T(0.30, 1.42, -5.30));
    for (var hc = 0; hc < 4; hc++) {
      P('rubber', tor(0.22 + hc * 0.055, 0.035, 5, 14), T(0.66, 1.70 - hc * 0.02, -4.55, 0, 0, Math.PI * 0.5));
    }
    P('steel', box(2.20, 0.10, 0.10, 0.008), T(0, 0.62, -5.52));
    P('steel', box(0.10, 0.62, 0.08, 0.008), T(-1.02, 0.90, -5.30));
    P('steel', box(0.10, 0.62, 0.08, 0.008), T(1.02, 0.90, -5.30));
    // ---- running gear ------------------------------------------------------
    var AX = [3.20, -2.90, -4.20];
    for (var a = 0; a < AX.length; a++) {
      P('steel', cyl(0.09, 0.09, 2.05, 10), T(0, axleR, AX[a], 0, 0, Math.PI * 0.5));
      for (var sd = 0; sd < 2; sd++) {
        var wx = (sd ? 1 : -1) * 1.02;
        P('rubber', cyl(axleR, axleR, 0.32, 16), T(wx, axleR, AX[a], 0, 0, Math.PI * 0.5));
        if (a > 0) P('rubber', cyl(axleR, axleR, 0.30, 16), T(wx * 1.30, axleR, AX[a], 0, 0, Math.PI * 0.5));
        P('steel', cyl(axleR * 0.55, axleR * 0.55, 0.34, 10), T(wx, axleR, AX[a], 0, 0, Math.PI * 0.5));
      }
      P('steel', box(2.16, 0.06, 0.55, 0.008), T(0, 1.06, AX[a]));
    }
    // mud flaps and the placards
    P('rubber', box(0.62, 0.46, 0.02, 0), T(-1.10, 0.30, -4.75));
    P('rubber', box(0.62, 0.46, 0.02, 0), T(1.10, 0.30, -4.75));
    B.marks.push(part(markQuad(MARK.flam, 0.66, 0.66), T(0, 1.34, -5.44, Math.PI * 0.5, 0, 0)));
    B.marks.push(part(markQuad(MARK.logo, 2.30, 0.80), T(TR + 0.02, 1.05 + TR, -1.70, 0, -Math.PI * 0.5, -Math.PI * 0.5)));
    B.marks.push(part(markQuad(MARK.logo, 2.30, 0.80), T(-TR - 0.02, 1.05 + TR, -1.70, 0, Math.PI * 0.5, Math.PI * 0.5)));
    B.marks.push(part(markQuad(MARK.unitno, 0.90, 0.34), T(0, 1.05, 4.22, Math.PI * 0.5, 0, 0)));
    return { parts: B, colliders: [[0, 1.4, -1.7, 1.30, 1.4, 4.0], [0, 1.5, 3.4, 1.20, 1.5, 1.3]] };
  };

  // ---- scaffold tower with sheeting hooks ---------------------------------
  K.scaffold = function (N, w, d, lifts) {
    var B = bag();
    function P(k, g, m) { B[k].push(part(g, m)); }
    w = w || 2.40; d = d || 1.80; lifts = lifts || 4;
    var LIFT = 2.00;
    var H = lifts * LIFT;
    var i, k;
    for (i = 0; i < 4; i++) {
      var sx = (i & 1 ? 1 : -1) * w * 0.5, sz = (i & 2 ? 1 : -1) * d * 0.5;
      P('steel', cyl(0.024, 0.024, H + 0.4, 8), T(sx, (H + 0.4) * 0.5, sz));
      P('steel', box(0.14, 0.04, 0.14, 0.006), T(sx, 0.02, sz));
    }
    for (k = 1; k <= lifts; k++) {
      var y = k * LIFT;
      P('steel', cyl(0.024, 0.024, w, 8), T(0, y, -d * 0.5, 0, 0, Math.PI * 0.5));
      P('steel', cyl(0.024, 0.024, w, 8), T(0, y, d * 0.5, 0, 0, Math.PI * 0.5));
      P('steel', cyl(0.024, 0.024, d, 8), T(-w * 0.5, y, 0, Math.PI * 0.5));
      P('steel', cyl(0.024, 0.024, d, 8), T(w * 0.5, y, 0, Math.PI * 0.5));
      P('steel', cyl(0.024, 0.024, w, 8), T(0, y + 0.95, -d * 0.5, 0, 0, Math.PI * 0.5));
      P('steel', cyl(0.024, 0.024, w, 8), T(0, y + 0.95, d * 0.5, 0, 0, Math.PI * 0.5));
      // diagonal brace, alternating hand
      var s2 = (k % 2) ? 1 : -1;
      P('steel', cyl(0.020, 0.020, 1, 6),
        strutT(-w * 0.5 * s2, y - LIFT, -d * 0.5, w * 0.5 * s2, y, -d * 0.5));
      P('steel', cyl(0.020, 0.020, 1, 6),
        strutT(-w * 0.5 * s2, y - LIFT, d * 0.5, w * 0.5 * s2, y, d * 0.5));
      // boards
      for (i = 0; i < 4; i++) {
        P('timber', box(w - 0.10, 0.038, d * 0.23, 0.005),
          T(0, y + 0.05, -d * 0.5 + d * 0.14 + i * (d * 0.24)));
      }
      P('timber', box(w - 0.10, 0.15, 0.032, 0.005), T(0, y + 0.14, -d * 0.5 + 0.04));
      // couplers
      for (i = 0; i < 4; i++) {
        var cx2 = (i & 1 ? 1 : -1) * w * 0.5, cz2 = (i & 2 ? 1 : -1) * d * 0.5;
        P('steel', cyl(0.042, 0.042, 0.09, 8), T(cx2, y, cz2));
      }
    }
    // access ladder up one face
    for (k = 0; k < Math.round(H / 0.30); k++) {
      P('steel', cyl(0.014, 0.014, 0.42, 5), T(0, 0.35 + k * 0.30, d * 0.5 + 0.16, 0, 0, Math.PI * 0.5));
    }
    P('steel', cyl(0.020, 0.020, H, 6), T(-0.21, H * 0.5, d * 0.5 + 0.16));
    P('steel', cyl(0.020, 0.020, H, 6), T(0.21, H * 0.5, d * 0.5 + 0.16));
    return { parts: B, colliders: [[0, H * 0.5, 0, w * 0.5 + 0.1, H * 0.5, d * 0.5 + 0.1]] };
  };

  // ---- workbench, for the pump house --------------------------------------
  K.workbench = function () {
    var B = bag();
    function P(k, g, m) { B[k].push(part(g, m)); }
    var w = 2.20, d = 0.72, h = 0.90;
    P('timber', box(w, 0.055, d, 0.008), T(0, h, 0));
    for (var i = 0; i < 4; i++) {
      P('steel', box(0.07, h, 0.07, 0.008),
        T((i & 1 ? 1 : -1) * (w * 0.5 - 0.09), h * 0.5, (i & 2 ? 1 : -1) * (d * 0.5 - 0.07)));
    }
    P('steel', box(w - 0.20, 0.05, d - 0.14, 0.006), T(0, 0.26, 0));
    P('steel', box(w, 0.85, 0.04, 0.006), T(0, h + 0.44, -d * 0.5));
    // vice, offcuts, a couple of tools on the board
    P('steel', box(0.20, 0.16, 0.26, 0.012), T(-w * 0.36, h + 0.10, 0.06));
    P('steel', cyl(0.020, 0.020, 0.30, 6), T(-w * 0.36, h + 0.20, 0.06, 0, 0, Math.PI * 0.5));
    P('steel', box(0.06, 0.30, 0.03, 0.004), T(0.10, h + 0.30, -d * 0.5 + 0.04));
    P('steel', box(0.10, 0.24, 0.03, 0.004), T(0.30, h + 0.28, -d * 0.5 + 0.04));
    P('rust', cyl(0.045, 0.045, 0.52, 8), T(0.55, h + 0.08, 0.08, 0, 0.3, Math.PI * 0.5));
    return { parts: B, colliders: [[0, h * 0.5, 0, w * 0.5, h * 0.5, d * 0.5]] };
  };

  // ---- leaning ladder ------------------------------------------------------
  K.ladder = function (len) {
    var B = bag();
    function P(k, g, m) { B[k].push(part(g, m)); }
    len = len || 4.2;
    P('rust', box(0.05, len, 0.10, 0.006), T(-0.24, len * 0.5, 0));
    P('rust', box(0.05, len, 0.10, 0.006), T(0.24, len * 0.5, 0));
    var n = Math.round(len / 0.30);
    for (var i = 1; i < n; i++) {
      P('rust', cyl(0.014, 0.014, 0.48, 5), T(0, i * 0.30, 0, 0, 0, Math.PI * 0.5));
    }
    return { parts: B, colliders: [] };
  };

  // ==========================================================================
  // GAME.PropsRefinery
  // ==========================================================================
  function PropsRefinery(ctx) {
    this.ctx = ctx || {};
    this.root = new THREE.Object3D();
    this.root.name = 'props_refinery';
    this.root.matrixAutoUpdate = false;
    this.colliders = [];

    // Deterministic and independent of every other system's stream, so adding a
    // spark somewhere else cannot reshuffle the laydown yard.
    var seed = ((this.ctx.seed || 20260801) ^ 0x52465052) >>> 0;
    this.rng = new GAME.RNG(seed);
    this.noise = new GAME.Noise((seed ^ 0x9E3779B1) >>> 0);

    this.time = 0;
    // The level's own evening breeze; update() adopts ctx.weather if it appears.
    this.windDir = new THREE.Vector2(0.72, 0.69).normalize();
    this.windSpeed = 4.2;

    this.tex = {};
    this.mats = {};
    this.B = {};                    // instanced batches by key
    this.S = {                      // one-off geometry, merged per material
      steel: [], paint: [], paintA: [], paintB: [], rust: [], concrete: [],
      timber: [], clad: [], rubber: [], glass: [], lamp: [], marks: [],
      sand: [], grate: []
    };
    this._occ = new Map();          // our own occupancy grid
    this._skipped = 0;
    this._rayOK = true;
    this._qout = [];
    this.hash = null;

    this.tapes = [];                // wind-animated barrier tape runs
    this.vents = null;              // steam puff batch
    this.ventDefs = [];
    this.weeds = [];                // tumbleweeds that rock in the gusts
    this.beacons = [];              // emissive fixtures that pulse

    this.stats = { instanced: 0, draws: 0, tris: 0, colliders: 0, skipped: 0, full: [] };

    // Fallback site metrics, all overwritten by _probeLayout the moment the
    // level publishes anchors.  They exist so that a level which failed to
    // build does not take this module down with it.
    this.site = { x0: -96, x1: 96, z0: -104, z1: 88 };
    this.pave = { x0: -78, x1: 78, z0: -94, z1: 76 };
    this.road = { x0: -7.6, x1: 7.6 };
    this.A = null;

    try { if (this.ctx.scene) this.ctx.scene.add(this.root); }
    catch (e) { GAME.logError('propsR.ctor', e); }
  }

  PropsRefinery.prototype._phase = function (name, fn) {
    try { fn.call(this); } catch (e) { GAME.logError('propsR.' + name, e); }
    return GAME.yieldFrame();
  };

  PropsRefinery.prototype.build = async function (ctx) {
    if (ctx) this.ctx = ctx;
    await this._phase('textures', this._initTextures);
    await this._phase('materials', this._initMaterials);
    await this._phase('layout', this._probeLayout);
    await this._phase('kit', this._buildKit);
    // Heavy plant first: the tanker, the forklift, the containers and the skips
    // are the only things here that need four metres of clear ground, and a
    // yard is blocked out with its plant and then filled in around it - which
    // is also how it is actually laid out.  Running them after the small stuff
    // had taken every site is how three of five large props failed to land in
    // the harbor build.
    await this._phase('heavy', this._dressHeavy);
    await this._phase('laydown', this._dressLaydown);
    await this._phase('racks', this._dressRacks);
    // The carriageway pass runs BEFORE the kerbside one because it is the only
    // pass that has to win its ground: the occupancy grid is first-come, and
    // the near foreground of the level's signature frame is not something to
    // leave to whatever is left over.
    await this._phase('carriageway', this._dressCarriageway);
    await this._phase('road', this._dressRoad);
    await this._phase('unit200', this._dressUnit200);
    await this._phase('tankfarm', this._dressTankFarm);
    await this._phase('flare', this._dressFlarePad);
    await this._phase('pumphouse', this._dressPumpHouse);
    await this._phase('control', this._dressControl);
    await this._phase('entrance', this._dressEntrance);
    await this._phase('deck', this._dressRackDeck);
    await this._phase('sand', this._dressSand);
    await this._phase('scrub', this._dressScrub);
    await this._phase('litter', this._dressLitter);
    await this._phase('marks', this._dressGroundMarks);
    await this._phase('wind', this._dressWind);
    await this._phase('commit', this._commit);
    return this;
  };

  // --------------------------------------------------------------------------
  // Textures
  // --------------------------------------------------------------------------
  PropsRefinery.prototype._initTextures = function () {
    var t = this.tex;
    var aniso = 8;
    try {
      if (this.ctx.renderer && this.ctx.renderer.capabilities) {
        aniso = Math.min(8, this.ctx.renderer.capabilities.getMaxAnisotropy() || 8);
      }
    } catch (e) { /* default */ }
    var grunge = TX.grunge(256, 0x5AC1, 1.15);
    t.hazard = TX.tex(TX.hazard(256, 0x11A2, grunge), true, 1, 1, aniso);
    t.marks = TX.tex(TX.markAtlas(1024, 0x33B7, grunge), true, 1, 1, aniso);
    if (t.marks) { t.marks.wrapS = t.marks.wrapT = THREE.ClampToEdgeWrapping; }
    t.tape = TX.tex(TX.tape(256, 64, 0x77C3), true, 1, 1, aniso);
    t.puff = TX.tex(TX.puff(128, 0x2255), true, 1, 1, 2);
    if (t.puff) { t.puff.wrapS = t.puff.wrapT = THREE.ClampToEdgeWrapping; }
    t.sack = TX.tex(TX.sack(256, 0x9911, grunge), true, 1, 1, aniso);
  };

  // --------------------------------------------------------------------------
  // Materials.  Every request goes through _material so a missing library, a
  // thrown generator or an unknown name degrades to a plausible painted surface
  // instead of taking the pass down.
  // --------------------------------------------------------------------------
  PropsRefinery.prototype._material = function (libName, opts, fallbackHex, fallbackRough, fallbackMetal) {
    var m = null;
    var lib = this.ctx && this.ctx.materials;
    if (lib && typeof lib.get === 'function') {
      try { m = lib.get(libName, opts); }
      catch (e) { GAME.logError('propsR.mat:' + libName, e); m = null; }
    }
    if (m && m.isMaterial) return m;
    m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(fallbackHex === undefined ? 0x807a70 : fallbackHex,
        THREE.SRGBColorSpace),
      roughness: fallbackRough === undefined ? 0.80 : fallbackRough,
      metalness: fallbackMetal === undefined ? 0.0 : fallbackMetal,
      // A stock material has no wear shader, so a wear MASK in the colour
      // attribute would multiply straight onto albedo and paint everything
      // filthy.  Drop vertex colours on the fallback path.
      vertexColors: false,
      envMapIntensity: (opts && opts.envMapIntensity) || 1.0
    });
    m.name = 'refinery_prop_fallback_' + libName;
    return m;
  };

  PropsRefinery.prototype._initMaterials = function () {
    var m = this.mats, t = this.tex;
    var W = { vertexColors: true, wearMode: 'wear' };
    function o(extra) {
      var out = { vertexColors: true, wearMode: 'wear' };
      for (var k in extra) out[k] = extra[k];
      return out;
    }
    // METALNESS CEILING.  The sun is under the horizon and the probe with it;
    // anything above ~0.6 here renders as a black cut-out with a couple of
    // specular dots on it, which is exactly how the harbor's first pass failed.
    m.steel = this._material('structural_steel',
      o({ albedoTarget: 0x6d7073, roughness: 0.58, metalness: 0.52, envMapIntensity: 1.35 }),
      0x63666a, 0.58, 0.5);
    m.rust = this._material('rusted_metal',
      o({ roughness: 0.80, metalness: 0.46, envMapIntensity: 1.10 }), 0x7a4a30, 0.80, 0.45);
    m.paintBlue = this._material('painted_metal',
      o({ albedoTarget: 0x3c5a76, roughness: 0.52, metalness: 0.34, envMapIntensity: 1.30 }),
      0x3c5a76, 0.52, 0.3);
    m.paintRed = this._material('painted_metal',
      o({ albedoTarget: 0x8e3a2b, roughness: 0.48, metalness: 0.30, envMapIntensity: 1.30 }),
      0x8e3a2b, 0.48, 0.3);
    m.paintYellow = this._material('painted_metal',
      o({ albedoTarget: 0xa9821f, roughness: 0.55, metalness: 0.36, envMapIntensity: 1.25 }),
      0xa9821f, 0.55, 0.35);
    m.paintGreen = this._material('painted_metal',
      o({ albedoTarget: 0x466b52, roughness: 0.54, metalness: 0.34, envMapIntensity: 1.25 }),
      0x466b52, 0.54, 0.32);
    m.paintPale = this._material('painted_metal',
      o({ albedoTarget: 0xa8a89f, roughness: 0.52, metalness: 0.32, envMapIntensity: 1.35 }),
      0xa8a89f, 0.52, 0.3);
    m.machine = this._material('painted_metal',
      o({ albedoTarget: 0x4c6354, roughness: 0.46, metalness: 0.42, envMapIntensity: 1.30 }),
      0x4c6354, 0.46, 0.4);
    m.clad = this._material('corrugated_metal',
      o({ roughness: 0.58, metalness: 0.50, envMapIntensity: 1.30 }), 0x71767a, 0.58, 0.5);
    m.timber = this._material('wood_plank',
      o({ albedoTarget: 0x7a6849, roughness: 0.90, metalness: 0.0 }), 0x7a6849, 0.90, 0.0);
    m.concrete = this._material('concrete',
      o({ roughness: 0.92, metalness: 0.0 }), 0x8a857c, 0.92, 0.0);
    m.rubber = this._material('rubber',
      o({ roughness: 0.88, metalness: 0.0, envMapIntensity: 0.8 }), 0x2a2827, 0.88, 0.0);
    m.sand = this._material('sand',
      o({ albedoTarget: 0x8b7c5e, roughness: 0.96, metalness: 0.0, envMapIntensity: 0.7 }),
      0x8b7c5e, 0.96, 0.0);
    m.scrub = this._material('dirt',
      o({ albedoTarget: 0x6d5d40, roughness: 0.94, metalness: 0.0, envMapIntensity: 0.7 }),
      0x6d5d40, 0.94, 0.0);
    m.grate = this._material('steel_grate',
      o({ roughness: 0.70, metalness: 0.45, envMapIntensity: 1.2 }), 0x55514b, 0.72, 0.45);
    m.glass = this._material('glass', { envMapIntensity: 2.2 }, 0x243038, 0.10, 0.0);

    // ---- local materials ----------------------------------------------------
    m.hazard = new THREE.MeshStandardMaterial({
      map: t.hazard || null, color: 0xffffff, roughness: 0.62, metalness: 0.22,
      envMapIntensity: 1.2, vertexColors: false
    });
    m.hazard.name = 'refinery_hazard';
    m.sackcloth = new THREE.MeshStandardMaterial({
      map: t.sack || null, color: 0xffffff, roughness: 0.94, metalness: 0.0,
      envMapIntensity: 0.9, vertexColors: false
    });
    m.sackcloth.name = 'refinery_sack';
    // Ground/prop marks: alpha-cut, polygon-offset so they never z-fight the
    // apron they are lying on.
    m.marks = new THREE.MeshStandardMaterial({
      map: t.marks || null, color: 0xffffff, roughness: 0.86, metalness: 0.0,
      transparent: true, depthWrite: false, alphaTest: 0.04, side: THREE.DoubleSide,
      envMapIntensity: 0.9,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3
    });
    m.marks.name = 'refinery_marks';
    m.tape = new THREE.MeshStandardMaterial({
      map: t.tape || null, color: 0xffffff, roughness: 0.70, metalness: 0.0,
      side: THREE.DoubleSide, envMapIntensity: 1.0
    });
    m.tape.name = 'refinery_tape';
    m.puff = new THREE.MeshBasicMaterial({
      map: t.puff || null, color: 0xffffff, transparent: true, depthWrite: false,
      side: THREE.DoubleSide, blending: THREE.NormalBlending, vertexColors: false
    });
    m.puff.name = 'refinery_steam';
    // Emissive fixture faces.  This file adds NO scene lights - lighting.js is
    // at its 24-practical cap and the level owns every one of them - so these
    // are self-lit surfaces that the bloom picks up, nothing more.
    m.lampAmber = new THREE.MeshStandardMaterial({
      color: 0x241a0c, roughness: 0.30, metalness: 0.0,
      emissive: new THREE.Color().setHex(0xff9a34, THREE.SRGBColorSpace),
      emissiveIntensity: 4.2
    });
    m.lampAmber.name = 'refinery_beacon';
    m.lampWarm = new THREE.MeshStandardMaterial({
      color: 0x2a2318, roughness: 0.30, metalness: 0.0,
      emissive: new THREE.Color().setHex(0xffc07a, THREE.SRGBColorSpace),
      emissiveIntensity: 3.0
    });
    m.lampWarm.name = 'refinery_marker';
  };

  // --------------------------------------------------------------------------
  // Layout.  Everything is read from level.anchors, never from a camera pose.
  // --------------------------------------------------------------------------
  PropsRefinery.prototype._probeLayout = function () {
    var lvl = this.ctx && this.ctx.level;
    var A = (lvl && lvl.anchors) || null;
    this.A = A;
    if (A && A.site) {
      this.site = { x0: A.site.x0, x1: A.site.x1, z0: A.site.z0, z1: A.site.z1 };
      this.pave = { x0: A.site.paveX0, x1: A.site.paveX1, z0: A.site.paveZ0, z1: A.site.paveZ1 };
    }
    if (A && A.road) this.road = { x0: A.road.x0, x1: A.road.x1, cross: A.road.cross };
    // the site's own breeze, so drift and litter are baked against the wind
    // that will actually blow them at run time
    try {
      if (lvl && lvl.windDir && isFinite(lvl.windDir.x)) {
        this.windDir.set(lvl.windDir.x, lvl.windDir.y).normalize();
        if (lvl.windSpeed > 0.05) this.windSpeed = lvl.windSpeed;
      }
    } catch (e) { /* our own breeze is fine */ }

    // Broadphase over the LEVEL's colliders so no prop lands inside a column
    // skirt, a bund wall or a rack leg.
    this.hash = new GAME.SpatialHash(6.0);
    var cols = (lvl && lvl.colliders) || [];
    for (var i = 0; i < cols.length; i++) {
      var c = cols[i];
      if (!c || !c.center || !c.halfExtents) continue;
      try {
        GAME.Collision.boxBounds(c, _bmin, _bmax);
        this.hash.insert(c, _bmin, _bmax);
      } catch (e2) { /* skip a malformed collider */ }
    }
    this._levelColliders = cols.length;
  };

  // --------------------------------------------------------------------------
  // Ground.  sampleGround is the level's own authored surface (site fall, road
  // crown, plinth step, bund dish) and it is exact, so it is the primary; the
  // raycast is only the backstop for a level that did not publish one.
  // --------------------------------------------------------------------------
  PropsRefinery.prototype._ground = function (x, z) {
    var lvl = this.ctx && this.ctx.level;
    if (lvl && typeof lvl.sampleGround === 'function') {
      try {
        var s = lvl.sampleGround(x, z);
        if (isFinite(s)) return s;
      } catch (e) { /* fall through */ }
    }
    if (this._rayOK && lvl && typeof lvl.raycast === 'function') {
      _rayO.set(x, 30, z); _rayD.set(0, -1, 0);
      try {
        var r = lvl.raycast(_rayO, _rayD, 60);
        if (r && r.hit && r.point && isFinite(r.point.y)) return r.point.y;
      } catch (e2) { this._rayOK = false; }
    }
    return 0;
  };

  // MEASURE THE GRADE ACROSS THE PROP'S OWN FOOTPRINT.
  //
  // This site falls 0.45 m north-south, is crowned 85 mm over the carriageway,
  // dished 550 mm inside every bund and stepped 280-420 mm onto six kerbed
  // plinths.  Dropping a prop level onto any of that floats its downhill edge,
  // and the step cases are worse: a 1.2 m pallet straddling a kerb has 0.42 m
  // of air under half of it.  So sample the ground at the four corners of the
  // footprint, fit a normal, and report the RELIEF as well - a caller seeing
  // more relief than the prop can bridge should move, not tilt.
  var _srf = { y: 0, relief: 0, n: new THREE.Vector3(0, 1, 0), dydx: 0, dydz: 0 };
  PropsRefinery.prototype._surface = function (x, z, r) {
    r = Math.max(0.12, r || 0.4);
    var c = this._ground(x, z);
    var xp = this._ground(x + r, z), xn = this._ground(x - r, z);
    var zp = this._ground(x, z + r), zn = this._ground(x, z - r);
    var lo = Math.min(c, Math.min(Math.min(xp, xn), Math.min(zp, zn)));
    var hi = Math.max(c, Math.max(Math.max(xp, xn), Math.max(zp, zn)));
    var dydx = (xp - xn) / (2 * r);
    var dydz = (zp - zn) / (2 * r);
    _srf.y = (c * 2 + xp + xn + zp + zn) / 6;
    _srf.relief = hi - lo;
    _srf.dydx = dydx; _srf.dydz = dydz;
    // clamp the modelled slope: a prop settles onto the LOCAL plane, it does
    // not fold itself over a kerb
    var mx = M.clamp(dydx, -0.30, 0.30), mz = M.clamp(dydz, -0.30, 0.30);
    _srf.n.set(-mx, 1, -mz).normalize();
    return _srf;
  };

  // Is level geometry already occupying this sphere?  FLOOR COLLIDERS ARE
  // EXCLUDED and that exclusion is the point: a ground slab is a box whose top
  // face is the ground, so a test sphere resting on the ground always overlaps
  // it, and including them rejects every site on the whole site.
  PropsRefinery.prototype._blocked = function (x, y, z, r) {
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

  PropsRefinery.prototype._occupied = function (x, z, r) {
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
  PropsRefinery.prototype._occupy = function (x, z, r) {
    var cs = 3;
    var k = Math.floor(x / cs) * 73856093 ^ Math.floor(z / cs) * 19349663;
    var l = this._occ.get(k);
    if (!l) { l = []; this._occ.set(k, l); }
    l.push(x, z, r);
  };

  PropsRefinery.prototype._inSite = function (x, z, pad) {
    pad = pad || 0;
    var s = this.site;
    return x > s.x0 + pad && x < s.x1 - pad && z > s.z0 + pad && z < s.z1 - pad;
  };

  // Is the carriageway clear here?  The road is the level's leading line and
  // the only walking surface that must stay walkable end to end, so standing
  // masses are kept out of the middle of it - but litter, cones, a dropped
  // offcut and a spill belong ON it, because a road with nothing whatever on it
  // is not a road, it is a runway somebody swept.
  PropsRefinery.prototype._onRoad = function (x, z, low) {
    var cx = (this.road.x0 + this.road.x1) * 0.5, hw = (this.road.x1 - this.road.x0) * 0.5;
    var cr = this.road.cross;
    var onMain = Math.abs(x - cx) < hw + (low ? -hw * 0.38 : 0.45);
    var onCross = false;
    if (cr) {
      var d = (cr.z1 - cr.z0);
      var lo = cr.z0 - (low ? -d * 0.19 : 0.45), hi = cr.z1 + (low ? -d * 0.19 : 0.45);
      onCross = z > lo && z < hi && x > cr.x0 - 0.5 && x < cr.x1 + 0.5;
    }
    return onMain || onCross;
  };

  // The one call every ground placement goes through.
  //
  //   opts: { r clearance radius, h prop height, yaw, tilt extra random lean,
  //           scale, sx/sy/sz, maxRelief, road:true to allow the carriageway,
  //           low:true for ankle-height props, color, sink, collider:[hx,hy,hz] }
  //
  // Returns the settled ground height, or null if the site was rejected.
  PropsRefinery.prototype._place = function (batch, x, z, opts) {
    if (!batch || !batch.add) return null;
    opts = opts || {};
    var r = opts.r === undefined ? 0.5 : opts.r;
    if (!this._inSite(x, z, 0.5)) { this._skipped++; return null; }
    if (!opts.road && this._onRoad(x, z, opts.low)) { this._skipped++; return null; }
    if (this._occupied(x, z, r)) { this._skipped++; return null; }
    var s = this._surface(x, z, Math.max(0.25, r * 0.85));
    var maxRelief = opts.maxRelief === undefined ? 0.16 + r * 0.10 : opts.maxRelief;
    if (s.relief > maxRelief) { this._skipped++; return null; }   // a kerb, not a slope
    var y = s.y;
    var h = opts.h === undefined ? 0.6 : opts.h;
    var cr = opts.clearR === undefined ? r * 0.8 : opts.clearR;
    if (this._blocked(x, y + h * 0.5, z, cr)) { this._skipped++; return null; }
    var yaw = opts.yaw === undefined ? this.rng.range(0, M.TAU) : opts.yaw;
    var tilt = opts.tilt === undefined ? 0.020 : opts.tilt;
    _vn.copy(s.n);
    if (tilt > 0) {
      _vn.x += this.rng.gaussian(0, tilt);
      _vn.z += this.rng.gaussian(0, tilt);
      _vn.normalize();
    }
    // KNOCKED OVER. `lay` tilts the settle normal by a real angle about a
    // chosen azimuth, so a cone can lie on its side and a drum can be on its
    // end. A prop set in which nothing has ever been hit by a fork truck is
    // the "perfectly uniform anything" on the instant-fail list.
    if (opts.lay) {
      var la2 = opts.layDir === undefined ? this.rng.range(0, M.TAU) : opts.layDir;
      var ca2 = Math.cos(opts.lay), sa2 = Math.sin(opts.lay);
      _vn.set(Math.cos(la2) * sa2, ca2, Math.sin(la2) * sa2).normalize();
    }
    var sc = opts.scale === undefined ? 1 : opts.scale;
    var ok = batch.add(
      settleT(x, y - (opts.sink || 0), z, yaw, _vn,
        sc * (opts.sx || 1), sc * (opts.sy || 1), sc * (opts.sz || 1)),
      opts.color || wearTint(this.rng, null, opts.grime));
    if (!ok) return null;
    this._occupy(x, z, r);
    if (opts.collider) this._collider(x, y, z, opts.collider, yaw);
    return y;
  };

  PropsRefinery.prototype._collider = function (x, y, z, he, yaw, material) {
    _eu.set(0, yaw || 0, 0, 'YXZ');
    this.colliders.push({
      type: 'box',
      center: new THREE.Vector3(x + (he[3] || 0), y + he[1], z + (he[4] || 0)),
      halfExtents: new THREE.Vector3(he[0], he[1], he[2]),
      quaternion: new THREE.Quaternion().setFromEuler(_eu),
      material: material || 'metal'
    });
  };

  PropsRefinery.prototype._static = function (key, geometry, matrix) {
    var arr = this.S[key];
    if (!arr) arr = this.S[key] = [];
    arr.push(part(geometry, matrix));
  };

  // Drop a whole one-off assembly (a vehicle, a scaffold) into the static
  // buckets at a world transform, settled on the measured ground.
  PropsRefinery.prototype._placeRig = function (rig, x, z, yaw, opts) {
    if (!rig || !rig.parts) return null;
    opts = opts || {};
    var s = this._surface(x, z, opts.r || 2.0);
    if (opts.maxRelief !== undefined && s.relief > opts.maxRelief) { this._skipped++; return null; }
    var y = s.y + (opts.lift || 0);
    _vn.copy(s.n);
    var base = settleT(x, y, z, yaw, _vn).clone();
    var mm = new THREE.Matrix4();
    for (var k in rig.parts) {
      var list = rig.parts[k];
      var bucket = this.S[k] ? k : 'steel';
      for (var i = 0; i < list.length; i++) {
        mm.copy(base);
        if (list[i].matrix) mm.multiply(list[i].matrix);
        this._static(bucket, list[i].geometry, mm);
      }
    }
    if (rig.colliders && !opts.noCollide) {
      for (var c = 0; c < rig.colliders.length; c++) {
        var q = rig.colliders[c];
        _va.set(q[0], 0, q[2]).applyQuaternion(_qs.setFromEuler(_eu.set(0, yaw, 0, 'YXZ')));
        this.colliders.push({
          type: 'box',
          center: new THREE.Vector3(x + _va.x, y + q[1], z + _va.z),
          halfExtents: new THREE.Vector3(q[3], q[4], q[5]),
          quaternion: new THREE.Quaternion().setFromEuler(_eu.set(0, yaw, 0, 'YXZ')),
          material: 'metal'
        });
      }
    }
    if (opts.r) this._occupy(x, z, opts.r);
    return y;
  };

  // --------------------------------------------------------------------------
  // Kit assembly
  // --------------------------------------------------------------------------
  PropsRefinery.prototype._uvScale = function (name, texels) {
    try {
      if (this.ctx.materials && this.ctx.materials.uvScaleFor) {
        var s = this.ctx.materials.uvScaleFor(name, texels || 500);
        if (isFinite(s) && s > 0) return s;
      }
    } catch (e) { /* library still booting */ }
    return 1.2;
  };

  // Re-UV a merged prop to the library's declared texel density, copy uv1 for
  // the AO channel, and paint the dust/wear mask.  Every instanced prop goes
  // through here so texture density does not visibly jump between a 0.3 m cone
  // and a 6 m container - the tell that a prop set was authored piecemeal.
  // ---- uvAbs, AND WHY IT HAD TO EXIST -------------------------------------
  // MEASURED IN THE SIGNATURE FRAME. Two jersey barriers at 18 and 22 m from the
  // hero1 mark printed as FLAT PALE PINK SLABS - no hazard striping, no texture
  // of any kind - which is item one on the instant-fail list on two of the
  // largest props in the near field.
  //
  // The cause is this function. Every batch is re-UV'd to the library's declared
  // TEXEL DENSITY for its material name, and `uvScaleFor('concrete', 480)` is
  // 480 / (1024 * repeat) = about 0.23 tiles per metre - correct for a 1024-texel
  // concrete map. But a barrier does not wear concrete; it wears the LOCAL hazard
  // tile, which is 256 px carrying 2.7 stripe pairs and therefore has to run at
  // roughly 1.5 tiles per metre to put a 120 mm band on the world. At 0.23 the
  // whole 2.3 m barrier sampled a 0.27 x 0.19 corner of the tile - one flat
  // region between two diagonals - so it rendered as a single colour.
  //
  // Texel density is the right default and stays the default. `uvAbs` is the
  // override for a prop whose map is authored in WORLD units rather than in
  // texels, which is every hazard-striped thing on the site.
  PropsRefinery.prototype._fin = function (geo, matName, wear, texels, uvAbs) {
    if (!geo) return null;
    try {
      Geo.worldUV(geo, (uvAbs !== undefined && uvAbs > 0)
        ? uvAbs : this._uvScale(matName, texels));
    } catch (e) { /* keep builder uv */ }
    Geo.copyUV1(geo);
    paintWear(geo, wear || {});
    try { geo.computeBoundingSphere(); geo.computeBoundingBox(); } catch (e2) { /* ignore */ }
    return geo;
  };

  PropsRefinery.prototype._buildKit = function () {
    var N = this.noise, R = this.rng, m = this.mats, self = this;
    var G = this.G = {};
    function fin(g, name, wear, texels, uvAbs) {
      return self._fin(g, name, wear, texels, uvAbs);
    }
    // A batch is ALWAYS created, even if its builder returned nothing: forty
    // dressing call sites reach into this.B by name, and making one of them
    // conditional on a geometry that might be null turns a cosmetic failure
    // into a throw in the middle of a pass, which loses every prop after it.
    function bat(key, geo, mat, max, shadow) {
      if (!geo || !geo.attributes || !geo.attributes.position) {
        geo = new THREE.BoxGeometry(0.02, 0.02, 0.02);
      }
      self.B[key] = new Batch(geo, mat || m.steel, max, shadow);
      return self.B[key];
    }

    var dusty = { noise: N, grime: 0.40, edge: 0.26, dust: 0.55, hiY: 1.0 };

    // ---- drums, in three services -------------------------------------------
    G.drum = fin(K.drum(N, R), 'painted_metal', { noise: N, grime: 0.46, edge: 0.34, dust: 0.7, hiY: 0.9 }, 620);
    bat('drumBlue', G.drum, m.paintBlue, 104);
    bat('drumRust', G.drum.clone(), m.rust, 104);
    bat('drumPale', G.drum.clone(), m.paintPale, 84);
    G.drumSide = fin(K.drum(N, R), 'painted_metal', { noise: N, grime: 0.52, edge: 0.38, dust: 0.6, hiY: 0.9 }, 620);
    bat('drumSide', G.drumSide, m.rust, 46);

    // ---- unit loads ----------------------------------------------------------
    // ---- CAPS -----------------------------------------------------------------
    // An overflowing batch drops every placement after the cap AND calls
    // GAME.logError from _commit, which fails the capture outright - so the caps
    // on every batch the gate-approach pass draws from are raised by more than
    // the pass can possibly consume. Unused instance slots cost nothing at draw
    // time (mesh.count is set to n), only a few hundred bytes of buffer.
    bat('ibc', fin(K.ibc(N), 'painted_metal', { noise: N, grime: 0.34, edge: 0.22, dust: 0.6, hiY: 1.2 }, 560), m.paintPale, 44);
    bat('pallet', fin(K.pallet(N, R), 'wood_plank', { noise: N, grime: 0.52, edge: 0.40, dust: 0.5, hiY: 0.2 }, 520), m.timber, 112);
    bat('sacks', fin(K.sackPallet(N, R), 'fabric', { noise: N, grime: 0.40, edge: 0.16, dust: 0.8, hiY: 0.8 }, 420), m.sackcloth, 24);
    bat('crate', fin(K.crate(N, R), 'wood_plank', { noise: N, grime: 0.44, edge: 0.36, dust: 0.6, hiY: 0.9 }, 520), m.timber, 56);

    // ---- traffic and safety ---------------------------------------------------
    bat('cone', fin(K.cone(), 'plastic', { noise: N, grime: 0.50, edge: 0.24, dust: 0.7, hiY: 0.6 }, 700), m.paintRed, 132, true);
    // uvAbs 1.5: both of these wear the LOCAL hazard tile, not a library map, and
    // it has to be scaled in world units - see the note on _fin.
    bat('barrier', fin(K.barrier(N), 'concrete', { noise: N, grime: 0.44, edge: 0.30, dust: 0.6, hiY: 0.9 }, 480, 1.5), m.hazard, 64);
    bat('bollard', fin(K.bollard(), 'painted_metal', { noise: N, grime: 0.42, edge: 0.34, dust: 0.5, hiY: 1.0 }, 640, 1.5), m.hazard, 96);
    bat('ext', fin(K.extStation(), 'painted_metal', { noise: N, grime: 0.30, edge: 0.20, dust: 0.5, hiY: 1.4 }, 620), m.paintRed, 30);
    bat('shower', fin(K.safetyShower(), 'painted_metal', { noise: N, grime: 0.30, edge: 0.18, dust: 0.5, hiY: 2.0 }, 620), m.paintGreen, 12);
    bat('monitor', fin(K.fireMonitor(), 'painted_metal', { noise: N, grime: 0.36, edge: 0.24, dust: 0.5, hiY: 1.6 }, 620), m.paintRed, 14);
    bat('sign', fin(K.signPost(), 'painted_metal', { noise: N, grime: 0.34, edge: 0.20, dust: 0.5, hiY: 1.6 }, 620), m.paintPale, 80, false);
    bat('signBent', fin(K.signPost(0.78, 0.56, 1.55, true), 'painted_metal', { noise: N, grime: 0.44, edge: 0.30, dust: 0.6, hiY: 1.6 }, 620), m.paintPale, 44, false);
    bat('hose', fin(K.hoseReel(N), 'painted_metal', { noise: N, grime: 0.36, edge: 0.22, dust: 0.5, hiY: 1.1 }, 620), m.paintRed, 18);
    bat('coil', fin(K.coilHose(), 'rubber', { noise: N, grime: 0.52, edge: 0.18, dust: 0.7, hiY: 0.3 }, 620), m.rubber, 32, false);

    // ---- process odds and ends -----------------------------------------------
    bat('valve', fin(K.valveStand(N), 'painted_metal', { noise: N, grime: 0.40, edge: 0.28, dust: 0.5, hiY: 1.6 }, 560), m.paintGreen, 34);
    bat('bottle', fin(K.gasBottle(), 'painted_metal', { noise: N, grime: 0.36, edge: 0.26, dust: 0.5, hiY: 1.3 }, 640), m.paintGreen, 64, false);
    bat('bottlePack', fin(K.bottlePack(), 'painted_metal', { noise: N, grime: 0.38, edge: 0.26, dust: 0.5, hiY: 1.5 }, 560), m.paintPale, 32);
    bat('jbox', fin(K.junctionBox(), 'painted_metal', { noise: N, grime: 0.44, edge: 0.24, dust: 0.5, hiY: 0.4 }, 700), m.paintPale, 48, false);
    bat('tray', fin(K.cableTray(2.4), 'structural_steel', { noise: N, grime: 0.46, edge: 0.26, dust: 0.6, hiY: 0.3 }, 560), m.steel, 46, false);
    bat('toolbox', fin(K.toolChest(), 'painted_metal', { noise: N, grime: 0.42, edge: 0.34, dust: 0.5, hiY: 0.9 }, 620), m.paintRed, 24);
    bat('cableDrum', fin(K.cableDrum(N, true), 'wood_plank', { noise: N, grime: 0.46, edge: 0.30, dust: 0.6, hiY: 1.4 }, 480), m.timber, 22);
    bat('cableDrumBare', fin(K.cableDrum(N, false), 'wood_plank', { noise: N, grime: 0.52, edge: 0.36, dust: 0.6, hiY: 1.4 }, 480), m.timber, 10);
    bat('gully', fin(K.gully(N), 'steel_grate', { noise: N, grime: 0.62, edge: 0.30, dust: 0.4, hiY: 0.2 }, 640), m.grate, 44, false);

    // ---- laydown -------------------------------------------------------------
    bat('pipe', fin(K.pipeLength(N, 0.16, 6.0), 'painted_metal', { noise: N, grime: 0.44, edge: 0.28, dust: 0.7, hiY: 0.4 }, 520), m.paintPale, 212);
    bat('pipeFat', fin(K.pipeLength(N, 0.30, 5.2), 'rusted_metal', { noise: N, grime: 0.50, edge: 0.30, dust: 0.7, hiY: 0.7 }, 520), m.rust, 70);
    bat('dunnage', fin(K.dunnage(N), 'wood_plank', { noise: N, grime: 0.56, edge: 0.40, dust: 0.6, hiY: 0.2 }, 520), m.timber, 124, false);
    bat('skip', fin(K.skip(N), 'rusted_metal', { noise: N, grime: 0.50, edge: 0.36, dust: 0.6, hiY: 1.3 }, 420), m.rust, 14);

    // ---- ground cover --------------------------------------------------------
    // MEASURED THE HARD WAY: drift2 overflowed by 13 and the harness failed the
    // capture, which is exactly what the overflow report is for. The demand is
    // ~194 sand banks and it moves whenever a pass is added, because a shifted
    // RNG stream changes which placements the occupancy grid rejects. Both drift
    // caps now carry 50% headroom over measured demand.
    bat('drift', fin(K.sandDrift(N, 3.7), 'sand', { noise: N, grime: 0.18, edge: 0.05, dust: 0.2, hiY: 0.5 }, 260), m.sand, 340, false);
    bat('drift2', fin(K.sandDrift(N, 11.3), 'sand', { noise: N, grime: 0.20, edge: 0.05, dust: 0.2, hiY: 0.5 }, 260), m.sand, 300, false);
    bat('scrub', fin(K.scrub(N, R), 'dirt', { noise: N, grime: 0.30, edge: 0.10, dust: 0.4, hiY: 0.6 }, 420), m.scrub, 480, false);
    bat('weed', fin(K.tumbleweed(N, R), 'dirt', { noise: N, grime: 0.24, edge: 0.08, dust: 0.3, hiY: 0.5 }, 420), m.scrub, 52, false);
    bat('offcut', fin(K.offcut(N, R), 'rusted_metal', { noise: N, grime: 0.60, edge: 0.36, dust: 0.7, hiY: 0.2 }, 620), m.rust, 160, false);
    bat('plank', fin(K.plank(N, R), 'wood_plank', { noise: N, grime: 0.62, edge: 0.40, dust: 0.7, hiY: 0.1 }, 520), m.timber, 140, false);
    bat('rag', fin(K.rag(N, R), 'fabric', { noise: N, grime: 0.64, edge: 0.20, dust: 0.8, hiY: 0.1 }, 420), m.sackcloth, 116, false);
    bat('hat', fin(K.hardHat(), 'plastic', { noise: N, grime: 0.42, edge: 0.24, dust: 0.6, hiY: 0.2 }, 700), m.paintYellow, 18, false);
  };

  // Elevated placement: the rack walkway and the column catwalks are not
  // ground, so these bypass the ground solve entirely and take an explicit Y.
  PropsRefinery.prototype._placeAt = function (batch, x, y, z, yaw, opts) {
    if (!batch || !batch.add) return false;
    opts = opts || {};
    var tilt = opts.tilt === undefined ? 0.012 : opts.tilt;
    _vn.set(this.rng.gaussian(0, tilt), 1, this.rng.gaussian(0, tilt)).normalize();
    if (opts.lay) {
      var la3 = opts.layDir === undefined ? this.rng.range(0, M.TAU) : opts.layDir;
      var ca3 = Math.cos(opts.lay), sa3 = Math.sin(opts.lay);
      _vn.set(Math.cos(la3) * sa3, ca3, Math.sin(la3) * sa3).normalize();
    }
    var sc = opts.scale === undefined ? 1 : opts.scale;
    return batch.add(
      settleT(x, y, z, yaw === undefined ? this.rng.range(0, M.TAU) : yaw, _vn,
        sc * (opts.sx || 1), sc * (opts.sy || 1), sc * (opts.sz || 1)),
      opts.color || wearTint(this.rng, null, opts.grime));
  };

  // A ground mark, laid coplanar on the measured surface.
  PropsRefinery.prototype._mark = function (cell, x, z, w, h, yaw, opts) {
    opts = opts || {};
    if (!this._inSite(x, z, 0.2)) return false;
    var s = this._surface(x, z, Math.max(w, h) * 0.5);
    if (s.relief > (opts.maxRelief === undefined ? 0.35 : opts.maxRelief)) return false;
    var g = markQuad(cell, w, h, opts.flip);
    _vn.copy(s.n);
    this._static('marks', g, settleT(x, s.y + (opts.lift === undefined ? 0.012 : opts.lift), z,
      yaw === undefined ? this.rng.range(0, M.TAU) : yaw, _vn));
    return true;
  };

  // A placard on a vertical face.  `face` is the outward normal as a yaw.
  PropsRefinery.prototype._placard = function (cell, x, y, z, w, h, yaw) {
    var g = markQuad(cell, w, h);
    // markQuad lies in XZ facing +Y; stand it up and turn it to face `yaw`
    this._static('marks', g, Tn(x, y, z, Math.PI * 0.5, yaw, 0));
  };

  // ---- A SIGN THAT SAYS SOMETHING, AND IS NOT DEAD PLUMB -------------------
  // Every sign on the site goes through here, so a bare board can no longer be
  // put up by forgetting the second call: hero3 shipped a completely blank
  // untextured rectangle 2.24 m from the published eye because `_place` was
  // called without the `_placard` that every other site pairs with it.
  //
  // One in three is the bent variant, and every one of them takes 2-3 degrees
  // of yaw jitter and a real settle tilt. Signs are the most repeated
  // silhouette in the level and a row of identical plumb rectangles is the
  // single loudest "this was generated" tell a yard can have.
  PropsRefinery.prototype._signPost = function (x, z, yaw, cell, opts) {
    opts = opts || {};
    var R = this.rng;
    var bent = R.bool(opts.bentP === undefined ? 0.34 : opts.bentP);
    var yj = yaw + R.range(-0.052, 0.052);
    var y = this._place(bent ? this.B.signBent : this.B.sign, x, z,
      { r: opts.r === undefined ? 0.5 : opts.r, h: 1.6, yaw: yj,
        tilt: opts.tilt === undefined ? 0.040 : opts.tilt,
        maxRelief: opts.maxRelief, road: opts.road });
    if (y === null) return null;
    // the board's own local +X offset on the bent variant, resolved into world
    var ox = bent ? Math.cos(yj) * SIGN_BEND_DX : 0;
    var oz = bent ? -Math.sin(yj) * SIGN_BEND_DX : 0;
    this._placard(cell, x + ox + Math.sin(yj) * 0.065, y + 1.27,
      z + oz + Math.cos(yj) * 0.065, 0.66, 0.48, yj);
    return y;
  };

  // Wind helpers.  windDir is the direction the wind TRAVELS, so the windward
  // face of an obstacle is at -w and the deposition shadow is at +w.
  PropsRefinery.prototype._wx = function () { return this.windDir.x; };
  PropsRefinery.prototype._wz = function () { return this.windDir.y; };

  // ==========================================================================
  // DRESSING PASSES
  // ==========================================================================

  // ---- heavy plant, placed first so it gets the clear ground ---------------
  PropsRefinery.prototype._dressHeavy = function () {
    var A = this.A, R = this.rng, N = this.noise;

    // THE TANKER, parked on the west half of the carriageway 32 m up the road.
    // It is there for a reason that is both operational and compositional: a
    // 170 m straight with nothing on it has no scale reference at all, and a
    // 11 m vehicle at 32 m of depth is the one object in the frame whose size
    // a viewer knows without being told.  It is off the centreline, so the
    // road still runs to its vanishing point past the near side of it.
    var tk = K.tanker(N);
    this._placeRig(tk, -5.2, -6.0, Math.PI, { r: 5.0, maxRelief: 0.5 });
    this._mark(MARK.oil, -5.2, -1.2, 2.4, 1.8, 0.2, { lift: 0.011 });
    this._mark(MARK.scuff, -5.2, 6.5, 3.0, 5.0, 0, { lift: 0.010 });
    // chocks and a cone at the tail, which is what a driver actually does
    this._place(this.B.cone, -3.4, 1.2, { r: 0.34, h: 0.7, road: true, low: true, yaw: R.range(0, 6) });
    this._place(this.B.cone, -7.0, 0.4, { r: 0.34, h: 0.7, road: true, low: true, yaw: R.range(0, 6) });

    // THE FORK-LIFT, on the apron off the unit 200 plinth with its forks down
    // and a pallet still on them - i.e. mid-job, not parked in a bay.
    var fl = K.forklift(N);
    this._placeRig(fl, 18.6, 10.4, -0.85, { r: 2.6, maxRelief: 0.4 });
    this._place(this.B.pallet, 19.9, 9.2, { r: 0.9, h: 0.15, yaw: -0.85, tilt: 0.01 });
    this._mark(MARK.oil, 18.2, 11.2, 1.5, 1.2, 0.6, { lift: 0.011 });

    // A SECOND FORK-LIFT deep in the laydown yard, which is what makes that
    // yard read as in use rather than as a stack of geometry.
    var fl2 = K.forklift(N);
    this._placeRig(fl2, 47.0, -57.0, 2.35, { r: 2.6, maxRelief: 0.4 });

    // Site store and contractor's compound south-east, in the establishing
    // frame's near-right quarter where there was nothing at all.
    var cbox = K.container(N, true);
    this._placeRig(cbox, 41.0, 50.0, 0.06, { r: 4.2, maxRelief: 0.45 });
    var cbox2 = K.container(N, false);
    this._placeRig(cbox2, 41.4, 54.4, 0.10, { r: 4.2, maxRelief: 0.45 });
    this._place(this.B.skip, 47.5, 46.5, { r: 2.4, h: 1.3, yaw: 0.35, collider: [1.8, 0.65, 0.95] });
    this._place(this.B.skip, 33.0, 47.6, { r: 2.4, h: 1.3, yaw: -1.15, collider: [1.8, 0.65, 0.95] });
    this._compound(41.2, 47.2, 0.06);

    // The gatehouse approach: a store container and a skip inside the fence.
    // MOVED WEST. level_refinery now stands the guard hut at (-14.5, 72.5) - it
    // is the emissive content that carries the west wing of the establishing
    // frame - and a 6 m container at (-14, 70) was 0.9 m off its south wall.
    var cbox3 = K.container(N, false);
    this._placeRig(cbox3, -25.5, 67.5, 1.62, { r: 4.2, maxRelief: 0.45 });
    this._place(this.B.skip, -33.0, 63.5, { r: 2.4, h: 1.3, yaw: 1.4, collider: [1.8, 0.65, 0.95] });

    // Laydown-yard stores.
    var cbox4 = K.container(N, true);
    this._placeRig(cbox4, 57.0, -66.0, 1.52, { r: 4.2, maxRelief: 0.45 });
    var cbox5 = K.container(N, true);
    this._placeRig(cbox5, 57.2, -62.6, 1.55, { r: 4.2, maxRelief: 0.45 });
    this._place(this.B.skip, 40.0, -48.0, { r: 2.4, h: 1.3, yaw: 0.15, collider: [1.8, 0.65, 0.95] });

    // Scaffold: one tower against the second column's skirt (a real plant
    // always has one up somewhere) and one against the pump-house gable.
    var sc = K.scaffold(N, 2.6, 1.9, 5);
    this._placeRig(sc, 21.6, -22.0, 0.0, { r: 2.2, maxRelief: 0.45 });
    var sc2 = K.scaffold(N, 2.2, 1.6, 3);
    this._placeRig(sc2, -14.6, 41.6, 1.57, { r: 2.0, maxRelief: 0.45 });
    var lad = K.ladder(4.4);
    this._placeRig(lad, -16.9, 39.4, 1.40, { r: 0.8, maxRelief: 0.4, noCollide: true });
    this._placeRig(K.ladder(3.6), 23.4, -13.0, 3.05, { r: 0.8, maxRelief: 0.4, noCollide: true });
  };

  // A contractor's compound: pallets, drums and crates banked against the
  // container line, which is where a yard actually stacks them.
  PropsRefinery.prototype._compound = function (cx, cz, yaw) {
    var R = this.rng;
    var ux = Math.cos(yaw), uz = -Math.sin(yaw);
    var i, t;
    for (i = 0; i < 9; i++) {
      t = -3.4 + i * 0.86;
      var px = cx + ux * t - uz * 2.6, pz = cz + uz * t + ux * 2.6;
      var b = R.bool(0.5) ? this.B.drumBlue : (R.bool(0.6) ? this.B.drumRust : this.B.drumPale);
      this._place(b, px + R.range(-0.16, 0.16), pz + R.range(-0.16, 0.16),
        { r: 0.34, h: 0.9, yaw: R.range(0, 6), grime: 0.06 });
    }
    for (i = 0; i < 4; i++) {
      this._place(this.B.pallet, cx + ux * (-2.6 + i * 1.35) - uz * 4.1,
        cz + uz * (-2.6 + i * 1.35) + ux * 4.1,
        { r: 0.85, h: 0.16, yaw: yaw + R.range(-0.2, 0.2) });
    }
    for (i = 0; i < 3; i++) {
      this._place(this.B.crate, cx + ux * (1.2 + i * 1.5) - uz * 4.3,
        cz + uz * (1.2 + i * 1.5) + ux * 4.3,
        { r: 0.9, h: 0.9, yaw: yaw + R.range(-0.35, 0.35), collider: [0.62, 0.45, 0.52] });
    }
    this._place(this.B.cableDrum, cx - ux * 4.6 - uz * 3.4, cz - uz * 4.6 + ux * 3.4,
      { r: 1.0, h: 1.4, yaw: yaw + 0.4, collider: [0.5, 0.72, 0.78] });
    this._place(this.B.bottlePack, cx + ux * 4.4 - uz * 2.4, cz + uz * 4.4 + ux * 2.4,
      { r: 0.7, h: 1.5, yaw: yaw - 0.3, collider: [0.45, 0.78, 0.45] });
    this._place(this.B.toolbox, cx + ux * 3.2 - uz * 3.9, cz + uz * 3.2 + ux * 3.9,
      { r: 0.7, h: 0.9, yaw: yaw + 1.2 });
    this._mark(MARK.oil, cx - ux * 1.0 - uz * 3.2, cz - uz * 1.0 + ux * 3.2, 2.0, 1.6, yaw);
    this._mark(MARK.scuff, cx + ux * 5.5, cz + uz * 5.5, 3.4, 4.5, yaw);
  };

  // ---- the laydown yards ---------------------------------------------------
  // Pipe is stacked in courses on timber dunnage, each course offset half a
  // pipe into the valleys of the one below, with the ends squared off against
  // a datum line.  It is the single most recognisable thing in an industrial
  // yard and it is entirely about the STACK, not the pipe.
  PropsRefinery.prototype._pipeStack = function (cx, cz, yaw, courses, perCourse, fat) {
    var R = this.rng, i, c;
    var ux = Math.sin(yaw), uz = Math.cos(yaw);       // along the pipes
    var px = Math.cos(yaw), pz = -Math.sin(yaw);      // across the stack
    var pipeR = fat ? 0.30 : 0.16;
    var pitch = pipeR * 2.02;
    var s = this._surface(cx, cz, 2.4);
    if (s.relief > 0.34) { this._skipped++; return false; }
    var base = s.y;
    // three dunnage baulks under the stack, laid across it
    for (i = 0; i < 3; i++) {
      var dz = -2.0 + i * 2.0;
      this._placeAt(this.B.dunnage, cx + ux * dz, base, cz + uz * dz, yaw + Math.PI * 0.5,
        { tilt: 0.006, sx: Math.max(0.6, perCourse * pitch / 2.4) });
    }
    var y = base + 0.145 + pipeR;
    for (c = 0; c < courses; c++) {
      var n = Math.max(1, perCourse - c);
      var off = (c % 2) ? pitch * 0.5 : 0;
      for (i = 0; i < n; i++) {
        var t = (i - (n - 1) * 0.5) * pitch + off;
        var jx = R.range(-0.05, 0.05), jz = R.range(-0.05, 0.05);
        this._placeAt(fat ? this.B.pipeFat : this.B.pipe,
          cx + px * t + jx, y, cz + pz * t + jz, yaw,
          { tilt: 0.004, grime: 0.04 });
      }
      y += pitch * 0.87;
    }
    this._occupy(cx, cz, 3.2);
    this.colliders.push({
      type: 'box',
      center: new THREE.Vector3(cx, base + (y - base) * 0.5, cz),
      halfExtents: new THREE.Vector3(perCourse * pitch * 0.5 + 0.4, (y - base) * 0.5, 3.2),
      quaternion: new THREE.Quaternion().setFromEuler(_eu.set(0, yaw, 0, 'YXZ')),
      material: 'metal'
    });
    return true;
  };

  PropsRefinery.prototype._dressLaydown = function () {
    var R = this.rng;
    var i;
    // EAST YARD, between the flare pad and the heater.  Stacks are laid out on
    // one datum line with their ends squared, because that is how a yard is
    // set out and because a row of aligned ends is a strong receding edge.
    var rows = [
      { x: 40.0, z: -68.0, yaw: 0.02, c: 4, n: 7, fat: false },
      { x: 45.4, z: -68.4, yaw: 0.02, c: 3, n: 6, fat: true },
      { x: 40.2, z: -60.0, yaw: 0.02, c: 5, n: 8, fat: false },
      { x: 51.0, z: -66.0, yaw: 0.02, c: 3, n: 5, fat: false },
      { x: 62.0, z: -52.0, yaw: 1.05, c: 3, n: 6, fat: true },
      { x: 55.5, z: -44.0, yaw: 0.9, c: 4, n: 6, fat: false }
    ];
    for (i = 0; i < rows.length; i++) {
      this._pipeStack(rows[i].x, rows[i].z, rows[i].yaw, rows[i].c, rows[i].n, rows[i].fat);
    }
    // WEST YARD, off the tank farm's north-west corner
    this._pipeStack(-62.0, -76.0, 1.55, 4, 6, false);
    this._pipeStack(-62.4, -70.0, 1.55, 3, 5, true);
    this._pipeStack(-54.0, -78.5, 0.05, 3, 6, false);

    // fittings, flanges and offcuts at the ends of the stacks - a yard is
    // never just the big stuff
    for (i = 0; i < 26; i++) {
      var a = R.range(0, M.TAU), rr = 3.4 + Math.pow(R.next(), 0.6) * 9.0;
      var x = 46.0 + Math.cos(a) * rr, z = -58.0 + Math.sin(a) * rr * 0.8;
      this._place(this.B.offcut, x, z, { r: 0.42, h: 0.2, low: true, tilt: 0.05 });
    }
    for (i = 0; i < 12; i++) {
      this._place(this.B.crate, 52.0 + R.gaussian(0, 4.0), -50.0 + R.gaussian(0, 4.0),
        { r: 1.0, h: 0.9, collider: [0.62, 0.45, 0.52] });
    }
    for (i = 0; i < 8; i++) {
      this._place(this.B.cableDrum, 60.0 + R.gaussian(0, 3.5), -60.0 + R.gaussian(0, 3.2),
        { r: 1.05, h: 1.44, collider: [0.5, 0.72, 0.78] });
    }
    for (i = 0; i < 14; i++) {
      var b = R.bool(0.45) ? this.B.drumRust : (R.bool(0.5) ? this.B.drumBlue : this.B.drumPale);
      this._place(b, 36.0 + R.gaussian(0, 3.2), -46.0 + R.gaussian(0, 3.0),
        { r: 0.36, h: 0.9 });
    }
    for (i = 0; i < 6; i++) {
      this._place(this.B.pallet, 37.5 + R.gaussian(0, 3.0), -72.0 + R.gaussian(0, 2.4),
        { r: 0.85, h: 0.16 });
    }
    // the yard's own marks: a hardstanding stencil and the tracks in and out
    this._mark(MARK.unitno, 43.0, -74.0, 3.2, 2.0, 0.02);
    this._mark(MARK.scuff, 34.0, -62.0, 5.0, 8.0, 0.02);
    this._mark(MARK.scuff, 33.0, -50.0, 4.0, 7.0, 0.10);
    this._mark(MARK.oil, 47.2, -57.6, 2.6, 2.0, 0.4);
    this._mark(MARK.scuff, -50.0, -74.0, 5.0, 7.0, 1.55);
  };

  // ---- the pipe-rack colonnades --------------------------------------------
  // A pipe rack is a covered edge 120 m long, and everything a plant cannot
  // find a home for ends up under one.  Placement follows the BENTS: material
  // goes hard against a leg (where it is out of the way of a truck), sand
  // banks on the windward side of each leg, litter collects in the lee.
  PropsRefinery.prototype._dressRacks = function () {
    var A = this.A, R = this.rng;
    var racks = (A && A.racks) || [];
    var wx = this._wx(), wz = this._wz();
    for (var r = 0; r < racks.length; r++) {
      var rk = racks[r];
      var legL = rk.colX ? rk.colX[0] : rk.x - rk.halfW;
      var legR = rk.colX ? rk.colX[1] : rk.x + rk.halfW;
      var n = Math.max(2, Math.round((rk.z1 - rk.z0) / rk.pitch));
      for (var i = 0; i <= n; i++) {
        var z = rk.z0 + (rk.z1 - rk.z0) * (i / n);
        for (var side = 0; side < 2; side++) {
          var lx = side ? legR : legL;
          // the aisle face of the rack is the one people use
          var out = side ? 1 : -1;
          // sand drift banked on the windward side of the leg
          if (R.bool(0.55)) {
            this._place(this.B.drift, lx - wx * R.range(0.5, 0.95), z - wz * R.range(0.5, 0.95),
              { r: 0.5, h: 0.2, low: true, road: true, tilt: 0,
                yaw: Math.atan2(wx, wz), sx: R.range(1.0, 2.1), sy: R.range(0.4, 0.9),
                sz: R.range(0.8, 1.7), sink: 0.03, maxRelief: 0.5 });
          }
          // and the material that lives against it
          var roll = R.next();
          if (roll < 0.10) {
            this._drumCluster(lx + out * R.range(0.7, 1.3), z + R.range(-1.4, 1.4), R.int(2, 5));
          } else if (roll < 0.16) {
            this._place(this.B.pallet, lx + out * R.range(0.8, 1.4), z + R.range(-1.2, 1.2),
              { r: 0.85, h: 0.16, yaw: R.range(0, 6) });
          } else if (roll < 0.20) {
            this._place(this.B.bottlePack, lx + out * R.range(0.9, 1.3), z + R.range(-1.0, 1.0),
              { r: 0.7, h: 1.5, collider: [0.45, 0.78, 0.45] });
          } else if (roll < 0.245) {
            this._place(this.B.crate, lx + out * R.range(0.9, 1.5), z + R.range(-1.0, 1.0),
              { r: 0.95, h: 0.9, collider: [0.62, 0.45, 0.52] });
          } else if (roll < 0.29) {
            this._place(this.B.cone, lx + out * R.range(0.6, 1.1), z + R.range(-1.6, 1.6),
              { r: 0.32, h: 0.7, low: true });
          } else if (roll < 0.325) {
            this._place(this.B.coil, lx + out * R.range(0.7, 1.2), z + R.range(-1.0, 1.0),
              { r: 0.55, h: 0.2, low: true });
          }
          // junction boxes and conduit live ON the legs
          if (R.bool(0.22)) {
            this._placeAt(this.B.jbox, lx + out * 0.22, this._ground(lx, z) + R.range(0.9, 1.7), z,
              side ? Math.PI * 0.5 : -Math.PI * 0.5, { tilt: 0.004 });
          }
        }
        // hazard bollards protecting the legs that face the road
        if (i % 3 === 0 && Math.abs(legR) < 24) {
          this._place(this.B.bollard, legR + 1.15, z + R.range(-0.3, 0.3),
            { r: 0.4, h: 1.0, tilt: 0.03, collider: [0.14, 0.5, 0.14] });
        }
      }
    }
  };

  // Drums are stacked in a group, touching, because one man rolled them there.
  PropsRefinery.prototype._drumCluster = function (cx, cz, n, upright) {
    var R = this.rng;
    var placed = 0;
    for (var i = 0; i < n; i++) {
      var a = (i / Math.max(1, n)) * M.TAU + R.range(-0.4, 0.4);
      var rr = i === 0 ? 0 : 0.60 + R.range(-0.05, 0.12);
      var x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
      var b = R.next();
      var batch = b < 0.38 ? this.B.drumRust : (b < 0.72 ? this.B.drumBlue : this.B.drumPale);
      if (upright === false && R.bool(0.4)) {
        // one on its side, which is what a stack that has been raided looks like
        if (this._placeSideDrum(x, z, R.range(0, M.TAU))) placed++;
      } else if (this._place(batch, x, z,
        { r: 0.34, h: 0.9, yaw: R.range(0, M.TAU), collider: [0.30, 0.44, 0.30] }) !== null) placed++;
    }
    return placed;
  };

  PropsRefinery.prototype._placeSideDrum = function (x, z, yaw) {
    var s = this._surface(x, z, 0.45);
    if (s.relief > 0.24) { this._skipped++; return false; }
    if (this._occupied(x, z, 0.5)) { this._skipped++; return false; }
    if (this._blocked(x, s.y + 0.3, z, 0.42)) { this._skipped++; return false; }
    _vn.copy(s.n);
    var ok = this.B.drumSide.add(
      _m4.compose(_vp.set(x, s.y + 0.295, z),
        _qs.setFromUnitVectors(UP, _vn).multiply(
          _qt.setFromEuler(_eu.set(0, yaw, Math.PI * 0.5, 'YXZ'))),
        _vs.set(1, 1, 1)),
      wearTint(this.rng, null, 0.10));
    if (ok) this._occupy(x, z, 0.5);
    return ok;
  };

  // ---- the main road -------------------------------------------------------
  // ==========================================================================
  // THE CARRIAGEWAY.  The near foreground of the signature frame.
  //
  // MEASURED FAILURE: the lower 250 px of lv_hero1 - 35% of the image - was
  // bare apron with nothing nearer than about 18 m, and it was not a lighting
  // problem (that region measures 0.239 mean at 0.08 std, so anything standing
  // there would read).  It was structural.  _dressRoad confines every kerbside
  // placement to the 3 m strip outside the kerb, and _place refuses the
  // carriageway outright unless `road:true` - so the crown of the road, which
  // IS the bottom third of the level's hero pose, was swept clean by
  // construction.  A hero frame always carries a near anchor to set scale.
  //
  // Everything here is a real reason for a road to be occupied - a lifted
  // plate over a cable pull, its cordon, the gully line across the crown, a
  // hose run out from the hydrant, drifted sand against the windward kerb -
  // and everything except the cordon itself is kept under 0.4 m so the road's
  // leading line runs through it rather than into it.
  // ==========================================================================
  PropsRefinery.prototype._dressCarriageway = function () {
    var R = this.rng;
    var rx0 = this.road.x0, rx1 = this.road.x1;
    var i;

    // ---- 1. the steel road plate over a cable trench ------------------------
    // 8 m ahead of the hero mark and just right of the crown, so it sits on the
    // third line rather than blocking the vanishing point.
    var plx = 1.9, plz = 18.6, pyaw = 0.14;
    var ply = this._ground(plx, plz);
    var PW = 2.55, PD = 3.10;
    // the trench itself, showing at the plate's uphill edge
    this._static('rust', box(PW + 0.5, 0.30, 0.55, 0.01),
      Tn(plx - Math.sin(pyaw) * 0, ply - 0.15, plz - PD * 0.5 - 0.30, 0, pyaw, 0));
    // the plate: a chequer sheet with a chamfered lip all round and two lifting
    // eyes, sitting 35 mm proud, which is what you trip over on a real site
    this._static('grate', box(PW, 0.035, PD, 0.006), Tn(plx, ply + 0.035, plz, 0, pyaw, 0));
    this._static('steel', box(PW + 0.22, 0.018, PD + 0.22, 0.004),
      Tn(plx, ply + 0.012, plz, 0, pyaw, 0));
    for (i = 0; i < 2; i++) {
      this._static('steel', tor(0.075, 0.014, 5, 10),
        Tn(plx + (i ? 0.85 : -0.85), ply + 0.055, plz + PD * 0.32, Math.PI * 0.5, pyaw, 0));
    }
    // spoil and a shovel-scraped ramp of sand banked on the downhill lip
    this._place(this.B.drift, plx - 1.7, plz + 1.5,
      { r: 0.5, h: 0.2, low: true, road: true, tilt: 0, yaw: pyaw,
        sx: 1.7, sy: 0.32, sz: 0.9, sink: 0.03, maxRelief: 0.5 });
    this._place(this.B.drift, plx + 1.6, plz - 1.2,
      { r: 0.5, h: 0.2, low: true, road: true, tilt: 0, yaw: pyaw + 0.4,
        sx: 1.4, sy: 0.28, sz: 0.8, sink: 0.03, maxRelief: 0.5 });
    this._mark(MARK.oil, plx + 0.6, plz + 2.3, 2.0, 2.4, 0.3, { maxRelief: 0.5 });
    this._mark(MARK.scuff, plx - 0.4, plz - 2.4, 3.0, 3.6, 0.1, { maxRelief: 0.5 });

    // ---- 2. the cordon ------------------------------------------------------
    // Seven cones on a jittered ellipse, one of them flat on its side where a
    // wheel has clipped it, and the tape strung between the standing ones.
    this._coneRing(plx, plz, 2.5, 3.0, 7, { road: true, lay: 2 });
    this._tapeRing(plx, plz, 2.6, 3.1, 0.88);
    this._placeAt(this.B.hat, plx - 1.6, this._ground(plx - 1.6, plz + 2.9) + 0.02, plz + 2.9,
      R.range(0, 6), { tilt: 0.06 });

    // ---- 3. the gully line across the crown ---------------------------------
    // A transverse channel at the low point of the crossfall, 11 m ahead. Three
    // hard, small-scale, strongly-lit objects laid straight across the leading
    // line: the cheapest depth cue a receding road has.
    var gz = 15.2;
    for (i = 0; i < 5; i++) {
      var gxx = rx0 + 1.3 + i * ((rx1 - rx0 - 2.6) / 4) + R.range(-0.22, 0.22);
      var gyy = this._ground(gxx, gz);
      this._placeAt(this.B.gully, gxx, gyy + 0.010, gz + R.range(-0.18, 0.18),
        Math.PI * 0.5, { tilt: 0.008 });
    }
    this._static('steel', box(rx1 - rx0 - 1.6, 0.055, 0.10, 0.008),
      Tn((rx0 + rx1) * 0.5, this._ground(0, gz) + 0.025, gz - 0.52, 0, 0, 0));

    // ---- 4. the hose run ----------------------------------------------------
    // Charged 65 mm line run out from the hydrant on the east verge and left
    // lying across the carriageway. A hose is the one prop that draws a long,
    // soft, non-orthogonal CURVE in a level made entirely of straight lines.
    var hose = [
      [8.4, 23.4], [7.2, 22.1], [5.6, 21.4], [3.9, 21.3], [2.4, 20.6],
      [1.1, 19.4], [0.2, 17.9], [-0.4, 16.3], [-0.2, 14.6], [0.9, 13.4]
    ];
    for (i = 0; i + 1 < hose.length; i++) {
      var ax = hose[i][0], az = hose[i][1], bx = hose[i + 1][0], bz = hose[i + 1][1];
      var ay = this._ground(ax, az) + 0.048, by = this._ground(bx, bz) + 0.048;
      // three sub-segments per span so the run bends instead of faceting
      for (var s = 0; s < 3; s++) {
        var t0 = s / 3, t1 = (s + 1) / 3;
        this._static('rubber', cyl(0.042, 0.042, 1, 7),
          strutT(M.lerp(ax, bx, t0), M.lerp(ay, by, t0) + Math.sin(t0 * 3.1) * 0.006,
                 M.lerp(az, bz, t0),
                 M.lerp(ax, bx, t1), M.lerp(ay, by, t1) + Math.sin(t1 * 3.1) * 0.006,
                 M.lerp(az, bz, t1)));
      }
      // a coupling every other span
      if (i % 2 === 1) {
        this._static('steel', cyl(0.058, 0.058, 0.13, 8),
          strutT(ax, ay, az, ax + (bx - ax) * 0.1, ay, az + (bz - az) * 0.1));
      }
    }
    // the branch on the working end, and the hydrant it came from
    this._static('paintB', cyl(0.055, 0.038, 0.36, 9),
      strutT(0.9, this._ground(0.9, 13.4) + 0.05, 13.4, 1.35, this._ground(0.9, 13.4) + 0.10, 12.7));
    var hyy = this._ground(8.9, 23.8);
    this._static('paintB', cyl(0.10, 0.12, 0.86, 10), Tn(8.9, hyy + 0.43, 23.8));
    this._static('paintB', sph(0.11, 10, 6), Tn(8.9, hyy + 0.88, 23.8));
    this._static('steel', cyl(0.055, 0.055, 0.22, 8),
      Tn(8.78, hyy + 0.62, 23.8, 0, 0, Math.PI * 0.5));

    // ---- 5. the sand against the windward kerb ------------------------------
    // The wind runs 0.72/0.69, so it drops its load on the west kerb line and
    // nowhere else. This is the one thing in the near field that is not man-made
    // and it is what stops the foreground reading as a tidy set of objects.
    for (i = 0; i < 9; i++) {
      var sz2 = 12.5 + i * 1.55 + R.range(-0.4, 0.4);
      this._place(this.B.drift, rx0 + R.range(0.25, 1.05), sz2,
        { r: 0.55, h: 0.2, low: true, road: true, tilt: 0,
          yaw: Math.atan2(this._wx(), this._wz()) + R.range(-0.35, 0.35),
          sx: R.range(1.3, 2.6), sy: R.range(0.25, 0.55), sz: R.range(0.9, 1.9),
          sink: 0.04, maxRelief: 0.6 });
    }
    for (i = 0; i < 3; i++) {
      this._mark(MARK.sand, rx0 + R.range(0.6, 2.0), 13.0 + i * 4.4, 2.6, 3.4,
        R.range(0, 3), { maxRelief: 0.6, lift: 0.010 });
    }

    // ---- 6. the chained-off bollard pair ------------------------------------
    // Standing on the west verge line, closing the old access. Two posts and a
    // catenary is the only near-field object here with real height, and it is
    // deliberately at the frame edge so it frames rather than blocks.
    var b0 = [rx0 + 0.9, 23.9], b1 = [rx0 + 2.9, 24.4];
    var by0 = this._place(this.B.bollard, b0[0], b0[1],
      { r: 0.4, h: 1.0, road: true, tilt: 0.04, collider: [0.14, 0.5, 0.14] });
    var by1 = this._place(this.B.bollard, b1[0], b1[1],
      { r: 0.4, h: 1.0, road: true, tilt: 0.03, collider: [0.14, 0.5, 0.14] });
    if (by0 !== null && by1 !== null) {
      var links = 9;
      for (i = 0; i < links; i++) {
        var u0 = i / links, u1 = (i + 1) / links;
        var sag = 0.30;
        this._static('rust', cyl(0.020, 0.020, 1, 5),
          strutT(M.lerp(b0[0], b1[0], u0), by0 + 0.78 - sag * 4 * u0 * (1 - u0),
                 M.lerp(b0[1], b1[1], u0),
                 M.lerp(b0[0], b1[0], u1), by1 + 0.78 - sag * 4 * u1 * (1 - u1),
                 M.lerp(b0[1], b1[1], u1)));
      }
    }

    // ---- 7. the wear the traffic leaves ------------------------------------
    this._mark(MARK.scuff, -2.2, 21.0, 4.4, 6.0, 0.05, { maxRelief: 0.5 });
    this._mark(MARK.grime, 2.6, 13.6, 3.6, 4.4, 0.0, { maxRelief: 0.5 });
    this._mark(MARK.drip, -3.4, 17.2, 1.8, 2.4, 0.6, { maxRelief: 0.5 });
    this._placeAt(this.B.offcut, -4.2, this._ground(-4.2, 19.6) + 0.02, 19.6, 1.1, { tilt: 0.05 });
    this._placeAt(this.B.rag, 3.4, this._ground(3.4, 15.8) + 0.02, 15.8, 0.4, { tilt: 0.03 });
  };

  // A ring of cones with the spacing jittered +/-35% and one or two laid over.
  // Seven cones at identical spacing, all perfectly upright, is a metronome.
  PropsRefinery.prototype._coneRing = function (cx, cz, rx, rz, n, opts) {
    var R = this.rng;
    opts = opts || {};
    var flat = opts.lay === undefined ? -1 : opts.lay;
    var a = R.range(0, M.TAU);
    for (var i = 0; i < n; i++) {
      // walk round in jittered steps rather than dividing the circle evenly
      a += (M.TAU / n) * R.range(0.65, 1.35);
      var px = cx + Math.cos(a) * rx * R.range(0.90, 1.10);
      var pz = cz + Math.sin(a) * rz * R.range(0.90, 1.10);
      var o = { r: 0.30, h: 0.7, low: true, road: !!opts.road,
                yaw: R.range(0, M.TAU), tilt: 0.055 };
      if (i === flat) { o.lay = R.range(1.15, 1.45); o.sink = 0.06; o.tilt = 0; }
      else if (R.bool(0.22)) { o.lay = R.range(0.16, 0.34); o.tilt = 0; }
      this._place(this.B.cone, px, pz, o);
    }
  };

  PropsRefinery.prototype._dressRoad = function () {
    var A = this.A, R = this.rng;
    var rx0 = this.road.x0, rx1 = this.road.x1;
    var z0 = this.pave.z0 + 4, z1 = this.pave.z1 - 6;
    var i, z, side;

    // KERBSIDE MATERIAL, alternating sides down the length so the eye is led
    // by a rhythm instead of a wall.  Kept in the 3 m strip between the kerb
    // and the rack leg line, which is exactly where a plant dumps things.
    for (z = z0; z < z1; z += 6.6) {
      side = (Math.floor((z - z0) / 6.6) % 2) ? 1 : -1;
      var kx = (side > 0 ? rx1 : rx0) + side * R.range(1.0, 2.0);
      var kz = z + R.range(-2.5, 2.5);
      var roll = R.next();
      if (roll < 0.30) this._drumCluster(kx, kz, R.int(2, 4), false);
      else if (roll < 0.44) this._place(this.B.pallet, kx, kz, { r: 0.85, h: 0.16 });
      else if (roll < 0.54) this._place(this.B.ibc, kx, kz, { r: 0.9, h: 1.2, collider: [0.55, 0.6, 0.62] });
      else if (roll < 0.64) this._place(this.B.crate, kx, kz, { r: 0.95, h: 0.9, collider: [0.62, 0.45, 0.52] });
      else if (roll < 0.72) this._place(this.B.coil, kx, kz, { r: 0.55, h: 0.2, low: true });
      else if (roll < 0.80) this._place(this.B.cableDrum, kx, kz, { r: 1.0, h: 1.44, collider: [0.5, 0.72, 0.78] });
      else if (roll < 0.90) this._place(this.B.cone, kx, kz, { r: 0.32, h: 0.7, low: true });
    }

    // GULLIES in the level's own drainage channels, which run at 0.62 m
    // outside each kerb.  Placed by _placeAt against the measured channel
    // invert rather than through _place, because _place would (correctly)
    // refuse them for standing in the carriageway.
    var chX = [rx0 - 0.62, rx1 + 0.62];
    for (i = 0; i < chX.length; i++) {
      for (z = this.pave.z0 + 6; z < this.pave.z1 - 4; z += 12.0) {
        var gz = z + (i ? 6.0 : 0) + R.range(-0.5, 0.5);
        var gyv = this._ground(chX[i], gz);
        this._placeAt(this.B.gully, chX[i], gyv + 0.012, gz, 0, { tilt: 0.006 });
        if (R.bool(0.30)) {
          this._mark(MARK.sand, chX[i] + (i ? 0.7 : -0.7), gz, 1.6, 2.4, 0,
            { lift: 0.010, maxRelief: 0.45 });
        }
      }
    }

    // SIGNS at the plant's decision points, facing the traffic.
    var signs = [
      [rx1 + 1.5, 24.0, Math.PI], [rx0 - 1.5, -12.0, 0.0], [rx1 + 1.5, -40.0, Math.PI],
      [rx0 - 1.5, -66.0, 0.0], [rx1 + 1.6, 6.5, Math.PI], [rx0 - 1.6, 40.0, 0.0],
      [rx1 + 1.6, -78.0, Math.PI], [rx0 - 1.6, -52.0, 0.0]
    ];
    for (i = 0; i < signs.length; i++) {
      this._signPost(signs[i][0], signs[i][1], signs[i][2],
        R.bool(0.4) ? MARK.nosmoke : (R.bool(0.5) ? MARK.danger : MARK.ppe));
    }

    // THE WORKS AREA.  A lifted floor plate on the east verge at z = -30, coned
    // and taped, with the plate itself leaning against the barrier and the
    // tools still out.  Every real plant has exactly one of these.
    var wxc = rx1 + 2.6, wzc = -30.0;
    this._coneRing(wxc, wzc, 2.3, 2.9, 7, { road: true, lay: 4 });
    this._place(this.B.toolbox, wxc + 1.1, wzc - 1.6, { r: 0.7, h: 0.9, yaw: 0.7 });
    this._place(this.B.coil, wxc - 1.2, wzc + 1.4, { r: 0.55, h: 0.2, low: true });
    this._place(this.B.bottlePack, wxc + 1.9, wzc + 2.2, { r: 0.7, h: 1.5, collider: [0.45, 0.78, 0.45] });
    this._place(this.B.hat, wxc - 0.4, wzc - 2.2, { r: 0.25, h: 0.2, low: true, road: true });
    this._mark(MARK.oil, wxc, wzc, 2.2, 2.6, 0.1);
    this._mark(MARK.cross, wxc - 1.6, wzc + 3.4, 1.1, 1.1, 0.4);
    this._tapeRing(wxc, wzc, 2.9, 3.4, 0.95);

    // BARRIERS at the cross-road corners and at the unit entrances: a line of
    // jersey barrier is how a plant separates a road from a live unit.
    var xr = (A && A.road && A.road.cross) ? A.road.cross : { z0: 13, z1: 22 };
    this._barrierRun(rx1 + 1.2, xr.z1 + 1.6, rx1 + 1.2, xr.z1 + 12.0, 0.0);
    this._barrierRun(rx0 - 1.2, xr.z0 - 1.6, rx0 - 1.2, xr.z0 - 11.0, 0.0);
    this._barrierRun(19.6, 8.4, 30.0, 8.4, Math.PI * 0.5);
    this._barrierRun(-19.0, 28.5, -9.5, 28.5, Math.PI * 0.5);

    // Bollards guarding the manifolds where they meet the road.
    var mans = (A && A.manifolds) || [];
    for (i = 0; i < mans.length; i++) {
      var mp = mans[i].position;
      if (!mp) continue;
      for (var b = 0; b < 4; b++) {
        var bx = mp.x - (mans[i].side || 1) * 2.6;
        var bz = mp.z - 3.0 + b * 2.0;
        this._place(this.B.bollard, bx, bz, { r: 0.42, h: 1.0, tilt: 0.03,
          collider: [0.14, 0.5, 0.14] });
      }
      // and the housekeeping that lives at a manifold
      this._place(this.B.valve, mp.x + (mans[i].side || 1) * 1.6, mp.z + 3.6,
        { r: 0.6, h: 1.8, collider: [0.3, 0.9, 0.3] });
      this._place(this.B.ext, mp.x + (mans[i].side || 1) * 1.2, mp.z - 3.8,
        { r: 0.8, h: 1.5, yaw: (mans[i].side || 1) > 0 ? -Math.PI * 0.5 : Math.PI * 0.5 });
      this._mark(MARK.drip, mp.x, mp.z + 1.0, 1.6, 2.4, R.range(0, 3));
    }

    this._junction();
  };

  // The main-road / cross-road intersection.  Every junction on a working site
  // carries the same four things at each quadrant - guard bollards, a sign
  // facing the traffic, a chevron on the deck and the wedge of sand that
  // collects in the corner where nothing sweeps - and because the intersection
  // is a published anchor rather than a camera mark, dressing it lands in the
  // near third of every framing that looks along the spine.
  PropsRefinery.prototype._junction = function () {
    var A = this.A, R = this.rng;
    var xr = (A && A.road && A.road.cross) ? A.road.cross : { z0: 13, z1: 22 };
    var rx0 = this.road.x0, rx1 = this.road.x1;
    var wx = this._wx(), wz = this._wz();
    var quads = [
      [rx1 + 1.5, xr.z1 + 1.7, 1, 1], [rx1 + 1.5, xr.z0 - 1.7, 1, -1],
      [rx0 - 1.5, xr.z1 + 1.7, -1, 1], [rx0 - 1.5, xr.z0 - 1.7, -1, -1]
    ];
    for (var q = 0; q < quads.length; q++) {
      var cx = quads[q][0], cz = quads[q][1], sx = quads[q][2], sz = quads[q][3];
      // three guard bollards wrapping the corner
      for (var b = 0; b < 3; b++) {
        var a = (b / 2) * Math.PI * 0.5;
        this._place(this.B.bollard, cx + sx * Math.cos(a) * 1.7, cz + sz * Math.sin(a) * 1.7,
          { r: 0.34, h: 1.0, tilt: 0.025, collider: [0.14, 0.5, 0.14] });
      }
      // the sign, turned to face the traffic coming up the spine
      var yaw = sz > 0 ? 0 : Math.PI;
      this._signPost(cx + sx * 2.6, cz + sz * 2.4, yaw,
        q % 2 ? MARK.nosmoke : MARK.ppe);
      // a barrier stub keeping traffic off the corner radius
      this._place(this.B.barrier, cx + sx * 4.4, cz + sz * 3.0,
        { r: 1.15, h: 0.85, yaw: 0.7 * sx * sz, tilt: 0.012, maxRelief: 0.30,
          collider: [0.32, 0.42, 1.18] });
      // and the corner's own housekeeping
      if (q % 2 === 0) this._drumCluster(cx + sx * 3.0, cz + sz * 5.4, 3, false);
      else this._place(this.B.crate, cx + sx * 3.2, cz + sz * 5.0,
        { r: 0.95, h: 0.9, collider: [0.62, 0.45, 0.52] });
      this._mark(MARK.arrow, cx + sx * 1.0, cz + sz * 4.2, 2.0, 1.3,
        sz > 0 ? Math.PI * 0.5 : -Math.PI * 0.5, { maxRelief: 0.4 });
      // sand in the corner: the wind drops its load where the flow separates
      for (var d = 0; d < 5; d++) {
        this._place(this.B.drift, cx + sx * R.range(0.6, 3.4), cz + sz * R.range(0.6, 3.4),
          { r: 0.5, h: 0.2, low: true, road: true, tilt: 0,
            yaw: Math.atan2(wx, wz) + R.range(-0.4, 0.4),
            sx: R.range(1.1, 2.3), sy: R.range(0.3, 0.7), sz: R.range(0.8, 1.6),
            sink: 0.035, maxRelief: 0.5 });
      }
    }
    // cone taper narrowing the carriageway on the north approach, which is the
    // one piece of dressing that is allowed to stand ON the road
    // Spacing jittered +/-35% and two of the twelve knocked flat. Cones set out
    // by a person are never at identical centres and never all still standing.
    var ct = 0, cs = 0;
    for (var c = 0; c < 6; c++) {
      ct += R.range(0.65, 1.35);
      cs += R.range(0.65, 1.35);
      this._place(this.B.cone, -6.4 + ct * 0.28 + R.range(-0.12, 0.12), 11.0 - ct * 1.6,
        { r: 0.28, h: 0.7, low: true, road: true, yaw: R.range(0, 6),
          tilt: 0.05, lay: (c === 4) ? 1.32 : 0, sink: (c === 4) ? 0.06 : 0 });
      this._place(this.B.cone, 6.4 - cs * 0.28 + R.range(-0.12, 0.12), 24.0 + cs * 1.6,
        { r: 0.28, h: 0.7, low: true, road: true, yaw: R.range(0, 6),
          tilt: 0.05, lay: (c === 1) ? R.range(0.20, 0.38) : 0 });
    }
  };

  // MEASURED: the runs read as ONE CONTINUOUS EXTRUSION with a repeating notch
  // along the top - "a zipper, not discrete 3 m units". A jersey barrier run is
  // a line of separately cast, separately dropped 2.3 m units: there is a
  // finger's gap at every joint, no two sit at quite the same heading, one in
  // five has been nudged out of line by a fork truck, and the ends of a run
  // never land on the theoretical centres. All of that is per-instance jitter
  // and it costs nothing.
  PropsRefinery.prototype._barrierRun = function (ax, az, bx, bz, yaw) {
    var dx = bx - ax, dz = bz - az;
    var len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.5) return;
    var ux = dx / len, uz = dz / len;
    var px2 = -uz, pz2 = ux;                    // lateral, for the nudges
    var R = this.rng;
    // start the run at a random offset so two runs never share a joint rhythm
    var s = R.range(0.05, 0.55);
    var guard = 0;
    while (s + 2.30 <= len + 0.4 && guard++ < 60) {
      var mid = s + 1.15;
      var lat = R.bool(0.20) ? R.range(-0.16, 0.16) : R.range(-0.035, 0.035);
      var x = ax + ux * mid + px2 * lat;
      var z = az + uz * mid + pz2 * lat;
      this._place(this.B.barrier, x, z,
        { r: 1.10, h: 0.85, yaw: yaw + R.range(-0.052, 0.052), tilt: 0.016,
          // a cast unit is not a machined one: 4% of length and 5% of height
          sx: R.range(0.985, 1.015), sy: R.range(0.955, 1.045),
          sz: R.range(0.97, 1.02),
          maxRelief: 0.34, collider: [0.32, 0.42, 1.18] });
      // 20-45 mm of daylight at every joint, which is what makes the top line
      // read as units rather than as one moulding
      s += 2.30 + R.range(0.020, 0.048);
    }
  };

  // ---- unit 200: the column row --------------------------------------------
  // Everything here is process housekeeping and it is placed AT the process:
  // safety kit at the head of a stair, a wash station within the regulation
  // reach of the sample point, drums where the drain valve is, bollards
  // between the road and anything that can be hit.
  PropsRefinery.prototype._dressUnit200 = function () {
    var A = this.A, R = this.rng;
    var cols = (A && A.columns) || [];
    var i, c;
    for (i = 0; i < cols.length; i++) {
      c = cols[i];
      var skirt = c.r + 0.9;
      var face = i % 2 ? -1 : 1;
      // valve stand and a sample point on the aisle face of each skirt
      this._place(this.B.valve, c.x - skirt * 0.95, c.z + face * skirt * 0.6,
        { r: 0.62, h: 1.8, yaw: R.range(0, 6), collider: [0.3, 0.9, 0.3] });
      // the drums that live under a drain valve, and the tray they stand in
      this._drumCluster(c.x - skirt - 0.7, c.z - face * (skirt * 0.4 + 0.6), R.int(2, 4), false);
      this._mark(MARK.oil, c.x - skirt - 0.7, c.z - face * (skirt * 0.4 + 0.6), 2.4, 2.0, R.range(0, 3));
      // an extinguisher pair at every second column, a shower at the first
      if (i % 2 === 0) {
        this._place(this.B.ext, c.x - skirt * 1.25, c.z + face * 2.6,
          { r: 0.8, h: 1.5, yaw: -Math.PI * 0.5 });
      }
      if (i === 0 || i === 2) {
        this._place(this.B.shower, c.x - skirt * 1.4, c.z - face * 3.2,
          { r: 0.7, h: 2.3, yaw: -Math.PI * 0.5, collider: [0.22, 1.15, 0.22] });
      }
      // gas bottles lashed at the base for the maintenance that never ends
      if (R.bool(0.6)) {
        for (var b = 0; b < R.int(2, 4); b++) {
          this._place(this.B.bottle, c.x + skirt * 0.75 + R.range(-0.2, 0.2),
            c.z + face * (skirt * 0.8 + b * 0.30), { r: 0.20, h: 1.4, tilt: 0.02 });
        }
      }
      // stencilled unit number on the plinth in front of the column
      this._mark(MARK.unitno, c.x - skirt - 2.2, c.z, 1.8, 1.2, Math.PI * 0.5);
    }

    // hose reels and a monitor covering the unit, on the road side of the pad
    this._place(this.B.hose, 20.8, -34.0, { r: 0.7, h: 1.1, yaw: -Math.PI * 0.5 });
    this._place(this.B.hose, 20.8, -6.0, { r: 0.7, h: 1.1, yaw: -Math.PI * 0.5 });
    this._place(this.B.monitor, 20.4, -48.0, { r: 0.7, h: 1.8, yaw: -1.2,
      collider: [0.3, 0.9, 0.3] });
    this._place(this.B.monitor, 33.2, -18.0, { r: 0.7, h: 1.8, yaw: 1.9,
      collider: [0.3, 0.9, 0.3] });

    // BOLLARDS along the plinth kerb facing the road, at 3 m centres.  This is
    // the level's one long line of saturated warm chroma below eye level and
    // it does a great deal of work leading the eye up the right side of hero1.
    for (var z = -50.0; z <= 4.0; z += 3.0) {
      this._place(this.B.bollard, 19.4 + R.range(-0.12, 0.12), z,
        { r: 0.36, h: 1.0, tilt: 0.025, collider: [0.14, 0.5, 0.14] });
    }
    // cones round the plinth's south-west corner where a step catches people
    for (i = 0; i < 5; i++) {
      this._place(this.B.cone, 20.2 + i * 0.9, 6.6 + R.range(-0.2, 0.2),
        { r: 0.3, h: 0.7, low: true });
    }
    // laydown against the plinth's east flank
    for (i = 0; i < 5; i++) {
      this._place(this.B.pallet, 35.2 + R.gaussian(0, 0.7), -46.0 + i * 3.4 + R.gaussian(0, 0.8),
        { r: 0.85, h: 0.16 });
    }
    this._place(this.B.cableDrum, 35.6, -28.0, { r: 1.0, h: 1.44, yaw: 0.3,
      collider: [0.5, 0.72, 0.78] });
    this._place(this.B.toolbox, 35.4, -24.0, { r: 0.7, h: 0.9, yaw: 1.1 });

    // The heater's own corner: bottles, a barrow-load of refractory, drums.
    var ht = A && A.heater;
    if (ht) {
      this._drumCluster(ht.x0 - 2.2, ht.z0 - 2.4, 4, false);
      this._place(this.B.bottlePack, ht.x0 - 2.6, ht.z1 + 2.0, { r: 0.7, h: 1.5,
        collider: [0.45, 0.78, 0.45] });
      this._place(this.B.ext, ht.x0 - 1.8, ht.z0 + 4.0, { r: 0.8, h: 1.5, yaw: -Math.PI * 0.5 });
      this._place(this.B.shower, ht.x0 - 2.4, ht.z0 + 8.0, { r: 0.7, h: 2.3, yaw: -Math.PI * 0.5,
        collider: [0.22, 1.15, 0.22] });
      this._mark(MARK.unitno, ht.x0 - 4.0, (ht.z0 + ht.z1) * 0.5, 2.4, 1.6, Math.PI * 0.5);
    }
  };

  // ---- the tank farm -------------------------------------------------------
  PropsRefinery.prototype._dressTankFarm = function () {
    var A = this.A, R = this.rng;
    var tanks = (A && A.tanks) || [];
    var wx = this._wx(), wz = this._wz();
    for (var i = 0; i < tanks.length; i++) {
      var t = tanks[i];
      var c = t.centre, bd = t.bund;
      if (!c || !bd) continue;
      var sa = t.stairYaw || 0;
      // the foot of the spiral stair: this is where everything congregates
      var fx = c.x + Math.cos(sa) * (t.r + 1.6), fz = c.z + Math.sin(sa) * (t.r + 1.6);
      this._drumCluster(fx + Math.cos(sa + 1.2) * 1.6, fz + Math.sin(sa + 1.2) * 1.6, 3, false);
      this._place(this.B.valve, fx + Math.cos(sa - 1.1) * 2.0, fz + Math.sin(sa - 1.1) * 2.0,
        { r: 0.62, h: 1.8, collider: [0.3, 0.9, 0.3] });
      this._place(this.B.ext, fx + Math.cos(sa + 0.5) * 2.6, fz + Math.sin(sa + 0.5) * 2.6,
        { r: 0.8, h: 1.5, yaw: sa + Math.PI * 0.5 });
      this._mark(MARK.oil, fx, fz, 2.6, 2.2, sa);
      // the manway, with its blind flange leaning against the shell
      if (t.manwayPos) {
        this._place(this.B.cone, t.manwayPos.x + R.range(-0.6, 0.6),
          t.manwayPos.z + R.range(-0.6, 0.6), { r: 0.3, h: 0.7, low: true });
      }
      // valves on the shell outlets, inside the bund
      for (var v = 0; v < 3; v++) {
        var va = sa + Math.PI + (v - 1) * 0.55;
        this._place(this.B.valve, c.x + Math.cos(va) * (t.r + 1.9),
          c.z + Math.sin(va) * (t.r + 1.9), { r: 0.6, h: 1.8, collider: [0.3, 0.9, 0.3] });
      }
      // fire monitors covering the bund from OUTSIDE it, which is where they go
      this._place(this.B.monitor, bd.x1 + 2.6, (bd.z0 + bd.z1) * 0.5 + R.range(-4, 4),
        { r: 0.8, h: 1.8, yaw: -Math.PI * 0.5, collider: [0.3, 0.9, 0.3] });
      this._place(this.B.hose, bd.x1 + 2.4, bd.z0 + 5.0, { r: 0.7, h: 1.1, yaw: -Math.PI * 0.5 });
      // hazard placards and the tank number on the bund wall face
      this._placard(MARK.flam, bd.x1 + 0.16, this._ground(bd.x1 + 1, bd.z0 + 9) + 1.05,
        bd.z0 + 9.0, 0.9, 0.9, -Math.PI * 0.5);
      this._placard(MARK.danger, bd.x1 + 0.16, this._ground(bd.x1 + 1, bd.z1 - 7) + 1.05,
        bd.z1 - 7.0, 1.1, 0.8, -Math.PI * 0.5);
      // the drift that has been banking against the windward bund face since
      // the plant was commissioned
      for (var d = 0; d < 26; d++) {
        var tt = d / 25;
        var bx = wx > 0 ? bd.x0 : bd.x1;
        var px = bx - wx * R.range(0.4, 1.5);
        var pz = bd.z0 + (bd.z1 - bd.z0) * tt + R.range(-0.7, 0.7);
        this._place(this.B.drift2, px, pz,
          { r: 0.6, h: 0.2, low: true, road: true, tilt: 0, yaw: Math.atan2(wx, wz),
            sx: R.range(1.6, 3.4), sy: R.range(0.35, 0.85), sz: R.range(0.9, 2.0),
            sink: 0.04, maxRelief: 0.55 });
      }
      // AND ON THE LEE FACE.  A long wall makes a separation bubble downwind
      // and the flow drops its load inside it, so a bund banks on both sides -
      // the windward ramp is longer and shallower, the lee bank shorter and
      // steeper.  This is also the face the plant's own aisle runs down, so it
      // is the one an eye at ground level actually sees.
      for (var d2 = 0; d2 < 16; d2++) {
        var t2 = d2 / 15;
        var lx = (wx > 0 ? bd.x1 : bd.x0) + wx * R.range(0.25, 1.1);
        var lz = bd.z0 + (bd.z1 - bd.z0) * t2 + R.range(-0.8, 0.8);
        this._place(this.B.drift, lx, lz,
          { r: 0.5, h: 0.2, low: true, road: true, tilt: 0, yaw: Math.atan2(wx, wz),
            sx: R.range(1.0, 2.2), sy: R.range(0.3, 0.7), sz: R.range(0.7, 1.5),
            sink: 0.04, maxRelief: 0.55 });
      }
      // scrub in the lee corners of the bund, where nothing ever drives
      for (var s = 0; s < 14; s++) {
        this._place(this.B.scrub,
          bd.x0 + R.range(1.6, 4.5), bd.z0 + R.range(1.6, 5.0) + (s % 2 ? (bd.z1 - bd.z0 - 6.5) : 0),
          { r: 0.34, h: 0.5, low: true, road: true, tilt: 0.06,
            scale: R.range(0.55, 1.35), maxRelief: 0.5 });
      }
    }
    // the pump-out set between the two big bunds, on the apron
    this._place(this.B.ibc, -27.5, -20.0, { r: 0.9, h: 1.2, collider: [0.55, 0.6, 0.62] });
    this._place(this.B.ibc, -27.4, -18.6, { r: 0.9, h: 1.2, collider: [0.55, 0.6, 0.62] });
    this._drumCluster(-27.0, -14.5, 5, false);
    this._place(this.B.coil, -26.4, -11.8, { r: 0.55, h: 0.2, low: true });
    // MOVED, AND IT NOW SAYS SOMETHING. At (-27, -8) this stood 2.24 m from the
    // published hero3 eye and filled a large part of the lower centre with a
    // blank, untextured, off-white rectangle - a direct hit on the instant-fail
    // list, on the most prominent prop in a published framing, in a level whose
    // brief asks for "warning placards in an invented script". Two separate
    // faults: it was in the lens, and it carried no printing because `_place`
    // alone puts up a bare board - every other sign in the level gets a
    // `_placard` call after it and this one never did.
    //
    // At (-27, -13.5) it reads at 7.4 m as set dressing rather than as a
    // subject, it still marks the pump-out set it belongs to, and it carries a
    // FLAMMABLE diamond because that is what stands at the entrance to a crude
    // tank farm.
    this._signPost(-27.0, -13.5, Math.PI * 0.5, MARK.flam);

    // ---- THE BUND-WALL AISLE ------------------------------------------------
    // The 8 m strip between the west rack and the bund coping is the tank
    // farm's own access road, and at ground level it is the darkest surface in
    // the level - the floods are 9.5 m up and aimed at a tank shell 25 m away,
    // so almost nothing reaches the apron.  What is placed along it is
    // deliberately PALE: sand, white poly totes, a chalky bag pallet and a
    // pale-enamel drum stack read off the flare's 1.8 lux from overhead where
    // a dark steel prop would be a hole.  This is the same problem the harbor
    // hit; the answer is albedo, not another light.
    // Hard against the bund coping, where a plant stacks anything it does not
    // want a truck to clip.  This is the darkest square metre in the level -
    // the floods are 9.5 m up and aimed at a shell 25 m away, so the only light
    // reaching it is the flare's 1.8 lux from directly overhead - which is
    // exactly why the group is white poly, pale enamel and sand: albedo is the
    // only lever left once the lamp budget is spent.
    this._place(this.B.ibc, -29.2, 4.2, { r: 0.85, h: 1.2, yaw: 0.10,
      clearR: 0.45, collider: [0.55, 0.6, 0.62] });
    this._place(this.B.drumPale, -29.3, 2.5, { r: 0.34, h: 0.9, yaw: 0.7,
      clearR: 0.28, collider: [0.30, 0.44, 0.30] });
    this._place(this.B.drumPale, -28.7, 2.2, { r: 0.34, h: 0.9, yaw: 3.3,
      clearR: 0.28, collider: [0.30, 0.44, 0.30] });
    this._place(this.B.sacks, -29.1, 6.2, { r: 0.85, h: 0.7, yaw: 0.06,
      clearR: 0.45 });
    for (var tc = 0; tc < 7; tc++) {
      this._place(this.B.drift2, -29.7 + R.range(0, 0.6), 0.4 - tc * 1.5,
        { r: 0.6, h: 0.2, low: true, road: true, tilt: 0, yaw: Math.atan2(wx, wz),
          sx: R.range(2.2, 4.0), sy: R.range(0.5, 1.0), sz: R.range(1.1, 2.2),
          sink: 0.02, maxRelief: 0.7 });
    }
    this._place(this.B.ibc, -27.6, 1.4, { r: 0.9, h: 1.2, yaw: 0.35,
      collider: [0.55, 0.6, 0.62] });
    this._place(this.B.ibc, -28.5, 2.7, { r: 0.9, h: 1.2, yaw: 0.20,
      collider: [0.55, 0.6, 0.62] });
    this._place(this.B.sacks, -28.2, -2.6, { r: 0.9, h: 0.7, yaw: 0.5 });
    this._place(this.B.drumPale, -26.7, -0.6, { r: 0.34, h: 0.9, yaw: 1.1,
      collider: [0.30, 0.44, 0.30] });
    this._place(this.B.drumPale, -27.3, -1.2, { r: 0.34, h: 0.9, yaw: 2.6,
      collider: [0.30, 0.44, 0.30] });
    this._place(this.B.pallet, -26.6, 3.6, { r: 0.85, h: 0.16, yaw: 0.1 });
    this._place(this.B.cone, -25.9, 0.2, { r: 0.3, h: 0.7, low: true });
    // the toe of the bund, where the sand has been piling for nine years
    for (var tb = 0; tb < 9; tb++) {
      this._place(this.B.drift2, -29.6 + R.range(0, 0.9), -6.0 + tb * 1.9,
        { r: 0.65, h: 0.2, low: true, road: true, tilt: 0,
          yaw: Math.atan2(wx, wz), sx: R.range(2.0, 3.8), sy: R.range(0.45, 0.95),
          sz: R.range(1.0, 2.2), sink: 0.03, maxRelief: 0.6 });
    }
    var aisle = [
      [-26.9, 5.2], [-28.1, -30.0],
      [-27.2, -36.5], [-28.3, -44.0], [-26.8, -52.0], [-28.0, -58.5]
    ];
    for (var q = 0; q < aisle.length; q++) {
      var ax = aisle[q][0], az = aisle[q][1];
      var roll = R.next();
      if (roll < 0.30) {
        this._place(this.B.ibc, ax, az, { r: 0.9, h: 1.2, yaw: R.range(0, 6),
          collider: [0.55, 0.6, 0.62] });
        this._place(this.B.drumPale, ax + R.range(0.9, 1.4), az + R.range(-0.9, 0.9),
          { r: 0.34, h: 0.9, collider: [0.30, 0.44, 0.30] });
      } else if (roll < 0.58) {
        this._drumCluster(ax, az, 4, false);
      } else if (roll < 0.76) {
        this._place(this.B.sacks, ax, az, { r: 0.9, h: 0.7, yaw: R.range(0, 6) });
      } else {
        this._place(this.B.pallet, ax, az, { r: 0.85, h: 0.16 });
        this._place(this.B.cone, ax + R.range(-1.2, 1.2), az + R.range(-1.2, 1.2),
          { r: 0.3, h: 0.7, low: true });
      }
      // the sand that has crept out of the bund corner onto the aisle
      for (var sd = 0; sd < 3; sd++) {
        this._place(this.B.drift2, ax + R.range(-2.6, 1.2), az + R.range(-2.6, 2.6),
          { r: 0.6, h: 0.2, low: true, road: true, tilt: 0,
            yaw: Math.atan2(wx, wz) + R.range(-0.4, 0.4),
            sx: R.range(1.4, 3.0), sy: R.range(0.3, 0.8), sz: R.range(0.9, 1.9),
            sink: 0.04, maxRelief: 0.55 });
      }
    }
    this._place(this.B.monitor, -27.3, 4.6, { r: 0.8, h: 1.8, yaw: -1.9,
      collider: [0.3, 0.9, 0.3] });
    this._place(this.B.valve, -28.4, -8.6, { r: 0.6, h: 1.8, collider: [0.3, 0.9, 0.3] });
    this._mark(MARK.scuff, -26.5, -6.0, 2.6, 9.0, 0.06, { maxRelief: 0.5 });
    this._mark(MARK.scuff, -26.5, -32.0, 2.6, 9.0, 0.06, { maxRelief: 0.5 });
  };

  // ---- the flare pad -------------------------------------------------------
  PropsRefinery.prototype._dressFlarePad = function () {
    var A = this.A, R = this.rng;
    var f = A && A.flare;
    if (!f || !f.base) return;
    var bx = f.base.x, bz = f.base.z;
    // A flare base is a hard exclusion zone: it is coned, taped, placarded and
    // otherwise EMPTY, and that emptiness is exactly why the cordon reads.
    var ring = (f.derrickR || 9) + 3.4;
    for (var i = 0; i < 12; i++) {
      var a = (i / 12) * M.TAU + 0.13;
      this._place(this.B.cone, bx + Math.cos(a) * ring, bz + Math.sin(a) * ring,
        { r: 0.32, h: 0.7, low: true, road: true });
    }
    this._tapeRing(bx, bz, ring, ring, 0.92);
    for (var s = 0; s < 4; s++) {
      var sa = s * Math.PI * 0.5 + 0.4;
      this._signPost(bx + Math.cos(sa) * (ring + 1.6), bz + Math.sin(sa) * (ring + 1.6),
        sa + Math.PI, s % 2 ? MARK.nosmoke : MARK.danger);
    }
    // the knock-out drum's own housekeeping, off the cordon to the east
    this._drumCluster(bx + ring + 3.0, bz + 4.0, 4, false);
    this._place(this.B.valve, bx + ring + 2.0, bz - 2.0, { r: 0.6, h: 1.8,
      collider: [0.3, 0.9, 0.3] });
    this._place(this.B.monitor, bx - ring - 2.4, bz + 3.0, { r: 0.8, h: 1.8, yaw: 1.4,
      collider: [0.3, 0.9, 0.3] });
    this._place(this.B.ext, bx + ring + 1.2, bz - 6.0, { r: 0.8, h: 1.5, yaw: Math.PI });
    this._mark(MARK.unitno, bx - 6.0, bz + ring - 2.0, 2.6, 1.8, 0.0);
    this._mark(MARK.scuff, bx + ring + 6.0, bz, 3.0, 6.0, 0.0);
  };

  // ---- the pump house ------------------------------------------------------
  // The one interior.  Placement is by EXACT floor level, not by the ground
  // solve: the slab is a flat plane at floorY while the terrain under it still
  // carries the site's noise, and settling interior props onto the terrain
  // would sink them a few centimetres into a floor that does not follow it.
  PropsRefinery.prototype._dressPumpHouse = function () {
    var A = this.A, R = this.rng;
    var ph = A && A.pumpHouse;
    if (!ph) return;
    var fy = ph.floorY + 0.03;         // top of the slab, above the trench lids
    var x0 = ph.x0, x1 = ph.x1, z0 = ph.z0, z1 = ph.z1;
    var cz = (z0 + z1) * 0.5;
    var i;

    // ---- the north strip.  This is the whole left half of the `interior`
    // framing and it was bare slab; it is now the stores end of the hall.
    var wb = K.workbench();
    this._placeRigAt(wb, x0 + 5.2, fy, z1 - 1.35, Math.PI);
    this._placeAt(this.B.toolbox, x0 + 7.1, fy, z1 - 1.15, Math.PI, { tilt: 0.004 });
    this._placeAt(this.B.toolbox, x0 + 3.1, fy, z1 - 1.20, Math.PI + 0.06, { tilt: 0.004 });
    for (i = 0; i < 6; i++) {
      var dx = x0 + 9.4 + i * 0.62;
      var b = i % 3 === 0 ? this.B.drumBlue : (i % 3 === 1 ? this.B.drumPale : this.B.drumRust);
      this._placeAt(b, dx, fy, z1 - 1.05 + (i % 2) * 0.62, R.range(0, 6), { tilt: 0.006 });
    }
    this._placeAt(this.B.ibc, x0 + 13.6, fy, z1 - 1.45, 0.04, { tilt: 0.003 });
    this._placeAt(this.B.ibc, x0 + 15.0, fy, z1 - 1.45, -0.03, { tilt: 0.003 });
    this._placeAt(this.B.sacks, x0 + 17.6, fy, z1 - 1.55, 0.10, { tilt: 0.004 });
    this._placeAt(this.B.pallet, x0 + 17.5, fy, z1 - 3.10, 0.06, { tilt: 0.004 });
    this._placeAt(this.B.pallet, x0 + 16.2, fy, z1 - 3.15, 1.60, { tilt: 0.004 });
    this._placeAt(this.B.crate, x0 + 1.9, fy, z1 - 2.9, 0.22, { tilt: 0.004 });
    this._placeAt(this.B.crate, x0 + 3.2, fy, z1 - 3.0, -0.16, { tilt: 0.004 });
    // one wound, one bare and lying on its side where it was rolled off the
    // pallet - two identical upright drums was the review's own example of
    // uniformity across the prop set
    this._placeAt(this.B.cableDrum, x0 + 11.4, fy, z1 - 3.1, 1.35, { tilt: 0.004 });
    this._placeAt(this.B.coil, x0 + 6.4, fy, z1 - 3.2, 0.5, { tilt: 0.004 });
    for (i = 0; i < 4; i++) {
      this._placeAt(this.B.bottle, x0 + 0.9, fy, z1 - 4.6 - i * 0.30, R.range(0, 6), { tilt: 0.01 });
    }
    this._placeAt(this.B.hose, x0 + 0.75, fy, cz + 2.2, -Math.PI * 0.5, { tilt: 0.003 });
    // the near stores stack, four metres inside the shutter
    this._placeAt(this.B.pallet, x1 - 2.3, fy, z1 - 1.55, 0.05, { tilt: 0.004 });
    this._placeAt(this.B.sacks, x1 - 3.7, fy, z1 - 1.60, 0.08, { tilt: 0.004 });
    this._placeAt(this.B.drumBlue, x1 - 1.5, fy, z1 - 2.9, 0.9, { tilt: 0.006 });
    this._placeAt(this.B.drumPale, x1 - 2.15, fy, z1 - 2.9, 2.4, { tilt: 0.006 });
    this._placeAt(this.B.drumPale, x1 - 1.85, fy, z1 - 3.5, 4.1, { tilt: 0.006 });
    this._placeAt(this.B.crate, x1 - 5.4, fy, z1 - 1.45, -0.07, { tilt: 0.004 });
    // rolled flat onto a flange, which is how a drum ends up once its cable is
    // pulled and nobody has taken it back to the store
    this._placeAt(this.B.cableDrumBare, x1 - 4.2, fy + 0.72, z1 - 3.4, 0.9,
      { lay: Math.PI * 0.5, layDir: 0.35, tilt: 0 });
    this._placeAt(this.B.cone, x1 - 3.4, fy, z1 - 5.0, 0.6, { tilt: 0.02 });
    this._placeAt(this.B.toolbox, x1 - 6.8, fy, z1 - 3.0, 1.55, { tilt: 0.004 });
    this._placeAt(this.B.coil, x1 - 5.9, fy, z1 - 4.6, 0.3, { tilt: 0.004 });
    this._placeAt(this.B.plank, x1 - 2.9, fy, z1 - 4.4, 0.35, { tilt: 0.02 });
    this._markAt(MARK.grime, x1 - 3.2, fy, z1 - 2.6, 3.6, 2.6, 0.0);

    // ---- the pump row's own service kit, on the aisle side ----------------
    var bays = ph.bays || [];
    for (i = 0; i < bays.length; i++) {
      var bp = bays[i].position;
      if (!bp) continue;
      // the drip tray drum and the oil stain that says which pump leaks
      if (i % 2 === 0) {
        this._placeAt(this.B.drumRust, bp.x + 1.35, fy, bp.z + 1.30, R.range(0, 6), { tilt: 0.006 });
      }
      this._markAt(MARK.oil, bp.x + R.range(-0.3, 0.3), fy, bp.z + 1.15,
        1.6, 1.2, R.range(0, 3));
      if (i === 1) this._placeAt(this.B.hat, bp.x + 0.9, fy, bp.z + 1.55, R.range(0, 6), { tilt: 0.05 });
      if (i === 3) this._placeAt(this.B.coil, bp.x - 0.8, fy, bp.z + 1.45, 0.8, { tilt: 0.004 });
    }
    // ---- the south strip: spares and the swept-up debris of a shift -------
    this._placeAt(this.B.pallet, x0 + 4.4, fy, z0 + 1.25, 0.03, { tilt: 0.004 });
    this._placeAt(this.B.sacks, x0 + 6.6, fy, z0 + 1.30, 0.05, { tilt: 0.004 });
    this._placeAt(this.B.crate, x0 + 9.0, fy, z0 + 1.20, -0.10, { tilt: 0.004 });
    this._placeAt(this.B.drumBlue, x0 + 11.0, fy, z0 + 1.10, 1.2, { tilt: 0.006 });
    this._placeAt(this.B.drumBlue, x0 + 11.66, fy, z0 + 1.10, 2.9, { tilt: 0.006 });
    this._placeAt(this.B.toolbox, x0 + 13.6, fy, z0 + 1.15, 0.02, { tilt: 0.004 });
    this._placeAt(this.B.cone, x0 + 15.8, fy, z0 + 1.40, 0.4, { tilt: 0.02 });
    this._placeAt(this.B.cone, x0 + 16.5, fy, z0 + 1.10, 2.1, { tilt: 0.02 });
    this._placeAt(this.B.offcut, x0 + 18.6, fy, z0 + 1.5, 0.9, { tilt: 0.03 });
    this._placeAt(this.B.rag, x0 + 19.4, fy, z0 + 2.2, 1.7, { tilt: 0.02 });
    this._placeAt(this.B.rag, x0 + 12.2, fy, z1 - 2.4, 0.4, { tilt: 0.02 });
    this._placeAt(this.B.ext, x0 + 0.9, fy, z0 + 1.5, Math.PI * 0.5, { tilt: 0.003 });
    this._placeAt(this.B.ext, x1 - 1.4, fy, z0 + 1.5, -Math.PI * 0.5, { tilt: 0.003 });

    // ---- the floor itself.  The walking line from the shutter to the pump
    // row and on to the MCC is the most-trodden 30 square metres in the level,
    // and a swept-clean slab is the tell that nobody works here.
    // THE TYRE TRACK. Built as a CHAIN of quads laid nose to tail in world
    // metres, each 1.7 m long, so the tread pitch is fixed at 190 mm on the
    // ground and perspective shortens it by itself. It curves gently toward the
    // shutter (a fork truck coming in through the door does not drive a
    // straight line) and fades over its last 4 m by narrowing to nothing, so it
    // dies into the floor instead of stopping at an edge.
    var TRK = 14, trkX0 = x1 - 1.6, trkX1 = x0 + 3.4;
    for (i = 0; i < TRK; i++) {
      var u = (i + 0.5) / TRK;
      var tx3 = M.lerp(trkX0, trkX1, u);
      // the curve: hardest near the shutter where the truck is still turning in
      var bend = Math.pow(1 - u, 1.7) * 2.4;
      var tz3 = cz - 1.05 + bend + Math.sin(u * 5.1) * 0.10;
      var fade = M.smoothstep(1.0, 0.72, u);          // last 4 m dies away
      var wide = 1.55 * (0.55 + 0.45 * fade);
      var head = Math.atan2(
        M.lerp(trkX0, trkX1, Math.min(1, u + 0.06)) - tx3,
        (cz - 1.05 + Math.pow(1 - Math.min(1, u + 0.06), 1.7) * 2.4) - tz3);
      this._markAt(MARK.tread, tx3, fy, tz3, wide, (trkX0 - trkX1) / TRK * 1.02,
        head + Math.PI * 0.5);
    }
    // a second, older pass at a different heading, half faded
    for (i = 0; i < 8; i++) {
      var u2 = (i + 0.5) / 8;
      this._markAt(MARK.tread, M.lerp(x1 - 2.4, x0 + 9.0, u2), fy,
        cz + 2.6 - u2 * 1.4, 1.15, (x1 - 11.4 - x0) / 8 * 1.02,
        Math.PI * 0.5 + 0.10);
    }
    this._markAt(MARK.grime, x0 + 6.0, fy, z1 - 1.9, 4.5, 2.2, 0.0);
    this._markAt(MARK.grime, x0 + 15.0, fy, z1 - 2.0, 4.0, 2.0, 0.0);
    this._markAt(MARK.scuff, x1 - 3.0, fy, ph.door ? ph.door.position.z : cz, 3.2, 4.2, 0.0);
    this._markAt(MARK.unitno, x0 + 2.2, fy, cz - 3.4, 1.6, 1.1, 1.57);

    // ---- outside the roll shutter -----------------------------------------
    this._drumCluster(x1 + 2.6, (ph.door ? ph.door.position.z : cz) - 4.2, 4, false);
    this._place(this.B.pallet, x1 + 2.4, (ph.door ? ph.door.position.z : cz) + 3.8,
      { r: 0.85, h: 0.16 });
    this._place(this.B.bollard, x1 + 1.1, (ph.door ? ph.door.position.z : cz) - 2.9,
      { r: 0.4, h: 1.0, collider: [0.14, 0.5, 0.14] });
    this._place(this.B.bollard, x1 + 1.1, (ph.door ? ph.door.position.z : cz) + 2.9,
      { r: 0.4, h: 1.0, collider: [0.14, 0.5, 0.14] });
    this._place(this.B.skip, x1 + 4.6, z0 - 2.2, { r: 2.4, h: 1.3, yaw: 0.1,
      collider: [1.8, 0.65, 0.95] });
    this._mark(MARK.scuff, x1 + 5.0, (ph.door ? ph.door.position.z : cz), 4.0, 5.0, 0.0);
  };

  // A rig placed at an explicit floor level rather than on the terrain.
  PropsRefinery.prototype._placeRigAt = function (rig, x, y, z, yaw) {
    if (!rig || !rig.parts) return;
    var base = Tn(x, y, z, 0, yaw || 0, 0);
    var mm = new THREE.Matrix4();
    for (var k in rig.parts) {
      var list = rig.parts[k];
      var bucket = this.S[k] ? k : 'steel';
      for (var i = 0; i < list.length; i++) {
        mm.copy(base);
        if (list[i].matrix) mm.multiply(list[i].matrix);
        this._static(bucket, list[i].geometry, mm);
      }
    }
  };

  PropsRefinery.prototype._markAt = function (cell, x, y, z, w, h, yaw) {
    this._static('marks', markQuad(cell, w, h), Tn(x, y + 0.008, z, 0, yaw || 0, 0));
  };

  // ---- the control building and its compound -------------------------------
  PropsRefinery.prototype._dressControl = function () {
    var A = this.A, R = this.rng;
    var cb = A && A.control;
    if (!cb) return;
    var i;
    // bollards along the west elevation, protecting the glazing from the road
    for (i = 0; i < 7; i++) {
      this._place(this.B.bollard, cb.x0 - 1.6, cb.z0 + 1.6 + i * 2.6,
        { r: 0.4, h: 1.0, tilt: 0.02, collider: [0.14, 0.5, 0.14] });
    }
    // the muster point: signage, a hose reel and a wash station by the door
    if (cb.door && cb.door.position) {
      var dp = cb.door.position;
      this._signPost(dp.x - 2.4, dp.z - 1.2, Math.PI * 0.5, MARK.ppe, { bentP: 0.0 });
      this._place(this.B.ext, dp.x - 1.0, dp.z + 2.2, { r: 0.8, h: 1.5, yaw: Math.PI * 0.5 });
      this._mark(MARK.tread, dp.x - 2.0, dp.z, 2.4, 2.0, Math.PI * 0.5);
    }
    this._place(this.B.shower, cb.x0 - 2.2, cb.z1 - 2.0, { r: 0.7, h: 2.3, yaw: Math.PI * 0.5,
      collider: [0.22, 1.15, 0.22] });
    // the car park kerb line south of the building, and what sits on it
    for (i = 0; i < 8; i++) {
      this._place(this.B.barrier, cb.x0 + 1.4 + i * 2.36, cb.z1 + 4.2,
        { r: 1.15, h: 0.85, yaw: Math.PI * 0.5, tilt: 0.01, maxRelief: 0.3,
          collider: [1.18, 0.42, 0.32] });
    }
    this._place(this.B.cone, cb.x0 + 0.4, cb.z1 + 4.0, { r: 0.3, h: 0.7, low: true });
    this._place(this.B.cone, cb.x0 + 20.4, cb.z1 + 4.0, { r: 0.3, h: 0.7, low: true });
    this._mark(MARK.scuff, cb.x0 + 8.0, cb.z1 + 8.0, 6.0, 7.0, 0.1);
    this._mark(MARK.arrow, cb.x0 - 4.5, cb.z0 + 8.0, 2.2, 1.4, Math.PI * 0.5);
  };

  // ==========================================================================
  // THE GATE APPROACH.
  //
  // level_refinery now builds a weighbridge, a kiosk, two boom barriers, a
  // marked truck park and a drum-store canopy across x 11..54, z 43..75, and
  // stands a 15.4 m four-head floodlight tower over them - because the
  // establishing frame's bottom third measured a median luminance of 0.043 with
  // 59.7% of its pixels under 0.05.  That is the plant.  This is the traffic:
  // the tanker on the deck waiting to be weighed, the flatbed reversed into
  // bay 3, the drums and totes that came off it, the cones that keep everything
  // else off the deck, and the signage a gate carries.
  //
  // It runs LAST of the fixed dressing passes on purpose.  Every prop here is
  // within thirty metres of the establishing eye, so it is the one place on the
  // site where a rejected placement is visible - and by running after the
  // containers, the skips and the compound have taken their ground, nothing here
  // has to compete for it.
  // ==========================================================================
  PropsRefinery.prototype._dressEntrance = function () {
    var A = this.A, R = this.rng, N = this.noise;
    var en = A && A.entrance;
    if (!en) return;
    var wb = en.weighbridge, ki = en.kiosk, by = en.bays, cn = en.canopy;
    var i, k;

    // ---- 1. the tanker on the weighbridge -----------------------------------
    // Standing ON the deck, which is the whole reason the deck exists: an 11 m
    // vehicle is the one object in the frame whose size a viewer knows without
    // being told, and putting it on the weighbridge makes both of them read.
    if (wb) {
      var wbCx = (wb.x0 + wb.x1) * 0.5, wbCz = (wb.z0 + wb.z1) * 0.5;
      // lift 0.14: it stands on the DECK, not on the slab. _ground reports the
      // level's authored surface, and the weigh plates sit 0.14 m over it.
      this._placeRig(K.tanker(N), wbCx + 0.15, wbCz + 0.4, 0.012,
        { r: 5.2, maxRelief: 0.9, lift: 0.14 });
      this._occupy(wbCx, wbCz, 6.0);
      // the driver's cone and the chock he actually put down
      this._place(this.B.cone, wb.x1 + 1.05, wb.z0 - 1.6,
        { r: 0.30, h: 0.7, low: true, road: true, yaw: R.range(0, 6), tilt: 0.05 });
      this._place(this.B.cone, wb.x0 - 1.05, wb.z1 + 1.4,
        { r: 0.30, h: 0.7, low: true, road: true, yaw: R.range(0, 6), tilt: 0.05 });
      this._mark(MARK.oil, wbCx + 0.4, wb.z0 - 3.4, 2.6, 2.0, 0.05, { maxRelief: 0.7 });
      this._mark(MARK.scuff, wbCx, wb.z0 - 7.0, 3.6, 8.0, 0.0, { maxRelief: 0.7 });
      this._mark(MARK.scuff, wbCx, wb.z1 + 6.0, 3.6, 7.0, 0.0, { maxRelief: 0.7 });
      // the queue: barriers channelling traffic onto the deck
      this._barrierRun(wb.x1 + 1.9, wb.z0 - 8.5, wb.x1 + 1.9, wb.z0 - 1.5, 0.0);
    }

    // ---- 2. the kiosk's own housekeeping ------------------------------------
    if (ki && ki.centre) {
      var kc = ki.centre;
      for (i = 0; i < 4; i++) {
        this._place(this.B.bollard, kc.x - ki.w * 0.5 - 1.5, kc.z - 2.4 + i * 1.7,
          { r: 0.36, h: 1.0, tilt: 0.03, collider: [0.14, 0.5, 0.14] });
      }
      this._place(this.B.ext, kc.x - ki.w * 0.5 - 0.4, kc.z + ki.d * 0.5 + 0.5,
        { r: 0.7, h: 1.5, yaw: Math.PI * 0.5 });
      this._signPost(kc.x - ki.w * 0.5 - 2.6, kc.z + 3.4, Math.PI, MARK.ppe, { bentP: 0.0 });
      this._signPost(kc.x + ki.w * 0.5 + 1.8, kc.z - 2.8, Math.PI, MARK.nosmoke);
      this._place(this.B.drumRust, kc.x + ki.w * 0.5 + 1.0, kc.z + ki.d * 0.5 + 0.9,
        { r: 0.34, h: 0.9, yaw: R.range(0, 6), collider: [0.30, 0.44, 0.30] });
      this._mark(MARK.tread, kc.x - ki.w * 0.5 - 1.0, kc.z + ki.d * 0.5 - 0.9, 2.0, 1.8,
        Math.PI * 0.5);
    }

    // ---- 3. the truck park, in use ------------------------------------------
    // One flatbed reversed into a bay with its load still on it, and the bays
    // either side of it holding what came off the last one.  A car park with
    // painted bays and nothing standing in them is a car park nobody uses.
    if (by) {
      var bayZ = function (n) { return by.z0 + (n + 0.5) * by.pitch; };
      // bay 0: pipe spools on dunnage, squared off against the bay line.
      // _pipeStack tests the GRADE but not the occupancy grid, and a skip from
      // the contractor's compound stands 2 m away, so the test is made here -
      // the alternative is a stack of pipe growing through a skip.
      if (!this._occupied(by.x0 + 5.4, bayZ(0), 3.6)) {
        this._pipeStack(by.x0 + 5.4, bayZ(0), 1.571, 3, 5, false);
      }
      // bay 1: the fork truck, mid-job with a pallet still down
      if (!this._occupied(by.x0 + 3.4, bayZ(1) - 0.4, 2.8)) {
        this._placeRig(K.forklift(N), by.x0 + 3.4, bayZ(1) - 0.4, -1.62,
          { r: 2.6, maxRelief: 0.5 });
      }
      for (i = 0; i < 3; i++) {
        this._place(this.B.pallet, by.x0 + 8.2 + i * 1.35, bayZ(1) + 1.2,
          { r: 0.85, h: 0.16, yaw: R.range(-0.2, 0.2) });
      }
      // bay 2: out of service. Coned off, taped, and the reason is on the deck.
      this._coneRing(by.x0 + 5.6, bayZ(2), 3.6, 1.4, 7, { road: true, lay: 4 });
      this._mark(MARK.oil, by.x0 + 5.6, bayZ(2), 3.4, 2.4, 0.15, { lift: 0.011 });
      this._place(this.B.hat, by.x0 + 2.4, bayZ(2) - 1.5,
        { r: 0.25, h: 0.2, low: true, road: true, tilt: 0.06 });
      // bay 3: a store container dropped in it, which is what an idle bay grows
      if (!this._occupied(by.x0 + 6.4, bayZ(3), 4.4)) {
        this._placeRig(K.container(N, false), by.x0 + 6.4, bayZ(3), 1.575,
          { r: 4.2, maxRelief: 0.6 });
      }
      for (i = 0; i < 3; i++) {
        this._place(this.B.ibc, by.x1 - 2.4, bayZ(3) - 1.3 + i * 1.25,
          { r: 0.85, h: 1.2, yaw: Math.PI * 0.5 + R.range(-0.08, 0.08),
            collider: [0.55, 0.6, 0.62] });
      }
      // bay 4: the drum line and the crates that came off the last flatbed. A
      // row of drums at 1.05 m centres reads as a GRID from above, which is what
      // a steeply-viewed apron needs and had none of.
      for (i = 0; i < 7; i++) {
        var dbx = by.x0 + 2.0 + i * 1.05;
        var bb = R.next();
        this._place(bb < 0.42 ? this.B.drumBlue : (bb < 0.74 ? this.B.drumRust : this.B.drumPale),
          dbx, bayZ(4) - 0.9 + R.range(-0.12, 0.12),
          { r: 0.34, h: 0.9, yaw: R.range(0, 6), collider: [0.30, 0.44, 0.30] });
      }
      for (i = 0; i < 5; i++) {
        this._place(this.B.crate, by.x0 + 2.6 + i * 1.5, bayZ(4) + 1.1,
          { r: 0.92, h: 0.9, yaw: R.range(-0.3, 0.3), collider: [0.62, 0.45, 0.52] });
      }
      this._place(this.B.skip, by.x1 - 2.2, bayZ(4) + 0.4,
        { r: 2.4, h: 1.3, yaw: 1.58, collider: [1.8, 0.65, 0.95] });
      // and the tracks the traffic actually leaves at the head of the row
      for (i = 0; i < by.n; i++) {
        this._mark(MARK.scuff, by.x0 - 2.6, bayZ(i), 4.4, 3.2, Math.PI * 0.5,
          { lift: 0.011, maxRelief: 0.5 });
      }
      this._mark(MARK.grime, by.x0 + 7.0, bayZ(3), 6.0, 5.0, 0.1, { lift: 0.010 });
    }

    // ---- 4. the drum store under the canopy --------------------------------
    if (cn && cn.centre) {
      var cc = cn.centre;
      for (i = 0; i < 5; i++) {
        this._place(this.B.pallet, cc.x - cn.w * 0.5 + 1.0 + i * 1.7, cc.z + cn.d * 0.5 - 1.0,
          { r: 0.82, h: 0.16, yaw: R.range(-0.15, 0.15) });
      }
      for (i = 0; i < 4; i++) {
        this._place(this.B.bottlePack, cc.x - cn.w * 0.5 + 1.2 + i * 2.1,
          cc.z + cn.d * 0.5 + 1.3,
          { r: 0.68, h: 1.5, yaw: R.range(0, 6), collider: [0.45, 0.78, 0.45] });
      }
      this._place(this.B.toolbox, cc.x + cn.w * 0.5 - 1.0, cc.z - cn.d * 0.5 + 0.9,
        { r: 0.7, h: 0.9, yaw: 1.2 });
      this._place(this.B.coil, cc.x - cn.w * 0.5 - 1.2, cc.z + 0.4,
        { r: 0.55, h: 0.2, low: true });
      this._signPost(cc.x - cn.w * 0.5 - 2.0, cc.z - cn.d * 0.5 - 1.4, Math.PI, MARK.flam);
      this._mark(MARK.oil, cc.x, cc.z + cn.d * 0.5 + 2.2, 3.0, 2.2, 0.1);
    }

    // ---- 5. the gate itself -------------------------------------------------
    // Signage on the approach, and the sand that has been drifting against the
    // south fence for nine years - which is the one thing in this quarter of the
    // site that is not man-made.
    var bz = en.boomZ === undefined ? 70.5 : en.boomZ;
    this._signPost(this.road.x1 + 2.6, bz + 2.6, Math.PI, MARK.danger, { bentP: 0.0 });
    this._signPost(this.road.x0 - 2.6, bz + 2.6, Math.PI, MARK.nosmoke, { bentP: 0.0 });
    this._signPost(this.road.x1 + 2.4, bz - 5.0, Math.PI, MARK.ppe);
    for (i = 0; i < 5; i++) {
      this._place(this.B.cone, this.road.x1 + 0.9 + R.range(-0.2, 0.2), bz - 2.0 - i * 1.6,
        { r: 0.28, h: 0.7, low: true, road: true, yaw: R.range(0, 6), tilt: 0.05,
          lay: (i === 2) ? R.range(0.18, 0.36) : 0 });
    }
    var yawW = Math.atan2(this._wx(), this._wz());
    for (i = 0; i < 14; i++) {
      var sx = R.range(en.x0 + 2, en.x1 - 2), sz = R.range(en.z1 - 2, en.z1 + 5);
      this._place(this.B.drift2, sx, sz,
        { r: 0.7, h: 0.2, low: true, road: true, tilt: 0, yaw: yawW + R.range(-0.45, 0.45),
          sx: R.range(1.8, 3.8), sy: R.range(0.35, 0.9), sz: R.range(1.0, 2.4),
          sink: 0.045, maxRelief: 0.7 });
    }
    // a couple of tumbleweeds caught against the boom pedestals, because the
    // gate is where everything the wind carries finally stops
    for (i = 0; i < 3; i++) {
      this._place(this.B.weed, this.road.x1 + R.range(1.2, 3.6), bz + R.range(-1.4, 1.4),
        { r: 0.45, h: 0.5, low: true, road: true, tilt: 0.08,
          scale: R.range(0.7, 1.15), maxRelief: 0.8 });
    }
  };

  // ---- the rack walkway, 11 m up -------------------------------------------
  // hero2 stands on this deck, so its foreground is whatever is lying on it.
  // Everything here is small, to one side and lashed down, because a walkway
  // is 1.2 m wide and anything loose on it goes over the edge.
  PropsRefinery.prototype._dressRackDeck = function () {
    var A = this.A, R = this.rng;
    var racks = (A && A.racks) || [];
    var rk = racks[0];
    if (!rk || !rk.deckY) return;
    var wxp = (rk.walkX !== undefined && rk.walkX) ? rk.walkX : (rk.x + rk.halfW - 0.62);
    var i, z;
    for (z = rk.z0 + 8; z < rk.z1 - 4; z += 6.2) {
      var y = this._ground(wxp, z) + rk.deckY;
      var off = R.range(-0.42, -0.20);
      var roll = R.next();
      if (roll < 0.30) {
        this._placeAt(this.B.tray, wxp + off - 0.15, y + 0.02, z, 0.0, { tilt: 0.004 });
      } else if (roll < 0.46) {
        this._placeAt(this.B.jbox, wxp + off, y, z, Math.PI * 0.5, { tilt: 0.01 });
      } else if (roll < 0.58) {
        this._placeAt(this.B.coil, wxp + off, y, z, R.range(0, 6), { tilt: 0.01 });
      } else if (roll < 0.68) {
        this._placeAt(this.B.bottle, wxp + off, y, z, R.range(0, 6), { tilt: 0.02 });
      } else if (roll < 0.76) {
        this._placeAt(this.B.toolbox, wxp + off - 0.05, y, z, R.range(0, 6), { tilt: 0.01 });
      } else if (roll < 0.86) {
        this._placeAt(this.B.offcut, wxp + off, y, z, R.range(0, 6), { tilt: 0.05 });
      } else if (roll < 0.92) {
        this._placeAt(this.B.hat, wxp + off, y, z, R.range(0, 6), { tilt: 0.06 });
      }
      // and the odd cone marking a grating that has been lifted
      if (R.bool(0.16)) this._placeAt(this.B.cone, wxp + R.range(-0.2, 0.2), y, z + 2.2,
        R.range(0, 6), { tilt: 0.01 });
    }
    // THE LIT STRETCH.  The deck's own lamp stands at the south end of the run
    // and throws about 20 m; everything beyond that is a dark walkway with a
    // bright plant behind it, so the props that have to READ go inside that
    // pool and they are the pale and saturated ones - a yellow hat, an orange
    // cone, a red tool chest, a pale drum - rather than another grey box.
    var lit = [
      [0.4, 'cone'], [-2.2, 'drumPale'], [-4.4, 'hat'], [-6.4, 'toolbox'],
      [-8.4, 'drumPale'], [-10.6, 'coil'], [-12.6, 'cone'], [-14.8, 'bottle'],
      [-17.0, 'offcut'], [-19.4, 'drumPale'], [-21.6, 'cone']
    ];
    for (i = 0; i < lit.length; i++) {
      var lz = lit[i][0];
      var ly = this._ground(wxp, lz) + rk.deckY;
      var lo = (i % 2) ? -0.38 : 0.24;
      this._placeAt(this.B[lit[i][1]], wxp + lo, ly, lz, R.range(0, 6),
        { tilt: lit[i][1] === 'offcut' ? 0.05 : 0.012 });
    }

    // a cordon across the deck where the grating is out, 26 m up the run
    var cz = rk.z0 + 26.0;
    var cy = this._ground(wxp, cz) + rk.deckY;
    this._tapeSeg(wxp - 0.62, cy + 1.02, cz, wxp + 0.62, cy + 1.02, cz, 0.10);
    this._placeAt(this.B.cone, wxp - 0.30, cy, cz + 0.6, 0.3, { tilt: 0.01 });
    this._placeAt(this.B.cone, wxp + 0.30, cy, cz + 0.6, 2.1, { tilt: 0.01 });
  };

  // ---- windblown sand ------------------------------------------------------
  // Sand does not sit in a uniform layer, it BANKS: against the windward face
  // of anything that stops the wind, in the corner where two faces meet, and
  // in the lee of small obstacles where the flow separates and drops its load.
  // Everything below is one of those three cases; there is no scatter pass.
  PropsRefinery.prototype._dressSand = function () {
    var A = this.A, R = this.rng;
    var wx = this._wx(), wz = this._wz();
    var yawW = Math.atan2(wx, wz);
    var self = this;
    var i, t;

    function bank(x0, z0, x1, z1, count, big) {
      var dx = x1 - x0, dz = z1 - z0;
      var len = Math.sqrt(dx * dx + dz * dz) || 1;
      // outward normal of the run, pointing into the wind
      var nx = -dz / len, nz = dx / len;
      if (nx * wx + nz * wz > 0) { nx = -nx; nz = -nz; }
      for (var k = 0; k < count; k++) {
        var f = (k + R.range(0.1, 0.9)) / count;
        var px = x0 + dx * f + nx * R.range(0.25, 1.30);
        var pz = z0 + dz * f + nz * R.range(0.25, 1.30);
        self._place(big ? self.B.drift2 : self.B.drift, px, pz,
          { r: 0.55, h: 0.2, low: true, road: true, tilt: 0, yaw: yawW + R.range(-0.4, 0.4),
            sx: R.range(1.3, big ? 3.6 : 2.4), sy: R.range(0.35, 0.9),
            sz: R.range(0.8, big ? 2.2 : 1.6), sink: 0.035, maxRelief: 0.6 });
      }
    }

    // the buildings
    var ph = A && A.pumpHouse;
    if (ph) {
      bank(ph.x0, ph.z0, ph.x1, ph.z0, 12, true);
      bank(ph.x0, ph.z0, ph.x0, ph.z1, 9, true);
      bank(ph.x0, ph.z1, ph.x1, ph.z1, 10, false);
    }
    var cb = A && A.control;
    if (cb) {
      bank(cb.x0, cb.z0, cb.x1, cb.z0, 11, true);
      bank(cb.x0, cb.z0, cb.x0, cb.z1, 9, true);
    }
    var cools = (A && A.coolers) || [];
    for (i = 0; i < cools.length; i++) {
      var cc = cools[i];
      if (!cc.centre) continue;
      bank(cc.centre.x - cc.w * 0.5, cc.centre.z - cc.d * 0.5,
        cc.centre.x + cc.w * 0.5, cc.centre.z - cc.d * 0.5, 7, true);
    }
    // the raised unit plinths: sand ramps up against a 0.4 m kerb exactly the
    // way it does against a wall
    bank(20.0, -52.0, 20.0, 6.0, 16, false);
    bank(20.0, -52.0, 34.0, -52.0, 8, false);
    bank(42.0, -36.0, 42.0, -14.0, 9, false);
    bank(9.0, -76.0, 31.0, -76.0, 10, false);

    // the site fence line, where nothing has ever driven and the drift is deep
    var s = this.site;
    bank(s.x0 + 6, s.z0 + 6, s.x1 - 6, s.z0 + 6, 26, true);
    bank(s.x0 + 6, s.z0 + 6, s.x0 + 6, s.z1 - 6, 26, true);
    bank(s.x1 - 6, s.z0 + 6, s.x1 - 6, s.z1 - 6, 24, true);

    // and the corners of the paved area, which is where it really piles up
    var corners = [
      [this.pave.x0 + 2, this.pave.z0 + 2], [this.pave.x1 - 2, this.pave.z0 + 2],
      [this.pave.x0 + 2, this.pave.z1 - 2], [this.pave.x1 - 2, this.pave.z1 - 2]
    ];
    for (i = 0; i < corners.length; i++) {
      for (var k = 0; k < 7; k++) {
        this._place(this.B.drift2, corners[i][0] + R.gaussian(0, 3.2),
          corners[i][1] + R.gaussian(0, 3.2),
          { r: 0.7, h: 0.2, low: true, road: true, tilt: 0, yaw: yawW + R.range(-0.5, 0.5),
            sx: R.range(2.0, 4.2), sy: R.range(0.4, 1.0), sz: R.range(1.2, 2.6),
            sink: 0.05, maxRelief: 0.7 });
      }
    }
    // the smears the drift leaves on the apron in front of itself
    for (i = 0; i < 34; i++) {
      var a = R.range(0, M.TAU), rr = 30 + Math.pow(R.next(), 0.5) * 55;
      var mx = Math.cos(a) * rr, mz = -20 + Math.sin(a) * rr;
      if (this._onRoad(mx, mz)) continue;
      this._mark(MARK.sand, mx, mz, R.range(3, 8), R.range(2, 6), yawW + R.range(-0.3, 0.3),
        { lift: 0.009, maxRelief: 0.5 });
    }
  };

  // ---- dry scrub -----------------------------------------------------------
  // It grows where nothing drives: the gravel margin beyond the paving, the
  // fence line, the bund corners and the crack at the foot of a kerb.  Density
  // comes off the noise field so it clumps the way seeded ground does.
  PropsRefinery.prototype._dressScrub = function () {
    var R = this.rng, N = this.noise;
    var s = this.site, pv = this.pave;
    var i, x, z;
    // the margin between the paving and the fence
    for (i = 0; i < 420; i++) {
      var edge = R.int(0, 3);
      if (edge === 0) { x = R.range(s.x0 + 4, s.x1 - 4); z = R.range(s.z0 + 4, pv.z0 - 0.5); }
      else if (edge === 1) { x = R.range(s.x0 + 4, s.x1 - 4); z = R.range(pv.z1 + 0.5, s.z1 - 4); }
      else if (edge === 2) { x = R.range(s.x0 + 4, pv.x0 - 0.5); z = R.range(s.z0 + 4, s.z1 - 4); }
      else { x = R.range(pv.x1 + 0.5, s.x1 - 4); z = R.range(s.z0 + 4, s.z1 - 4); }
      var d = N.fbm2(x * 0.055 + 3.1, z * 0.055 - 7.4, 3) * 0.5 + 0.5;
      if (d < 0.42) continue;
      this._place(this.B.scrub, x, z,
        { r: 0.30, h: 0.5, low: true, road: true, tilt: 0.05,
          scale: R.range(0.5, 1.5), maxRelief: 0.9 });
    }
    // the crack at the foot of the plinth kerbs and the bund walls
    var runs = [
      [20.0, -52.0, 20.0, 6.0], [34.0, -52.0, 34.0, 6.0],
      [42.0, -36.0, 42.0, -14.0], [-70.0, -66.0, -70.0, -26.0],
      [-30.0, -66.0, -30.0, -26.0], [-70.0, -24.0, -70.0, 10.0],
      [-30.0, -24.0, -30.0, 10.0], [-70.0, 24.0, -70.0, 50.0]
    ];
    for (i = 0; i < runs.length; i++) {
      var rn = runs[i];
      var n = Math.max(3, Math.round(Math.abs(rn[3] - rn[1] || rn[2] - rn[0]) / 2.6));
      for (var k = 0; k < n; k++) {
        var t = (k + R.range(0.1, 0.9)) / n;
        var px = rn[0] + (rn[2] - rn[0]) * t + R.range(-0.45, 0.45);
        var pz = rn[1] + (rn[3] - rn[1]) * t + R.range(-0.45, 0.45);
        if (!R.bool(0.42)) continue;
        this._place(this.B.scrub, px, pz,
          { r: 0.26, h: 0.4, low: true, road: true, tilt: 0.06,
            scale: R.range(0.4, 0.95), maxRelief: 0.9 });
      }
    }
  };

  // ---- litter --------------------------------------------------------------
  // Two mechanisms, both physical: debris drops where work happens, and
  // anything light enough blows until something stops it.
  PropsRefinery.prototype._dressLitter = function () {
    var R = this.rng;
    var wx = this._wx(), wz = this._wz();
    var i;
    // 1. work spoil, near the places that generate it
    var sites = [
      [46.0, -58.0, 9.0], [-58.0, -74.0, 7.0], [21.8, -22.0, 4.0], [-14.6, 41.6, 4.0],
      [11.0, -30.0, 4.5], [-11.0, -2.0, 4.5], [41.0, 50.0, 6.0], [20.0, -86.0, 8.0],
      [-27.0, -16.0, 5.0], [18.6, 10.4, 4.0], [-5.2, -6.0, 5.0]
    ];
    for (i = 0; i < sites.length; i++) {
      var st = sites[i];
      var n = 5 + Math.round(st[2] * 0.7);
      for (var k = 0; k < n; k++) {
        var a = R.range(0, M.TAU), rr = Math.pow(R.next(), 0.55) * st[2];
        var x = st[0] + Math.cos(a) * rr, z = st[1] + Math.sin(a) * rr;
        var roll = R.next();
        var b = roll < 0.44 ? this.B.offcut : (roll < 0.78 ? this.B.plank : this.B.rag);
        this._place(b, x, z, { r: 0.30, h: 0.15, low: true, road: true, tilt: 0.06,
          maxRelief: 0.5 });
      }
    }
    // 2. wind-carried litter, caught on the DOWNWIND face of an obstacle - it
    // travels until a fence, a kerb or a bund wall stops it, so that is the
    // only place it is allowed to land
    var catchers = [
      [this.site.x0 + 6, this.site.z0 + 6, this.site.x1 - 6, this.site.z0 + 6],
      [this.site.x1 - 6, this.site.z0 + 6, this.site.x1 - 6, this.site.z1 - 6],
      [-30.0, -66.0, -30.0, -26.0], [-30.0, -24.0, -30.0, 10.0],
      [20.0, -52.0, 20.0, 6.0], [34.0, -52.0, 34.0, 6.0]
    ];
    for (i = 0; i < catchers.length; i++) {
      var c = catchers[i];
      var dx = c[2] - c[0], dz = c[3] - c[1];
      var len = Math.sqrt(dx * dx + dz * dz) || 1;
      var nx = -dz / len, nz = dx / len;
      if (nx * wx + nz * wz < 0) { nx = -nx; nz = -nz; }  // the LEE side
      for (var j = 0; j < 16; j++) {
        var f = R.next();
        var px = c[0] + dx * f - nx * R.range(0.1, 0.9);
        var pz = c[1] + dz * f - nz * R.range(0.1, 0.9);
        var rl = R.next();
        this._place(rl < 0.55 ? this.B.rag : (rl < 0.8 ? this.B.plank : this.B.offcut),
          px, pz, { r: 0.28, h: 0.12, low: true, road: true, tilt: 0.08, maxRelief: 0.6 });
      }
    }
    // and a couple of hard hats where somebody put one down and forgot it
    this._place(this.B.hat, 21.2, -18.6, { r: 0.25, h: 0.2, low: true, tilt: 0.05 });
    this._place(this.B.hat, -26.2, -13.4, { r: 0.25, h: 0.2, low: true, tilt: 0.05 });
    this._place(this.B.hat, 44.6, -59.0, { r: 0.25, h: 0.2, low: true, tilt: 0.05 });
  };

  // ---- ground marks --------------------------------------------------------
  PropsRefinery.prototype._dressGroundMarks = function () {
    var R = this.rng;
    var i, z;
    // WHEEL TRACKS.  Two ribbons at a truck's track width down the road, laid
    // where the traffic actually runs rather than everywhere.
    for (z = this.pave.z1 - 8; z > this.pave.z0 + 8; z -= 7.0) {
      for (var s = 0; s < 2; s++) {
        var x = (s ? 1 : -1) * 2.35 + R.range(-0.22, 0.22);
        this._mark(MARK.scuff, x, z, 1.6, 6.4, 0.0, { lift: 0.010, maxRelief: 0.4 });
      }
    }
    // the turning scrub at the cross road, where every vehicle swings wide
    this._mark(MARK.scuff, 6.0, 17.5, 7.0, 6.0, 0.0, { lift: 0.011, maxRelief: 0.5 });
    this._mark(MARK.scuff, -6.5, 17.5, 7.0, 6.0, 0.0, { lift: 0.011, maxRelief: 0.5 });
    // hydrocarbon on the crown, where drips land
    for (i = 0; i < 9; i++) {
      this._mark(MARK.oil, R.range(-3.5, 3.5), R.range(this.pave.z0 + 10, this.pave.z1 - 10),
        R.range(1.2, 2.8), R.range(1.0, 2.4), R.range(0, 3), { lift: 0.011, maxRelief: 0.4 });
    }
    // sprayed inspection marks where the lines cross the road
    var brs = (this.A && this.A.bridges) || [];
    for (i = 0; i < brs.length; i++) {
      this._mark(MARK.cross, R.range(-5, 5), brs[i].z + R.range(-2, 2), 1.2, 1.2,
        R.range(0, 3), { maxRelief: 0.4 });
      this._mark(MARK.arrow, (i % 2 ? 1 : -1) * 5.8, brs[i].z + 3.0, 2.0, 1.3,
        (i % 2 ? -1 : 1) * Math.PI * 0.5, { maxRelief: 0.4 });
    }
    // and the general grime of a working apron, banked where traffic converges
    var hot = [[0, 17.5], [18.6, 10.4], [-16.0, 37.5], [34.0, 30.0], [46.0, -58.0], [20.0, -78.0]];
    for (i = 0; i < hot.length; i++) {
      for (var k = 0; k < 3; k++) {
        this._mark(MARK.grime, hot[i][0] + R.gaussian(0, 4.0), hot[i][1] + R.gaussian(0, 4.0),
          R.range(3, 7), R.range(3, 6), R.range(0, 3), { lift: 0.009, maxRelief: 0.5 });
      }
    }
  };

  // ==========================================================================
  // THINGS THAT MOVE
  //
  // The level owns the flare, its smoke and three steam plumes.  What is added
  // here is the small stuff the wind actually touches: barrier tape, which is
  // the most legible moving thing in any industrial scene, four low-pressure
  // vents that trail vapour across the apron, and the tumbleweed that has been
  // stuck against the fence for a week and rocks when it gusts.
  // ==========================================================================
  PropsRefinery.prototype._tapeSeg = function (ax, ay, az, bx, by, bz, sag) {
    (this._tapeDefs || (this._tapeDefs = [])).push([ax, ay, az, bx, by, bz, sag || 0.16]);
  };

  PropsRefinery.prototype._tapeRing = function (cx, cz, rx, rz, h) {
    var n = 8;
    var prev = null;
    for (var i = 0; i <= n; i++) {
      var a = (i / n) * M.TAU + 0.13;
      var x = cx + Math.cos(a) * rx, z = cz + Math.sin(a) * rz;
      var y = this._ground(x, z) + h;
      if (prev) this._tapeSeg(prev[0], prev[1], prev[2], x, y, z, 0.14);
      prev = [x, y, z];
    }
  };

  PropsRefinery.prototype._dressWind = function () {
    var R = this.rng;
    var i;
    // a cordon along the kerb where the road works are
    var wy = this._ground(9.4, -30.0);
    this._tapeSeg(9.4, wy + 0.95, -36.0, 9.4, wy + 0.95, -30.0, 0.20);
    this._tapeSeg(9.4, wy + 0.95, -30.0, 9.4, wy + 0.95, -24.0, 0.20);
    // and one across the head of the unit-200 stair
    var uy = this._ground(20.6, -40.0);
    this._tapeSeg(20.6, uy + 1.0, -41.6, 20.6, uy + 1.0, -38.4, 0.12);

    // ---- tumbleweed ---------------------------------------------------------
    // Lodged against the fence and the bund walls, downwind, which is the only
    // place a tumbleweed ever stops.
    var wx = this._wx(), wz = this._wz();
    var lodges = [
      [this.site.x1 - 6.6, this.site.z0 + 20], [this.site.x1 - 6.6, this.site.z0 + 46],
      [this.site.x1 - 6.6, this.site.z1 - 30], [this.site.x0 + 7.4, this.site.z1 - 18],
      [-29.4, -40.0], [-29.4, -6.0], [19.4, -30.0], [19.4, 2.0],
      [this.site.x1 - 6.6, 10.0], [this.site.x0 + 7.4, -52.0]
    ];
    for (i = 0; i < lodges.length; i++) {
      var lx = lodges[i][0] + wx * R.range(-0.5, 0.2);
      var lz = lodges[i][1] + wz * R.range(-0.5, 0.2);
      var s = this._surface(lx, lz, 0.4);
      if (s.relief > 0.7) continue;
      var live = i < 6;
      var sc = R.range(0.7, 1.25);
      var y = s.y + 0.30 * sc;
      if (live) {
        this.weeds.push({ x: lx, y: y, z: lz, s: sc, phase: R.range(0, 6.28),
          yaw: R.range(0, 6.28), idx: this.weeds.length });
      } else {
        this._placeAt(this.B.weed, lx, y, lz, R.range(0, 6.28),
          { scale: sc, tilt: 0.10 });
      }
    }
    // the live ones go in their own batch so update() can rewrite them
    this.B.weedLive = new Batch(this.B.weed.mesh.geometry, this.mats.scrub,
      Math.max(1, this.weeds.length), true);
    for (i = 0; i < this.weeds.length; i++) {
      var w = this.weeds[i];
      this.B.weedLive.add(T(w.x, w.y, w.z, 0, w.yaw, 0, w.s, w.s, w.s),
        wearTint(R));
    }

    // ---- low-pressure vents -------------------------------------------------
    // Sited where a plant actually vents: a manifold bleed, the pump-house
    // gland drain, the heater's steam-out and a tank-farm sample point.
    var A = this.A;
    var mans = (A && A.manifolds) || [];
    this.ventDefs = [];
    for (i = 0; i < mans.length && i < 2; i++) {
      var mp = mans[i].position;
      if (!mp) continue;
      this.ventDefs.push({ x: mp.x + (mans[i].side || 1) * 0.9, y: mp.y + 2.4, z: mp.z - 1.2,
        rise: 3.4, rate: 0.30, size: 1.5, tint: new THREE.Color(0.62, 0.60, 0.58) });
    }
    var ph = A && A.pumpHouse;
    if (ph) {
      this.ventDefs.push({ x: ph.x1 + 0.5, y: ph.floorY + 1.2, z: ph.z0 + 3.0,
        rise: 2.2, rate: 0.42, size: 1.0, tint: new THREE.Color(0.58, 0.56, 0.55) });
    }
    var ht = A && A.heater;
    if (ht) {
      this.ventDefs.push({ x: ht.x0 - 0.6, y: (ht.centre ? ht.centre.y : 0) + 4.2, z: ht.z0 + 2.0,
        rise: 5.0, rate: 0.24, size: 2.1, tint: new THREE.Color(0.66, 0.62, 0.58) });
    }
    var tks = (A && A.tanks) || [];
    if (tks.length) {
      var t0 = tks[0];
      this.ventDefs.push({ x: t0.centre.x + t0.r * 0.2, y: t0.roofY + 1.4, z: t0.centre.z - t0.r * 0.9,
        rise: 4.2, rate: 0.20, size: 1.8, tint: new THREE.Color(0.60, 0.58, 0.58) });
    }
    if (this.ventDefs.length) {
      var per = 7;
      var geo = plane(1, 1);
      var im = new THREE.InstancedMesh(geo, this.mats.puff, this.ventDefs.length * per);
      im.name = 'refinery_vents';
      im.frustumCulled = false;
      im.castShadow = false;
      im.receiveShadow = false;
      im.renderOrder = 3;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (i = 0; i < this.ventDefs.length * per; i++) {
        im.setMatrixAt(i, T(0, -900, 0, 0, 0, 0, 0.01, 0.01, 0.01));
        im.setColorAt(i, WHITE);
      }
      this.vents = { mesh: im, per: per };
      this.root.add(im);
    }
  };

  // ---- tape geometry -------------------------------------------------------
  PropsRefinery.prototype._buildTape = function () {
    var defs = this._tapeDefs;
    if (!defs || !defs.length) return;
    var SEG = 9, W = 0.075;
    var vertsPer = SEG * 6;
    var total = defs.length * vertsPer;
    var pos = new Float32Array(total * 3);
    var nrm = new Float32Array(total * 3);
    var uv = new Float32Array(total * 2);
    var base = new Float32Array(total * 3);
    var flex = new Float32Array(total);
    var phase = new Float32Array(total);
    var perp = new Float32Array(total * 3);
    var v = 0;
    var a = new THREE.Vector3(), b = new THREE.Vector3();
    var p0 = new THREE.Vector3(), p1 = new THREE.Vector3();
    var pv = new THREE.Vector3();
    for (var d = 0; d < defs.length; d++) {
      var q = defs[d];
      a.set(q[0], q[1], q[2]); b.set(q[3], q[4], q[5]);
      var sag = q[6];
      pv.set(b.x - a.x, 0, b.z - a.z);
      var len = Math.max(0.2, pv.length());
      pv.normalize();
      // horizontal perpendicular to the run - the direction the tape bellies
      var pxn = -pv.z, pzn = pv.x;
      var dPhase = d * 2.7;
      for (var i = 0; i < SEG; i++) {
        var t0 = i / SEG, t1 = (i + 1) / SEG;
        p0.lerpVectors(a, b, t0); p0.y -= sag * 4 * t0 * (1 - t0);
        p1.lerpVectors(a, b, t1); p1.y -= sag * 4 * t1 * (1 - t1);
        var f0 = Math.sin(Math.PI * t0), f1 = Math.sin(Math.PI * t1);
        var quad = [
          [p0.x, p0.y + W, p0.z, 0, 0, t0, f0],
          [p1.x, p1.y + W, p1.z, 1, 0, t1, f1],
          [p1.x, p1.y - W, p1.z, 1, 1, t1, f1],
          [p0.x, p0.y + W, p0.z, 0, 0, t0, f0],
          [p1.x, p1.y - W, p1.z, 1, 1, t1, f1],
          [p0.x, p0.y - W, p0.z, 0, 1, t0, f0]
        ];
        for (var k = 0; k < 6; k++) {
          var e = quad[k];
          pos[v * 3] = base[v * 3] = e[0];
          pos[v * 3 + 1] = base[v * 3 + 1] = e[1];
          pos[v * 3 + 2] = base[v * 3 + 2] = e[2];
          nrm[v * 3] = pxn; nrm[v * 3 + 1] = 0; nrm[v * 3 + 2] = pzn;
          // ---- BUG, MEASURED IN THE SIGNATURE FRAME -----------------------
          // This was `e[3] * len * 1.6`, and e[3] is the QUAD-LOCAL u (0 or 1).
          // So every one of the nine segments in a run was given the full
          // 0..len*1.6 range across its own 0.36 m - about fourteen chevron
          // repeats per metre. At the 14 m the hero1 mark puts the road-works
          // cordon at, that is far past Nyquist, so the mip chain resolved the
          // whole ribbon to the texture's AVERAGE and the tape rendered as a
          // FLAT PALE PINK BAND with no chevrons in it at all - a two-metre
          // untextured single-colour surface in the near field of the level's
          // signature image, which is item one on the instant-fail list.
          //
          // e[5] is the parameter along the WHOLE run, which is what the
          // expression was reaching for. At 1.7 tiles per metre the texture's
          // 5.9 chevron pairs land at a 0.10 m pitch, which is real barrier tape.
          uv[v * 2] = e[5] * len * 1.7; uv[v * 2 + 1] = e[4];
          perp[v * 3] = pxn; perp[v * 3 + 1] = 0; perp[v * 3 + 2] = pzn;
          flex[v] = e[6];
          phase[v] = dPhase + e[5] * len * 0.9;
          v++;
        }
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.computeBoundingSphere();
    var mesh = new THREE.Mesh(g, this.mats.tape);
    mesh.name = 'refinery_tape';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    this.root.add(mesh);
    this.tape = { mesh: mesh, geo: g, base: base, flex: flex, phase: phase, perp: perp, n: total };
  };

  // ==========================================================================
  // COMMIT.  Everything one-off is merged per material into a single mesh, so
  // the whole prop set lands in about thirty draw calls; everything repeated is
  // already an InstancedMesh.  The counts are published on this.stats so an
  // overflowing batch is a number somebody can read rather than a silent hole
  // in the frame.
  // ==========================================================================
  var STATIC_BUCKETS = [
    ['steel', 'steel', 'structural_steel', true, { grime: 0.40, edge: 0.26, dust: 0.6, hiY: 2.2 }],
    ['paint', 'paintPale', 'painted_metal', true, { grime: 0.36, edge: 0.24, dust: 0.6, hiY: 2.2 }],
    ['paintA', 'paintPale', 'painted_metal', true, { grime: 0.34, edge: 0.22, dust: 0.6, hiY: 2.4 }],
    ['paintB', 'paintYellow', 'painted_metal', true, { grime: 0.44, edge: 0.34, dust: 0.6, hiY: 1.8 }],
    ['rust', 'rust', 'rusted_metal', true, { grime: 0.50, edge: 0.32, dust: 0.6, hiY: 2.0 }],
    ['concrete', 'concrete', 'concrete', true, { grime: 0.44, edge: 0.24, dust: 0.6, hiY: 1.6 }],
    ['timber', 'timber', 'wood_plank', true, { grime: 0.52, edge: 0.38, dust: 0.6, hiY: 1.2 }],
    ['clad', 'clad', 'corrugated_metal', true, { grime: 0.42, edge: 0.26, dust: 0.6, hiY: 2.4 }],
    ['rubber', 'rubber', 'rubber', true, { grime: 0.56, edge: 0.20, dust: 0.5, hiY: 1.0 }],
    ['grate', 'grate', 'steel_grate', true, { grime: 0.46, edge: 0.24, dust: 0.5, hiY: 1.0 }],
    ['sand', 'sand', 'sand', true, { grime: 0.16, edge: 0.05, dust: 0.2, hiY: 0.6 }],
    ['glass', 'glass', 'glass', false, null],
    ['lamp', 'lampWarm', null, false, null],
    ['marks', 'marks', null, false, null]
  ];

  PropsRefinery.prototype._commit = function () {
    var self = this;
    var draws = 0, tris = 0, instanced = 0;

    // ---- one-off geometry --------------------------------------------------
    for (var b = 0; b < STATIC_BUCKETS.length; b++) {
      var spec = STATIC_BUCKETS[b];
      var list = this.S[spec[0]];
      if (!list || !list.length) continue;
      var geo = null;
      try { geo = Geo.mergeAll(list); }
      catch (e) { GAME.logError('propsR.merge:' + spec[0], e); geo = null; }
      disposeParts(list);
      if (!geo || !geo.attributes.position || !geo.attributes.position.count) continue;
      if (spec[2]) {
        // marks carry ATLAS uvs and must never be re-projected: worldUV would
        // rewrite them and every placard on the site would sample cell zero
        try { Geo.worldUV(geo, this._uvScale(spec[2], 520)); } catch (e2) { /* keep uv */ }
      }
      Geo.copyUV1(geo);
      if (spec[3]) {
        var w = spec[4] || {};
        paintWear(geo, { noise: this.noise, grime: w.grime, edge: w.edge, dust: w.dust,
          hiY: w.hiY, seed: b * 3.1 });
      }
      try { geo.computeBoundingSphere(); geo.computeBoundingBox(); } catch (e3) { /* ignore */ }
      var mat = this.mats[spec[1]] || this.mats.steel;
      var mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'refinery_props_' + spec[0];
      mesh.castShadow = spec[0] !== 'marks';
      mesh.receiveShadow = true;
      if (spec[0] === 'marks') { mesh.renderOrder = 2; mesh.castShadow = false; }
      this.root.add(mesh);
      draws++;
      tris += geo.attributes.position.count / 3;
    }

    // ---- the animated ribbon ----------------------------------------------
    try { this._buildTape(); } catch (e4) { GAME.logError('propsR.tape', e4); }
    if (this.tape) { draws++; tris += this.tape.n / 3; }
    if (this.vents) { draws++; }

    // ---- instanced ---------------------------------------------------------
    for (var key in this.B) {
      var bat = this.B[key];
      if (!bat) continue;
      if (key === 'weed' && this.B.weedLive) { /* both are real batches */ }
      var m2 = bat.finish(this.root, 'refinery_' + key);
      if (m2) {
        draws++;
        instanced += bat.n;
        var pc = m2.geometry.attributes.position ? m2.geometry.attributes.position.count : 0;
        tris += (pc / 3) * bat.n;
      }
      if (bat.full) this.stats.full.push(key + ' +' + bat.full);
    }

    this.stats.draws = draws;
    this.stats.tris = Math.round(tris);
    this.stats.instanced = instanced;
    this.stats.colliders = this.colliders.length;
    this.stats.skipped = this._skipped;
    // An overflowing batch drops everything after the cap and is invisible
    // until somebody counts, so say so loudly enough to be seen in the report.
    if (this.stats.full.length) {
      GAME.logError('propsR.capacity', 'instanced batches overflowed: ' +
        this.stats.full.join(', '));
    }
    clearGeoCache();
    try { this.root.updateMatrixWorld(true); } catch (e5) { /* ignore */ }
  };

  // ==========================================================================
  // update
  // ==========================================================================
  var _wq = new THREE.Quaternion();
  var _wv = new THREE.Vector3();

  PropsRefinery.prototype.update = function (dt, ctx) {
    dt = dt || 0;
    this.time += dt;
    var t = this.time;
    ctx = ctx || this.ctx;

    // weather.js owns the wind if it is running; otherwise the level's own
    // evening breeze stands.
    try {
      if (ctx && ctx.weather && ctx.weather.windDir && isFinite(ctx.weather.windDir.x) &&
          ctx.weather.windSpeed > 0.05) {
        this.windDir.set(ctx.weather.windDir.x, ctx.weather.windDir.y);
        this.windSpeed = ctx.weather.windSpeed;
      }
    } catch (e) { /* our own breeze */ }

    // ---- barrier tape ------------------------------------------------------
    var tp = this.tape;
    if (tp) {
      // a slow travelling gust envelope plus the fast ripple running along each
      // run, so six cordons on the same site do not breathe in unison
      var gust = 0.62 + 0.38 * Math.sin(t * 0.41) * Math.sin(t * 0.17 + 1.3);
      var amp = M.clamp(0.055 + this.windSpeed * 0.016, 0.05, 0.20) * gust;
      var pos = tp.geo.attributes.position;
      var arr = pos.array, base = tp.base, flex = tp.flex, ph = tp.phase, pe = tp.perp;
      for (var i = 0, n = tp.n; i < n; i++) {
        var f = flex[i];
        if (f < 1e-4) {
          arr[i * 3] = base[i * 3]; arr[i * 3 + 1] = base[i * 3 + 1]; arr[i * 3 + 2] = base[i * 3 + 2];
          continue;
        }
        var s1 = Math.sin(t * 3.1 + ph[i]);
        var s2 = Math.sin(t * 5.7 + ph[i] * 1.7 + 0.9);
        var a = amp * f;
        arr[i * 3] = base[i * 3] + pe[i * 3] * a * (s1 * 0.85 + s2 * 0.25);
        arr[i * 3 + 1] = base[i * 3 + 1] + a * 0.45 * s2;
        arr[i * 3 + 2] = base[i * 3 + 2] + pe[i * 3 + 2] * a * (s1 * 0.85 + s2 * 0.25);
      }
      pos.needsUpdate = true;
    }

    // ---- tumbleweed --------------------------------------------------------
    if (this.B && this.B.weedLive && this.weeds.length) {
      var lb = this.B.weedLive;
      for (var w = 0; w < this.weeds.length; w++) {
        var q = this.weeds[w];
        var g2 = Math.sin(t * 0.73 + q.phase) * Math.sin(t * 0.29 + q.phase * 1.7);
        var rock = g2 * 0.16 * M.clamp(this.windSpeed / 6, 0.3, 1.4);
        _eu.set(rock * 0.7, q.yaw + rock * 0.5, rock, 'YXZ');
        _wq.setFromEuler(_eu);
        _wv.set(q.x + this.windDir.x * rock * 0.10, q.y + Math.abs(rock) * 0.05,
          q.z + this.windDir.y * rock * 0.10);
        lb.mesh.setMatrixAt(w, _m4.compose(_wv, _wq, _vs.set(q.s, q.s, q.s)));
      }
      lb.mesh.instanceMatrix.needsUpdate = true;
    }

    // ---- vent vapour -------------------------------------------------------
    var V = this.vents;
    if (V && this.ventDefs.length) {
      var cam = ctx && ctx.camera;
      if (cam) _wq.copy(cam.quaternion); else _wq.identity();
      var per = V.per;
      var idx = 0;
      for (var d = 0; d < this.ventDefs.length; d++) {
        var vd = this.ventDefs[d];
        for (var k = 0; k < per; k++) {
          var age = ((t * vd.rate + k / per) % 1);
          var rise = age * vd.rise;
          var spread = 0.35 + age * age * 1.5;
          // vapour is carried downwind as it climbs, and slows as it cools
          var drift = age * age * this.windSpeed * 0.42;
          _wv.set(vd.x + this.windDir.x * drift + Math.sin(t * 1.7 + k * 2.1) * 0.10 * age,
            vd.y + rise,
            vd.z + this.windDir.y * drift + Math.cos(t * 1.4 + k * 1.7) * 0.10 * age);
          var sc = vd.size * spread;
          V.mesh.setMatrixAt(idx, _m4.compose(_wv, _wq, _vs.set(sc, sc, sc)));
          // fade in fast, out slow; instanceColor multiplies the basic material
          var al = M.saturate(age * 6.0) * Math.pow(1 - age, 1.5) * 0.55;
          _col.copy(vd.tint).multiplyScalar(al);
          V.mesh.setColorAt(idx, _col);
          idx++;
        }
      }
      V.mesh.instanceMatrix.needsUpdate = true;
      if (V.mesh.instanceColor) V.mesh.instanceColor.needsUpdate = true;
    }
  };

  PropsRefinery.prototype.resize = function () { /* nothing viewport-dependent */ };

  PropsRefinery.prototype.dispose = function () {
    try {
      this.root.traverse(function (o) {
        if (o.geometry && o.geometry.dispose) o.geometry.dispose();
      });
      if (this.root.parent) this.root.parent.remove(this.root);
    } catch (e) { GAME.logError('propsR.dispose', e); }
  };

  GAME.PropsRefinery = PropsRefinery;
})(window.GAME, window.THREE);
