// ============================================================================
// OPERATION BLACKOUT - props, clutter, debris, decal surfaces
// Module owner: agent 7.  Exports GAME.Props.
//
// An empty street reads as a tech demo.  This module is what makes it read as a
// lived-in place that was just fought over: market stalls with striped canopies,
// oil drums, sandbag emplacements, rubble spilling out of a collapsed balcony,
// laundry lines and power cables crossing overhead, weeds in the pavement
// cracks, litter drifted into the gutters.
//
// Design constraints that shaped the code:
//   * < 80 draw calls for ALL props.  Everything repeated goes through
//     THREE.InstancedMesh; everything one-off is merged per material into a
//     handful of static batches.
//   * Nothing floats.  Placement raycasts down against ctx.level, and
//     wall-hugging props probe outward for the real facade instead of trusting
//     a hard-coded x.
//   * Nothing is scattered uniformly.  Debris banks against walls and under
//     damage, litter collects in gutters, sand drifts into corners, brass piles
//     up where somebody actually fired from.
//   * Cloth, foliage and cables move.  A single shared vertex-shader wind
//     snippet (identical source text, so three.js shares the program) drives
//     canopies, laundry, tarps, leaves and catenary cables.
//   * Every cross-module call is guarded.  ctx.level, ctx.textures and
//     ctx.materials may all be missing or broken; we degrade instead of throwing.
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  if (!GAME || !THREE) return;

  var M = GAME.Math;
  var Geo = GAME.Geo;

  // --------------------------------------------------------------------------
  // Scratch objects.  Build-time code runs thousands of placements; allocating
  // a Matrix4 per placement is a measurable chunk of the boot budget.
  // --------------------------------------------------------------------------
  var _m4 = new THREE.Matrix4();
  var _m4b = new THREE.Matrix4();
  var _qt = new THREE.Quaternion();
  var _eu = new THREE.Euler();
  var _vp = new THREE.Vector3();
  var _vs = new THREE.Vector3();
  var _va = new THREE.Vector3();
  var _vb = new THREE.Vector3();
  var _vc = new THREE.Vector3();
  var _vd = new THREE.Vector3();
  var _col = new THREE.Color();
  var _col2 = new THREE.Color();
  var _bmin = new THREE.Vector3();
  var _bmax = new THREE.Vector3();
  var _rayO = new THREE.Vector3();
  var _rayD = new THREE.Vector3(0, -1, 0);

  var UP = new THREE.Vector3(0, 1, 0);
  var SIDE_X = new THREE.Vector3(1, 0, 0);

  // --------------------------------------------------------------------------
  // Instance / material tinting
  //
  // An InstancedMesh colour and a material colour BOTH multiply the albedo map.
  // Writing a real mid-tone hex into either one is fine; writing one into both
  // squares the albedo, and the library material already carries a calibrated
  // gain solved from a measurement of its own map.  A rusty drum authored as
  // "0xc8b7a4 material x 0x8a4a2a instance" therefore renders at roughly a
  // tenth of its intended reflectance - a cut-out silhouette, not an object.
  //
  // So every tint in this file is normalised by its own max channel (the
  // multiplier centres on 1.0) and then pulled back toward white, which turns
  // the hex into a HUE SHIFT rather than a second coat of paint.  Same helper
  // as level.js:tint(), deliberately, so props and level agree.
  // --------------------------------------------------------------------------
  var _tc = new THREE.Color();
  var TINT_S = 0.62;              // per-instance hue strength
  var TINT_M = 0.45;              // material-level hue strength (subtler still)
  function normTint(hex, strength, out) {
    out = out || _tc;
    out.setHex(hex, THREE.SRGBColorSpace);
    var mx = Math.max(out.r, Math.max(out.g, out.b));
    if (!(mx > 1e-4)) mx = 1;
    out.multiplyScalar(1 / mx);
    var s = strength === undefined ? 0.62 : strength;
    out.r = 1 + (out.r - 1) * s;
    out.g = 1 + (out.g - 1) * s;
    out.b = 1 + (out.b - 1) * s;
    return out;
  }

  // --------------------------------------------------------------------------
  // Geometry helpers
  // --------------------------------------------------------------------------

  // Compose a transform without garbage; returns the shared scratch matrix.
  function T(px, py, pz, rx, ry, rz, sx, sy, sz) {
    _eu.set(rx || 0, ry || 0, rz || 0, 'YXZ');
    _qt.setFromEuler(_eu);
    _vp.set(px || 0, py || 0, pz || 0);
    _vs.set(sx === undefined ? 1 : sx, sy === undefined ? 1 : sy, sz === undefined ? 1 : sz);
    return _m4.compose(_vp, _qt, _vs);
  }

  // Same, but returns a fresh matrix (for anything that gets stored).
  function Tn(px, py, pz, rx, ry, rz, sx, sy, sz) {
    return T(px, py, pz, rx, ry, rz, sx, sy, sz).clone();
  }

  // Compose a transform from an explicit orthonormal basis.  An Euler cannot
  // express "lie along this swept curve and point radially outward from it"
  // without gimbal slop, and that is exactly what a barb on a wire coil needs.
  function TB(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
    _m4b.set(ax, bx, cx, px,
             ay, by, cy, py,
             az, bz, cz, pz,
             0, 0, 0, 1);
    return _m4b;
  }

  var _qs = new THREE.Quaternion();
  // Matrix that maps a unit-height, Y-up cylinder/box onto the segment a->b.
  // Used for frames and brackets, where "from here to there" is the natural
  // description and the Euler is not.
  function strut(ax, ay, az, bx, by, bz) {
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

  // Merge a part list into one geometry and dispose the temporaries.
  function mergeParts(parts, uvScale) {
    if (!parts || !parts.length) return null;
    var g = null;
    try {
      g = Geo.mergeAll(parts);
    } catch (e) {
      GAME.logError('props.merge', e);
      return null;
    }
    if (!g) return null;
    if (uvScale) {
      try { Geo.worldUV(g, uvScale); } catch (e) { GAME.logError('props.worldUV', e); }
    }
    Geo.copyUV1(g);
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

  // Displace every vertex by fbm noise.  This is the single cheapest way to
  // stop a primitive reading as a primitive: a box that has been kicked around
  // for ten years does not have four perfectly coplanar faces.
  function roughen(geo, noise, amount, freq, mode) {
    var p = geo.attributes.position;
    if (!p) return geo;
    freq = freq || 3;
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      var n1 = noise.fbm3(x * freq, y * freq, z * freq, 3, 2.1, 0.55);
      if (mode === 'radial') {
        // push in/out along the XZ radius - right for lathes, barrels, sacks
        var r = Math.sqrt(x * x + z * z);
        if (r > 1e-5) {
          var s = 1 + n1 * amount;
          p.setXYZ(i, x * s, y + n1 * amount * 0.25, z * s);
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

  // A convex profile extruded along Z, with fan-triangulated caps.  Used for
  // jersey barriers, kerb blocks, corrugated brackets - anything with a
  // recognisable cross-section.
  function extrudeProfile(pts, depth, uvScale) {
    var n = pts.length, hz = depth * 0.5;
    var pos = [], nrm = [], uv = [];
    var i, a, b;

    function push(px, py, pz, nx, ny, nz, u, v) {
      pos.push(px, py, pz); nrm.push(nx, ny, nz); uv.push(u, v);
    }
    // sides
    for (i = 0; i < n; i++) {
      a = pts[i]; b = pts[(i + 1) % n];
      var dx = b.x - a.x, dy = b.y - a.y;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var nx = dy / len, ny = -dx / len;
      var u0 = 0, u1 = len * (uvScale || 1);
      push(a.x, a.y, -hz, nx, ny, 0, u0, 0);
      push(b.x, b.y, -hz, nx, ny, 0, u1, 0);
      push(b.x, b.y, hz, nx, ny, 0, u1, depth * (uvScale || 1));
      push(a.x, a.y, -hz, nx, ny, 0, u0, 0);
      push(b.x, b.y, hz, nx, ny, 0, u1, depth * (uvScale || 1));
      push(a.x, a.y, hz, nx, ny, 0, u0, depth * (uvScale || 1));
    }
    // caps (fan from vertex 0)
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
  // TubeBuilder - swept tubes with a per-vertex wind-flex attribute.
  // three.js TubeGeometry cannot carry a custom attribute through mergeAll, and
  // overhead cables have to be ONE mesh, so we sweep them ourselves.
  // --------------------------------------------------------------------------
  function TubeBuilder() {
    this.pos = []; this.nrm = []; this.uv = []; this.flex = [];
  }
  TubeBuilder.prototype.addPath = function (points, radius, radial, flexFn, uRepeat) {
    var n = points.length;
    if (n < 2) return;
    radial = radial || 4;
    uRepeat = uRepeat || 1;
    var rings = [];
    var tan = new THREE.Vector3(), nb = new THREE.Vector3(), bi = new THREE.Vector3();
    var i, j;
    for (i = 0; i < n; i++) {
      var pPrev = points[Math.max(0, i - 1)];
      var pNext = points[Math.min(n - 1, i + 1)];
      tan.copy(pNext).sub(pPrev);
      if (tan.lengthSq() < 1e-10) tan.set(0, 0, 1);
      tan.normalize();
      // Pick a reference up-vector that is never parallel to the tangent, so
      // near-vertical drop cables do not produce a degenerate frame.
      var ref = Math.abs(tan.y) > 0.92 ? SIDE_X : UP;
      nb.crossVectors(tan, ref).normalize();
      bi.crossVectors(nb, tan).normalize();
      var r = typeof radius === 'function' ? radius(i / (n - 1)) : radius;
      var ring = [];
      for (j = 0; j <= radial; j++) {
        var a = (j / radial) * Math.PI * 2;
        var ca = Math.cos(a), sa = Math.sin(a);
        var nx = nb.x * ca + bi.x * sa;
        var ny = nb.y * ca + bi.y * sa;
        var nz = nb.z * ca + bi.z * sa;
        ring.push({
          x: points[i].x + nx * r, y: points[i].y + ny * r, z: points[i].z + nz * r,
          nx: nx, ny: ny, nz: nz
        });
      }
      rings.push(ring);
    }
    for (i = 0; i < n - 1; i++) {
      var f0 = flexFn ? flexFn(i / (n - 1)) : 0;
      var f1 = flexFn ? flexFn((i + 1) / (n - 1)) : 0;
      var v0 = (i / (n - 1)) * uRepeat, v1 = ((i + 1) / (n - 1)) * uRepeat;
      for (j = 0; j < radial; j++) {
        var a0 = rings[i][j], a1 = rings[i][j + 1];
        var b0 = rings[i + 1][j], b1 = rings[i + 1][j + 1];
        var u0 = j / radial, u1 = (j + 1) / radial;
        this._tri(a0, b0, b1, f0, f1, f1, v0, v1, v1, u0, u0, u1);
        this._tri(a0, b1, a1, f0, f1, f0, v0, v1, v0, u0, u1, u1);
      }
    }
  };
  TubeBuilder.prototype._tri = function (a, b, c, fa, fb, fc, va, vb, vc, ua, ub, uc) {
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    this.nrm.push(a.nx, a.ny, a.nz, b.nx, b.ny, b.nz, c.nx, c.ny, c.nz);
    this.uv.push(ua, va, ub, vb, uc, vc);
    this.flex.push(fa, fb, fc);
  };
  TubeBuilder.prototype.geometry = function (withFlex) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    if (withFlex) g.setAttribute('aFlex', new THREE.BufferAttribute(new Float32Array(this.flex), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  };
  TubeBuilder.prototype.count = function () { return this.pos.length / 3; };

  // Parabolic approximation of a catenary.  Visually indistinguishable at the
  // sags real cables have, and far cheaper than cosh().
  function sagPoint(a, b, sag, t, out) {
    out.lerpVectors(a, b, t);
    out.y -= sag * 4 * t * (1 - t);
    return out;
  }

  function sagPath(a, b, sag, segments) {
    var pts = [];
    for (var i = 0; i <= segments; i++) {
      pts.push(sagPoint(a, b, sag, i / segments, new THREE.Vector3()));
    }
    return pts;
  }

  // ==========================================================================
  // Procedural texture kit
  //
  // Everything here is drawn with canvas2d + GAME.Noise.  Textures that are
  // props-specific art (canopy stripes, invented signage, leaf cards, ground
  // decals) are ALWAYS generated locally - the shared library cannot know about
  // them.  Generic surfaces (wood, rust, concrete...) come from ctx.textures
  // when it exists, and fall back to a cheap local generator when it does not.
  // ==========================================================================
  var TK = {};

  TK.canvas = function (w, h) {
    if (typeof document === 'undefined') return null;
    var c = document.createElement('canvas');
    c.width = w; c.height = h || w;
    return c;
  };

  TK.tex = function (canvas, srgb, rx, ry, aniso) {
    if (!canvas) return null;
    var t = new THREE.CanvasTexture(canvas);
    // Colour space discipline: albedo is sRGB, everything else is raw data.
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx || 1, ry || rx || 1);
    t.anisotropy = aniso || 8;
    t.needsUpdate = true;
    return t;
  };

  // Build a normal map from a scalar height field (Sobel, wrapping).
  TK.normalFromHeight = function (h, size, strength) {
    var data = new Uint8Array(size * size * 4);
    strength = strength === undefined ? 2.2 : strength;
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

  // Packed ORM: r = AO, g = roughness, b = metalness.  glTF convention, which
  // is what three.js MeshStandardMaterial samples when you assign the same
  // texture to aoMap / roughnessMap / metalnessMap.
  TK.orm = function (size, fn) {
    var data = new Uint8Array(size * size * 4);
    var o = { ao: 1, rough: 0.8, metal: 0 };
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        o.ao = 1; o.rough = 0.8; o.metal = 0;
        fn(x / size, y / size, o, x, y);
        var i = (y * size + x) * 4;
        data[i] = M.saturate(o.ao) * 255;
        data[i + 1] = M.saturate(o.rough) * 255;
        data[i + 2] = M.saturate(o.metal) * 255;
        data[i + 3] = 255;
      }
    }
    var t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    return t;
  };

  // A tileable multi-scale grunge field, reused as a multiply overlay for every
  // locally-generated surface.  Generating one and compositing it is an order
  // of magnitude cheaper than running fbm per pixel per material.
  TK.grungeCanvas = function (size, seed, contrast) {
    var c = TK.canvas(size);
    if (!c) return null;
    var g = c.getContext('2d');
    var img = g.createImageData(size, size);
    var d = img.data;
    var noise = new GAME.Noise(seed);
    var inv = 1 / size;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        // Tileable fbm: sample noise on a torus so the seams match.
        var u = x * inv * Math.PI * 2, v = y * inv * Math.PI * 2;
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

  // Pull the same field back out as a float array so we can build a normal map
  // from it without a second noise pass.
  TK.heightFromCanvas = function (canvas) {
    var g = canvas.getContext('2d');
    var d = g.getImageData(0, 0, canvas.width, canvas.height).data;
    var n = canvas.width * canvas.height;
    var h = new Float32Array(n);
    for (var i = 0; i < n; i++) h[i] = d[i * 4] / 255;
    return h;
  };

  // --------------------------------------------------------------------------
  // Invented script.  Deliberately NOT any real alphabet or logo: connected
  // baseline strokes with random ascenders and diacritic dots, which reads as
  // "signage in a language I do not speak" without impersonating anything.
  // --------------------------------------------------------------------------
  TK.scriptRun = function (g, x, y, size, width, rng, weight) {
    g.lineWidth = Math.max(1, size * (weight || 0.15));
    g.lineCap = 'round';
    g.lineJoin = 'round';
    var cx = x;
    var end = x + width;
    var dots = [];
    g.beginPath();
    g.moveTo(cx, y);
    var guard = 0;
    while (cx < end && guard++ < 60) {
      var w = size * rng.range(0.42, 0.95);
      if (cx + w > end) w = end - cx;
      var mode = rng.int(0, 5);
      if (mode === 0) {
        g.quadraticCurveTo(cx + w * 0.5, y - size * 0.62, cx + w, y);
      } else if (mode === 1) {
        g.lineTo(cx + w * 0.34, y - size * 0.70);
        g.lineTo(cx + w, y);
      } else if (mode === 2) {
        g.quadraticCurveTo(cx + w * 0.5, y + size * 0.42, cx + w, y);
      } else if (mode === 3) {
        g.bezierCurveTo(cx + w * 0.15, y - size * 0.85, cx + w * 0.85, y - size * 0.2, cx + w, y);
      } else if (mode === 4) {
        g.lineTo(cx + w * 0.5, y);
        g.lineTo(cx + w * 0.5, y - size * 0.55);
        g.moveTo(cx + w * 0.5, y);
        g.lineTo(cx + w, y);
      } else {
        g.lineTo(cx + w, y);
      }
      if (rng.bool(0.34)) dots.push([cx + w * 0.5, y - size * (rng.bool(0.6) ? 0.95 : -0.35), size * 0.09]);
      cx += w;
      // small inter-word gap
      if (rng.bool(0.14)) { cx += size * 0.35; g.moveTo(cx, y); }
    }
    g.stroke();
    for (var i = 0; i < dots.length; i++) {
      g.beginPath();
      g.arc(dots[i][0], dots[i][1], dots[i][2], 0, Math.PI * 2);
      g.fill();
    }
  };

  // --------------------------------------------------------------------------
  // Canopy stripe texture.  Real market awnings are two-tone, sun-bleached at
  // the top and filthy along the front edge where hands and rain hit it.
  // --------------------------------------------------------------------------
  TK.stripeCanvas = function (size, baseHex, accentHex, seed, grunge) {
    var c = TK.canvas(size);
    if (!c) return null;
    var g = c.getContext('2d');
    var rng = new GAME.RNG(seed);
    g.fillStyle = baseHex;
    g.fillRect(0, 0, size, size);

    // Vertical stripes of irregular width - hand-sewn, not printed.
    var x = 0;
    var wide = true;
    while (x < size) {
      var w = wide ? size * rng.range(0.085, 0.12) : size * rng.range(0.05, 0.08);
      if (!wide) {
        g.fillStyle = accentHex;
        g.fillRect(Math.round(x), 0, Math.ceil(w), size);
      }
      // a faint seam line at every stripe boundary
      g.fillStyle = 'rgba(0,0,0,0.13)';
      g.fillRect(Math.round(x), 0, 1, size);
      x += w;
      wide = !wide;
    }

    // Sun bleaching: the top of a canopy takes the sun all day.
    var grad = g.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0, 'rgba(255,246,225,0.34)');
    grad.addColorStop(0.45, 'rgba(255,246,225,0.10)');
    grad.addColorStop(1, 'rgba(40,32,24,0.16)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);

    // Dirt streaks running with gravity down the drop of the cloth.
    g.globalAlpha = 0.5;
    for (var i = 0; i < 26; i++) {
      var sx = rng.range(0, size);
      var sw = rng.range(1, 5);
      var sh = rng.range(size * 0.2, size * 0.95);
      g.fillStyle = 'rgba(46,38,28,' + rng.range(0.06, 0.26).toFixed(3) + ')';
      g.fillRect(sx, size - sh, sw, sh);
    }
    // Mildew blooms near the bottom edge.
    for (i = 0; i < 14; i++) {
      var bx = rng.range(0, size), by = rng.range(size * 0.55, size);
      var br = rng.range(size * 0.02, size * 0.09);
      var rg = g.createRadialGradient(bx, by, 0, bx, by, br);
      rg.addColorStop(0, 'rgba(38,36,26,0.34)');
      rg.addColorStop(1, 'rgba(38,36,26,0)');
      g.fillStyle = rg;
      g.beginPath(); g.arc(bx, by, br, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;

    if (grunge) {
      g.globalAlpha = 0.30;
      g.globalCompositeOperation = 'multiply';
      g.drawImage(grunge, 0, 0, size, size);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
    }
    return c;
  };

  // Woven cloth for laundry, tarps and rugs.  This texture maps 0..1 over ONE
  // sheet, so it is a garment layout, not a tiling pattern.
  //
  // The version this replaces drew a warp thread every 3 px and a weft thread
  // every 3 px at a fixed pitch with a bright thread every 6 - a perfectly
  // regular two-tone lattice.  At the size a hung sheet occupies in frame that
  // is a literal GINGHAM CHECKERBOARD, which is on the instant-fail list twice
  // over ("flat single-colour surfaces", "perfectly uniform anything"), and it
  // carried no variation above thread scale at all, so a 2 m tarp was one
  // unbroken value.  What is needed is content in the MIDDLE frequencies: the
  // dye lot, the fade, the dirt line up the hem, a woven stripe.
  //
  // `variant` shifts the palette and stripe layout so several distinct cloths
  // can be generated from one recipe.
  TK.fabricCanvas = function (size, seed, grunge, variant) {
    var c = TK.canvas(size);
    if (!c) return null;
    var g = c.getContext('2d');
    var rng = new GAME.RNG(seed);
    var noise = new GAME.Noise((seed ^ 0x3ab1) >>> 0);
    var i, j, x, y;
    variant = variant || 0;

    // ---- ground ------------------------------------------------------------
    // ALBEDO INVARIANT: sunlit plaster (#d9c3a0, ~0.55 linear) is the brightest
    // diffuse surface on this street, and NOTHING procedural is allowed above
    // it.  These bases used to be #cfc6b6 / #d3c7ad (~0.79 sRGB), which put a
    // hung sheet at 0.342 measured luminance against sunlit plaster at 0.320 -
    // washing that out-values the wall it hangs on, and at night out-values the
    // SKY.  m.paper already carries this discipline in its comment; cloth is
    // twenty times the screen area and never got it.  Unbleached, dusty,
    // hand-washed cotton belongs at 0.30-0.42 albedo.
    var bases = ['#a89e8e', '#9d9689', '#ac9c82', '#989287'];
    g.fillStyle = bases[variant % bases.length];
    g.fillRect(0, 0, size, size);

    // ---- woven stripe bands -------------------------------------------------
    // Cheap market cloth is nearly always banded.  Irregular widths, irregular
    // spacing, soft dye bleed at the edges - the one thing it must not be is
    // evenly spaced, because that is the lattice again.
    var bandCols = [
      ['rgba(120,104,86,0.30)', 'rgba(160,142,116,0.22)'],
      ['rgba(74,96,102,0.26)', 'rgba(150,152,146,0.20)'],
      ['rgba(126,78,62,0.28)', 'rgba(168,140,110,0.20)'],
      ['rgba(96,102,74,0.26)', 'rgba(152,150,120,0.20)']
    ][variant % 4];
    y = rng.range(0.02, 0.16) * size;
    while (y < size) {
      var bh = rng.range(0.012, 0.075) * size;
      var lg = g.createLinearGradient(0, y - bh * 0.35, 0, y + bh * 1.35);
      lg.addColorStop(0, 'rgba(0,0,0,0)');
      lg.addColorStop(0.28, rng.bool(0.62) ? bandCols[0] : bandCols[1]);
      lg.addColorStop(0.72, rng.bool(0.62) ? bandCols[0] : bandCols[1]);
      lg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = lg;
      g.fillRect(0, y - bh * 0.35, size, bh * 1.7);
      y += bh + rng.range(0.05, 0.26) * size;
    }

    // ---- weave -------------------------------------------------------------
    // Jittered pitch and per-thread value.  Slubs (thick threads) every so
    // often, because hand-loomed cloth is not extruded.
    g.globalAlpha = 1;
    var pitch = Math.max(2.2, size / 150);
    for (x = 0; x < size; ) {
      var w = pitch * rng.range(0.62, 1.5);
      var v = rng.range(-24, 20);
      g.fillStyle = 'rgba(' + (134 + v) + ',' + (128 + v) + ',' + (114 + v) + ',' +
        rng.range(0.07, 0.22).toFixed(3) + ')';
      g.fillRect(x, 0, Math.max(0.9, w * 0.55), size);
      x += w;
    }
    for (y = 0; y < size; ) {
      var h2 = pitch * rng.range(0.62, 1.5);
      var v2 = rng.range(-24, 20);
      g.fillStyle = 'rgba(' + (134 + v2) + ',' + (128 + v2) + ',' + (114 + v2) + ',' +
        rng.range(0.07, 0.22).toFixed(3) + ')';
      g.fillRect(0, y, size, Math.max(0.9, h2 * 0.55));
      y += h2;
    }

    // ---- macro dye / fade ---------------------------------------------------
    // The single most important layer: low-frequency multiply so the sheet is
    // never one value.  Drawn as a coarse blocky field and left unsmoothed at
    // this resolution, then relied on for bilinear filtering to soften.
    var mac = TK.canvas(48);
    if (mac) {
      var mg = mac.getContext('2d');
      var mi = mg.createImageData(48, 48);
      for (j = 0; j < 48; j++) {
        for (i = 0; i < 48; i++) {
          var n = noise.fbm2(i * 0.09, j * 0.09, 4, 2.2, 0.55) * 0.5 + 0.5;
          // sun bleaches the exposed upper half; damp collects at the hem
          var vgrad = 1.10 - 0.30 * (j / 47) * (j / 47);
          var val = M.saturate((0.80 + n * 0.42) * vgrad);
          var o = (j * 48 + i) * 4;
          mi.data[o] = val * 255;
          mi.data[o + 1] = val * 252;
          mi.data[o + 2] = val * 246;
          mi.data[o + 3] = 255;
        }
      }
      mg.putImageData(mi, 0, 0);
      g.globalCompositeOperation = 'multiply';
      g.globalAlpha = 0.85;
      g.drawImage(mac, 0, 0, size, size);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
    }

    // ---- wear: stains, mildew, bleached patches ----------------------------
    for (i = 0; i < 26; i++) {
      x = rng.range(0, size);
      y = Math.pow(rng.next(), 0.6) * size;     // biased toward the hem
      var r = rng.range(size * 0.025, size * 0.15);
      var rg = g.createRadialGradient(x, y, 0, x, y, r);
      var kind = rng.next();
      if (kind < 0.5) rg.addColorStop(0, 'rgba(58,50,38,0.34)');
      // A sun-bleached patch is still cloth: it lifts the local value, it does
      // not turn the sheet into paper.  This was rgba(240,236,224) - brighter
      // than sunlit plaster all by itself.
      else if (kind < 0.78) rg.addColorStop(0, 'rgba(204,196,178,0.30)');
      else rg.addColorStop(0, 'rgba(58,66,50,0.28)');   // mildew
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = rg;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    // grime driven up the hem by splashing
    var hg = g.createLinearGradient(0, size, 0, size * 0.78);
    hg.addColorStop(0, 'rgba(58,50,40,0.42)');
    hg.addColorStop(1, 'rgba(58,50,40,0)');
    g.fillStyle = hg;
    g.fillRect(0, size * 0.78, size, size * 0.22);

    // ---- hem, seam and a couple of small tears ------------------------------
    g.strokeStyle = 'rgba(96,86,70,0.34)';
    g.lineWidth = Math.max(1, size * 0.006);
    g.strokeRect(size * 0.022, size * 0.022, size * 0.956, size * 0.956);
    g.strokeStyle = 'rgba(120,110,92,0.22)';
    g.lineWidth = Math.max(1, size * 0.003);
    g.strokeRect(size * 0.045, size * 0.045, size * 0.91, size * 0.91);
    for (i = 0; i < 3; i++) {
      x = rng.range(size * 0.1, size * 0.9);
      y = rng.range(size * 0.45, size * 0.95);
      g.strokeStyle = 'rgba(36,32,26,0.5)';
      g.lineWidth = rng.range(1, 2.6);
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + rng.range(-size * 0.05, size * 0.05), y + rng.range(size * 0.01, size * 0.07));
      g.stroke();
    }

    if (grunge) {
      g.globalAlpha = 0.26;
      g.globalCompositeOperation = 'multiply';
      g.drawImage(grunge, 0, 0, size, size);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
    }
    return c;
  };

  // Painted shop signage: a metal board, invented script, rust bleed, bullet
  // pocks.  Four different boards in a 2x2 atlas so signs never repeat.
  TK.signCanvas = function (size, seed, grunge) {
    var c = TK.canvas(size, size);
    if (!c) return null;
    var g = c.getContext('2d');
    var rng = new GAME.RNG(seed);
    var half = size / 2;
    var plates = ['#2c4a52', '#7a2f24', '#3b4a2c', '#b0a184'];
    var inks = ['#e8e0cc', '#efe7d2', '#e6dcc0', '#22201c'];
    for (var cell = 0; cell < 4; cell++) {
      var ox = (cell % 2) * half, oy = Math.floor(cell / 2) * half;
      g.save();
      g.beginPath(); g.rect(ox, oy, half, half); g.clip();
      g.fillStyle = plates[cell];
      g.fillRect(ox, oy, half, half);
      // panel border
      g.strokeStyle = 'rgba(255,255,255,0.16)';
      g.lineWidth = Math.max(1, half * 0.018);
      g.strokeRect(ox + half * 0.05, oy + half * 0.06, half * 0.9, half * 0.88);
      // script lines
      g.fillStyle = inks[cell];
      g.strokeStyle = inks[cell];
      TK.scriptRun(g, ox + half * 0.10, oy + half * 0.40, half * 0.24, half * 0.80, rng, 0.16);
      TK.scriptRun(g, ox + half * 0.14, oy + half * 0.68, half * 0.15, half * 0.70, rng, 0.17);
      if (rng.bool(0.5)) TK.scriptRun(g, ox + half * 0.12, oy + half * 0.86, half * 0.11, half * 0.62, rng, 0.18);
      // rust bleeding from the fixings
      for (var i = 0; i < 5; i++) {
        var bx = ox + rng.range(half * 0.08, half * 0.92);
        var by = oy + rng.range(half * 0.08, half * 0.5);
        var bl = rng.range(half * 0.1, half * 0.42);
        var lg = g.createLinearGradient(bx, by, bx, by + bl);
        lg.addColorStop(0, 'rgba(126,64,32,0.66)');
        lg.addColorStop(1, 'rgba(126,64,32,0)');
        g.fillStyle = lg;
        g.fillRect(bx - rng.range(1, 3), by, rng.range(2, 5), bl);
        g.fillStyle = 'rgba(30,24,18,0.5)';
        g.beginPath(); g.arc(bx, by, half * 0.012, 0, Math.PI * 2); g.fill();
      }
      // paint loss / bullet pocks
      for (i = 0; i < 26; i++) {
        var px = ox + rng.range(0, half), py = oy + rng.range(0, half);
        var pr = rng.range(half * 0.004, half * 0.02);
        g.fillStyle = 'rgba(120,110,96,' + rng.range(0.25, 0.7).toFixed(2) + ')';
        g.beginPath(); g.arc(px, py, pr, 0, Math.PI * 2); g.fill();
      }
      g.restore();
    }
    if (grunge) {
      g.globalAlpha = 0.36;
      g.globalCompositeOperation = 'multiply';
      g.drawImage(grunge, 0, 0, size, size);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
    }
    return c;
  };

  // Litter: a scrap of newsprint / wrapper, warm off-white, with tiny script.
  TK.paperCanvas = function (size, seed) {
    var c = TK.canvas(size);
    if (!c) return null;
    var g = c.getContext('2d');
    var rng = new GAME.RNG(seed);
    g.fillStyle = '#cdc5b2';
    g.fillRect(0, 0, size, size);
    g.fillStyle = '#3a3630';
    g.strokeStyle = '#3a3630';
    for (var i = 0; i < 9; i++) {
      g.globalAlpha = rng.range(0.35, 0.8);
      TK.scriptRun(g, size * 0.08, size * (0.16 + i * 0.095), size * 0.045, size * 0.84, rng, 0.22);
    }
    g.globalAlpha = 1;
    // grime - litter is never clean
    for (i = 0; i < 20; i++) {
      var x = rng.range(0, size), y = rng.range(0, size), r = rng.range(size * 0.04, size * 0.24);
      var rg = g.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, 'rgba(90,78,58,0.30)');
      rg.addColorStop(1, 'rgba(90,78,58,0)');
      g.fillStyle = rg;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    return c;
  };

  // --------------------------------------------------------------------------
  // Foliage atlas: 2x2 cells of alpha-cut vegetation.
  //   0 broad dry-leaf cluster   1 grass / weed tuft
  //   2 twiggy dead scrub        3 succulent / fleshy leaves
  // Dry Mediterranean palette (#6b7248 base) - not lush green.
  // --------------------------------------------------------------------------
  TK.foliageCanvas = function (size, seed) {
    var c = TK.canvas(size);
    if (!c) return null;
    var g = c.getContext('2d');
    var rng = new GAME.RNG(seed);
    var half = size / 2;
    g.clearRect(0, 0, size, size);

    function leaf(cx, cy, len, wid, ang, fill, vein) {
      g.save();
      g.translate(cx, cy);
      g.rotate(ang);
      g.beginPath();
      g.moveTo(0, 0);
      g.quadraticCurveTo(wid, -len * 0.42, 0, -len);
      g.quadraticCurveTo(-wid, -len * 0.42, 0, 0);
      g.fillStyle = fill;
      g.fill();
      if (vein) {
        g.strokeStyle = vein;
        g.lineWidth = Math.max(0.7, len * 0.022);
        g.beginPath(); g.moveTo(0, -len * 0.04); g.lineTo(0, -len * 0.94); g.stroke();
        for (var k = 1; k < 5; k++) {
          var t = k / 5;
          g.beginPath();
          g.moveTo(0, -len * t);
          g.lineTo(wid * (1 - t) * 0.8, -len * (t + 0.13));
          g.moveTo(0, -len * t);
          g.lineTo(-wid * (1 - t) * 0.8, -len * (t + 0.13));
          g.stroke();
        }
      }
      g.restore();
    }

    function blade(cx, cy, len, wid, ang, bend, fill) {
      g.save();
      g.translate(cx, cy);
      g.rotate(ang);
      g.beginPath();
      g.moveTo(-wid, 0);
      g.quadraticCurveTo(bend * 0.6, -len * 0.55, bend, -len);
      g.quadraticCurveTo(bend * 0.6 + wid * 0.5, -len * 0.5, wid, 0);
      g.closePath();
      g.fillStyle = fill;
      g.fill();
      g.restore();
    }

    function shade(base, k) {
      _col.setStyle(base, THREE.SRGBColorSpace);
      _col.multiplyScalar(k);
      return '#' + _col.getHexString(THREE.SRGBColorSpace);
    }

    var greens = ['#6b7248', '#7d8352', '#59613c', '#8a8355', '#4e5636'];

    // cell 0 - broad dry leaves
    g.save(); g.beginPath(); g.rect(0, 0, half, half); g.clip();
    for (var i = 0; i < 26; i++) {
      var base = rng.pick(greens);
      leaf(rng.range(half * 0.12, half * 0.88), rng.range(half * 0.55, half * 1.0),
        rng.range(half * 0.22, half * 0.46), rng.range(half * 0.05, half * 0.12),
        rng.range(-1.25, 1.25), shade(base, rng.range(0.75, 1.2)), shade(base, 0.6));
    }
    g.restore();

    // cell 1 - grass / weed tuft
    g.save(); g.beginPath(); g.rect(half, 0, half, half); g.clip();
    for (i = 0; i < 62; i++) {
      var bx = half + rng.range(half * 0.16, half * 0.84);
      blade(bx, half * 0.99, rng.range(half * 0.28, half * 0.86), rng.range(1.2, 3.0),
        rng.range(-0.5, 0.5), rng.range(-half * 0.2, half * 0.2),
        shade(rng.pick(['#8a8355', '#9a8f5c', '#6f7145', '#b0a06a']), rng.range(0.7, 1.25)));
    }
    // a few seed heads
    for (i = 0; i < 9; i++) {
      var sx = half + rng.range(half * 0.2, half * 0.8), sy = rng.range(half * 0.1, half * 0.45);
      g.fillStyle = shade('#b8a874', rng.range(0.8, 1.1));
      g.beginPath(); g.ellipse(sx, sy, rng.range(1.5, 3), rng.range(5, 11), rng.range(-0.4, 0.4), 0, Math.PI * 2); g.fill();
    }
    g.restore();

    // cell 2 - dead twiggy scrub
    g.save(); g.beginPath(); g.rect(0, half, half, half); g.clip();
    g.lineCap = 'round';
    for (i = 0; i < 40; i++) {
      var ox = rng.range(half * 0.2, half * 0.8), oy = half * 1.98;
      g.strokeStyle = shade(rng.pick(['#6b5540', '#7d6448', '#54452f']), rng.range(0.75, 1.2));
      g.lineWidth = rng.range(0.9, 2.6);
      var px = ox, py = oy, a = -Math.PI / 2 + rng.range(-0.7, 0.7);
      g.beginPath(); g.moveTo(px, py);
      for (var s = 0; s < 4; s++) {
        var l = rng.range(half * 0.08, half * 0.22);
        a += rng.range(-0.5, 0.5);
        px += Math.cos(a) * l; py += Math.sin(a) * l;
        g.lineTo(px, py);
      }
      g.stroke();
    }
    for (i = 0; i < 22; i++) {
      leaf(rng.range(half * 0.15, half * 0.85), half + rng.range(half * 0.2, half * 0.95),
        rng.range(half * 0.06, half * 0.16), rng.range(half * 0.02, half * 0.05),
        rng.range(-1.5, 1.5), shade('#7a7448', rng.range(0.7, 1.15)), null);
    }
    g.restore();

    // cell 3 - fleshy / succulent leaves (potted plants, courtyard greenery)
    g.save(); g.beginPath(); g.rect(half, half, half, half); g.clip();
    for (i = 0; i < 20; i++) {
      leaf(half + rng.range(half * 0.18, half * 0.82), half + rng.range(half * 0.6, half * 1.0),
        rng.range(half * 0.26, half * 0.5), rng.range(half * 0.09, half * 0.17),
        rng.range(-1.1, 1.1), shade(rng.pick(['#5d7a48', '#6e8a52', '#48603a']), rng.range(0.8, 1.2)),
        shade('#3d5230', 1));
    }
    g.restore();

    // Nibble the alpha edges so leaves are not perfect vector shapes.
    var img = g.getImageData(0, 0, size, size);
    var d = img.data;
    var noise = new GAME.Noise(seed ^ 0x51);
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var idx = (y * size + x) * 4;
        if (d[idx + 3] === 0) continue;
        var n = noise.fbm2(x * 0.13, y * 0.13, 3, 2.2, 0.5);
        // darken toward leaf interiors for fake self-shadowing
        var k = 1 + n * 0.28;
        d[idx] = M.clamp(d[idx] * k, 0, 255);
        d[idx + 1] = M.clamp(d[idx + 1] * k, 0, 255);
        d[idx + 2] = M.clamp(d[idx + 2] * k, 0, 255);
        if (d[idx + 3] > 200 && n < -0.34) d[idx + 3] = 0;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  };

  // A single pinnate palm frond, drawn tip-right so the card can be bent.
  // Leaflets are FILLED tapered shapes, not strokes: alpha testing is binary,
  // and thin antialiased strokes vanish under it, leaving a black spiky mess.
  TK.frondCanvas = function (w, h, seed) {
    var c = TK.canvas(w, h);
    if (!c) return null;
    var g = c.getContext('2d');
    var rng = new GAME.RNG(seed);
    g.clearRect(0, 0, w, h);
    var midY = h * 0.5;

    function leaflet(x, y, len, wid, dir, tint) {
      g.beginPath();
      g.moveTo(x, y - wid * 0.5);
      g.quadraticCurveTo(x + len * 0.45, y + dir * len * 0.18 - wid * 0.15,
        x + len * 0.92, y + dir * len * 0.86);
      g.quadraticCurveTo(x + len * 0.5, y + dir * len * 0.22 + wid * 0.55,
        x, y + wid * 0.5);
      g.closePath();
      g.fillStyle = tint;
      g.fill();
    }

    var n = 46;
    var i, t, s;
    // Two passes: a dense dark underlayer, then a lighter overlayer, so the
    // frond has internal value variation instead of reading as one flat shape.
    for (var pass = 0; pass < 2; pass++) {
      for (i = 0; i < n; i++) {
        t = i / (n - 1);
        var x = w * (0.03 + t * 0.94);
        var y = midY + h * 0.05 - t * h * 0.08 + Math.sin(t * 3.1) * h * 0.02;
        var len = h * (0.46 * Math.sin(Math.PI * Math.pow(t, 0.72)) + 0.07) * rng.range(0.86, 1.14);
        var wid = h * rng.range(0.055, 0.095) * (pass ? 0.72 : 1);
        var tint = pass
          ? rng.pick(['#8b9752', '#96a05c', '#7d8a48'])
          : rng.pick(['#5c6836', '#66703c', '#4e5a30']);
        for (s = -1; s <= 1; s += 2) leaflet(x, y, len * (pass ? 0.9 : 1), wid, s, tint);
      }
    }
    // rachis on top
    g.strokeStyle = '#8a8450';
    g.lineWidth = h * 0.05;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(w * 0.02, midY + h * 0.05);
    g.quadraticCurveTo(w * 0.55, midY - h * 0.05, w * 0.985, midY - h * 0.03);
    g.stroke();
    // a few dead brown leaflets - a palm always has some
    for (i = 0; i < 12; i++) {
      t = rng.next();
      leaflet(w * (0.05 + t * 0.9), midY + rng.range(-h * 0.04, h * 0.04),
        h * rng.range(0.18, 0.36), h * 0.06, rng.sign(), 'rgba(128,100,56,0.95)');
    }
    return c;
  };

  // --------------------------------------------------------------------------
  // Ground decal atlas (2x2): oil stain, scorch, dust splat, grime/water.
  // Ground stains are one of the highest-value-per-byte realism cues there is.
  // --------------------------------------------------------------------------
  TK.decalCanvas = function (size, seed) {
    var c = TK.canvas(size);
    if (!c) return null;
    var g = c.getContext('2d');
    var rng = new GAME.RNG(seed);
    var half = size / 2;
    var noise = new GAME.Noise(seed ^ 0x77);
    g.clearRect(0, 0, size, size);

    function blob(cx, cy, r, lobes, jag, fill) {
      g.beginPath();
      var steps = 64;
      for (var i = 0; i <= steps; i++) {
        var a = (i / steps) * Math.PI * 2;
        var rr = r * (1 + noise.fbm2(Math.cos(a) * lobes + cx * 0.01, Math.sin(a) * lobes + cy * 0.01, 3, 2.2, 0.5) * jag);
        var x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath();
      g.fillStyle = fill;
      g.fill();
    }

    // cell 0 (0,0) - oil / fluid stain
    g.save(); g.beginPath(); g.rect(0, 0, half, half); g.clip();
    blob(half * 0.5, half * 0.5, half * 0.36, 1.7, 0.34, 'rgba(16,13,11,0.86)');
    blob(half * 0.52, half * 0.52, half * 0.28, 2.4, 0.42, 'rgba(8,7,6,0.95)');
    for (var i = 0; i < 16; i++) {
      blob(half * rng.range(0.15, 0.85), half * rng.range(0.15, 0.85), half * rng.range(0.02, 0.07),
        2.5, 0.5, 'rgba(12,10,9,' + rng.range(0.4, 0.9).toFixed(2) + ')');
    }
    // slight iridescent rim - fresh oil is not matte black
    g.globalCompositeOperation = 'lighter';
    blob(half * 0.5, half * 0.5, half * 0.33, 1.7, 0.34, 'rgba(40,28,52,0.16)');
    g.globalCompositeOperation = 'source-over';
    g.restore();

    // cell 1 (1,0) - scorch / blast mark
    g.save(); g.beginPath(); g.rect(half, 0, half, half); g.clip();
    var scx = half * 1.5, scy = half * 0.5;
    var rg = g.createRadialGradient(scx, scy, 0, scx, scy, half * 0.46);
    rg.addColorStop(0, 'rgba(10,9,8,0.94)');
    rg.addColorStop(0.42, 'rgba(24,20,17,0.72)');
    rg.addColorStop(0.78, 'rgba(46,38,31,0.30)');
    rg.addColorStop(1, 'rgba(60,50,40,0)');
    g.fillStyle = rg;
    g.fillRect(half, 0, half, half);
    // radial soot streaks thrown out by the blast
    for (i = 0; i < 46; i++) {
      var a = rng.range(0, Math.PI * 2);
      var l = half * rng.range(0.16, 0.48);
      g.strokeStyle = 'rgba(14,12,10,' + rng.range(0.15, 0.6).toFixed(2) + ')';
      g.lineWidth = rng.range(0.8, 4.5);
      g.beginPath();
      g.moveTo(scx + Math.cos(a) * half * 0.06, scy + Math.sin(a) * half * 0.06);
      g.lineTo(scx + Math.cos(a) * l, scy + Math.sin(a) * l);
      g.stroke();
    }
    g.restore();

    // cell 2 (0,1) - warm dust / pulverised-concrete splat
    g.save(); g.beginPath(); g.rect(0, half, half, half); g.clip();
    for (i = 0; i < 9; i++) {
      var dx = half * rng.range(0.25, 0.75), dy = half + half * rng.range(0.25, 0.75);
      var dr = half * rng.range(0.12, 0.36);
      var dg = g.createRadialGradient(dx, dy, 0, dx, dy, dr);
      dg.addColorStop(0, 'rgba(206,187,152,' + rng.range(0.28, 0.55).toFixed(2) + ')');
      dg.addColorStop(1, 'rgba(206,187,152,0)');
      g.fillStyle = dg;
      g.beginPath(); g.arc(dx, dy, dr, 0, Math.PI * 2); g.fill();
    }
    // grit speckle
    for (i = 0; i < 240; i++) {
      g.fillStyle = 'rgba(150,136,110,' + rng.range(0.1, 0.5).toFixed(2) + ')';
      g.fillRect(rng.range(0, half), half + rng.range(0, half), rng.range(0.7, 2.4), rng.range(0.7, 2.4));
    }
    g.restore();

    // cell 3 (1,1) - grime / damp patch, also reused stretched for tyre tracks
    g.save(); g.beginPath(); g.rect(half, half, half, half); g.clip();
    var gg = g.createLinearGradient(half, half, half * 2, half * 2);
    gg.addColorStop(0, 'rgba(38,36,33,0.0)');
    gg.addColorStop(0.5, 'rgba(30,29,27,0.55)');
    gg.addColorStop(1, 'rgba(38,36,33,0.0)');
    g.fillStyle = gg;
    g.fillRect(half, half, half, half);
    blob(half * 1.5, half * 1.5, half * 0.38, 1.4, 0.3, 'rgba(28,28,27,0.5)');
    blob(half * 1.48, half * 1.52, half * 0.24, 2.2, 0.45, 'rgba(20,21,22,0.62)');
    for (i = 0; i < 30; i++) {
      blob(half + half * rng.range(0.1, 0.9), half + half * rng.range(0.1, 0.9),
        half * rng.range(0.015, 0.06), 2.5, 0.5, 'rgba(24,24,24,' + rng.range(0.2, 0.55).toFixed(2) + ')');
    }
    g.restore();

    // Soften every cell edge to zero alpha so quads never show a hard border.
    var img = g.getImageData(0, 0, size, size);
    var d = img.data;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var lx = (x % half) / half, ly = (y % half) / half;
        var fade = M.smoothstep(0, 0.11, lx) * M.smoothstep(0, 0.11, 1 - lx) *
                   M.smoothstep(0, 0.11, ly) * M.smoothstep(0, 0.11, 1 - ly);
        var idx = (y * size + x) * 4;
        d[idx + 3] *= fade;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  };

  // --------------------------------------------------------------------------
  // Fallback surfaces.  Only built if ctx.textures is missing or throws, so the
  // props still read as materials rather than as flat vertex colours.  Cheap by
  // design: one shared grunge field tinted and modulated per surface.
  // --------------------------------------------------------------------------
  TK.surfaceCanvas = function (size, grunge, spec, seed) {
    var c = TK.canvas(size);
    if (!c) return null;
    var g = c.getContext('2d');
    var rng = new GAME.RNG(seed);
    g.fillStyle = spec.base;
    g.fillRect(0, 0, size, size);

    if (spec.planks) {
      // wood: boards with varying tone plus grain lines
      var y = 0;
      while (y < size) {
        var h = size * rng.range(0.11, 0.2);
        _col.setStyle(spec.base, THREE.SRGBColorSpace);
        _col.multiplyScalar(rng.range(0.78, 1.22));
        g.fillStyle = '#' + _col.getHexString(THREE.SRGBColorSpace);
        g.fillRect(0, y, size, h);
        g.strokeStyle = 'rgba(0,0,0,0.32)';
        g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(0, y); g.lineTo(size, y); g.stroke();
        // grain
        for (var k = 0; k < 22; k++) {
          g.strokeStyle = 'rgba(30,22,14,' + rng.range(0.04, 0.16).toFixed(3) + ')';
          g.lineWidth = rng.range(0.6, 2.2);
          var gy = y + rng.range(0, h);
          g.beginPath();
          g.moveTo(0, gy);
          g.bezierCurveTo(size * 0.33, gy + rng.range(-4, 4), size * 0.66, gy + rng.range(-4, 4), size, gy + rng.range(-3, 3));
          g.stroke();
        }
        y += h;
      }
    }
    if (spec.corrode) {
      // rust: irregular orange-brown blooms eating through the base
      for (var i = 0; i < 46; i++) {
        var x = rng.range(0, size), yy = rng.range(0, size);
        var r = rng.range(size * 0.02, size * 0.16);
        var rg = g.createRadialGradient(x, yy, 0, x, yy, r);
        var tone = rng.pick(['138,74,42', '112,56,30', '160,96,50', '86,48,30']);
        rg.addColorStop(0, 'rgba(' + tone + ',' + rng.range(0.5, 0.95).toFixed(2) + ')');
        rg.addColorStop(0.6, 'rgba(' + tone + ',0.35)');
        rg.addColorStop(1, 'rgba(' + tone + ',0)');
        g.fillStyle = rg;
        g.beginPath(); g.arc(x, yy, r, 0, Math.PI * 2); g.fill();
      }
      // weep streaks running downhill from the worst blooms
      for (i = 0; i < 20; i++) {
        var sx = rng.range(0, size), sy = rng.range(0, size * 0.7);
        var sl = rng.range(size * 0.08, size * 0.4);
        var lg = g.createLinearGradient(sx, sy, sx, sy + sl);
        lg.addColorStop(0, 'rgba(122,60,32,0.55)');
        lg.addColorStop(1, 'rgba(122,60,32,0)');
        g.fillStyle = lg;
        g.fillRect(sx, sy, rng.range(1.5, 5), sl);
      }
    }
    if (spec.speck) {
      for (i = 0; i < 900; i++) {
        g.fillStyle = 'rgba(' + spec.speck + ',' + rng.range(0.05, 0.35).toFixed(2) + ')';
        g.fillRect(rng.range(0, size), rng.range(0, size), rng.range(0.8, 3.2), rng.range(0.8, 3.2));
      }
    }
    if (spec.scuff) {
      for (i = 0; i < 60; i++) {
        g.strokeStyle = 'rgba(' + spec.scuff + ',' + rng.range(0.06, 0.3).toFixed(2) + ')';
        g.lineWidth = rng.range(0.6, 2.4);
        var ax = rng.range(0, size), ay = rng.range(0, size), aa = rng.range(0, Math.PI * 2);
        var al = rng.range(size * 0.03, size * 0.28);
        g.beginPath();
        g.moveTo(ax, ay);
        g.lineTo(ax + Math.cos(aa) * al, ay + Math.sin(aa) * al);
        g.stroke();
      }
    }
    if (grunge) {
      g.globalAlpha = spec.grungeAmount === undefined ? 0.42 : spec.grungeAmount;
      g.globalCompositeOperation = 'multiply';
      g.drawImage(grunge, 0, 0, size, size);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
    }
    return c;
  };

  // ==========================================================================
  // Wind
  //
  // ONE snippet, injected identically into every wind material.  three.js keys
  // its program cache on onBeforeCompile.toString(), so keeping the source text
  // byte-identical means all of these share a single compiled program and the
  // per-material variation lives entirely in uniforms.
  //
  // It also has to compile inside MeshDepthMaterial (for shadows), whose vertex
  // shader has no objectNormal - hence no normal-space billow term.
  // ==========================================================================
  var WIND_PARS = [
    'uniform float uTime;',
    'uniform vec4 uWind;',
    'attribute float aFlex;'
  ].join('\n');

  var WIND_BODY = [
    'vec3 wOrg = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;',
    '#ifdef USE_INSTANCING',
    'wOrg = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;',
    '#endif',
    // wOrg + local position: for an instanced prop this gives a ripple that
    // travels across the cloth; for a merged world-space mesh (cables) wOrg is
    // zero and the term degenerates to the world position, which is what we
    // want there.  Same code, both cases.
    'vec3 wpp = wOrg + transformed;',
    'float gust = 0.60 + 0.40 * sin( uTime * 0.37 + wpp.x * 0.055 + wpp.z * 0.041 );',
    'gust *= 0.84 + 0.16 * sin( uTime * 0.131 + wpp.z * 0.021 - wpp.x * 0.017 );',
    'float ph = uTime * uWind.y + ( wpp.x * 0.31 + wpp.z * 0.23 ) * uWind.w;',
    'float s1 = sin( ph );',
    'float s2 = sin( ph * 2.31 + 1.7 );',
    'float s3 = sin( ph * 4.70 + wpp.y * 5.3 + wpp.x * 1.9 );',
    'float amp = uWind.x * aFlex * gust;',
    'transformed.x += amp * ( s1 * 0.86 + s2 * 0.21 );',
    'transformed.z += amp * ( s2 * 0.58 - s1 * 0.17 );',
    'transformed.y += amp * uWind.z * ( s3 * 0.50 - 0.22 );'
  ].join('\n');

  function windCompile(shader) {
    /* jshint validthis:true */
    shader.uniforms.uTime = this.userData.uTime;
    shader.uniforms.uWind = this.userData.uWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + WIND_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + WIND_BODY);
  }

  // Attach the wind snippet to a material.  amp = metres of travel at aFlex=1,
  // freq = rad/s, billow = vertical flutter scale, spatial = phase gradient
  // (higher means neighbouring props are more out of sync).
  function applyWind(mat, timeUniform, amp, freq, billow, spatial) {
    if (!mat) return mat;
    mat.userData.uTime = timeUniform;
    mat.userData.uWind = { value: new THREE.Vector4(amp, freq, billow, spatial) };
    // bind() keeps the source text identical across every call site
    mat.onBeforeCompile = windCompile.bind(mat);
    mat.customProgramCacheKey = windCacheKey;
    mat.needsUpdate = true;
    return mat;
  }

  // bind() makes toString() return "function () { [native code] }" for every
  // bound copy, which would still collide correctly - but be explicit so the
  // intent survives a refactor.
  function windCacheKey() { return 'props-wind'; }

  // Give an alpha-tested / cloth mesh a depth material that runs the SAME wind,
  // otherwise the shadow stays rigid while the cloth moves - a very obvious tell.
  function windDepth(timeUniform, windUniform, map, alphaTest, side) {
    var d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    if (map) { d.map = map; d.alphaTest = alphaTest || 0.5; }
    d.side = side || THREE.FrontSide;
    d.userData.uTime = timeUniform;
    d.userData.uWind = windUniform;
    d.onBeforeCompile = windCompile.bind(d);
    d.customProgramCacheKey = windCacheKey;
    return d;
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
  // Batch - a thin wrapper over InstancedMesh that counts up as you place.
  // ==========================================================================
  function Batch(geo, mat, max, castShadow) {
    this.mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, max));
    this.mesh.count = 0;
    this.mesh.castShadow = !!castShadow;
    this.mesh.receiveShadow = true;
    this.mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.n = 0;
    this.max = Math.max(1, max);
  }
  Batch.prototype.add = function (matrix, color) {
    if (this.n >= this.max) return false;
    this.mesh.setMatrixAt(this.n, matrix);
    // Always set a colour: instanceColor is allocated lazily and leaving an
    // entry unwritten risks a black instance depending on three's fill policy.
    this.mesh.setColorAt(this.n, color || WHITE);
    this.n++;
    return true;
  };
  Batch.prototype.place = function (x, y, z, yaw, pitch, roll, sx, sy, sz, color) {
    return this.add(T(x, y, z, pitch || 0, yaw || 0, roll || 0, sx, sy, sz), color);
  };
  Batch.prototype.finish = function (parent) {
    if (this.n === 0) {
      this.mesh.dispose();
      return null;
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    if (typeof this.mesh.computeBoundingSphere === 'function') {
      try { this.mesh.computeBoundingSphere(); } catch (e) { /* older three */ }
    }
    parent.add(this.mesh);
    return this.mesh;
  };
  var WHITE = new THREE.Color(1, 1, 1);

  // ==========================================================================
  // Geometry kit
  //
  // Every builder returns a geometry whose origin is at the BASE CENTRE of the
  // prop (y = 0 is the ground contact) so placement is just "put it at the
  // ground height".  Silhouette detail is the priority: ribs, slats, handles,
  // brackets - the things that read at 20 metres in a screenshot.
  // ==========================================================================
  var K = {};

  function box(w, h, d, bevel) { return Geo.bevelBox(w, h, d, bevel === undefined ? 0.008 : bevel); }
  function cyl(rt, rb, h, seg, open) {
    return new THREE.CylinderGeometry(rt, rb, h, seg || 12, 1, !!open);
  }

  // ---- industrial ----------------------------------------------------------

  K.drum = function (noise) {
    var R = 0.285, H = 0.88;
    var p = [];
    function v(r, y) { p.push(new THREE.Vector2(Math.max(0.0008, r), y)); }
    v(0.0008, 0); v(R * 0.84, 0); v(R * 0.96, 0.025); v(R * 0.96, 0.055);
    v(R * 0.92, 0.085); v(R * 0.92, 0.27); v(R * 1.005, 0.305); v(R * 1.005, 0.355);
    v(R * 0.92, 0.39); v(R * 0.92, 0.52); v(R * 1.005, 0.555); v(R * 1.005, 0.605);
    v(R * 0.92, 0.64); v(R * 0.92, 0.80); v(R * 0.96, 0.83); v(R * 0.96, 0.858);
    v(R * 0.84, H); v(0.0008, H);
    var g = new THREE.LatheGeometry(p, 15);
    // Dents: every drum in a war zone has been dropped at least once.
    roughen(g, noise, 0.022, 2.6, 'radial');
    var parts = [part(g, null)];
    // bung plugs on the lid
    parts.push(part(cyl(0.045, 0.045, 0.022, 8), Tn(0.13, H + 0.006, 0.05)));
    parts.push(part(cyl(0.028, 0.028, 0.018, 8), Tn(-0.11, H + 0.005, -0.08)));
    var out = mergeParts(parts, 1.4);
    return out || g;
  };

  K.jerryCan = function () {
    var parts = [];
    var W = 0.34, H = 0.46, D = 0.17;
    parts.push(part(box(W, H * 0.92, D, 0.022), Tn(0, H * 0.46, 0)));
    // the classic recessed X-braces on both faces
    for (var s = -1; s <= 1; s += 2) {
      parts.push(part(box(W * 0.92, 0.035, 0.012, 0.004), Tn(0, H * 0.5, s * (D * 0.5 + 0.004), 0, 0, 0.62)));
      parts.push(part(box(W * 0.92, 0.035, 0.012, 0.004), Tn(0, H * 0.5, s * (D * 0.5 + 0.004), 0, 0, -0.62)));
    }
    // shoulder, three-bar handle, spout
    parts.push(part(box(W * 0.97, 0.05, D * 0.97, 0.02), Tn(0, H * 0.90, 0)));
    for (var i = -1; i <= 1; i++) {
      parts.push(part(box(0.05, 0.045, D * 0.86, 0.012), Tn(i * 0.098, H * 0.955, 0)));
    }
    parts.push(part(box(W * 0.97, 0.05, 0.05, 0.014), Tn(0, H * 0.955, -D * 0.42)));
    parts.push(part(box(W * 0.97, 0.05, 0.05, 0.014), Tn(0, H * 0.955, D * 0.42)));
    parts.push(part(cyl(0.036, 0.04, 0.05, 10), Tn(W * 0.30, H * 1.0, 0)));
    return mergeParts(parts, 1.6);
  };

  K.gasCylinder = function () {
    var R = 0.155, H = 0.66;
    var p = [];
    function v(r, y) { p.push(new THREE.Vector2(Math.max(0.0008, r), y)); }
    v(0.0008, 0); v(R * 0.9, 0); v(R, 0.035); v(R, 0.055); v(R * 0.94, 0.075);
    v(R * 0.94, H * 0.78); v(R * 0.86, H * 0.88); v(R * 0.6, H * 0.965);
    v(R * 0.3, H * 1.0); v(R * 0.22, H * 1.02); v(0.0008, H * 1.02);
    var g = new THREE.LatheGeometry(p, 14);
    var parts = [part(g, null)];
    // valve + protective collar
    parts.push(part(cyl(0.028, 0.032, 0.075, 8), Tn(0, H * 1.05, 0)));
    parts.push(part(cyl(0.016, 0.016, 0.05, 6), Tn(0.035, H * 1.08, 0, 0, 0, Math.PI / 2)));
    parts.push(part(cyl(0.072, 0.072, 0.1, 12, true), Tn(0, H * 1.06, 0)));
    return mergeParts(parts, 1.6);
  };

  K.pallet = function () {
    var parts = [];
    var X = 1.2, Z = 0.8;
    var i;
    // bottom deck boards (3, running along Z)
    for (i = -1; i <= 1; i++) parts.push(part(box(0.125, 0.021, Z, 0.004), Tn(i * (X * 0.5 - 0.062), 0.011, 0)));
    // stringers (3, running along X)
    for (i = -1; i <= 1; i++) parts.push(part(box(X, 0.09, 0.1, 0.005), Tn(0, 0.067, i * (Z * 0.5 - 0.05))));
    // top deck (7 boards along Z with gaps)
    for (i = 0; i < 7; i++) {
      var t = i / 6;
      parts.push(part(box(0.128, 0.022, Z, 0.004), Tn(-X * 0.5 + 0.064 + t * (X - 0.128), 0.123, 0)));
    }
    return mergeParts(parts, 1.5);
  };

  K.spool = function () {
    // A wooden cable drum lying on its side, so the cheeks face +/-Z and the
    // whole thing rests on its rim at y = R.
    var body = [];
    var R = 0.62, W = 0.72;
    var i, s;
    body.push(part(cyl(R, R, 0.055, 20), Tn(0, R, W * 0.5, Math.PI / 2, 0, 0)));
    body.push(part(cyl(R, R, 0.055, 20), Tn(0, R, -W * 0.5, Math.PI / 2, 0, 0)));
    body.push(part(cyl(0.22, 0.22, W, 14), Tn(0, R, 0, Math.PI / 2, 0, 0)));
    // the wound cable itself, sitting proud of the hub
    body.push(part(cyl(0.5, 0.5, W * 0.82, 18), Tn(0, R, 0, Math.PI / 2, 0, 0)));
    for (s = -1; s <= 1; s += 2) {
      for (i = 0; i < 8; i++) {
        var a = (i / 8) * Math.PI * 2;
        body.push(part(box(R * 0.86, 0.024, 0.085, 0.005),
          Tn(Math.cos(a) * R * 0.5, R + Math.sin(a) * R * 0.5, s * (W * 0.5 + 0.04), 0, 0, a)));
      }
    }
    return mergeParts(body, 1.1);
  };

  K.toolbox = function () {
    var parts = [];
    parts.push(part(box(0.46, 0.19, 0.22, 0.012), Tn(0, 0.095, 0)));
    parts.push(part(box(0.47, 0.055, 0.23, 0.012), Tn(0, 0.215, 0)));
    parts.push(part(box(0.13, 0.018, 0.028, 0.005), Tn(0, 0.262, 0)));
    parts.push(part(box(0.018, 0.038, 0.026, 0.005), Tn(-0.062, 0.244, 0)));
    parts.push(part(box(0.018, 0.038, 0.026, 0.005), Tn(0.062, 0.244, 0)));
    // latches
    parts.push(part(box(0.03, 0.05, 0.014, 0.004), Tn(-0.15, 0.185, 0.115)));
    parts.push(part(box(0.03, 0.05, 0.014, 0.004), Tn(0.15, 0.185, 0.115)));
    return mergeParts(parts, 2.0);
  };

  // ---- market --------------------------------------------------------------

  // Slatted produce crate.  Three silhouette families share this builder: a
  // regular one, a taller narrow one and a broken one with slats missing and a
  // stove-in corner.  A single crate geometry repeated forty times across a
  // hero framing is the loudest copy-paste tell in the whole set dressing, and
  // no amount of position jitter hides an identical outline.
  function crateGeo(W, H, D, rows, missing) {
    var parts = [];
    var post = 0.042;
    var i, sx, sz, k = 0;
    for (sx = -1; sx <= 1; sx += 2) {
      for (sz = -1; sz <= 1; sz += 2) {
        // one corner post snapped short on the broken variant
        var ph = (missing && sx < 0 && sz < 0) ? H * 0.55 : H;
        parts.push(part(box(post, ph, post, 0.004),
          Tn(sx * (W * 0.5 - post * 0.5), ph * 0.5, sz * (D * 0.5 - post * 0.5))));
      }
    }
    var pitch = (H - 0.10) / Math.max(1, rows - 1);
    for (i = 0; i < rows; i++) {
      var y = 0.06 + i * pitch;
      var gone = missing ? ((i === rows - 1) || (i === 1)) : false;
      if (!gone) {
        parts.push(part(box(W, 0.072, 0.016, 0.003), Tn(0, y, D * 0.5 - 0.008)));
      } else if (missing && i === 1) {
        // half a slat left hanging off one end
        parts.push(part(box(W * 0.42, 0.072, 0.016, 0.003),
          Tn(-W * 0.24, y - 0.012, D * 0.5 - 0.008, 0, 0, 0.22)));
      }
      parts.push(part(box(W, 0.072, 0.016, 0.003), Tn(0, y, -D * 0.5 + 0.008)));
      parts.push(part(box(0.016, 0.072, D - post * 2, 0.003), Tn(W * 0.5 - 0.008, y, 0)));
      if (!(missing && i === rows - 1)) {
        parts.push(part(box(0.016, 0.072, D - post * 2, 0.003), Tn(-W * 0.5 + 0.008, y, 0)));
      }
      k++;
    }
    // floor boards
    for (i = -1; i <= 1; i++) {
      parts.push(part(box(W - 0.02, 0.016, D * 0.3, 0.003), Tn(0, 0.014, i * D * 0.33)));
    }
    return mergeParts(parts, 2.2);
  }

  K.crate = function () { return crateGeo(0.52, 0.34, 0.36, 3, false); };
  K.crateTall = function () { return crateGeo(0.40, 0.47, 0.31, 4, false); };
  K.crateBroken = function () { return crateGeo(0.55, 0.32, 0.38, 3, true); };

  K.ammoCrate = function () {
    var parts = [];
    var W = 0.76, H = 0.29, D = 0.36;
    parts.push(part(box(W, H, D, 0.014), Tn(0, H * 0.5, 0)));
    parts.push(part(box(W * 1.02, 0.05, D * 1.02, 0.012), Tn(0, H + 0.025, 0)));
    // corner reinforcement straps
    for (var sx = -1; sx <= 1; sx += 2) {
      parts.push(part(box(0.035, H * 1.05, D * 1.02, 0.006), Tn(sx * (W * 0.5 - 0.03), H * 0.5, 0)));
      parts.push(part(box(0.055, 0.045, D * 1.03, 0.006), Tn(sx * (W * 0.5 - 0.03), H + 0.02, 0)));
      // rope handle
      parts.push(part(cyl(0.014, 0.014, 0.19, 6), Tn(sx * (W * 0.5 + 0.012), H * 0.62, 0, 0, 0, Math.PI / 2)));
      parts.push(part(cyl(0.012, 0.012, 0.07, 6), Tn(sx * (W * 0.5 + 0.006), H * 0.62 + 0.05, 0.08)));
      parts.push(part(cyl(0.012, 0.012, 0.07, 6), Tn(sx * (W * 0.5 + 0.006), H * 0.62 + 0.05, -0.08)));
    }
    // latches
    parts.push(part(box(0.07, 0.055, 0.02, 0.005), Tn(-0.18, H + 0.01, D * 0.5 + 0.006)));
    parts.push(part(box(0.07, 0.055, 0.02, 0.005), Tn(0.18, H + 0.01, D * 0.5 + 0.006)));
    // stencil-plate boss (no readable text - just a raised blank plate)
    parts.push(part(box(0.24, 0.1, 0.006, 0.003), Tn(0, H * 0.55, D * 0.5 + 0.004)));
    return mergeParts(parts, 1.8);
  };

  K.sack = function (noise) {
    var p = [];
    function v(r, y) { p.push(new THREE.Vector2(Math.max(0.0008, r), y)); }
    v(0.0008, 0); v(0.17, 0.005); v(0.205, 0.06); v(0.215, 0.18);
    v(0.208, 0.32); v(0.185, 0.44); v(0.13, 0.52); v(0.06, 0.555);
    v(0.045, 0.58); v(0.075, 0.63); v(0.055, 0.66); v(0.0008, 0.665);
    var g = new THREE.LatheGeometry(p, 13);
    roughen(g, noise, 0.03, 3.4, 'radial');
    return g;
  };

  // A filled hessian bag under the weight of the ones above it.  The old
  // version was a lightly-dented ellipsoid, which read as a brick; a real bag
  // is fatter at the tied ends, slumps over whatever it is resting on, and has
  // a flat load-bearing top face where the next course sits on it.
  //
  // The previous version squashed a sphere on Y.  Squashing a sphere leaves the
  // equator at full radius with zero flattening, so the silhouette is a LENS
  // with a sharp rim at both ends - which is exactly how it read in frame: a
  // wall of clam shells / pitta bread, not filled sacks.
  //
  // A filled bag is a rounded BOX: flat-ish load-bearing top and bottom (the
  // course above compresses it), rounded vertical sides, tied and pinched at
  // the ends, fattest across the middle where the fill has nowhere to go.  That
  // is a superellipsoid, which you get for free by re-normalising a unit sphere
  // direction under an L^p norm (p=2 sphere, p->inf cube, p=3.1 rounded box).
  K.sandbag = function (noise, seed) {
    var g = new THREE.SphereGeometry(0.5, 16, 10);
    var pos = g.attributes.position;
    var n2 = new GAME.Noise(seed === undefined ? 0x5A9 : seed);
    var i, x, y, z, ax, az;
    for (i = 0; i < pos.count; i++) {
      // unit direction (the source sphere has radius 0.5)
      x = pos.getX(i) * 2; y = pos.getY(i) * 2; z = pos.getZ(i) * 2;
      ax = Math.abs(x); az = Math.abs(z);
      var ay = Math.abs(y);
      // L^p re-normalisation.  p is higher in Y than in the horizontal plane so
      // the load-bearing faces flatten harder than the sides do.
      var pw = 3.7;
      var s = Math.pow(Math.pow(ax, pw) + Math.pow(ay, pw * 1.35) + Math.pow(az, pw),
        -1 / pw);
      x *= s; y *= s; z *= s;
      ax = Math.abs(x); az = Math.abs(z);
      // Fill bulge: the unconstrained middle is fatter than the tied ends.
      // Kept small - overdo it and the superellipsoid turns back into a lens.
      var mid = (1 - ax * ax) * (1 - az * az * 0.55);
      y *= 1 + mid * 0.11;
      z *= 1 + (1 - ax * ax) * 0.09;
      // Tied ends: only the last 12% is gathered, and only a little.
      var pinch = 1 - 0.15 * M.smoothstep(0.88, 1.0, ax);
      y *= pinch; z *= pinch;
      // It sags over whatever it is resting on, and the top is never level.
      var sag = mid * 0.07 * (1 + n2.perlin3(x * 3, z * 3, 0) * 0.7);
      y -= sag * (y < 0 ? -0.35 : 1.0);
      pos.setXYZ(i, x, y, z);
    }
    pos.needsUpdate = true;
    // Lumps of aggregate pushing against the weave.  Two octaves: a few big
    // bulges plus a finer grain, so the surface is never a smooth clay blob.
    roughen(g, noise, 0.055, 2.2);
    roughen(g, noise, 0.022, 7.5);
    g.computeVertexNormals();
    g.scale(0.200, 0.088, 0.131);
    g.translate(0, 0.086, 0);
    return g;
  };

  K.chair = function () {
    // monobloc plastic garden chair - the single most universal street object
    var parts = [];
    var SH = 0.44;
    parts.push(part(box(0.42, 0.032, 0.40, 0.014), Tn(0, SH, 0)));
    parts.push(part(box(0.40, 0.44, 0.028, 0.012), Tn(0, SH + 0.24, -0.19, 0.16, 0, 0)));
    parts.push(part(box(0.40, 0.05, 0.032, 0.012), Tn(0, SH + 0.47, -0.255)));
    // splayed tapered legs
    var lx = 0.175, lz = 0.165;
    for (var sx = -1; sx <= 1; sx += 2) {
      for (var sz = -1; sz <= 1; sz += 2) {
        parts.push(part(cyl(0.019, 0.026, SH, 6),
          Tn(sx * lx * 1.12, SH * 0.5, sz * lz * 1.12, sz * 0.055, 0, -sx * 0.055)));
      }
      // arm rests
      parts.push(part(box(0.035, 0.026, 0.30, 0.008), Tn(sx * 0.208, SH + 0.20, -0.04)));
      parts.push(part(box(0.032, 0.20, 0.03, 0.008), Tn(sx * 0.208, SH + 0.10, 0.10)));
    }
    // apron rails
    parts.push(part(box(0.40, 0.026, 0.024, 0.006), Tn(0, SH - 0.055, 0.18)));
    parts.push(part(box(0.024, 0.026, 0.36, 0.006), Tn(-0.19, SH - 0.055, 0)));
    parts.push(part(box(0.024, 0.026, 0.36, 0.006), Tn(0.19, SH - 0.055, 0)));
    return mergeParts(parts, 2.4);
  };

  K.stallFrame = function () {
    var parts = [];
    var W = 2.5, D = 1.15, H = 2.28;
    var post = 0.072;
    for (var sx = -1; sx <= 1; sx += 2) {
      for (var sz = -1; sz <= 1; sz += 2) {
        var h = sz > 0 ? H : H + 0.18;   // back posts taller so the canopy sheds
        parts.push(part(box(post, h, post, 0.006),
          Tn(sx * (W * 0.5 - post), h * 0.5, sz * (D * 0.5 - post * 0.5))));
      }
      // diagonal brace
      parts.push(part(box(0.045, 1.5, 0.045, 0.004),
        Tn(sx * (W * 0.5 - post), 0.86, 0, 0.62, 0, 0)));
    }
    // head rails
    parts.push(part(box(W - post, 0.06, 0.055, 0.005), Tn(0, H - 0.05, D * 0.5 - post * 0.5)));
    parts.push(part(box(W - post, 0.06, 0.055, 0.005), Tn(0, H + 0.13, -(D * 0.5 - post * 0.5))));
    parts.push(part(box(0.05, 0.05, D, 0.005), Tn(-(W * 0.5 - post), H + 0.05, 0, -0.14, 0, 0)));
    parts.push(part(box(0.05, 0.05, D, 0.005), Tn((W * 0.5 - post), H + 0.05, 0, -0.14, 0, 0)));
    // counter top and lower shelf
    parts.push(part(box(W, 0.05, D * 0.86, 0.008), Tn(0, 0.87, 0.04)));
    parts.push(part(box(W * 0.96, 0.035, D * 0.7, 0.006), Tn(0, 0.34, 0.02)));
    // front fascia board
    parts.push(part(box(W, 0.24, 0.03, 0.006), Tn(0, 0.74, D * 0.44)));
    // hanging rail under the head rail, for scales / bags
    parts.push(part(cyl(0.016, 0.016, W * 0.9, 8), Tn(0, H - 0.18, 0.1, 0, 0, Math.PI / 2)));
    return mergeParts(parts, 1.4);
  };

  // Sagging awning cloth.  Local frame: x across the shop front, z from the
  // wall (0) out to the street edge; y is a drop from the wall attachment.
  K.canopy = function () {
    var nx = 11, nz = 6, W = 2.7, D = 1.75;
    var pos = [], nrm = [], uv = [], idx = [];
    var i, j;
    for (j = 0; j <= nz; j++) {
      var tz = j / nz;
      for (i = 0; i <= nx; i++) {
        var tx = i / nx;
        var x = (tx - 0.5) * W;
        var z = tz * D;
        // slope out to the street, plus a sag that is deepest mid-span
        var y = -tz * 0.42 - Math.sin(Math.PI * tx) * Math.sin(Math.PI * tz * 0.85) * 0.155;
        // scalloped front edge
        if (j === nz) y -= 0.03 + Math.sin(tx * Math.PI * 5) * 0.02;
        pos.push(x, y, z);
        nrm.push(0, 1, 0);
        uv.push(tx * 1.6, tz);
      }
    }
    // valance hanging off the front edge
    var base = (nz + 1) * (nx + 1);
    for (j = 0; j <= 1; j++) {
      for (i = 0; i <= nx; i++) {
        var tx2 = i / nx;
        var x2 = (tx2 - 0.5) * W;
        var drop = j === 0 ? 0 : 0.24 + Math.sin(tx2 * Math.PI * 5) * 0.035;
        var y2 = -D * 0 - 0.42 - Math.sin(Math.PI * tx2) * Math.sin(Math.PI * 0.85) * 0.155 - drop;
        if (j === 0) y2 -= 0.03 + Math.sin(tx2 * Math.PI * 5) * 0.02;
        pos.push(x2, y2, D + 0.005);
        nrm.push(0, 0, 1);
        uv.push(tx2 * 1.6, 1 + j * 0.22);
      }
    }
    for (j = 0; j < nz; j++) {
      for (i = 0; i < nx; i++) {
        var a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    for (i = 0; i < nx; i++) {
      var a2 = base + i, b2 = a2 + 1, c2 = a2 + nx + 1, d2 = c2 + 1;
      idx.push(a2, c2, b2, b2, c2, d2);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    // pinned at the wall (z=0), free at the street edge and freest on the valance
    setFlex(g, function (x, y, z) {
      var t = M.saturate(z / D);
      return t * t * (z > D ? 1.5 : 1.0) + (y < -0.5 ? 0.45 : 0);
    });
    g.computeBoundingSphere();
    return g;
  };

  // Corrugated metal shop awning (rigid, above the cloth canopies).
  K.awning = function () {
    var parts = [];
    var W = 3.0, D = 1.35, n = 30;
    var pos = [], nrm = [], uv = [], idx = [];
    for (var j = 0; j <= 1; j++) {
      for (var i = 0; i <= n; i++) {
        var tx = i / n;
        var ripple = Math.sin(tx * Math.PI * 2 * 11) * 0.022;
        pos.push((tx - 0.5) * W, ripple - j * 0.30, j * D);
        nrm.push(0, 1, 0);
        uv.push(tx * 3.2, j * 1.2);
      }
    }
    for (i = 0; i < n; i++) {
      var a = i, b = i + 1, c = i + n + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    var sheet = new THREE.BufferGeometry();
    sheet.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    sheet.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
    sheet.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    sheet.setIndex(idx);
    sheet.computeVertexNormals();
    parts.push(part(sheet, null));
    // support brackets back to the wall
    for (var s = -1; s <= 1; s += 2) {
      parts.push(part(box(0.04, 0.04, D, 0.005), Tn(s * W * 0.42, -0.14, D * 0.5, -0.22, 0, 0)));
      parts.push(part(box(0.035, 0.5, 0.035, 0.004), Tn(s * W * 0.42, -0.22, 0.06, 0, 0, 0.42)));
    }
    parts.push(part(box(W, 0.05, 0.05, 0.006), Tn(0, -0.30, D)));
    return mergeParts(parts, 1.6);
  };

  K.cart = function () {
    var parts = [];
    var W = 1.5, D = 0.95, BEDY = 0.62;
    parts.push(part(box(W, 0.06, D, 0.008), Tn(0, BEDY, 0)));
    for (var s = -1; s <= 1; s += 2) {
      parts.push(part(box(W, 0.24, 0.035, 0.006), Tn(0, BEDY + 0.14, s * D * 0.5)));
      parts.push(part(box(0.035, 0.24, D, 0.006), Tn(s * W * 0.5, BEDY + 0.14, 0)));
      // wheels
      parts.push(part(cyl(0.31, 0.31, 0.075, 16), Tn(s * (W * 0.5 + 0.05), 0.31, 0, 0, 0, Math.PI / 2)));
      parts.push(part(cyl(0.075, 0.075, 0.1, 8), Tn(s * (W * 0.5 + 0.05), 0.31, 0, 0, 0, Math.PI / 2)));
      for (var k = 0; k < 6; k++) {
        var a = (k / 6) * Math.PI;
        parts.push(part(box(0.028, 0.58, 0.028, 0.004),
          Tn(s * (W * 0.5 + 0.05), 0.31, 0, 0, 0, a)));
      }
      // frame rails and handles
      parts.push(part(box(0.05, 0.05, D * 1.9, 0.006), Tn(s * W * 0.36, BEDY - 0.06, D * 0.45, -0.06, 0, 0)));
    }
    parts.push(part(box(W * 0.72, 0.045, 0.045, 0.006), Tn(0, BEDY - 0.16, D * 1.36)));
    parts.push(part(box(0.06, 0.42, 0.06, 0.006), Tn(0, 0.2, -D * 0.35, 0.3, 0, 0)));
    return mergeParts(parts, 1.5);
  };

  K.hangingScale = function () {
    var parts = [];
    parts.push(part(cyl(0.012, 0.012, 0.3, 6), Tn(0, -0.15, 0)));
    parts.push(part(cyl(0.11, 0.11, 0.055, 14), Tn(0, -0.33, 0, Math.PI / 2, 0, 0)));
    parts.push(part(cyl(0.02, 0.02, 0.16, 6), Tn(0, -0.44, 0)));
    for (var s = -1; s <= 1; s += 2) {
      parts.push(part(cyl(0.005, 0.005, 0.26, 4), Tn(s * 0.11, -0.60, 0, 0, 0, s * 0.4)));
    }
    parts.push(part(cyl(0.16, 0.17, 0.05, 14, true), Tn(0, -0.74, 0)));
    parts.push(part(cyl(0.16, 0.16, 0.008, 14), Tn(0, -0.762, 0)));
    return mergeParts(parts, 2.5);
  };

  // ---- street furniture ----------------------------------------------------

  K.bollard = function () {
    var parts = [];
    parts.push(part(cyl(0.075, 0.10, 0.86, 12), Tn(0, 0.43, 0)));
    parts.push(part(new THREE.SphereGeometry(0.075, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.5), Tn(0, 0.86, 0)));
    parts.push(part(cyl(0.135, 0.15, 0.07, 12), Tn(0, 0.035, 0)));
    parts.push(part(cyl(0.082, 0.082, 0.055, 12), Tn(0, 0.70, 0)));
    return mergeParts(parts, 1.8);
  };

  K.bin = function () {
    var parts = [];
    parts.push(part(cyl(0.28, 0.21, 0.66, 14), Tn(0, 0.33, 0)));
    parts.push(part(cyl(0.295, 0.295, 0.05, 14), Tn(0, 0.665, 0)));
    parts.push(part(cyl(0.30, 0.30, 0.03, 14), Tn(0, 0.70, 0)));
    for (var i = 0; i < 8; i++) {
      var a = (i / 8) * Math.PI * 2;
      parts.push(part(box(0.02, 0.6, 0.03, 0.004),
        Tn(Math.cos(a) * 0.25, 0.34, Math.sin(a) * 0.25, 0, a, 0)));
    }
    return mergeParts(parts, 1.8);
  };

  K.streetLamp = function () {
    var parts = [];
    var H = 5.4;
    parts.push(part(cyl(0.06, 0.11, H, 10), Tn(0, H * 0.5, 0)));
    parts.push(part(cyl(0.17, 0.19, 0.16, 12), Tn(0, 0.08, 0)));
    parts.push(part(box(0.26, 0.34, 0.24, 0.01), Tn(0, 0.62, 0)));   // access hatch
    // swan-neck arm, built from short segments so it actually curves
    var seg = 7, reach = 1.5;
    for (var i = 0; i < seg; i++) {
      var t0 = i / seg, t1 = (i + 1) / seg;
      var a0 = t0 * Math.PI * 0.5, a1 = t1 * Math.PI * 0.5;
      var x0 = Math.sin(a0) * reach, y0 = H + (1 - Math.cos(a0)) * 0.62;
      var x1 = Math.sin(a1) * reach, y1 = H + (1 - Math.cos(a1)) * 0.62;
      var dx = x1 - x0, dy = y1 - y0;
      var len = Math.sqrt(dx * dx + dy * dy);
      parts.push(part(cyl(0.045, 0.05, len * 1.12, 8),
        Tn((x0 + x1) * 0.5, (y0 + y1) * 0.5, 0, 0, 0, -Math.atan2(dx, dy))));
    }
    // luminaire
    parts.push(part(box(0.6, 0.13, 0.28, 0.02), Tn(reach + 0.16, H + 0.58, 0, 0, 0, 0.1)));
    parts.push(part(box(0.5, 0.05, 0.22, 0.01), Tn(reach + 0.16, H + 0.50, 0, 0, 0, 0.1)));
    return mergeParts(parts, 1.2);
  };

  K.signPanel = function () {
    // slightly bowed sheet so it catches a highlight instead of reading flat
    var g = new THREE.PlaneGeometry(1.25, 0.44, 6, 2);
    var p = g.attributes.position;
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i);
      p.setZ(i, Math.cos((x / 0.625) * 0.9) * 0.018 - 0.018);
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  };

  K.signBracket = function () {
    var parts = [];
    parts.push(part(box(0.05, 0.05, 0.42, 0.006), Tn(0, 0.22, -0.21)));
    parts.push(part(box(0.05, 0.44, 0.05, 0.006), Tn(0, 0.22, 0)));
    parts.push(part(box(0.04, 0.04, 0.34, 0.005), Tn(0, 0.05, -0.17, 0.55, 0, 0)));
    parts.push(part(box(0.12, 0.16, 0.02, 0.004), Tn(0, 0.22, -0.41)));
    return mergeParts(parts, 2.2);
  };

  K.junctionBox = function () {
    var parts = [];
    parts.push(part(box(0.44, 0.62, 0.19, 0.012), Tn(0, 0, 0)));
    parts.push(part(box(0.40, 0.56, 0.03, 0.008), Tn(0, 0, 0.105)));
    parts.push(part(box(0.46, 0.05, 0.22, 0.008), Tn(0, 0.33, 0.01)));  // drip cap
    parts.push(part(cyl(0.028, 0.028, 0.5, 8), Tn(-0.14, -0.55, 0.02)));
    parts.push(part(cyl(0.028, 0.028, 0.5, 8), Tn(0.10, -0.55, 0.02)));
    parts.push(part(box(0.06, 0.09, 0.02, 0.004), Tn(0.16, -0.05, 0.12)));
    return mergeParts(parts, 2.0);
  };

  K.acUnit = function () {
    var parts = [];
    var W = 0.78, H = 0.58, D = 0.32;
    parts.push(part(box(W, H, D, 0.014), Tn(0, 0, 0)));
    parts.push(part(box(W * 0.98, 0.04, D * 0.98, 0.008), Tn(0, H * 0.5, 0)));
    // louvre slats on the outward face
    for (var i = 0; i < 6; i++) {
      parts.push(part(box(W * 0.82, 0.05, 0.03, 0.004),
        Tn(0, H * 0.36 - i * 0.09, D * 0.5 + 0.01, -0.5, 0, 0)));
    }
    // fan bezel + spokes
    parts.push(part(cyl(0.22, 0.22, 0.03, 16, true), Tn(0, -0.04, D * 0.5 + 0.02, Math.PI / 2, 0, 0)));
    for (i = 0; i < 4; i++) {
      parts.push(part(box(0.4, 0.016, 0.016, 0.003),
        Tn(0, -0.04, D * 0.5 + 0.025, 0, 0, (i / 4) * Math.PI)));
    }
    // wall brackets and condensate pipe
    for (var s = -1; s <= 1; s += 2) {
      parts.push(part(box(0.05, 0.06, D + 0.16, 0.006), Tn(s * W * 0.4, -H * 0.42, -0.08)));
      parts.push(part(box(0.045, 0.34, 0.045, 0.005), Tn(s * W * 0.4, -H * 0.32, -D * 0.5 - 0.06, 0.7, 0, 0)));
    }
    parts.push(part(cyl(0.016, 0.016, 0.6, 6), Tn(W * 0.3, -H * 0.5 - 0.28, -D * 0.3)));
    return mergeParts(parts, 1.8);
  };

  K.satDish = function () {
    var parts = [];
    // offset parabola
    var p = [];
    for (var i = 0; i <= 7; i++) {
      var r = (i / 7) * 0.44;
      p.push(new THREE.Vector2(Math.max(0.0008, r), (r * r) / 0.92));
    }
    p.push(new THREE.Vector2(0.445, (0.44 * 0.44) / 0.92 + 0.03));
    p.push(new THREE.Vector2(0.43, (0.44 * 0.44) / 0.92 + 0.032));
    for (i = 7; i >= 0; i--) {
      var r2 = (i / 7) * 0.43;
      p.push(new THREE.Vector2(Math.max(0.0008, r2), (r2 * r2) / 0.92 + 0.022));
    }
    var dish = new THREE.LatheGeometry(p, 20);
    parts.push(part(dish, Tn(0, 0.9, 0, -1.15, 0, 0)));
    // LNB arm + head
    parts.push(part(cyl(0.016, 0.016, 0.55, 6), Tn(0, 0.72, 0.3, -0.5, 0, 0)));
    parts.push(part(cyl(0.035, 0.045, 0.14, 8), Tn(0, 0.6, 0.55, 1.0, 0, 0)));
    // mast
    parts.push(part(cyl(0.032, 0.032, 0.92, 8), Tn(0, 0.46, -0.03)));
    parts.push(part(box(0.24, 0.03, 0.24, 0.006), Tn(0, 0.015, -0.03)));
    parts.push(part(box(0.07, 0.14, 0.07, 0.006), Tn(0, 0.86, -0.03)));
    return mergeParts(parts, 1.8);
  };

  K.aerial = function () {
    var parts = [];
    parts.push(part(cyl(0.02, 0.026, 1.9, 6), Tn(0, 0.95, 0)));
    parts.push(part(box(0.16, 0.05, 0.16, 0.006), Tn(0, 0.03, 0)));
    // yagi elements, shortening toward the top
    for (var i = 0; i < 8; i++) {
      var y = 0.85 + i * 0.13;
      var len = 1.15 - i * 0.09;
      parts.push(part(cyl(0.007, 0.007, len, 4), Tn(0, y, 0, 0, 0, Math.PI / 2)));
    }
    // reflector cage at the bottom of the boom
    for (i = 0; i < 5; i++) {
      parts.push(part(cyl(0.006, 0.006, 0.62, 4), Tn(0, 0.72 + i * 0.035, -0.13, 0, 0, Math.PI / 2)));
    }
    return mergeParts(parts, 2.0);
  };

  K.planter = function () {
    var p = [];
    p.push(new THREE.Vector2(0.0008, 0));
    p.push(new THREE.Vector2(0.155, 0));
    p.push(new THREE.Vector2(0.16, 0.02));
    p.push(new THREE.Vector2(0.225, 0.28));
    p.push(new THREE.Vector2(0.235, 0.31));
    p.push(new THREE.Vector2(0.245, 0.325));
    p.push(new THREE.Vector2(0.245, 0.35));
    p.push(new THREE.Vector2(0.215, 0.35));
    p.push(new THREE.Vector2(0.205, 0.30));
    p.push(new THREE.Vector2(0.0008, 0.28));   // soil surface
    return new THREE.LatheGeometry(p, 14);
  };

  // ---- military ------------------------------------------------------------

  K.jerseyBarrier = function () {
    // The real profile: wide splayed foot, kink at 380mm, near-vertical top.
    var pts = [
      new THREE.Vector2(-0.305, 0), new THREE.Vector2(0.305, 0),
      new THREE.Vector2(0.305, 0.075), new THREE.Vector2(0.185, 0.33),
      new THREE.Vector2(0.115, 0.81), new THREE.Vector2(0.10, 0.83),
      new THREE.Vector2(-0.10, 0.83), new THREE.Vector2(-0.115, 0.81),
      new THREE.Vector2(-0.185, 0.33), new THREE.Vector2(-0.305, 0.075)
    ];
    var g = extrudeProfile(pts, 2.4, 1);
    var parts = [part(g, null)];
    // lifting eyes
    parts.push(part(cyl(0.03, 0.03, 0.12, 6), Tn(0, 0.86, 0.5)));
    parts.push(part(cyl(0.03, 0.03, 0.12, 6), Tn(0, 0.86, -0.5)));
    return mergeParts(parts, 0.9);
  };

  K.checkpointArm = function () {
    var parts = [];
    parts.push(part(box(0.34, 1.05, 0.34, 0.012), Tn(0, 0.52, 0)));
    parts.push(part(box(0.5, 0.08, 0.5, 0.01), Tn(0, 0.04, 0)));
    parts.push(part(cyl(0.05, 0.05, 0.3, 8), Tn(0, 1.05, 0, 0, 0, Math.PI / 2)));
    // the boom itself, slightly raised
    parts.push(part(cyl(0.055, 0.055, 4.4, 8), Tn(2.05, 1.32, 0, 0, 0, Math.PI / 2 - 0.12)));
    parts.push(part(box(0.12, 0.5, 0.12, 0.008), Tn(-0.42, 0.9, 0)));   // counterweight
    parts.push(part(cyl(0.02, 0.02, 0.9, 6), Tn(4.2, 0.82, 0)));        // drop leg
    return mergeParts(parts, 1.4);
  };

  // ---- debris --------------------------------------------------------------

  // Fractured masonry.  At 2x1x2 segments the fbm displacement could only move
  // the eight corners, so every face stayed planar and every arris stayed
  // straight: thirty of these in a pile read as spilled Lego.  Three octaves
  // over a finer cage is what turns a box into a broken lump.
  K.rubbleChunk = function (noise, seed) {
    var g = new THREE.BoxGeometry(0.92, 0.30, 0.68, 3, 2, 3);
    var n2 = new GAME.Noise(seed);
    roughen(g, n2, 0.085, 2.2);
    roughen(g, n2, 0.032, 6.4);
    roughen(g, n2, 0.012, 17.0);
    // shear one end so it reads as a fracture rather than a rounded pebble
    var p = g.attributes.position;
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i);
      if (x > 0.2) p.setY(i, p.getY(i) * 0.55 + noise.perlin3(x * 4, p.getY(i) * 4, p.getZ(i) * 4) * 0.05);
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    g.translate(0, 0.15, 0);
    Geo.worldUV(g, 1.4);
    Geo.copyUV1(g);
    return g;
  };

  K.rebar = function () {
    var tb = new TubeBuilder();
    var pts = [];
    var n = 7;
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      // bent and kinked, the way rebar looks when it has been torn out of slab
      pts.push(new THREE.Vector3(
        Math.sin(t * 3.1) * 0.09 + t * 0.06,
        t * 0.86,
        Math.sin(t * 5.3 + 1.1) * 0.055));
    }
    tb.addPath(pts, 0.0095, 5, null, 6);
    return tb.geometry(false);
  };

  // A brick out of a collapsed wall, not off a pallet.  The bevelled box this
  // replaces had four crisp 90-degree arrises and read as new stock tipped out
  // of a lorry; what makes rubble read as rubble is that every arris is
  // chipped and every face carries a skin of broken mortar.  Kept as ONE
  // geometry - the placement pass squashes it on X to produce snapped halves,
  // which is cheaper than a second batch and gives the same silhouette family.
  K.brick = function (noise) {
    var g = new THREE.BoxGeometry(0.215, 0.062, 0.102, 3, 2, 2);
    if (noise) {
      roughen(g, noise, 0.0075, 26);      // mortar skin / chipped arrises
      roughen(g, noise, 0.0035, 74);      // frog and surface pitting
    }
    return g;
  };

  K.pebble = function (noise, seed) {
    var g = new THREE.IcosahedronGeometry(0.5, 0);
    roughen(g, new GAME.Noise(seed), 0.17, 2.6);
    g.scale(0.09, 0.055, 0.075);
    g.translate(0, 0.026, 0);
    return g;
  };

  K.glassShard = function (rng) {
    // a thin irregular sliver, double-sided at render time
    var pos = [], nrm = [], uv = [];
    var a = [0, 0], b = [rng.range(0.05, 0.16), rng.range(-0.05, 0.05)];
    var c = [rng.range(0.02, 0.12), rng.range(0.06, 0.17)];
    function push(p) { pos.push(p[0], 0, p[1]); nrm.push(0, 1, 0); uv.push(p[0] * 6, p[1] * 6); }
    push(a); push(b); push(c);
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    g.computeBoundingSphere();
    return g;
  };

  K.casing = function () {
    // 5.56x45: 45mm long, 9.6mm rim.  Small, but they catch the low sun and
    // that glint around a firing position is worth the triangles.
    var p = [];
    p.push(new THREE.Vector2(0.0008, 0));
    p.push(new THREE.Vector2(0.0048, 0));
    p.push(new THREE.Vector2(0.0048, 0.004));
    p.push(new THREE.Vector2(0.0040, 0.006));
    p.push(new THREE.Vector2(0.0046, 0.010));
    p.push(new THREE.Vector2(0.0046, 0.030));
    p.push(new THREE.Vector2(0.0030, 0.038));
    p.push(new THREE.Vector2(0.0029, 0.045));
    p.push(new THREE.Vector2(0.0022, 0.045));
    p.push(new THREE.Vector2(0.0023, 0.038));
    p.push(new THREE.Vector2(0.0008, 0.030));
    var g = new THREE.LatheGeometry(p, 8);
    // lay it on its side; brass never lands standing up
    g.rotateZ(Math.PI / 2);
    g.translate(0, 0.005, 0);
    return g;
  };

  // A dropped sheet of newsprint / torn cardboard.  A flat quad is the single
  // worst-value primitive on a street: it presents one normal, so the whole
  // scrap flares at once and reads as confetti.  Two fold lines split it into
  // three near-planar facets pitched against each other, so at any sun angle
  // one facet is lit, one is half-lit and one is in its own shade - which is
  // what makes litter read as paper rather than as painted specks.
  K.paperScrap = function (rng) {
    var w = rng.range(0.14, 0.25), h = rng.range(0.17, 0.30);
    var g = new THREE.PlaneGeometry(w, h, 2, 2).toNonIndexed();
    var p = g.attributes.position;
    var f1 = rng.range(-0.26, 0.26) * h;      // fold across the sheet
    var f2 = rng.range(-0.26, 0.26) * w;      // fold along it
    var a1 = Math.tan(rng.range(0.10, 0.15));
    var a2 = Math.tan(rng.range(0.09, 0.14));
    var s1 = rng.bool() ? 1 : -1, s2 = rng.bool() ? 1 : -1;
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i);
      var z = Math.abs(y - f1) * a1 * (y > f1 ? s1 : -s1 * 0.72)
            + Math.abs(x - f2) * a2 * (x > f2 ? s2 : -s2 * 0.65);
      // Torn edge.  Derived from the vertex position, never from the rng:
      // the geometry is non-indexed, so coincident corners must agree or the
      // sheet splits open along its own seams.
      var ex = (Math.abs(x) > w * 0.4) ? (Math.sin(y * 61.3 + 1.7) * 0.008 - 0.004) * (x > 0 ? 1 : -1) : 0;
      var ey = (Math.abs(y) > h * 0.4) ? (Math.sin(x * 47.1 - 0.6) * 0.009 - 0.004) * (y > 0 ? 1 : -1) : 0;
      p.setXYZ(i, x + ex, y + ey, z);
    }
    p.needsUpdate = true;
    g.computeVertexNormals();               // non-indexed -> genuinely faceted
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0.004, 0);
    return g;
  };

  K.timber = function (noise, seed) {
    var g = new THREE.BoxGeometry(1.0, 0.07, 0.055, 3, 1, 1);
    var p = g.attributes.position;
    var n2 = new GAME.Noise(seed);
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i);
      if (x > 0.4) {
        // splintered end
        p.setY(i, p.getY(i) * (0.2 + Math.abs(n2.perlin3(p.getY(i) * 9, p.getZ(i) * 9, 3)) * 1.2));
        p.setX(i, x + n2.perlin3(p.getY(i) * 7, p.getZ(i) * 7, 8) * 0.13);
      }
    }
    p.needsUpdate = true;
    roughen(g, n2, 0.008, 6);
    g.translate(0, 0.035, 0);
    Geo.worldUV(g, 1.6);
    Geo.copyUV1(g);
    return g;
  };

  // ---- soft goods ----------------------------------------------------------

  // A hanging garment/sheet.  Pinned along the top edge, free everywhere else,
  // with a slight taper so it is not an obvious rectangle.
  // A sheet pegged to a line.  The previous version was a symmetrical trapezoid
  // with straight edges, a level hem and one clean sine of drape, which in the
  // alley framing read as three identical pieces of grey card - "perfectly
  // straight, perfectly uniform anything" off the instant-fail list.  Real
  // washing has a hem that scallops between the pegs, edges that curl, and
  // folds at two scales that do not line up with each other.
  K.hangingCloth = function () {
    var nx = 10, ny = 12, W = 0.62, H = 0.86;
    var g = new THREE.PlaneGeometry(W, H, nx, ny);
    var p = g.attributes.position;
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i);
      var u = (x + W * 0.5) / W;                    // 0..1 across
      var t = M.saturate((H * 0.5 - y) / H);        // 0 at top, 1 at bottom
      // The two pegs are inboard of the corners, so the top edge dips at the
      // sides and the sheet hangs wider at the hem than at the shoulders.
      var taper = 0.74 + t * 0.36;
      var edge = 1 + 0.10 * Math.sin(t * 9.3 + 1.1) * t;
      p.setX(i, x * taper * edge);
      // Drape: three incommensurate frequencies so no fold repeats, plus a
      // shallow cupping so the sheet is never a plane.  The amplitude matters
      // more than it looks: cloth is read almost entirely off the shading
      // gradient between fold crest and trough, and at 0.042 the whole sheet
      // shaded as one value and reported as flat paper in every framing.
      var fold = Math.sin(u * 12.4 + t * 2.4) * 0.62 + Math.sin(u * 5.1 - t * 1.7) * 0.38
        + Math.sin(u * 24.7 + t * 4.1) * 0.20;
      p.setZ(i, fold * 0.062 * (0.20 + t) - (0.5 - Math.abs(u - 0.5)) * 0.06 * t);
      // Hem scallops between the folds, and the whole thing stretches a little
      // under its own weight.
      var hem = (Math.sin(u * 11.0 + 0.7) * 0.5 + Math.sin(u * 4.3 + 2.2) * 0.5);
      p.setY(i, y - t * t * 0.045 + hem * 0.035 * t * t);
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    g.translate(0, -H * 0.5, 0);   // origin at the pegged top edge
    setFlex(g, function (x, y) {
      var t = M.saturate(-y / H);
      return t * t * 1.15;
    });
    return g;
  };

  // A draped tarpaulin / rug: pinned along one edge, sagging away from it.
  // The origin sits ON the pinned edge, so callers can rotate about X to swing
  // the free edge from horizontal (an awning) to vertical (a rug on a rail).
  K.tarp = function () {
    var nx = 7, ny = 7, W = 1.7, D = 2.0;
    var g = new THREE.PlaneGeometry(W, D, nx, ny);
    var p = g.attributes.position;
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i);
      var tv = M.saturate((D * 0.5 - y) / D);
      var tu = M.saturate((x + W * 0.5) / W);
      // drape: sags away from the pinned edge, with a soft fold across it
      var sag = -Math.sin(Math.PI * tu) * (0.10 + tv * 0.42) - tv * tv * 0.30;
      p.setZ(i, sag + Math.sin(tu * 9.1 + tv * 3.0) * 0.04 * tv);
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    g.rotateX(-Math.PI / 2);       // lie in XZ, +Z away from the pinned edge
    g.translate(0, 0, D * 0.5);
    setFlex(g, function (x, y, z) {
      var t = M.saturate(z / D);
      return t * t * 0.8;
    });
    return g;
  };

  // ---- vegetation ----------------------------------------------------------

  // Build a cluster of alpha cards.  cells is a list of [u0,v0] atlas origins
  // (in 0..1 with a 0.5 cell size); each quad gets its own cell so a cluster
  // never looks like the same billboard mirrored.
  function cardCluster(specs, atlasCells, flexPow) {
    var pos = [], nrm = [], uv = [], idx = [], flex = [];
    var v = 0;
    for (var s = 0; s < specs.length; s++) {
      var sp = specs[s];
      var cell = atlasCells[s % atlasCells.length];
      var hw = sp.w * 0.5, h = sp.h;
      var ca = Math.cos(sp.yaw), sa = Math.sin(sp.yaw);
      var tilt = sp.tilt || 0;
      // 4 corners of an upright quad rotated about Y then leaned over
      var corners = [[-hw, 0], [hw, 0], [hw, h], [-hw, h]];
      for (var c = 0; c < 4; c++) {
        var lx = corners[c][0], ly = corners[c][1];
        var lean = Math.sin(tilt) * ly;
        var px = lx * ca + lean * sa * 0 + sp.ox;
        var pz = lx * sa + sp.oz;
        var py = ly * Math.cos(tilt);
        px += Math.sin(sp.leanDir || 0) * lean;
        pz += Math.cos(sp.leanDir || 0) * lean;
        pos.push(px, py, pz);
        // Foliage cards get a normal biased hard toward +Y rather than the
        // card's true facing.  Real leaf clusters scatter light in every
        // direction; using the flat card normal makes half of every bush go
        // black, which is the classic amateur vegetation tell.
        var nl = Math.sqrt(sa * sa * 0.30 + 0.8464 + ca * ca * 0.30) || 1;
        nrm.push(-sa * 0.55 / nl, 0.92 / nl, ca * 0.55 / nl);
        var uu = (c === 1 || c === 2) ? 1 : 0;
        var vv = (c >= 2) ? 1 : 0;
        // inset by half a texel-ish to stop atlas bleed
        uv.push(cell[0] + 0.008 + uu * 0.484, cell[1] + 0.008 + vv * 0.484);
        flex.push(Math.pow(ly / Math.max(0.001, h), flexPow || 2) * (sp.flex || 1));
      }
      idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
      v += 4;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    g.setAttribute('aFlex', new THREE.BufferAttribute(new Float32Array(flex), 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return g;
  }

  K.weedTuft = function (rng) {
    var specs = [];
    for (var i = 0; i < 3; i++) {
      specs.push({
        w: rng.range(0.24, 0.40), h: rng.range(0.17, 0.34),
        yaw: (i / 3) * Math.PI + rng.range(-0.3, 0.3),
        tilt: rng.range(0.0, 0.35), leanDir: rng.range(0, 6.28),
        ox: rng.range(-0.04, 0.04), oz: rng.range(-0.04, 0.04), flex: 1
      });
    }
    return cardCluster(specs, [[0.5, 0], [0.5, 0], [0.5, 0]], 1.6);
  };

  K.scrubBush = function (rng) {
    var specs = [];
    var cells = [];
    var pool = [[0, 0], [0.5, 0], [0, 0.5], [0.5, 0.5]];
    for (var i = 0; i < 7; i++) {
      var r = rng.range(0, 0.28);
      var a = rng.range(0, Math.PI * 2);
      specs.push({
        w: rng.range(0.55, 1.0), h: rng.range(0.42, 0.85),
        yaw: rng.range(0, Math.PI), tilt: rng.range(0, 0.42),
        leanDir: a, ox: Math.cos(a) * r, oz: Math.sin(a) * r, flex: 1
      });
      cells.push(rng.pick(pool));
    }
    return cardCluster(specs, cells, 2.0);
  };

  K.pottedFoliage = function (rng) {
    var specs = [];
    var cells = [];
    for (var i = 0; i < 5; i++) {
      var a = rng.range(0, Math.PI * 2);
      specs.push({
        w: rng.range(0.34, 0.6), h: rng.range(0.3, 0.62),
        yaw: rng.range(0, Math.PI), tilt: rng.range(0.05, 0.5),
        leanDir: a, ox: Math.cos(a) * 0.07, oz: Math.sin(a) * 0.07, flex: 1
      });
      cells.push(rng.bool(0.6) ? [0.5, 0.5] : [0, 0]);
    }
    return cardCluster(specs, cells, 1.8);
  };

  K.palmTrunk = function (noise) {
    var tb = new TubeBuilder();
    var pts = [];
    var H = 4.6, lean = 0.5;
    var n = 16;
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      pts.push(new THREE.Vector3(
        Math.sin(t * 1.15) * lean,
        t * H,
        Math.sin(t * 0.8 + 0.4) * lean * 0.35));
    }
    // Radius pulses so the trunk shows the stepped leaf-boot scars that make a
    // palm read as a palm and not a lamp post.
    tb.addPath(pts, function (t) {
      return (0.19 - t * 0.075) * (1 + Math.sin(t * 52) * 0.075 + noise.perlin2(t * 9, 3) * 0.05);
    }, 9, null, 9);
    var g = tb.geometry(false);
    Geo.copyUV1(g);
    return g;
  };

  K.palmFrond = function () {
    // an arching card; the texture supplies the leaflets
    var nx = 9;
    var pos = [], nrm = [], uv = [], idx = [], flex = [];
    var L = 2.5, W = 0.62;
    for (var i = 0; i <= nx; i++) {
      var t = i / nx;
      var x = t * L;
      // arch: rises then falls away, tips drooping hard
      var y = Math.sin(t * 1.35) * 0.62 - Math.pow(t, 2.6) * 1.5;
      var w = W * (0.35 + Math.sin(Math.PI * Math.pow(t, 0.7)) * 0.85);
      for (var s = 0; s < 2; s++) {
        pos.push(x, y, (s === 0 ? -1 : 1) * w * 0.5);
        // Deliberately NOT computeVertexNormals(): a frond is a flat card that
        // stands in for a three-dimensional cluster of leaflets, so it wants a
        // soft upward normal.  The geometric normal would light it as a sheet.
        nrm.push(0, 1, 0);
        uv.push(t, s);
        flex.push(Math.pow(t, 2) * 1.2);
      }
    }
    for (i = 0; i < nx; i++) {
      var a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    g.setAttribute('aFlex', new THREE.BufferAttribute(new Float32Array(flex), 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return g;
  };

  // ---- one-off assemblies --------------------------------------------------

  K.busShelter = function () {
    var parts = [];
    var W = 3.6, D = 1.35, H = 2.42;
    // uprights
    for (var sx = -1; sx <= 1; sx += 2) {
      parts.push(part(box(0.09, H, 0.09, 0.008), Tn(sx * W * 0.5, H * 0.5, -D * 0.5)));
      parts.push(part(box(0.09, H, 0.09, 0.008), Tn(sx * W * 0.5, H * 0.5, D * 0.5)));
      parts.push(part(box(0.07, 0.07, D, 0.006), Tn(sx * W * 0.5, H - 0.05, 0)));
    }
    // roof: shallow curve
    for (var i = 0; i < 8; i++) {
      var t = i / 7;
      parts.push(part(box(W + 0.3, 0.035, D / 7 + 0.02, 0.005),
        Tn(0, H + 0.06 + Math.sin(t * Math.PI) * 0.11, (t - 0.5) * D, (t - 0.5) * 0.5, 0, 0)));
    }
    parts.push(part(box(W + 0.34, 0.11, 0.06, 0.008), Tn(0, H + 0.05, D * 0.5 + 0.05)));
    // back wall mullions
    for (i = 1; i < 4; i++) {
      parts.push(part(box(0.055, H - 0.2, 0.055, 0.005), Tn(-W * 0.5 + (i / 4) * W, (H - 0.2) * 0.5, -D * 0.5)));
    }
    // bench
    parts.push(part(box(W * 0.82, 0.05, 0.34, 0.008), Tn(0, 0.46, -D * 0.28)));
    for (sx = -1; sx <= 1; sx += 2) {
      parts.push(part(box(0.05, 0.46, 0.3, 0.006), Tn(sx * W * 0.34, 0.23, -D * 0.28)));
    }
    // shattered lower glazing rail
    parts.push(part(box(W, 0.06, 0.05, 0.006), Tn(0, 0.9, -D * 0.5)));
    return mergeParts(parts, 1.4);
  };

  // The glass that is LEFT in the shelter - jagged remnants clinging to the
  // frame.  Separate mesh because it needs a transparent material.
  K.shelterGlass = function (rng) {
    var parts = [];
    var W = 3.6, H = 2.42, D = 1.35;
    // back panes: three bays, each broken to a different height
    for (var i = 0; i < 4; i++) {
      var x0 = -W * 0.5 + (i / 4) * W + 0.03;
      var w = W / 4 - 0.06;
      var top = H - 0.24;
      var bottom = 0.94;
      var breakH = rng.range(0.15, 0.95);
      // remaining shard: a tapered quad clinging to the top rail
      var pos = [], nrm = [], uv = [];
      var yb1 = top - breakH * (top - bottom) * rng.range(0.6, 1.4);
      var yb2 = top - breakH * (top - bottom) * rng.range(0.6, 1.4);
      var mid = (yb1 + yb2) * 0.5 + rng.range(-0.2, 0.2);
      function tri(ax, ay, bx, by, cx, cy) {
        pos.push(ax, ay, -D * 0.5, bx, by, -D * 0.5, cx, cy, -D * 0.5);
        nrm.push(0, 0, 1, 0, 0, 1, 0, 0, 1);
        uv.push(ax, ay, bx, by, cx, cy);
      }
      tri(x0, top, x0 + w, top, x0 + w * 0.5, mid);
      tri(x0, top, x0 + w * 0.5, mid, x0 + w * 0.18, yb1);
      tri(x0 + w, top, x0 + w * 0.82, yb2, x0 + w * 0.5, mid);
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
      parts.push(part(g, null));
    }
    // one side pane still intact
    var side = new THREE.PlaneGeometry(D - 0.16, H - 1.2);
    parts.push(part(side, Tn(-W * 0.5, 0.94 + (H - 1.2) * 0.5, 0, 0, Math.PI / 2, 0)));
    return mergeParts(parts, 0);
  };

  K.dumpster = function () {
    var parts = [];
    var W = 1.85, H = 1.15, D = 1.1;
    // tapered body: build from a profile extrusion so the sides slope
    var pts = [
      new THREE.Vector2(-W * 0.5, H), new THREE.Vector2(W * 0.5, H),
      new THREE.Vector2(W * 0.42, 0.16), new THREE.Vector2(-W * 0.42, 0.16)
    ];
    parts.push(part(extrudeProfile(pts, D, 1), Tn(0, 0, 0)));
    parts.push(part(box(W * 1.02, 0.08, D * 1.02, 0.008), Tn(0, H, 0)));
    // lids, one flipped open
    parts.push(part(box(W * 0.5, 0.05, D * 1.02, 0.008), Tn(-W * 0.25, H + 0.05, 0)));
    parts.push(part(box(W * 0.5, 0.05, D * 1.02, 0.008), Tn(W * 0.32, H + 0.5, -D * 0.42, 0.9, 0, 0)));
    // corner posts, wheels, lifting pockets
    for (var sx = -1; sx <= 1; sx += 2) {
      for (var sz = -1; sz <= 1; sz += 2) {
        parts.push(part(cyl(0.09, 0.09, 0.16, 8), Tn(sx * W * 0.36, 0.08, sz * D * 0.38, 0, 0, Math.PI / 2)));
      }
      parts.push(part(box(0.05, H - 0.16, 0.05, 0.006), Tn(sx * W * 0.44, H * 0.55, D * 0.5)));
      parts.push(part(box(0.28, 0.16, 0.16, 0.008), Tn(sx * W * 0.28, H * 0.55, D * 0.52)));
    }
    return mergeParts(parts, 1.2);
  };

  // A stripped bike frame left leaning on a wall.  Origin at the tyre contact
  // patch, rolling plane = XY, so a caller only has to yaw it and add a roll to
  // lean it.  Cheap, but the double-triangle silhouette is instantly readable
  // and it is the kind of abandoned human object an alley needs.
  K.bicycle = function (rng) {
    var parts = [];
    var R = 0.335, tube = 0.017;
    var rearX = -0.52, frontX = 0.52;
    var wheel = new THREE.TorusGeometry(R, 0.019, 5, 18);
    parts.push(part(wheel, Tn(rearX, R, 0)));
    parts.push(part(wheel, Tn(frontX, R, 0)));
    // a few spokes each; enough to stop the wheels reading as bare hoops
    var i, a;
    for (i = 0; i < 6; i++) {
      a = (i / 6) * Math.PI;
      parts.push(part(cyl(0.0035, 0.0035, R * 2 - 0.02, 4),
        Tn(rearX, R, 0, 0, 0, a)));
      parts.push(part(cyl(0.0035, 0.0035, R * 2 - 0.02, 4),
        Tn(frontX, R, 0, 0, 0, a + 0.26)));
    }
    parts.push(part(cyl(0.028, 0.028, 0.07, 8), Tn(rearX, R, 0, 0, 0, Math.PI / 2)));
    parts.push(part(cyl(0.028, 0.028, 0.07, 8), Tn(frontX, R, 0, 0, 0, Math.PI / 2)));

    var bb = [-0.04, 0.30, 0];                 // bottom bracket
    var seat = [-0.20, 0.80, 0];               // top of seat tube
    var head = [0.34, 0.86, 0];                // top of head tube
    var hub = [frontX, R, 0], rhub = [rearX, R, 0];
    function bar(a1, b1, r) {
      parts.push(part(cyl(r, r, 1, 6), strut(a1[0], a1[1], a1[2], b1[0], b1[1], b1[2])));
    }
    bar(bb, seat, tube);                       // seat tube
    bar(seat, head, tube);                     // top tube
    bar(bb, head, tube * 1.15);                // down tube
    bar(bb, rhub, tube * 0.72);                // chain stay
    bar(seat, rhub, tube * 0.66);              // seat stay
    bar(head, hub, tube * 0.9);                // fork
    bar([0.30, 0.94, 0], [0.30, 0.94, 0.19], tube * 0.7);   // bars
    bar([0.30, 0.94, 0], [0.30, 0.94, -0.19], tube * 0.7);
    parts.push(part(box(0.20, 0.045, 0.09, 0.012), Tn(-0.22, 0.86, 0, 0, 0, -0.12)));
    // the chainring - the one detail that says bicycle at ten metres
    parts.push(part(cyl(0.085, 0.085, 0.008, 12), Tn(bb[0], bb[1], 0.045, 0, 0, Math.PI / 2)));
    if (rng && rng.bool(0.5)) {
      // one wheel buckled; a bike that survived a battle never rolls again
      parts.push(part(box(0.05, 0.26, 0.02, 0.004), Tn(frontX, R * 0.6, 0.02, 0, 0.4, 0.5)));
    }
    return mergeParts(parts, 2.4);
  };

  // A run of service pipes bracketed along a wall.  Built in the caller's
  // local frame: the run goes along +X at y = 0, standing off the wall in -Z.
  K.pipeRun = function (rng, length, count) {
    var tb = new TubeBuilder();
    var parts = [];
    var i, j, k;
    var radii = [0.038, 0.026, 0.019, 0.014];
    var segs = Math.max(6, Math.round(length / 0.55));
    for (i = 0; i < count; i++) {
      var r = radii[i % radii.length] * rng.range(0.85, 1.15);
      var oy = -0.075 * i + rng.range(-0.012, 0.012);
      var oz = rng.range(-0.03, 0.03);
      var pts = [];
      for (j = 0; j <= segs; j++) {
        var t = j / segs;
        pts.push(new THREE.Vector3(-length * 0.5 + t * length,
          oy + Math.sin(t * 5.1 + i) * 0.012, oz + Math.sin(t * 3.3 + i * 2.1) * 0.010));
      }
      tb.addPath(pts, r, 8, null, length * 1.4);
    }
    parts.push(part(tb.geometry(false), null));
    // saddle clamps back to the plaster
    var nClamp = Math.max(3, Math.round(length / 1.2));
    for (k = 0; k < nClamp; k++) {
      var cx = -length * 0.5 + (k + 0.5) * (length / nClamp);
      parts.push(part(box(0.045, 0.075 * count + 0.13, 0.05, 0.006),
        Tn(cx, -0.075 * (count - 1) * 0.5, 0.085)));
      parts.push(part(box(0.13, 0.13, 0.028, 0.005), Tn(cx, -0.075 * (count - 1) * 0.5, 0.115)));
    }
    return mergeParts(parts, 1.6);
  };

  // L-bracket pair that carries a wall-mounted AC condenser.  Local +Z points
  // AWAY from the wall, matching K.acUnit's louvre face, so a caller orients
  // the two with one shared yaw instead of two opposite ones.
  K.wallBracket = function (w, d) {
    var parts = [];
    var back = -0.17;                        // the plaster face
    for (var s = -1; s <= 1; s += 2) {
      var xs = s * w * 0.5;
      parts.push(part(box(0.05, 0.05, d, 0.006), Tn(xs, 0, back + d * 0.5)));
      parts.push(part(cyl(0.016, 0.016, 1, 5),
        strut(xs, -0.012, back + d - 0.04, xs, -d * 0.7, back + 0.03)));
      parts.push(part(box(0.09, d * 0.75, 0.022, 0.004), Tn(xs, -d * 0.3, back)));
    }
    return mergeParts(parts, 2.0);
  };

  // A breeze-block pigeon coop.  Every flat roof in this part of the world has
  // one, and it is exactly the kind of pale, box-and-slat silhouette a dark
  // lower deck needs in order to have a subject at all.  Origin at deck level.
  K.coop = function () {
    var parts = [];
    var W = 1.55, H = 1.10, D = 0.92;
    var i;
    // block plinth so it is not sitting flat on the felt
    parts.push(part(box(W + 0.18, 0.22, D + 0.18, 0.012), Tn(0, 0.11, 0)));
    // body, with a mono-pitch roof lifted at the back
    parts.push(part(box(W, H, D, 0.014), Tn(0, 0.22 + H * 0.5, 0)));
    parts.push(part(box(W + 0.26, 0.055, D + 0.30, 0.008),
      Tn(0, 0.22 + H + 0.09, 0.02, -0.15, 0, 0)));
    // slatted aviary front
    for (i = 0; i < 7; i++) {
      parts.push(part(box(0.032, H * 0.60, 0.032, 0.004),
        Tn(-W * 0.42 + i * (W * 0.84 / 6), 0.22 + H * 0.56, D * 0.5 + 0.02)));
    }
    parts.push(part(box(W * 0.92, 0.05, 0.05, 0.006), Tn(0, 0.22 + H * 0.26, D * 0.5 + 0.02)));
    parts.push(part(box(W * 0.92, 0.05, 0.05, 0.006), Tn(0, 0.22 + H * 0.86, D * 0.5 + 0.02)));
    // landing board and a perch rail on the ridge
    parts.push(part(box(W * 0.66, 0.035, 0.34, 0.006),
      Tn(0, 0.22 + H * 0.30, D * 0.5 + 0.19, 0.06, 0, 0)));
    parts.push(part(cyl(0.018, 0.018, W * 0.62, 6),
      Tn(0, 0.22 + H + 0.20, -D * 0.18, 0, 0, Math.PI / 2)));
    for (i = -1; i <= 1; i += 2) {
      parts.push(part(box(0.035, 0.24, 0.035, 0.004),
        Tn(i * W * 0.28, 0.22 + H + 0.10, -D * 0.18)));
    }
    return mergeParts(parts, 1.5);
  };

  K.waterTank = function () {
    var parts = [];
    parts.push(part(cyl(0.55, 0.55, 1.15, 16), Tn(0, 1.05, 0)));
    parts.push(part(cyl(0.56, 0.56, 0.05, 16), Tn(0, 1.62, 0)));
    parts.push(part(cyl(0.16, 0.16, 0.09, 10), Tn(0.16, 1.68, 0)));
    for (var i = 0; i < 4; i++) {
      var a = (i / 4) * Math.PI * 2 + 0.4;
      parts.push(part(box(0.06, 0.94, 0.06, 0.006), Tn(Math.cos(a) * 0.44, 0.47, Math.sin(a) * 0.44)));
    }
    parts.push(part(box(1.3, 0.06, 1.3, 0.008), Tn(0, 0.45, 0)));
    parts.push(part(cyl(0.028, 0.028, 0.9, 6), Tn(0.5, 0.45, 0.2)));
    return mergeParts(parts, 1.2);
  };

  // Worktop, split out of the counter body so it can take a PALE material.
  // A gutted shop interior is lit only by what comes through the shopfront, and
  // the counter is the biggest horizontal surface in that framing: built
  // entirely from the dark wood material it measured 0.003 luminance - a black
  // slab across the bottom third of a hero shot.  Real market counters are
  // faced in terrazzo, zinc or tile precisely because they get wiped down.
  K.shopCounterTop = function () {
    var parts = [];
    var W = 2.6, H = 0.95, D = 0.7;
    parts.push(part(box(W, 0.062, D, 0.010), Tn(0, H, 0)));
    // a nosing lip, and the splashback riser behind it
    parts.push(part(box(W + 0.05, 0.035, 0.05, 0.008), Tn(0, H - 0.03, -D * 0.5 + 0.02)));
    parts.push(part(box(W * 0.62, 0.16, 0.045, 0.008), Tn(-W * 0.12, H + 0.10, D * 0.44)));
    // a broken-off corner lying on the deck
    parts.push(part(box(0.52, 0.06, 0.36, 0.008), Tn(W * 0.36, 0.035, D * 0.85, 0.06, 0.5, 0.02)));
    return mergeParts(parts, 1.5);
  };

  K.shopCounter = function (rng) {
    // gutted shop interior fitting: a smashed serving counter
    var parts = [];
    var W = 2.6, H = 0.95, D = 0.7;
    parts.push(part(box(W, H - 0.1, 0.05, 0.006), Tn(0, (H - 0.1) * 0.5, D * 0.45)));
    for (var i = 0; i < 5; i++) {
      parts.push(part(box(0.06, H - 0.1, D * 0.8, 0.005), Tn(-W * 0.5 + (i / 4) * W, (H - 0.1) * 0.5, 0)));
    }
    parts.push(part(box(W * 0.9, 0.04, D * 0.6, 0.005), Tn(0, 0.34, -0.05)));
    // a section collapsed inward
    parts.push(part(box(W * 0.34, 0.05, D * 0.9, 0.006), Tn(W * 0.28, 0.42, 0.1, 0.35, 0.18, 0.5)));
    parts.push(part(box(0.6, 0.05, 0.35, 0.005), Tn(-W * 0.3 + rng.range(-0.2, 0.2), 0.05, D * 0.9, 0.1, 0.6, 0)));
    return mergeParts(parts, 1.5);
  };

  K.shelving = function () {
    var parts = [];
    var W = 1.7, H = 1.9, D = 0.42;
    for (var sx = -1; sx <= 1; sx += 2) {
      for (var sz = -1; sz <= 1; sz += 2) {
        parts.push(part(box(0.05, H, 0.05, 0.005), Tn(sx * W * 0.5, H * 0.5, sz * D * 0.5)));
      }
    }
    for (var i = 0; i < 4; i++) {
      parts.push(part(box(W, 0.035, D, 0.005), Tn(0, 0.35 + i * 0.5, 0)));
      parts.push(part(box(W, 0.06, 0.03, 0.004), Tn(0, 0.38 + i * 0.5, D * 0.5)));
    }
    return mergeParts(parts, 1.6);
  };

  // A 4-point barb, extruded along the wire tangent.  Built by hand rather than
  // through extrudeProfile because the star cross-section is concave and that
  // helper fan-triangulates its caps from vertex 0, which inverts on a concave
  // outline.  Local frame: +X along the wire, +Y radially out of the coil.
  function barbStar(tipLong, tipShort, thick) {
    var pos = [], nrm = [], uv = [];
    var hx = thick * 0.5;
    var pts = [], s, a, r;
    for (s = 0; s < 8; s++) {
      a = s * Math.PI * 0.25;
      r = (s % 2 === 0) ? ((s % 4 === 0) ? tipLong : tipShort) : thick * 0.9;
      pts.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    function push(x, y, z, nx, ny, nz, u, v) {
      pos.push(x, y, z); nrm.push(nx, ny, nz); uv.push(u, v);
    }
    for (s = 0; s < 8; s++) {
      var p0 = pts[s], p1 = pts[(s + 1) % 8];
      var dy = p1[0] - p0[0], dz = p1[1] - p0[1];
      var l = Math.sqrt(dy * dy + dz * dz) || 1;
      var ny = dz / l, nz = -dy / l;
      // side wall, wound so the outward face is front-facing
      push(-hx, p0[0], p0[1], 0, ny, nz, 0, 0);
      push(-hx, p1[0], p1[1], 0, ny, nz, l * 40, 0);
      push(hx, p1[0], p1[1], 0, ny, nz, l * 40, thick * 40);
      push(-hx, p0[0], p0[1], 0, ny, nz, 0, 0);
      push(hx, p1[0], p1[1], 0, ny, nz, l * 40, thick * 40);
      push(hx, p0[0], p0[1], 0, ny, nz, 0, thick * 40);
      // end caps, fanned from the centre so concavity is irrelevant
      push(-hx, 0, 0, -1, 0, 0, 0.5, 0.5);
      push(-hx, p1[0], p1[1], -1, 0, 0, 0.5, 0.5);
      push(-hx, p0[0], p0[1], -1, 0, 0, 0.5, 0.5);
      push(hx, 0, 0, 1, 0, 0, 0.5, 0.5);
      push(hx, p0[0], p0[1], 1, 0, 0, 0.5, 0.5);
      push(hx, p1[0], p1[1], 1, 0, 0, 0.5, 0.5);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    g.computeBoundingSphere();
    return g;
  }

  // Concertina / barbed-tape razor wire.
  //
  // The whole prop lives or dies on sample rate.  A helix drawn with nine
  // samples per revolution is a nonagon, and a tube swept with four radial
  // segments is a square prism that presents a flat facet edge-on: together
  // they render as flat polygon outlines, not wire.  So: 28 samples per turn,
  // 6 radial segments, and the pitch derived from the requested length instead
  // of taken as a parameter, because real concertina lays at ~0.18 m per loop
  // and only overlapping loops read as a dense obstacle rather than as hoops.
  // DENSITY IS THE WHOLE PROBLEM.  The version this replaces laid 15-25 turns
  // at 0.185 m pitch over a 2.8-4.6 m run and then added a SECOND half-phase
  // helix, so a single coil presented 30-50 visible rings carrying 26 mm barb
  // tips on a 6 mm core.  At the 2-5 m these actually sat at, that is not razor
  // tape - it is a dead bramble bush, and under a muzzle flash it became the
  // brightest, busiest object in the frame.  Real concertina reads as a
  // repeating open loop with sky through it.  One helix, wider pitch, barbs at
  // less than half the size and a third of the frequency.
  K.concertina = function (rng, length, coilR) {
    var PITCH = 0.26;
    var turns = M.clamp(Math.round(length / PITCH), 4, 14);
    var SPR = 24;                                // samples per revolution
    var n = Math.max(96, turns * SPR);
    var i, t, a, wob, r, cy;
    var ptsA = [];
    for (i = 0; i <= n; i++) {
      t = i / n;
      a = t * turns * Math.PI * 2;
      // Rolled-out wire is never a machined spring: the coil breathes.
      wob = 1 + Math.sin(t * 9.3) * 0.10 + Math.sin(t * 26.7 + 1.1) * 0.035;
      r = coilR * wob;
      cy = r;
      ptsA.push(new THREE.Vector3(t * length, cy + Math.sin(a) * r, Math.cos(a) * r));
    }
    var tb = new TubeBuilder();
    // 4.5 mm core: thin enough to read as wire gauge, thick enough to survive
    // anti-aliasing at the 8-18 m the coils now sit at.
    tb.addPath(ptsA, 0.0045, 6, null, 70);
    var tubeGeo = tb.geometry(false);
    var parts = [part(tubeGeo, null)];

    // Barbs, oriented radially outward from the coil axis so they form the
    // recognisable saw-tooth silhouette instead of scattering at random.
    var barb = barbStar(0.013, 0.008, 0.003);
    var arcPerSample = (2 * Math.PI * coilR) / SPR;
    var step = Math.max(2, Math.round(0.22 / Math.max(0.004, arcPerSample)));
    var tanx, tany, tanz, tl;
    for (i = 0; i < n; i += step) {
      var pA = ptsA[i], pN = ptsA[Math.min(n, i + 1)];
      tanx = pN.x - pA.x; tany = pN.y - pA.y; tanz = pN.z - pA.z;
      tl = Math.sqrt(tanx * tanx + tany * tany + tanz * tanz) || 1;
      tanx /= tl; tany /= tl; tanz /= tl;
      // radial: outward from the coil centreline (which runs along +X at y = cy)
      t = i / n;
      wob = 1 + Math.sin(t * 9.3) * 0.10 + Math.sin(t * 26.7 + 1.1) * 0.035;
      cy = coilR * wob;
      var rx = 0, ry = pA.y - cy, rz = pA.z;
      var rl = Math.sqrt(ry * ry + rz * rz) || 1;
      ry /= rl; rz /= rl;
      // re-orthogonalise the radial against the tangent, then complete the frame
      var d = tanx * rx + tany * ry + tanz * rz;
      var ux = rx - tanx * d, uy = ry - tany * d, uz = rz - tanz * d;
      var ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
      ux /= ul; uy /= ul; uz /= ul;
      var bx = tany * uz - tanz * uy, by = tanz * ux - tanx * uz, bz = tanx * uy - tany * ux;
      parts.push(part(barb, TB(pA.x, pA.y, pA.z, tanx, tany, tanz, ux, uy, uz, bx, by, bz)));
    }
    var g = mergeParts(parts, 6.0);
    if (barb.dispose) barb.dispose();
    if (tubeGeo.dispose) tubeGeo.dispose();
    return g;
  };

  // ==========================================================================
  // GAME.Props
  // ==========================================================================
  function Props(ctx) {
    this.ctx = ctx || {};
    this.root = new THREE.Object3D();
    this.root.name = 'props';
    this.root.matrixAutoUpdate = false;
    this.colliders = [];

    // Deterministic and independent of every other system's RNG stream, so
    // adding a particle somewhere else cannot reshuffle the street dressing.
    var seed = (this.ctx.seed || 20260801) ^ 0x9E3779B1;
    this.rng = new GAME.RNG(seed >>> 0);
    this.noise = new GAME.Noise((seed ^ 0x2545F491) >>> 0);

    this.uTime = { value: 0 };
    this.time = 0;

    this.tex = {};
    this.mats = {};
    this.B = {};                 // instanced batches
    this.S = {                   // one-off geometry, merged per material
      wood: [], rust: [], painted: [], concrete: []
    };
    this.decals = [];            // {p, n, w, h, rot, cell, tint, alpha}
    this.wetDecals = [];
    this.sandRibbons = [];
    this.dustSites = [];
    this.windMats = [];

    this.stats = { instances: 0, drawCalls: 0, colliders: 0, skipped: 0, floaters: 0 };
    this._skipped = 0;           // prop-volume hits rejected by _ground

    // Layout, refined in _probeLayout once the level is known.
    this.z0 = -34; this.z1 = 32;
    this.halfW = 7;
    this._facadeCache = Object.create(null);
    // Composition guards, filled in by _probeLayout.  Declared here so a failed
    // layout phase degrades to "no guard" instead of throwing in every drop.
    this._sightlines = null;
    this._vanish = null;
    this._sightSkipped = 0;
    this._rayOK = true;
    this._hash = null;
    this._qout = [];

    try {
      if (this.ctx.scene) this.ctx.scene.add(this.root);
    } catch (e) { GAME.logError('props.ctor', e); }
  }

  Props.prototype._phase = function (name, fn) {
    var self = this;
    try { fn.call(self); } catch (e) { GAME.logError('props.' + name, e); }
    return GAME.yieldFrame();
  };

  Props.prototype.build = async function () {
    await this._phase('textures', this._initTextures);
    await this._phase('materials', this._initMaterials);
    await this._phase('layout', this._probeLayout);
    await this._phase('kit', this._buildKit);
    await this._phase('market', this._dressMarket);
    await this._phase('industrial', this._dressIndustrial);
    await this._phase('furniture', this._dressStreetFurniture);
    await this._phase('military', this._dressMilitary);
    await this._phase('debris', this._dressDebris);
    await this._phase('soft', this._dressSoftGoods);
    await this._phase('vegetation', this._dressVegetation);
    await this._phase('pockets', this._dressPockets);
    // Aftermath runs late on purpose: it reads back the damage the level
    // published and the emplacements the military pass built, and drops the
    // human residue on top of both.
    await this._phase('aftermath', this._dressAftermath);
    // Overhead runs last of the dressing passes: it turns every line registered
    // by the soft-goods and pocket passes into an actual sagging cord.
    await this._phase('overhead', this._dressOverhead);
    await this._phase('poses', this._dressCameraPoses);
    await this._phase('ground', this._buildGroundDressing);
    await this._phase('commit', this._commit);
    return this;
  };

  // --------------------------------------------------------------------------
  // Textures
  // --------------------------------------------------------------------------
  Props.prototype._initTextures = function () {
    var t = this.tex;
    var aniso = 8;
    try {
      if (this.ctx.renderer && this.ctx.renderer.capabilities) {
        aniso = Math.min(8, this.ctx.renderer.capabilities.getMaxAnisotropy() || 8);
      }
    } catch (e) { /* headless */ }
    this._aniso = aniso;

    // One shared grunge field, reused as a multiply layer everywhere.  Also
    // supplies the height data for a shared detail normal map.
    var grunge = TK.grungeCanvas(256, 0x1234, 1.2);
    this._grunge = grunge;
    if (grunge) {
      t.detailNormal = TK.normalFromHeight(TK.heightFromCanvas(grunge), 256, 1.5);
    }

    // Canopy stripes: faded red / ochre / teal, exactly per the art direction.
    t.stripeRed = TK.tex(TK.stripeCanvas(256, '#c9bda6', '#a8503c', 0x51, grunge), true, 1, 1, aniso);
    t.stripeOchre = TK.tex(TK.stripeCanvas(256, '#cfc3a4', '#b9873f', 0x52, grunge), true, 1, 1, aniso);
    t.stripeTeal = TK.tex(TK.stripeCanvas(256, '#c4bda9', '#3f7a78', 0x53, grunge), true, 1, 1, aniso);

    // Two distinct cloths: washing on a line and a heavy tarpaulin are not the
    // same bolt of fabric, and using one texture for both is what made every
    // hung sheet in the alley an exact copy of its neighbour.
    var clothCv = TK.fabricCanvas(384, 0x61, grunge, 0);
    t.cloth = TK.tex(clothCv, true, 1, 1, aniso);
    t.cloth2 = TK.tex(TK.fabricCanvas(384, 0x6d, grunge, 2), true, 1, 1, aniso);
    // Weave relief.  The shared grunge normal is an abstract dirt field; cloth
    // needs its OWN threads and hem or it lights like painted board.
    if (clothCv) {
      t.clothNormal = TK.normalFromHeight(TK.heightFromCanvas(clothCv), 384, 1.1);
    }
    t.sign = TK.tex(TK.signCanvas(512, 0x71, grunge), true, 1, 1, aniso);
    if (t.sign) { t.sign.wrapS = t.sign.wrapT = THREE.ClampToEdgeWrapping; }
    t.paper = TK.tex(TK.paperCanvas(128, 0x81), true, 1, 1, aniso);
    t.foliage = TK.tex(TK.foliageCanvas(512, 0x91), true, 1, 1, aniso);
    if (t.foliage) { t.foliage.wrapS = t.foliage.wrapT = THREE.ClampToEdgeWrapping; }
    t.frond = TK.tex(TK.frondCanvas(256, 96, 0xA1), true, 1, 1, aniso);
    if (t.frond) { t.frond.wrapS = t.frond.wrapT = THREE.ClampToEdgeWrapping; }
    t.decal = TK.tex(TK.decalCanvas(512, 0xB1), true, 1, 1, aniso);
    if (t.decal) { t.decal.wrapS = t.decal.wrapT = THREE.ClampToEdgeWrapping; }

    // Cloth roughness: fabric is uniformly matte but not perfectly so.
    t.clothORM = TK.orm(64, function (u, v, o) {
      o.rough = 0.88 + Math.sin(u * 41) * 0.03 + Math.cos(v * 37) * 0.03;
      o.metal = 0;
      o.ao = 0.94;
    });
  };

  // Lazily built stand-ins used only when ctx.materials is unavailable.
  Props.prototype._fallbackTexture = function (key, spec) {
    var t = this.tex;
    var id = 'fb_' + key;
    if (t[id] !== undefined) return t[id];
    t[id] = TK.tex(TK.surfaceCanvas(256, this._grunge, spec, spec.seed || 7), true,
      spec.repeat || 1, spec.repeat || 1, this._aniso);
    return t[id];
  };

  var FALLBACK_SPECS = {
    wood_plank: { base: '#6b5540', planks: true, seed: 11, rough: 0.84, metal: 0 },
    rusted_metal: { base: '#7d5138', corrode: true, seed: 12, rough: 0.74, metal: 0.75 },
    painted_metal: { base: '#5a6068', scuff: '210,214,220', speck: '30,26,22', seed: 13, rough: 0.48, metal: 0.6 },
    corrugated_metal: { base: '#8a8074', corrode: true, seed: 14, rough: 0.6, metal: 0.7 },
    concrete: { base: '#9a958c', speck: '60,56,50', seed: 15, rough: 0.93, metal: 0 },
    sand: { base: '#c9b08a', speck: '150,130,100', seed: 16, rough: 1.0, metal: 0 },
    brick: { base: '#8a5a44', speck: '60,40,32', seed: 17, rough: 0.9, metal: 0 },
    rubber: { base: '#3c4147', scuff: '120,126,132', seed: 18, rough: 0.72, metal: 0 },
    fabric: { base: '#b8ac97', speck: '90,82,68', seed: 19, rough: 0.95, metal: 0 },
    plastic: { base: '#6d7a72', scuff: '190,196,190', seed: 20, rough: 0.42, metal: 0 },
    glass: { base: '#8fa6ad', seed: 21, rough: 0.08, metal: 0 },
    asphalt: { base: '#4b4a48', speck: '110,108,104', seed: 22, rough: 0.95, metal: 0 }
  };

  // Get a material.  Prefers the shared library (so props match the level), and
  // ALWAYS clones - modifying a cached library material would corrupt it for
  // every other system.
  Props.prototype._material = function (libName, opts) {
    opts = opts || {};
    var mat = null;
    if (this.ctx.materials && this.ctx.materials.get) {
      try {
        var m = this.ctx.materials.get(libName, opts.libOpts);
        if (m && m.clone) mat = m.clone();
      } catch (e) { GAME.logError('props.mat:' + libName, e); }
    }
    if (!mat) {
      var spec = FALLBACK_SPECS[libName] || FALLBACK_SPECS.concrete;
      mat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: this._fallbackTexture(libName, spec),
        normalMap: this.tex.detailNormal || null,
        roughness: spec.rough,
        metalness: spec.metal
      });
      if (mat.normalScale) mat.normalScale.set(0.6, 0.6);
    }
    mat.name = 'props_' + libName;
    // `color` REPLACES the library's calibrated gain - only correct where the
    // prop has no map worth trusting, or where we genuinely want an absolute
    // value (dark galvanising, brass).  `tint` MULTIPLIES, keeping the
    // calibration and shifting hue only; that is what anything wearing a
    // per-instance colour must use, or the two darkenings compound.
    if (opts.color !== undefined) mat.color.setHex(opts.color);
    else if (opts.tint !== undefined) {
      mat.color.multiply(normTint(opts.tint,
        opts.tintStrength === undefined ? TINT_M : opts.tintStrength, _col2));
    }
    if (opts.roughness !== undefined) mat.roughness = opts.roughness;
    if (opts.metalness !== undefined) mat.metalness = opts.metalness;
    if (opts.side !== undefined) mat.side = opts.side;
    if (opts.transparent !== undefined) mat.transparent = opts.transparent;
    if (opts.opacity !== undefined) mat.opacity = opts.opacity;
    if (opts.alphaTest !== undefined) mat.alphaTest = opts.alphaTest;
    // Sky fill, not sun, is what stops a prop reading as a cut-out.  A prop is
    // a small object with a lot of vertical surface: under a 14-degree sun its
    // sides receive essentially no direct light and live entirely on the IBL
    // term, which is why the interior counter measured 0.003 luminance and 40%
    // of that framing sat under 0.01.  A modest global lift is almost invisible
    // on sunlit faces (the sun dominates there) and worth most of a stop in
    // shade, which is exactly where it is needed.  ARCHITECTURE 7.6.
    if ('envMapIntensity' in mat) {
      mat.envMapIntensity = opts.envIntensity !== undefined ? opts.envIntensity : 1.15;
    }
    // Props are small; a heavy displacement map from the library would blow the
    // vertex budget and is meaningless at this scale.
    if (mat.displacementMap) { mat.displacementMap = null; mat.displacementScale = 0; }
    return mat;
  };

  // Hessian sacking, straight off the texture library.  Goes to the generator
  // by name rather than through materials.get() so a peer module's choice of
  // `tex:` for its own `sandbag` def cannot put striped awning canvas back on
  // three hundred sandbags.  Falls back to the old path if the library is
  // missing or throws.
  Props.prototype._sackMaterial = function (repeat, tint, rough) {
    var st = null;
    try {
      if (this.ctx.textures && this.ctx.textures.get) {
        st = this.ctx.textures.get('sandbag', { repeat: [repeat, repeat] });
      }
    } catch (e) { GAME.logError('props.sackTex', e); st = null; }
    if (st && st.map) {
      // ROUGHNESS IS OURS, NOT THE LIBRARY'S.  Measured: the shared `sandbag`
      // ORM has a green (roughness) channel averaging 0.424 and reaching 0.0.
      // Bound to a material at roughness 1.0 that is an effective gloss of
      // ~0.42 - a lacquered surface.  Under the art direction's 14-degree sun
      // that turns every bag into a hard specular streak along its top edge
      // with a black body, which is exactly why the emplacement reads as a
      // stack of dark stones instead of filled hessian.  Jute is one of the
      // roughest surfaces on the street; drive it from our own cloth ORM
      // (0.88 +/- 0.03) so the highlight is a broad diffuse sheen.
      var mat = new THREE.MeshStandardMaterial({
        map: st.map,
        normalMap: st.normalMap || this.tex.detailNormal || null,
        roughnessMap: this.tex.clothORM || null,
        color: 0xffffff,
        roughness: this.tex.clothORM ? 1.0 : (rough === undefined ? 0.96 : rough),
        metalness: 0
      });
      // Cloth in shade lives almost entirely on sky fill, and a vertical bag
      // face under a raking sun sees no direct light at all.  Cutting the env
      // term (this used to be 0.85) is what pushed the shaded courses under
      // 0.02 luminance; hessian is fibrous and reads LIGHTER than the concrete
      // beside it in any real photograph, so the env term goes up, not down.
      if ('envMapIntensity' in mat) mat.envMapIntensity = 1.25;
      // The weave normal is strong enough to shade itself into mud at grazing
      // incidence; keep the texture, halve the relief.
      if (mat.normalScale) mat.normalScale.set(0.72, 0.72);
      mat.color.multiply(normTint(tint, 0.35, _col2));
      mat.name = 'props_sacking';
      return mat;
    }
    return this._material('fabric', {
      tint: tint, roughness: rough === undefined ? 0.96 : rough, metalness: 0
    });
  };

  Props.prototype._initMaterials = function () {
    var m = this.mats;
    var t = this.tex;

    // NOTE ON ALBEDO: every one of these carries a per-instance tint as well,
    // so they take `tint` (a unit-centred hue multiplier), never `color` (an
    // absolute replacement).  Using `color` here threw away the library's
    // measured albedo gain and then let instanceColor darken it a second time,
    // which is what put the alley drum at 0.04 luminance against 0.20 ground.
    //
    // Metalness is also pulled well down from the library defaults.  Those are
    // authored for large architectural sheet metal read against a full sky;
    // a 0.6 m drum in an alley has almost no environment to reflect, and at
    // metalness 0.72 its diffuse term is scaled by 0.28 before the albedo is
    // even considered.  Rust is iron OXIDE - a dielectric - and paint is a
    // dielectric film over metal, so both belong far lower.
    m.wood = this._material('wood_plank', { tint: 0xbfae95, roughness: 0.86 });
    m.woodDark = this._material('wood_plank', { tint: 0x8a7256, tintStrength: 0.6, roughness: 0.9 });
    m.rust = this._material('rusted_metal', { tint: 0xc8b7a4, roughness: 0.74, metalness: 0.34 });
    m.painted = this._material('painted_metal', { tint: 0x9aa4ab, roughness: 0.52, metalness: 0.22 });
    m.paintedWarm = this._material('painted_metal', { tint: 0xb08a5a, roughness: 0.58, metalness: 0.2 });
    m.corrugated = this._material('corrugated_metal', { tint: 0xb6ab9c, roughness: 0.62, metalness: 0.4 });
    m.concrete = this._material('concrete', { tint: 0xa7a29a, roughness: 0.94, metalness: 0.02 });
    m.brick = this._material('brick', { tint: 0xa07660, roughness: 0.92, metalness: 0 });
    m.sand = this._material('sand', { tint: 0xd0b98f, roughness: 1.0, metalness: 0 });
    m.plastic = this._material('rubber', { tint: 0x9fb0a6, roughness: 0.45, metalness: 0.02 });
    m.brass = this._material('painted_metal', { color: 0xb8903c, roughness: 0.34, metalness: 0.95 });

    // ---- sacking -----------------------------------------------------------
    // Hessian, from the texture library's own jute recipe.  This used to route
    // through `fabric`, which is red-and-cream STRIPED awning canvas; at a
    // sack's uv density the stripe weave aliased into gingham and the whole
    // emplacement read as a picnic blanket thrown over boxes.  textures.js has
    // had `sandbag` (aliases hessian/burlap) the entire time.
    m.sack = this._sackMaterial(2.3, 0xd6c6a4, 0.96);
    m.sandbagMat = this._sackMaterial(1.35, 0xc0ad86, 0.98);
    // Weathered galvanised steel for razor wire and thin brackets.  A near
    // sub-pixel strand takes its whole appearance from its specular response,
    // so the env contribution is pulled right down: at full strength the sky
    // alone turns the coil into a bright hard line with no shading variation.
    // Razor wire is the single worst specular-aliasing case in the scene: a
    // 12 mm strand plus a few hundred flat barb plates, most of them under a
    // pixel across.  At metalness 0.58 / roughness 0.55 every one of those
    // sub-pixel facets returns a full sun highlight for one frame and loses it
    // the next, and the coil reads as a ball of glitter rather than as steel.
    // Galvanising is a dull matte zinc coating, so this is also the physically
    // right answer, not just the quiet one.
    m.wire = this._material('painted_metal', {
      color: 0x4b4f53, roughness: 0.78, metalness: 0.30, envIntensity: 0.26
    });

    m.glass = this._material('glass', {
      color: 0x9fb6bd, roughness: 0.06, metalness: 0.02,
      transparent: true, opacity: 0.34, side: THREE.DoubleSide
    });
    m.glass.depthWrite = false;

    // Newsprint and cardboard, not office bond.  The base is knocked down here
    // as well as per-instance so a scrap can never be the brightest thing in a
    // frame - street litter that out-values the sunlit plaster is the fastest
    // way to make a road read as a slab covered in confetti.
    m.paper = new THREE.MeshStandardMaterial({
      map: t.paper, color: 0xb2a892, roughness: 0.94, metalness: 0,
      normalMap: t.detailNormal || null,
      side: THREE.DoubleSide
    });
    if (m.paper.normalScale) m.paper.normalScale.set(0.5, 0.5);
    if ('envMapIntensity' in m.paper) m.paper.envMapIntensity = 0.6;

    // ---- wind materials ----------------------------------------------------
    // Amplitudes are in metres at aFlex = 1: canopies barely move (they are
    // lashed down), laundry and fronds move a lot.
    var self = this;
    function clothMat(map, amp, freq, billow, spatial, tint, nrm, env) {
      var mm = new THREE.MeshStandardMaterial({
        map: map, color: tint === undefined ? 0xffffff : tint,
        roughnessMap: t.clothORM || null,
        normalMap: nrm || t.detailNormal || null,
        roughness: 0.9, metalness: 0,
        side: THREE.DoubleSide
      });
      if (mm.normalScale) mm.normalScale.set(nrm ? 0.85 : 0.35, nrm ? 0.85 : 0.35);
      // Cloth is fibrous: it scatters far more sky than a painted board does,
      // and a lit awning SHOULD glow, so canopies keep the full 1.15.  Hung
      // washing does NOT: it is DoubleSide, so at 1.15 the back skin took a
      // second full helping of sky and the sheet ended up brighter than the
      // night sky behind it.  See the albedo invariant in TK.fabricCanvas.
      if ('envMapIntensity' in mm) mm.envMapIntensity = env === undefined ? 1.15 : env;
      applyWind(mm, self.uTime, amp, freq, billow, spatial);
      self.windMats.push(mm);
      return mm;
    }
    this._clothMat = clothMat;

    m.canopyRed = clothMat(t.stripeRed, 0.035, 1.55, 0.55, 0.55);
    m.canopyOchre = clothMat(t.stripeOchre, 0.033, 1.42, 0.55, 0.62);
    m.canopyTeal = clothMat(t.stripeTeal, 0.036, 1.63, 0.55, 0.48);
    m.laundry = clothMat(t.cloth, 0.085, 2.05, 0.75, 0.9, undefined, t.clothNormal, 0.88);
    m.tarp = clothMat(t.cloth2 || t.cloth, 0.05, 1.35, 0.6, 0.7, undefined, t.clothNormal, 0.9);

    m.foliage = new THREE.MeshStandardMaterial({
      map: t.foliage, color: 0xffffff,
      roughness: 0.86, metalness: 0,
      side: THREE.DoubleSide, alphaTest: 0.32, transparent: false
    });
    applyWind(m.foliage, this.uTime, 0.055, 2.35, 0.8, 1.25);
    this.windMats.push(m.foliage);

    m.frond = new THREE.MeshStandardMaterial({
      map: t.frond, color: 0xffffff,
      roughness: 0.8, metalness: 0,
      side: THREE.DoubleSide, alphaTest: 0.30, transparent: false
    });
    applyWind(m.frond, this.uTime, 0.16, 1.25, 0.9, 0.35);
    this.windMats.push(m.frond);

    // A catenary is the worst specular-aliasing case in the scene after razor
    // wire: a sub-pixel tube swept with three or four radial segments presents
    // flat facets that catch and lose the sun from frame to frame, and at 0.15
    // metalness the laundry cords rendered as strings of white beads - fairy
    // lights strung across a war zone.  Insulated cable is a matte dielectric.
    m.cable = new THREE.MeshStandardMaterial({
      color: 0x1d1e20, roughness: 0.88, metalness: 0.04
    });
    if ('envMapIntensity' in m.cable) m.cable.envMapIntensity = 0.5;
    applyWind(m.cable, this.uTime, 0.055, 1.15, 0.85, 0.4);
    this.windMats.push(m.cable);

    // Shadow casters that move must move in the shadow pass too.
    this._depth = {
      canopy: windDepth(this.uTime, m.canopyRed.userData.uWind, null, 0, THREE.DoubleSide),
      laundry: windDepth(this.uTime, m.laundry.userData.uWind, null, 0, THREE.DoubleSide),
      tarp: windDepth(this.uTime, m.tarp.userData.uWind, null, 0, THREE.DoubleSide),
      foliage: windDepth(this.uTime, m.foliage.userData.uWind, t.foliage, 0.32, THREE.DoubleSide),
      frond: windDepth(this.uTime, m.frond.userData.uWind, t.frond, 0.30, THREE.DoubleSide)
    };

    // ---- decals ------------------------------------------------------------
    // Ground stains are the cheapest "this place has a history" signal we have.
    m.decal = new THREE.MeshStandardMaterial({
      map: t.decal, color: 0xffffff, transparent: true,
      roughness: 0.88, metalness: 0, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      vertexColors: true, side: THREE.FrontSide
    });
    // Wet decals get their own low-roughness material: a damp patch that does
    // not reflect the sky is not a damp patch.
    m.decalWet = m.decal.clone();
    m.decalWet.roughness = 0.13;
    m.decalWet.metalness = 0.05;
    m.decalWet.polygonOffsetFactor = -5;
    // A wet patch only reads as wet if it returns the sky.  These live in the
    // alley, which is the darkest framing in the set and the one place a
    // specular highlight has to do the whole job.
    if ('envMapIntensity' in m.decalWet) m.decalWet.envMapIntensity = 1.6;
  };

  // --------------------------------------------------------------------------
  // Layout probing
  //
  // We never hard-code where the buildings are.  We probe the level's own
  // colliders, so if level.js moves a facade the props follow it.  Only if
  // there is no level at all do we fall back to the art-direction numbers.
  // --------------------------------------------------------------------------
  Props.prototype._probeLayout = function () {
    var lvl = this.ctx.level;
    var i;

    // Street extent from the level's own bounds.
    if (lvl && lvl.root) {
      try {
        var bb = new THREE.Box3().setFromObject(lvl.root);
        if (isFinite(bb.min.z) && isFinite(bb.max.z) && (bb.max.z - bb.min.z) > 20) {
          this.z0 = M.clamp(bb.min.z + 2.5, -70, 0);
          this.z1 = M.clamp(bb.max.z - 2.5, 0, 70);
        }
      } catch (e) { GAME.logError('props.bounds', e); }
    }

    // Broadphase over the level's obstacles.  Anything whose top is essentially
    // at ground level is floor, not obstacle, and must not block placement.
    if (lvl && lvl.colliders && lvl.colliders.length) {
      var hash = new GAME.SpatialHash(4);
      var used = 0;
      for (i = 0; i < lvl.colliders.length; i++) {
        var c = lvl.colliders[i];
        if (!c || c.type !== 'box' || !c.center || !c.halfExtents) continue;
        if (c.center.y + c.halfExtents.y < 0.25) continue;   // floor slab
        GAME.Collision.boxBounds(c, _bmin, _bmax);
        hash.insert(c, _bmin, _bmax);
        used++;
      }
      if (used) this._hash = hash;
    }
    this._noLevel = !this._hash;

    // Ground raycast smoke test - if level.raycast is broken, stop calling it.
    if (lvl && lvl.raycast) {
      try {
        _rayO.set(0, 3, 0);
        var r = lvl.raycast(_rayO, _rayD, 8);
        this._rayOK = !!(r && typeof r === 'object');
      } catch (e) { this._rayOK = false; }
    } else {
      this._rayOK = false;
    }

    // Effective street half-width: median of the probed facades.
    if (!this._noLevel) {
      var z, a, b;
      var samples = [];
      for (z = this.z0 + 4; z < this.z1 - 4; z += 5) {
        a = this._facade(z, -1); b = this._facade(z, 1);
        if (a.solid) samples.push(Math.abs(a.x));
        if (b.solid) samples.push(Math.abs(b.x));
      }
      if (samples.length > 2) {
        samples.sort(function (p, q) { return p - q; });
        this.halfW = M.clamp(samples[Math.floor(samples.length / 2)], 3.5, 12);
      }

      // The level's bounding box can include a distant skyline backdrop, which
      // would stretch the dressing over a hundred metres of empty tarmac and
      // thin it out everywhere that matters.  Trim each end inward to the first
      // slice that actually has a building beside it.
      var step = 2;
      for (z = this.z0; z < this.z1 - 12; z += step) {
        if (this._facade(z, -1).solid || this._facade(z, 1).solid) break;
      }
      this.z0 = Math.max(this.z0, z - step);
      for (z = this.z1; z > this.z0 + 12; z -= step) {
        if (this._facade(z, -1).solid || this._facade(z, 1).solid) break;
      }
      this.z1 = Math.min(this.z1, z + step);
    }
    // Backstop: never dress more street than the art direction describes.
    if (this.z1 - this.z0 > 96) {
      var mid = (this.z0 + this.z1) * 0.5;
      this.z0 = mid - 48;
      this.z1 = mid + 48;
    }

    this._buildSightlines();
  };

  // --------------------------------------------------------------------------
  // Sightlines
  //
  // Four independent dressing passes all write into the same 3-5 m wedge in
  // front of every hero camera, because none of them had any concept of what
  // the camera is looking THROUGH.  A strong foreground element is composition;
  // a wall of clutter across the plate is not, and the street framing measured
  // a bottom third at 0.169 against an upper band at 0.463 - an undifferentiated
  // dark mass, not a framing element.
  //
  // So each street-level hero pose publishes a wedge, and every prop that would
  // read as OCCLUSION (rather than as ground texture) is rejected inside it.
  // Deliberately only the street-corridor poses: the alley, interior and
  // rooftop framings are hand-composed by _dressPockets and their dressing is
  // supposed to be in shot.
  //
  // Separately, the arched passage at the far end of the street is the
  // vanishing point every leading line in the composition delivers you to, so
  // the last stretch of centre road before it is kept clear as well.
  // --------------------------------------------------------------------------
  var SIGHT_POSES = { street: 1, overview: 1 };

  Props.prototype._buildSightlines = function () {
    this._sightlines = [];
    this._vanish = null;
    this._sightSkipped = 0;
    var poses = null;
    try { poses = this.ctx.level && this.ctx.level.cameraPoses; } catch (e) { poses = null; }
    if (poses) {
      for (var key in SIGHT_POSES) {
        var p = poses[key];
        if (!p || !p.position) continue;
        if (!(isFinite(p.position.x) && isFinite(p.position.z))) continue;
        var yaw = p.yaw || 0;
        this._sightlines.push({
          ox: p.position.x, oz: p.position.z,
          fx: -Math.sin(yaw), fz: -Math.cos(yaw),
          rx: Math.cos(yaw), rz: -Math.sin(yaw),
          near: 1.2, far: 22,
          base: 0.35, grow: 0.09, cap: 2.0,
          yMax: (p.position.y || 1.6) + 0.35
        });
      }
    }
    // The clear cone at the vanishing point.  z0 is the far end of the dressed
    // corridor, which is the arched cross-block.
    this._vanish = {
      z0: this.z0 - 2, z1: this.z0 + 14,
      x: 0, r: 2.5, yMax: 3.2
    };
  };

  Props.prototype._inSightline = function (x, y, z) {
    var S = this._sightlines;
    var i, s;
    if (S) {
      for (i = 0; i < S.length; i++) {
        s = S[i];
        if (y > s.yMax) continue;
        var dx = x - s.ox, dz = z - s.oz;
        var d = dx * s.fx + dz * s.fz;
        if (d < s.near || d > s.far) continue;
        var lat = Math.abs(dx * s.rx + dz * s.rz);
        if (lat < Math.min(s.cap, s.base + s.grow * d)) return true;
      }
    }
    var V = this._vanish;
    if (V && y < V.yMax && z >= V.z0 && z <= V.z1 && Math.abs(x - V.x) < V.r) return true;
    return false;
  };

  // Ground height under (x,z).  Raycasts down against the level; falls back to
  // a gently cambered street so props still sit sensibly with no level.
  //
  // GROUND-ONLY BY DEFAULT.  The naive version returned the FIRST hit, and the
  // level's collision volumes for stall frames, shop counters, awnings and
  // canopies are considerably larger than the geometry that justifies them.
  // Street litter dropped anywhere near a shopfront therefore latched onto the
  // top of an invisible box and hung 0.5-1.5 m in the air - a galvanised bin
  // floating over the pavement surrounded by suspended paper, which is an
  // instant-fail tell in any shipped shooter.
  //
  // So: keep casting downward through anything that is neither flagged as a
  // floor by the level nor sitting at the height we expect the floor to be,
  // and take the first surface that IS.  `expectY` lets a caller dressing an
  // upper storey say where its deck is; an explicit `fromY` with no `expectY`
  // keeps the old first-hit behaviour as a backstop so elevated dressing can
  // never be dumped onto the street.
  var GROUND_TOL = 0.40;

  Props.prototype._ground = function (x, z, fromY, maxDist, expectY) {
    var expect = expectY !== undefined ? expectY : this._camber(x);
    // Infinity means "accept the first hit"; it is a filter threshold, never a
    // sane answer, so the miss case still falls back to the cambered street.
    var miss = isFinite(expect) ? expect : this._camber(x);
    if (this._rayOK && this.ctx.level && this.ctx.level.raycast) {
      var oy = fromY === undefined ? 2.4 : fromY;
      var remain = maxDist === undefined ? 6 : maxDist;
      var first = null;
      for (var pass = 0; pass < 4 && remain > 0.03; pass++) {
        _rayO.set(x, oy, z);
        _rayD.set(0, -1, 0);
        var r;
        try {
          r = this.ctx.level.raycast(_rayO, _rayD, remain);
        } catch (e) {
          this._rayOK = false;
          GAME.logError('props.ground', e);
          return miss;
        }
        if (!(r && r.hit && r.point && isFinite(r.point.y))) break;
        var hy = r.point.y;
        if (first === null) first = hy;
        if ((r.collider && r.collider.floor) || hy <= expect + GROUND_TOL) return hy;
        this._skipped++;
        remain -= (oy - hy) + 0.04;
        oy = hy - 0.04;
      }
      if (fromY !== undefined && expectY === undefined && first !== null) return first;
    }
    return miss;
  };

  // Roads are cambered so water runs to the gutters; 6cm of crown over 7m.
  Props.prototype._camber = function (x) {
    var t = M.saturate(Math.abs(x) / Math.max(1, this.halfW));
    return 0.06 * (1 - t * t);
  };

  Props.prototype._blocked = function (x, y, z, r) {
    if (!this._hash) return false;
    _bmin.set(x - r, y - r, z - r);
    _bmax.set(x + r, y + r, z + r);
    var list = this._hash.query(_bmin, _bmax, this._qout);
    _va.set(x, y, z);
    for (var i = 0; i < list.length; i++) {
      if (GAME.Collision.boxOverlapsSphere(list[i], _va, r)) return true;
    }
    return false;
  };

  // March outward from the street centreline until we hit something thick.
  // That is the facade.  `solid:false` means there is a gap there (alley mouth,
  // junction) and wall-hugging props should be skipped.
  Props.prototype._probeFacade = function (z, side, y) {
    if (this._noLevel) return { x: side * this.halfW, solid: true };
    var step = 0.12, run = 0, firstX = 0;
    for (var d = 0; d < 120; d++) {
      var x = side * (3.4 + d * step);
      if (Math.abs(x) > 20) break;
      if (this._blocked(x, y, z, 0.20)) {
        if (run === 0) firstX = x;
        run++;
        // require 3 consecutive hits so a lone street prop is not mistaken for
        // a building
        if (run >= 3) return { x: firstX, solid: true };
      } else {
        run = 0;
      }
    }
    return { x: side * this.halfW, solid: false };
  };

  Props.prototype._facade = function (z, side, y) {
    y = y === undefined ? 1.2 : y;
    var key = (side > 0 ? 'e' : 'w') + Math.round(z * 2) + '_' + Math.round(y);
    var c = this._facadeCache[key];
    if (c) return c;
    c = this._probeFacade(z, side, y);
    this._facadeCache[key] = c;
    return c;
  };

  // Is there sky (or at least clear air) directly above this point?
  //
  // Hung cloth is the one prop class that cannot be validated by a ground
  // raycast: a garment is pegged to a cord several metres up, so a line whose
  // endpoint probe landed on the wrong surface leaves washing hanging in mid
  // air inside a room, with the cord too thin to see.  Anything pegged out to
  // dry has open air above it; anything that does not, we simply do not place.
  Props.prototype._openAbove = function (x, y, z, dist) {
    if (!this._rayOK || !this.ctx.level || !this.ctx.level.raycast) return true;
    _rayO.set(x, y, z);
    _rayD.set(0, 1, 0);
    try {
      var r = this.ctx.level.raycast(_rayO, _rayD, dist === undefined ? 2.0 : dist);
      _rayD.set(0, -1, 0);
      return !(r && r.hit);
    } catch (e) {
      _rayD.set(0, -1, 0);
      this._rayOK = false;
      return true;
    }
  };

  // Find the roof surface above (x,z).  Used for AC units, dishes, aerials.
  Props.prototype._roof = function (x, z) {
    if (!this._rayOK || !this.ctx.level || !this.ctx.level.raycast) return -1;
    _rayO.set(x, 26, z);
    _rayD.set(0, -1, 0);
    try {
      var r = this.ctx.level.raycast(_rayO, _rayD, 34);
      if (r && r.hit && r.point && r.point.y > 3.5) return r.point.y;
    } catch (e) { this._rayOK = false; }
    return -1;
  };

  Props.prototype._collider = function (x, y, z, hx, hy, hz, yaw, mat) {
    _eu.set(0, yaw || 0, 0, 'YXZ');
    this.colliders.push({
      type: 'box',
      center: new THREE.Vector3(x, y, z),
      halfExtents: new THREE.Vector3(hx, hy, hz),
      quaternion: new THREE.Quaternion().setFromEuler(_eu),
      material: mat || 'wood'
    });
  };

  // Small hue/value jitter so no two instances are the same object.
  //
  // The hex is a HUE, not a value: it is normalised to a unit multiplier before
  // the jitter is applied (see normTint above), because the material it lands
  // on already carries its own calibrated albedo.  Only vLo/vHi set brightness.
  Props.prototype._jit = function (hex, vLo, vHi, hueJit, out) {
    out = normTint(hex, TINT_S, out || _col);
    var rng = this.rng;
    out.multiplyScalar(rng.range(vLo === undefined ? 0.82 : vLo, vHi === undefined ? 1.14 : vHi));
    if (hueJit) {
      out.r = M.clamp(out.r * (1 + rng.range(-hueJit, hueJit)), 0, 4);
      out.g = M.clamp(out.g * (1 + rng.range(-hueJit, hueJit)), 0, 4);
      out.b = M.clamp(out.b * (1 + rng.range(-hueJit, hueJit)), 0, 4);
    }
    return out;
  };

  // --------------------------------------------------------------------------
  // Kit construction: build every geometry once, wrap in batches.
  // --------------------------------------------------------------------------
  Props.prototype._batch = function (name, geo, mat, max, cast) {
    if (!geo) return null;
    Geo.copyUV1(geo);
    var b = new Batch(geo, mat, max, cast);
    b.mesh.name = 'props_' + name;
    this.B[name] = b;
    return b;
  };

  Props.prototype._buildKit = function () {
    var rng = this.rng, n = this.noise, m = this.mats;
    var self = this;

    // ---- industrial ----
    this._batch('drum', K.drum(n), m.rust, 130, true);
    this._batch('jerrycan', K.jerryCan(), m.painted, 54, true);
    this._batch('cylinder', K.gasCylinder(), m.painted, 20, true);
    this._batch('pallet', K.pallet(), m.woodDark, 76, true);
    this._batch('spool', K.spool(), m.woodDark, 10, true);
    this._batch('toolbox', K.toolbox(), m.painted, 14, true);

    // ---- market ----
    this._batch('crate', K.crate(), m.wood, 300, true);
    this._batch('crateTall', K.crateTall(), m.wood, 110, true);
    this._batch('crateBroken', K.crateBroken(), m.wood, 90, true);
    this._batch('ammocrate', K.ammoCrate(), m.woodDark, 64, true);
    this._batch('sack', K.sack(n), m.sack, 96, true);
    this._batch('chair', K.chair(), m.plastic, 56, true);
    this._batch('stall', K.stallFrame(), m.woodDark, 34, true);
    this._batch('awning', K.awning(), m.corrugated, 34, true);

    var canopyGeo = K.canopy();
    this._batch('canopyRed', canopyGeo, m.canopyRed, 16, true);
    this._batch('canopyOchre', canopyGeo, m.canopyOchre, 16, true);
    this._batch('canopyTeal', canopyGeo, m.canopyTeal, 16, true);

    // ---- street furniture ----
    this._batch('bollard', K.bollard(), m.painted, 30, true);
    this._batch('bin', K.bin(), m.painted, 28, true);
    this._batch('lamp', K.streetLamp(), m.painted, 14, true);
    this._batch('signPanel', K.signPanel(), this._material('painted_metal', {
      color: 0xffffff, roughness: 0.62, metalness: 0.25, side: THREE.DoubleSide
    }), 34, true);
    if (this.B.signPanel) {
      // the sign board's albedo is the invented-script atlas, not the library map
      this.B.signPanel.mesh.material.map = this.tex.sign;
      this.B.signPanel.mesh.material.needsUpdate = true;
    }
    this._batch('signBracket', K.signBracket(), m.rust, 34, true);
    this._batch('ac', K.acUnit(), m.painted, 40, true);
    this._batch('dish', K.satDish(), m.painted, 24, true);
    this._batch('aerial', K.aerial(), m.rust, 20, false);
    this._batch('planter', K.planter(), m.brick, 20, true);

    // ---- military ----
    this._batch('sandbag', K.sandbag(n), m.sandbagMat, 980, true);
    this._batch('jersey', K.jerseyBarrier(), m.concrete, 22, true);

    // ---- debris ----
    // Rubble is now graded into slabs / chunks / fines, so the instance count
    // per pile is roughly three times what it was; without the headroom the
    // last piles built silently place nothing.
    this._batch('rubble', K.rubbleChunk(n, 0x777), m.concrete, 1700, true);
    this._batch('rebar', K.rebar(), m.rust, 320, false);
    this._batch('brick', K.brick(n), m.brick, 820, false);
    this._batch('pebble', K.pebble(n, 0x778), m.concrete, 1560, false);
    this._batch('glass', K.glassShard(rng), m.glass, 1400, false);
    this._batch('casing', K.casing(), m.brass, 700, false);
    this._batch('paper', K.paperScrap(rng), m.paper, 620, false);
    this._batch('timber', K.timber(n, 0x779), m.woodDark, 300, false);

    // ---- soft goods ----
    this._batch('laundry', K.hangingCloth(), m.laundry, 110, true);
    this._batch('tarp', K.tarp(), m.tarp, 44, true);

    // ---- vegetation ----
    this._batch('weed', K.weedTuft(rng), m.foliage, 620, false);
    this._batch('scrub', K.scrubBush(rng), m.foliage, 130, true);
    this._batch('potFoliage', K.pottedFoliage(rng), m.foliage, 20, true);
    this._batch('palmTrunk', K.palmTrunk(n), m.woodDark, 8, true);
    this._batch('frond', K.palmFrond(), m.frond, 220, true);

    // Wind shadow materials.
    var d = this._depth;
    ['canopyRed', 'canopyOchre', 'canopyTeal'].forEach(function (k) {
      if (self.B[k]) self.B[k].mesh.customDepthMaterial = d.canopy;
    });
    if (this.B.laundry) this.B.laundry.mesh.customDepthMaterial = d.laundry;
    if (this.B.tarp) this.B.tarp.mesh.customDepthMaterial = d.tarp;
    ['weed', 'scrub', 'potFoliage'].forEach(function (k) {
      if (self.B[k]) self.B[k].mesh.customDepthMaterial = d.foliage;
    });
    if (this.B.frond) this.B.frond.mesh.customDepthMaterial = d.frond;
  };

  // Per-instance proportion jitter for kit that gets stamped out dozens of
  // times.  A drum is a manufactured object so it cannot vary much, but a rank
  // of thirty identically-proportioned drums is the loudest copy-paste tell
  // there is; +/-6% on three axes independently is under the threshold where a
  // viewer reads "wrong size" and well over the one where the array stops
  // looking cloned.
  //
  // Derived from a hash of the instance index rather than from this.rng ON
  // PURPOSE: drawing three extra randoms per placement would re-phase the
  // whole deterministic dressing stream and reshuffle every composition that
  // has already been tuned against a capture.
  var VARY_KITS = {
    drum: [0.055, 0.075, 0.055], pallet: [0.075, 0.06, 0.075],
    jerrycan: [0.05, 0.06, 0.05], bin: [0.06, 0.07, 0.06],
    ammocrate: [0.07, 0.06, 0.07], chair: [0.05, 0.05, 0.05],
    toolbox: [0.07, 0.06, 0.07], planter: [0.08, 0.07, 0.08],
    ac: [0.07, 0.06, 0.07], jersey: [0.03, 0.045, 0.03],
    spool: [0.07, 0.07, 0.07], sack: [0.09, 0.08, 0.09]
  };
  var MIRROR_KITS = {
    laundry: 1, tarp: 1, canopyRed: 1, canopyOchre: 1, canopyTeal: 1, awning: 1
  };
  function hash01(i, salt) {
    var h = (Math.imul(i + 1, 374761393) + Math.imul(salt + 1, 668265263)) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 1274126177) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // Prop classes that read as GROUND TEXTURE rather than as occlusion, and are
  // therefore allowed inside a camera's sightline wedge.  Everything else - a
  // drum, a crate, a barrier, a bin - is a silhouette across the plate.
  var SIGHT_EXEMPT = {
    paper: 1, pebble: 1, casing: 1, glass: 1, brick: 1, weed: 1,
    rubble: 1, timber: 1, rebar: 1
  };

  // Convenience: place into a batch, sitting on the ground with a small tilt.
  Props.prototype._drop = function (name, x, z, yaw, opts) {
    var b = this.B[name];
    if (!b) return false;
    opts = opts || {};
    var rng = this.rng;
    var y = opts.y !== undefined ? opts.y : this._ground(x, z, opts.fromY, opts.maxDist, opts.expectY);
    if (!SIGHT_EXEMPT[name] && !opts.force && this._inSightline(x, y, z)) {
      this._sightSkipped++;
      return false;
    }
    var tilt = opts.tilt === undefined ? 0.035 : opts.tilt;
    var s = opts.scale === undefined ? 1 : opts.scale;
    var sx = s * (opts.sx || 1), sy = s * (opts.sy || 1), sz = s * (opts.sz || 1);
    var vk = VARY_KITS[name];
    if (vk && opts.sx === undefined && opts.sy === undefined && opts.sz === undefined) {
      sx *= 1 + (hash01(b.n, 11) * 2 - 1) * vk[0];
      sy *= 1 + (hash01(b.n, 29) * 2 - 1) * vk[1];
      sz *= 1 + (hash01(b.n, 47) * 2 - 1) * vk[2];
    }
    // Cloth carries a 0..1 sheet layout, so every instance of a batch shows the
    // SAME stains in the same places - three sheets on one alley line read as
    // one sheet stamped three times.  Mirroring half of them on X costs nothing
    // (the materials are DoubleSide already, so the flipped winding shades
    // correctly) and doubles the apparent library.
    if (MIRROR_KITS[name] && hash01(b.n, 71) < 0.5) sx = -sx;
    var col = opts.color || this._jit(opts.tint === undefined ? 0xffffff : opts.tint,
      opts.vLo, opts.vHi, opts.hue);
    // Everything settles slightly out of true - nothing on a street is level.
    var pitch = (opts.pitch || 0) + rng.gaussian(0, tilt);
    var roll = (opts.roll || 0) + rng.gaussian(0, tilt);
    return b.place(x, y + (opts.lift || 0), z, yaw, pitch, roll, sx, sy, sz, col);
  };

  // The ONLY way a produce crate gets placed.
  //
  // `_drop` jitters position, tilt and value but never proportion, so fifteen
  // crates at frame left read as one object stamped fifteen times.  This picks
  // between three silhouette families, jitters the three axes independently,
  // uses the full yaw circle rather than a quantised one, and occasionally
  // lays a crate on its side or cants it off a stack.
  var CRATE_KIT = ['crate', 'crate', 'crate', 'crateTall', 'crateBroken'];
  Props.prototype._crate = function (x, z, opts) {
    opts = opts || {};
    var rng = this.rng;
    var name = rng.pick(CRATE_KIT);
    if (!this.B[name]) name = 'crate';
    var o = {
      y: opts.y, fromY: opts.fromY, maxDist: opts.maxDist, expectY: opts.expectY,
      lift: opts.lift || 0,
      tilt: opts.tilt === undefined ? 0.04 : opts.tilt,
      tint: opts.tint === undefined ? 0xc6b294 : opts.tint,
      vLo: opts.vLo === undefined ? 0.66 : opts.vLo,
      vHi: opts.vHi === undefined ? 1.16 : opts.vHi,
      hue: opts.hue === undefined ? 0.075 : opts.hue,
      sx: (opts.sx || 1) * rng.range(0.87, 1.15),
      sy: (opts.sy || 1) * rng.range(0.80, 1.13),
      sz: (opts.sz || 1) * rng.range(0.88, 1.14)
    };
    var yaw = opts.yaw === undefined ? rng.range(0, 6.283) : opts.yaw;
    if (rng.bool(opts.topple === undefined ? 0.12 : opts.topple)) {
      if (rng.bool(0.5)) {
        // fully over onto a long side; the lift is half the crate's width
        o.roll = rng.sign() * (Math.PI * 0.5 + rng.gaussian(0, 0.07));
        o.lift += 0.26 * o.sx;
        o.tilt = 0.04;
      } else {
        // stacked askew - the top box of a pile that somebody kicked
        o.pitch = rng.sign() * rng.range(0.26, 0.44);
        o.lift += 0.05;
      }
    }
    return this._drop(name, x, z, yaw, o);
  };

  // Distance `d` from a facade, measured into the street.
  Props.prototype._in = function (x, side, d) { return x - side * d; };

  // Yaw that makes a prop's local +Z face the street from `side`.
  Props.prototype._faceStreet = function (side) { return -side * Math.PI * 0.5; };

  Props.prototype._addStatic = function (key, geo, matrix) {
    if (!geo) return;
    if (matrix && matrix.elements) {
      var e = matrix.elements;
      if (this._inSightline(e[12], e[13], e[14])) {
        this._sightSkipped++;
        if (geo.dispose) geo.dispose();
        return;
      }
    }
    this.S[key].push(part(geo, matrix));
  };

  // --------------------------------------------------------------------------
  // Market: the ground floor of this street is a souk.  Stalls, canopies,
  // produce crates, sacks of grain, plastic chairs, a hand cart.
  // --------------------------------------------------------------------------
  Props.prototype._dressMarket = function () {
    var rng = this.rng;
    var canopies = ['canopyRed', 'canopyOchre', 'canopyTeal'];
    var stallCount = 0;

    for (var si = 0; si < 2; si++) {
      var side = si === 0 ? -1 : 1;
      // Stagger the two sides so stalls never line up across the street.
      var z = this.z1 - 3.5 - (si * 3.1);
      while (z > this.z0 + 3.5) {
        var gap = rng.range(4.6, 7.2);
        var fac = this._facade(z, side);
        if (!fac.solid) { z -= gap; continue; }
        // leave the odd shopfront empty; a solid rank of stalls looks stamped
        if (rng.bool(0.16)) { z -= gap; continue; }

        var yaw = this._faceStreet(side) + rng.range(-0.05, 0.05);
        var cx = this._in(fac.x, side, 0.63);
        var gy = this._ground(cx, z);
        stallCount++;

        // ---- frame -------------------------------------------------------
        this._drop('stall', cx, z, yaw, { y: gy, tilt: 0.012, tint: 0xd8cbb4, vLo: 0.72, vHi: 1.06, hue: 0.05 });
        // half-extents are in the stall's own frame: 2.5m of frontage, 1.15 deep
        this._collider(cx, gy + 0.5, z, 1.25, 0.5, 0.58, yaw, 'wood');

        // ---- overhead cover ----------------------------------------------
        var roll = rng.next();
        if (roll < 0.74) {
          var cname = canopies[stallCount % 3];
          this._drop(cname, this._in(fac.x, side, 0.04), z, yaw, {
            y: gy + rng.range(2.72, 3.00), tilt: 0.02,
            tint: 0xffffff, vLo: 0.80, vHi: 1.08, hue: 0.03,
            sx: rng.range(0.95, 1.12), sy: 1, sz: rng.range(0.92, 1.1)
          });
        }
        if (roll > 0.45) {
          this._drop('awning', this._in(fac.x, side, 0.02), z + rng.range(-0.2, 0.2), yaw, {
            y: gy + rng.range(3.35, 3.85), tilt: 0.014,
            tint: 0xc7bcab, vLo: 0.72, vHi: 1.1, hue: 0.05,
            sx: rng.range(0.9, 1.15), sy: 1, sz: rng.range(0.85, 1.05)
          });
        }

        // ---- goods on and around the counter ------------------------------
        var nCrates = rng.int(3, 6);
        for (var c = 0; c < nCrates; c++) {
          var stack = rng.int(0, 2);
          var bx = this._in(fac.x, side, rng.range(1.35, 2.25));
          var bz = z + rng.range(-1.35, 1.35);
          var bgy = this._ground(bx, bz);
          for (var s2 = 0; s2 <= stack; s2++) {
            this._crate(bx + rng.range(-0.06, 0.06) * s2, bz + rng.range(-0.06, 0.06) * s2, {
              y: bgy + s2 * 0.345,
              tilt: s2 ? 0.05 : 0.02,
              tint: 0xc6b294, vLo: 0.66, vHi: 1.16, hue: 0.075,
              topple: s2 === stack && stack > 0 ? 0.22 : 0.04
            });
          }
          if (stack >= 1) {
            this._collider(bx, this._ground(bx, bz) + 0.35, bz, 0.3, 0.35, 0.24, 0, 'wood');
          }
        }
        // crates ON the counter, at working height
        for (c = 0; c < rng.int(1, 3); c++) {
          this._crate(this._in(fac.x, side, rng.range(0.35, 0.95)), z + rng.range(-0.9, 0.9), {
            y: gy + 0.90, tilt: 0.02,
            tint: 0xcdb896, vLo: 0.7, vHi: 1.15, hue: 0.07,
            sx: 0.92, sy: 0.82, sz: 0.95, topple: 0.16
          });
        }
        // sacks leaning on the stall legs
        for (c = 0; c < rng.int(2, 5); c++) {
          var sx2 = this._in(fac.x, side, rng.range(0.35, 1.15));
          var sz3 = z + rng.range(-1.3, 1.3);
          this._drop('sack', sx2, sz3, rng.range(0, 6.283), {
            tilt: 0.14, tint: 0xd6c6a4, vLo: 0.72, vHi: 1.12, hue: 0.05,
            sx: rng.range(0.88, 1.15), sy: rng.range(0.85, 1.2), sz: rng.range(0.88, 1.15)
          });
        }
        // a chair, sometimes tipped over
        if (rng.bool(0.72)) {
          var chx = this._in(fac.x, side, rng.range(1.4, 2.5));
          var chz = z + rng.range(-1.8, 1.8);
          if (rng.bool(0.24)) {
            var b = this.B.chair;
            if (b) {
              b.add(T(chx, this._ground(chx, chz) + 0.22, chz,
                Math.PI * 0.5 + rng.range(-0.2, 0.2), rng.range(0, 6.283), rng.range(-0.2, 0.2)),
                this._jit(rng.pick([0x9fb0a6, 0xb8b0a0, 0x8a9aa8, 0xc0b49a]), 0.7, 1.15, 0.06));
            }
          } else {
            this._drop('chair', chx, chz, rng.range(0, 6.283), {
              tilt: 0.03, color: this._jit(rng.pick([0x9fb0a6, 0xb8b0a0, 0x8a9aa8, 0xc0b49a]), 0.7, 1.15, 0.06)
            });
          }
        }
        // hanging scale under the head rail
        if (rng.bool(0.35)) {
          this._addStatic('rust', K.hangingScale(),
            Tn(this._in(fac.x, side, rng.range(0.5, 0.9)), gy + 2.1, z + rng.range(-0.8, 0.8), 0, rng.range(0, 6.28), 0));
        }
        // litter accumulates in front of a stall
        this._litter(this._in(fac.x, side, rng.range(1.6, 3.0)), z, 1.6, rng.int(3, 7));

        z -= gap;
      }
    }

    // A hand cart parked against the kerb, plus a couple of loose pallets.
    var cz = this.z1 - rng.range(9, 16);
    var cside = rng.bool() ? -1 : 1;
    var cfac = this._facade(cz, cside);
    var cartX = this._in(cfac.x, cside, 2.1);
    this._addStatic('wood', K.cart(),
      Tn(cartX, this._ground(cartX, cz), cz, 0, this._faceStreet(cside) + rng.range(-0.3, 0.3), 0));
    this._collider(cartX, this._ground(cartX, cz) + 0.5, cz, 0.85, 0.5, 0.6, 0, 'wood');
    for (var i = 0; i < rng.int(2, 4); i++) {
      this._crate(cartX + rng.range(-0.5, 0.5), cz + rng.range(-0.4, 0.4), {
        y: this._ground(cartX, cz) + 0.66, tilt: 0.05,
        tint: 0xc9b592, vLo: 0.7, vHi: 1.12, hue: 0.07, topple: 0.2
      });
    }
  };

  // Where loose rubbish actually ends up.  Nothing stays in the middle of a
  // carriageway: wind and traffic sweep it to the gutter line, so a sampled
  // point out in the open road is dragged most of the way there before it is
  // dropped.  Points already on the pavement, or outside the street corridor
  // entirely (alley, interior, rooftop) are left where they were.
  Props.prototype._litterBias = function (px, pz, out) {
    out.x = px; out.z = pz;
    var gutter = M.clamp(this.halfW - 2.35, 1.4, this.halfW - 0.3);
    if (Math.abs(px) > this.halfW + 1.2) return out;     // not in the street
    if (Math.abs(px) >= gutter) return out;              // already at the kerb
    var side = px >= 0 ? 1 : -1;
    if (Math.abs(px) < 0.35) side = this.rng.sign();
    var b = this.rng.range(0.6, 0.82);
    out.x = M.lerp(px, side * gutter, b) + this.rng.gaussian(0, 0.22);
    out.z = pz + this.rng.gaussian(0, 0.18);
    return out;
  };

  // Scatter a handful of litter (paper + a few small stones) around a point.
  var _litP = { x: 0, z: 0 };
  Props.prototype._litter = function (x, z, radius, count) {
    var rng = this.rng;
    for (var i = 0; i < count; i++) {
      // gaussian, not uniform: rubbish clumps
      this._litterBias(x + rng.gaussian(0, radius * 0.45), z + rng.gaussian(0, radius * 0.55), _litP);
      this._drop('paper', _litP.x, _litP.z, rng.range(0, 6.283), {
        // dirty newsprint / soaked cardboard, with enough hue spread that a
        // scatter never reads as one repeated decal
        tilt: 0.20, tint: 0xbfb6a4, vLo: 0.34, vHi: 0.84, hue: 0.12,
        scale: rng.range(0.75, 1.35), lift: 0.002
      });
      if (rng.bool(0.6)) {
        this._litterBias(x + rng.gaussian(0, radius * 0.6), z + rng.gaussian(0, radius * 0.6), _litP);
        this._drop('pebble', _litP.x, _litP.z, rng.range(0, 6.283), {
          tilt: 0.5, tint: 0xb5aea3, vLo: 0.6, vHi: 1.2, hue: 0.05,
          scale: rng.range(0.6, 1.5)
        });
      }
    }
  };

  // --------------------------------------------------------------------------
  // Industrial: drums, cylinders, jerry cans, pallets, spools.  These cluster -
  // somebody stacked them somewhere for a reason - they are never sprinkled.
  // --------------------------------------------------------------------------
  Props.prototype._dressIndustrial = function () {
    var rng = this.rng;
    var i, j;

    // Pick cluster anchors: against facades, biased to the ends of the street
    // and to any gap (a yard or alley mouth).
    var anchors = [];
    for (i = 0; i < 9; i++) {
      var side = rng.bool() ? -1 : 1;
      var z = M.lerp(this.z0 + 3, this.z1 - 3, rng.next());
      var fac = this._facade(z, side);
      anchors.push({ x: this._in(fac.x, side, rng.range(0.7, 1.9)), z: z, side: side, solid: fac.solid });
    }

    for (i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      var nDrums = rng.int(2, 6);
      for (j = 0; j < nDrums; j++) {
        // pack them shoulder-to-shoulder along the wall line, with a bit of slop
        var t = (j - (nDrums - 1) * 0.5) * rng.range(0.60, 0.72);
        var dx = a.x + rng.range(-0.16, 0.16);
        var dz = a.z + t;
        var tipped = rng.bool(0.18);
        var tint = rng.pick([0x8a4a2a, 0x5a6a5c, 0x6a6f74, 0x8f7a44, 0x7a3c2e]);
        if (tipped) {
          // rolled over onto its side, nestled against the wall
          var b = this.B.drum;
          if (b) {
            var gy = this._ground(dx, dz);
            b.add(T(this._in(a.x, a.side, rng.range(-0.2, 0.35)), gy + 0.288, dz,
              rng.range(0, 6.283), Math.PI * 0.5 + rng.gaussian(0, 0.03), rng.gaussian(0, 0.05),
              1, 1, 1), this._jit(tint, 0.7, 1.18, 0.07));
            this._collider(dx, gy + 0.28, dz, 0.45, 0.29, 0.29, 0, 'metal');
          }
        } else {
          this._drop('drum', dx, dz, rng.range(0, 6.283), {
            tilt: 0.028, color: this._jit(tint, 0.7, 1.18, 0.07),
            sx: rng.range(0.97, 1.03), sy: rng.range(0.96, 1.04), sz: rng.range(0.97, 1.03)
          });
          this._collider(dx, this._ground(dx, dz) + 0.44, dz, 0.3, 0.44, 0.3, 0, 'metal');
          // stacked drum, occasionally
          if (rng.bool(0.16)) {
            this._drop('drum', dx + rng.range(-0.06, 0.06), dz + rng.range(-0.06, 0.06),
              rng.range(0, 6.283), {
                y: this._ground(dx, dz) + 0.885, tilt: 0.03,
                color: this._jit(tint, 0.7, 1.18, 0.07)
              });
          }
        }
        // oil pooling under a drum is a free storytelling beat
        if (rng.bool(0.4)) this._decal(dx + rng.range(-0.3, 0.3), dz + rng.range(-0.3, 0.3),
          rng.range(0.7, 1.5), 0, 0x2a2622, rng.range(0.5, 0.95));
      }

      // jerry cans and cylinders sit tight against the drums
      for (j = 0; j < rng.int(0, 3); j++) {
        this._drop('jerrycan', a.x + rng.range(-0.35, 0.35), a.z + rng.range(-1.9, 1.9),
          rng.range(0, 6.283), {
            tilt: 0.04, color: this._jit(rng.pick([0x5c6349, 0x6b6f5e, 0x7a4a34, 0x494f56]), 0.75, 1.15, 0.06)
          });
      }
      if (rng.bool(0.55)) {
        for (j = 0; j < rng.int(1, 4); j++) {
          this._drop('cylinder', a.x + rng.range(-0.3, 0.3), a.z + rng.range(-1.6, 1.6),
            rng.range(0, 6.283), {
              tilt: 0.03, color: this._jit(rng.pick([0xb04a3a, 0xd8c48a, 0x4a6a7a, 0x8a9098]), 0.78, 1.12, 0.05)
            });
        }
      }
      // pallets: flat stacks, or leaned against the wall
      for (j = 0; j < rng.int(0, 3); j++) {
        if (rng.bool(0.45) && a.solid) {
          // leaned: rotate about the wall-parallel axis so it rests on the wall
          var lb = this.B.pallet;
          if (lb) {
            var lz = a.z + rng.range(-2.2, 2.2);
            var lx = this._in(a.x, a.side, rng.range(-0.55, -0.25));
            var lgy = this._ground(lx, lz);
            lb.add(T(lx, lgy + 0.58, lz,
              this._faceStreet(a.side) + rng.range(-0.15, 0.15),
              0, -a.side * rng.range(1.15, 1.32)),
              this._jit(0xbda98a, 0.68, 1.14, 0.06));
          }
        } else {
          var pz = a.z + rng.range(-2.4, 2.4);
          var px = a.x + rng.range(-0.4, 0.4);
          var h = rng.int(1, 4);
          for (var k = 0; k < h; k++) {
            this._drop('pallet', px + rng.range(-0.04, 0.04), pz + rng.range(-0.04, 0.04),
              rng.range(0, 6.283), {
                y: this._ground(px, pz) + k * 0.146, tilt: 0.02,
                tint: 0xbda98a, vLo: 0.68, vHi: 1.14, hue: 0.06
              });
          }
          if (h >= 2) this._collider(px, this._ground(px, pz) + h * 0.073, pz, 0.6, h * 0.073, 0.4, 0, 'wood');
        }
      }
    }

    // Cable spools and toolboxes near the industrial end.
    for (i = 0; i < 5; i++) {
      var ss = rng.bool() ? -1 : 1;
      var sz = M.lerp(this.z0 + 4, this.z0 + 18, rng.next());
      var sf = this._facade(sz, ss);
      var sx = this._in(sf.x, ss, rng.range(0.9, 2.0));
      this._drop('spool', sx, sz, rng.range(0, 6.283), {
        tilt: 0.02, tint: 0xbda98a, vLo: 0.7, vHi: 1.1, hue: 0.05
      });
      this._collider(sx, this._ground(sx, sz) + 0.6, sz, 0.6, 0.6, 0.4, 0, 'wood');
    }
    for (i = 0; i < 7; i++) {
      var ts = rng.bool() ? -1 : 1;
      var tz = M.lerp(this.z0 + 3, this.z1 - 3, rng.next());
      var tf = this._facade(tz, ts);
      this._drop('toolbox', this._in(tf.x, ts, rng.range(0.5, 1.6)), tz, rng.range(0, 6.283), {
        tilt: 0.05, color: this._jit(rng.pick([0x8a3a30, 0x3a4a5a, 0x4a5a3a, 0x6a6a6a]), 0.75, 1.1, 0.05)
      });
    }
  };

  // --------------------------------------------------------------------------
  // Street furniture: bollards, lamps, signage, bins, a bus shelter, a phone
  // junction box, a dumpster.  This is the layer that says "municipality".
  // --------------------------------------------------------------------------
  Props.prototype._dressStreetFurniture = function () {
    var rng = this.rng;
    var i, z, side, fac, x, gy;

    // ---- bollards: runs along both pavements, with a few knocked flat -----
    // Bollards are the strongest leading line available for the street shot,
    // so they are laid as a regular rank with only small placement error.
    for (var run = 0; run < 2; run++) {
      var bside = run === 0 ? -1 : 1;
      var bz0 = M.lerp(this.z1 - 4, this.z1 - 16, rng.next());
      var spacing = rng.range(2.9, 3.5);
      var nB = rng.int(10, 16);
      for (i = 0; i < nB; i++) {
        z = bz0 - i * spacing + rng.gaussian(0, 0.08);
        if (z < this.z0 + 2) break;
        fac = this._facade(z, bside);
        x = this._in(fac.x, bside, rng.range(2.08, 2.24));
        gy = this._ground(x, z);
        if (rng.bool(0.13)) {
          // sheared off at the base - something drove through here
          var b = this.B.bollard;
          if (b) {
            b.add(T(x + rng.range(-0.4, 0.4), gy + 0.08, z + rng.range(-0.5, 0.5),
              rng.range(0, 6.283), Math.PI * 0.5 + rng.gaussian(0, 0.12), rng.gaussian(0, 0.2),
              1, rng.range(0.5, 0.85), 1), this._jit(0x6a7076, 0.7, 1.12, 0.04));
          }
        } else {
          this._drop('bollard', x, z, rng.range(0, 6.283), {
            tilt: 0.05, tint: 0x7d858c, vLo: 0.72, vHi: 1.14, hue: 0.045
          });
          this._collider(x, gy + 0.45, z, 0.11, 0.45, 0.11, 0, 'metal');
        }
      }
    }

    // ---- street lamps, alternating sides ---------------------------------
    var lz = this.z1 - rng.range(2, 6);
    var lside = -1;
    while (lz > this.z0 + 3) {
      fac = this._facade(lz, lside);
      x = this._in(fac.x, lside, rng.range(0.55, 0.95));
      gy = this._ground(x, lz);
      this._drop('lamp', x, lz, this._faceStreet(lside) + rng.range(-0.08, 0.08), {
        y: gy, tilt: 0.008, tint: 0x8a9299, vLo: 0.78, vHi: 1.1, hue: 0.04,
        sy: rng.range(0.94, 1.06)
      });
      this._collider(x, gy + 1.2, lz, 0.13, 1.2, 0.13, 0, 'metal');
      // rubbish always collects at the foot of a lamp post
      this._litter(x, lz, 0.7, rng.int(2, 5));
      lside = -lside;
      lz -= rng.range(12, 17);
    }

    // ---- signage ----------------------------------------------------------
    // Two kinds: flat boards bolted to the plaster, and projecting shop signs.
    for (i = 0; i < 22; i++) {
      side = i % 2 === 0 ? -1 : 1;
      z = M.lerp(this.z0 + 3, this.z1 - 3, rng.next());
      fac = this._facade(z, side, rng.bool(0.55) ? 2.6 : 3.9);
      if (!fac.solid) continue;
      var yawS = this._faceStreet(side);
      var sy = this._ground(0, z) + rng.range(2.45, 4.3);
      var scale = rng.range(0.75, 1.5);
      if (rng.bool(0.45)) {
        // projecting sign on a bracket, perpendicular to the wall
        this._addStatic('rust', K.signBracket(),
          Tn(this._in(fac.x, side, 0.06), sy + 0.44 * scale, z, 0, yawS, 0));
        this._drop('signPanel', this._in(fac.x, side, 0.55 * scale + 0.1), z, yawS + Math.PI * 0.5, {
          y: sy, tilt: 0.01, tint: 0xffffff, vLo: 0.72, vHi: 1.06, hue: 0.03,
          sx: scale, sy: scale * rng.range(0.8, 1.25), sz: 1
        });
      } else {
        // flat against the facade
        this._drop('signPanel', this._in(fac.x, side, 0.07), z, yawS, {
          y: sy, tilt: 0.008, tint: 0xffffff, vLo: 0.72, vHi: 1.08, hue: 0.03,
          sx: scale * rng.range(1.0, 1.9), sy: scale * rng.range(0.85, 1.3), sz: 1
        });
      }
    }

    // ---- bins -------------------------------------------------------------
    for (i = 0; i < 11; i++) {
      side = rng.bool() ? -1 : 1;
      z = M.lerp(this.z0 + 3, this.z1 - 3, rng.next());
      fac = this._facade(z, side);
      x = this._in(fac.x, side, rng.range(0.5, 1.3));
      gy = this._ground(x, z);
      if (rng.bool(0.16)) {
        // tipped over, contents spilled downwind
        var bb = this.B.bin;
        if (bb) {
          bb.add(T(x, gy + 0.28, z, rng.range(0, 6.283), Math.PI * 0.46 + rng.gaussian(0, 0.1),
            rng.gaussian(0, 0.15), 1, 1, 1), this._jit(0x5f6a63, 0.7, 1.1, 0.05));
          this._litter(this._in(x, side, 0.9), z, 1.1, rng.int(6, 12));
        }
      } else {
        this._drop('bin', x, z, rng.range(0, 6.283), {
          tilt: 0.035, color: this._jit(rng.pick([0x5f6a63, 0x4a5560, 0x6a5a48]), 0.72, 1.12, 0.05)
        });
        this._collider(x, gy + 0.35, z, 0.3, 0.35, 0.3, 0, 'metal');
        this._litter(x, z, 0.8, rng.int(2, 6));
      }
    }

    // ---- bus shelter (shot out) -------------------------------------------
    var shz = M.lerp(this.z1 - 4, this.z1 - 18, rng.next());
    var shside = 1;
    var shf = this._facade(shz, shside);
    var shx = this._in(shf.x, shside, 1.45);
    var shgy = this._ground(shx, shz);
    var shyaw = this._faceStreet(shside);
    this._addStatic('painted', K.busShelter(), Tn(shx, shgy, shz, 0, shyaw, 0));
    var glass = K.shelterGlass(rng);
    if (glass) {
      var gm = new THREE.Mesh(glass, this.mats.glass);
      gm.position.set(shx, shgy, shz);
      gm.rotation.set(0, shyaw, 0);
      gm.name = 'props_shelterGlass';
      gm.castShadow = false;
      gm.receiveShadow = false;
      gm.renderOrder = 2;
      this.root.add(gm);
      this._shelterGlass = gm;
    }
    this._collider(shx, shgy + 1.2, shz, 1.85, 1.2, 0.12, shyaw, 'metal');
    // The glass that is NOT still in the frame is all over the pavement.
    this._glassField(shx, shz, 2.4, 1.6, 130, shyaw);
    this._decal(shx, shz, 3.2, 2, 0xbfae90, 0.4, shyaw, 1.5);

    // ---- dumpster in the side alley / a service bay ----------------------
    var dz = M.lerp(this.z0 + 6, this.z1 - 6, rng.next());
    var dside = 1;
    var dfac = this._facade(dz, dside);
    var dx = this._in(dfac.x, dside, 0.95);
    var dgy = this._ground(dx, dz);
    this._addStatic('painted', K.dumpster(),
      Tn(dx, dgy, dz, 0, this._faceStreet(dside) + rng.range(-0.12, 0.12), 0));
    this._collider(dx, dgy + 0.6, dz, 0.6, 0.6, 0.95, this._faceStreet(dside), 'metal');
    this._litter(this._in(dx, dside, 1.1), dz, 1.4, 14);
    this._decal(dx, dz + 1.4, 2.0, 3, 0x30302c, 0.55);

    // ---- phone / power junction boxes on the plaster --------------------
    for (i = 0; i < 5; i++) {
      side = rng.bool() ? -1 : 1;
      z = M.lerp(this.z0 + 4, this.z1 - 4, rng.next());
      fac = this._facade(z, side, 1.8);
      if (!fac.solid) continue;
      this._addStatic('painted', K.junctionBox(),
        Tn(this._in(fac.x, side, 0.09), this._ground(0, z) + rng.range(1.5, 1.9), z,
          0, this._faceStreet(side), 0));
    }
  };

  // --------------------------------------------------------------------------
  // Military: a checkpoint at the south end - sandbag emplacements built by
  // hand (so: irregular), jersey barriers in a chicane, ammo crates, wire.
  // --------------------------------------------------------------------------
  Props.prototype._dressMilitary = function () {
    var rng = this.rng;
    var i;

    // ---- sandbag walls ----------------------------------------------------
    // A real sandbag wall is laid in courses by a tired soldier, and it is the
    // IRREGULARITY that sells it.  The previous version alternated a clean
    // half-bag offset and stepped a constant course height, which produced a
    // textbook running bond - a brick lattice, exactly the geometry that shows
    // up as horizontal repetition in the frame statistics and reads as flat
    // brick-red rectangles rather than as filled sacks.
    //
    // So: per-course phase is continuous rather than 0/1/2, each course sags
    // toward the middle under the weight above it, bags sit slightly proud or
    // recessed across the wall face, the odd bag is missing, and the ends slump
    // instead of stopping square.
    var self = this;
    // Sacking is bought in job lots and weathers at different rates: new bags
    // are pale jute, old ones are sun-bleached grey, damp ones darken to olive.
    var BAG_TINTS = [0xb8a67f, 0xa9976f, 0xc4b28c, 0x9d8e6c, 0xc9bd9c,
                     0x8f8163, 0xb0a488, 0xd0c1a0, 0xa89a76, 0xbcae90,
                     0x94906f, 0xd4c8a6];
    function sandbagWall(cx, cz, yaw, length, courses, taper) {
      // Courses overlap on Y by a quarter of a bag so no daylight shows
      // between them, but bags in a course only just touch: overlapping them
      // along the run buries both tied ends in the neighbours and leaves only
      // the middle bulge visible, which is what made the wall read as a stack
      // of clam shells rather than as individual sacks.
      var bagW = 0.40, bagH = 0.128;
      var dirX = Math.cos(yaw), dirZ = -Math.sin(yaw);
      var perpX = -dirZ, perpZ = dirX;
      var gy = self._ground(cx, cz);
      var b = self.B.sandbag;
      if (!b) return;
      // the whole wall leans and settles a little
      var lean = rng.gaussian(0, 0.035);
      var settle = rng.range(0.02, 0.075);      // how much the middle sinks
      for (var c = 0; c < courses; c++) {
        // shorten upper courses so the wall has a profile, not a slab
        var lenC = length * (1 - (taper || 0.12) * c);
        var n = Math.max(1, Math.round(lenC / (bagW * 0.985)));
        // continuous phase, not a two-state running bond
        var off = rng.next();
        for (var k = 0; k < n; k++) {
          if (c > 0 && rng.bool(0.04)) continue;         // a bag never got laid
          var u = n > 1 ? (k / (n - 1)) : 0.5;           // 0..1 along the course
          var t = (k + off - (n - 1) * 0.5) * bagW * rng.range(0.94, 1.03);
          // the ends of a hand-built wall slump; the middle settles
          var endSlump = Math.pow(Math.abs(u - 0.5) * 2, 3.0);
          var dip = Math.sin(Math.PI * u) * settle * (c / Math.max(1, courses - 1));
          var proud = rng.gaussian(0, 0.045);            // in/out of the face
          var px = cx + dirX * t + perpX * proud + rng.gaussian(0, 0.028);
          var pz = cz + dirZ * t + perpZ * proud + rng.gaussian(0, 0.028);
          var py = gy + c * bagH * rng.range(0.90, 1.02) - dip
            - endSlump * c * bagH * 0.55 + rng.gaussian(0, 0.011);
          // every few bags is laid crosswise as a header, which is what makes a
          // real emplacement look built rather than extruded
          var cross = rng.bool(0.22);
          b.add(T(px, py, pz,
            yaw + (cross ? Math.PI * 0.5 : 0) + rng.gaussian(0, 0.22),
            rng.gaussian(0, 0.07) + lean, rng.gaussian(0, 0.09) + endSlump * rng.sign() * 0.22,
            rng.range(0.90, 1.16), rng.range(0.82, 1.12), rng.range(0.90, 1.18)),
            self._jit(rng.pick(BAG_TINTS), 0.74, 1.20, 0.085));
        }
      }
      self._collider(cx, gy + courses * bagH * 0.5, cz,
        length * 0.5, courses * bagH * 0.5 + 0.02, 0.20, yaw, 'sand');
      // sand always drifts out from the base of a sandbag wall
      self._decal(cx, cz, length * 1.15, 2, 0xc9b08a, 0.5, yaw, 0.28);
      // and a couple of split bags have spilled at the foot of it
      for (var s3 = 0; s3 < 2; s3++) {
        var st = rng.range(-0.4, 0.4) * length;
        var sxp = cx + dirX * st + perpX * rng.range(0.28, 0.55) * rng.sign();
        var szp = cz + dirZ * st + perpZ * rng.range(0.28, 0.55) * rng.sign();
        b.add(T(sxp, self._ground(sxp, szp) + 0.055, szp,
          rng.range(0, 6.283), rng.gaussian(0, 0.22), rng.gaussian(0, 0.25),
          rng.range(0.95, 1.15), rng.range(0.55, 0.8), rng.range(0.95, 1.2)),
          self._jit(rng.pick(BAG_TINTS), 0.78, 1.1, 0.07));
        self._decal(sxp, szp, rng.range(0.5, 0.95), 2, 0xc9b08a, rng.range(0.4, 0.7));
      }
    }

    // THE POSITION FACES THE THREAT.
    //
    // This block used to lay both primary walls ALONG the street at x ~ +/-4.5
    // and put the wire, the chicane and the spent brass on the SOUTH side of
    // them - i.e. between the player, who spawns at the south end looking north,
    // and the level.  The camera was therefore looking into the back of its own
    // firing position, which is tactically backwards and was the direct cause of
    // a 1.15 m sandbag wall screening the entire right-hand shopfront row from
    // 4.6 m out to 9 m.
    //
    // A real emplacement's parapet runs ACROSS the axis of advance with a
    // vehicle lane through it; you stand BEHIND it and look over.  So: two
    // outboard parapet sections leaving a clear lane down the middle, each with
    // an L-return along the street behind it, brass and ammunition on the near
    // side where the shooter is, and wire plus barriers pushed downrange.
    var czBase = this.z1 - rng.range(9.5, 12.0);
    var wFac = this._facade(czBase, -1), eFac = this._facade(czBase, 1);
    var gapHalf = rng.range(2.9, 3.5);
    var wKerb = Math.abs(this._in(wFac.x, -1, 0.55));
    var eKerb = Math.abs(this._in(eFac.x, 1, 0.55));
    var wLen = M.clamp(wKerb - gapHalf, 1.6, 4.4);
    var eLen = M.clamp(eKerb - gapHalf, 1.6, 4.4);
    var w1x = -(gapHalf + wLen * 0.5);
    var e1x = (gapHalf + eLen * 0.5);
    var eBaseZ = czBase - rng.range(0.5, 1.5);      // staggered, not a single line
    sandbagWall(w1x, czBase, rng.range(-0.06, 0.06), wLen, rng.int(7, 9), 0.11);
    sandbagWall(e1x, eBaseZ, rng.range(-0.06, 0.06), eLen, rng.int(7, 9), 0.11);
    // L-returns folding back along the street on the outboard flank, so the
    // position has depth instead of being a single screen.
    sandbagWall(w1x - wLen * 0.5 + 0.22, czBase + rng.range(1.5, 2.2),
      Math.PI * 0.5 + rng.range(-0.1, 0.1), rng.range(2.2, 3.0), rng.int(5, 7), 0.16);
    sandbagWall(e1x + eLen * 0.5 - 0.22, eBaseZ + rng.range(1.2, 1.9),
      Math.PI * 0.5 + rng.range(-0.1, 0.1), rng.range(1.9, 2.7), rng.int(4, 6), 0.18);
    // A second, half-built position further up the street: courses laid, bags
    // still stacked beside it - somebody stopped work in a hurry.
    var czB = M.lerp(this.z0 + 6, czBase - 12, rng.next());
    var b2side = rng.bool() ? -1 : 1;
    var b2f = this._facade(czB, b2side);
    var b2x = this._in(b2f.x, b2side, rng.range(1.5, 2.4));
    sandbagWall(b2x, czB, Math.PI * 0.5 + rng.range(-0.2, 0.2), rng.range(3.0, 4.4), rng.int(3, 5), 0.2);
    for (i = 0; i < rng.int(8, 16); i++) {
      var lx2 = b2x + rng.gaussian(0, 0.55), lz2 = czB + rng.gaussian(0, 1.6);
      var lb2 = this.B.sandbag;
      if (lb2) {
        lb2.add(T(lx2, this._ground(lx2, lz2) + rng.range(0.0, 0.16), lz2,
          rng.range(0, 6.283), rng.gaussian(0, 0.3), rng.gaussian(0, 0.3),
          rng.range(0.92, 1.1), rng.range(0.85, 1.05), rng.range(0.92, 1.1)),
          this._jit(rng.pick([0xb8a67f, 0xa9976f, 0xc4b28c]), 0.82, 1.12, 0.05));
      }
    }
    // A low sangar around a doorway, on the opposite side.
    var czC = M.lerp(czBase - 4, this.z0 + 10, rng.next());
    var c3side = -b2side;
    var c3f = this._facade(czC, c3side);
    var c3x = this._in(c3f.x, c3side, rng.range(0.9, 1.5));
    sandbagWall(c3x, czC, rng.range(-0.2, 0.2), rng.range(1.6, 2.4), rng.int(4, 6), 0.16);
    sandbagWall(this._in(c3x, c3side, -0.6), czC + rng.range(1.0, 1.4),
      Math.PI * 0.5 + rng.range(-0.2, 0.2), rng.range(1.4, 2.0), rng.int(3, 5), 0.2);

    // Brass and ammunition on the NEAR side of the parapet - that is where the
    // shooter stands, it is the detail that sells the position, and at 0.05 m
    // (brass) and 0.34 m (crates) it all sits comfortably below the sightline.
    this._brassField(e1x + rng.range(-1.0, 0.3), eBaseZ + rng.range(0.9, 1.7), 1.4, 1.1, 90);
    this._brassField(w1x + rng.range(-0.3, 1.0), czBase + rng.range(0.9, 1.7), 1.2, 1.0, 55);
    for (i = 0; i < rng.int(5, 9); i++) {
      var ax = (rng.bool() ? w1x : e1x) + rng.range(-1.1, 1.1);
      var az = czBase + rng.range(0.6, 2.6);
      var stack = rng.int(0, 2);
      for (var s = 0; s <= stack; s++) {
        this._drop('ammocrate', ax + rng.range(-0.04, 0.04), az + rng.range(-0.04, 0.04),
          rng.range(0, 6.283), {
            y: this._ground(ax, az) + s * 0.345, tilt: 0.025,
            tint: 0x8f8a6a, vLo: 0.74, vHi: 1.1, hue: 0.05
          });
      }
      this._collider(ax, this._ground(ax, az) + 0.18 + stack * 0.17, az, 0.4, 0.18 + stack * 0.17, 0.2, 0, 'wood');
    }
    for (i = 0; i < rng.int(2, 4); i++) {
      var bx = e1x + rng.range(-1.2, 0.4), bz = eBaseZ + rng.range(1.4, 3.0);
      this._drop('ammocrate', bx, bz, rng.range(0, 6.283), {
        tilt: 0.03, tint: 0x8f8a6a, vLo: 0.74, vHi: 1.1, hue: 0.05
      });
    }

    // ---- jersey barrier chicane ------------------------------------------
    // DOWNRANGE of the parapet, so it reads as the far side of the checkpoint
    // and supplies a mid-ground beat at 12-20 m rather than a foreground
    // blocker at 3-5 m.  Kept out of the lane the hero cameras look down.
    var jz = czBase - rng.range(8, 12);
    var lanes = [-1, 1];
    for (i = 0; i < 7; i++) {
      var lane = lanes[i % 2];
      var jx = lane * rng.range(2.4, 4.8);
      var jzz = jz - i * rng.range(2.8, 4.0);
      if (jzz < this.z0 + 8) break;
      if (this._blocked(jx, 0.5, jzz, 0.5)) continue;
      var jgy = this._ground(jx, jzz);
      if (this._inSightline(jx, jgy + 0.42, jzz)) continue;
      var jyaw = rng.bool(0.65) ? rng.range(-0.16, 0.16) : Math.PI * 0.5 + rng.range(-0.3, 0.3);
      this._drop('jersey', jx, jzz, jyaw, {
        y: jgy, tilt: 0.012, tint: 0xb0aca3, vLo: 0.78, vHi: 1.1, hue: 0.03
      });
      this._collider(jx, jgy + 0.42, jzz, 0.31, 0.42, 1.2, jyaw, 'concrete');
      // scuffed and clipped by vehicles
      if (rng.bool(0.5)) this._decal(jx + rng.range(-1, 1), jzz + rng.range(-1.4, 1.4),
        rng.range(1.0, 2.2), 3, 0x33322e, rng.range(0.3, 0.6));
    }

    // ---- checkpoint barrier ----------------------------------------------
    var kz = this.z1 - rng.range(1.5, 3.5);
    var kside = rng.bool() ? -1 : 1;
    var kfac = this._facade(kz, kside);
    var kx = this._in(kfac.x, kside, rng.range(1.6, 2.6));
    var barrier = K.checkpointArm();
    if (barrier) {
      var bm = new THREE.Mesh(barrier, this.mats.paintedWarm);
      bm.position.set(kx, this._ground(kx, kz), kz);
      bm.rotation.set(0, this._faceStreet(kside) + rng.range(-0.2, 0.2), 0);
      bm.castShadow = true;
      bm.receiveShadow = true;
      bm.name = 'props_checkpoint';
      this.root.add(bm);
      this._collider(kx, this._ground(kx, kz) + 0.5, kz, 0.25, 0.5, 0.25, 0, 'metal');
    }

    // ---- concertina wire --------------------------------------------------
    // Wire is a LATERAL obstacle.  The version this replaces laid a 2.8-4.6 m
    // coil dead centre of a 10 m roadway, 1.6-10.6 m in front of the street
    // camera, with rotation.y = PI/2 so its axis pointed straight down -Z at
    // the lens: a tunnel around the aim point rather than an obstacle across
    // it, floating 0.5-0.85 m clear of the ground, and roughly 12% of the frame
    // straddling the crosshair.  Under a muzzle flash it lit up as the
    // brightest, busiest object in the shot.
    //
    // Now: short coils laid as an apron on the DOWNRANGE face of each parapet
    // with their axis running ACROSS the street, so each presents a 0.2 m band,
    // plus one band further downrange in a side lane.  All of them sit on the
    // deck.  Dark galvanised steel, NOT the rust material: a warm
    // high-metalness albedo under a bright sky turns a sub-pixel strand into a
    // hard orange line, which is the loudest way to make wire read as wireframe.
    var wireSpots = [
      { x: w1x + rng.range(-0.5, 0.5), z: czBase - rng.range(0.95, 1.4), yaw: rng.range(-0.16, 0.16) },
      { x: e1x + rng.range(-0.5, 0.5), z: eBaseZ - rng.range(0.95, 1.4), yaw: rng.range(-0.16, 0.16) },
      { x: (rng.bool() ? -1 : 1) * rng.range(3.0, 4.6), z: czBase - rng.range(9, 13),
        yaw: rng.range(-0.22, 0.22) }
    ];
    for (i = 0; i < wireSpots.length; i++) {
      var ws = wireSpots[i];
      var coilR = rng.range(0.20, 0.26);
      var coilLen = rng.range(1.8, 2.6);
      var wgy = this._ground(ws.x, ws.z);
      // The coil geometry runs from local x = 0 to x = length, so back the mesh
      // origin off by half a length to centre the band on the requested spot.
      var hdx = Math.cos(ws.yaw) * coilLen * 0.5;
      var hdz = -Math.sin(ws.yaw) * coilLen * 0.5;
      if (this._inSightline(ws.x, wgy + coilR, ws.z) ||
          this._inSightline(ws.x + hdx, wgy + coilR, ws.z + hdz) ||
          this._inSightline(ws.x - hdx, wgy + coilR, ws.z - hdz)) continue;
      var coil = K.concertina(rng, coilLen, coilR);
      if (!coil) continue;
      var cm = new THREE.Mesh(coil, this.mats.wire);
      cm.position.set(ws.x - hdx, wgy + coilR * 0.15, ws.z - hdz);
      cm.rotation.set(0, ws.yaw, 0);
      cm.castShadow = true;
      // It has to RECEIVE shadow too.  With this off, a coil sitting in the
      // buildings' shadow was still lit by the full sun term and floated out of
      // the frame as a bright tangle detached from everything around it.
      cm.receiveShadow = true;
      cm.name = 'props_wire' + i;
      this.root.add(cm);
    }
  };

  // --------------------------------------------------------------------------
  // Aftermath: the difference between a ruin and a battlefield.
  //
  // The street already has shell holes, rebar and a collapsed balcony, but
  // damage on its own reads as decay.  What says "people fought here and then
  // left" is abandoned human material at human scale: sandbags stuffed into
  // ground-floor windows as firing loopholes, furniture dragged across a
  // doorway, dropped kit inside the emplacements - and, crucially, spoil on
  // the ground UNDER every hole overhead, because a shell that opens a wall
  // puts its wall on the pavement.
  // --------------------------------------------------------------------------

  // Find the sill of a ground-floor opening, or -1 if there is not one here.
  // Deliberately uses the uncached probe: the facade cache quantises y to the
  // nearest metre, which is far too coarse to locate a sill.
  Props.prototype._sill = function (z, side) {
    if (this._noLevel) return -1;
    var low = this._probeFacade(z, side, 0.55);
    if (!low.solid) return -1;                       // doorway or a gap, not a window
    var prevY = 0.55;
    for (var y = 0.85; y <= 2.35; y += 0.22) {
      var p = this._probeFacade(z, side, y);
      if (!p.solid || Math.abs(p.x - low.x) > 0.55) {
        // opening starts between prevY and y.  These are absolute world
        // heights - the probe takes a world y - so no ground term here.
        return (prevY + y) * 0.5 - 0.08;
      }
      prevY = y;
    }
    return -1;
  };

  Props.prototype._dressAftermath = function () {
    var rng = this.rng;
    var i, j, side, z, x, gy;

    // ---- sandbagged loopholes in ground-floor windows ---------------------
    var bagB = this.B.sandbag;
    var loopholes = [];
    var wanted = 9;
    for (z = this.z0 + 3.5; z < this.z1 - 3.5 && loopholes.length < wanted; z += 1.35) {
      side = rng.bool() ? -1 : 1;
      if (rng.bool(0.45)) continue;                  // not every window is fortified
      var sy = this._sill(z, side);
      if (sy < 0) continue;
      var fac = this._facade(z, side, 1);
      if (!fac.solid) continue;
      loopholes.push({ z: z, side: side, y: sy, x: fac.x });
      if (bagB) {
        var yaw = this._faceStreet(side);
        var courses = rng.int(2, 4);
        for (var c = 0; c < courses; c++) {
          var per = 3 - (c === courses - 1 ? 1 : 0);
          for (j = 0; j < per; j++) {
            // Leave the middle of the top course out: that gap IS the loophole.
            if (c === courses - 1 && per > 1 && j === 1) continue;
            var t = (j - (per - 1) * 0.5) * 0.40;
            // far enough in from the facade plane that the bag sits in the
            // reveal rather than half-buried in the plaster
            var bx = this._in(fac.x, side, rng.range(0.12, 0.26));
            // _faceStreet already lays a bag's long axis along the facade line;
            // rotating another quarter turn would stand the course crosswise.
            bagB.add(T(bx, sy + 0.075 + c * 0.14 + rng.gaussian(0, 0.008), z + t + rng.gaussian(0, 0.02),
              yaw + rng.gaussian(0, 0.09),
              rng.gaussian(0, 0.04), rng.gaussian(0, 0.05),
              rng.range(0.92, 1.06), rng.range(0.88, 1.02), rng.range(0.92, 1.08)),
              this._jit(rng.pick([0xa9976f, 0x9d8e6c, 0xb8a67f]), 0.72, 1.02, 0.05));
          }
        }
        // a couple that never made it up onto the sill
        for (j = 0; j < rng.int(1, 3); j++) {
          var lx = this._in(fac.x, side, rng.range(0.3, 1.1)), lz = z + rng.gaussian(0, 0.7);
          bagB.add(T(lx, this._ground(lx, lz) + 0.07, lz,
            rng.range(0, 6.283), rng.gaussian(0, 0.25), rng.gaussian(0, 0.25),
            rng.range(0.92, 1.08), rng.range(0.85, 1.0), rng.range(0.92, 1.08)),
            this._jit(rng.pick([0xa9976f, 0x9d8e6c]), 0.7, 1.0, 0.05));
        }
        // sand weeping out of a split bag, and grime down the plaster below
        this._decal(this._in(fac.x, side, rng.range(0.4, 0.9)), z,
          rng.range(1.2, 2.0), 2, 0xc4ac86, rng.range(0.3, 0.55), this._faceStreet(side), 0.4);
        this._wallDecal(this._in(fac.x, side, 0.05), sy - rng.range(0.4, 0.9), z, side,
          rng.range(0.7, 1.3), rng.range(0.8, 1.6), 3, 0x4a4133, rng.range(0.2, 0.4));
      }
    }

    // ---- furniture barricades in doorway openings -------------------------
    // A doorway reads as "not solid at knee height but solid above": that is
    // the one signature a bay opening has that a window does not.
    var doors = 0;
    for (z = this.z0 + 4; z < this.z1 - 4 && doors < 3; z += 1.6) {
      side = rng.bool() ? -1 : 1;
      var kneeP = this._probeFacade(z, side, 0.5);
      var headP = this._probeFacade(z, side, 2.9);
      if (kneeP.solid) continue;                     // wall at knee height: not a door
      if (!headP.solid) continue;                    // no lintel: an alley mouth
      if (rng.bool(0.35)) continue;
      var dx = headP.x;
      var dgy = this._ground(this._in(dx, side, 0.5), z);
      doors++;
      var dyaw = this._faceStreet(side) + rng.range(-0.3, 0.3);
      // shelving tipped across the opening
      var sh = K.shelving();
      if (sh) {
        this._addStatic('wood', sh,
          Tn(this._in(dx, side, rng.range(0.55, 0.95)), dgy, z + rng.range(-0.3, 0.3),
            rng.range(-0.08, 0.08), dyaw, Math.PI * 0.44 * (rng.bool() ? 1 : -1)));
      }
      // crates and a counter jammed in behind it
      for (j = 0; j < rng.int(3, 6); j++) {
        var cxx = this._in(dx, side, rng.range(-0.1, 0.9)) + rng.gaussian(0, 0.15);
        var czz = z + rng.gaussian(0, 0.6);
        this._crate(cxx, czz, {
          y: this._ground(cxx, czz) + (rng.bool(0.45) ? 0.345 : 0),
          tilt: rng.bool(0.4) ? 0.6 : 0.06,
          tint: 0xb0a084, vLo: 0.55, vHi: 1.06, hue: 0.08, topple: 0.22
        });
      }
      this._drop('chair', this._in(dx, side, rng.range(0.8, 1.6)), z + rng.range(-0.9, 0.9),
        rng.range(0, 6.283), { tilt: 0.6, color: this._jit(0x8d998f, 0.55, 0.98, 0.06) });
      this._collider(this._in(dx, side, 0.6), dgy + 0.5, z, 0.55, 0.5, 0.7, dyaw, 'wood');
      this._decal(this._in(dx, side, rng.range(0.9, 1.8)), z, rng.range(1.8, 2.8), 3,
        0x2f2b24, rng.range(0.25, 0.45), this._faceStreet(side), rng.range(0.25, 0.5));
    }

    // ---- abandoned kit inside two of the emplacements ---------------------
    for (i = 0; i < Math.min(2, loopholes.length); i++) {
      var lh = loopholes[rng.int(0, loopholes.length - 1)];
      var kx = this._in(lh.x, lh.side, rng.range(1.0, 2.0));
      var kz = lh.z + rng.range(-1.4, 1.4);
      gy = this._ground(kx, kz);
      for (j = 0; j < rng.int(2, 4); j++) {
        this._drop('ammocrate', kx + rng.gaussian(0, 0.4), kz + rng.gaussian(0, 0.5),
          rng.range(0, 6.283), {
            tilt: rng.bool(0.3) ? 0.5 : 0.04, tint: 0x8a8568, vLo: 0.62, vHi: 1.0, hue: 0.05
          });
      }
      // a drum knocked over as cover, and a discarded jerry can
      var tx = kx + rng.gaussian(0, 0.6), tz = kz + rng.gaussian(0, 0.8);
      if (this.B.drum) {
        this.B.drum.add(T(tx, this._ground(tx, tz) + 0.288, tz,
          rng.range(0, 6.283), Math.PI * 0.5 + rng.gaussian(0, 0.05), rng.gaussian(0, 0.06), 1, 1, 1),
          this._jit(rng.pick([0x6a6f74, 0x5a6a5c]), 0.6, 1.0, 0.07));
      }
      this._drop('jerrycan', kx + rng.gaussian(0, 0.7), kz + rng.gaussian(0, 0.9),
        rng.range(0, 6.283), { tilt: 0.5, color: this._jit(0x4f5544, 0.6, 0.95, 0.06) });
      // a dropped groundsheet / poncho, and the drag mark leaving the position
      this._drop('tarp', kx + rng.gaussian(0, 0.5), kz + rng.gaussian(0, 0.6),
        rng.range(0, 6.283), {
          y: gy + 0.03, tilt: 0.06, pitch: rng.range(-0.09, 0.09),
          color: this._jit(rng.pick([0x54503f, 0x3f4a44, 0x5a4c3a]), 0.55, 0.9, 0.06),
          sx: rng.range(0.5, 0.8), sy: 1, sz: rng.range(0.45, 0.7)
        });
      this._brassField(kx + rng.range(-0.4, 0.4), kz + rng.range(-0.4, 0.4),
        rng.range(0.6, 1.1), rng.range(0.5, 0.9), rng.int(24, 46));
      // drag marks: something heavy was pulled out of here
      var da = rng.range(0, 6.283);
      for (j = 0; j < 3; j++) {
        this._decal(kx + Math.cos(da) * (0.8 + j * 1.1), kz + Math.sin(da) * (0.8 + j * 1.1),
          rng.range(1.6, 2.6), 3, 0x33302a, rng.range(0.18, 0.34), da, rng.range(0.09, 0.16));
      }
    }

    // ---- spoil under the damage that already exists -----------------------
    // Every scorch the level registered overhead gets its debris runout on the
    // pavement below, pointing away from the wall it came out of.
    var scor = null;
    try { scor = this.ctx.level && this.ctx.level.scorches; } catch (e) { scor = null; }
    if (scor && scor.length) {
      var made = 0;
      for (i = 0; i < scor.length && made < 9; i++) {
        var s = scor[i];
        if (!s || !s.p) continue;
        var sx = s.p.x, sz = s.p.z, syy = s.p.y;
        if (!(isFinite(sx) && isFinite(sz) && isFinite(syy))) continue;
        if (syy < 1.6 || syy > 13) continue;              // ground level, or the sky
        if (Math.abs(sx) < 3.0 || Math.abs(sx) > 22) continue;
        if (sz < this.z0 - 2 || sz > this.z1 + 2) continue;
        var out = sx > 0 ? -1 : 1;                        // away from the facade
        var bx2 = sx + out * rng.range(0.35, 0.9);
        if (this._blocked(bx2, 0.5, sz, 0.5)) continue;
        var r = M.clamp((s.r || 2) * 0.42, 0.75, 2.0);
        this._rubblePile(bx2, sz + rng.gaussian(0, 0.5), r,
          M.clamp(r * 0.75, 0.5, 1.5), out * 0.75, rng.range(-0.2, 0.2));
        // and the dust that ran down the wall face beneath it
        this._wallDecal(sx + out * 0.06, syy - (syy - this._ground(bx2, sz)) * 0.45, sz,
          -out, M.clamp((s.r || 2) * 0.5, 0.6, 2.2), M.clamp(syy * 0.7, 1.0, 4.0),
          2, 0xbaa48c, 0.3);
        made++;
      }
    }
  };

  // --------------------------------------------------------------------------
  // Debris
  //
  // Placement rules that make rubble read as physics rather than as noise:
  //   - a pile has a centre and a runout direction; density falls off along it
  //   - big chunks land near the source, small grit travels furthest
  //   - everything against a wall banks up against the wall
  // --------------------------------------------------------------------------
  Props.prototype._glassField = function (x, z, w, d, count, yaw) {
    var rng = this.rng;
    yaw = yaw || 0;
    var ca = Math.cos(yaw), sa = Math.sin(yaw);
    for (var i = 0; i < count; i++) {
      // gaussian in the long axis, tighter across - glass sprays forward
      var lu = rng.gaussian(0, w * 0.42);
      var lv = rng.gaussian(0, d * 0.42);
      var px = x + lu * ca - lv * sa;
      var pz = z + lu * sa + lv * ca;
      this._drop('glass', px, pz, rng.range(0, 6.283), {
        tilt: 0.22, lift: 0.004 + rng.range(0, 0.006),
        tint: 0xcfe0e4, vLo: 0.7, vHi: 1.25, hue: 0.04,
        scale: rng.range(0.45, 1.5)
      });
    }
  };

  Props.prototype._brassField = function (x, z, w, d, count) {
    var rng = this.rng;
    for (var i = 0; i < count; i++) {
      // Ejection pattern: a lobe to one side, not a disc.
      var a = rng.gaussian(0.9, 0.55);
      var r = Math.abs(rng.gaussian(0, 1)) * w;
      var px = x + Math.cos(a) * r;
      var pz = z + Math.sin(a) * r * (d / Math.max(0.01, w));
      this._drop('casing', px, pz, rng.range(0, 6.283), {
        tilt: 0.35, lift: 0.001,
        tint: 0xd8a94a, vLo: 0.7, vHi: 1.2, hue: 0.05,
        scale: rng.range(0.9, 1.1)
      });
    }
  };

  // Rubble albedo classes.  A collapsed masonry building is not one material:
  // it is structural concrete, the brick infill behind it, and the lime plaster
  // skim off the face, and the three read at visibly different values.  One
  // grey for the lot is what makes a debris field look like spilled Lego.
  var RUBBLE_MIX = [
    0x9a958c, 0x9a958c, 0x9a958c, 0xa39c90,       // concrete / structural
    0x8a5a44, 0x9a5a48, 0x7d4f3c,                 // brick infill
    0xd9c3a0, 0xcbb392                            // plaster skim
  ];

  // One rubble pile, GRADED.
  //
  // Real rubble is a power-law size distribution: one or two slabs big enough
  // to have been a floor, a dozen fist-to-head-sized chunks, and hundreds of
  // fines that fill the interstices and bleed the pile into the ground.  The
  // previous version emitted a single size class at a single albedo, which is
  // why the debris field read as thirty identical light-grey boxes.
  Props.prototype._rubblePile = function (x, z, radius, mass, dirX, dirZ) {
    var rng = this.rng;
    var i, t, r, a, px, pz, gy, sc;
    // A pile has a metre of vertical mass and its own collider: it occludes.
    if (this._inSightline(x, this._ground(x, z) + 0.3, z)) {
      this._sightSkipped++;
      return;
    }
    var nSlab = 1 + (rng.bool(M.clamp(mass * 0.35, 0.15, 0.85)) ? 1 : 0);
    var nChunk = Math.round(mass * 8) + 4;
    var nBrick = Math.round(mass * 14);
    var nFine = Math.round(mass * 10) + 16;
    var nGrit = Math.round(mass * 18);
    var slabs = [];

    // ---- slabs: a couple of big flat plates lying at shallow angles --------
    // The rubbleChunk base is 0.92 x 0.30 x 0.68, so sy 0.22-0.30 flattens it
    // into a plate.  Laid nearly level, these are what give the pile a top
    // silhouette instead of a heap of dice.
    for (i = 0; i < nSlab; i++) {
      a = rng.range(0, 6.283);
      r = rng.range(0, radius * 0.45);
      px = x + Math.cos(a) * r + dirX * radius * 0.25;
      pz = z + Math.sin(a) * r + dirZ * radius * 0.25;
      gy = this._ground(px, pz);
      sc = M.clamp(radius * rng.range(0.42, 0.62), 0.72, 1.25);
      this._drop('rubble', px, pz, rng.range(0, 6.283), {
        y: gy + rng.range(0.0, 0.12) * radius,
        tilt: 0.02, pitch: rng.range(-0.30, 0.30), roll: rng.range(-0.26, 0.26),
        tint: rng.pick(RUBBLE_MIX), vLo: 0.72, vHi: 1.12, hue: 0.05,
        sx: sc * rng.range(0.95, 1.25), sy: sc * rng.range(0.20, 0.32),
        sz: sc * rng.range(0.9, 1.2)
      });
      slabs.push({ x: px, z: pz, y: gy });
    }

    // ---- mid chunks: the 0.2-0.4 m body of the pile -----------------------
    for (i = 0; i < nChunk; i++) {
      t = Math.pow(rng.next(), 1.7);              // biased toward the centre
      r = t * radius;
      a = rng.range(0, 6.283);
      px = x + Math.cos(a) * r + dirX * r * 0.55;
      pz = z + Math.sin(a) * r + dirZ * r * 0.55;
      gy = this._ground(px, pz);
      // pile height: a cone, so the middle actually stacks up
      var hy = gy + Math.max(0, (1 - t) * radius * 0.42) * rng.range(0.4, 1.0);
      sc = M.lerp(0.42, 0.20, t) * rng.range(0.75, 1.3);
      this._drop('rubble', px, pz, rng.range(0, 6.283), {
        y: hy, tilt: 0.55, tint: rng.pick(RUBBLE_MIX), vLo: 0.66, vHi: 1.18, hue: 0.06,
        sx: sc * rng.range(0.8, 1.35), sy: sc * rng.range(0.6, 1.25), sz: sc * rng.range(0.8, 1.35)
      });
    }

    // ---- fines: the skirt that stops the pile having a hard footprint -----
    // Concentrated in the outer two thirds and pressed flat, so the pile bleeds
    // into the pavement instead of sitting on it like a decal.
    for (i = 0; i < nFine; i++) {
      t = 0.35 + Math.pow(rng.next(), 0.6) * 0.9;
      r = t * radius;
      a = rng.range(0, 6.283);
      px = x + Math.cos(a) * r + dirX * r * 0.8;
      pz = z + Math.sin(a) * r + dirZ * r * 0.8;
      sc = rng.range(0.10, 0.24);
      this._drop('rubble', px, pz, rng.range(0, 6.283), {
        y: this._ground(px, pz), lift: 0.004,
        tilt: 0.7, tint: rng.pick(RUBBLE_MIX), vLo: 0.62, vHi: 1.2, hue: 0.07,
        sx: sc * rng.range(0.7, 1.5), sy: sc * rng.range(0.35, 0.8), sz: sc * rng.range(0.7, 1.5)
      });
    }

    // ---- rebar torn out of the slabs, standing proud at random angles -----
    for (i = 0; i < slabs.length; i++) {
      var nb = rng.int(2, 4);
      for (var b2 = 0; b2 < nb; b2++) {
        var sl = slabs[i];
        this._drop('rebar', sl.x + rng.gaussian(0, 0.26), sl.z + rng.gaussian(0, 0.26),
          rng.range(0, 6.283), {
            y: sl.y + rng.range(0.04, 0.22),
            tilt: 0.02, pitch: rng.range(-1.25, 1.25), roll: rng.range(-0.7, 0.7),
            tint: 0xa87a58, vLo: 0.7, vHi: 1.12, hue: 0.06,
            scale: rng.range(0.7, 1.5)
          });
      }
    }
    for (i = 0; i < nBrick; i++) {
      t = Math.pow(rng.next(), 1.3);
      r = t * radius * 1.25;
      a = rng.range(0, 6.283);
      px = x + Math.cos(a) * r + dirX * r * 0.8;
      pz = z + Math.sin(a) * r + dirZ * r * 0.8;
      gy = this._ground(px, pz) + Math.max(0, (1 - t) * radius * 0.3) * rng.next();
      // Bricks come out of a collapse whole, snapped in half, or as a corner
      // spall.  One geometry, three length classes.  Hashed off the instance
      // index rather than drawn from this.rng so the dressing stream downstream
      // of here keeps the phase every other composition was tuned against.
      var bn = this.B.brick ? this.B.brick.n : i;
      var bfrac = hash01(bn, 91);
      var blen = bfrac < 0.42 ? 1.0 : (bfrac < 0.78 ? 0.46 + hash01(bn, 93) * 0.16
        : 0.24 + hash01(bn, 95) * 0.14);
      this._drop('brick', px, pz, rng.range(0, 6.283), {
        y: gy + 0.031, tilt: 0.6, tint: 0xa87a5e, vLo: 0.62, vHi: 1.2, hue: 0.075,
        scale: rng.range(0.85, 1.15),
        sx: blen, sy: 0.88 + hash01(bn, 97) * 0.22, sz: 0.90 + hash01(bn, 99) * 0.18
      });
    }
    for (i = 0; i < nGrit; i++) {
      t = Math.pow(rng.next(), 0.75);             // grit travels furthest
      r = t * radius * 2.1;
      a = rng.range(0, 6.283);
      px = x + Math.cos(a) * r + dirX * r * 1.1;
      pz = z + Math.sin(a) * r + dirZ * r * 1.1;
      this._drop('pebble', px, pz, rng.range(0, 6.283), {
        tilt: 0.7, tint: 0xb6afa4, vLo: 0.6, vHi: 1.22, hue: 0.05,
        scale: rng.range(0.55, 1.7)
      });
    }
    // A little more exposed rebar near the middle, where the slab broke.
    for (i = 0; i < Math.round(mass * 1.2); i++) {
      a = rng.range(0, 6.283);
      r = rng.range(0, radius * 0.6);
      px = x + Math.cos(a) * r;
      pz = z + Math.sin(a) * r;
      this._drop('rebar', px, pz, rng.range(0, 6.283), {
        y: this._ground(px, pz) + rng.range(0.0, 0.25),
        tilt: 0.45, tint: 0xa87a58, vLo: 0.68, vHi: 1.15, hue: 0.06,
        scale: rng.range(0.6, 1.4)
      });
    }
    for (i = 0; i < Math.round(mass * 3.5); i++) {
      a = rng.range(0, 6.283);
      r = rng.range(radius * 0.2, radius * 1.5);
      px = x + Math.cos(a) * r + dirX * r * 0.7;
      pz = z + Math.sin(a) * r + dirZ * r * 0.7;
      this._drop('timber', px, pz, rng.range(0, 6.283), {
        y: this._ground(px, pz) + rng.range(0, 0.12),
        tilt: 0.4, tint: 0xa08a68, vLo: 0.62, vHi: 1.15, hue: 0.06,
        sx: rng.range(0.4, 1.15), sy: rng.range(0.7, 1.3), sz: rng.range(0.7, 1.4)
      });
    }
    // Pulverised concrete: three overlapping rings at different radii so the
    // pile's footprint dissolves rather than stopping at a hard edge.
    this._decal(x + dirX * radius * 0.4, z + dirZ * radius * 0.4,
      radius * 2.6, 2, 0xc9b490, 0.55);
    this._decal(x + dirX * radius * 0.25 + rng.range(-0.3, 0.3),
      z + dirZ * radius * 0.25 + rng.range(-0.3, 0.3),
      radius * 1.8, 2, 0xd2bd98, 0.5);
    this._decal(x + rng.range(-1, 1), z + rng.range(-1, 1), radius * 1.5, 2, 0xd6c2a0, 0.4);
    // a couple of decent-sized chunks read as collision, so give them one
    this._collider(x, this._ground(x, z) + radius * 0.22, z,
      radius * 0.75, radius * 0.24, radius * 0.75, 0, 'concrete');
  };

  Props.prototype._dressDebris = function () {
    var rng = this.rng;
    var i;

    // ---- the collapsed balcony (art direction set piece) ------------------
    var colSide = -1;
    var colZ = M.lerp(this.z0 + 8, this.z1 - 14, rng.next());
    var colFac = this._facade(colZ, colSide);
    var colX = this._in(colFac.x, colSide, 1.1);
    this._rubblePile(colX, colZ, 2.6, 4.2, -colSide * 0.35, 0);
    // the balcony slab itself, canted against the wall
    var slab = this.B.rubble;
    if (slab) {
      for (i = 0; i < 3; i++) {
        var sx = this._in(colFac.x, colSide, rng.range(0.4, 1.6));
        var sz = colZ + rng.range(-1.6, 1.6);
        slab.add(T(sx, this._ground(sx, sz) + rng.range(0.3, 0.9), sz,
          rng.range(0, 6.283), rng.range(0.5, 1.15), rng.range(-0.4, 0.4),
          rng.range(1.6, 2.6), rng.range(0.8, 1.4), rng.range(1.4, 2.2)),
          this._jit(0xb2ada3, 0.72, 1.1, 0.04));
      }
    }
    // rebar fringe hanging where the slab tore away
    for (i = 0; i < 7; i++) {
      var rx = this._in(colFac.x, colSide, rng.range(0.1, 0.5));
      var rz = colZ + rng.range(-1.8, 1.8);
      this._drop('rebar', rx, rz, rng.range(0, 6.283), {
        y: this._ground(rx, rz) + rng.range(2.6, 3.4), tilt: 0.9,
        tint: 0xa87a58, vLo: 0.7, vHi: 1.1, hue: 0.06,
        scale: rng.range(0.9, 1.6)
      });
    }

    // ---- secondary damage sites -------------------------------------------
    for (i = 0; i < 9; i++) {
      var side = rng.bool() ? -1 : 1;
      var z = M.lerp(this.z0 + 3, this.z1 - 3, rng.next());
      var fac = this._facade(z, side);
      var x = this._in(fac.x, side, rng.range(0.5, 1.4));
      this._rubblePile(x, z, rng.range(0.9, 1.9), rng.range(0.9, 2.2), -side * 0.4, rng.range(-0.2, 0.2));
      // scorch and blast marks belong with damage, not scattered at random
      if (rng.bool(0.5)) {
        this._decal(this._in(fac.x, side, rng.range(0.4, 1.6)), z + rng.range(-0.8, 0.8),
          rng.range(1.6, 3.4), 1, 0x2a2622, rng.range(0.45, 0.85));
      }
      this._glassField(this._in(fac.x, side, rng.range(0.5, 1.3)), z + rng.range(-1, 1),
        1.7, 1.1, rng.int(30, 70), rng.range(0, 3.14));
    }

    // ---- glass beneath the window lines ----------------------------------
    // Windows are regularly spaced; glass on the pavement should be too.
    for (var s2 = 0; s2 < 2; s2++) {
      var sd = s2 === 0 ? -1 : 1;
      for (var zz = this.z0 + 4; zz < this.z1 - 4; zz += rng.range(3.4, 5.2)) {
        var f2 = this._facade(zz, sd);
        if (!f2.solid) continue;
        if (rng.bool(0.45)) continue;             // not every window is broken
        this._glassField(this._in(f2.x, sd, rng.range(0.45, 1.0)), zz,
          1.4, 0.6, rng.int(14, 40), Math.PI * 0.5);
      }
    }

    // ---- gutter litter ----------------------------------------------------
    // Rubbish ends up where water would take it: the gutter line, and in the
    // lee of anything that sticks out.
    for (s2 = 0; s2 < 2; s2++) {
      sd = s2 === 0 ? -1 : 1;
      for (zz = this.z0 + 2; zz < this.z1 - 2; zz += rng.range(1.1, 2.6)) {
        var f3 = this._facade(zz, sd);
        var gx = this._in(f3.x, sd, rng.range(2.0, 2.6));
        // clump: the noise field decides where rubbish gathers
        var dens = this.noise.fbm2(zz * 0.11, sd * 3.3, 3, 2.1, 0.55);
        if (dens < -0.05) continue;
        this._litter(gx, zz, 0.9, rng.int(1, 3 + Math.round(dens * 5)));
      }
    }

    // ---- spent brass along the fighting line ------------------------------
    for (i = 0; i < 5; i++) {
      var px2 = rng.range(-this.halfW * 0.7, this.halfW * 0.7);
      var pz2 = M.lerp(this.z0 + 4, this.z1 - 4, rng.next());
      this._brassField(px2, pz2, rng.range(0.5, 1.3), rng.range(0.4, 1.0), rng.int(10, 30));
    }

    // ---- loose brick piles (somebody was rebuilding, or looting) ---------
    for (i = 0; i < 4; i++) {
      var bside = rng.bool() ? -1 : 1;
      var bz = M.lerp(this.z0 + 4, this.z1 - 4, rng.next());
      var bfac = this._facade(bz, bside);
      var bx = this._in(bfac.x, bside, rng.range(0.55, 1.3));
      var rows = rng.int(3, 6);
      for (var r2 = 0; r2 < rows; r2++) {
        var perRow = rng.int(4, 8);
        for (var k = 0; k < perRow; k++) {
          var ox = (k - perRow * 0.5) * 0.115 + rng.gaussian(0, 0.02);
          var oz = rng.gaussian(0, 0.11);
          var wx = bx + ox * Math.cos(0) - oz * Math.sin(0);
          var wz = bz + ox * Math.sin(0) + oz * Math.cos(0);
          this._drop('brick', wx, wz, this._faceStreet(bside) + rng.gaussian(0, 0.07), {
            y: this._ground(bx, bz) + 0.031 + r2 * 0.066,
            tilt: 0.02, tint: 0xa87a5e, vLo: 0.62, vHi: 1.2, hue: 0.08
          });
        }
      }
      this._collider(bx, this._ground(bx, bz) + rows * 0.033, bz, 0.45, rows * 0.033, 0.2, 0, 'brick');
    }

    this._dressRoad();
  };

  // --------------------------------------------------------------------------
  // The roadway itself.
  //
  // Left to the wall-hugging rules above, the centre of the street ends up
  // conspicuously bare - which reads as a corridor with decoration glued to the
  // sides.  Real fought-over streets have stuff pushed OUT into the road:
  // debris fans from the facades, things dragged into cover, cargo dropped
  // where a vehicle stopped.
  // --------------------------------------------------------------------------
  Props.prototype._dressRoad = function () {
    var rng = this.rng;
    var i, j;

    // ---- debris fans running out from the buildings -----------------------
    for (i = 0; i < 7; i++) {
      var side = rng.bool() ? -1 : 1;
      var z = M.lerp(this.z0 + 4, this.z1 - 4, rng.next());
      var fac = this._facade(z, side);
      var reach = rng.range(2.6, 5.2);
      // the fan narrows and thins as it gets further from the source
      var steps = 9;
      for (j = 0; j < steps; j++) {
        var t = (j + 0.5) / steps;
        var fx = this._in(fac.x, side, 0.6 + t * reach);
        var spread = 0.5 + t * 1.9;
        var count = Math.round(M.lerp(7, 2, t));
        for (var k = 0; k < count; k++) {
          var px = fx + rng.gaussian(0, 0.35);
          var pz = z + rng.gaussian(0, spread);
          if (rng.bool(0.34 * (1 - t) + 0.06)) {
            this._drop('rubble', px, pz, rng.range(0, 6.283), {
              tilt: 0.55, tint: 0xb2ada3, vLo: 0.68, vHi: 1.16, hue: 0.045,
              scale: M.lerp(0.5, 0.16, t) * rng.range(0.7, 1.35)
            });
          } else if (rng.bool(0.45)) {
            this._drop('brick', px, pz, rng.range(0, 6.283), {
              tilt: 0.7, tint: 0xa87a5e, vLo: 0.62, vHi: 1.2, hue: 0.08,
              scale: rng.range(0.8, 1.1)
            });
          } else {
            this._drop('pebble', px, pz, rng.range(0, 6.283), {
              tilt: 0.8, tint: 0xb6afa4, vLo: 0.6, vHi: 1.22, hue: 0.05,
              scale: rng.range(0.5, 1.5)
            });
          }
        }
      }
      this._decal(this._in(fac.x, side, 0.6 + reach * 0.4), z, reach * 1.4, 2,
        0xc9b490, rng.range(0.22, 0.45), Math.PI * 0.5, rng.range(0.35, 0.7));
    }

    // ---- obstacle clusters out in the roadway -----------------------------
    // These break the sightline and give the street shot something to occlude
    // with, which is what turns a corridor into a composition.
    for (i = 0; i < 6; i++) {
      var cx = rng.gaussian(0, this.halfW * 0.42);
      var cz = M.lerp(this.z0 + 5, this.z1 - 5, rng.next());
      if (this._blocked(cx, 0.7, cz, 0.9)) continue;
      var gy = this._ground(cx, cz);
      // Tested BEFORE the cluster is built, not per prop: these carry colliders
      // and half a cluster of invisible collision would be worse than the
      // clutter it replaced.
      if (this._inSightline(cx, gy + 0.5, cz)) continue;
      var kind = rng.next();

      if (kind < 0.32) {
        // drums pushed together as improvised cover, one on its side
        for (j = 0; j < rng.int(2, 4); j++) {
          var dx = cx + rng.gaussian(0, 0.42), dz = cz + rng.gaussian(0, 0.42);
          if (rng.bool(0.28)) {
            var db = this.B.drum;
            if (db) db.add(T(dx, gy + 0.288, dz, rng.range(0, 6.283),
              Math.PI * 0.5 + rng.gaussian(0, 0.05), rng.gaussian(0, 0.06), 1, 1, 1),
              this._jit(rng.pick([0x8a4a2a, 0x5a6a5c, 0x6a6f74]), 0.68, 1.14, 0.07));
          } else {
            this._drop('drum', dx, dz, rng.range(0, 6.283), {
              y: gy, tilt: 0.04,
              color: this._jit(rng.pick([0x8a4a2a, 0x5a6a5c, 0x6a6f74, 0x8f7a44]), 0.68, 1.14, 0.07)
            });
            this._collider(dx, gy + 0.44, dz, 0.3, 0.44, 0.3, 0, 'metal');
          }
        }
        this._decal(cx, cz, rng.range(1.2, 2.2), 0, 0x24211d, rng.range(0.35, 0.7));

      } else if (kind < 0.58) {
        // a load of crates dropped off the back of something
        var yaw = rng.range(0, 6.283);
        for (j = 0; j < rng.int(4, 8); j++) {
          var ox = rng.gaussian(0, 0.55), oz = rng.gaussian(0, 0.7);
          var lvl = rng.bool(0.35) ? 1 : 0;
          this._crate(cx + ox, cz + oz, {
            y: gy + lvl * 0.345, tilt: lvl ? 0.28 : 0.06,
            tint: 0xc6b294, vLo: 0.66, vHi: 1.16, hue: 0.075,
            topple: lvl ? 0.28 : 0.08
          });
        }
        this._collider(cx, gy + 0.2, cz, 0.85, 0.2, 0.9, yaw, 'wood');
        this._litter(cx, cz, 1.4, rng.int(5, 10));

      } else if (kind < 0.78) {
        // a lone jersey barrier dragged across a lane, plus wire
        var jyaw = rng.range(0, 6.283);
        this._drop('jersey', cx, cz, jyaw, {
          y: gy, tilt: 0.02, tint: 0xb0aca3, vLo: 0.78, vHi: 1.1, hue: 0.03
        });
        this._collider(cx, gy + 0.42, cz, 0.31, 0.42, 1.2, jyaw, 'concrete');
        if (rng.bool(0.5)) {
          this._drop('pallet', cx + rng.range(-1.2, 1.2), cz + rng.range(-1.2, 1.2),
            rng.range(0, 6.283), { tilt: 0.05, tint: 0xbda98a, vLo: 0.68, vHi: 1.14, hue: 0.06 });
        }

      } else {
        // rubble bank with scrub, right out in the road
        this._rubblePile(cx, cz, rng.range(0.8, 1.5), rng.range(0.9, 1.8),
          rng.range(-0.4, 0.4), rng.range(-0.4, 0.4));
        for (j = 0; j < rng.int(1, 3); j++) {
          this._drop('scrub', cx + rng.gaussian(0, 0.5), cz + rng.gaussian(0, 0.5),
            rng.range(0, 6.283), {
              y: gy + rng.range(0.05, 0.28), tilt: 0.16,
              tint: 0x8a9060, vLo: 0.6, vHi: 1.2, hue: 0.1, scale: rng.range(0.5, 0.95)
            });
        }
      }
    }

    // ---- fine ground read: brass, litter and grit across the carriageway --
    for (i = 0; i < 90; i++) {
      var lx = rng.gaussian(0, this.halfW * 0.55);
      var lz = M.lerp(this.z0, this.z1, rng.next());
      this._drop('pebble', lx, lz, rng.range(0, 6.283), {
        tilt: 0.8, tint: 0xb0a99e, vLo: 0.6, vHi: 1.2, hue: 0.05,
        scale: rng.range(0.4, 1.0)
      });
      if (rng.bool(0.28)) {
        this._drop('paper', lx + rng.range(-0.6, 0.6), lz + rng.range(-0.6, 0.6),
          rng.range(0, 6.283), {
            tilt: 0.12, tint: 0xffffff, vLo: 0.6, vHi: 1.06, hue: 0.05,
            scale: rng.range(0.7, 1.2)
          });
      }
    }
  };

  // --------------------------------------------------------------------------
  // Soft goods: laundry lines, tarpaulins, a rug over a balcony rail.
  // Cloth strung across a street is the single strongest "people live here"
  // signal available, and it costs almost nothing.
  // --------------------------------------------------------------------------
  // Dust-dulled washing.  These are HUES, not values: _jit normalises each hex
  // by its own max channel before applying it, so what a bright entry like the
  // old 0xe0dcd0 actually bought was "no hue shift at all" - ten near-identical
  // white sheets.  The real value knock-down lives in TK.fabricCanvas's base
  // and in m.laundry's env term; this list exists to make sure no two sheets on
  // a line are the same colour.  Spread, therefore, not brightness.
  var LAUNDRY_TINTS = [
    0x8e8477, 0x6f7c86, 0x8a6f62, 0x6a7460, 0x9a8560,
    0x5c6570, 0x7d6d72, 0x6f6552, 0x847a6a, 0x5f6b74
  ];
  // Laundry colour: a stronger hue term than the general _jit default, because
  // a line of washing is the one place on the street where real colour variety
  // is expected, and a duller value band, because it is unlit cotton.
  Props.prototype._clothCol = function (hex, vLo, vHi) {
    var out = normTint(hex, 0.88, _col);
    out.multiplyScalar(this.rng.range(vLo === undefined ? 0.66 : vLo,
      vHi === undefined ? 1.02 : vHi));
    return out;
  };

  Props.prototype._dressSoftGoods = function () {
    var rng = this.rng;
    var i, j;
    this._lines = [];                // catenaries, consumed by _dressOverhead

    // ---- laundry lines across the street ----------------------------------
    var z = this.z1 - rng.range(6, 11);
    while (z > this.z0 + 4) {
      var wf = this._facade(z, -1, 4.5);
      var ef = this._facade(z, 1, 4.5);
      if (wf.solid && ef.solid) {
        var ya = this._ground(0, z) + rng.range(4.6, 6.4);
        var yb = ya + rng.range(-0.5, 0.5);
        var a = new THREE.Vector3(wf.x + 0.12, ya, z);
        var b = new THREE.Vector3(ef.x - 0.12, yb, z + rng.range(-0.5, 0.5));
        var sag = rng.range(0.55, 1.15);
        this._lines.push({ a: a, b: b, sag: sag, kind: 'laundry' });

        // hang garments along it
        var n = rng.int(4, 9);
        for (i = 0; i < n; i++) {
          var t = (i + rng.range(0.25, 0.75)) / (n + 0.5);
          sagPoint(a, b, sag, t, _vb);
          if (this._blocked(_vb.x, _vb.y - 0.45, _vb.z, 0.3)) continue;
          if (!this._openAbove(_vb.x, _vb.y + 0.15, _vb.z, 2.2)) continue;
          var sc = rng.range(0.75, 1.5);
          this._drop('laundry', _vb.x, _vb.z, rng.range(-0.35, 0.35) + Math.PI * 0.5, {
            y: _vb.y - 0.03, tilt: 0.05,
            color: this._clothCol(rng.pick(LAUNDRY_TINTS), 0.70, 1.04),
            sx: sc * rng.range(0.8, 1.5), sy: sc * rng.range(0.85, 1.5), sz: sc
          });
        }
      }
      z -= rng.range(7, 13);
    }

    // ---- shorter lines along a single facade (balcony to balcony) --------
    for (i = 0; i < 6; i++) {
      var side = rng.bool() ? -1 : 1;
      var z0 = M.lerp(this.z0 + 4, this.z1 - 8, rng.next());
      var z1 = z0 + rng.range(3.5, 6.5);
      var f0 = this._facade(z0, side, 4.0), f1 = this._facade(z1, side, 4.0);
      if (!f0.solid || !f1.solid) continue;
      var y0 = this._ground(0, z0) + rng.range(3.4, 7.2);
      var pa = new THREE.Vector3(this._in(f0.x, side, 0.55), y0, z0);
      var pb = new THREE.Vector3(this._in(f1.x, side, 0.55), y0 + rng.range(-0.35, 0.35), z1);
      var sg = rng.range(0.25, 0.6);
      this._lines.push({ a: pa, b: pb, sag: sg, kind: 'laundry' });
      var m = rng.int(3, 6);
      for (j = 0; j < m; j++) {
        var tt = (j + rng.range(0.3, 0.7)) / (m + 0.4);
        sagPoint(pa, pb, sg, tt, _vb);
        if (this._blocked(_vb.x, _vb.y - 0.45, _vb.z, 0.3)) continue;
        if (!this._openAbove(_vb.x, _vb.y + 0.15, _vb.z, 2.2)) continue;
        var s2 = rng.range(0.7, 1.3);
        this._drop('laundry', _vb.x, _vb.z, this._faceStreet(side) + rng.range(-0.3, 0.3), {
          y: _vb.y - 0.03, tilt: 0.05,
          color: this._clothCol(rng.pick(LAUNDRY_TINTS), 0.70, 1.04),
          sx: s2 * rng.range(0.8, 1.4), sy: s2 * rng.range(0.85, 1.4), sz: s2
        });
      }
    }

    // ---- tarpaulins -------------------------------------------------------
    // Over stalls, over rubble, lashed to a wall as a lean-to.
    for (i = 0; i < 9; i++) {
      var ts = rng.bool() ? -1 : 1;
      var tz = M.lerp(this.z0 + 4, this.z1 - 4, rng.next());
      var tf = this._facade(tz, ts);
      if (!tf.solid) continue;
      var tx = this._in(tf.x, ts, rng.range(0.08, 0.3));
      var ty = this._ground(tx, tz) + rng.range(1.9, 3.0);
      var sc2 = rng.range(0.7, 1.1);
      // Pitched well past horizontal so it hangs off the wall as a lean-to
      // rather than sticking out over the street like a flat billboard.
      this._drop('tarp', tx, tz, this._faceStreet(ts) + rng.range(-0.2, 0.2), {
        y: ty, tilt: 0.05, pitch: rng.range(0.95, 1.30),
        color: this._jit(rng.pick([0x4a6a7a, 0x7a5a3a, 0x5a6a4a, 0xc0b498, 0x8a4a3a]), 0.7, 1.1, 0.06),
        sx: sc2 * rng.range(0.85, 1.35), sy: 1, sz: sc2 * rng.range(0.8, 1.2)
      });
    }

    // ---- rugs and carpets aired over a balcony rail / hung on the plaster
    for (i = 0; i < 5; i++) {
      var rs = rng.bool() ? -1 : 1;
      var rz = M.lerp(this.z0 + 4, this.z1 - 4, rng.next());
      var rf = this._facade(rz, rs, 3.4);
      if (!rf.solid) continue;
      var rx = this._in(rf.x, rs, 0.14);
      var ry = this._ground(0, rz) + rng.range(3.1, 4.4);
      // A rug over a rail hangs essentially vertically, with just enough
      // stand-off that it clears the plaster and casts its own shadow.
      this._drop('tarp', rx, rz, this._faceStreet(rs) + rng.range(-0.08, 0.08), {
        y: ry, tilt: 0.02, pitch: rng.range(1.36, 1.50),
        color: this._jit(rng.pick([0x7a3a30, 0x3a4a5a, 0x6a5a34, 0x54384a]), 0.7, 1.08, 0.07),
        sx: rng.range(0.62, 1.0), sy: 1, sz: rng.range(0.55, 0.85)
      });
    }
  };

  // --------------------------------------------------------------------------
  // Overhead: power and phone cables in real catenaries, satellite dishes, AC
  // units, TV aerials.  Cables crossing the frame at three different depths do
  // more for "this is a city" than another thousand polygons on the ground.
  // --------------------------------------------------------------------------
  Props.prototype._dressOverhead = function () {
    var rng = this.rng;
    var tb = new TubeBuilder();
    var i, j;
    var spans = 0;

    function flexFn(t) { return Math.sin(Math.PI * t); }

    // Laundry lines get a physical cord.
    var lines = this._lines || [];
    for (i = 0; i < lines.length; i++) {
      var L = lines[i];
      // 10 mm at 5 radial segments: thin enough to read as a washing line,
      // thick and round enough to survive anti-aliasing at 8-14 m.
      tb.addPath(sagPath(L.a, L.b, L.sag, 14), 0.010, 5, flexFn, 30);
      spans++;
    }

    // ---- power / phone crossings -----------------------------------------
    // CLUSTERED, NOT SPREAD.  Stepping 4.5-9 m the whole length of the street
    // at 2-4 cables a step produced about thirty crossings, and with the
    // pole-to-pole runs on top of that the upper half of every street framing
    // was a cross-hatched mesh you had to read the arch through.  Evenly
    // distributed cable is also the "perfectly uniform anything" tell: real
    // overhead runs bunch at the poles and leave clear sky between them.
    //
    // So the crossings hang from four fixed pole stations, and nothing is
    // allowed to cross the last stretch of street before the arch, because that
    // is the vanishing point every leading line in the composition delivers you
    // to.
    var vanishZ = this.z0;
    var stations = [
      this.z1 - rng.range(3, 5),
      this.z1 - rng.range(8, 11),
      M.lerp(this.z1, this.z0, 0.42) + rng.range(-2, 2),
      M.lerp(this.z1, this.z0, 0.68) + rng.range(-2, 2)
    ];
    for (var st = 0; st < stations.length; st++) {
      var z = stations[st];
      if (z < this.z0 + 4 || z > this.z1 - 1) continue;
      if (Math.abs(z - vanishZ) < 16) continue;      // keep the arch approach clear
      var wf = this._facade(z, -1, 5.5);
      var ef = this._facade(z, 1, 5.5);
      if (!(wf.solid && ef.solid)) continue;
      var baseY = this._ground(0, z) + rng.range(6.2, 8.6);
      // a bundle of 2-3 cables leaving the same pole at slightly different
      // heights, sags and lateral offsets
      var bundle = rng.int(2, 3);
      for (j = 0; j < bundle; j++) {
        var a = new THREE.Vector3(wf.x + 0.1, baseY + j * rng.range(0.16, 0.3), z + rng.range(-0.35, 0.35));
        var b = new THREE.Vector3(ef.x - 0.1, baseY + j * rng.range(0.14, 0.32) + rng.range(-0.4, 0.4),
          z + rng.range(-0.7, 0.7));
        tb.addPath(sagPath(a, b, rng.range(0.7, 1.5) + j * 0.12, 16),
          rng.range(0.012, 0.024), 4, flexFn, 40);
        spans++;
      }
      // a drop line down the facade to a junction box
      if (rng.bool(0.55)) {
        var side = rng.bool() ? -1 : 1;
        var fx = side < 0 ? wf.x + 0.1 : ef.x - 0.1;
        var dTop = new THREE.Vector3(fx, baseY, z);
        var dBot = new THREE.Vector3(this._in(fx, side, -0.05), this._ground(0, z) + rng.range(1.6, 2.6), z + rng.range(-0.3, 0.3));
        tb.addPath(sagPath(dTop, dBot, 0.1, 8), 0.012, 3, function (t) { return t * 0.25; }, 20);
        spans++;
      }
    }

    // ---- cables running ALONG the street, pole to pole --------------------
    // One cable per span rather than two, and a much longer stride, so these
    // read as the service run linking the crossing clusters instead of a second
    // layer of hatching.
    for (var s = 0; s < 2; s++) {
      var sd = s === 0 ? -1 : 1;
      var zz = this.z1 - rng.range(2, 6);
      var prev = null;
      while (zz > this.z0 + 2) {
        var f = this._facade(zz, sd, 6.0);
        if (f.solid) {
          var p = new THREE.Vector3(this._in(f.x, sd, rng.range(0.1, 0.4)),
            this._ground(0, zz) + rng.range(5.6, 7.4), zz);
          if (prev && Math.abs(prev.z - p.z) < 26) {
            tb.addPath(sagPath(prev, p, rng.range(0.4, 1.0), 12), rng.range(0.011, 0.02), 4, flexFn, 34);
            spans++;
          }
          prev = p;
        }
        zz -= rng.range(14, 20);
      }
    }

    if (spans && tb.count() > 0) {
      var g = tb.geometry(true);
      Geo.copyUV1(g);
      var mesh = new THREE.Mesh(g, this.mats.cable);
      mesh.name = 'props_cables';
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      // The catenaries are already in world space; keep the mesh at the origin
      // so the shared wind snippet reads world position straight from them.
      this.root.add(mesh);
      this._cableMesh = mesh;
      this.stats.cableSpans = spans;
    }

    // ---- roof and facade hardware ----------------------------------------
    for (var k = 0; k < 2; k++) {
      var side2 = k === 0 ? -1 : 1;
      for (var pz = this.z1 - 2; pz > this.z0 + 2; pz -= rng.range(2.3, 4.2)) {
        var fa = this._facade(pz, side2, 3.2);
        if (!fa.solid) continue;

        // AC units bolted to the plaster at first and second floor
        if (rng.bool(0.58)) {
          var acY = this._ground(0, pz) + rng.pick([3.3, 3.5, 6.2, 6.5, 8.8]);
          this._drop('ac', this._in(fa.x, side2, 0.18), pz, this._faceStreet(side2) + rng.range(-0.04, 0.04), {
            y: acY, tilt: 0.012, tint: 0xc4c0b6, vLo: 0.74, vHi: 1.1, hue: 0.035,
            scale: rng.range(0.85, 1.1)
          });
          // rust weeping down the wall from the brackets
          if (rng.bool(0.55)) this._wallDecal(this._in(fa.x, side2, 0.03), acY - 0.9, pz,
            side2, rng.range(0.5, 1.0), rng.range(1.0, 2.0), 3, 0x6a4028, rng.range(0.25, 0.5));
        }

        // parapet-level hardware needs the actual roof height
        var roofY = this._roof(this._in(fa.x, side2, -0.9), pz);
        if (roofY > 3.5) {
          if (rng.bool(0.3)) {
            this._drop('dish', this._in(fa.x, side2, -rng.range(0.7, 1.8)), pz,
              this._faceStreet(side2) + rng.range(-0.7, 0.7), {
                y: roofY, tilt: 0.01, tint: 0xc2beb4, vLo: 0.68, vHi: 0.96, hue: 0.03,
                scale: rng.range(0.72, 1.0)
              });
          }
          if (rng.bool(0.22)) {
            this._drop('aerial', this._in(fa.x, side2, -rng.range(0.8, 2.2)), pz + rng.range(-0.6, 0.6),
              rng.range(0, 6.283), {
                y: roofY, tilt: 0.05, tint: 0xb0a698, vLo: 0.72, vHi: 1.1, hue: 0.05,
                scale: rng.range(0.85, 1.2)
              });
          }
          if (rng.bool(0.10)) {
            var wtx = this._in(fa.x, side2, -rng.range(1.2, 2.6));
            this._addStatic('rust', K.waterTank(), Tn(wtx, roofY, pz, 0, rng.range(0, 6.283), 0));
          }
        }
      }
    }
  };

  // --------------------------------------------------------------------------
  // Vegetation
  //
  // Plants grow where nobody walks and where water collects: the crack between
  // pavement and wall, the lee of a kerb, the middle of a rubble pile.  Weeds
  // in the centre of a busy street would read as wrong even if nobody could
  // say why.
  // --------------------------------------------------------------------------
  Props.prototype._dressVegetation = function () {
    var rng = this.rng, n = this.noise;
    var i, side, z, fac, x;

    // ---- weeds in the wall/pavement crack ---------------------------------
    for (var s = 0; s < 2; s++) {
      side = s === 0 ? -1 : 1;
      for (z = this.z0 + 1; z < this.z1 - 1; z += rng.range(0.28, 0.85)) {
        fac = this._facade(z, side);
        // Growth mask: a noise field so weeds come in patches, plus a hard
        // preference for the 20cm strip right at the wall.
        var mask = n.fbm2(z * 0.19, side * 7.7, 3, 2.2, 0.55);
        if (mask < -0.02) continue;
        var count = 1 + Math.round(M.saturate(mask * 2.2) * 3);
        for (i = 0; i < count; i++) {
          var d = Math.abs(rng.gaussian(0, 0.24)) + 0.03;
          x = this._in(fac.x, side, d);
          this._drop('weed', x, z + rng.gaussian(0, 0.35), rng.range(0, 6.283), {
            tilt: 0.16, tint: 0x9aa06a, vLo: 0.6, vHi: 1.25, hue: 0.10,
            scale: rng.range(0.55, 1.45)
          });
        }
        // occasional bigger scrub where the crack is widest
        if (mask > 0.22 && rng.bool(0.16)) {
          x = this._in(fac.x, side, rng.range(0.1, 0.45));
          this._drop('scrub', x, z, rng.range(0, 6.283), {
            tilt: 0.1, tint: 0x8a9060, vLo: 0.6, vHi: 1.25, hue: 0.10,
            scale: rng.range(0.55, 1.15)
          });
        }
      }
    }

    // ---- weeds in the gutter line and in road cracks ----------------------
    for (i = 0; i < 230; i++) {
      var gz = M.lerp(this.z0, this.z1, rng.next());
      var gside = rng.bool() ? -1 : 1;
      var gf = this._facade(gz, gside);
      var gx = this._in(gf.x, gside, rng.range(2.0, 2.75));
      if (n.fbm2(gx * 0.4, gz * 0.4, 2, 2, 0.5) < 0.05) continue;
      this._drop('weed', gx, gz, rng.range(0, 6.283), {
        tilt: 0.2, tint: 0x8f9662, vLo: 0.55, vHi: 1.2, hue: 0.1,
        scale: rng.range(0.4, 1.0)
      });
    }

    // ---- scrub taking hold in the rubble ---------------------------------
    for (i = 0; i < 44; i++) {
      var rside = rng.bool() ? -1 : 1;
      var rz = M.lerp(this.z0 + 3, this.z1 - 3, rng.next());
      var rf = this._facade(rz, rside);
      var rx = this._in(rf.x, rside, rng.range(0.3, 1.5));
      this._drop('scrub', rx, rz, rng.range(0, 6.283), {
        y: this._ground(rx, rz) + rng.range(0, 0.22),
        tilt: 0.14, tint: 0x7f8a58, vLo: 0.55, vHi: 1.25, hue: 0.11,
        scale: rng.range(0.45, 1.05)
      });
    }

    // ---- potted plants outside doorways and on the stall counters --------
    for (i = 0; i < 13; i++) {
      var pside = rng.bool() ? -1 : 1;
      var pz = M.lerp(this.z0 + 3, this.z1 - 3, rng.next());
      var pf = this._facade(pz, pside);
      if (!pf.solid) continue;
      var px = this._in(pf.x, pside, rng.range(0.35, 0.95));
      var pgy = this._ground(px, pz);
      this._drop('planter', px, pz, rng.range(0, 6.283), {
        y: pgy, tilt: 0.04,
        color: this._jit(rng.pick([0xa8724c, 0x8a7060, 0xb08a5a, 0x6e6a62]), 0.72, 1.14, 0.06),
        scale: rng.range(0.85, 1.35)
      });
      this._drop('potFoliage', px, pz, rng.range(0, 6.283), {
        y: pgy + 0.27, tilt: 0.06, tint: 0x8fa06a, vLo: 0.6, vHi: 1.2, hue: 0.1,
        scale: rng.range(0.75, 1.2)
      });
    }

    // ---- palms ------------------------------------------------------------
    // Three or four, at the ends of the street and one mid-block, where a
    // planted median or a courtyard entrance would plausibly be.
    var palmSpots = [
      { x: -this.halfW * 0.62, z: this.z1 - rng.range(2, 7) },
      { x: this.halfW * 0.66, z: this.z1 - rng.range(16, 24) },
      { x: -this.halfW * 0.70, z: this.z0 + rng.range(5, 12) },
      { x: this.halfW * 0.58, z: M.lerp(this.z0, this.z1, 0.5) + rng.range(-4, 4) }
    ];
    for (i = 0; i < palmSpots.length; i++) {
      var sp = palmSpots[i];
      if (this._blocked(sp.x, 1.5, sp.z, 0.7)) continue;
      var pgy2 = this._ground(sp.x, sp.z);
      var yaw = rng.range(0, 6.283);
      var pscale = rng.range(0.82, 1.25);
      this._drop('palmTrunk', sp.x, sp.z, yaw, {
        y: pgy2, tilt: 0.03, tint: 0xa39176, vLo: 0.78, vHi: 1.08, hue: 0.04,
        scale: pscale
      });
      this._collider(sp.x, pgy2 + 1.2, sp.z, 0.22, 1.2, 0.22, 0, 'wood');
      // crown: fronds radiating from the top of the (leaning) trunk
      var lean = 0.5 * pscale;
      var topX = sp.x + Math.sin(1.15) * lean * Math.cos(yaw);
      var topZ = sp.z - Math.sin(1.15) * lean * Math.sin(yaw);
      var topY = pgy2 + 4.6 * pscale;
      // Two whorls of fronds: an upper crown held near horizontal and a lower
      // one drooping.  A single ring of evenly-drooping fronds reads as a star.
      var nF = rng.int(16, 21);
      for (var f = 0; f < nF; f++) {
        var fa2 = (f / nF) * Math.PI * 2 + rng.range(-0.14, 0.14);
        var droop = (f % 2 === 0) ? rng.range(-0.42, -0.05) : rng.range(0.25, 0.72);
        var b = this.B.frond;
        if (!b) break;
        b.add(T(topX, topY - rng.range(0, 0.3), topZ,
          fa2, droop, rng.range(-0.15, 0.15),
          pscale * rng.range(0.85, 1.15), pscale * rng.range(0.85, 1.15), pscale * rng.range(0.9, 1.15)),
          this._jit(0x8f9a58, 0.68, 1.18, 0.09));
      }
      // dead skirt of hanging fronds just under the crown
      for (f = 0; f < rng.int(3, 6); f++) {
        var da = rng.range(0, 6.283);
        var b2 = this.B.frond;
        if (!b2) break;
        b2.add(T(topX, topY - rng.range(0.25, 0.55), topZ, da, rng.range(0.9, 1.4), 0,
          pscale * 0.85, pscale * 0.85, pscale * 0.85),
          this._jit(0x8a6a40, 0.6, 1.05, 0.06));
      }
      // litter of dropped fronds and a dust ring at the base
      this._decal(sp.x, sp.z, 1.9, 2, 0xc4ad88, 0.4);
      for (f = 0; f < rng.int(2, 5); f++) {
        this._drop('timber', sp.x + rng.gaussian(0, 0.8), sp.z + rng.gaussian(0, 0.8),
          rng.range(0, 6.283), {
            tilt: 0.35, tint: 0x9a8258, vLo: 0.65, vHi: 1.1, hue: 0.06,
            sx: rng.range(0.5, 0.9), sy: 0.5, sz: rng.range(0.6, 1.1)
          });
      }
    }
  };

  // --------------------------------------------------------------------------
  // Pocket spaces: the alley, the gutted interior, the accessible rooftop.
  // These are the three capture scenarios that are NOT the main street, so they
  // get deliberate, hand-composed dressing rather than scatter.
  // --------------------------------------------------------------------------
  // The alley is published as a hero capture, so it is composed rather than
  // scattered: every object below is placed at an explicit distance from the
  // camera pose, alternating walls, so the corridor reads in depth layers
  // (foreground mass -> mid clutter -> far silhouette) instead of funnelling
  // the eye straight to the bright slot at the end.
  //
  // The alley's axis comes from the published pose - that pose looks DOWN the
  // alley by construction - and the two side walls are PROBED, not assumed:
  // the pose is not on the alley centreline, so a symmetric +/- lateral offset
  // buries half the dressing inside a building.
  Props.prototype._dressAlley = function (poses) {
    var rng = this.rng;
    var i, k;

    var A = { x: 11, z: 2, fx: 1, fz: 0 };
    if (poses && poses.alley && poses.alley.position) {
      A.x = poses.alley.position.x;
      A.z = poses.alley.position.z;
      var ay = poses.alley.yaw || 0;
      A.fx = -Math.sin(ay);
      A.fz = -Math.cos(ay);
    }
    var arx = -A.fz, arz = A.fx;                 // right-hand perpendicular
    function pt(fwd, lat) {
      return { x: A.x + A.fx * fwd + arx * lat, z: A.z + A.fz * fwd + arz * lat };
    }
    var aGY = this._ground(A.x, A.z);
    var aYaw = Math.atan2(-A.fx, -A.fz);         // yaw facing back down the alley
    var self = this;

    // Walk out sideways until we hit something: that is the wall.  Done at
    // three depths and averaged, so one doorway reveal does not skew it.
    function wallAt(sign) {
      var acc = 0, hits = 0;
      for (var s = 0; s < 3; s++) {
        var f = 1.0 + s * 2.4;
        for (var d = 0.5; d < 6.0; d += 0.14) {
          var q = pt(f, sign * d);
          if (self._blocked(q.x, 1.2, q.z, 0.16)) { acc += d; hits++; break; }
        }
      }
      return hits ? (acc / hits) : 1.9;
    }
    var wL = this._noLevel ? 1.9 : wallAt(-1);   // left wall distance
    var wR = this._noLevel ? 1.9 : wallAt(1);    // right wall distance
    // How far the alley actually runs before it opens out.  The mouth is where
    // BOTH side walls stop, not where the centreline is first blocked - past
    // that point we are in the street and the street dressing owns the space.
    var depth = 7.0;
    if (!this._noLevel) {
      depth = 2.0;
      for (i = 1.0; i < 15.0; i += 0.5) {
        var okL = false, okR = false, d2, qq;
        for (d2 = 0.35; d2 < 4.6; d2 += 0.2) {
          qq = pt(i, -d2);
          if (this._blocked(qq.x, 1.2, qq.z, 0.16)) { okL = true; break; }
        }
        for (d2 = 0.35; d2 < 4.6; d2 += 0.2) {
          qq = pt(i, d2);
          if (this._blocked(qq.x, 1.2, qq.z, 0.16)) { okR = true; break; }
        }
        if (!(okL && okR)) break;
        depth = i;
      }
    }
    depth = M.clamp(depth, 4.0, 11.0);
    // Wall-hugging lateral offset for a prop of half-width `hw`.
    function lane(sign, hw) {
      var w = sign < 0 ? wL : wR;
      return sign * M.clamp(w - hw - 0.06, 0.35, w);
    }

    if (!this._lines) this._lines = [];

    // ---- 3.5 m, left wall: the dumpster.  Foreground mass, and the thing
    // that gives the shot a near-field silhouette to read the depth against.
    var dLat = lane(-1, 0.58);
    var dp = pt(depth * 0.46, dLat);
    var dyaw = aYaw + Math.PI * 0.5 * (dLat < 0 ? 1 : -1) + rng.range(-0.09, 0.09);
    this._addStatic('painted', K.dumpster(), Tn(dp.x, this._ground(dp.x, dp.z), dp.z, 0, dyaw, 0));
    this._collider(dp.x, this._ground(dp.x, dp.z) + 0.6, dp.z, 0.95, 0.6, 0.6, dyaw, 'metal');
    // Bin bags spilled out of it.  These are BLACK PLASTIC, and they used to go
    // through _jit, which normalises a hex by its own max channel and turns it
    // into a unit-centred HUE multiplier - so 0x2a2c2e arrived as very nearly
    // white and five refuse sacks rendered as sacks of flour, in the darkest
    // framing in the set.  A bin bag needs an absolute value, not a hue shift.
    for (i = 0; i < 5; i++) {
      var bg = pt(depth * 0.46 + rng.range(-1.1, 1.1), dLat + rng.range(-0.1, 0.6) * (dLat < 0 ? 1 : -1));
      _col.setRGB(0.20, 0.20, 0.215).multiplyScalar(rng.range(0.8, 1.3));
      this._drop('sack', bg.x, bg.z, rng.range(0, 6.283), {
        tilt: 0.35, color: _col,
        sx: rng.range(0.8, 1.2), sy: rng.range(0.7, 1.05), sz: rng.range(0.8, 1.2)
      });
    }
    var dsp = pt(depth * 0.46 + 1.0, dLat * 0.55);
    this._decal(dsp.x, dsp.z, rng.range(1.8, 2.6), 3, 0x2b2822, rng.range(0.5, 0.75));
    this._litter(dsp.x, dsp.z, 1.3, rng.int(6, 11));

    // ---- the wet patch, under the fire escape drip line.  The art direction
    // asks for exactly one, and it belongs where water would actually fall.
    //
    // These used to be near-black (0x1b1f22 at 0.78 alpha) on an alley floor
    // that was already at p25 = 0.043, so they subtracted from the one region
    // of the frame that needed to gain.  A damp patch on a shaded surface is
    // DARKER IN ALBEDO BUT BRIGHTER IN SPECULAR - it is the only thing down
    // there carrying the sky - so the albedo comes up and m.decalWet does the
    // rest with its own env term.
    var wp = pt(depth * 0.55, lane(1, 1.1) * 0.92);
    this._wetDecal(wp.x, wp.z, 2.2, 3, 0x33393e, 0.62, aYaw, rng.range(0.55, 0.85));
    this._wetDecal(wp.x + rng.range(-0.5, 0.5), wp.z + rng.range(-0.5, 0.5),
      rng.range(0.9, 1.5), 3, 0x3b4249, 0.46, aYaw, rng.range(0.5, 0.95));
    var wp2 = pt(depth * 0.82, lane(-1, 1.0) * 0.6);
    this._wetDecal(wp2.x, wp2.z, rng.range(1.4, 2.2), 3, 0x353c42, 0.5, aYaw, rng.range(0.45, 0.9));

    // ---- THE VALUE ISLAND -------------------------------------------------
    // ART_DIRECTION mandates one shaft of light in this alley, and props have
    // to supply something for it to strike.  With p25 = 0.043 and a centre of
    // frame at 0.171, the eye had nowhere to land at all: the two brightest
    // objects in the shot were hanging sheets above the subject and the sky
    // slot behind it, both of which pull the eye up and out.
    //
    // So: a rust-orange drum and a tipped chair on a pool of drifted sand, on
    // the lane opposite the dumpster, at the depth the shaft would land.  Warm,
    // and the only saturated thing in a blue-grey corridor.
    var isLat = lane(1, 0.42) * rng.range(0.58, 0.74);
    var isP = pt(depth * 0.66, isLat);
    this._decal(isP.x, isP.z, rng.range(2.4, 3.2), 2, 0xcfb891, 0.42, aYaw, rng.range(0.7, 1.1));
    this._decal(isP.x + rng.range(-0.6, 0.6), isP.z + rng.range(-0.6, 0.6),
      rng.range(1.2, 1.9), 2, 0xd6c09a, 0.34);
    this._drop('drum', isP.x, isP.z, rng.range(0, 6.283), {
      tilt: 0.03, color: this._jit(0xb0552a, 0.92, 1.16, 0.05)
    });
    this._collider(isP.x, this._ground(isP.x, isP.z) + 0.44, isP.z, 0.3, 0.44, 0.3, 0, 'metal');
    var chP = pt(depth * 0.66 + rng.range(-0.75, 0.75), isLat * rng.range(0.5, 0.78));
    var chB = this.B.chair;
    if (chB) {
      chB.add(T(chP.x, this._ground(chP.x, chP.z) + 0.22, chP.z,
        Math.PI * 0.5 + rng.range(-0.25, 0.25), rng.range(0, 6.283), rng.range(-0.25, 0.25)),
        this._jit(0xc0b49a, 0.9, 1.2, 0.05));
    }

    // ---- one mid-depth cluster, not two.  With a 0.6 m crate stack and a
    // 0.44 m drum against BOTH walls at TWO depths there was no clear floor
    // left in a 1.9 m corridor for the shaft to land on.
    var stackDepths = [depth * 0.88];
    for (k = 0; k < stackDepths.length; k++) {
      var sSign = -1;
      var sLat = lane(sSign, 0.55);
      var sp = pt(stackDepths[k], sLat);
      var syaw = aYaw + rng.range(-0.35, 0.35);
      if (rng.bool(0.55)) {
        var hgt = rng.int(2, 4);
        for (i = 0; i < hgt; i++) {
          this._drop('pallet', sp.x + rng.range(-0.05, 0.05), sp.z + rng.range(-0.05, 0.05), syaw, {
            y: this._ground(sp.x, sp.z) + i * 0.146, tilt: 0.02,
            tint: 0xa8977c, vLo: 0.58, vHi: 1.06, hue: 0.07
          });
        }
        this._crate(sp.x + rng.range(-0.2, 0.2), sp.z + rng.range(-0.2, 0.2), {
          yaw: syaw + rng.range(-0.7, 0.7),
          y: this._ground(sp.x, sp.z) + hgt * 0.146, tilt: 0.07,
          tint: 0xb8a68a, vLo: 0.55, vHi: 1.08, hue: 0.08, topple: 0.2
        });
        this._collider(sp.x, this._ground(sp.x, sp.z) + hgt * 0.073, sp.z, 0.6, hgt * 0.073, 0.45, syaw, 'wood');
      } else {
        var rows = rng.int(2, 3);
        for (i = 0; i < rows; i++) {
          for (var j = 0; j < 2; j++) {
            this._crate(
              sp.x + rng.range(-0.05, 0.05) + arx * (j - 0.5) * 0.42,
              sp.z + rng.range(-0.05, 0.05) + arz * (j - 0.5) * 0.42, {
                yaw: syaw + rng.range(-0.3, 0.3),
                y: this._ground(sp.x, sp.z) + i * 0.345, tilt: 0.03,
                tint: 0xb8a68a, vLo: 0.55, vHi: 1.1, hue: 0.08,
                topple: i === rows - 1 ? 0.18 : 0.03
              });
          }
        }
        this._collider(sp.x, this._ground(sp.x, sp.z) + rows * 0.17, sp.z, 0.5, rows * 0.17, 0.35, syaw, 'wood');
      }
      // a drum tucked beside every cluster, for a second silhouette height
      var dq = pt(stackDepths[k] + rng.range(-0.9, 0.9), sLat * rng.range(0.82, 0.98));
      this._drop('drum', dq.x, dq.z, rng.range(0, 6.283), {
        tilt: 0.04, color: this._jit(rng.pick([0x8a4a2a, 0x5a6a5c, 0x6a6f74]), 0.62, 1.06, 0.07)
      });
      this._collider(dq.x, this._ground(dq.x, dq.z) + 0.44, dq.z, 0.3, 0.44, 0.3, 0, 'metal');
    }

    // ---- conduit / pipe bundle running the left wall at 2.4 m -------------
    // Pulled hard against the plaster: a service run standing a foot off the
    // wall reads as three floating scaffold poles, not as conduit.
    // The probe stops 0.16 m short of the plaster (that is the sphere radius it
    // tests with), so the run is pushed slightly past it to graze the wall, and
    // kept well inside the alley mouth - a run that overshoots the end of the
    // wall leaves three bars hanging in open air.
    var pipeLat = -(wL + 0.10);
    var pipeLen = M.clamp(depth * 0.55, 2.5, 6.0);
    var pmid = pt(depth * 0.5, pipeLat);
    var pipes = K.pipeRun(rng, pipeLen, rng.int(3, 4));
    if (pipes) {
      // local +X along the run, local +Z into the wall
      this._addStatic('rust', pipes, Tn(pmid.x, aGY + rng.range(2.25, 2.6), pmid.z,
        0, aYaw + Math.PI * 0.5 * (pipeLat < 0 ? -1 : 1), 0));
    }
    // a second, thinner run lower down on the opposite wall
    var pipe2Lat = wR + 0.10;
    var pmid2 = pt(depth * 0.52, pipe2Lat);
    var pipes2 = K.pipeRun(rng, M.clamp(depth * 0.42, 2.0, 5.0), 2);
    if (pipes2) {
      this._addStatic('rust', pipes2, Tn(pmid2.x, aGY + rng.range(1.5, 1.9), pmid2.z,
        0, aYaw + Math.PI * 0.5 * (pipe2Lat < 0 ? -1 : 1), 0));
    }

    // ---- AC condenser bracketed at 3.6 m, with the rust streak it weeps ----
    var acLat = lane(1, 0.24);
    var acp = pt(depth * 0.44, acLat);
    // yaw that turns the unit's louvre face out into the alley, not into the
    // plaster it is bolted to
    var acYaw = aYaw + Math.PI * 0.5 * (acLat > 0 ? -1 : 1);
    var acY = aGY + rng.range(3.3, 3.9);
    this._drop('ac', acp.x, acp.z, acYaw, {
      y: acY, tilt: 0.01, tint: 0xb4b0a6, vLo: 0.62, vHi: 0.94, hue: 0.03
    });
    var brk = K.wallBracket(0.74, 0.42);
    if (brk) this._addStatic('rust', brk, Tn(acp.x, acY - 0.34, acp.z, 0, acYaw, 0));
    // The streak below it is registered on the level so the wall shader can
    // pick it up too, but we draw our own decal regardless of whether it does.
    var acSide = acLat > 0 ? (arx > 0 ? 1 : -1) : (arx > 0 ? -1 : 1);
    this._wallDecal(acp.x - arx * (acLat > 0 ? 0.16 : -0.16), acY - 1.5,
      acp.z - arz * (acLat > 0 ? 0.16 : -0.16), acSide, 0.55, 2.6, 3, 0x6a4a30, 0.42);
    try {
      var lvlStreaks = this.ctx.level && this.ctx.level.streaks;
      if (lvlStreaks && lvlStreaks.push) {
        lvlStreaks.push({ p: new THREE.Vector3(acp.x, acY - 0.3, acp.z), r: 1.1 });
      }
    } catch (e) { /* level owns that array; never fatal if it does not want it */ }

    // ---- 8-12 m: boards and a bike leaning on the wall.  Far layer, read as
    // silhouette against the bright slot rather than as detail.
    var leanSign = rng.bool() ? -1 : 1;
    var leanLat = lane(leanSign, 0.12);
    for (i = 0; i < 4; i++) {
      var lb2 = pt(depth * rng.range(0.70, 0.99), leanLat * rng.range(0.9, 1.0));
      // roll sign is what puts the TOP of the board on the wall rather than
      // standing it up leaning out into the walkway
      this._drop('timber', lb2.x, lb2.z, aYaw + rng.range(-0.5, 0.5), {
        y: this._ground(lb2.x, lb2.z) + rng.range(0.55, 0.95),
        tilt: 0.06, pitch: 0, roll: leanSign * rng.range(1.20, 1.36),
        tint: 0x9c8a6c, vLo: 0.55, vHi: 1.05, hue: 0.07,
        sx: rng.range(1.2, 1.9), sy: rng.range(1.2, 2.2), sz: rng.range(1.4, 2.6)
      });
    }
    var bikeSign = -leanSign;
    var bp2 = pt(depth * rng.range(0.66, 0.86), lane(bikeSign, 0.2));
    var bike = K.bicycle(rng);
    if (bike) {
      // The bike leans about its own travel axis (the X rotation in a YXZ
      // Euler), never about Z - a Z roll would tip it forwards down the alley.
      this._addStatic('rust', bike,
        Tn(bp2.x, this._ground(bp2.x, bp2.z), bp2.z,
          -rng.range(0.20, 0.30),
          aYaw + Math.PI * 0.5 * (bikeSign > 0 ? -1 : 1) + rng.range(-0.25, 0.25), 0));
    }

    // ---- clutter along both walls, still leaving the centre walkable.
    // Nothing closer than 2.4 m: the published pose is a composition, and a
    // pallet a metre off the lens is a wall across the frame, not dressing.
    for (i = 0; i < 8; i++) {
      var cSign = rng.bool() ? -1 : 1;
      var cLat = lane(cSign, 0.34) * rng.range(0.82, 1.0);
      var cFwd = rng.range(3.4, Math.max(4.0, depth));
      var ap = pt(cFwd, cLat);
      if (this._blocked(ap.x, 0.6, ap.z, 0.34)) continue;
      var pick = rng.next();
      if (pick < 0.26) {
        this._drop('bin', ap.x, ap.z, rng.range(0, 6.283), {
          tilt: 0.05, color: this._jit(0x4f5a53, 0.6, 1.02, 0.05)
        });
      } else if (pick < 0.5) {
        this._crate(ap.x, ap.z, {
          tilt: rng.bool(0.3) ? 0.7 : 0.06, tint: 0xb8a68a, vLo: 0.55, vHi: 1.08,
          hue: 0.08, topple: 0.22
        });
      } else if (pick < 0.72) {
        this._drop('pallet', ap.x, ap.z, aYaw + rng.range(-0.3, 0.3), {
          y: this._ground(ap.x, ap.z) + 0.5, tilt: 0.04,
          roll: cSign * rng.range(1.12, 1.3),
          tint: 0xa8977c, vLo: 0.58, vHi: 1.06, hue: 0.06
        });
      } else if (pick < 0.88) {
        this._drop('jerrycan', ap.x, ap.z, rng.range(0, 6.283), {
          tilt: 0.06, color: this._jit(rng.pick([0x5c6349, 0x494f56, 0x6b6f5e]), 0.62, 1.0, 0.06)
        });
      } else {
        this._drop('scrub', ap.x, ap.z, rng.range(0, 6.283), {
          tilt: 0.2, tint: 0x7d8455, vLo: 0.55, vHi: 1.05, hue: 0.1, scale: rng.range(0.5, 0.9)
        });
      }
    }
    // grit and weeds in the wall/ground joint, both sides
    for (i = 0; i < 16; i++) {
      var gSign = i % 2 === 0 ? -1 : 1;
      var gp = pt(rng.range(0.4, depth + 0.5), lane(gSign, 0.05) * rng.range(0.9, 1.0));
      this._drop('pebble', gp.x, gp.z, rng.range(0, 6.283), {
        tilt: 0.7, tint: 0xa9a297, vLo: 0.5, vHi: 1.05, hue: 0.05, scale: rng.range(0.6, 1.6)
      });
      if (rng.bool(0.4)) {
        this._drop('weed', gp.x, gp.z, rng.range(0, 6.283), {
          tilt: 0.1, tint: 0x7f8a55, vLo: 0.5, vHi: 1.0, hue: 0.1, scale: rng.range(0.6, 1.2)
        });
      }
    }
    for (i = 0; i < 3; i++) {
      var lp = pt(rng.range(0.6, depth), lane(rng.bool() ? -1 : 1, 0.3) * rng.range(0.5, 0.95));
      this._litter(lp.x, lp.z, 1.0, rng.int(3, 7));
    }
    var brp = pt(rng.range(1.0, 3.0), lane(rng.bool() ? -1 : 1, 0.6) * rng.range(0.5, 0.9));
    this._brassField(brp.x, brp.z, 0.9, 0.7, 26);
    this._decal(brp.x, brp.z, rng.range(1.4, 2.2), 1, 0x2a2622, rng.range(0.3, 0.55));

    // ---- washing strung wall to wall.  ONE line, and it is kept past 0.75 of
    // the alley's depth so it is never directly above the subject: this used to
    // run two lines from 0.3 of depth, which put the two brightest objects in
    // the frame over the head of whatever the shot was about and lifted the eye
    // straight out of the composition.
    for (i = 0; i < 1; i++) {
      var fwd = M.lerp(depth * 0.76, depth * 0.98, rng.next());
      var pA = pt(fwd, -wL + 0.1), pB = pt(fwd + rng.range(-0.4, 0.4), wR - 0.1);
      var lyA = aGY + rng.range(3.9, 5.2);
      var la = new THREE.Vector3(pA.x, lyA, pA.z);
      var lbv = new THREE.Vector3(pB.x, lyA + rng.range(-0.3, 0.3), pB.z);
      this._lines.push({ a: la, b: lbv, sag: 0.45, kind: 'laundry' });
      for (var q = 0; q < 3; q++) {
        sagPoint(la, lbv, 0.45, (q + 0.7) / 3.8, _vb);
        if (this._blocked(_vb.x, _vb.y - 0.4, _vb.z, 0.3)) continue;
        if (!this._openAbove(_vb.x, _vb.y + 0.15, _vb.z, 2.2)) continue;
        this._drop('laundry', _vb.x, _vb.z, aYaw + rng.range(-0.3, 0.3), {
          y: _vb.y - 0.03, tilt: 0.05,
          color: this._clothCol(rng.pick(LAUNDRY_TINTS), 0.62, 0.94),
          scale: rng.range(0.8, 1.25)
        });
      }
    }

  };

  Props.prototype._dressPockets = function () {
    var rng = this.rng;
    var poses = (this.ctx.level && this.ctx.level.cameraPoses) || null;
    var i;

    this._dressAlley(poses);

    // ---- gutted interior (west, ~x -6) ------------------------------------
    var inter = { x: -6, z: -4 };
    if (poses && poses.interior && poses.interior.position) {
      inter.x = poses.interior.position.x;
      inter.z = poses.interior.position.z;
    }
    var iGY = this._ground(inter.x, inter.z, 2.0, 5);
    // Turn the counter to face the interior camera, so the shot gets a strong
    // horizontal foreground element instead of a random side-on box.
    var iyaw = poses && poses.interior ? (poses.interior.yaw || 0) + Math.PI + rng.range(-0.25, 0.25)
      : rng.range(0, 6.283);
    var ifx = poses && poses.interior ? -Math.sin(poses.interior.yaw || 0) : 0;
    var ifz = poses && poses.interior ? -Math.cos(poses.interior.yaw || 0) : -1;
    var ctm = Tn(inter.x + ifx * rng.range(2.2, 3.4), iGY,
      inter.z + ifz * rng.range(2.2, 3.4), 0, iyaw, 0);
    this._addStatic('wood', K.shopCounter(rng), ctm);
    this._addStatic('concrete', K.shopCounterTop(), ctm);
    this._collider(inter.x + ifx * 2.8, iGY + 0.5, inter.z + ifz * 2.8, 1.3, 0.5, 0.4, iyaw, 'wood');
    // toppled shelving
    this._addStatic('wood', K.shelving(),
      Tn(inter.x + rng.range(-2.5, -1.0), iGY, inter.z + rng.range(-3, -1.4),
        rng.range(-0.1, 0.1), rng.range(0, 6.283), Math.PI * 0.48));
    this._addStatic('wood', K.shelving(),
      Tn(inter.x + rng.range(-2.6, -1.2), iGY, inter.z + rng.range(1.4, 3.0), 0, rng.range(0, 6.283), 0));
    // dust, debris, paper across the floor - this is the dust-shaft scenario
    this._rubblePile(inter.x + rng.range(-1.5, 1.5), inter.z + rng.range(-1.5, 1.5),
      1.5, 1.4, rng.range(-0.3, 0.3), rng.range(-0.3, 0.3));
    this._litter(inter.x, inter.z, 2.6, 34);
    this._glassField(inter.x + rng.range(-1, 1), inter.z + rng.range(-1, 1), 1.9, 1.6, 90, rng.range(0, 3.1));
    for (i = 0; i < 7; i++) {
      var cx2 = inter.x + rng.gaussian(0, 1.6), cz2 = inter.z + rng.gaussian(0, 1.9);
      this._crate(cx2, cz2, {
        y: this._ground(cx2, cz2, 2.0, 5, iGY),
        tilt: rng.bool(0.3) ? 0.55 : 0.05,
        tint: 0xb0a084, vLo: 0.58, vHi: 1.12, hue: 0.07, topple: 0.3
      });
    }
    for (i = 0; i < 3; i++) {
      this._drop('chair', inter.x + rng.gaussian(0, 1.8), inter.z + rng.gaussian(0, 2.0),
        rng.range(0, 6.283), {
          tilt: 0.5, color: this._jit(0x9aa89e, 0.6, 1.05, 0.06)
        });
    }
    this._decal(inter.x, inter.z, 4.5, 2, 0xc0ab88, 0.5);
    this.dustSites.push({ x: inter.x, z: inter.z, y: iGY, r: 3.2, h: 3.0, n: 240, size: 0.9 });

    // ---- accessible rooftop -----------------------------------------------
    // This is one of five hero framings and it was the weakest, because its
    // dressing was scattered around the camera POSITION with a gaussian: half
    // of it landed behind the eye and most of the rest inside 3 m, where it
    // falls below the frustum.  The water tank that level.js promises as "the
    // near right foreground mass" was placed at roof.x - 2..4, which is past
    // the rear parapet - off the roof entirely.
    //
    // So: derive the scatter area from the ROOF (probe a grid and keep the
    // cells that are actually deck), and place the hero anchors along the
    // camera FORWARD vector so they land in shot at three depths.
    var roof = { x: -14, y: 9, z: -12 };
    var rYaw = 0;
    if (poses && poses.rooftop && poses.rooftop.position) {
      roof.x = poses.rooftop.position.x;
      roof.y = poses.rooftop.position.y;
      roof.z = poses.rooftop.position.z;
      rYaw = poses.rooftop.yaw || 0;
    }
    var rY = this._roof(roof.x, roof.z);
    if (rY < 0) rY = roof.y - 1.7;
    // camera basis, three.js YXZ convention
    var rfx = -Math.sin(rYaw), rfz = -Math.cos(rYaw);
    var rrx = Math.cos(rYaw), rrz = -Math.sin(rYaw);

    // Probe the deck on a 1 m grid.
    //
    // THE GATE USED TO BE `Math.abs(qy - rY) > 0.5` - the camera's OWN deck
    // height and nothing else.  But this pose looks across a parapet onto a
    // LOWER adjacent deck which fills the bottom-left third of the frame, and
    // every cell on that deck failed the gate, so all thirty clutter props and
    // sixty-eight ground-dressing props landed behind the parapet where they
    // are invisible.  Centre-of-frame measured 0.182 with p25 = 0.075: the
    // darkest subject region of any daylight capture, and nothing in it.
    //
    // So lower decks qualify, and a cell is additionally only accepted if the
    // eye-to-cell ray actually clears whatever is between - otherwise we would
    // just be dressing the far side of the parapet instead of the near side.
    var self2 = this;
    var eyeY = roof.y;
    function deckVisible(qx, qy, qz) {
      var dx = qx - roof.x, dz = qz - roof.z;
      var dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 1.0) return true;
      for (var sN = 1; sN <= 4; sN++) {
        var tt = sN / 5;
        var sy = self2._roof(roof.x + dx * tt, roof.z + dz * tt);
        if (sy < 0) continue;                        // open air / street below
        if (sy > eyeY + (qy - eyeY) * tt + 0.20) return false;
      }
      return true;
    }

    var cells = [];         // the camera's own deck
    var lowCells = [];      // visible lower decks
    var allCells = [];
    var gx, gz;
    for (gx = -16; gx <= 16; gx += 1.25) {
      for (gz = -16; gz <= 16; gz += 1.25) {
        var qx = roof.x + gx, qz = roof.z + gz;
        var qy = this._roof(qx, qz);
        // Any deck at or below the camera's own qualifies.  The old gate was
        // |qy - rY| <= 0.5, which meant only the strip the camera stands on;
        // there is no lower bound now because deckVisible is the real test and
        // this district's roofs step down by three and four metres at a time.
        if (qy < 0 || qy > rY + 0.5) continue;
        var ahead = gx * rfx + gz * rfz;          // metres in front of the eye
        if (ahead < 1.4) continue;                // behind, or under the chin
        var cell = { x: qx, z: qz, y: qy, d: ahead,
          lat: gx * rrx + gz * rrz };
        if (qy > rY - 0.35) {
          cells.push(cell);
          allCells.push(cell);
        } else if (deckVisible(qx, qy, qz)) {
          lowCells.push(cell);
          allCells.push(cell);
        }
      }
    }
    var pickCell = function () {
      if (!allCells.length) return null;
      return allCells[rng.int(0, allCells.length - 1)];
    };
    // The region that needs a subject is the deck off the camera's LEFT
    // shoulder, so anchors are selected by screen band (depth AND lateral
    // offset), preferring the lower adjacent deck.  Falling back through
    // progressively looser pools means a roof laid out differently still gets
    // its anchors instead of silently getting none, which is what happened when
    // this only ever looked 6-11 m straight down the forward vector.
    // Snap to the deck cell nearest an INTENDED screen position, expressed as
    // (metres ahead, metres off the right shoulder).  A band filter plus a
    // random pick inside it is not good enough here: the region that needs a
    // subject is a specific wedge of frame, and if the band happens to be empty
    // the anchor silently vanishes - which is exactly what happened when this
    // only ever looked 6-11 m straight down the forward vector and put nothing
    // at all on the deck the camera actually overlooks.
    function anchorAt(fwd, lat) {
      var tx = roof.x + rfx * fwd + rrx * lat;
      var tz = roof.z + rfz * fwd + rrz * lat;
      var best = null, bestD = 1e9, q2, c2, dd;
      var ranked = [];
      for (var pass = 0; pass < 2; pass++) {
        var pool = pass === 0 ? lowCells : cells;
        ranked.length = 0;
        for (q2 = 0; q2 < pool.length; q2++) {
          c2 = pool[q2];
          dd = (c2.x - tx) * (c2.x - tx) + (c2.z - tz) * (c2.z - tz);
          ranked.push({ c: c2, d2: dd });
        }
        ranked.sort(function (a2, b2) { return a2.d2 - b2.d2; });
        // Nearest cell to the intent that the eye can ACTUALLY see: an anchor
        // that lands behind the parapet or the stair-head bulkhead is an anchor
        // that does not exist as far as the composition is concerned.
        for (q2 = 0; q2 < ranked.length && q2 < 26; q2++) {
          if (deckVisible(ranked[q2].c.x, ranked[q2].c.y, ranked[q2].c.z)) return ranked[q2].c;
        }
        if (ranked.length && ranked[0].d2 < bestD) { bestD = ranked[0].d2; best = ranked[0].c; }
      }
      return best;
    }

    // ---- hero anchors, staged down the sightline --------------------------
    // Near right foreground mass: the water tank on its stand.  Pushed out from
    // 3.4 m to 5.2 m, because at pitch -0.048 rad the near deck inside about
    // 4.7 m falls below the frustum entirely and the tank was out of shot even
    // when it did seat.
    var anchored = false;
    var wtDist = rng.range(4.8, 5.5);
    var wtx = roof.x + rfx * wtDist + rrx * rng.range(2.2, 2.8);
    var wtz = roof.z + rfz * wtDist + rrz * rng.range(2.2, 2.8);
    var wty = this._roof(wtx, wtz);
    if (wty < 0 || Math.abs(wty - rY) > 0.5) {
      // the ideal spot is off the deck; take the nearest valid cell instead
      var best = null, bestD = 1e9;
      for (i = 0; i < cells.length; i++) {
        var dd = Math.abs(cells[i].d - wtDist);
        if (dd < bestD) { bestD = dd; best = cells[i]; }
      }
      if (best) { wtx = best.x; wtz = best.z; wty = best.y; }
    }
    if (wty > 0) {
      this._addStatic('rust', K.waterTank(),
        Tn(wtx, wty, wtz, 0, rYaw + rng.range(-0.5, 0.5), 0));
      this._collider(wtx, wty + 0.9, wtz, 0.62, 0.9, 0.62, 0, 'metal');
      anchored = true;
      // the puddle and rust weep under it
      this._decal(wtx + rng.range(-0.4, 0.4), wtz + rng.range(-0.4, 0.4),
        rng.range(1.4, 2.2), 2, 0x8a6a4a, 0.42, undefined, undefined, wty);
    }

    // ---- the LOWER deck: give the bottom-left third a subject -------------
    // A pale breeze-block pigeon coop for silhouette, a rust-orange drum
    // cluster and a toppled dish for a second and third read, and a warm sand
    // pool under them so that region is not one dark value.  Every one of
    // these is on a cell the eye can actually see over the parapet.
    var coopCell = anchorAt(7.0, -2.5);
    if (coopCell) {
      var coopGeo = K.coop();
      if (coopGeo) {
        this._addStatic('concrete', coopGeo,
          Tn(coopCell.x, coopCell.y, coopCell.z, 0, rYaw + Math.PI + rng.range(-0.7, 0.7), 0));
        this._collider(coopCell.x, coopCell.y + 0.7, coopCell.z, 0.85, 0.7, 0.55, rYaw, 'concrete');
      }
      this._decal(coopCell.x + rfx * 1.4, coopCell.z + rfz * 1.4, rng.range(2.6, 3.6), 2,
        0xcfb891, 0.42, undefined, undefined, coopCell.y);
      anchored = true;
    }
    var drumCell = anchorAt(4.6, -1.7);
    if (drumCell) {
      // The one warm value island in a framing whose centre measured 0.182.
      for (i = 0; i < rng.int(2, 4); i++) {
        var ddx = drumCell.x + rng.gaussian(0, 0.45), ddz = drumCell.z + rng.gaussian(0, 0.45);
        this._drop('drum', ddx, ddz, rng.range(0, 6.283), {
          y: drumCell.y, tilt: 0.03,
          color: this._jit(rng.pick([0xb0552a, 0xa8623a, 0x9c4f2c]), 0.86, 1.14, 0.05)
        });
      }
      this._decal(drumCell.x, drumCell.z, rng.range(2.0, 2.8), 2, 0xd2bb96, 0.42,
        undefined, undefined, drumCell.y);
      anchored = true;
    }
    // A third read at a different height and silhouette.  Deliberately NOT a
    // toppled satellite dish: a 0.9 m parabola lying face-up catches the whole
    // sky and renders as a smooth white egg, which is worse than the empty deck
    // it was meant to fill.
    var stackCell = anchorAt(10.0, -3.4);
    if (stackCell) {
      var stackYaw = rYaw + rng.range(-0.9, 0.9);
      for (i = 0; i < rng.int(2, 4); i++) {
        this._drop('pallet', stackCell.x + rng.range(-0.07, 0.07),
          stackCell.z + rng.range(-0.07, 0.07), stackYaw + rng.range(-0.12, 0.12), {
            y: stackCell.y + i * 0.146, tilt: 0.02,
            tint: 0xbda98a, vLo: 0.72, vHi: 1.16, hue: 0.06
          });
      }
      this._crate(stackCell.x + rng.range(-0.25, 0.25), stackCell.z + rng.range(-0.25, 0.25), {
        y: stackCell.y + 0.44, yaw: stackYaw + rng.range(-0.6, 0.6), tilt: 0.06,
        tint: 0xc6b294, vLo: 0.7, vHi: 1.18, hue: 0.07, topple: 0.25
      });
      this._collider(stackCell.x, stackCell.y + 0.3, stackCell.z, 0.6, 0.3, 0.45, stackYaw, 'wood');
    }

    // mid ground: a bank of condensers on their frames
    var acx = roof.x + rfx * 7.0 + rrx * rng.range(-1.4, 0.6);
    var acz = roof.z + rfz * 7.0 + rrz * rng.range(-1.4, 0.6);
    var acy = this._roof(acx, acz);
    if (acy > 0 && Math.abs(acy - rY) < 0.5) {
      for (i = 0; i < 3; i++) {
        var abx = acx + rrx * (i - 1) * 1.05 + rng.range(-0.1, 0.1);
        var abz = acz + rrz * (i - 1) * 1.05 + rng.range(-0.1, 0.1);
        if (Math.abs(this._roof(abx, abz) - rY) > 0.5) continue;
        this._drop('ac', abx, abz, rYaw + Math.PI + rng.range(-0.18, 0.18), {
          y: acy + 0.29, tilt: 0.02,
          tint: 0xc4c0b6, vLo: 0.74, vHi: 1.08, hue: 0.03,
          sx: rng.range(0.92, 1.1), sy: rng.range(0.9, 1.08), sz: rng.range(0.92, 1.1)
        });
        this._collider(abx, acy + 0.42, abz, 0.42, 0.42, 0.3, rYaw, 'metal');
      }
      // a junction box on the deck beside them
      this._addStatic('rust', K.junctionBox(),
        Tn(acx + rrx * 2.0, acy + 0.02, acz + rrz * 2.0, 0, rYaw + Math.PI, 0));
      anchored = true;
    }

    // Far: an aerial cluster silhouetted against the sky, with the occasional
    // dish.  Dishes are rationed and shrunk here on purpose: a 0.9 m white
    // paraboloid seen near edge-on is a smooth pale ellipse with no readable
    // detail, and one of them landed on the dark lower deck as the single
    // brightest object in the region of frame that most needed a subject - it
    // read as an egg, not as a dish.  Small, weathered, and mostly aerials.
    for (i = 0; i < 4; i++) {
      var fdd = 9.0 + i * 1.8;
      var fdx = roof.x + rfx * fdd + rrx * rng.range(-3.8, 3.8);
      var fdz = roof.z + rfz * fdd + rrz * rng.range(-3.8, 3.8);
      var fdy = this._roof(fdx, fdz);
      if (fdy < 0 || Math.abs(fdy - rY) > 0.5) continue;
      if (rng.bool(0.28)) {
        this._drop('dish', fdx, fdz, rYaw + Math.PI + rng.range(-0.45, 0.45), {
          y: fdy, tilt: 0.02, tint: 0xc0bcb2, vLo: 0.60, vHi: 0.86, hue: 0.03,
          scale: rng.range(0.62, 0.85)
        });
      } else {
        this._drop('aerial', fdx, fdz, rng.range(0, 6.283), {
          y: fdy, tilt: 0.05, tint: 0xb0a698, vLo: 0.72, vHi: 1.1, hue: 0.05
        });
      }
    }

    // ---- general clutter, spread over the whole deck in front of the eye --
    for (i = 0; i < 30; i++) {
      var cell = pickCell();
      var ox, oz, oy;
      if (cell) {
        ox = cell.x + rng.range(-0.45, 0.45);
        oz = cell.z + rng.range(-0.45, 0.45);
        oy = cell.y;
      } else {
        ox = roof.x + rng.gaussian(0, 3.2);
        oz = roof.z + rng.gaussian(0, 3.6);
        oy = this._roof(ox, oz);
        if (oy < 0) oy = rY;
        if (Math.abs(oy - rY) > 1.2) continue;
      }
      var r2 = rng.next();
      if (r2 < 0.16) {
        this._drop('ac', ox, oz, rng.range(0, 6.283), {
          y: oy + 0.29, tilt: 0.02, tint: 0xc4c0b6, vLo: 0.74, vHi: 1.08, hue: 0.03
        });
      } else if (r2 < 0.28) {
        this._drop('aerial', ox, oz, rng.range(0, 6.283), {
          y: oy, tilt: 0.06, tint: 0xb0a698, vLo: 0.72, vHi: 1.1, hue: 0.05
        });
      } else if (r2 < 0.46) {
        this._drop('drum', ox, oz, rng.range(0, 6.283), {
          y: oy, tilt: 0.03,
          color: this._jit(rng.pick([0x8a4a2a, 0x6a6f74, 0x5a6a5c]), 0.7, 1.12, 0.07),
          sx: rng.range(0.96, 1.04), sy: rng.range(0.95, 1.05), sz: rng.range(0.96, 1.04)
        });
        this._collider(ox, oy + 0.44, oz, 0.3, 0.44, 0.3, 0, 'metal');
      } else if (r2 < 0.64) {
        this._crate(ox, oz, {
          y: oy, tilt: 0.06, tint: 0xb8a68a, vLo: 0.6, vHi: 1.12, hue: 0.07, topple: 0.25
        });
      } else if (r2 < 0.74) {
        this._drop('chair', ox, oz, rng.range(0, 6.283), {
          y: oy, tilt: 0.05, color: this._jit(0xa8b0a4, 0.65, 1.1, 0.06)
        });
      } else if (r2 < 0.84) {
        this._drop('pallet', ox, oz, rng.range(0, 6.283), {
          y: oy, tilt: 0.03, tint: 0xbda98a, vLo: 0.68, vHi: 1.14, hue: 0.06
        });
      } else if (r2 < 0.92) {
        this._drop('jerrycan', ox, oz, rng.range(0, 6.283), {
          y: oy, tilt: 0.05, color: this._jit(rng.pick([0x5c6349, 0x7a4a34]), 0.75, 1.12, 0.06)
        });
      } else {
        this._drop('planter', ox, oz, rng.range(0, 6.283), {
          y: oy, tilt: 0.02, tint: 0xa8776a, vLo: 0.7, vHi: 1.12, hue: 0.06
        });
        this._drop('scrub', ox + rng.range(-0.12, 0.12), oz + rng.range(-0.12, 0.12),
          rng.range(0, 6.283), {
            y: oy + 0.34, tilt: 0.12, tint: 0x8a9060, vLo: 0.6, vHi: 1.15, hue: 0.1,
            scale: rng.range(0.5, 0.8)
          });
      }
    }

    // ---- a laundry line strung ACROSS the frame, not behind the viewer ----
    var lzF = 4.6, lHalf = 3.6;
    var laX = roof.x + rfx * lzF - rrx * lHalf, laZ = roof.z + rfz * lzF - rrz * lHalf;
    var lbX = roof.x + rfx * (lzF + 0.6) + rrx * lHalf;
    var lbZ = roof.z + rfz * (lzF + 0.6) + rrz * lHalf;
    var ra = new THREE.Vector3(laX, rY + 1.85, laZ);
    var rb = new THREE.Vector3(lbX, rY + 1.72, lbZ);
    this._roofLine = { a: ra, b: rb, sag: 0.4, kind: 'laundry' };
    for (i = 0; i < 6; i++) {
      sagPoint(ra, rb, 0.4, (i + 0.5) / 6.5, _vb);
      if (this._blocked(_vb.x, _vb.y - 0.45, _vb.z, 0.3)) continue;
      this._drop('laundry', _vb.x, _vb.z, rYaw + Math.PI * 0.5 + rng.range(-0.25, 0.25), {
        y: _vb.y - 0.03, tilt: 0.05,
        color: this._clothCol(rng.pick(LAUNDRY_TINTS), 0.72, 1.06),
        scale: rng.range(0.85, 1.35)
      });
    }

    // ---- ground dressing over the deck ------------------------------------
    for (i = 0; i < 68; i++) {
      var gc = pickCell();
      var dx2, dz2, dy2;
      if (gc) {
        dx2 = gc.x + rng.range(-0.5, 0.5); dz2 = gc.z + rng.range(-0.5, 0.5); dy2 = gc.y;
      } else {
        dx2 = roof.x + rng.gaussian(0, 3.4); dz2 = roof.z + rng.gaussian(0, 3.8);
        dy2 = this._roof(dx2, dz2);
        if (dy2 < 0 || Math.abs(dy2 - rY) > 1.2) continue;
      }
      this._drop('pebble', dx2, dz2, rng.range(0, 6.283), {
        y: dy2, tilt: 0.6, tint: 0xb6afa4, vLo: 0.6, vHi: 1.2, hue: 0.05,
        scale: rng.range(0.6, 1.6)
      });
      if (rng.bool(0.35)) {
        this._drop('paper', dx2 + rng.range(-0.5, 0.5), dz2 + rng.range(-0.5, 0.5),
          rng.range(0, 6.283),
          { y: dy2, tilt: 0.22, tint: 0xbfb6a4, vLo: 0.45, vHi: 0.95, hue: 0.12 });
      }
      if (rng.bool(0.18)) {
        this._drop('weed', dx2 + rng.range(-0.4, 0.4), dz2 + rng.range(-0.4, 0.4),
          rng.range(0, 6.283), {
            y: dy2, tilt: 0.12, tint: 0x8a8f58, vLo: 0.5, vHi: 1.0, hue: 0.1,
            scale: rng.range(0.5, 1.0)
          });
      }
    }
    // Weathering: felt patches, a tar seam and drifted grit, so the deck is not
    // one unbroken value.  26% of this framing measured as flat, and it stayed
    // flat because every one of these decals resolved its height with the
    // street-level ground probe and ended up buried under the building - hence
    // the explicit deck height now.  Weighted warm, because the deck is the
    // darkest region of the frame and this is the cheapest lift available.
    for (i = 0; i < 12; i++) {
      var sc2 = pickCell();
      if (!sc2) break;
      var warm = rng.bool(0.6);
      this._decal(sc2.x + rng.range(-0.5, 0.5), sc2.z + rng.range(-0.5, 0.5),
        rng.range(1.4, 3.4), warm ? 2 : rng.int(1, 3),
        warm ? rng.pick([0xc9b08a, 0xd2bd98, 0xbfa483]) : rng.pick([0x4a4642, 0x6a6258]),
        warm ? rng.range(0.28, 0.46) : rng.range(0.18, 0.36),
        undefined, undefined, sc2.y);
    }
    if (anchored) {
      var apX = roof.x + rfx * 5.5, apZ = roof.z + rfz * 5.5;
      var apY = this._roof(apX, apZ);
      this._decal(apX, apZ, 3.4, 2, 0xc2b094, 0.34, undefined, undefined,
        apY > 0 ? apY : rY);
    }

    // The overhead pass runs after this one and turns every registered line
    // into a real sagging cord.
    if (this._lines && this._roofLine) this._lines.push(this._roofLine);
  };

  // --------------------------------------------------------------------------
  // Composition pass: make sure each published capture pose has a strong
  // foreground element and something reading at mid-depth.  Without this the
  // scatter can leave a hero shot looking into empty tarmac.
  // --------------------------------------------------------------------------
  Props.prototype._dressCameraPoses = function () {
    var poses = (this.ctx.level && this.ctx.level.cameraPoses) || null;
    if (!poses) return;
    var rng = this.rng;
    // The alley and the interior are hand-composed by _dressPockets, down to
    // the metre; dropping a generic anchor into either one is what made the
    // alley too cluttered to read.  The rooftop needs its anchor much further
    // out, because at pitch -0.048 rad its near deck is below the frustum.
    var ANCHOR = {
      overview: [3.2, 5.0], street: [3.0, 4.8], rooftop: [5.2, 7.6]
    };
    var keys = ['overview', 'street', 'rooftop'];

    for (var i = 0; i < keys.length; i++) {
      var p = poses[keys[i]];
      if (!p || !p.position) continue;
      var yaw = p.yaw || 0;
      // camera forward in three.js YXZ convention
      var fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      var rx = Math.cos(yaw), rz = -Math.sin(yaw);
      var band = ANCHOR[keys[i]];

      // ONE foreground anchor, on ONE side.  This used to loop s = -1..1 and
      // plant a mass on both flanks of every pose, which is not a foreground
      // element - it is a gate.  A strong foreground element is asymmetric by
      // definition; that is the whole reason it reads as depth.
      var s = rng.bool() ? -1 : 1;
      var tries;
      for (tries = 0; tries < 3; tries++) {
        var dist = rng.range(band[0], band[1]);
        var lat = s * rng.range(2.2, 3.4);
        var ax = p.position.x + fx * dist + rx * lat;
        var az = p.position.z + fz * dist + rz * lat;
        if (this._blocked(ax, 0.7, az, 0.55)) continue;
        // Infinity = accept the first hit: this pose may be on any storey, and
        // the wrong-storey test two lines down is the real validation.
        var gy = this._ground(ax, az, p.position.y + 1.0, 8, Infinity);
        if (Math.abs(gy - (p.position.y - 1.65)) > 2.5) continue;   // wrong storey
        if (this._inSightline(ax, gy + 0.5, az)) continue;

        var pick = rng.next();
        if (pick < 0.4) {
          // a drum pair - vertical, dark, great silhouette against a bright street
          for (var d = 0; d < 2; d++) {
            var ddx = ax + rng.range(-0.35, 0.35), ddz = az + rng.range(-0.35, 0.35);
            this._drop('drum', ddx, ddz, rng.range(0, 6.283), {
              y: gy, tilt: 0.03,
              color: this._jit(rng.pick([0x8a4a2a, 0x5a6a5c, 0x6a6f74]), 0.68, 1.14, 0.07)
            });
            this._collider(ddx, gy + 0.44, ddz, 0.3, 0.44, 0.3, 0, 'metal');
          }
        } else if (pick < 0.72) {
          // a crate stack
          var h = rng.int(2, 3);
          for (var k = 0; k < h; k++) {
            this._crate(ax + rng.range(-0.06, 0.06), az + rng.range(-0.06, 0.06), {
              y: gy + k * 0.345, tilt: 0.04,
              tint: 0xc6b294, vLo: 0.66, vHi: 1.16, hue: 0.075,
              topple: k === h - 1 ? 0.2 : 0.03
            });
          }
          this._collider(ax, gy + h * 0.17, az, 0.3, h * 0.17, 0.22, 0, 'wood');
        } else {
          // rubble bank with a scrub growing out of it
          this._rubblePile(ax, az, rng.range(0.7, 1.2), rng.range(0.8, 1.5), -rx * s * 0.3, -rz * s * 0.3);
          this._drop('scrub', ax + rng.range(-0.3, 0.3), az + rng.range(-0.3, 0.3),
            rng.range(0, 6.283), {
              y: gy + rng.range(0.05, 0.3), tilt: 0.15,
              tint: 0x8a9060, vLo: 0.6, vHi: 1.2, hue: 0.1, scale: rng.range(0.6, 1.0)
            });
        }
        break;
      }

      // Mid-depth read along the leading line of the shot.  Deliberately
      // sparse: this used to spray paper evenly down the middle of the lane,
      // which put the highest-contrast element of the frame where nothing
      // would ever blow it.  _litterBias drags whatever survives to the kerb.
      for (var t = 6; t < 20; t += 2.5) {
        if (!rng.bool(0.4)) continue;
        var mx = p.position.x + fx * t + rx * rng.range(-2.6, 2.6);
        var mz = p.position.z + fz * t + rz * rng.range(-2.6, 2.6);
        if (this._blocked(mx, 0.4, mz, 0.3)) continue;
        this._litter(mx, mz, 1.0, rng.int(1, 3));
      }
    }
  };

  // --------------------------------------------------------------------------
  // Ground dressing: decals, sand drifts, dust motes.
  // --------------------------------------------------------------------------
  var DECAL_CELL = [[0, 0.5], [0.5, 0.5], [0, 0], [0.5, 0]];   // uv origin per cell

  // `deckY` overrides the ground probe.  Without it every decal resolves its
  // height with _ground(), which casts down from y = 2.4 - so every stain laid
  // on a rooftop deck at y = 9.4 missed the deck entirely and was buried in the
  // street underneath the building.  The rooftop framing has been carrying
  // eight invisible weathering decals for exactly that reason.
  Props.prototype._decal = function (x, z, size, cell, tint, alpha, rot, aspect, deckY) {
    var rng = this.rng;
    rot = rot === undefined ? rng.range(0, 6.283) : rot;
    aspect = aspect === undefined ? rng.range(0.75, 1.35) : aspect;
    var hw = size * 0.5, hh = size * 0.5 * aspect;
    var ca = Math.cos(rot), sa = Math.sin(rot);
    var baseY = (deckY !== undefined && isFinite(deckY)) ? deckY : this._ground(x, z);
    _col2.setHex(tint === undefined ? 0xffffff : tint, THREE.SRGBColorSpace);
    this.decals.push({
      x: x, y: baseY + 0.012 + this.decals.length * 0.00012, z: z,
      ux: ca * hw, uy: 0, uz: sa * hw,
      vx: -sa * hh, vy: 0, vz: ca * hh,
      nx: 0, ny: 1, nz: 0,
      cell: cell | 0, r: _col2.r, g: _col2.g, b: _col2.b,
      a: alpha === undefined ? 0.6 : alpha
    });
  };

  Props.prototype._wetDecal = function (x, z, size, cell, tint, alpha, rot, aspect) {
    var before = this.decals.length;
    this._decal(x, z, size, cell, tint, alpha, rot, aspect);
    if (this.decals.length > before) this.wetDecals.push(this.decals.pop());
  };

  // A stain on a vertical facade: grime under a window, rust below a bracket.
  Props.prototype._wallDecal = function (x, y, z, side, w, h, cell, tint, alpha) {
    _col2.setHex(tint === undefined ? 0xffffff : tint, THREE.SRGBColorSpace);
    this.decals.push({
      x: x, y: y, z: z,
      ux: 0, uy: 0, uz: w * 0.5 * -side,
      vx: 0, vy: h * 0.5, vz: 0,
      nx: -side, ny: 0, nz: 0,
      cell: cell | 0, r: _col2.r, g: _col2.g, b: _col2.b,
      a: alpha === undefined ? 0.5 : alpha
    });
  };

  Props.prototype._decalMesh = function (list, material, name) {
    if (!list.length) return null;
    var n = list.length;
    var pos = new Float32Array(n * 6 * 3);
    var nrm = new Float32Array(n * 6 * 3);
    var uv = new Float32Array(n * 6 * 2);
    var col = new Float32Array(n * 6 * 4);
    // quad corner signs, two triangles
    var cs = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
    for (var i = 0; i < n; i++) {
      var dcl = list[i];
      var cell = DECAL_CELL[dcl.cell & 3];
      for (var c = 0; c < 6; c++) {
        var su = cs[c][0], sv = cs[c][1];
        var o = (i * 6 + c);
        pos[o * 3] = dcl.x + dcl.ux * su + dcl.vx * sv;
        pos[o * 3 + 1] = dcl.y + dcl.uy * su + dcl.vy * sv;
        pos[o * 3 + 2] = dcl.z + dcl.uz * su + dcl.vz * sv;
        nrm[o * 3] = dcl.nx; nrm[o * 3 + 1] = dcl.ny; nrm[o * 3 + 2] = dcl.nz;
        // 0.006 inset keeps bilinear filtering from bleeding across the atlas
        uv[o * 2] = cell[0] + 0.006 + (su * 0.5 + 0.5) * 0.488;
        uv[o * 2 + 1] = cell[1] + 0.006 + (sv * 0.5 + 0.5) * 0.488;
        col[o * 4] = dcl.r; col[o * 4 + 1] = dcl.g; col[o * 4 + 2] = dcl.b; col[o * 4 + 3] = dcl.a;
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    // 4-component colour gives per-decal opacity without a second material
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    Geo.copyUV1(g);
    g.computeBoundingSphere();
    var mesh = new THREE.Mesh(g, material);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    this.root.add(mesh);
    return mesh;
  };

  // Sand drifted against the wall base.  A continuous, varying ribbon reads far
  // better than a row of discrete mounds, and it is one mesh.
  Props.prototype._buildSandDrifts = function () {
    var n = this.noise;
    var pos = [], nrm = [], uvs = [];
    var step = 0.55;

    function tri(a, b, c) {
      pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      nrm.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
      uvs.push(a[0] * 0.5, a[2] * 0.5, b[0] * 0.5, b[2] * 0.5, c[0] * 0.5, c[2] * 0.5);
    }

    for (var s = 0; s < 2; s++) {
      var side = s === 0 ? -1 : 1;
      var prev = null;
      for (var z = this.z0; z <= this.z1; z += step) {
        var fac = this._facade(z, side);
        // width driven by two noise scales: long dunes with local variation
        var w = (n.fbm2(z * 0.07, side * 11.3, 3, 2.2, 0.5) * 0.55 +
                 n.fbm2(z * 0.31, side * 4.1, 2, 2.1, 0.5) * 0.28 + 0.30);
        w = Math.max(0, w) * (fac.solid ? 1 : 0.35);
        if (w < 0.07) { prev = null; continue; }
        w = Math.min(w, 0.95);
        var gy = this._ground(this._in(fac.x, side, w * 0.5), z);
        var cur = {
          wall: [fac.x, gy + w * 0.20, z],
          toe: [this._in(fac.x, side, w), gy + 0.004, z]
        };
        if (prev) {
          tri(prev.wall, prev.toe, cur.toe);
          tri(prev.wall, cur.toe, cur.wall);
        }
        prev = cur;
      }
    }
    if (!pos.length) return null;
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    g.computeVertexNormals();
    Geo.copyUV1(g);
    g.computeBoundingSphere();
    var mesh = new THREE.Mesh(g, this.mats.sand);
    mesh.name = 'props_sandDrift';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    this.root.add(mesh);
    return mesh;
  };

  // Airborne dust.  Vertex-animated points: no CPU cost per frame, one draw
  // call, and it is what sells the shafts of light the art direction asks for.
  var DUST_VERT = [
    'uniform float uTime;',
    'uniform float uSize;',
    'attribute vec3 aSeed;',
    'attribute float aH;',
    'varying float vFade;',
    'void main() {',
    '  vec3 p = position;',
    '  float t = uTime;',
    '  p.x += sin( t * aSeed.y * 0.75 + aSeed.x ) * 0.55 + sin( t * 0.21 + aSeed.x * 2.3 ) * 0.95;',
    '  p.z += cos( t * aSeed.y * 0.62 + aSeed.x * 1.7 ) * 0.48 + cos( t * 0.17 + aSeed.x ) * 0.7;',
    '  p.y += mod( t * aSeed.y * 0.17 + aSeed.x * 3.0, aH );',
    '  vec4 mv = modelViewMatrix * vec4( p, 1.0 );',
    '  float dist = max( 0.08, -mv.z );',
    // Clamped: an unclamped 1/z point size turns a near mote into a
    // screen-filling white disc, which is exactly what it looks like.
    '  gl_PointSize = clamp( uSize * aSeed.z / dist, 0.9, 5.2 );',
    '  gl_Position = projectionMatrix * mv;',
    // fade in close (so motes do not pop in the near plane) and out with range
    '  vFade = smoothstep( 0.6, 3.5, dist ) * ( 1.0 - smoothstep( 22.0, 44.0, dist ) );',
    '}'
  ].join('\n');

  var DUST_FRAG = [
    'uniform vec3 uColor;',
    'varying float vFade;',
    'void main() {',
    '  vec2 d = gl_PointCoord - 0.5;',
    '  float r2 = dot( d, d );',
    '  if ( r2 > 0.25 ) discard;',
    '  float a = 1.0 - r2 * 4.0;',
    '  a *= a;',
    // Kept deliberately low: this is additive and the bloom pass amplifies it,
    // so anything brighter turns individual motes into hard white discs.
    '  gl_FragColor = vec4( uColor, a * vFade * 0.14 );',
    '}'
  ].join('\n');

  Props.prototype._buildDust = function () {
    var rng = this.rng;
    // The street volume itself, plus any pocket that registered a site.
    var sites = this.dustSites.slice();
    var lanes = Math.max(4, Math.round((this.z1 - this.z0) / 9));
    for (var i = 0; i < lanes; i++) {
      var z = M.lerp(this.z0, this.z1, (i + 0.5) / lanes);
      sites.push({
        x: rng.range(-this.halfW * 0.9, this.halfW * 0.9), z: z,
        y: this._ground(0, z), r: this.halfW * 1.05, h: 5.5,
        n: Math.round(110 * (this.ctx.quality && this.ctx.quality.particles ? this.ctx.quality.particles : 1)),
        size: 1.0
      });
    }
    var total = 0;
    for (i = 0; i < sites.length; i++) total += sites[i].n;
    if (total < 8) return null;
    total = Math.min(total, 3000);

    var pos = new Float32Array(total * 3);
    var seed = new Float32Array(total * 3);
    var hh = new Float32Array(total);
    var k = 0;
    for (i = 0; i < sites.length && k < total; i++) {
      var st = sites[i];
      for (var j = 0; j < st.n && k < total; j++) {
        pos[k * 3] = st.x + rng.gaussian(0, st.r * 0.5);
        pos[k * 3 + 1] = st.y - 0.2;
        pos[k * 3 + 2] = st.z + rng.gaussian(0, st.r * 0.75);
        seed[k * 3] = rng.range(0, 60);
        seed[k * 3 + 1] = rng.range(0.35, 1.5);
        // a modest size spread: a handful of larger flecks, but dust is dust
        seed[k * 3 + 2] = st.size * (rng.bool(0.06) ? rng.range(1.5, 2.2) : rng.range(0.5, 1.15));
        hh[k] = st.h;
        k++;
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, k * 3), 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed.subarray(0, k * 3), 3));
    g.setAttribute('aH', new THREE.BufferAttribute(hh.subarray(0, k), 1));
    g.computeBoundingSphere();
    // conservative bounds: motes wander a couple of metres from their seed
    if (g.boundingSphere) g.boundingSphere.radius += 8;

    var dustColor = new THREE.Color(0xc9b08a);
    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.uTime,
        uSize: { value: 15 },
        uColor: { value: dustColor.clone().multiplyScalar(1.0) }
      },
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending
    });
    var pts = new THREE.Points(g, mat);
    pts.name = 'props_dust';
    pts.frustumCulled = true;
    pts.renderOrder = 3;
    this.root.add(pts);
    this._dust = pts;
    return pts;
  };

  Props.prototype._buildGroundDressing = function () {
    var rng = this.rng;
    var i, s, side, z, fac;

    // Tyre tracks and traffic wear down the crown of the road.
    for (i = 0; i < 26; i++) {
      z = M.lerp(this.z0, this.z1, rng.next());
      var lane = rng.bool() ? -1 : 1;
      this._decal(lane * rng.range(1.1, 2.6) + rng.gaussian(0, 0.3), z,
        rng.range(3.5, 7.5), 3, 0x3a3833, rng.range(0.12, 0.3),
        rng.range(-0.06, 0.06), rng.range(0.06, 0.14));
    }
    // Grime line where the pavement meets the plaster.
    for (s = 0; s < 2; s++) {
      side = s === 0 ? -1 : 1;
      for (z = this.z0; z < this.z1; z += rng.range(1.8, 3.4)) {
        fac = this._facade(z, side);
        this._decal(this._in(fac.x, side, rng.range(0.25, 0.7)), z,
          rng.range(2.0, 4.0), 3, 0x342f28, rng.range(0.2, 0.42),
          Math.PI * 0.5, rng.range(0.12, 0.3));
        // downwash streaks on the wall itself
        if (rng.bool(0.35) && fac.solid) {
          this._wallDecal(this._in(fac.x, side, 0.04), this._ground(0, z) + rng.range(1.2, 3.6), z,
            side, rng.range(0.6, 1.8), rng.range(1.2, 3.0), 3, 0x3a342c, rng.range(0.16, 0.36));
        }
      }
    }
    // Scattered dust splats where footfall kicks the surface up.
    for (i = 0; i < 30; i++) {
      z = M.lerp(this.z0, this.z1, rng.next());
      this._decal(rng.gaussian(0, this.halfW * 0.5), z, rng.range(1.6, 4.0), 2,
        0xc9b490, rng.range(0.14, 0.34));
    }
    // A few oil patches where vehicles have stood.
    for (i = 0; i < 7; i++) {
      z = M.lerp(this.z0 + 3, this.z1 - 3, rng.next());
      this._decal(rng.range(-this.halfW * 0.7, this.halfW * 0.7), z,
        rng.range(1.2, 2.6), 0, 0x24211d, rng.range(0.4, 0.8));
    }

    // ---- drifted sand across the near carriageway -------------------------
    // Now that the sightline is clear, the bottom third of the street framing
    // is bare asphalt: it measured 0.169 against an upper band of 0.463 in
    // daylight and 0.037 at night, an undifferentiated dark smear either way.
    // A warm sand wash is the in-fiction fix (this is a Mediterranean street
    // where sand drifts across the road), it costs nothing, it reads as ground
    // texture rather than occlusion, and it lifts the near foreground in every
    // time of day at once.
    var S = this._sightlines;
    if (S && S.length) {
      for (s = 0; s < S.length; s++) {
        var sl = S[s];
        for (i = 0; i < 9; i++) {
          var t = 2.2 + i * 1.6 + rng.range(-0.5, 0.5);
          var wx = sl.ox + sl.fx * t + sl.rx * rng.range(-3.4, 3.4);
          var wz = sl.oz + sl.fz * t + sl.rz * rng.range(-3.4, 3.4);
          this._decal(wx, wz, rng.range(3.0, 5.6), 2,
            rng.pick([0xcbb28c, 0xd4bf9a, 0xc2a982]), rng.range(0.26, 0.42),
            rng.range(-0.35, 0.35), rng.range(0.28, 0.6));
        }
      }
    }

    this._sandMesh = this._buildSandDrifts();
    this._decalMesh(this.decals, this.mats.decal, 'props_decals');
    this._decalMesh(this.wetDecals, this.mats.decalWet, 'props_decalsWet');
    this._buildDust();
  };

  // --------------------------------------------------------------------------
  // Commit: merge the one-off geometry per material, publish the batches.
  // --------------------------------------------------------------------------
  var STATIC_MATERIAL = { wood: 'woodDark', rust: 'rust', painted: 'painted', concrete: 'concrete' };
  var STATIC_UV = { wood: 1.3, rust: 1.1, painted: 1.0, concrete: 0.9 };

  // Post-pass audit: walk the placed instances of the kits that are supposed to
  // be sitting on a surface and count any that are hanging in mid air.  This is
  // a regression net for the `_ground` fix - a floating prop is invisible in
  // code review and instantly obvious in a screenshot.  It records a stat and
  // never throws; it deliberately does NOT call GAME.logError, because that
  // feeds the build's error report and a diagnostic is not an error.
  // Only kits that are NEVER deliberately stacked or shelved.  Props stand on
  // other props all over this street (crates on counters, drums on drums) and
  // those supports live in props' own collider list, not the level's, so
  // auditing them against level.raycast would report them all as floating.
  var GROUND_KITS = ['paper', 'pebble', 'casing', 'glass', 'brick', 'timber',
                     'sack', 'bin', 'weed'];

  Props.prototype._auditPlacement = function () {
    if (!this._rayOK || !this.ctx.level || !this.ctx.level.raycast) return;
    var floaters = 0, tested = 0;
    var budget = 700;
    var mm = new THREE.Matrix4();
    for (var g = 0; g < GROUND_KITS.length && budget > 0; g++) {
      var b = this.B[GROUND_KITS[g]];
      if (!b || !b.n) continue;
      var stride = Math.max(1, Math.ceil(b.n / Math.max(1, budget / GROUND_KITS.length)));
      for (var i = 0; i < b.n; i += stride) {
        if (budget-- <= 0) break;
        b.mesh.getMatrixAt(i, mm);
        var px = mm.elements[12], py = mm.elements[13], pz = mm.elements[14];
        if (!(isFinite(px) && isFinite(py) && isFinite(pz))) continue;
        tested++;
        // first surface anywhere below: if it is more than 0.5 m down, this
        // instance is not resting on anything.
        var sy = this._ground(px, pz, py + 0.35, 3.2, Infinity);
        if (py - sy > 0.5) floaters++;
      }
    }
    this.stats.floaters = floaters;
    this.stats.audited = tested;
  };

  Props.prototype._commit = function () {
    var draws = 0;
    var key;

    try { this._auditPlacement(); } catch (e) { GAME.logError('props.audit', e); }
    this.stats.skipped = this._skipped;
    this.stats.sightSkipped = this._sightSkipped;

    for (key in this.S) {
      var parts = this.S[key];
      if (!parts.length) continue;
      var geo = mergeParts(parts, STATIC_UV[key] || 1);
      disposeParts(parts);
      if (!geo) continue;
      var mesh = new THREE.Mesh(geo, this.mats[STATIC_MATERIAL[key]] || this.mats.concrete);
      mesh.name = 'props_static_' + key;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.root.add(mesh);
      draws++;
    }

    for (key in this.B) {
      var b = this.B[key];
      if (b.finish(this.root)) this.stats.instances += b.n;
      else delete this.B[key];
    }

    // Authoritative count: everything parented under root is one draw call
    // (cables, shelter glass, decals and dust parented themselves earlier).
    draws = 0;
    this.root.traverse(function (o) { if (o.isMesh || o.isPoints) draws++; });
    this.stats.drawCalls = draws;
    this.stats.colliders = this.colliders.length;

    // Publish for anyone who wants to merge us into their broadphase.
    this.root.userData.colliders = this.colliders;
    this.root.userData.stats = this.stats;
    this.root.updateMatrixWorld(true);
    // Opt-in build diagnostic (index.html?...&propsdbg=1).  Inert otherwise, and
    // it is the only way to see instance-budget overflow, which is silent:
    // Batch.place just returns false and the last pass built gets nothing.
    try {
      if (typeof location !== 'undefined' && /propsdbg=1/.test(location.search || '')) {
        var dbg = { st: this.stats, full: [] };
        for (key in this.B) {
          if (this.B[key].n >= this.B[key].max) dbg.full.push(key + ':' + this.B[key].n);
        }
        if (window.console && console.log) console.log('PROPSTAT ' + JSON.stringify(dbg));
      }
    } catch (e2) { /* diagnostics never break a build */ }

    // Opt-in isolation (index.html?...&propshide=drum,static or =1 for all).
    // Inert otherwise, and it earns its keep: "which module owns that object?"
    // is otherwise unanswerable from a screenshot, and props is the module most
    // likely to be blamed for somebody else's mesh.  Capture with and without,
    // diff the two PNGs, and the answer is a bounding box.
    try {
      var hm = typeof location !== 'undefined' && /propshide=([A-Za-z0-9_,]+)/.exec(location.search || '');
      if (hm) {
        var want = hm[1].split(',');
        if (want.indexOf('1') >= 0) this.root.visible = false;
        else {
          for (var wi = 0; wi < want.length; wi++) {
            this.root.traverse(function (o) {
              if (o.name && o.name.indexOf(want[wi]) >= 0) o.visible = false;
            });
          }
        }
      }
    } catch (e3) { /* diagnostics never break a build */ }

    if (this.ctx && this.ctx.bus && this.ctx.bus.emit) {
      this.ctx.bus.emit('props:ready', this);
    }
  };

  // --------------------------------------------------------------------------
  // Per-frame
  // --------------------------------------------------------------------------
  Props.prototype.update = function (dt, ctx) {
    if (!(dt > 0)) dt = 0;
    // Drive from ctx.time when the engine provides it so deterministic capture
    // runs reproduce exactly; fall back to integrating dt.
    if (ctx && typeof ctx.time === 'number' && isFinite(ctx.time)) {
      this.time = ctx.time;
    } else {
      this.time += dt;
    }
    this.uTime.value = this.time;
  };

  Props.prototype.resize = function () { /* nothing viewport-dependent */ };

  Props.prototype.dispose = function () {
    var self = this;
    try {
      this.root.traverse(function (o) {
        if (o.geometry && o.geometry.dispose) o.geometry.dispose();
        if (o.isInstancedMesh && o.dispose) o.dispose();
      });
      var k;
      for (k in this.mats) { if (this.mats[k] && this.mats[k].dispose) this.mats[k].dispose(); }
      for (k in this.tex) { if (this.tex[k] && this.tex[k].dispose) this.tex[k].dispose(); }
      if (this.root.parent) this.root.parent.remove(this.root);
    } catch (e) { GAME.logError('props.dispose', e); }
    self.colliders.length = 0;
  };

  GAME.Props = Props;

})(window.GAME, window.THREE);
