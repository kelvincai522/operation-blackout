// ============================================================================
// OPERATION BLACKOUT - src/weapons/weapons.js  ->  GAME.WeaponSystem
//
// Procedural weapon models, first-person viewmodel animation and recoil.
//
// Design notes that matter:
//  * The gun is on screen 100% of the time, so it gets the polygon budget
//    (~45k tris for the carbine + gloved hands). Everything is built from
//    bevelled primitives, lathes and extruded shapes-with-holes so the
//    SILHOUETTE carries real detail (rail slots, M-LOK cut-outs, flash-hider
//    prongs, trigger guard hole) instead of relying on textures.
//  * Edge wear is baked into a per-vertex `aDetail` attribute (x = wear,
//    y = ambient occlusion) and injected into MeshStandardMaterial through
//    onBeforeCompile. Wear lerps albedo toward bare aluminium and drops
//    roughness / raises metalness, so worn edges pick up the sky exactly the
//    way ART_DIRECTION.md asks for. There is no UV unwrap to author, and it
//    still merges down to a handful of draw calls.
//  * All animation is procedural and spring-damped. No keyframe tables.
//  * The viewmodel lives in ctx.viewScene with ctx.viewCamera at the origin,
//    so viewScene coordinates ARE camera space. That makes the ADS solve
//    exact: put the optic's lens centre at (0, 0, -eyeDistance) and the
//    reticle is mathematically dead centre.
// ============================================================================
(function (GAME, THREE) {
  'use strict';
  if (!GAME || !THREE) return;

  var M = GAME.Math;
  var PI = Math.PI, HALF_PI = PI * 0.5;

  // ---- scratch (never allocate in update) ----------------------------------
  var _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
  var _q1 = new THREE.Quaternion();
  var _e1 = new THREE.Euler();
  var _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
  var _mp = new THREE.Vector3(), _msc = new THREE.Vector3();
  var _me = new THREE.Euler(), _mq = new THREE.Quaternion();

  // ==========================================================================
  // 1. Small maths helpers
  // ==========================================================================

  // Critically-damped scalar spring with velocity memory. Everything that
  // "settles" in this file goes through one of these.
  function Spring() { this.v = 0; this.vel = { v: 0 }; }
  Spring.prototype.to = function (target, smooth, dt) {
    this.v = M.springDamp(this.v, target, this.vel, smooth, dt);
    return this.v;
  };
  Spring.prototype.kick = function (amount) { this.vel.v += amount; };
  Spring.prototype.reset = function (v) { this.v = v || 0; this.vel.v = 0; };

  function Spring3() {
    this.x = new Spring(); this.y = new Spring(); this.z = new Spring();
  }
  Spring3.prototype.to = function (tx, ty, tz, smooth, dt) {
    this.x.to(tx, smooth, dt); this.y.to(ty, smooth, dt); this.z.to(tz, smooth, dt);
  };
  Spring3.prototype.reset = function () { this.x.reset(); this.y.reset(); this.z.reset(); };

  // Snappy in / soft out - the classic ADS feel. t in 0..1.
  function easeAds(t) {
    // fast departure, gentle arrival: 1-(1-t)^3 biased with a touch of
    // overshoot-free smoothstep so the sight picture never "lands" abruptly.
    var a = 1 - Math.pow(1 - t, 3);
    return a * 0.72 + M.smootherstep(0, 1, t) * 0.28;
  }

  // ==========================================================================
  // 2. Procedural surface textures
  //
  // The material library in ARCHITECTURE.md only advertises environment
  // surfaces (concrete, sand, rusted_metal...). Nothing there is right for a
  // gun at 8cm from the lens, so the weapon carries its own micro-detail set.
  // ctx.materials is still queried first (see _libMaterial) in case a project
  // build supplies weapon-specific names.
  // ==========================================================================

  var TEX_SIZE = 256;

  function wrapi(i, n) { return i < 0 ? i + n : (i >= n ? i - n : i); }

  // Tileable height field -> tangent-space normal map (DataTexture, RGBA).
  // Frequencies must be integers so GAME.Noise's 256-period wraps cleanly.
  function normalFromHeight(h, size, strength) {
    var data = new Uint8Array(size * size * 4);
    for (var y = 0; y < size; y++) {
      var yn = wrapi(y - 1, size) * size, yp = wrapi(y + 1, size) * size, yc = y * size;
      for (var x = 0; x < size; x++) {
        var l = h[yc + wrapi(x - 1, size)], r = h[yc + wrapi(x + 1, size)];
        var d = h[yn + x], u = h[yp + x];
        var nx = (l - r) * strength, ny = (d - u) * strength;
        var inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
        var o = (yc + x) * 4;
        data[o] = (nx * inv * 0.5 + 0.5) * 255;
        data[o + 1] = (ny * inv * 0.5 + 0.5) * 255;
        data[o + 2] = (inv * 0.5 + 0.5) * 255;
        data[o + 3] = 255;
      }
    }
    return finishTex(new THREE.DataTexture(data, size, size, THREE.RGBAFormat), false);
  }

  // Grayscale data map (roughness / AO). MUST stay NoColorSpace.
  function grayTexture(fn, size) {
    var data = new Uint8Array(size * size * 4);
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var v = M.saturate(fn(x / size, y / size, x, y)) * 255;
        var o = (y * size + x) * 4;
        data[o] = data[o + 1] = data[o + 2] = v; data[o + 3] = 255;
      }
    }
    return finishTex(new THREE.DataTexture(data, size, size, THREE.RGBAFormat), false);
  }

  // Colour map. Gets SRGBColorSpace - the rule that decides whether the whole
  // frame reads washed out or not.
  function colorTexture(fn, size) {
    var data = new Uint8Array(size * size * 4);
    var c = { r: 0, g: 0, b: 0 };
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        fn(x / size, y / size, c);
        var o = (y * size + x) * 4;
        data[o] = M.saturate(c.r) * 255;
        data[o + 1] = M.saturate(c.g) * 255;
        data[o + 2] = M.saturate(c.b) * 255;
        data[o + 3] = 255;
      }
    }
    return finishTex(new THREE.DataTexture(data, size, size, THREE.RGBAFormat), true);
  }

  function finishTex(t, srgb) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  }

  // Clone a texture so a material can own its own repeat without disturbing
  // the others sharing the same image.
  function repeated(tex, rep, aniso) {
    var t = tex.clone();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rep, rep);
    t.anisotropy = aniso || 4;
    t.colorSpace = tex.colorSpace;
    t.needsUpdate = true;
    return t;
  }

  // ==========================================================================
  // 3. Geometry helpers
  // ==========================================================================

  function mat4(x, y, z, rx, ry, rz, sx, sy, sz) {
    _mp.set(x || 0, y || 0, z || 0);
    _me.set(rx || 0, ry || 0, rz || 0, 'XYZ');
    _mq.setFromEuler(_me);
    _msc.set(sx === undefined ? 1 : sx, sy === undefined ? 1 : sy, sz === undefined ? 1 : sz);
    return new THREE.Matrix4().compose(_mp, _mq, _msc);
  }

  function basisMat(ax, ay, az, origin) {
    var m = new THREE.Matrix4();
    m.makeBasis(ax, ay, az);
    m.setPosition(origin);
    return m;
  }

  // Bevelled box. Perfectly sharp edges never catch a highlight, which is the
  // single loudest "this is CG" tell on a hero asset.
  // `seg` is a detail tier, not a subdivision count: 1 = plain box (hidden
  // internals, 12 tris), anything else = hero quality. Hero boxes subdivide
  // 3x per axis so each face ends up as a flat plateau ringed by a genuine
  // chamfer band - the band is what picks up the sky and the muzzle flash.
  var BOX_SEG = 3;
  function bx(w, h, d, bevel, seg) {
    if (seg === 1 || bevel === 0) return new THREE.BoxGeometry(w, h, d);
    return GAME.Geo.bevelBox(w, h, d, bevel === undefined ? 0.0009 : bevel, BOX_SEG);
  }

  // Cylinder lying along +Z (three builds them along +Y).
  function cylZ(rTop, rBot, len, seg, open) {
    var g = new THREE.CylinderGeometry(rTop, rBot, len, seg || 20, 1, !!open);
    g.rotateX(HALF_PI);
    return g;
  }

  function capsuleZ(r, len, radial) {
    var g = new THREE.CapsuleGeometry(r, Math.max(0.0005, len), 2, radial || 8, 1);
    g.rotateX(HALF_PI);
    return g;
  }

  // Lathe swept about +Z. profile = [[radius, z], ...] traced so that the
  // outer wall runs +z (outward normals) and the inner wall runs -z.
  function latheZ(profile, seg) {
    var pts = [];
    for (var i = 0; i < profile.length; i++) pts.push(new THREE.Vector2(profile[i][0], profile[i][1]));
    var g = new THREE.LatheGeometry(pts, seg || 28);
    g.rotateX(HALF_PI);   // +Y sweep axis -> +Z, and profile +y -> -Z (muzzle)
    return g;
  }

  function roundedRectShape(w, h, r) {
    var s = new THREE.Shape();
    var hw = w * 0.5, hh = h * 0.5;
    r = Math.min(r, Math.min(hw, hh) * 0.98);
    s.moveTo(-hw + r, -hh);
    s.lineTo(hw - r, -hh);
    s.absarc(hw - r, -hh + r, r, -HALF_PI, 0, false);
    s.lineTo(hw, hh - r);
    s.absarc(hw - r, hh - r, r, 0, HALF_PI, false);
    s.lineTo(-hw + r, hh);
    s.absarc(-hw + r, hh - r, r, HALF_PI, PI, false);
    s.lineTo(-hw, -hh + r);
    s.absarc(-hw + r, -hh + r, r, PI, PI * 1.5, false);
    s.closePath();
    return s;
  }

  function roundedRectPath(cx, cy, w, h, r) {
    var p = new THREE.Path();
    var hw = w * 0.5, hh = h * 0.5;
    r = Math.min(r, Math.min(hw, hh) * 0.98);
    p.moveTo(cx - hw + r, cy - hh);
    p.lineTo(cx + hw - r, cy - hh);
    p.absarc(cx + hw - r, cy - hh + r, r, -HALF_PI, 0, false);
    p.lineTo(cx + hw, cy + hh - r);
    p.absarc(cx + hw - r, cy + hh - r, r, 0, HALF_PI, false);
    p.lineTo(cx - hw + r, cy + hh);
    p.absarc(cx - hw + r, cy + hh - r, r, HALF_PI, PI, false);
    p.lineTo(cx - hw, cy - hh + r);
    p.absarc(cx - hw + r, cy - hh + r, r, PI, PI * 1.5, false);
    p.closePath();
    return p;
  }

  // Obround (stadium) hole with its long axis along Y - an M-LOK slot.
  function slotPathV(cx, cy, len, wid) {
    var p = new THREE.Path();
    var r = wid * 0.5, hl = Math.max(0.0001, len * 0.5 - r);
    p.moveTo(cx - r, cy - hl);
    p.lineTo(cx - r, cy + hl);
    p.absarc(cx, cy + hl, r, PI, 0, true);
    p.lineTo(cx + r, cy - hl);
    p.absarc(cx, cy - hl, r, 0, PI, true);
    p.closePath();
    return p;
  }

  function extrude(shape, depth, bevel, curveSeg) {
    var g = new THREE.ExtrudeGeometry(shape, {
      depth: depth,
      curveSegments: curveSeg || 6,
      steps: 1,
      bevelEnabled: bevel > 0,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelOffset: 0,
      bevelSegments: 1
    });
    g.translate(0, 0, -depth * 0.5);  // centre on the extrusion axis
    return g;
  }

  // Annular sector prism - one prong of an A2 flash hider, or a rail clamp.
  function arcPrism(rInner, rOuter, a0, a1, depth, bevel) {
    var s = new THREE.Shape();
    s.absarc(0, 0, rOuter, a0, a1, false);
    s.absarc(0, 0, rInner, a1, a0, true);
    s.closePath();
    return extrude(s, depth, bevel === undefined ? 0.0004 : bevel, 8);
  }

  // Sweep a closed 2-D profile along a list of frames. This is what gives the
  // magazine its real banana curve and the pistol grip its palm swell -
  // stacked boxes cannot do either.
  //   profile: [[x, y], ...] counter-clockwise
  //   frames:  [{p:Vector3, q:Quaternion, sx:Number, sy:Number}]
  function loft(profile, frames, capStart, capEnd) {
    var n = profile.length, m = frames.length;
    var vcount = n * m + (capStart ? 1 : 0) + (capEnd ? 1 : 0);
    var pos = new Float32Array(vcount * 3);
    var idx = [];
    var i, j, o = 0, f;
    for (i = 0; i < m; i++) {
      f = frames[i];
      for (j = 0; j < n; j++) {
        _v1.set(profile[j][0] * f.sx, profile[j][1] * f.sy, 0).applyQuaternion(f.q).add(f.p);
        pos[o * 3] = _v1.x; pos[o * 3 + 1] = _v1.y; pos[o * 3 + 2] = _v1.z;
        o++;
      }
    }
    for (i = 0; i < m - 1; i++) {
      for (j = 0; j < n; j++) {
        var a = i * n + j, b = i * n + (j + 1) % n;
        var c = (i + 1) * n + j, d = (i + 1) * n + (j + 1) % n;
        idx.push(a, b, c, b, d, c);   // winding chosen so normals face outward
      }
    }
    if (capStart) {
      var cs = o; f = frames[0];
      _v1.set(0, 0, 0).applyQuaternion(f.q).add(f.p);
      pos[o * 3] = _v1.x; pos[o * 3 + 1] = _v1.y; pos[o * 3 + 2] = _v1.z; o++;
      for (j = 0; j < n; j++) idx.push(cs, (j + 1) % n, j);
    }
    if (capEnd) {
      var ce = o; f = frames[m - 1];
      _v1.set(0, 0, 0).applyQuaternion(f.q).add(f.p);
      pos[o * 3] = _v1.x; pos[o * 3 + 1] = _v1.y; pos[o * 3 + 2] = _v1.z; o++;
      var base = (m - 1) * n;
      for (j = 0; j < n; j++) idx.push(ce, base + j, base + (j + 1) % n);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  // Rounded-rectangle profile ring for loft(). Corner-tangent so the shading
  // stays continuous without duplicating vertices.
  function rrProfile(w, h, r, cornerSeg) {
    var pts = [];
    var hw = w * 0.5 - r, hh = h * 0.5 - r;
    var cs = cornerSeg || 4;
    var corners = [[hw, hh, 0], [-hw, hh, HALF_PI], [-hw, -hh, PI], [hw, -hh, PI * 1.5]];
    for (var c = 0; c < 4; c++) {
      var cx = corners[c][0], cy = corners[c][1], a0 = corners[c][2];
      for (var i = 0; i <= cs; i++) {
        var a = a0 + (i / cs) * HALF_PI;
        pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
      }
    }
    return pts;
  }

  // Frames marching down a circular arc - used by the magazine.
  function arcFrames(start, dir0, radius, totalLen, count) {
    var out = [];
    var aMax = totalLen / radius;
    var side = new THREE.Vector3(1, 0, 0);
    for (var i = 0; i < count; i++) {
      var a = (i / (count - 1)) * aMax;
      var p = new THREE.Vector3(
        start.x,
        start.y - radius * Math.sin(a) * dir0,
        start.z + radius * (Math.cos(a) - 1)
      );
      var z = new THREE.Vector3(0, -Math.cos(a) * dir0, -Math.sin(a));
      var y = new THREE.Vector3().crossVectors(z, side).normalize();
      var x = new THREE.Vector3().crossVectors(y, z).normalize();
      var q = new THREE.Quaternion().setFromRotationMatrix(_m1.makeBasis(x, y, z));
      out.push({ p: p, q: q, sx: 1, sy: 1, t: i / (count - 1) });
    }
    return out;
  }

  // ==========================================================================
  // 4. Part builder - merges parts per material and bakes wear / AO
  // ==========================================================================

  function Builder(noise) {
    this.buckets = Object.create(null);
    this.noise = noise || GAME.noise;
    this.tris = 0;
  }

  var DEFAULT_OPT = { wear: 0.5, ao: 0.08, mode: 'edges', tol: 0.0016 };

  Builder.prototype.add = function (key, geo, mtx, opt) {
    if (!geo) return;
    opt = opt || DEFAULT_OPT;
    var b = this.buckets[key] || (this.buckets[key] = { entries: [], detail: [] });
    // Always work on a private copy: the same source geometry gets reused for
    // dozens of rail teeth, and worldUV/uv-offset mutate in place.
    var g = geo.index ? geo.toNonIndexed() : geo.clone();
    var m = mtx || new THREE.Matrix4();
    // Parts get world-space UVs so texel density is identical across a 4mm pin
    // and a 300mm handguard. Anything whose texture is a SPRITE (the reticle
    // dot) must keep its own 0..1 UVs, or it samples a single clamped texel.
    if (!opt.keepUV) {
      GAME.Geo.worldUV(g, 1.0);
      // Offset UVs by the part's placement so neighbouring parts do not repeat
      // the exact same texel patch.
      var e = m.elements;
      var uOff = e[12] + e[14] * 0.37, vOff = e[13] - e[14] * 0.21;
      var uv = g.attributes.uv;
      for (var i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) + uOff, uv.getY(i) + vOff);
    }
    b.entries.push({ geometry: g, matrix: m });
    b.detail.push(this._detail(g, m, opt));
    this.tris += g.attributes.position.count / 3;
  };

  // Global wear ceiling with a soft knee. Authored per-part `wear` values stay
  // as a RELATIVE ranking of which parts rub hardest, but nothing is allowed to
  // run away: the old authoring topped out near 1.0, which repainted whole
  // faces in bare aluminium and put the rendered handguard BRIGHTER than sunlit
  // plaster - impossible for a matte black rifle. Wear is additionally masked
  // per-PIXEL in the shader (see applyWearShader) so what survives is speckle
  // on the corners, not a ramp across the flats.
  // The cap is deliberately generous now and the LIMITING is done per-pixel.
  // Capping the amplitude at 0.30 (the round-2 value) meant the strongest
  // possible rub mark was mix(anodising, aluminium, 0.30) - a 5% change in
  // value that measured below the noise floor, so the weapon had no bright
  // pixels anywhere and the whole body sat inside a 0.06 luminance span. What
  // stops wear running away is COVERAGE, not amplitude: applyWearShader gates
  // it through a thresholded worley mask so only ~15% of the texels on a
  // vertex-allowed edge ever fire, and those go all the way to bare metal.
  var WEAR_CAP = 0.42;
  function wearBudget(a) {
    return a <= WEAR_CAP ? a : WEAR_CAP + (a - WEAR_CAP) * 0.10;
  }

  // Per-vertex (wear, occlusion). Wear concentrates on convex edges because
  // that is exactly where a rifle rubs against gear, walls and hands.
  Builder.prototype._detail = function (g, mtx, opt) {
    var p = g.attributes.position, nrm = g.attributes.normal;
    g.computeBoundingBox();
    var bb = g.boundingBox, mn = bb.min, mx = bb.max;
    var tol = opt.tol === undefined ? DEFAULT_OPT.tol : opt.tol;
    var mode = opt.mode || 'edges';
    var wScale = wearBudget(opt.wear === undefined ? DEFAULT_OPT.wear : opt.wear);
    var aoBase = opt.ao === undefined ? DEFAULT_OPT.ao : opt.ao;
    var out = new Float32Array(p.count * 2);
    var noise = this.noise;
    // Optional contact occlusion against a cylinder (a grip the hand wraps).
    // aDetail.y is otherwise computed with no knowledge of neighbouring parts,
    // so fingers sit on an evenly-lit grip and read as a separate prop.
    var oc = opt.occl || null;
    var ocO = oc ? oc.origin : null, ocA = oc ? oc.axis : null;
    var ocR = oc ? oc.radius : 0, ocK = oc ? (oc.strength === undefined ? 0.45 : oc.strength) : 0;
    var ocFall = oc ? (oc.falloff === undefined ? 0.0075 : oc.falloff) : 1;
    var thickX = (mx.x - mn.x) > tol * 4.5;
    var thickY = (mx.y - mn.y) > tol * 4.5;
    var thickZ = (mx.z - mn.z) > tol * 4.5;
    for (var i = 0; i < p.count; i++) {
      var lx = p.getX(i), ly = p.getY(i), lz = p.getZ(i);
      _v1.set(lx, ly, lz).applyMatrix4(mtx);         // model space, for noise
      var edge = 0;
      if (mode === 'edges') {
        var c = 0;
        // An axis only VOTES if the part is actually thick along it. The rail
        // base bar is 3mm tall against a 1.1mm tolerance, so every one of its
        // vertices sat within tol of both Y extremes and the whole 21x480mm
        // strip scored as "edge" - which rendered as a light speckled band the
        // full length of the weapon's spine, reading as printed camouflage
        // rather than as rub marks. The same was true of every thin plate,
        // every rail tooth and every magazine rib. Being near the extreme of an
        // axis carries no information about being on an edge when the whole
        // part is thinner than a few tolerances in that axis.
        if (thickX && Math.min(lx - mn.x, mx.x - lx) <= tol) c++;
        if (thickY && Math.min(ly - mn.y, mx.y - ly) <= tol) c++;
        if (thickZ && Math.min(lz - mn.z, mx.z - lz) <= tol) c++;
        // A vertex at three extremes is a box CORNER; two extremes is the
        // chamfer band that runs along an EDGE, and that band is where a rifle
        // actually rubs - a corner is a mathematically single point and at
        // viewmodel scale it covers well under a pixel. The round-2 value of
        // 0.30 for the two-extreme case, put through an amplitude multiply,
        // meant no edge on the weapon ever exceeded mix(anodising, metal, 0.09)
        // and every part measured below the noise floor. The face interior
        // (one extreme) stays deliberately below applyWearShader's lower
        // smoothstep knee so the wear cannot bleed across a flat.
        edge = c >= 3 ? 1 : (c === 2 ? 0.72 : (c === 1 ? 0.09 : 0));
      } else if (mode === 'flat') {
        edge = 0.38;
      } else if (mode === 'rim') {
        // cylindrical part: wear only on the end rims
        edge = Math.min(lz - mn.z, mx.z - lz) <= tol ? 0.90 : 0.05;
      }
      // Wear must be PATCHY. A smooth ramp along every edge turns the whole
      // gun silver, because the bevel ring is a large share of the vertices on
      // a subdivided box; thresholding the noise hard keeps it to real rub
      // marks that only show on part of any given edge.
      var blotch = noise.fbm3(_v1.x * 46, _v1.y * 46, _v1.z * 46, 3) * 0.5 + 0.5;
      var w = edge * M.saturate(blotch * 2.20 - 0.78) * wScale;
      var ny = nrm ? _v2.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i)).applyMatrix4(_m2.extractRotation(mtx)).y : 0;
      // downward-facing surfaces and low parts sit in their own shadow
      var cav = noise.fbm3(_v1.x * 15 + 11, _v1.y * 15, _v1.z * 15, 2) * 0.5 + 0.5;
      // The "low parts sit in their own shadow" term used to start at y = -0.01
      // and reach full strength by -0.16, which is ABOVE the pistol grip, the
      // magazine, the foregrip and both hands - i.e. it applied a flat 0.20
      // darkening to more than half the weapon and is a large part of why the
      // polymer measured a 0.04 luminance span. It now starts lower and is
      // weaker, so it shades the true underside instead of the whole lower half.
      var ao = aoBase + 0.46 * M.smoothstep(0.42, -0.90, ny)
        + 0.16 * M.smoothstep(-0.045, -0.24, _v1.y)
        + 0.10 * M.saturate(1.4 - cav * 2.0);
      if (oc) {
        _v3.copy(_v1).sub(ocO);
        _v3.addScaledVector(ocA, -_v3.dot(ocA));      // radial component
        ao += ocK * (1 - M.smoothstep(0, ocFall, Math.abs(_v3.length() - ocR)));
      }
      out[i * 2] = M.saturate(w);
      out[i * 2 + 1] = M.saturate(ao);
    }
    return out;
  };

  var NO_SHADOW = { inner: 1, tubeInner: 1, lens: 1, reticle: 1, reticleCore: 1, coating: 1, brass: 1, skin: 1 };

  Builder.prototype.finish = function (matlib, parent, castShadow) {
    var made = [];
    for (var key in this.buckets) {
      var b = this.buckets[key];
      if (!b.entries.length) continue;
      var geo = GAME.Geo.mergeAll(b.entries);
      var total = geo.attributes.position.count;
      var det = new Float32Array(total * 2), off = 0, i;
      for (i = 0; i < b.detail.length; i++) {
        det.set(b.detail[i], off);
        off += b.detail[i].length;
      }
      geo.setAttribute('aDetail', new THREE.BufferAttribute(det, 2));
      GAME.Geo.copyUV1(geo);      // three reads aoMap from the 2nd uv set
      for (i = 0; i < b.entries.length; i++) b.entries[i].geometry.dispose();
      var mesh = new THREE.Mesh(geo, matlib[key] || matlib.metal);
      mesh.name = key;
      mesh.frustumCulled = false;  // viewmodel is animated hard every frame
      // Cavities, glass and the reticle are never the caster of a shadow that
      // reads - skipping them keeps the viewmodel shadow pass cheap.
      mesh.castShadow = castShadow !== false && !NO_SHADOW[key];
      mesh.receiveShadow = true;
      if (key === 'tubeInner') { mesh.renderOrder = -1; mesh.receiveShadow = false; }
      if (key === 'lens') { mesh.renderOrder = 6; }
      if (key === 'coating') { mesh.renderOrder = 7; mesh.receiveShadow = false; }
      if (key === 'reticle') { mesh.renderOrder = 8; mesh.receiveShadow = false; }
      // The hue-locked core draws LAST so it replaces whatever the additive
      // glow (and the sky behind it) put down - that is what keeps the dot red
      // instead of salmon over a blown highlight.
      if (key === 'reticleCore') { mesh.renderOrder = 9; mesh.receiveShadow = false; }
      if (parent) parent.add(mesh);
      made.push(mesh);
    }
    this.buckets = Object.create(null);
    return made;
  };

  // A model is a tree of named groups, each with its own Builder, so parts
  // that animate (bolt, magazine, charging handle, hands) stay separable
  // while everything static merges down to a couple of draw calls.
  function ModelBuilder(noise) {
    this.root = new THREE.Object3D();
    this.root.name = 'weapon';
    this.groups = Object.create(null);
    this.noise = noise;
    this.order = [];
  }
  ModelBuilder.prototype.group = function (name, parent, offset) {
    var g = this.groups[name];
    if (!g) {
      g = this.groups[name] = { obj: new THREE.Object3D(), b: new Builder(this.noise) };
      g.obj.name = name;
      if (offset) g.obj.position.copy(offset);
      (parent && this.groups[parent] ? this.groups[parent].obj : this.root).add(g.obj);
      this.order.push(name);
    }
    return g;
  };
  ModelBuilder.prototype.add = function (group, key, geo, mtx, opt) {
    this.group(group).b.add(key, geo, mtx, opt);
  };
  ModelBuilder.prototype.finish = function (matlib) {
    var tris = 0;
    for (var i = 0; i < this.order.length; i++) {
      var g = this.groups[this.order[i]];
      tris += g.b.tris;
      g.b.finish(matlib, g.obj, true);
    }
    return tris;
  };

  // ==========================================================================
  // 5. Gloved hands
  //
  // Fingers are wrapped onto an actual cylinder (the grip) rather than posed
  // by eye: each phalanx advances around the grip by length/(radius+thickness)
  // radians, so the hand physically hugs whatever it is holding.
  // ==========================================================================

  // Radii are ~12% under the old set: at viewmodel scale the previous values
  // read as sausages rather than gloved fingers.
  var FINGER = {
    index:  { len: [0.0405, 0.0262, 0.0198], rad: [0.0082, 0.0074, 0.0064] },
    middle: { len: [0.0448, 0.0288, 0.0208], rad: [0.0084, 0.0076, 0.0065] },
    ring:   { len: [0.0412, 0.0272, 0.0198], rad: [0.0078, 0.0071, 0.0062] },
    pinky:  { len: [0.0332, 0.0212, 0.0172], rad: [0.0070, 0.0063, 0.0055] }
  };
  var FINGER_ORDER = ['index', 'middle', 'ring', 'pinky'];

  // Unit finger cross-section: slightly taller than wide (a finger is not
  // round), with soft corners. Scaled per-frame by sx/sy in loft().
  var FINGER_PROFILE = rrProfile(2.0, 2.25, 0.72, 4);

  // ONE continuous swept volume for the whole finger. The old version emitted a
  // sphere plus a capsule per phalanx with nothing bridging them, which at
  // viewmodel scale reads as a string of separated grey balls with daylight
  // between them. Knuckle bulges now come from the sx/sy scale curve, so the
  // glove stays a single closed surface.
  //   m0 places the metacarpal head; local +Z runs distal, a positive curl
  //   about local X folds the finger toward the palm (-Y).
  function fingerChain(b, key, m0, lens, rads, curls, opt) {
    var m = m0.clone();
    var rot = new THREE.Matrix4(), tr = new THREE.Matrix4();
    var frames = [];
    var i, j;
    // Knuckle / mid / distal / joint-overlap frames, plus a rounded tip.
    // The old three-frame set waisted at t=0.86 and then restarted the next
    // phalanx at full width AFTER the joint rotation, which opens a visible
    // notch on the outside of every knuckle - the "articulated gauntlet" read.
    // The extra frame at 0.94 swells back out so consecutive phalanges
    // interpenetrate through the bend and the glove stays one closed surface.
    var ts = [0.0, 0.30, 0.66, 0.94];
    var bulge = [1.16, 0.99, 0.96, 1.10];
    var q = new THREE.Quaternion(), sc = new THREE.Vector3(), pp = new THREE.Vector3();
    for (i = 0; i < lens.length; i++) {
      m.multiply(rot.makeRotationX(curls[i]));
      var L = lens[i], r = rads[i];
      var rNext = (i + 1 < rads.length) ? rads[i + 1] : r * 0.86;
      for (j = 0; j < ts.length; j++) {
        var mm = m.clone().multiply(tr.makeTranslation(0, 0, L * ts[j]));
        mm.decompose(pp, q, sc);
        var rr = M.lerp(r, rNext, ts[j]) * bulge[j];
        frames.push({ p: pp.clone(), q: q.clone(), sx: rr, sy: rr * (j === 0 ? 1.08 : 1.0) });
      }
      m.multiply(tr.makeTranslation(0, 0, L));
    }
    // fingertip: two quick frames so the pad rolls over instead of ending flat
    var rTip = rads[rads.length - 1];
    var tipT = [0.34, 0.78], tipS = [0.86, 0.46];
    for (j = 0; j < 2; j++) {
      var mt = m.clone().multiply(tr.makeTranslation(0, 0, rTip * tipT[j] * 1.9));
      mt.decompose(pp, q, sc);
      frames.push({ p: pp.clone(), q: q.clone(), sx: rTip * tipS[j], sy: rTip * tipS[j] });
    }
    b.add(key, loft(FINGER_PROFILE, frames, true, true), null, opt);
    return m;
  }

  // Build one hand gripping a cylinder.
  //   o.origin  centre of the grip cylinder at the index-finger end
  //   o.axis    unit vector down the grip (index -> pinky direction)
  //   o.front   unit vector, perpendicular to axis, pointing where the
  //             finger knuckles sit (the front strap side)
  //   o.radius  grip radius
  //   o.sense   +1 / -1 wrap direction about the axis
  function gripHand(b, keyGlove, keySkin, o) {
    var axis = o.axis.clone().normalize();
    var front = o.front.clone().projectOnPlane(axis).normalize();
    var side = new THREE.Vector3().crossVectors(axis, front).normalize();
    var R = o.radius;
    var spacing = o.spacing === undefined ? 0.0205 : o.spacing;
    var sense = o.sense || 1;
    // Contact occlusion. aDetail.y knows nothing about neighbouring parts, so
    // without this the fingers sit on an evenly-lit grip and the hand reads as
    // a separate prop resting near the gun. Every glove vertex within ~7mm of
    // the grip cylinder's surface darkens.
    // 0.44 stacked on top of the base/normal/height AO terms, which already
    // reach ~0.8 on the underside of a curled finger, so aDetail.y saturated
    // over most of the hand and lib.glove's AO multiplier then removed a fixed
    // 70% of it - a glove with a median of 0.034 and no readable knuckles.
    var occl = { origin: o.origin.clone(), axis: axis.clone(), radius: R, strength: 0.24, falloff: 0.0068 };
    var opt = { wear: 0.16, ao: 0.10, mode: 'flat', occl: occl };
    var i, k, fi;

    // ---- fingers ----------------------------------------------------------
    var lastKnuckle = null, firstKnuckle = null;
    for (i = 0; i < FINGER_ORDER.length; i++) {
      fi = FINGER[FINGER_ORDER[i]];
      if (o.skipIndex && i === 0) continue;
      var t0 = (o.startAngle || 0) + (o.stagger ? o.stagger * i : 0);
      var r0 = R + fi.rad[0];
      // knuckle frame on the cylinder
      _q1.setFromAxisAngle(axis, t0 * sense);
      var radial = front.clone().applyQuaternion(_q1);
      var tangent = new THREE.Vector3().crossVectors(axis, radial).multiplyScalar(sense).normalize();
      var pos = axis.clone().multiplyScalar(spacing * i + (o.axisOffset || 0))
        .add(o.origin).add(radial.clone().multiplyScalar(r0));
      var xAx = new THREE.Vector3().crossVectors(radial, tangent).normalize();
      var m0 = basisMat(xAx, radial, tangent, pos);
      // curl each segment by the arc it must travel around the grip
      var curls = [
        fi.len[0] / (R + fi.rad[0]) * (o.tight || 1),
        fi.len[1] / (R + fi.rad[1]) * (o.tight || 1),
        fi.len[2] / (R + fi.rad[2]) * (o.tight || 1) * 1.08
      ];
      fingerChain(b, keyGlove, m0, fi.len, fi.rad, curls, opt);
      if (i === 0) firstKnuckle = { p: pos.clone(), r: radial.clone(), t: tangent.clone() };
      lastKnuckle = { p: pos.clone(), r: radial.clone(), t: tangent.clone() };
    }
    if (!firstKnuckle) {
      firstKnuckle = { p: o.origin.clone().add(front.clone().multiplyScalar(R + 0.01)),
        r: front.clone(), t: new THREE.Vector3().crossVectors(axis, front) };
    }

    // ---- extended trigger finger -----------------------------------------
    if (o.skipIndex && o.triggerTarget) {
      fi = FINGER.index;
      var kp = o.origin.clone().add(axis.clone().multiplyScalar(o.axisOffset || 0))
        .add(front.clone().applyAxisAngle(axis, (o.startAngle || 0) * sense).multiplyScalar(R + fi.rad[0]));
      var dir = o.triggerTarget.clone().sub(kp).normalize();
      var up = new THREE.Vector3().crossVectors(dir, axis).normalize();
      var xa = new THREE.Vector3().crossVectors(up, dir).normalize();
      fingerChain(b, keyGlove, basisMat(xa, up, dir, kp), fi.len, fi.rad,
        [0.10, 0.72, 0.55], opt);
    }

    // ---- palm -------------------------------------------------------------
    var palmAng = (o.startAngle || 0) + (o.palmArc === undefined ? 2.35 : o.palmArc);
    _q1.setFromAxisAngle(axis, palmAng * sense);
    var pRadial = front.clone().applyQuaternion(_q1);
    var palmCentre = o.origin.clone()
      .add(axis.clone().multiplyScalar(spacing * 1.45 + (o.axisOffset || 0)))
      .add(pRadial.clone().multiplyScalar(R + 0.019));
    var pTan = new THREE.Vector3().crossVectors(axis, pRadial).multiplyScalar(sense).normalize();
    var palmM = basisMat(pTan, pRadial, axis.clone().negate(), palmCentre);
    b.add(keyGlove, bx(0.030, 0.026, 0.090, 0.006, 2), palmM, { wear: 0.10, ao: 0.20, mode: 'flat', occl: occl });
    // heel of the hand
    b.add(keyGlove, bx(0.032, 0.030, 0.034, 0.008, 2),
      palmM.clone().multiply(mat4(0, -0.002, -0.038)), { wear: 0.08, ao: 0.24, mode: 'flat', occl: occl });
    // Knuckle guard: one moulded slab across the back of the hand, with the
    // individual pads proud of it. Without the slab the pads float over a gap
    // between the palm box and the finger roots.
    b.add(keyGlove, bx(0.030, 0.0105, 0.0870, 0.0045, 2),
      palmM.clone().multiply(mat4(0.0005, 0.0142, 0.0060, 0, 0, 0)),
      { wear: 0.12, ao: 0.10, mode: 'flat' });
    // knuckle pads across the back of the hand
    for (k = 0; k < 4; k++) {
      b.add(keyGlove, bx(0.016, 0.006, 0.017, 0.002, 2),
        palmM.clone().multiply(mat4(0.001, 0.0205, 0.030 - k * 0.0205, 0, 0, 0)),
        { wear: 0.30, ao: 0.02, mode: 'edges', tol: 0.0025 });
    }

    // ---- thumb ------------------------------------------------------------
    if (!o.noThumb) {
      var thumbAng = (o.startAngle || 0) - (o.thumbArc === undefined ? 1.15 : o.thumbArc);
      _q1.setFromAxisAngle(axis, thumbAng * sense);
      var tRadial = front.clone().applyQuaternion(_q1);
      var tBase = o.origin.clone()
        .add(axis.clone().multiplyScalar(spacing * 0.15 + (o.axisOffset || 0) - 0.006))
        .add(tRadial.clone().multiplyScalar(R + 0.010));
      // thumbUp trades "thumb runs up alongside the weapon" against "thumb
      // wraps the grip". Low values keep it clear of a fat handguard.
      var tDir = axis.clone().multiplyScalar(-(o.thumbUp === undefined ? 0.55 : o.thumbUp))
        .add(new THREE.Vector3().crossVectors(axis, tRadial).multiplyScalar(sense * 0.83)).normalize();
      var tUp = tRadial.clone();
      var tX = new THREE.Vector3().crossVectors(tUp, tDir).normalize();
      tUp.crossVectors(tDir, tX).normalize();
      fingerChain(b, keyGlove, basisMat(tX, tUp, tDir, tBase),
        [0.030, 0.026, 0.021], [0.0115, 0.0102, 0.0090],
        [o.thumbCurl === undefined ? 0.34 : o.thumbCurl, 0.46, 0.40], opt);
      // thenar pad
      b.add(keyGlove, bx(0.020, 0.016, 0.028, 0.005, 2),
        basisMat(tX, tUp, tDir, tBase.clone().add(tDir.clone().multiplyScalar(-0.012))),
        { wear: 0.06, ao: 0.22, mode: 'flat' });
      // Web of the hand: the stretched span between thumb base and the index
      // knuckle. Without it the thumb reads as a separate limb bolted on.
      var webMid = tBase.clone().lerp(firstKnuckle.p, 0.52)
        .addScaledVector(pRadial, -0.004);
      var webZ = firstKnuckle.p.clone().sub(tBase).normalize();
      var webY = pRadial.clone().projectOnPlane(webZ).normalize();
      if (!isFinite(webY.x) || webY.lengthSq() < 0.2) webY.copy(front);
      var webX = new THREE.Vector3().crossVectors(webY, webZ).normalize();
      b.add(keyGlove, bx(0.0175, 0.0135, tBase.distanceTo(firstKnuckle.p) * 0.94, 0.0050, 2),
        basisMat(webX, webY, webZ, webMid),
        { wear: 0.05, ao: 0.24, mode: 'flat', occl: occl });
    }

    // ---- wrist, cuff and forearm -----------------------------------------
    var armDir = (o.armDir ? o.armDir.clone() : axis.clone()).normalize();
    var wrist = palmCentre.clone().add(axis.clone().multiplyScalar(0.052))
      .add(pRadial.clone().multiplyScalar(-0.004));
    var aUp = pRadial.clone().projectOnPlane(armDir).normalize();
    if (!isFinite(aUp.x) || aUp.lengthSq() < 0.2) aUp.set(0, 1, 0).projectOnPlane(armDir).normalize();
    var aX = new THREE.Vector3().crossVectors(aUp, armDir).normalize();
    var armM = basisMat(aX, aUp, armDir, wrist);
    b.add(keyGlove, capsuleZ(0.0245, 0.026, 12), armM.clone().multiply(mat4(0, 0, 0.014)),
      { wear: 0.05, ao: 0.20, mode: 'flat' });
    // glove cuff with a hook-and-loop strap
    b.add(keyGlove, cylZ(0.0272, 0.0258, 0.030, 14), armM.clone().multiply(mat4(0, 0, 0.040)),
      { wear: 0.22, ao: 0.16, mode: 'rim', tol: 0.0012 });
    // webbing wrist strap, deliberately off-centre so the cuff is not a
    // perfect surface of revolution
    b.add(keyGlove, bx(0.0560, 0.0075, 0.0125, 0.0018, 2),
      armM.clone().multiply(mat4(0, 0.0035, 0.0455, 0, 0, 0.20)),
      { wear: 0.28, ao: 0.10, mode: 'edges', tol: 0.0018 });
    b.add(keySkin, cylZ(0.0248, 0.0262, 0.020, 14), armM.clone().multiply(mat4(0, 0, 0.062)),
      { wear: 0, ao: 0.26, mode: 'none' });
    // Sleeve. The forearm BREAKS at the elbow: two straight rods running
    // parallel out of frame read as pipes, so the second half re-bases on an
    // outboard-rotated axis and stops short of showing its end cap.
    var sleeveKey = (keyGlove === 'glove') ? 'sleeve' : keyGlove;
    b.add(sleeveKey, cylZ(0.0290, 0.0335, 0.026, 14),
      armM.clone().multiply(mat4(0, 0, 0.084)), { wear: 0.10, ao: 0.20, mode: 'rim', tol: 0.0012 });
    b.add(sleeveKey, cylZ(0.0335, 0.0392, 0.120, 14),
      armM.clone().multiply(mat4(0, 0, 0.157)), { wear: 0.06, ao: 0.24, mode: 'flat' });
    // fabric fold at the elbow so the forearm is not one plain tube
    b.add(sleeveKey, cylZ(0.0388, 0.0366, 0.018, 14),
      armM.clone().multiply(mat4(0, 0, 0.222)), { wear: 0.08, ao: 0.22, mode: 'rim', tol: 0.0012 });
    // asymmetric bunched fold, one side only
    b.add(sleeveKey, bx(0.0180, 0.0300, 0.0330, 0.0060, 2),
      armM.clone().multiply(mat4(-0.0290, 0.0040, 0.196, 0, 0.22, 0.14)),
      { wear: 0.06, ao: 0.30, mode: 'flat' });
    // upper forearm on an elbow-broken axis (~22 deg outboard)
    var elbowP = new THREE.Vector3(0, 0, 0.232).applyMatrix4(armM);
    var elbowDir = armDir.clone().applyAxisAngle(aUp, (o.elbowOut === undefined ? 0.38 : o.elbowOut) * (sense >= 0 ? 1 : -1));
    var eUp = aUp.clone().projectOnPlane(elbowDir).normalize();
    if (!isFinite(eUp.x) || eUp.lengthSq() < 0.2) eUp.copy(aUp);
    var eX = new THREE.Vector3().crossVectors(eUp, elbowDir).normalize();
    var elbowM = basisMat(eX, eUp, elbowDir, elbowP);
    b.add(sleeveKey, cylZ(0.0372, 0.0424, 0.105, 14),
      elbowM.clone().multiply(mat4(0, 0, 0.050)), { wear: 0.05, ao: 0.30, mode: 'flat' });
  }

  // ==========================================================================
  // 6. Shared sub-assemblies
  // ==========================================================================

  // MIL-STD-1913 rail: a trapezoidal base bar plus individual teeth. Real
  // transverse slots, so the silhouette and the specular both break up.
  function picatinny(MB, group, zRear, zFront, yBase, xC, wearAmt) {
    var w = 0.0212, base = 0.0030, toothH = 0.0043, pitch = 0.0100, toothD = 0.0047;
    var len = zRear - zFront;
    MB.add(group, 'metalHard', bx(w, base, len, 0.0005, 2),
      mat4(xC, yBase + base * 0.5, (zRear + zFront) * 0.5), { wear: 0.16, ao: 0.05, tol: 0.0011 });
    var s = new THREE.Shape();
    var hw = w * 0.5, tw = 0.0079;
    s.moveTo(-hw, 0); s.lineTo(hw, 0); s.lineTo(tw, toothH); s.lineTo(-tw, toothH); s.closePath();
    var tooth = extrude(s, toothD, 0.00035, 2);
    var n = Math.max(1, Math.floor(len / pitch));
    for (var i = 0; i < n; i++) {
      MB.add(group, 'metalHard', tooth, mat4(xC, yBase + base, zRear - pitch * 0.5 - i * pitch),
        { wear: wearAmt === undefined ? 0.28 : wearAmt, ao: 0.0, tol: 0.0008 });
    }
    tooth.dispose();
  }

  // One facet of the free-float handguard, with genuine M-LOK cut-outs.
  function mlokPanel(MB, group, angRad, apothem, zC, len, panelW, thick, slots) {
    var n = new THREE.Vector3(Math.sin(angRad), Math.cos(angRad), 0);
    var t = new THREE.Vector3(Math.cos(angRad), -Math.sin(angRad), 0);
    var f = new THREE.Vector3(0, 0, -1);
    var shape = roundedRectShape(panelW, len, 0.0018);
    if (slots) {
      for (var i = 0; i < slots.length; i++) {
        shape.holes.push(slotPathV(0, slots[i], 0.0300, 0.0072));
      }
    }
    var g = extrude(shape, thick, 0.0006, 7);
    var o = new THREE.Vector3(n.x * (apothem + thick * 0.5), n.y * (apothem + thick * 0.5), zC);
    MB.add(group, 'metalHard', g, basisMat(t, f, n, o), { wear: 0.22, ao: 0.07, tol: 0.0012 });
  }

  // Extruded loop with a hole - trigger guard, sling loop, stock sling slot.
  function loopPart(MB, group, key, outerW, outerH, r, holeW, holeH, holeR, holeOff, depth, origin, xAxis, yAxis, zAxis, opt) {
    var s = roundedRectShape(outerW, outerH, r);
    s.holes.push(roundedRectPath(holeOff || 0, 0, holeW, holeH, holeR));
    MB.add(group, key, extrude(s, depth, 0.0008, 7), basisMat(xAxis, yAxis, zAxis, origin), opt);
  }

  // ==========================================================================
  // 7. M4-style carbine
  //
  // Bore axis is the Z line at (0,0); the muzzle points down -Z. All numbers
  // are metres and taken from real AR-15 geometry (14.5" barrel, 2.5" sight
  // height over bore, STANAG magwell).
  // ==========================================================================

  function buildCarbine(MB) {
    var G = 'body';
    MB.group(G);
    MB.group('bolt');
    MB.group('cover');
    MB.group('charge');
    MB.group('trigger');
    MB.group('mag');
    MB.group('lhand');
    MB.group('rhand');

    var A = function (g, k, geo, m, o) { MB.add(g, k, geo, m, o); };
    // These are RELATIVE rub budgets, scaled by WEAR_BUDGET and then masked
    // per-pixel. They used to be near 1.0, which turned every flat face into
    // bare aluminium and made the rifle brighter than sunlit plaster.
    var metal = { wear: 0.30, ao: 0.06 };
    var metalEdge = { wear: 0.32, ao: 0.03, tol: 0.0013 };
    var poly = { wear: 0.20, ao: 0.12 };
    var deep = { wear: 0.0, ao: 0.75, mode: 'none' };

    // ---- upper receiver ---------------------------------------------------
    // Built as a shell rather than a solid block so the ejection port is an
    // actual hole you can see the bolt carrier through when the dust cover
    // flips open. A painted-on port would read as a sticker at this distance.
    var rxAx = new THREE.Vector3(0, 0, -1), ryAx = new THREE.Vector3(0, 1, 0), rzAx = new THREE.Vector3(1, 0, 0);
    A(G, 'metal', bx(0.0378, 0.0092, 0.1980, 0.0016, 2), mat4(0, 0.0164, -0.0965), metal);
    A(G, 'metal', bx(0.0378, 0.0092, 0.1980, 0.0016, 2), mat4(0, -0.0144, -0.0965), metal);
    A(G, 'metal', bx(0.0062, 0.0400, 0.1980, 0.0016, 2), mat4(-0.0158, 0.0010, -0.0965), metal);
    loopPart(MB, G, 'metal', 0.1980, 0.0400, 0.0030, 0.0580, 0.0240, 0.0040, -0.0495, 0.0062,
      new THREE.Vector3(0.0158, 0.0010, -0.0965), rxAx, ryAx, rzAx, { wear: 0.62, ao: 0.06, tol: 0.0016 });
    A(G, 'metal', bx(0.0378, 0.0400, 0.0340, 0.0016, 2), mat4(0, 0.0010, -0.1810), metal);
    A(G, 'metal', bx(0.0378, 0.0400, 0.0280, 0.0016, 2), mat4(0, 0.0010, -0.0035), metal);
    // dark internals so the open port looks into a cavity, not at a wall
    A(G, 'inner', bx(0.0300, 0.0070, 0.1500, 0.0008, 2), mat4(0, -0.0100, -0.0950), deep);
    A(G, 'inner', bx(0.0300, 0.0070, 0.1500, 0.0008, 2), mat4(0, 0.0125, -0.0950), deep);
    A(G, 'inner', bx(0.0062, 0.0290, 0.1500, 0.0008, 2), mat4(-0.0122, 0.0010, -0.0950), deep);
    // rear takedown boss and the "shelf" the charging handle rides in
    A(G, 'metal', bx(0.0350, 0.0300, 0.0180, 0.0014, 2), mat4(0, 0.0020, 0.0110), metal);
    A(G, 'metal', cylZ(0.0068, 0.0068, 0.0360, 14), mat4(0, -0.0165, -0.0060), metal);
    // charging-handle channel walls
    A(G, 'metal', bx(0.0060, 0.0092, 0.0300, 0.0008, 2), mat4(-0.0148, 0.0182, 0.0060), metal);
    A(G, 'metal', bx(0.0060, 0.0092, 0.0300, 0.0008, 2), mat4(0.0148, 0.0182, 0.0060), metal);
    // top rail: receiver + free-float handguard read as one continuous rail
    picatinny(MB, G, 0.0075, -0.4740, 0.0202, 0, 0.15);

    // ---- ejection port, brass deflector, forward assist (right side) ------
    // raised lip framing the opening
    A(G, 'metal', bx(0.0055, 0.0044, 0.0640, 0.0009, 2), mat4(0.0182, 0.0126, -0.0470), metalEdge);
    A(G, 'metal', bx(0.0055, 0.0044, 0.0640, 0.0009, 2), mat4(0.0182, -0.0162, -0.0470), metalEdge);
    A(G, 'metal', bx(0.0055, 0.0290, 0.0050, 0.0009, 2), mat4(0.0182, -0.0018, -0.0155), metalEdge);
    A(G, 'metal', bx(0.0055, 0.0290, 0.0050, 0.0009, 2), mat4(0.0182, -0.0018, -0.0785), metalEdge);
    // brass deflector - the wedge behind the port
    A(G, 'metal', bx(0.0110, 0.0180, 0.0260, 0.0022, 2), mat4(0.0218, 0.0060, -0.0100, 0, 0, -0.32), metal);
    A(G, 'metal', bx(0.0080, 0.0130, 0.0150, 0.0020, 2), mat4(0.0230, 0.0020, -0.0025, 0.34, 0, -0.42), metal);
    // forward assist: housing + fluted plunger
    A(G, 'metal', cylZ(0.0084, 0.0090, 0.0230, 14), mat4(0.0215, 0.0092, -0.0110), metal);
    A(G, 'metal', cylZ(0.0062, 0.0062, 0.0110, 12), mat4(0.0215, 0.0092, 0.0060), metalEdge);
    A(G, 'metal', cylZ(0.0074, 0.0074, 0.0030, 12), mat4(0.0215, 0.0092, 0.0112), metalEdge);
    // ejection port dust cover (hinged along the bottom, swings out on +X)
    MB.groups.cover.obj.position.set(0.0185, -0.0148, -0.0470);
    A('cover', 'metal', bx(0.0038, 0.0270, 0.0610, 0.0009, 2), mat4(0, 0.0134, 0), metalEdge);
    A('cover', 'metal', bx(0.0030, 0.0060, 0.0080, 0.0006, 2), mat4(0.0006, 0.0272, -0.0250), metalEdge);
    A('cover', 'metal', cylZ(0.0030, 0.0030, 0.0620, 10), mat4(0, 0, 0), metal);

    // ---- bolt carrier seen through the port ------------------------------
    A('bolt', 'metalDark', cylZ(0.0128, 0.0128, 0.1000, 22), mat4(0, -0.0010, -0.0480), { wear: 0.5, ao: 0.35, mode: 'rim' });
    A('bolt', 'metalDark', bx(0.0250, 0.0090, 0.0300, 0.0008, 2), mat4(0, 0.0080, -0.0400), { wear: 0.4, ao: 0.3 });
    A('bolt', 'brass', cylZ(0.0046, 0.0046, 0.0180, 10), mat4(0, -0.0030, -0.0840), { wear: 0.2, ao: 0.2, mode: 'rim' });

    // ---- left side furniture: bolt catch, selector ------------------------
    A(G, 'metal', bx(0.0055, 0.0225, 0.0320, 0.0012, 2), mat4(-0.0198, -0.0290, -0.0530), metalEdge);
    A(G, 'metal', bx(0.0075, 0.0110, 0.0130, 0.0012, 2), mat4(-0.0208, -0.0330, -0.0400), metalEdge);
    A(G, 'metal', cylZ(0.0060, 0.0060, 0.0290, 12), mat4(-0.0186, -0.0300, -0.0530), metal);
    // safety selector, both sides
    var selL = mat4(-0.0198, -0.0300, -0.0020, 0, 0, 0);
    A(G, 'metal', new THREE.CylinderGeometry(0.0090, 0.0090, 0.0056, 14).rotateZ(HALF_PI), selL, metal);
    A(G, 'metal', bx(0.0060, 0.0110, 0.0260, 0.0012, 2), mat4(-0.0212, -0.0348, 0.0058, 0.42, 0, 0), metalEdge);
    A(G, 'metal', new THREE.CylinderGeometry(0.0072, 0.0072, 0.0050, 12).rotateZ(HALF_PI), mat4(0.0196, -0.0300, -0.0020), metal);
    A(G, 'metal', bx(0.0050, 0.0090, 0.0200, 0.0010, 2), mat4(0.0206, -0.0340, 0.0040, 0.42, 0, 0), metalEdge);
    // magazine release + its fence (right side)
    A(G, 'metal', new THREE.CylinderGeometry(0.0092, 0.0092, 0.0070, 14).rotateZ(HALF_PI), mat4(0.0200, -0.0348, -0.0505), metal);
    A(G, 'metal', new THREE.CylinderGeometry(0.0058, 0.0058, 0.0064, 12).rotateZ(HALF_PI), mat4(0.0228, -0.0348, -0.0505), metalEdge);
    // takedown / pivot pins
    A(G, 'metal', new THREE.CylinderGeometry(0.0052, 0.0052, 0.0400, 12).rotateZ(HALF_PI), mat4(0, -0.0330, -0.1560), metal);
    A(G, 'metal', new THREE.CylinderGeometry(0.0052, 0.0052, 0.0400, 12).rotateZ(HALF_PI), mat4(0, -0.0330, 0.0020), metal);

    // ---- lower receiver + flared magwell ---------------------------------
    A(G, 'metal', bx(0.0362, 0.0350, 0.1900, 0.0018, 2), mat4(0, -0.0368, -0.0880), metal);
    A(G, 'metal', bx(0.0330, 0.0250, 0.0560, 0.0016, 2), mat4(0, -0.0520, -0.1300), metal);
    // magwell walls, splayed outward at the mouth to make the flare
    var wellZ = -0.0745, wellY = -0.0645;
    A(G, 'metal', bx(0.0380, 0.0300, 0.0060, 0.0014, 2), mat4(0, wellY, wellZ - 0.0330, -0.13, 0, 0), metal);
    A(G, 'metal', bx(0.0380, 0.0300, 0.0060, 0.0014, 2), mat4(0, wellY, wellZ + 0.0330, 0.13, 0, 0), metal);
    A(G, 'metal', bx(0.0060, 0.0300, 0.0700, 0.0014, 2), mat4(-0.0190, wellY, wellZ, 0, 0, 0.13), metal);
    A(G, 'metal', bx(0.0060, 0.0300, 0.0700, 0.0014, 2), mat4(0.0190, wellY, wellZ, 0, 0, -0.13), metal);
    // the flare lip itself - a hard bright edge that catches the sky
    A(G, 'metal', bx(0.0460, 0.0070, 0.0090, 0.0016, 2), mat4(0, -0.0790, wellZ - 0.0378, -0.55, 0, 0), metalEdge);
    A(G, 'metal', bx(0.0460, 0.0070, 0.0090, 0.0016, 2), mat4(0, -0.0790, wellZ + 0.0378, 0.55, 0, 0), metalEdge);
    A(G, 'metal', bx(0.0090, 0.0070, 0.0760, 0.0016, 2), mat4(-0.0224, -0.0790, wellZ, 0, 0, 0.55), metalEdge);
    A(G, 'metal', bx(0.0090, 0.0070, 0.0760, 0.0016, 2), mat4(0.0224, -0.0790, wellZ, 0, 0, -0.55), metalEdge);
    A(G, 'inner', bx(0.0250, 0.0260, 0.0620, 0.0010, 2), mat4(0, -0.0660, wellZ), deep);

    // ---- trigger guard + trigger -----------------------------------------
    var gzAx = new THREE.Vector3(0, 0, -1), gyAx = new THREE.Vector3(0, 1, 0), gxAx = new THREE.Vector3(1, 0, 0);
    loopPart(MB, G, 'metal', 0.0620, 0.0430, 0.0130, 0.0470, 0.0300, 0.0110, 0.0010, 0.0068,
      new THREE.Vector3(0, -0.0680, -0.0090), gzAx, gyAx, gxAx, { wear: 0.85, ao: 0.10, tol: 0.0013 });
    MB.groups.trigger.obj.position.set(0, -0.0498, -0.0055);
    var tri = new THREE.Shape();
    tri.moveTo(-0.0042, 0.0000); tri.lineTo(0.0052, 0.0000);
    tri.lineTo(0.0060, -0.0110); tri.lineTo(0.0028, -0.0192);
    tri.lineTo(-0.0026, -0.0186); tri.lineTo(-0.0044, -0.0100);
    tri.closePath();
    A('trigger', 'metal', extrude(tri, 0.0062, 0.0006, 5),
      basisMat(gzAx, gyAx, gxAx, new THREE.Vector3(0, 0, 0)), { wear: 0.75, ao: 0.15, tol: 0.0012 });

    // ---- pistol grip ------------------------------------------------------
    // Lofted so it has a real palm swell and a beavertail, not a tapered box.
    var gripDir = new THREE.Vector3(0, -1, 0.40).normalize();
    var gripQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), gripDir);
    var gripTop = new THREE.Vector3(0, -0.0470, 0.0080);
    var gripProf = rrProfile(0.0330, 0.0470, 0.0110, 6);
    var gframes = [], gi, gt;
    var gsw = [0.86, 1.00, 1.04, 1.00, 0.94, 0.92, 1.02];
    var gdp = [1.14, 1.00, 0.95, 0.92, 0.90, 0.92, 1.00];
    for (gi = 0; gi < 7; gi++) {
      gt = gi / 6;
      gframes.push({
        p: gripTop.clone().add(gripDir.clone().multiplyScalar(gt * 0.1130)),
        q: gripQ, sx: gsw[gi], sy: gdp[gi]
      });
    }
    A(G, 'polymer', loft(gripProf, gframes, true, true), null, { wear: 0.24, ao: 0.14, mode: 'flat' });
    // finger grooves + grip cap
    var gripSide = new THREE.Vector3(1, 0, 0);
    var gripUp = new THREE.Vector3().crossVectors(gripDir, gripSide).normalize();
    for (gi = 0; gi < 3; gi++) {
      A(G, 'rubber', new THREE.TorusGeometry(0.0142, 0.0026, 6, 14).rotateX(HALF_PI),
        basisMat(gripSide, gripUp, gripDir,
          gripTop.clone().add(gripDir.clone().multiplyScalar(0.034 + gi * 0.026))),
        { wear: 0.3, ao: 0.2, mode: 'flat' });
    }
    A(G, 'polymer', bx(0.0350, 0.0090, 0.0430, 0.0035, 2),
      mat4(0, gripTop.y + gripDir.y * 0.118, gripTop.z + gripDir.z * 0.118,
        Math.atan2(gripDir.z, -gripDir.y), 0, 0), { wear: 0.5, ao: 0.3 });
    // beavertail where the web of the hand sits
    A(G, 'metal', bx(0.0300, 0.0150, 0.0230, 0.0050, 2), mat4(0, -0.0470, 0.0180, -0.30, 0, 0), metal);

    // ---- buffer tube, castle nut, notched bottom rail ---------------------
    A(G, 'metal', cylZ(0.0180, 0.0186, 0.1900, 30), mat4(0, -0.0040, 0.1070), { wear: 0.42, ao: 0.10, mode: 'flat' });
    A(G, 'metal', cylZ(0.0225, 0.0225, 0.0140, 26), mat4(0, -0.0040, 0.0195), metalEdge);
    A(G, 'metal', cylZ(0.0205, 0.0205, 0.0090, 26), mat4(0, -0.0040, 0.1990), metalEdge);
    // 7 stock-adjustment notches: eight short rail sections with gaps between
    for (gi = 0; gi < 8; gi++) {
      A(G, 'metal', bx(0.0110, 0.0075, 0.0128, 0.0009, 2),
        mat4(0, -0.0212, 0.0400 + gi * 0.0192), metalEdge);
    }
    A(G, 'metal', bx(0.0090, 0.0055, 0.1560, 0.0008, 2), mat4(0, -0.0186, 0.1120), { wear: 0.3, ao: 0.35 });

    // ---- collapsible stock -----------------------------------------------
    // The sy curve is deliberately NON-monotonic: a straight taper lofts into a
    // featureless teardrop that reads as an airship nosecone. The dip at frame
    // 3 gives the stock a real toe/heel angle instead.
    // The old sy curve peaked at 1.60 - a 90mm-tall pod, 2.2x the receiver -
    // which is what made the stock read as one smooth bulbous mass. A real M4
    // stock is a slim spine riding a visible buffer tube, so the body is now
    // 71mm at its deepest and only wraps the tube; the comb, the butt pad and
    // the release lever below then read as three separate steps against it.
    var stockQ = new THREE.Quaternion();
    var sProf = rrProfile(0.0410, 0.0560, 0.0115, 6);
    var sframes = [];
    var szs = [0.0520, 0.0760, 0.1080, 0.1400, 0.1650, 0.1810];
    var sx = [0.90, 0.97, 1.00, 1.00, 1.01, 0.99];
    var sy = [0.84, 0.96, 1.06, 1.02, 1.20, 1.26];
    var sYo = [-0.0050, -0.0070, -0.0100, -0.0130, -0.0150, -0.0155];
    for (gi = 0; gi < 6; gi++) {
      sframes.push({ p: new THREE.Vector3(0, sYo[gi], szs[gi]), q: stockQ, sx: sx[gi], sy: sy[gi] });
    }
    A(G, 'polymer', loft(sProf, sframes, true, false), null, { wear: 0.16, ao: 0.10, mode: 'flat' });
    // Hard breaklines on the visible flank. Without these the stock's whole
    // side is 100% blank at any showcase angle - the comb, the release lever
    // and the sling slot all sit on faces the camera never sees.
    for (gi = 0; gi < 2; gi++) {
      var sfx = gi ? 1 : -1;
      // moulded side plate, proud of the flank so it throws a hard shadow line
      A(G, 'polymer', bx(0.0042, 0.0380, 0.0900, 0.0030, 2),
        mat4(sfx * 0.0212, -0.0100, 0.1320), { wear: 0.16, ao: 0.10, mode: 'flat' });
      // the recess groove inside it
      A(G, 'inner', bx(0.0022, 0.0240, 0.0740, 0.0010, 2),
        mat4(sfx * 0.0220, -0.0100, 0.1320), deep);
      A(G, 'polymer', bx(0.0032, 0.0200, 0.0700, 0.0014, 2),
        mat4(sfx * 0.0224, -0.0100, 0.1320), { wear: 0.20, ao: 0.14, mode: 'flat' });
      // ambidextrous QD socket on both flanks
      A(G, 'metal', new THREE.CylinderGeometry(0.0072, 0.0072, 0.0070, 14).rotateZ(HALF_PI),
        mat4(sfx * 0.0196, -0.0090, 0.0700), metalEdge);
      A(G, 'inner', new THREE.CylinderGeometry(0.0042, 0.0042, 0.0080, 10).rotateZ(HALF_PI),
        mat4(sfx * 0.0218, -0.0090, 0.0700), deep);
    }
    // cheek weld comb - a thin slab sitting ON the spine, not part of it
    A(G, 'polymer', bx(0.0225, 0.0105, 0.0880, 0.0035, 2), mat4(0, 0.0238, 0.1300, -0.06, 0, 0), poly);
    A(G, 'polymer', bx(0.0245, 0.0042, 0.0300, 0.0018, 2), mat4(0, 0.0172, 0.0790, -0.06, 0, 0), poly);
    // butt pad, sized to the slimmer stock instead of overhanging it
    A(G, 'rubber', bx(0.0430, 0.0740, 0.0140, 0.0055, 2), mat4(0, -0.0165, 0.1880, 0.10, 0, 0), { wear: 0.10, ao: 0.2, mode: 'flat' });
    for (gi = 0; gi < 4; gi++) {
      A(G, 'rubber', bx(0.0385, 0.0055, 0.0110, 0.0015, 2), mat4(0, -0.0430 + gi * 0.0175, 0.1955), { wear: 0.10, ao: 0.1 });
    }
    // stock release lever underneath, with its channel running to the toe
    A(G, 'polymer', bx(0.0180, 0.0230, 0.0290, 0.0035, 2), mat4(0, -0.0430, 0.1210, 0.22, 0, 0), poly);
    A(G, 'polymer', bx(0.0230, 0.0090, 0.0160, 0.0025, 2), mat4(0, -0.0540, 0.1330, 0.42, 0, 0), poly);
    A(G, 'inner', bx(0.0128, 0.0060, 0.0780, 0.0012, 2), mat4(0, -0.0448, 0.1470, 0.10, 0, 0), deep);
    A(G, 'polymer', bx(0.0072, 0.0090, 0.0790, 0.0018, 2), mat4(-0.0098, -0.0432, 0.1470, 0.10, 0, 0), { wear: 0.22, ao: 0.14, tol: 0.0014 });
    A(G, 'polymer', bx(0.0072, 0.0090, 0.0790, 0.0018, 2), mat4(0.0098, -0.0432, 0.1470, 0.10, 0, 0), { wear: 0.22, ao: 0.14, tol: 0.0014 });
    // rear sling slot: a real hole through the stock plate
    loopPart(MB, G, 'polymer', 0.0340, 0.0280, 0.0080, 0.0180, 0.0140, 0.0050, 0, 0.0400,
      new THREE.Vector3(0, -0.0230, 0.1580), gzAx, gyAx, gxAx, { wear: 0.26, ao: 0.18, tol: 0.0013 });
    // QD sling loop on the left of the stock
    A(G, 'metal', new THREE.TorusGeometry(0.0080, 0.0022, 6, 14),
      mat4(-0.0218, -0.0120, 0.0760, 0, HALF_PI, 0), metalEdge);

    // ---- free-float M-LOK handguard --------------------------------------
    var hgZ = -0.3395, hgLen = 0.2680, apo = 0.0225, panelW = 0.0182, panelT = 0.0042;
    var slotY = [-0.1000, -0.0600, -0.0200, 0.0200, 0.0600, 0.1000];
    var facets = [
      { a: 45, s: null }, { a: 90, s: slotY }, { a: 135, s: slotY },
      { a: 180, s: slotY }, { a: 225, s: slotY }, { a: 270, s: slotY }, { a: 315, s: null }
    ];
    for (gi = 0; gi < facets.length; gi++) {
      mlokPanel(MB, G, facets[gi].a * PI / 180, apo, hgZ, hgLen, panelW, panelT, facets[gi].s);
    }
    // dark inner shroud so the slots read as holes into a cavity
    A(G, 'inner', cylZ(0.0176, 0.0176, 0.2640, 22), mat4(0, 0, hgZ), deep);
    // barrel-nut collar and the front end cap
    A(G, 'metal', cylZ(0.0248, 0.0252, 0.0300, 28), mat4(0, 0, -0.2160), { wear: 0.6, ao: 0.08, mode: 'rim', tol: 0.0013 });
    A(G, 'metal', cylZ(0.0238, 0.0238, 0.0060, 28), mat4(0, 0, -0.2330), metalEdge);
    A(G, 'metal', new THREE.RingGeometry(0.0180, 0.0248, 28, 1).rotateY(PI), mat4(0, 0, -0.4760), metalEdge);
    A(G, 'metal', cylZ(0.0250, 0.0246, 0.0080, 28), mat4(0, 0, -0.4720), metalEdge);
    // QD sling socket on the handguard, left side, plus a front loop
    A(G, 'metal', new THREE.CylinderGeometry(0.0062, 0.0062, 0.0060, 12).rotateZ(HALF_PI),
      mat4(-0.0232, -0.0090, -0.4400), metalEdge);
    A(G, 'metal', new THREE.TorusGeometry(0.0075, 0.0021, 6, 14),
      mat4(-0.0215, -0.0130, -0.2500, 0, HALF_PI, 0), metalEdge);

    // ---- barrel, gas system, flash hider ---------------------------------
    A(G, 'metalDark', cylZ(0.0110, 0.0128, 0.0460, 26), mat4(0, 0, -0.2180), { wear: 0.25, ao: 0.3, mode: 'flat' });
    A(G, 'metalDark', cylZ(0.0091, 0.0100, 0.2420, 26), mat4(0, 0, -0.3590), { wear: 0.18, ao: 0.25, mode: 'flat' });
    A(G, 'metalDark', cylZ(0.0022, 0.0022, 0.2500, 8), mat4(0, 0.0128, -0.3560), { wear: 0.1, ao: 0.4, mode: 'flat' });
    // low-profile gas block
    A(G, 'metalDark', bx(0.0248, 0.0270, 0.0330, 0.0022, 2), mat4(0, 0.0008, -0.4940), { wear: 0.5, ao: 0.12, tol: 0.0016 });
    A(G, 'metalDark', bx(0.0180, 0.0080, 0.0120, 0.0014, 2), mat4(0, 0.0148, -0.4980), { wear: 0.6, ao: 0.05 });
    A(G, 'metal', new THREE.CylinderGeometry(0.0028, 0.0028, 0.0270, 8).rotateZ(HALF_PI), mat4(0, -0.0050, -0.4870), metalEdge);
    // 11-degree tapered shoulder out of the gas block instead of the old hard
    // step - two tubes jammed together is the loudest "primitive" tell there is
    A(G, 'metalDark', cylZ(0.0086, 0.0100, 0.0072, 26), mat4(0, 0, -0.5140), { wear: 0.14, ao: 0.22, mode: 'flat' });
    A(G, 'metalDark', cylZ(0.0080, 0.0086, 0.0580, 26), mat4(0, 0, -0.5480), { wear: 0.2, ao: 0.2, mode: 'flat' });
    // muzzle threads
    A(G, 'metalDark', cylZ(0.0071, 0.0071, 0.0090, 22), mat4(0, 0, -0.5790), { wear: 0.4, ao: 0.1, mode: 'rim' });
    for (gi = 0; gi < 5; gi++) {
      A(G, 'metalDark', new THREE.TorusGeometry(0.0072, 0.00042, 4, 16),
        mat4(0, 0, -0.5760 - gi * 0.0016), { wear: 0.30, ao: 0.06, mode: 'flat' });
    }
    // A2 birdcage: solid bottom sector, five real slots between five tines.
    // Deep, wide slots - at 2.8mm the old ones vanished at rendered scale and
    // the whole device read as a smooth cap.
    A(G, 'muzzleDev', cylZ(0.0112, 0.0118, 0.0150, 26), mat4(0, 0, -0.5880), { wear: 0.30, ao: 0.06, mode: 'rim', tol: 0.0012 });
    A(G, 'muzzleDev', arcPrism(0.0066, 0.0112, 240 * PI / 180, 300 * PI / 180, 0.0370, 0.0006),
      mat4(0, 0, -0.6070), { wear: 0.28, ao: 0.12, tol: 0.0012 });
    for (gi = 0; gi < 5; gi++) {
      var a0 = (305 + gi * 60) * PI / 180;
      A(G, 'muzzleDev', arcPrism(0.0066, 0.0112, a0, a0 + 26 * PI / 180, 0.0370, 0.0005),
        mat4(0, 0, -0.6070), { wear: 0.30, ao: 0.08, tol: 0.0012 });
    }
    // proud crown ring at the front face, so the device has a rim to catch light
    A(G, 'muzzleDev', cylZ(0.0118, 0.0112, 0.0035, 30), mat4(0, 0, -0.6238), { wear: 0.32, ao: 0.04, mode: 'rim', tol: 0.0009 });
    // The bore is UNLIT: a lit cavity seen end-on at grazing incidence picks up
    // a Fresnel rim and stops reading as a hole. This is the one place on the
    // weapon that genuinely has to be a void.
    A(G, 'tubeInner', cylZ(0.0074, 0.0074, 0.0700, 16), mat4(0, 0, -0.5950), { wear: 0, ao: 0, mode: 'none' });
    A(G, 'tubeInner', new THREE.CircleGeometry(0.0074, 16).rotateY(PI), mat4(0, 0, -0.6255), { wear: 0, ao: 0, mode: 'none' });

    // ---- vertical foregrip -----------------------------------------------
    A(G, 'metal', bx(0.0300, 0.0110, 0.0440, 0.0025, 2), mat4(0, -0.0268, -0.3550), metal);
    A(G, 'metal', bx(0.0220, 0.0080, 0.0180, 0.0018, 2), mat4(0, -0.0330, -0.3550), metal);
    var fgProf = rrProfile(0.0300, 0.0340, 0.0120, 6);
    var fgQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, -1, 0));
    var fgFrames = [], fsc = [0.78, 1.00, 1.02, 0.96, 0.92, 0.98, 1.16];
    for (gi = 0; gi < 7; gi++) {
      fgFrames.push({
        p: new THREE.Vector3(0, -0.0345 - (gi / 6) * 0.0920, -0.3550),
        q: fgQ, sx: fsc[gi], sy: fsc[gi]
      });
    }
    A(G, 'polymer', loft(fgProf, fgFrames, true, true), null, { wear: 0.26, ao: 0.16, mode: 'flat' });
    for (gi = 0; gi < 3; gi++) {
      A(G, 'rubber', new THREE.TorusGeometry(0.0148, 0.0024, 6, 14).rotateX(HALF_PI),
        mat4(0, -0.0530 - gi * 0.0230, -0.3550), { wear: 0.3, ao: 0.2, mode: 'flat' });
    }

    // ---- red-dot optic ----------------------------------------------------
    // REAL AIMPOINT-T2 PROPORTIONS. The previous build was a 41.2mm-OD tube
    // 52mm long with the eye 155mm behind it, which put the outer housing at
    // 41.7% of frame height (a shipped red-dot ADS is 22-26%) and, worse, made
    // the tube wall eat 48% of the clear aperture by pure construction: at that
    // eye relief the rear rim subtended 6.45 deg and the front rim 4.67 deg, so
    // 1-(4.67/6.45)^2 of what you could see through was tube, not sight
    // picture. Three numbers fix that together - 30mm OD, a 22mm-long clear
    // tube instead of 50mm, and 180mm of eye relief:
    //     outer disc   = 2*atan(0.0150/0.1675) -> 23.3% of frame height
    //     clear disc   = 2*atan(0.0125/0.1910) -> 17.1% of frame height
    //     clear/outer area ratio                 0.53   (was 0.264)
    var oy = 0.0632, oz = -0.0750;
    var oR = 0.0150;        // housing outer radius (30mm OD)
    var oHalf = 0.0125;     // housing half length
    var oBore = 0.0127;     // housing inner bore
    var tR = 0.0125;        // clear aperture radius
    var tHalf = 0.0110;     // clear tube half length
    // Mount stack, bottom-up: rail-clamp -> riser -> housing. The riser MUST
    // stop below the tube's inner radius (oy - tR) or it stands up inside
    // the optic and eats the bottom of the sight picture.
    A(G, 'metal', bx(0.0360, 0.0130, 0.0430, 0.0025, 2), mat4(0, 0.0300, oz), metal);
    A(G, 'metal', bx(0.0300, 0.0150, 0.0340, 0.0025, 2), mat4(0, 0.0420, oz), metal);
    A(G, 'metal', bx(0.0072, 0.0110, 0.0290, 0.0018, 2), mat4(-0.0208, 0.0296, oz, 0, 0, 0.18), metalEdge);
    A(G, 'metal', new THREE.CylinderGeometry(0.0032, 0.0032, 0.0420, 10).rotateZ(HALF_PI), mat4(0, 0.0300, oz), metal);
    A(G, 'metal', latheZ([
      [oBore, -oHalf], [0.0138, -oHalf], [oR, -0.0114], [oR, -0.0096],
      [0.0142, -0.0088], [0.0142, 0.0088], [oR, 0.0096], [oR, 0.0114],
      [0.0138, oHalf], [oBore, oHalf], [oBore, -oHalf]
    ], 40), mat4(0, oy, oz), { wear: 0.42, ao: 0.06, mode: 'rim', tol: 0.0016 });
    // elevation / windage turrets and the battery cap, all at the same 0.73
    A(G, 'metal', new THREE.CylinderGeometry(0.0060, 0.0063, 0.0066, 14), mat4(0, oy + 0.0164, oz - 0.0044), metalEdge);
    A(G, 'metal', new THREE.CylinderGeometry(0.0050, 0.0050, 0.0044, 12), mat4(0, oy + 0.0217, oz - 0.0044), metalEdge);
    A(G, 'metal', new THREE.CylinderGeometry(0.0060, 0.0063, 0.0066, 14).rotateZ(HALF_PI), mat4(-0.0164, oy, oz - 0.0044), metalEdge);
    A(G, 'metal', new THREE.CylinderGeometry(0.0073, 0.0076, 0.0080, 16).rotateZ(HALF_PI), mat4(0.0172, oy, oz + 0.0015), metalEdge);
    for (gi = 0; gi < 8; gi++) {
      A(G, 'metal', bx(0.0021, 0.0022, 0.0073, 0.0005, 2),
        mat4(0.0213, oy + Math.cos(gi / 8 * PI * 2) * 0.0072, oz + 0.0015 + Math.sin(gi / 8 * PI * 2) * 0.0072,
          0, 0, gi / 8 * PI * 2), metalEdge);
    }
    // ONE lens pane, at the objective. The eye-side copy was never visible from
    // the eye and only doubled the milky veil over the whole sight picture.
    A(G, 'lens', new THREE.CircleGeometry(0.0126, 34), mat4(0, oy, oz - 0.0100), { wear: 0, ao: 0, mode: 'none' });
    // AR-coating flare: a single small off-axis quad, not a full-aperture
    // reflection. Real glass never brightens what is behind it uniformly.
    A(G, 'coating', new THREE.PlaneGeometry(0.0053, 0.0053),
      mat4(-0.0063, oy + 0.0060, oz - 0.0098), { wear: 0, ao: 0, mode: 'none', keepUV: true });
    // CLOSED tube liner. The old one was latheZ with a two-point profile: a
    // single-sided open cylinder with no end rings and no back faces, so it
    // could be looked straight through, and being a lit MeshStandardMaterial
    // at ~5 deg off grazing it rendered as a chrome sleeve at luminance 0.75
    // against a 0.76 sky. This is a real thin-walled tube (both surfaces plus
    // both end faces) in the unlit lib.tubeInner, so the sight picture is
    // bounded by geometry that no lighting path can brighten.
    A(G, 'tubeInner', latheZ([
      [tR, tHalf], [tR, -tHalf], [0.01268, -tHalf], [0.01268, tHalf], [tR, tHalf]
    ], 34), mat4(0, oy, oz), { wear: 0, ao: 0, mode: 'none' });
    // Matte eyepiece and objective rings. Without these the housing's own rear
    // annular face - lit aluminium - frames the aperture and reads as a bright
    // collar. A real optic's surround is black anodised right up to the outer
    // edge, and the only metal you see is the outer rim itself.
    A(G, 'tubeInner', new THREE.RingGeometry(0.01245, 0.01455, 40, 1),
      mat4(0, oy, oz + oHalf + 0.0002), { wear: 0, ao: 0, mode: 'none' });
    A(G, 'tubeInner', new THREE.RingGeometry(0.01245, 0.01455, 40, 1),
      mat4(0, oy, oz - oHalf - 0.0002), { wear: 0, ao: 0, mode: 'none' });
    // Reticle: hue-locked core + additive bloom skirt (see lib.reticleCore).
    // At 0.180m eye relief the core's solid disc is ~5.5px at 720p and its
    // soft edge dies by 12px - a crisp dot, not a 60px smear.
    A(G, 'reticle', new THREE.PlaneGeometry(0.0055, 0.0055), mat4(0, oy, oz - 0.0004), { wear: 0, ao: 0, mode: 'none', keepUV: true });
    A(G, 'reticleCore', new THREE.PlaneGeometry(0.0030, 0.0030), mat4(0, oy, oz), { wear: 0, ao: 0, mode: 'none', keepUV: true });

    // ---- charging handle --------------------------------------------------
    MB.groups.charge.obj.position.set(0, 0.0182, 0);
    A('charge', 'metal', bx(0.0300, 0.0062, 0.0620, 0.0010, 2), mat4(0, 0, 0.0100), metalEdge);
    A('charge', 'metal', bx(0.0470, 0.0090, 0.0150, 0.0016, 2), mat4(0, 0.0006, 0.0420), metalEdge);
    A('charge', 'metal', bx(0.0150, 0.0086, 0.0140, 0.0016, 2), mat4(-0.0270, 0.0006, 0.0420), metalEdge);
    for (gi = 0; gi < 4; gi++) {
      A('charge', 'metal', bx(0.0110, 0.0030, 0.0022, 0.0004, 2), mat4(-0.0270, 0.0056, 0.0370 + gi * 0.0032), metalEdge);
    }

    // ---- 30-round STANAG magazine ----------------------------------------
    var magTop = new THREE.Vector3(0, -0.0610, -0.0750);
    var magFrames = arcFrames(magTop, 1, 0.5200, 0.1840, 9);
    var magProf = rrProfile(0.0250, 0.0590, 0.0062, 5);
    var mi;
    for (mi = 0; mi < magFrames.length; mi++) {
      magFrames[mi].sx = 1 + (mi === 8 ? 0.04 : 0);
      magFrames[mi].sy = 1 - magFrames[mi].t * 0.045;
    }
    A('mag', 'polymer', loft(magProf, magFrames, false, true), null, { wear: 0.34, ao: 0.10, mode: 'flat' });
    // feed lips + the polymer body's reinforcing ribs
    A('mag', 'metal', bx(0.0262, 0.0090, 0.0600, 0.0012, 2), mat4(0, -0.0600, -0.0752), metalEdge);
    A('mag', 'inner', bx(0.0140, 0.0060, 0.0420, 0.0008, 2), mat4(0, -0.0570, -0.0752), deep);
    for (mi = 1; mi < 8; mi++) {
      var mf = magFrames[mi];
      A('mag', 'polymer', bx(0.0272, 0.0060, 0.0300, 0.0012, 2),
        new THREE.Matrix4().compose(mf.p, mf.q, new THREE.Vector3(1, 1, 1))
          .multiply(mat4(0, 0, 0, HALF_PI, 0, 0)), { wear: 0.5, ao: 0.08, tol: 0.0013 });
      // witness holes down the right-hand face
      if (mi > 1 && mi < 8) {
        A('mag', 'inner', cylZ(0.0032, 0.0032, 0.0060, 8),
          new THREE.Matrix4().compose(mf.p, mf.q, new THREE.Vector3(1, 1, 1))
            .multiply(mat4(0.0122, 0.0140, 0.0090, 0, HALF_PI, 0)), deep);
      }
    }
    var mlast = magFrames[8];
    A('mag', 'polymer', bx(0.0300, 0.0170, 0.0640, 0.0035, 2),
      new THREE.Matrix4().compose(mlast.p, mlast.q, new THREE.Vector3(1, 1, 1))
        .multiply(mat4(0, 0, 0.0075, HALF_PI, 0, 0)), { wear: 0.6, ao: 0.16, tol: 0.0016 });
    A('mag', 'polymer', bx(0.0330, 0.0070, 0.0700, 0.0025, 2),
      new THREE.Matrix4().compose(mlast.p, mlast.q, new THREE.Vector3(1, 1, 1))
        .multiply(mat4(0, 0, 0.0180, HALF_PI, 0, 0)), { wear: 0.8, ao: 0.20, tol: 0.0016 });

    // ---- gloved hands -----------------------------------------------------
    var gripAxis = gripDir.clone();
    gripHand(MB.groups.rhand.b, 'glove', 'skin', {
      origin: gripTop.clone().add(gripAxis.clone().multiplyScalar(0.0195)),
      axis: gripAxis,
      front: new THREE.Vector3(0.42, 0, -0.91),
      radius: 0.0192, sense: -1, startAngle: 0, spacing: 0.0202,
      palmArc: -2.15, tight: 1.12, noThumb: true, skipIndex: true,
      triggerTarget: new THREE.Vector3(0.0030, -0.0640, -0.0090),
      armDir: new THREE.Vector3(0.30, -0.52, 0.80), elbowOut: 0.40
    });
    // right thumb rides high along the LEFT side of the receiver - the pose
    // real shooters use, and the only part of the firing hand the camera sees.
    var tz = new THREE.Vector3(-0.42, 0.22, -0.88).normalize();
    var tx = new THREE.Vector3(0, 1, 0).cross(tz).normalize();
    var ty = new THREE.Vector3().crossVectors(tz, tx).normalize();
    fingerChain(MB.groups.rhand.b, 'glove',
      basisMat(tx, ty, tz, new THREE.Vector3(0.0125, -0.0530, 0.0130)),
      [0.0310, 0.0265, 0.0210], [0.0118, 0.0104, 0.0092], [0.16, 0.30, 0.26],
      { wear: 0.16, ao: 0.12, mode: 'flat' });

    gripHand(MB.groups.lhand.b, 'glove', 'skin', {
      origin: new THREE.Vector3(0, -0.0430, -0.3550),
      axis: new THREE.Vector3(0, -1, 0),
      front: new THREE.Vector3(-0.40, 0, -0.92),
      radius: 0.0172, sense: 1, startAngle: 0, spacing: 0.0198,
      palmArc: -2.05, tight: 1.16, thumbArc: 1.20, thumbCurl: 0.55, thumbUp: 0.18,
      armDir: new THREE.Vector3(-0.34, -0.50, 0.80), elbowOut: 0.40
    });

    // ---- named nodes the system reads every frame ------------------------
    // Sit the flash origin ON the crown face (the birdcage front ring ends at
    // z = -0.62555) so vfx.muzzleFlash and the flash point light erupt from the
    // device and light its tines, not from a point floating past the end of it.
    MB.muzzle = new THREE.Object3D(); MB.muzzle.position.set(0, 0, -0.6258);
    MB.eject = new THREE.Object3D(); MB.eject.position.set(0.0230, 0.0000, -0.0470);
    MB.root.add(MB.muzzle, MB.eject);

    return MB;
  }

  // ==========================================================================
  // 8. Striker-fired sidearm
  // Bore axis is the Z line at y = 0.012. Sight plane sits 0.018 above it, so
  // ADS aligns the rear notch and the front post on the camera axis exactly.
  // ==========================================================================

  function buildPistol(MB) {
    var G = 'body';
    MB.group(G); MB.group('slide'); MB.group('trigger'); MB.group('mag');
    MB.group('lhand'); MB.group('rhand');
    var A = function (g, k, geo, m, o) { MB.add(g, k, geo, m, o); };
    var metal = { wear: 0.5, ao: 0.07 };
    var metalEdge = { wear: 0.92, ao: 0.03, tol: 0.0013 };
    var poly = { wear: 0.26, ao: 0.12 };
    var deep = { wear: 0, ao: 0.75, mode: 'none' };
    var by = 0.0120, i;

    // ---- slide ------------------------------------------------------------
    A('slide', 'metal', bx(0.0262, 0.0330, 0.1730, 0.0022, 2), mat4(0, by + 0.0022, -0.0680), metal);
    A('slide', 'metal', bx(0.0224, 0.0110, 0.1740, 0.0018, 2), mat4(0, by + 0.0205, -0.0670, 0, 0, 0), metalEdge);
    // top flat with a slight bevel each side, then the nose taper
    A('slide', 'metal', bx(0.0248, 0.0160, 0.0300, 0.0030, 2), mat4(0, by + 0.0030, -0.1470, 0, 0, 0), metalEdge);
    // cocking serrations, front and rear
    for (i = 0; i < 7; i++) {
      A('slide', 'metal', bx(0.0284, 0.0230, 0.0034, 0.0007, 2), mat4(0, by + 0.0020, 0.0110 - i * 0.0072, 0, 0, 0), metalEdge);
    }
    for (i = 0; i < 4; i++) {
      A('slide', 'metal', bx(0.0284, 0.0210, 0.0032, 0.0007, 2), mat4(0, by + 0.0020, -0.1180 - i * 0.0070, 0, 0, 0), metalEdge);
    }
    // ejection port + extractor (right side)
    A('slide', 'inner', bx(0.0060, 0.0170, 0.0420, 0.0008, 2), mat4(0.0110, by + 0.0110, -0.0330), deep);
    A('slide', 'metal', bx(0.0055, 0.0075, 0.0230, 0.0010, 2), mat4(0.0136, by + 0.0100, -0.0130), metalEdge);
    // barrel hood visible in the port, plus the crown at the muzzle
    A('slide', 'metalDark', cylZ(0.0092, 0.0092, 0.1500, 24), mat4(0, by, -0.0800), { wear: 0.3, ao: 0.2, mode: 'flat' });
    A('slide', 'metal', cylZ(0.0098, 0.0098, 0.0110, 24), mat4(0, by, -0.1540), metalEdge);
    A('slide', 'inner', cylZ(0.0052, 0.0052, 0.0400, 14), mat4(0, by, -0.1450), deep);
    A('slide', 'metalDark', cylZ(0.0060, 0.0060, 0.0300, 12), mat4(0, by - 0.0135, -0.1420), { wear: 0.3, ao: 0.3, mode: 'flat' });
    // sights: rear notch blades + front post, tops coplanar at y = 0.0300
    A('slide', 'metalDark', bx(0.0230, 0.0092, 0.0075, 0.0010, 2), mat4(0, 0.0256, 0.0130), metalEdge);
    A('slide', 'inner', bx(0.0044, 0.0068, 0.0090, 0.0006, 2), mat4(0, 0.0272, 0.0130), deep);
    A('slide', 'metalDark', bx(0.0034, 0.0088, 0.0060, 0.0008, 2), mat4(0, 0.0254, -0.1480), metalEdge);
    A('slide', 'reticle', new THREE.PlaneGeometry(0.0030, 0.0030), mat4(0, 0.0268, -0.1447), { wear: 0, ao: 0, mode: 'none', keepUV: true });

    // ---- frame ------------------------------------------------------------
    A(G, 'polymer', bx(0.0268, 0.0190, 0.1500, 0.0025, 2), mat4(0, -0.0075, -0.0760), poly);
    A(G, 'polymer', bx(0.0300, 0.0130, 0.0420, 0.0030, 2), mat4(0, -0.0020, 0.0140), poly);
    // accessory rail underneath
    A(G, 'polymer', bx(0.0210, 0.0090, 0.0540, 0.0018, 2), mat4(0, -0.0195, -0.1080), poly);
    for (i = 0; i < 3; i++) {
      A(G, 'polymer', bx(0.0230, 0.0060, 0.0050, 0.0010, 2), mat4(0, -0.0215, -0.0900 - i * 0.0140), metalEdge);
    }
    // beavertail, slide stop, takedown lever, magazine release
    A(G, 'polymer', bx(0.0230, 0.0110, 0.0260, 0.0040, 2), mat4(0, 0.0010, 0.0300, 0.22, 0, 0), poly);
    A(G, 'metal', bx(0.0055, 0.0080, 0.0330, 0.0012, 2), mat4(-0.0150, -0.0020, -0.0250), metalEdge);
    A(G, 'metal', bx(0.0060, 0.0120, 0.0090, 0.0014, 2), mat4(-0.0152, -0.0060, -0.0090), metalEdge);
    A(G, 'metal', new THREE.CylinderGeometry(0.0052, 0.0052, 0.0290, 12).rotateZ(HALF_PI), mat4(0, -0.0110, -0.0410), metalEdge);
    A(G, 'metal', bx(0.0075, 0.0110, 0.0110, 0.0016, 2), mat4(0.0158, -0.0040, 0.0060), metalEdge);

    // ---- trigger guard + trigger -----------------------------------------
    var zAx = new THREE.Vector3(0, 0, -1), yAx = new THREE.Vector3(0, 1, 0), xAx = new THREE.Vector3(1, 0, 0);
    loopPart(MB, G, 'polymer', 0.0620, 0.0450, 0.0150, 0.0460, 0.0310, 0.0120, 0.0020, 0.0250,
      new THREE.Vector3(0, -0.0310, -0.0300), zAx, yAx, xAx, { wear: 0.7, ao: 0.12, tol: 0.0016 });
    MB.groups.trigger.obj.position.set(0, -0.0105, -0.0215);
    var tri = new THREE.Shape();
    tri.moveTo(-0.0038, 0); tri.lineTo(0.0048, 0);
    tri.lineTo(0.0050, -0.0130); tri.lineTo(0.0016, -0.0180);
    tri.lineTo(-0.0028, -0.0170); tri.lineTo(-0.0040, -0.0090);
    tri.closePath();
    A('trigger', 'polymer', extrude(tri, 0.0068, 0.0006, 5),
      basisMat(zAx, yAx, xAx, new THREE.Vector3(0, 0, 0)), { wear: 0.6, ao: 0.18, tol: 0.0012 });
    A('trigger', 'polymer', bx(0.0022, 0.0130, 0.0034, 0.0004, 2), mat4(0, -0.0090, 0.0010), metalEdge);

    // ---- grip -------------------------------------------------------------
    var gDir = new THREE.Vector3(0, -1, 0.34).normalize();
    var gQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), gDir);
    var gTop = new THREE.Vector3(0, -0.0060, 0.0080);
    var gProf = rrProfile(0.0300, 0.0480, 0.0115, 6);
    var gf = [], gsx = [0.94, 1.00, 1.03, 1.02, 0.99, 1.00, 1.10], gsy = [1.12, 1.02, 0.97, 0.95, 0.95, 0.98, 1.04];
    for (i = 0; i < 7; i++) {
      gf.push({ p: gTop.clone().add(gDir.clone().multiplyScalar((i / 6) * 0.1080)), q: gQ, sx: gsx[i], sy: gsy[i] });
    }
    A(G, 'polymer', loft(gProf, gf, true, true), null, { wear: 0.22, ao: 0.14, mode: 'flat' });
    // stipple panels + finger swells
    for (i = 0; i < 4; i++) {
      A(G, 'rubber', new THREE.TorusGeometry(0.0136, 0.0022, 6, 14).rotateX(HALF_PI),
        basisMat(new THREE.Vector3(1, 0, 0),
          new THREE.Vector3().crossVectors(gDir, new THREE.Vector3(1, 0, 0)).normalize(), gDir,
          gTop.clone().add(gDir.clone().multiplyScalar(0.026 + i * 0.020))),
        { wear: 0.3, ao: 0.2, mode: 'flat' });
    }

    // ---- magazine (floorplate proud of the grip) -------------------------
    MB.groups.mag.obj.position.set(0, 0, 0);
    var mprof = rrProfile(0.0195, 0.0330, 0.0050, 5);
    var mf = [];
    for (i = 0; i < 4; i++) {
      mf.push({ p: gTop.clone().add(gDir.clone().multiplyScalar(0.010 + (i / 3) * 0.1080)), q: gQ, sx: 1, sy: 1 });
    }
    A('mag', 'metalDark', loft(mprof, mf, false, true), null, { wear: 0.5, ao: 0.2, mode: 'flat' });
    A('mag', 'polymer', bx(0.0300, 0.0130, 0.0440, 0.0030, 2),
      mat4(gTop.x + gDir.x * 0.1180, gTop.y + gDir.y * 0.1180, gTop.z + gDir.z * 0.1180,
        Math.atan2(gDir.z, -gDir.y), 0, 0), { wear: 0.7, ao: 0.2, tol: 0.0016 });

    // ---- hands: firing hand plus a wrapped support hand ------------------
    gripHand(MB.groups.rhand.b, 'glove', 'skin', {
      origin: gTop.clone().add(gDir.clone().multiplyScalar(0.0180)),
      axis: gDir, front: new THREE.Vector3(0.40, 0, -0.92),
      radius: 0.0215, sense: -1, startAngle: 0, spacing: 0.0200,
      palmArc: -2.15, tight: 1.00, skipIndex: true, noThumb: true,
      triggerTarget: new THREE.Vector3(0.0020, -0.0250, -0.0240),
      armDir: new THREE.Vector3(0.20, -0.46, 0.86)
    });
    var ptz = new THREE.Vector3(-0.30, 0.30, -0.90).normalize();
    var ptx = new THREE.Vector3(0, 1, 0).cross(ptz).normalize();
    var pty = new THREE.Vector3().crossVectors(ptz, ptx).normalize();
    fingerChain(MB.groups.rhand.b, 'glove',
      basisMat(ptx, pty, ptz, new THREE.Vector3(0.0130, -0.0160, 0.0150)),
      [0.0300, 0.0258, 0.0205], [0.0116, 0.0102, 0.0090], [0.18, 0.26, 0.22],
      { wear: 0.16, ao: 0.12, mode: 'flat' });
    // support hand cups over the firing hand at a larger radius
    gripHand(MB.groups.lhand.b, 'glove', 'skin', {
      origin: gTop.clone().add(gDir.clone().multiplyScalar(0.0330)).add(new THREE.Vector3(-0.006, 0, 0)),
      axis: gDir, front: new THREE.Vector3(0.05, 0, -0.99),
      radius: 0.0320, sense: -1, startAngle: 0.30, spacing: 0.0198,
      palmArc: -2.55, tight: 1.02, thumbArc: 1.35, thumbCurl: 0.10,
      armDir: new THREE.Vector3(-0.42, -0.44, 0.79)
    });

    MB.muzzle = new THREE.Object3D(); MB.muzzle.position.set(0, by, -0.1600);
    MB.eject = new THREE.Object3D(); MB.eject.position.set(0.0160, by + 0.0110, -0.0250);
    MB.root.add(MB.muzzle, MB.eject);
    return MB;
  }

  // ==========================================================================
  // 9. Weapon data
  // ==========================================================================

  function weaponDefs() {
    return [
      {
        id: 'carbine', name: 'M4A1', kind: 'rifle', build: buildCarbine,
        auto: true, magSize: 30, ammo: 30, reserve: 210, rpm: 800,
        damage: 33, headMultiplier: 2.3, limbMultiplier: 0.85,
        range: 140, falloffStart: 30, penetration: 0.6, muzzleVelocity: 890,
        tracerEvery: 3, shellKind: 'rifle',
        // viewmodel poses (metres / radians, relative to the view camera)
        // Hip: the muzzle yaws inward and the weapon rolls, so the receiver
        // reads in perspective instead of broadside. At 3 deg of yaw the eye
        // was almost square to the receiver's left flank and the whole rifle
        // showed in near-elevation - a display stand, not a shouldered weapon.
        // Hipfire framing: the optic used to land at ~75% frame width with the
        // eye almost square to the receiver's flank, so it pulled the eye off
        // the crosshair and out to the right edge. Brought inboard and yawed
        // further in, the receiver reads in stronger perspective and the optic
        // sits nearer two-thirds width.
        hipPos: new THREE.Vector3(0.1015, -0.1050, -0.2150),
        hipRot: new THREE.Vector3(-0.0300, 0.1600, -0.1600),
        // adsPos.z sets the eye relief: optic centre is at local z = -0.0750,
        // so -0.1050 puts the eye 180mm behind it. See the optic block in
        // buildCarbine - that number is half of the sight-picture geometry.
        adsPos: new THREE.Vector3(0.0000, -0.0632, -0.1050),
        adsRot: new THREE.Vector3(0, 0, 0),
        sprintPos: new THREE.Vector3(0.0520, -0.0620, 0.0520),
        sprintRot: new THREE.Vector3(-0.3800, 0.5500, -0.5200),
        // showcase: pulled back onto a longer lens so the whole weapon fits
        // in frame with mild perspective instead of the stock ballooning
        inspectPos: new THREE.Vector3(-0.1940, 0.0700, -0.9750),
        inspectRot: new THREE.Vector3(-0.1000, -1.1500, 0.2000),
        lowerPos: new THREE.Vector3(0.0400, -0.2600, 0.0500),
        lowerRot: new THREE.Vector3(-0.7000, 0.4500, 0.3000),
        reloadPos: new THREE.Vector3(-0.0250, -0.0620, 0.0300),
        reloadRot: new THREE.Vector3(0.1400, 0.4200, -0.2600),
        adsTime: 0.22, adsFov: 42, hipFov: 60, inspectFov: 32, adsZoom: 0.80,
        // the magazine leaves along its own well axis, not straight down
        magDrop: new THREE.Vector3(0, -1, 0.08).normalize(), magTravel: 0.195,
        recoil: {
          kickBack: 0.0270, kickUp: 0.0130, pitch: 0.0500, yaw: 0.0200, roll: 0.0450,
          camPitch: 0.0122, camYaw: 0.0044, recover: 0.72, shake: 0.45
        },
        bloom: { perShot: 0.00230, max: 0.0300, decay: 3.0 },
        spread: { base: 0.00080, hip: 0.01750, move: 0.01450, air: 0.02800, crouch: 0.65 },
        reload: { tactical: 2.10, empty: 2.90 },
        drawTime: 0.52, holsterTime: 0.28
      },
      {
        id: 'sidearm', name: 'M9-X', kind: 'pistol', build: buildPistol,
        auto: false, magSize: 17, ammo: 17, reserve: 68, rpm: 430,
        damage: 26, headMultiplier: 2.0, limbMultiplier: 0.9,
        range: 60, falloffStart: 14, penetration: 0.3, muzzleVelocity: 380,
        tracerEvery: 4, shellKind: 'pistol',
        hipPos: new THREE.Vector3(0.0880, -0.1020, -0.2500),
        hipRot: new THREE.Vector3(-0.0350, 0.0700, -0.0500),
        adsPos: new THREE.Vector3(0.0000, -0.0300, -0.3120),
        adsRot: new THREE.Vector3(0, 0, 0),
        sprintPos: new THREE.Vector3(0.0480, -0.0620, 0.0400),
        sprintRot: new THREE.Vector3(-0.4200, 0.4600, -0.5000),
        inspectPos: new THREE.Vector3(-0.0420, 0.0300, -0.5000),
        inspectRot: new THREE.Vector3(-0.1200, -1.1500, 0.2400),
        lowerPos: new THREE.Vector3(0.0400, -0.2400, 0.0500),
        lowerRot: new THREE.Vector3(-0.7500, 0.5000, 0.3000),
        reloadPos: new THREE.Vector3(-0.0200, -0.0520, 0.0260),
        reloadRot: new THREE.Vector3(0.1600, 0.4600, -0.3000),
        adsTime: 0.18, adsFov: 46, hipFov: 60, inspectFov: 32, adsZoom: 0.88,
        magDrop: new THREE.Vector3(0, -0.95, 0.31).normalize(), magTravel: 0.150,
        recoil: {
          kickBack: 0.0220, kickUp: 0.0150, pitch: 0.0720, yaw: 0.0180, roll: 0.0300,
          camPitch: 0.0165, camYaw: 0.0038, recover: 0.80, shake: 0.30
        },
        bloom: { perShot: 0.00320, max: 0.0340, decay: 3.6 },
        spread: { base: 0.00110, hip: 0.01900, move: 0.01550, air: 0.03000, crouch: 0.65 },
        reload: { tactical: 1.72, empty: 2.36 },
        drawTime: 0.42, holsterTime: 0.24
      }
    ];
  }

  // A designed recoil pattern: hard vertical climb that plateaus, horizontal
  // drift that stays predictable for the first third of the magazine and then
  // walks. Generated from the seeded RNG so captures stay reproducible.
  function buildRecoilPattern(def, rng) {
    var n = def.magSize + 2, out = new Array(n);
    var phase = rng.range(0, M.TAU);
    var dir = rng.bool() ? 1 : -1;
    for (var i = 0; i < n; i++) {
      var t = i / (n - 1);
      // vertical: strong first four shots, then a decaying plateau
      var v = (0.62 + 0.60 * Math.exp(-i * 0.55)) * (1 - 0.28 * M.smoothstep(0.35, 1, t));
      // horizontal: quiet start, then a wandering walk of growing amplitude
      var ramp = M.smoothstep(0.16, 0.62, t);
      var h = dir * (Math.sin(phase + i * 0.62) * 0.55 + Math.sin(phase * 1.7 + i * 0.23) * 0.45) * ramp;
      h += rng.gaussian(0, 0.22) * ramp;
      out[i] = { v: v, h: h };
    }
    return out;
  }

  // ==========================================================================
  // 10. Materials
  // ==========================================================================

  // Injects the baked (wear, occlusion) attribute into a standard material.
  // Wear reveals bare aluminium: lighter, smoother, fully metallic.
  function applyWearShader(m, o) {
    var uni = {
      uBareColor: { value: o.bare },
      uBareRough: { value: o.bareRough },
      uBareMetal: { value: o.bareMetal },
      uWear: { value: o.wear },
      uAO: { value: o.ao },
      uWearMask: { value: o.mask || null },
      uWearRep: { value: o.maskRep === undefined ? 42.0 : o.maskRep }
    };
    m.userData.wearUniforms = uni;
    m.onBeforeCompile = function (shader) {
      try {
        shader.uniforms.uBareColor = uni.uBareColor;
        shader.uniforms.uBareRough = uni.uBareRough;
        shader.uniforms.uBareMetal = uni.uBareMetal;
        shader.uniforms.uWear = uni.uWear;
        shader.uniforms.uAO = uni.uAO;
        shader.uniforms.uWearMask = uni.uWearMask;
        shader.uniforms.uWearRep = uni.uWearRep;
        // `uv` is always declared in three's vertex prefix, and Builder.add
        // bakes world-space metres into it - so vWearUv is a stable, seamless
        // parameterisation for a per-pixel mask across every merged part.
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>',
            '#include <common>\nattribute vec2 aDetail;\nvarying vec2 vDetail;\nvarying vec2 vWearUv;')
          .replace('#include <begin_vertex>',
            '#include <begin_vertex>\n\tvDetail = aDetail;\n\tvWearUv = uv;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>',
            '#include <common>\nvarying vec2 vDetail;\nvarying vec2 vWearUv;\nuniform vec3 uBareColor;\n' +
            'uniform float uBareRough;\nuniform float uBareMetal;\nuniform float uWear;\nuniform float uAO;\n' +
            'uniform sampler2D uWearMask;\nuniform float uWearRep;\nfloat wearF;')
          .replace('#include <color_fragment>',
            '#include <color_fragment>\n' +
            '\tfloat wearMask = texture2D(uWearMask, vWearUv * uWearRep).r;\n' +
            // Speckle, not a ramp: the vertex ramp only says "wear is ALLOWED
            // here", the mask decides which square millimetres actually rubbed.
            // The vertex term goes through a smoothstep rather than being used
            // as an amplitude - multiplying by it directly meant even a true
            // corner only reached 0.30 and no pixel on the weapon ever became
            // bare metal. Now an allowed corner rubs ALL the way through and
            // the mask is what keeps it to a few per cent of the surface.
            '\twearF = smoothstep(0.045, 0.205, vDetail.x * uWear) * smoothstep(0.355, 0.575, wearMask);\n' +
            '\tdiffuseColor.rgb = mix(diffuseColor.rgb, uBareColor, wearF);\n' +
            '\tdiffuseColor.rgb *= (1.0 - clamp(vDetail.y, 0.0, 1.0) * uAO);')
          .replace('#include <roughnessmap_fragment>',
            '#include <roughnessmap_fragment>\n\troughnessFactor = mix(roughnessFactor, uBareRough, wearF);')
          .replace('#include <metalnessmap_fragment>',
            '#include <metalnessmap_fragment>\n\tmetalnessFactor = mix(metalnessFactor, uBareMetal, wearF);');
      } catch (e) { GAME.logError('weapons.wearShader', e); }
    };
    // one shared program for every material that uses this injection
    m.customProgramCacheKey = function () { return 'blackout-weapon-wear2'; };
    return m;
  }

  // ==========================================================================
  // 11. WeaponSystem
  // ==========================================================================

  function WeaponSystem(ctx) {
    this.ctx = ctx || {};
    // fork() reads the seed without advancing ctx.rng, so later systems still
    // see the stream they would have seen without us.
    this.rng = (this.ctx.rng && this.ctx.rng.fork) ? this.ctx.rng.fork(0x57415) : new GAME.RNG(0x57415);
    this.noise = new GAME.Noise(0x9a2b57);

    this.rig = new THREE.Object3D();
    this.rig.name = 'weaponRig';
    this.weapons = [];
    this.models = [];
    this.current = null;
    this.index = 0;
    this.pendingIndex = -1;

    this.time = 0;
    this.state = 'idle';          // idle | reload | switch
    this.stateT = 0;
    this.nextFireTime = 0;
    this.shotIndex = 0;
    this.triggerHeld = false;
    this.triggerLatch = false;
    this.forceADS = false;
    this.inspecting = false;
    this.inspectT = 0;
    this.reloadEmpty = false;
    this.reloadDur = 0;
    this.reloadDone = false;
    this.boltLocked = false;
    this.triangles = 0;

    // animation state -------------------------------------------------------
    this.adsT = 0; this.adsEase = 0;
    this.sprintT = 0;
    this.lowerT = 0;
    this.bobPhase = 0;
    this.swayTarget = new THREE.Vector3();
    this.sway = new Spring3();
    this.swayRotTarget = new THREE.Vector3();
    this.swayRot = new Spring3();
    this.kick = new Spring3();          // positional recoil
    this.kickRot = new Spring3();       // rotational recoil
    this.land = new Spring();
    this.lastYaw = null; this.lastPitch = null;
    this.bloom = 0;
    this.recoilKick = { p: 0, y: 0 };
    this.recoilRecover = { p: 0, y: 0 };
    this.recoilApplied = { p: 0, y: 0 };
    this.recoilSmooth = { p: new Spring(), y: new Spring() };
    this.sinceFire = 99;
    this.boltT = 0; this.coverOpen = 0; this.triggerPull = 0; this.chargeT = 0;
    this.magOffset = new THREE.Vector3();
    this.dropped = [];
    this._pos = new THREE.Vector3();
    this._rot = new THREE.Vector3();
    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
    this._captureFire = null;
    this._envK = 1;
    this.viewEnv = null;
  }

  // ---- procedural surface set ---------------------------------------------
  WeaponSystem.prototype._makeTextures = function () {
    var n = this.noise, S = TEX_SIZE, TAU = M.TAU;
    var i, x, y, u, v;
    var h = new Float32Array(S * S);

    // anodised aluminium: bead-blast grain + machining lines + micro pits
    for (y = 0; y < S; y++) {
      for (x = 0; x < S; x++) {
        u = x / S; v = y / S;
        var fb = n.fbm2(u * 48, v * 48, 4);
        var lines = Math.sin(v * TAU * 64 + fb * 1.6) * 0.10;
        var w = n.worley2(u * 20, v * 20, 1.0);
        var pit = Math.max(0, 0.16 - w.f1) * 2.4;
        h[y * S + x] = fb * 0.45 + lines - pit * 0.55;
      }
    }
    this.texMetalN = normalFromHeight(h, S, 1.7);
    this.texMetalR = grayTexture(function (uu, vv) {
      var a = n.fbm2(uu * 12, vv * 12, 3) * 0.5 + 0.5;
      var b = n.fbm2(uu * 60, vv * 60, 2) * 0.5 + 0.5;
      return 0.62 + a * 0.30 + b * 0.12;
    }, S);

    // polymer: injection-moulded pebble stipple
    for (y = 0; y < S; y++) {
      for (x = 0; x < S; x++) {
        u = x / S; v = y / S;
        var wp = n.worley2(u * 40, v * 40, 1.0);
        h[y * S + x] = (1 - Math.min(1, wp.f1 * 2.6)) * 0.85 + n.fbm2(u * 96, v * 96, 3) * 0.18;
      }
    }
    this.texPolyN = normalFromHeight(h, S, 2.1);
    this.texPolyR = grayTexture(function (uu, vv) {
      var wp = n.worley2(uu * 40, vv * 40, 1.0);
      return 0.66 + (1 - Math.min(1, wp.f1 * 2.6)) * 0.26 + n.fbm2(uu * 24, vv * 24, 2) * 0.08;
    }, S);

    // tactical glove: knit weave + reinforcement panel stitching
    for (y = 0; y < S; y++) {
      for (x = 0; x < S; x++) {
        u = x / S; v = y / S;
        var weave = Math.sin(u * TAU * 52) * Math.sin(v * TAU * 52) * 0.34;
        var fine = n.fbm2(u * 110, v * 110, 3) * 0.34;
        var stitch = Math.max(0, 1 - Math.abs(((v * 6) % 1) - 0.5) * 7) * 0.30;
        h[y * S + x] = weave + fine + stitch;
      }
    }
    this.texGloveN = normalFromHeight(h, S, 1.5);
    // The glove map is a MODULATION BAND, not the albedo. Carrying the whole
    // value in the map means one wrong colour space, one wrong mip, or one
    // failed bind puts a white material on screen - which is exactly what the
    // firing hand did (mean 0.425 against a 0.057 weapon body). The base value
    // now lives in lib.glove.color, and this only says "this square millimetre
    // of fabric is a little darker / lighter than the rest".
    this.texGloveM = colorTexture(function (uu, vv, c) {
      var g = 0.900 + (n.fbm2(uu * 26, vv * 26, 3) * 0.5 + 0.5) * 0.100;
      var wv = (Math.sin(uu * TAU * 52) * Math.sin(vv * TAU * 52) * 0.5 + 0.5) * 0.070;
      c.r = g - wv * 1.00; c.g = g - wv * 0.97; c.b = g - wv * 0.92;
    }, S);
    // Knit fabric has no gloss. The old 0.70 floor multiplied against a 0.98
    // material roughness landed near 0.69, which is glossy enough for the key
    // light to put a broad dielectric highlight across the whole back of the
    // hand - the single biggest reason the gloves read bright.
    this.texGloveR = grayTexture(function (uu, vv) {
      return 0.90 + (n.fbm2(uu * 30, vv * 30, 3) * 0.5 + 0.5) * 0.10;
    }, S);

    // Wear mask. aDetail.x is a per-VERTEX ramp, and on a subdivided bevelBox
    // that ramp covers whole faces - which is precisely how a matte black rifle
    // ends up painted in bare aluminium. This mask breaks the ramp into
    // speckle at pixel resolution: worley cells thresholded so only the
    // high-frequency islands survive. NoColorSpace - it is data, not colour.
    for (y = 0; y < S; y++) {
      for (x = 0; x < S; x++) {
        u = x / S; v = y / S;
        var wa = n.worley2(u * 8, v * 8, 1.0);
        var wb = n.worley2(u * 19 + 7, v * 19 + 3, 1.0);
        // f1 low = cell centre. Two scales so the rub marks come in clumps of
        // small marks rather than one uniform grain.
        h[y * S + x] = (1 - Math.min(1, wa.f1 * 1.55)) * 0.62
          + (1 - Math.min(1, wb.f1 * 1.9)) * 0.48
          + (n.fbm2(u * 44, v * 44, 3) * 0.5 + 0.5) * 0.26;
      }
    }
    // Normalise against the field's own distribution so the shader's fixed
    // smoothstep(0.60, 0.74) threshold picks a KNOWN fraction of the surface.
    // Without this the mask's absolute range is an accident of the noise and
    // the wear either vanishes entirely or covers everything.
    var sorted = [];
    for (i = 0; i < S * S; i += 7) sorted.push(h[i]);
    sorted.sort(function (a, b) { return a - b; });
    var pRef = sorted[Math.floor(sorted.length * 0.80)] || 1;
    var pLo = sorted[Math.floor(sorted.length * 0.05)] || 0;
    var span = Math.max(1e-4, pRef - pLo);
    for (i = 0; i < S * S; i++) h[i] = M.saturate((h[i] - pLo) / span * 0.70);
    this.texWear = grayTexture(function (uu, vv, xx, yy) {
      return h[yy * S + xx];
    }, S);

    // reticle: 2-MOA dot with a soft bloom skirt
    var D = 64, dot = new Uint8Array(D * D * 4);
    for (y = 0; y < D; y++) {
      for (x = 0; x < D; x++) {
        var dx = (x + 0.5) / D - 0.5, dy = (y + 0.5) / D - 0.5;
        var r = Math.sqrt(dx * dx + dy * dy) * 2;
        // Tight core + a small skirt, sized in TEXTURE space against the plane
        // it lands on. An exponent of 300 puts the core's 1/e radius at 0.058
        // of the half-plane, which at the sizes buildCarbine uses is a third of
        // a pixel - the dot then vanishes into the supersample resolve. These
        // give a ~3px core and a ~9px skirt at 720p.
        var a = Math.exp(-r * r * 26) + Math.exp(-r * r * 3.2) * 0.10;
        i = (y * D + x) * 4;
        dot[i] = dot[i + 1] = dot[i + 2] = 255;
        dot[i + 3] = M.saturate(a) * 255;
      }
    }
    this.texDot = finishTex(new THREE.DataTexture(dot, D, D, THREE.RGBAFormat), true);
    this.texDot.wrapS = this.texDot.wrapT = THREE.ClampToEdgeWrapping;

    // Hue-lock core. A gaussian sprite is only fully opaque at its exact
    // centre, so an additive glow underneath leaks through everywhere else and
    // an already-bright background (blown sky through the aperture) drags the
    // dot to salmon. This is a SOLID disc with a soft rim: alpha 1 out to 45%
    // of the half-plane, so a normal-blended quad using it genuinely replaces
    // the background and the hue is whatever we author, full stop.
    var core = new Uint8Array(D * D * 4);
    for (y = 0; y < D; y++) {
      for (x = 0; x < D; x++) {
        var cx2 = (x + 0.5) / D - 0.5, cy2 = (y + 0.5) / D - 0.5;
        var cr = Math.sqrt(cx2 * cx2 + cy2 * cy2) * 2;
        i = (y * D + x) * 4;
        core[i] = core[i + 1] = core[i + 2] = 255;
        core[i + 3] = M.saturate(1 - M.smoothstep(0.44, 0.94, cr)) * 255;
      }
    }
    this.texDotCore = finishTex(new THREE.DataTexture(core, D, D, THREE.RGBAFormat), true);
    this.texDotCore.wrapS = this.texDotCore.wrapT = THREE.ClampToEdgeWrapping;

    // soft radial glow - the AR-coating flare, and anything else that needs a
    // falloff rather than the reticle's hard core
    var Gs = 32, glow = new Uint8Array(Gs * Gs * 4);
    for (y = 0; y < Gs; y++) {
      for (x = 0; x < Gs; x++) {
        var gx = (x + 0.5) / Gs - 0.5, gy = (y + 0.5) / Gs - 0.5;
        var gr = Math.min(1, Math.sqrt(gx * gx + gy * gy) * 2);
        i = (y * Gs + x) * 4;
        glow[i] = glow[i + 1] = glow[i + 2] = 255;
        glow[i + 3] = M.saturate(Math.pow(1 - gr, 2.2)) * 255;
      }
    }
    this.texGlow = finishTex(new THREE.DataTexture(glow, Gs, Gs, THREE.RGBAFormat), true);
    this.texGlow.wrapS = this.texGlow.wrapT = THREE.ClampToEdgeWrapping;
  };

  // The material library contract only covers environment surfaces, so we only
  // take one from it when it explicitly advertises a weapon name.
  WeaponSystem.prototype._libMaterial = function (name) {
    var lib = this.ctx.materials;
    if (!lib || typeof lib.get !== 'function') return null;
    var known = (typeof lib.has === 'function') ? !!lib.has(name)
      : (lib.names && lib.names.indexOf ? lib.names.indexOf(name) >= 0 : false);
    if (!known) return null;
    try { var m = lib.get(name); return (m && m.isMaterial) ? m : null; }
    catch (e) { GAME.logError('weapons.libMaterial', e); return null; }
  };

  // Specular IBL is what actually decides whether a black rifle 8cm from the
  // lens reads as anodised aluminium or as polished chrome: against a bright
  // HDR sky the split-sum grazing term alone lifts a 0.03-albedo metal to near
  // white. Measured against this build, using scene.environment directly put
  // the weapon BRIGHTER than sunlit plaster - physically impossible, and the
  // loudest possible "this is CG" tell.
  //
  // So the viewmodel gets its own small, art-directed environment instead of
  // borrowing the world's. Radiance is authored in the same physical units the
  // sun uses, which makes envMapIntensity mean something and makes the weapon's
  // look independent of how sky.js chooses to scale its PMREM.
  var SKY_REF = 5.2;   // reference sun intensity the env below is authored for
  // How hard the viewmodel key light drives relative to the world sun. The gun
  // is a matte black object: it has to sit well under the sunlit plaster it is
  // photographed against, and this is the single biggest lever on that.
  var KEY_MUL = 0.60;

  WeaponSystem.prototype._makeViewEnv = function () {
    var ctx = this.ctx;
    if (!ctx.renderer || typeof THREE.PMREMGenerator !== 'function') return null;
    var W = 64, H = 32;
    var data = new Float32Array(W * H * 4);
    // Rotationally symmetric on purpose - the sun highlight comes from the
    // directional key light, so the env never needs to be re-oriented as the
    // player turns and can never swing a hotspot across the gun.
    // Real radiance, real CONTRAST. The previous authoring (zenith 0.48,
    // ground 0.20) was only 2.4:1 top to bottom, and a flat environment is the
    // reason a cylinder like the barrel measured a 0.02 luminance range across
    // its whole diameter: every reflection direction returned the same number,
    // so there was no specular band anywhere on the weapon.
    //
    // Raising the absolute level alone would be a no-op - PMREM is linear and
    // the per-material envMapIntensity would just be divided back out. What
    // matters is the RATIO, which is now ~11:1 zenith to ground with a warm
    // horizon band, so a curved part sweeps a genuine bright-to-dark gradient
    // and edge wear has something bright to pick up. ENV_W (below) then scales
    // the whole response back so the flats stay three stops under sunlit
    // plaster the way ART_DIRECTION asks.
    var zen = [1.86, 1.96, 2.16];
    var hor = [1.22, 1.02, 0.80];
    var gnd = [0.24, 0.20, 0.15];
    for (var y = 0; y < H; y++) {
      // DataTexture row 0 is v=0, and three's equirect maps v = dir.y*0.5+0.5,
      // so row 0 is straight down and the last row is the zenith.
      var dy = (y + 0.5) / H * 2 - 1;
      var c = [0, 0, 0], t, i;
      if (dy >= 0) { t = Math.pow(dy, 0.55); for (i = 0; i < 3; i++) c[i] = hor[i] + (zen[i] - hor[i]) * t; }
      else { t = Math.pow(-dy, 0.45); for (i = 0; i < 3; i++) c[i] = hor[i] + (gnd[i] - hor[i]) * t; }
      for (var x = 0; x < W; x++) {
        var o = (y * W + x) * 4;
        data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 1;
      }
    }
    var tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.NoColorSpace;   // HDR radiance, not an albedo map
    tex.needsUpdate = true;
    var pm = new THREE.PMREMGenerator(ctx.renderer);
    var rt = pm.fromEquirectangular(tex);
    pm.dispose();
    tex.dispose();
    return rt.texture;
  };

  WeaponSystem.prototype._makeMaterials = function () {
    var aniso = 8;
    try { aniso = this.ctx.renderer ? this.ctx.renderer.capabilities.getMaxAnisotropy() : 8; }
    catch (e) { aniso = 8; }
    var self = this;
    try { this.viewEnv = this._makeViewEnv(); }
    catch (e) { GAME.logError('weapons.viewEnv', e); this.viewEnv = null; }
    // No private env available -> fall back to whatever lights viewScene, but
    // pull the response right down since that map's range is unknown.
    var envFallback = this.viewEnv ? 1.0 : 0.14;
    // Global env weight. _makeViewEnv now authors ~3.3x the radiance it used
    // to (for contrast, see there); this takes the mean back down so the flats
    // land where they did while the bright half of the gradient gains ~1.6x.
    var ENV_W = 0.40;

    function std(o) {
      var m = new THREE.MeshStandardMaterial({
        color: new THREE.Color(o.color),
        roughness: o.rough, metalness: o.metal,
        normalMap: o.nMap ? repeated(o.nMap, o.rep, aniso) : null,
        roughnessMap: o.rMap ? repeated(o.rMap, o.rep, aniso) : null,
        map: o.map ? repeated(o.map, o.rep, aniso) : null,
        envMap: self.viewEnv || null,
        envMapIntensity: (o.env === undefined ? 1.0 : o.env) * envFallback * ENV_W,
        dithering: true
      });
      // remember the authored weight so the sun-intensity tracker can rescale
      m.userData.baseEnv = (o.env === undefined ? 1.0 : o.env) * envFallback * ENV_W;
      if (m.normalMap) m.normalScale.set(o.nScale || 0.7, o.nScale || 0.7);
      applyWearShader(m, {
        // Bare aluminium under anodising is not bright chrome - it is a dull,
        // slightly warm grey that has been rubbed by nylon and sweat. 0x8d939b
        // was two stops too light and dominated every flat face; 0x55585d at
        // metalness 0.85 went the other way, because a metal has no diffuse
        // term at all, so a rub mark seen away from the specular lobe came out
        // DARKER than the anodising it replaced. This is the honest middle: a
        // semi-metal that keeps some diffuse and reflects the sky at grazing.
        bare: new THREE.Color(o.bare || 0x7e838b),
        bareRough: o.bareRough === undefined ? 0.32 : o.bareRough,
        bareMetal: o.bareMetal === undefined ? 0.50 : o.bareMetal,
        wear: o.wearMul === undefined ? 1.0 : o.wearMul,
        ao: o.aoMul === undefined ? 0.55 : o.aoMul,
        mask: self.texWear || null,
        maskRep: o.maskRep === undefined ? 92.0 : o.maskRep
      });
      return m;
    }

    // A dark object 8cm from the lens is dominated by its SPECULAR response,
    // not its albedo. With a hazy HDR sky in scene.environment, generous
    // envMapIntensity turns matte anodising into chrome, so these are kept
    // deliberately low - the weapon must sit a good three stops under the
    // sunlit plaster of the street.
    // METALNESS IS 0 ON EVERY PAINTED / ANODISED / PARKERISED SURFACE.
    // The old 0.42-0.48 was physically meaningless: it destroyed 42-48% of the
    // diffuse term (which is all a matte black rifle has on its camera-facing
    // flank) while moving F0 from 0.040 to only 0.035, so it bought no
    // specular at all. The weapon measured a 0.06 luminance span across the
    // entire side of the receiver because of it. Bare metal is what the wear
    // mask is for: uBareMetal lifts the speckle toward metal, the flats stay
    // dielectric, and the anodised coating - which is what you are actually
    // looking at - behaves like the dielectric oxide layer it is.
    // ...but "low" was taken far too literally. envMapIntensity 0.16 on a
    // dielectric puts the whole IBL specular term at 0.04 x 1.5 x 0.16 = 0.010
    // linear, i.e. two stops below the diffuse it is supposed to sit on top of,
    // which is why a 24mm barrel measured a 0.02 luminance range across its
    // entire diameter with an 0.85 sky directly behind it: no reflection
    // direction returned a different enough number to see. The env is the ONLY
    // thing on this weapon that varies with surface orientation - the world key
    // arrives from behind the muzzle in every hero framing - so it has to carry
    // the shape. These are ~2.4x the round-2 values, which is still ~2.5 stops
    // under the sunlit plaster the gun is photographed against.
    var lib = {};
    // Cast/forged lower + receiver: hard-anodised 7075. Roughness is the other
    // half of the fix - 0.86 (x0.83 from the map = 0.71 effective) is chalk,
    // and chalk has no highlight to lose. 0.44 puts the effective range at
    // 0.27-0.44 so the sky lays a real band down the flank.
    lib.metal = std({ color: 0x2b2a29, rough: 0.38, metal: 0.0, nMap: this.texMetalN, rMap: this.texMetalR, rep: 34, nScale: 0.95, bare: 0x7e838b, bareRough: 0.30, wearMul: 1.0, aoMul: 0.62, env: 0.24 });
    // Extruded rail / handguard: type-III hard coat, tighter machining lines,
    // noticeably slicker. This value+sheen break is what stops the whole gun
    // reading as one milled block.
    lib.metalHard = std({ color: 0x2b2a28, rough: 0.32, metal: 0.0, nMap: this.texMetalN, rMap: this.texMetalR, rep: 42, nScale: 0.70, bare: 0x7b8089, bareRough: 0.24, wearMul: 0.55, aoMul: 0.62, env: 0.22 });
    // Barrel + gas block: parkerised steel, and the one part of the gun that is
    // a long unbroken cylinder. It carries the highest env weight on the weapon
    // precisely because a cylinder is where a specular band reads.
    lib.metalDark = std({ color: 0x1f1e1d, rough: 0.40, metal: 0.0, nMap: this.texMetalN, rMap: this.texMetalR, rep: 28, nScale: 1.05, bare: 0x74797f, bareRough: 0.34, wearMul: 0.7, aoMul: 0.62, env: 0.38 });
    // Carbon-fouled muzzle device: soot never polishes off, so it stays the
    // darkest thing on the gun and separates from the barrel behind it.
    lib.muzzleDev = std({ color: 0x171614, rough: 0.48, metal: 0.0, nMap: this.texMetalN, rMap: this.texMetalR, rep: 50, nScale: 1.25, bare: 0x64686e, bareRough: 0.28, wearMul: 0.55, aoMul: 0.68, env: 0.15 });
    // Injection-moulded polymer: much finer stipple, much duller, barely any
    // environment response. Nothing about it should look like the metal.
    lib.polymer = std({ color: 0x232120, rough: 0.76, metal: 0.0, nMap: this.texPolyN, rMap: this.texPolyR, rep: 40, nScale: 0.62, bare: 0x44484e, bareRough: 0.60, bareMetal: 0.05, wearMul: 0.45, aoMul: 0.64, env: 0.18 });
    lib.rubber = std({ color: 0x151413, rough: 0.90, metal: 0.0, nMap: this.texPolyN, rMap: this.texPolyR, rep: 55, nScale: 1.2, bare: 0x2a2c30, bareRough: 0.82, bareMetal: 0.03, wearMul: 0.6, aoMul: 0.64, env: 0.10 });
    // never pure black: the cavity still catches a little skylight
    lib.inner = std({ color: 0x0e1013, rough: 0.92, metal: 0.0, nMap: this.texMetalN, rep: 120, nScale: 0.5, wearMul: 0.0, aoMul: 0.75, env: 0.07 });
    lib.brass = std({ color: 0xa87f36, rough: 0.42, metal: 1.0, nMap: this.texMetalN, rep: 140, nScale: 0.5, bare: 0xc9ad68, bareRough: 0.24, env: 0.30 });
    // GLOVES. Round 1 put them at 7.5x the weapon body (bright cream speckle,
    // "bird droppings"); round 2 over-corrected to 0.45x - a median of 0.034,
    // i.e. crushed to featureless black lozenges with no finger separation. The
    // brief is "dark tactical", not "silhouette": the target is roughly parity
    // with the weapon body, which needs a lighter base value AND much less
    // baked occlusion, because a 0.70 AO multiplier on top of a contact-occlusion
    // term that already saturates was taking 70% of the light off the fabric.
    lib.glove = std({ color: 0x2e3034, rough: 0.92, metal: 0.0, map: this.texGloveM, nMap: this.texGloveN, rMap: this.texGloveR, rep: 30, nScale: 0.85, bare: 0x171819, bareRough: 0.98, bareMetal: 0.0, wearMul: 1.6, aoMul: 0.48, env: 0.11 });
    lib.sleeve = std({ color: 0x31342c, rough: 0.95, metal: 0.0, nMap: this.texGloveN, rMap: this.texGloveR, rep: 20, nScale: 1.0, bare: 0x1c1e16, bareRough: 1.0, bareMetal: 0.0, wearMul: 1.2, aoMul: 0.52, env: 0.09 });
    lib.skin = std({ color: 0x59402f, rough: 0.68, metal: 0.0, nMap: this.texGloveN, rep: 40, nScale: 0.35, bare: 0x7d5942, bareRough: 0.60, bareMetal: 0.0, wearMul: 0.3, aoMul: 0.52, env: 0.11 });
    // Optic tube interior. UNLIT ON PURPOSE. This surface is seen at ~5 degrees
    // off grazing straight down its own axis, and at that incidence the
    // derivative-derived tangent frame and the Fresnel term together turned a
    // 0x101215 albedo into a chrome sleeve measuring 0.75 - brighter than the
    // sky behind it - which destroyed the sight picture and put a gold "lens"
    // on the hip pose. A MeshBasicMaterial has no lighting path at all, so
    // there is no value of roughness, env or light rig that can brighten it.
    lib.tubeInner = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x0a0b0d), side: THREE.DoubleSide, fog: false
    });

    // Objective lens. It is composited as mix(world, lensRGB*a, a), so a DARK
    // pane at a modest alpha reads exactly like real coated glass: the sight
    // picture loses ~18% and picks up the cool AR cast. It must never add
    // light - a bright envMapIntensity here is what veils the whole aperture.
    // Only ONE pane now (the eye-side copy was invisible and doubled the veil).
    // envMapIntensity is deliberately tiny: at the extreme off-axis angle of
    // the hip pose a real multi-coated objective goes DARK, not gold, and the
    // amber disc that used to sit at 75% frame width was the second-brightest
    // thing in the firefight frame after the muzzle flash.
    lib.lens = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x080d13), roughness: 0.06, metalness: 0.0,
      transparent: true, opacity: 0.28, side: THREE.FrontSide,
      depthWrite: false, envMap: this.viewEnv || null,
      envMapIntensity: 0.10 * envFallback
    });
    lib.lens.userData.baseEnv = 0.10 * envFallback;
    // Small off-axis additive quad standing in for the AR coating flare.
    lib.coating = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setRGB(0.08, 0.15, 0.26),
      map: this.texGlow || null, transparent: true, opacity: 0.30,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
    });
    // TWO-PART RETICLE.
    //
    // An additive-only dot cannot hold its hue. ARCHITECTURE 7.2 tonemaps in
    // the postfx composite, so `toneMapped:false` buys nothing here, and
    // ADDING red onto a 0.76-luminance sky lifts R while G and B are already
    // near the top of the curve - which is precisely how the dot measured
    // (0.761, 0.380, 0.322): a desaturated salmon smear.
    //
    // `reticleCore` is NORMAL-blended with a solid-disc sprite, so it REPLACES
    // the background and the hue no longer depends on what is behind it.
    //
    // The level and the NEGATIVE chroma were both measured, not guessed. The
    // composite's transfer for a pure-red normal-blended quad (probed by
    // driving this material and reading the centre pixel back through the full
    // chain) is:
    //     in 0.30 -> (0.63, 0.21, 0.19)     in 0.55 -> (0.80, 0.34, 0.31)
    //     in 0.90 -> (0.91, 0.45, 0.39)     in 1.34 -> (1.00, 0.64, 0.53)
    // i.e. G climbs with R no matter how pure the input is, because AgX's inset
    // matrix hands 13.7% of red to green and the grade's shadow-chroma rotation
    // then adds more. Driving R at 1.34 (the round-2 value) is therefore the
    // WORST case: it lands exactly on the salmon that was filed against it.
    // Authoring G and B NEGATIVE pre-tonemap cancels the inset crosstalk -
    // measured (0.80, 0.29, 0.26) at the same R as the 0.34/0.31 above - and a
    // moderate level keeps the rest. Half float render targets carry the
    // negative fine and AgX clamps at 1e-10, so nothing downstream can NaN.
    lib.reticleCore = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setRGB(0.48, -0.19, -0.16),
      map: this.texDotCore, transparent: true,
      blending: THREE.NormalBlending, depthWrite: false, toneMapped: false
    });
    // `reticle` is the additive bloom skirt only - the thing that makes the dot
    // read as EMISSIVE rather than as a red sticker. It is drawn underneath the
    // core, so it never gets to touch the hue at the centre.
    lib.reticle = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setRGB(0.90, 0.024, 0.008),
      map: this.texDot, transparent: true, opacity: 0.50,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
    });

    // give the library a chance to override with project-specific weapon mats
    var keys = ['metal', 'metalHard', 'metalDark', 'muzzleDev', 'polymer', 'rubber', 'glove', 'skin', 'sleeve', 'brass'];
    for (var k = 0; k < keys.length; k++) {
      var over = self._libMaterial('weapon_' + keys[k]);
      if (over) lib[keys[k]] = over;
    }
    this.mats = lib;
  };

  WeaponSystem.prototype._setupViewScene = function () {
    var ctx = this.ctx, vs = ctx.viewScene;
    if (!vs) return;
    // muzzle flash lights the gun and hands from the front for two frames
    this.flashLight = new THREE.PointLight(0xffc98a, 0, 1.4, 2);
    this.flashLight.castShadow = false;
    vs.add(this.flashLight);
    vs.add(this.rig);
    // Install the viewmodel rig NOW, during build. lighting.js documents the
    // contract as "if weapons.js supplied lights we leave it alone", and its
    // own check runs on the first frame - i.e. after every build(). Deferring
    // our install to the first weapons.update() loses that race in the wrong
    // direction (lighting.update runs before weapons.update), so the gun ended
    // up lit by a rig that cannot cast the contact shadow the hands need and
    // that ignores every value tuned in this file.
    this._ensureViewLights(ctx);
  };

  // The viewmodel scene needs lights or the gun renders black - but lighting.js
  // also builds a viewmodel rig, and MEASURED AT RUNTIME it wins the race: its
  // group is already a child of viewScene by the time weapons.build() runs, so
  // the "install our own rig" branch below has never actually executed in this
  // build. Replacing or disabling another module's lights would be both rude
  // and racy (it re-drives their intensity every frame), so when a rig is
  // already present we install exactly ONE supplementary light instead: a warm
  // camera-side bounce card. Their rig is a key from the world sun direction
  // plus a cool sky fill, which in every hero framing arrives from behind the
  // muzzle - so the flank facing the player, which is 80% of what is ever on
  // screen, gets nothing but cool ambient. That is what put the receiver at
  // B/R 2.41 in round 1 and it is what still leaves it with no tonal gradient.
  // One card at ~8% of the key cannot double-expose anything.
  WeaponSystem.prototype._ensureViewLights = function (ctx) {
    var vs = ctx.viewScene;
    this._lightsChecked = true;
    if (!vs) return;
    // Recursive: another module may park its rig inside a container object,
    // and a direct-children scan would miss it and double-light the weapon.
    var hasLight = false, self = this;
    vs.traverse(function (o) {
      if (o.isLight && o !== self.flashLight && !o.isPointLight) hasLight = true;
    });
    if (hasLight && !this.faceLight) {
      var sunF = (ctx.sky && isFinite(ctx.sky.sunIntensity)) ? ctx.sky.sunIntensity : 5.0;
      // Pointing almost straight back at the lens (0.38, -0.10, 0.92), so it
      // lands on the camera-facing flanks and on nothing else. That matters:
      // the ADS pose shows almost only UP-facing surfaces, which is where the
      // environment already over-delivers, so the card lifts the framings that
      // are short of light without touching the one that is not.
      var card = new THREE.DirectionalLight(0xffe9d6, sunF * 0.26);
      card.position.set(0.9, -0.25, 2.2);
      card.castShadow = false;
      vs.add(card);
      this.faceLight = card;
      this._faceMul = 0.26;
    }
    // Match the world's physical light level or the gun floats in its own
    // studio. Sky irradiance already arrives through the environment map, so
    // the hemisphere/rim are only there to shape - keeping them small avoids
    // double-counting the sky and washing the anodising out.
    var sunI = (ctx.sky && isFinite(ctx.sky.sunIntensity)) ? ctx.sky.sunIntensity : 5.0;
    if (!hasLight) {
      var key = new THREE.DirectionalLight(0xffeeda, sunI * KEY_MUL);
      key.position.set(-1.6, 2.4, 1.4);
      key.castShadow = true;
      // 2048 over the same 0.9m frustum triples texel density over the hands,
      // which is what lets a contact shadow survive at all. Shrinking the
      // frustum instead would drop the muzzle and the stock out of it.
      key.shadow.mapSize.set(2048, 2048);
      var sc = key.shadow.camera;
      sc.left = -0.45; sc.right = 0.45; sc.top = 0.45; sc.bottom = -0.45;
      sc.near = 0.6; sc.far = 6.5; sc.updateProjectionMatrix();
      key.shadow.normalBias = 0.0012;
      key.shadow.bias = -0.00005;
      key.shadow.radius = 1.1;
      // THE CAMERA-SIDE FLANK IS 80% OF WHAT THE PLAYER EVER SEES, and with
      // the key up at (-1.6, 2.4, 1.4) it used to receive nothing but the
      // hemisphere and the rim - both blue - which is why the receiver
      // measured B/R 2.41 against the #2a2c30 the art direction asks for
      // (B/R 1.14). This is a warm bounce card sitting just off the lens, the
      // same 4200K the street is lit by. It casts no shadow: it is a fill.
      var face = new THREE.DirectionalLight(0xffcb96, sunI * 0.115);
      face.position.set(0.9, -0.25, 2.2);
      face.castShadow = false;
      // Sky fill, near neutral. On a surface whose diffuse term is now intact
      // this is a shaping light, not the only light, so it no longer needs to
      // be blue to do its job - and it must not be, or it re-tints everything.
      var fill = new THREE.HemisphereLight(0xb6bec4, 0x6d5a42, 0.30);
      // The rim used to be the SECOND blue source on a surface with no diffuse
      // term to dilute it, which is most of why the gun read blue-grey against
      // a warm street. Cool but nearly neutral now, and much weaker.
      var rim = new THREE.DirectionalLight(0xa8b2be, 0.16);
      rim.position.set(2.2, 0.7, -2.4);
      // a soft bounce from below stops the underside going flat black
      var bounce = new THREE.DirectionalLight(0xd8b58a, 0.22);
      bounce.position.set(0.4, -2.2, 0.9);
      vs.add(key, face, fill, rim, bounce);
      this.keyLight = key; this.rimLight = rim; this.fillLight = fill;
      this.faceLight = face;
      this._faceMul = 0.115;
    }
    // Only touch the IBL if nobody else has: whoever set it owns its intensity.
    if (ctx.sky && ctx.sky.envMap && !vs.environment) {
      vs.environment = ctx.sky.envMap;
      vs.environmentIntensity = 1.0;
    }
  };

  // ---- build ---------------------------------------------------------------
  WeaponSystem.prototype.build = async function (ctx) {
    ctx = ctx || this.ctx;
    this.ctx = ctx;
    try {
      this._makeTextures();
      await GAME.yieldFrame();
      this._makeMaterials();
      this._setupViewScene();

      var defs = weaponDefs();
      for (var i = 0; i < defs.length; i++) {
        var def = defs[i];
        def.pattern = buildRecoilPattern(def, this.rng);
        def.fireInterval = 60 / Math.max(1, def.rpm);
        var MB = new ModelBuilder(this.noise);
        def.build(MB);
        this.triangles += MB.finish(this.mats);
        var model = {
          def: def,
          root: MB.root,
          groups: MB.groups,
          muzzle: MB.muzzle,
          eject: MB.eject,
          mag: MB.groups.mag ? MB.groups.mag.obj : null,
          bolt: MB.groups.bolt ? MB.groups.bolt.obj : (MB.groups.slide ? MB.groups.slide.obj : null),
          cover: MB.groups.cover ? MB.groups.cover.obj : null,
          charge: MB.groups.charge ? MB.groups.charge.obj : null,
          trigger: MB.groups.trigger ? MB.groups.trigger.obj : null,
          lhand: MB.groups.lhand ? MB.groups.lhand.obj : null,
          rhand: MB.groups.rhand ? MB.groups.rhand.obj : null,
          drops: []
        };
        // pooled mag props for the reload drop
        if (model.mag) {
          for (var d = 0; d < 3; d++) {
            var clone = model.mag.clone(true);
            clone.visible = false;
            clone.matrixAutoUpdate = true;
            model.drops.push({ obj: clone, live: false, vel: new THREE.Vector3(), spin: new THREE.Vector3(), t: 0 });
            if (ctx.viewScene) ctx.viewScene.add(clone);
          }
        }
        MB.root.visible = false;
        this.rig.add(MB.root);
        this.weapons.push(def);
        this.models.push(model);
        await GAME.yieldFrame();
      }

      this.index = 0;
      this.current = this.weapons[0];
      this.model = this.models[0];
      if (this.model) this.model.root.visible = true;
      if (ctx.viewCamera) {
        ctx.viewCamera.fov = this.current.hipFov;
        ctx.viewCamera.updateProjectionMatrix();
      }
      this._camBaseFov = null;
      this._pushAmmo();

      // The muzzleflash / firefight captures render a single deterministic
      // frame at ctx.params.t; time the last shot to land on it so the flash
      // is actually alight when the shutter opens.
      // main.js publishes the URL query on GAME.params, not on ctx
      var P = GAME.params || ctx.params || {};
      var sc = P.scenario;
      if ((ctx.capture || GAME.headless) && (sc === 'muzzleflash' || sc === 'firefight')) {
        var end = parseFloat(P.t || '2.5');
        if (isFinite(end)) this._captureFire = { from: Math.max(0.2, end - 0.32), to: end + 0.02 };
      }
    } catch (e) {
      GAME.logError('weapons.build', e);
    }
  };

  WeaponSystem.prototype._pushAmmo = function () {
    var hud = this.ctx.hud;
    if (hud && hud.setAmmo && this.current) {
      try { hud.setAmmo(this.current.ammo, this.current.reserve); }
      catch (e) { GAME.logError('weapons.hud', e); }
    }
  };

  WeaponSystem.prototype._sfx = function (name, opts) {
    var a = this.ctx.audio;
    if (a && a.play) { try { a.play(name, opts); } catch (e) { /* audio is optional */ } }
  };

  // ---- per-frame -----------------------------------------------------------
  WeaponSystem.prototype.update = function (dt, ctx) {
    ctx = ctx || this.ctx;
    if (!this.current || !this.model) return;
    dt = Math.min(Math.max(dt || 0, 0), 1 / 20);
    this.time += dt;
    this.sinceFire += dt;
    try {
      this._input(dt, ctx);
      this._machine(dt, ctx);
      this._recoil(dt, ctx);
      this._poseRig(dt, ctx);
      this._subAnim(dt, ctx);
      this._props(dt, ctx);
      this._lights(dt, ctx);
    } catch (e) {
      GAME.logError('weapons.update', e);
    }
  };

  WeaponSystem.prototype._input = function (dt, ctx) {
    var input = ctx.input;
    var wantFire = false;
    if (input && input.enabled !== false && input.locked) {
      wantFire = !!(input.mouse && input.mouse.left);
      this._adsWanted = !!(input.mouse && input.mouse.right);
      if (input.justPressed('KeyR')) this.reload();
      if (input.justPressed('Digit1')) this.switchTo(0);
      if (input.justPressed('Digit2')) this.switchTo(1);
      if (input.justPressed('KeyQ')) this.switchTo((this.index + 1) % this.weapons.length);
      if (input.mouse && input.mouse.wheel) this.switchTo((this.index + 1) % this.weapons.length);
      if (input.justPressed('KeyF')) this.inspect(!this.inspecting);
    }
    if (this.forceADS) this._adsWanted = true;
    if (this._captureFire) {
      wantFire = this.time >= this._captureFire.from && this.time <= this._captureFire.to;
    }
    // sprinting stows the sights and blocks the trigger
    var st = ctx.player ? ctx.player.state : null;
    this.sprinting = (st === 'sprint') && this.state !== 'reload' && !this.inspecting;
    if (this.sprinting) { this._adsWanted = false; wantFire = false; }
    if (this.inspecting && wantFire) this.inspect(false);

    this.triggerHeld = wantFire;
    if (wantFire) {
      if (this.current.auto) this.fire();
      else if (!this.triggerLatch) { this.fire(); this.triggerLatch = true; }
    } else {
      this.triggerLatch = false;
    }
  };

  WeaponSystem.prototype._machine = function (dt, ctx) {
    var w = this.current;

    // ADS timer - a linear clock through a snappy easing curve so the end
    // points are exact and interrupting simply reverses it.
    var adsRate = dt / Math.max(0.02, w.adsTime);
    var wantAds = !!this._adsWanted && this.state !== 'reload' && this.state !== 'switch' && !this.inspecting;
    this.adsT = M.clamp(this.adsT + (wantAds ? adsRate : -adsRate * 1.25), 0, 1);
    this.adsEase = easeAds(this.adsT);
    if (ctx.player) ctx.player.isADS = this.adsT > 0.5;

    // sprint pose blends over ~0.2s
    this.sprintT = M.clamp(this.sprintT + (this.sprinting ? dt / 0.20 : -dt / 0.18), 0, 1);

    // inspect showcase
    this.inspectT = M.clamp(this.inspectT + (this.inspecting ? dt / 0.55 : -dt / 0.40), 0, 1);

    this.reloadBlend = this.reloadBlend || 0;

    if (this.state === 'switch') {
      this.stateT += dt;
      var hol = this.holsterDur, tot = this.holsterDur + this.drawDur;
      if (this.stateT < hol) {
        this.lowerT = M.smootherstep(0, 1, this.stateT / hol);
      } else {
        if (this.pendingIndex >= 0) {
          this._commitSwitch();
        }
        var dtn = (this.stateT - hol) / Math.max(0.02, this.drawDur);
        this.lowerT = 1 - M.smootherstep(0, 1, M.saturate(dtn));
      }
      if (this.stateT >= tot) { this.state = 'idle'; this.lowerT = 0; this.stateT = 0; }
    } else {
      this.lowerT = M.damp(this.lowerT, 0, 14, dt);
    }

    if (this.state === 'reload') {
      this.stateT += dt;
      var p = M.saturate(this.stateT / this.reloadDur);
      this.reloadBlend = M.smootherstep(0, 0.14, p) * (1 - M.smootherstep(0.84, 1.0, p));
      this._reloadPhases(p, dt);
      if (this.stateT >= this.reloadDur) {
        this.state = 'idle'; this.stateT = 0; this.reloadBlend = 0;
        this.magVisible = true; this.magOffset.set(0, 0, 0);
      }
    } else {
      this.reloadBlend = M.damp(this.reloadBlend, 0, 12, dt);
    }
  };

  // The reload is a sequence of overlapping procedural moves, not a clip.
  WeaponSystem.prototype._reloadPhases = function (p, dt) {
    var m = this.model, w = this.current;
    var empty = this.reloadEmpty;
    // magazine: out -> gone -> new one rises into the well
    var outAmt = M.smootherstep(0.14, 0.26, p) * (1 - M.smootherstep(0.50, 0.62, p));
    var inAmt = M.smootherstep(0.50, 0.62, p);
    var away = w.magTravel;
    if (p < 0.50) {
      this.magOffset.copy(w.magDrop).multiplyScalar(away * outAmt);
      this.magVisible = outAmt < 0.98;
    } else {
      this.magOffset.copy(w.magDrop).multiplyScalar(away * (1 - inAmt));
      this.magVisible = true;
    }
    // spawn the falling mag exactly once, at the moment it clears the well
    if (!this._dropped && p > 0.235) { this._dropped = true; this._spawnDroppedMag(); }
    // seat + credit ammo
    if (!this.reloadDone && p >= 0.635) {
      this.reloadDone = true;
      this._creditAmmo();
      this._sfx('mag_in');
      this.kick.y.v -= 0.010; this.kickRot.x.v += 0.030;   // the mag tap
    }
    // empty reload: charging handle pull releases the bolt
    if (empty) {
      var pull = M.smootherstep(0.70, 0.80, p) * (1 - M.smootherstep(0.82, 0.90, p));
      this.chargeT = pull;
      if (this.boltLocked && p > 0.845) {
        this.boltLocked = false;
        this.boltT = 0.55;
        this._sfx('bolt_release');
      }
    }
    // left hand: drops to the mag pouch, returns with the magazine, then
    // reaches up for the charging handle on an empty reload.
    if (m && m.lhand) {
      var down = M.smootherstep(0.10, 0.30, p) * (1 - M.smootherstep(0.52, 0.66, p));
      var up = empty ? M.smootherstep(0.66, 0.76, p) * (1 - M.smootherstep(0.84, 0.94, p)) : 0;
      m.lhand.position.set(
        0.030 * down - 0.020 * up,
        -0.230 * down + 0.115 * up,
        0.075 * down + 0.145 * up
      );
      m.lhand.rotation.set(-0.55 * down + 0.30 * up, 0.35 * down, 0.20 * down);
    }
  };

  WeaponSystem.prototype._creditAmmo = function () {
    var w = this.current;
    var carry = Math.min(w.ammo, 1);                 // round stays in the chamber
    var back = Math.max(0, w.ammo - carry);          // partial mag returns to the pool
    w.reserve += back;
    var take = Math.min(w.reserve, w.magSize);
    w.reserve -= take;
    w.ammo = take + carry;
    this._pushAmmo();
  };

  WeaponSystem.prototype._spawnDroppedMag = function () {
    var m = this.model;
    if (!m || !m.drops.length || !m.mag) return;
    var d = null;
    for (var i = 0; i < m.drops.length; i++) if (!m.drops[i].live) { d = m.drops[i]; break; }
    if (!d) d = m.drops[0];
    this.rig.updateMatrixWorld(true);
    d.obj.matrix.copy(m.mag.matrixWorld);
    d.obj.matrix.decompose(d.obj.position, d.obj.quaternion, d.obj.scale);
    d.obj.visible = true;
    d.live = true; d.t = 0;
    var r = this.rng;
    d.vel.set(r.range(-0.15, 0.05), -0.55, r.range(0.10, 0.35));
    d.spin.set(r.range(-4, 4), r.range(-3, 3), r.range(-5, 5));
    this._sfx('mag_out');
  };

  WeaponSystem.prototype._props = function (dt) {
    var m = this.model;
    if (!m) return;
    for (var i = 0; i < m.drops.length; i++) {
      var d = m.drops[i];
      if (!d.live) continue;
      d.t += dt;
      d.vel.y -= 9.0 * dt;                 // view-space gravity; it leaves frame fast
      d.obj.position.addScaledVector(d.vel, dt);
      _e1.set(d.spin.x * dt, d.spin.y * dt, d.spin.z * dt, 'XYZ');
      d.obj.quaternion.multiply(_q1.setFromEuler(_e1));
      if (d.t > 1.4 || d.obj.position.y < -1.2) { d.live = false; d.obj.visible = false; }
    }
  };

  // ---- camera recoil -------------------------------------------------------
  // Recoil is tracked as an offset we own; every frame we hand the camera only
  // the DELTA of that offset, so player mouse input is never fought over.
  // After the trigger releases, ~70% of the accumulated climb walks back to
  // the original aim - the modern-CoD feel, not pure random spray.
  WeaponSystem.prototype._recoil = function (dt, ctx) {
    if (this.sinceFire > 0.09) {
      var rate = 1 - Math.exp(-6.5 * dt);
      var dp = this.recoilRecover.p * rate, dy = this.recoilRecover.y * rate;
      this.recoilKick.p -= dp; this.recoilRecover.p -= dp;
      this.recoilKick.y -= dy; this.recoilRecover.y -= dy;
    }
    var sp = this.recoilSmooth.p.to(this.recoilKick.p, 0.055, dt);
    var sy = this.recoilSmooth.y.to(this.recoilKick.y, 0.075, dt);
    var deltaP = sp - this.recoilApplied.p;
    var deltaY = sy - this.recoilApplied.y;
    this.recoilApplied.p = sp; this.recoilApplied.y = sy;
    if (Math.abs(deltaP) < 1e-7 && Math.abs(deltaY) < 1e-7) return;
    var p = ctx.player;

    if (p && typeof p.pitch === 'number' && !p.frozen) {
      p.pitch = M.clamp(p.pitch + deltaP, -1.54, 1.54);
      p.yaw += deltaY;
    } else if (!p && ctx.camera) {
      // no controller: drive the camera directly. A frozen scenario camera is
      // deliberately left alone so capture framing stays reproducible.
      ctx.camera.rotation.x = M.clamp(ctx.camera.rotation.x + deltaP, -1.54, 1.54);
      ctx.camera.rotation.y += deltaY;
    }
  };

  // ---- viewmodel pose ------------------------------------------------------
  WeaponSystem.prototype._poseRig = function (dt, ctx) {
    var w = this.current;
    var p = this._pos, r = this._rot;
    if (this.bobAmp === undefined) this.bobAmp = 0;

    // --- absolute pose blend (hip -> sprint -> ADS -> inspect) -------------
    p.copy(w.hipPos); r.copy(w.hipRot);
    if (this.sprintT > 0) {
      var se = M.smootherstep(0, 1, this.sprintT);
      p.lerp(w.sprintPos, se); r.lerp(w.sprintRot, se);
    }
    if (this.adsEase > 0) { p.lerp(w.adsPos, this.adsEase); r.lerp(w.adsRot, this.adsEase); }
    if (this.inspectT > 0) {
      var ie = M.smootherstep(0, 1, this.inspectT);
      p.lerp(w.inspectPos, ie); r.lerp(w.inspectRot, ie);
      // slow showcase oscillation so any capture time lands on a good angle
      var it = this.time;
      r.y += Math.sin(it * 0.55) * 0.22 * ie;
      r.x += Math.sin(it * 0.37 + 1.1) * 0.11 * ie;
      r.z += Math.sin(it * 0.29 + 2.2) * 0.09 * ie;
      p.z += Math.sin(it * 0.31) * 0.022 * ie;
      p.y += Math.sin(it * 0.44 + 0.8) * 0.012 * ie;
    }

    // --- additive offsets --------------------------------------------------
    p.addScaledVector(w.lowerPos, this.lowerT); r.addScaledVector(w.lowerRot, this.lowerT);
    p.addScaledVector(w.reloadPos, this.reloadBlend); r.addScaledVector(w.reloadRot, this.reloadBlend);

    // Procedural motion is heavily damped in ADS and switched off entirely for
    // a forced-ADS capture, so the sight picture is mathematically centred.
    var proc = (this.forceADS && this.adsT > 0.999) ? 0 : M.lerp(1, 0.12, this.adsEase);
    proc *= (1 - this.inspectT * 0.75);
    // Scaling `proc` to zero only stops NEW procedural motion being added; the
    // sway and recoil springs keep whatever state they accumulated on the way
    // in, and 1.5mm of leftover lateral offset is 9 pixels of point-of-aim
    // error at the view camera's 68.6 deg horizontal FOV. A locked-off ADS
    // capture has to be exactly on the axis, so the springs are hard-zeroed.
    if (proc === 0) {
      this.swayTarget.set(0, 0, 0); this.swayRotTarget.set(0, 0, 0);
      this.sway.reset(); this.swayRot.reset();
      this.kick.reset(); this.kickRot.reset();
      this.land.reset(0);
      this.bobAmp = 0;
    }

    // idle: breathing + a slow figure-of-eight drift
    var t = this.time, f8 = t * 0.42;
    p.x += Math.sin(f8) * 0.0042 * proc;
    p.y += (Math.sin(f8 * 2) * 0.0022 + Math.sin(t * 1.25) * 0.0026) * proc;
    r.x += Math.sin(t * 1.25 + 0.7) * 0.0062 * proc;
    r.y += Math.sin(f8) * 0.0078 * proc;
    r.z += Math.sin(t * 0.33) * 0.0060 * proc;

    // walk / sprint bob synced to actual player speed
    var speed = 0, state = 'idle';
    var pl = ctx.player;
    if (pl) {
      state = pl.state || 'idle';
      if (typeof pl.speed === 'number') speed = pl.speed;
      else if (pl.velocity) speed = Math.sqrt(pl.velocity.x * pl.velocity.x + pl.velocity.z * pl.velocity.z);
    }
    var moving = state !== 'air' && speed > 0.35;
    var rate = (state === 'sprint') ? 11.0 : 8.2;
    if (moving) this.bobPhase += dt * rate * M.clamp(speed / 4.2, 0.4, 1.5);
    var ampT = moving ? M.clamp(speed / 4.2, 0, 1.2) * (state === 'sprint' ? 1.45 : 1.0) : 0;
    this.bobAmp = M.damp(this.bobAmp, ampT * proc, 9, dt);
    var bp = this.bobPhase, ba = this.bobAmp;
    p.x += Math.sin(bp) * 0.0168 * ba;
    p.y += (Math.cos(bp * 2) * 0.5 - 0.5) * 0.0128 * ba;
    p.z += Math.sin(bp * 2) * 0.0050 * ba;
    r.z += Math.sin(bp) * 0.0330 * ba;
    r.x += Math.cos(bp * 2) * 0.0155 * ba;
    r.y += Math.sin(bp) * 0.0185 * ba;

    // --- sway: the gun LAGS the camera, then settles -----------------------
    var yaw, pitch;
    if (pl && typeof pl.yaw === 'number') { yaw = pl.yaw; pitch = pl.pitch || 0; }
    else if (ctx.camera) { yaw = ctx.camera.rotation.y; pitch = ctx.camera.rotation.x; }
    else { yaw = 0; pitch = 0; }
    if (this.lastYaw === null) { this.lastYaw = yaw; this.lastPitch = pitch; }
    var dyaw = M.wrapAngle(yaw - this.lastYaw), dpit = pitch - this.lastPitch;
    this.lastYaw = yaw; this.lastPitch = pitch;
    if (Math.abs(dyaw) > 0.55) dyaw = 0;      // scenario snap / teleport
    if (Math.abs(dpit) > 0.55) dpit = 0;
    var g = proc * 0.85;
    var sT = this.swayTarget, sR = this.swayRotTarget;
    sT.x = M.clamp(sT.x + dyaw * g * 0.95, -0.058, 0.058);
    sT.y = M.clamp(sT.y - dpit * g * 0.80, -0.048, 0.048);
    sR.y = M.clamp(sR.y - dyaw * g * 2.40, -0.21, 0.21);
    sR.x = M.clamp(sR.x - dpit * g * 2.00, -0.17, 0.17);
    sR.z = M.clamp(sR.z + dyaw * g * 1.40, -0.14, 0.14);
    var dec = Math.exp(-9.5 * dt);
    sT.multiplyScalar(dec); sR.multiplyScalar(dec);
    this.sway.to(sT.x, sT.y, 0, 0.100, dt);
    this.swayRot.to(sR.x, sR.y, sR.z, 0.115, dt);
    p.x += this.sway.x.v; p.y += this.sway.y.v;
    r.x += this.swayRot.x.v; r.y += this.swayRot.y.v; r.z += this.swayRot.z.v;

    // --- recoil springs + landing impulse ---------------------------------
    this.kick.to(0, 0, 0, 0.088, dt);
    this.kickRot.to(0, 0, 0, 0.105, dt);
    p.x += this.kick.x.v; p.y += this.kick.y.v; p.z += this.kick.z.v;
    r.x += this.kickRot.x.v; r.y += this.kickRot.y.v; r.z += this.kickRot.z.v;
    if (pl) {
      if (this._wasAir && state !== 'air') this.land.v -= 0.032;
      this._wasAir = (state === 'air');
    }
    this.land.to(0, 0.145, dt);
    p.y += this.land.v;

    this.rig.position.copy(p);
    _e1.set(r.x, r.y, r.z, 'YXZ');
    this.rig.quaternion.setFromEuler(_e1);

    // --- field of view -----------------------------------------------------
    if (ctx.viewCamera) {
      var vf = M.lerp(w.hipFov, w.adsFov, this.adsEase);
      if (this.inspectT > 0) vf = M.lerp(vf, w.inspectFov || w.hipFov, M.smootherstep(0, 1, this.inspectT));
      if (Math.abs(ctx.viewCamera.fov - vf) > 1e-3) {
        ctx.viewCamera.fov = vf; ctx.viewCamera.updateProjectionMatrix();
      }
    }
    // Main-camera ADS zoom. A controller that wants to own this can set
    // player.ownsAdsFov = true and we stay out of the way.
    if (ctx.camera && !(pl && pl.ownsAdsFov)) {
      if (this.adsEase > 0.0008) {
        if (this._camBaseFov === null || this._camBaseFov === undefined) this._camBaseFov = ctx.camera.fov;
        var tf = M.lerp(this._camBaseFov, this._camBaseFov * w.adsZoom, this.adsEase);
        if (Math.abs(ctx.camera.fov - tf) > 1e-3) { ctx.camera.fov = tf; ctx.camera.updateProjectionMatrix(); }
      } else if (this._camBaseFov !== null && this._camBaseFov !== undefined) {
        if (Math.abs(ctx.camera.fov - this._camBaseFov) > 1e-3) {
          ctx.camera.fov = this._camBaseFov; ctx.camera.updateProjectionMatrix();
        }
        this._camBaseFov = null;
      }
    }
  };

  // ---- moving parts --------------------------------------------------------
  WeaponSystem.prototype._subAnim = function (dt) {
    var m = this.model;
    if (!m) return;
    // shot dispersion recovers continuously between shots
    this.bloom = M.damp(this.bloom, 0, this.current.bloom.decay, dt);
    // bolt / slide reciprocation: 1 -> 0 over one cycle, back then forward.
    // On an empty magazine the carrier stays locked to the rear.
    this.boltT = Math.max(0, this.boltT - dt / 0.055);
    var travel = this.boltLocked ? 1 : Math.sin(PI * (1 - M.saturate(this.boltT)));
    if (!this.boltLocked && this.boltT <= 0) travel = 0;
    if (m.bolt) m.bolt.position.z = travel * (this.current.kind === 'pistol' ? 0.024 : 0.050);
    // ejection port dust cover: snaps open on the first shot, closes when cold
    var wantOpen = (this.sinceFire < 2.6 || this.boltLocked) ? 1 : 0;
    this.coverOpen = M.damp(this.coverOpen, wantOpen, wantOpen ? 26 : 3.2, dt);
    if (m.cover) m.cover.rotation.z = -1.42 * this.coverOpen;
    // trigger blade
    this.triggerPull = M.damp(this.triggerPull, this.triggerHeld && this.current.ammo > 0 ? 1 : 0, 30, dt);
    if (m.trigger) m.trigger.rotation.x = -0.30 * this.triggerPull;
    // charging handle
    if (m.charge) m.charge.position.z = this.chargeT * 0.092;
    if (this.state !== 'reload') this.chargeT = M.damp(this.chargeT, 0, 18, dt);
    // magazine
    if (m.mag) {
      m.mag.position.copy(this.magOffset);
      m.mag.visible = (this.magVisible === undefined) ? true : this.magVisible;
    }
    // hands return to their rest pose outside the reload
    if (m.lhand && this.state !== 'reload') {
      m.lhand.position.multiplyScalar(Math.exp(-11 * dt));
      m.lhand.rotation.set(m.lhand.rotation.x * Math.exp(-11 * dt),
        m.lhand.rotation.y * Math.exp(-11 * dt), m.lhand.rotation.z * Math.exp(-11 * dt));
    }
  };

  WeaponSystem.prototype._lights = function (dt, ctx) {
    if (!this._lightsChecked) this._ensureViewLights(ctx);
    // Scale the private environment with the sun so the weapon dims into dusk
    // and night with the rest of the world instead of glowing on its own.
    if (this.viewEnv && ctx.sky && isFinite(ctx.sky.sunIntensity)) {
      var k = M.clamp(ctx.sky.sunIntensity / SKY_REF, 0.06, 1.6);
      if (Math.abs(k - this._envK) > 0.01) {
        this._envK = k;
        for (var mn in this.mats) {
          var mm = this.mats[mn];
          if (mm && mm.userData && mm.userData.baseEnv !== undefined) {
            mm.envMapIntensity = mm.userData.baseEnv * k;
          }
        }
      }
    }
    // Swing the viewmodel key light with the world sun so the gun's highlights
    // agree with the scene instead of floating in their own studio.
    if (this.keyLight && ctx.sky && ctx.sky.sunDirection && ctx.camera) {
      _v1.copy(ctx.sky.sunDirection);
      _q1.copy(ctx.camera.quaternion).invert();
      _v1.applyQuaternion(_q1);
      if (_v1.y < 0.18) _v1.y = 0.18;         // never light the gun from below
      _v1.normalize();
      this.keyLight.position.copy(_v1).multiplyScalar(3.0);
      if (ctx.sky.sunColor) this.keyLight.color.copy(ctx.sky.sunColor);
      if (isFinite(ctx.sky.sunIntensity)) this.keyLight.intensity = ctx.sky.sunIntensity * KEY_MUL;
      if (this.rimLight) this.rimLight.position.set(-_v1.x * 2.4, 0.6, -_v1.z * 2.4 - 1.2);
    }
    // The camera-side bounce tracks the sun's LEVEL but never its direction: it
    // stands in for light coming back off the street into the shooter's own
    // side of the weapon, so it has to dim into dusk and night with everything
    // else or the gun glows on its own after dark. This runs OUTSIDE the
    // keyLight block on purpose - when lighting.js owns the rig the card is the
    // only light this module contributes and there is no keyLight to gate it.
    if (this.faceLight && ctx.sky && isFinite(ctx.sky.sunIntensity)) {
      this.faceLight.intensity = ctx.sky.sunIntensity * (this._faceMul || 0.085);
    }
    // match the environment orientation to the world so reflections track
    if (ctx.viewScene && ctx.viewScene.environmentRotation && ctx.camera) {
      try { ctx.viewScene.environmentRotation.copy(ctx.camera.rotation); } catch (e) { /* older three */ }
    }
    if (this.flashLight) {
      this.flashLight.intensity = M.damp(this.flashLight.intensity, 0, 34, dt);
      if (this.flashLight.intensity < 0.01) this.flashLight.intensity = 0;
    }
  };

  // ==========================================================================
  // 12. Public API
  // ==========================================================================

  WeaponSystem.prototype.fire = function () {
    var ctx = this.ctx, w = this.current, m = this.model;
    if (!w || !m) return false;
    if (this.state === 'reload' || this.state === 'switch') return false;
    if (this.time < this.nextFireTime) return false;
    if (this.inspecting) this.inspect(false);
    if (w.ammo <= 0) {
      this.nextFireTime = this.time + 0.30;
      this._sfx('dryfire');
      if (w.reserve > 0) this.reload();
      return false;
    }
    // a burst that has been quiet for a moment restarts the pattern
    if (this.sinceFire > 0.32) this.shotIndex = 0;
    else this.shotIndex = Math.min(this.shotIndex + 1, w.pattern.length - 1);

    this.nextFireTime = this.time + w.fireInterval;
    this.sinceFire = 0;
    w.ammo--;

    this._fdir = this._fdir || new THREE.Vector3();
    this._fmuz = this._fmuz || new THREE.Vector3();
    this._forg = this._forg || new THREE.Vector3();
    this._fej = this._fej || new THREE.Vector3();
    this._fejd = this._fejd || new THREE.Vector3();
    this._fend = this._fend || new THREE.Vector3();

    var dir = this.getSpreadDirection(this._fdir);
    this.muzzleWorldPosition(this._fmuz);
    // Ballistics traces from the eye so the shot always matches the crosshair;
    // the tracer is drawn from the visible muzzle. That is how shooters do it.
    if (ctx.camera) { ctx.camera.updateMatrixWorld(); this._forg.setFromMatrixPosition(ctx.camera.matrixWorld); }
    else this._forg.copy(this._fmuz);

    var hits = null;
    if (ctx.ballistics && ctx.ballistics.fireShot) {
      try { hits = ctx.ballistics.fireShot(this._forg, dir, w); }
      catch (e) { GAME.logError('weapons.fireShot', e); }
    }
    this._fend.copy(this._forg).addScaledVector(dir, w.range);
    if (hits && hits.length && hits[0] && hits[0].point) this._fend.copy(hits[0].point);

    if (ctx.vfx) {
      try {
        if (ctx.vfx.muzzleFlash) ctx.vfx.muzzleFlash(this._fmuz, dir, w);
        if (ctx.vfx.tracer && (this.shotIndex % Math.max(1, w.tracerEvery)) === 0) {
          ctx.vfx.tracer(this._fmuz, this._fend, w.muzzleVelocity);
        }
        if (ctx.vfx.ejectShell) {
          this.ejectWorldPosition(this._fej);
          // shells leave to the right and slightly rearward, in world space
          if (ctx.camera) {
            _m1.extractRotation(ctx.camera.matrixWorld);
            this._fejd.set(0.86, 0.42, 0.28).applyMatrix4(_m1).normalize();
          } else this._fejd.set(1, 0.4, 0).normalize();
          ctx.vfx.ejectShell(this._fej, this._fejd, w);
        }
      } catch (e) { GAME.logError('weapons.vfx', e); }
    }
    if (ctx.audio && ctx.audio.playGunshot) {
      try { ctx.audio.playGunshot(w, this._fmuz); } catch (e) { GAME.logError('weapons.audio', e); }
    }
    if (ctx.postfx && ctx.postfx.addImpulse) {
      try { ctx.postfx.addImpulse('shake', w.recoil.shake * M.lerp(1, 0.6, this.adsEase)); }
      catch (e) { /* postfx optional */ }
    }

    // ---- recoil ------------------------------------------------------------
    var pat = w.pattern[this.shotIndex] || { v: 1, h: 0 };
    var rc = w.recoil;
    var adsMul = M.lerp(1, 0.80, this.adsEase);
    this.recoilKick.p += rc.camPitch * pat.v * adsMul;
    this.recoilKick.y += rc.camYaw * pat.h * adsMul;
    this.recoilRecover.p += rc.camPitch * pat.v * adsMul * rc.recover;
    this.recoilRecover.y += rc.camYaw * pat.h * adsMul * rc.recover;

    var kk = M.lerp(1, 0.60, this.adsEase);
    this.kick.z.v += rc.kickBack * kk;
    this.kick.y.v += rc.kickUp * kk;
    this.kick.x.v += this.rng.gaussian(0, 1) * 0.0035 * kk;
    this.kickRot.x.v += rc.pitch * kk * (0.70 + pat.v * 0.45);
    this.kickRot.y.v += rc.yaw * kk * pat.h;
    this.kickRot.z.v += rc.roll * kk * (0.55 + this.rng.range(-0.45, 0.45));

    this.bloom = Math.min(w.bloom.max, this.bloom + w.bloom.perShot);

    // ---- mechanism ---------------------------------------------------------
    this.boltT = 1;
    this.coverOpen = 1;
    if (w.ammo <= 0) this.boltLocked = true;
    if (this.flashLight && m.muzzle) {
      this.rig.updateMatrixWorld(true);
      this.flashLight.position.setFromMatrixPosition(m.muzzle.matrixWorld);
      GAME.Color.kelvin(2400, this.flashLight.color);
      this.flashLight.intensity = w.kind === 'pistol' ? 3.6 : 5.2;
    }
    this._pushAmmo();
    if (ctx.bus && ctx.bus.emit) ctx.bus.emit('weapon:fire', w, this._fmuz);
    return true;
  };

  WeaponSystem.prototype.reload = function () {
    var w = this.current;
    if (!w || this.state === 'reload' || this.state === 'switch') return false;
    if (w.reserve <= 0) return false;
    if (w.ammo >= w.magSize + (w.ammo > 0 ? 1 : 0) && w.ammo >= w.magSize) return false;
    this.reloadEmpty = w.ammo <= 0;
    this.reloadDur = this.reloadEmpty ? w.reload.empty : w.reload.tactical;
    this.state = 'reload';
    this.stateT = 0;
    this.reloadDone = false;
    this._dropped = false;
    this.adsT = 0;
    this.inspect(false);
    this._sfx('reload_start');
    if (this.ctx.bus && this.ctx.bus.emit) this.ctx.bus.emit('weapon:reload', w);
    return true;
  };

  WeaponSystem.prototype.switchTo = function (i) {
    if (!this.weapons.length) return false;
    var n = this.weapons.length;
    i = (((i | 0) % n) + n) % n;
    if (this.state === 'switch') return false;
    if (i === this.index) return false;
    if (this.state === 'reload') {          // cancelling a reload is allowed
      this.state = 'idle'; this.magVisible = true; this.magOffset.set(0, 0, 0);
    }
    this.pendingIndex = i;
    this.state = 'switch';
    this.stateT = 0;
    this.holsterDur = this.current ? this.current.holsterTime : 0.25;
    this.drawDur = this.weapons[i].drawTime;
    this.adsT = 0;
    this.inspect(false);
    this._sfx('weapon_switch');
    return true;
  };

  WeaponSystem.prototype._commitSwitch = function () {
    var i = this.pendingIndex;
    this.pendingIndex = -1;
    if (i < 0 || i >= this.weapons.length) return;
    if (this.model) this.model.root.visible = false;
    this.index = i;
    this.current = this.weapons[i];
    this.model = this.models[i];
    if (this.model) this.model.root.visible = true;
    this.shotIndex = 0;
    this.bloom = 0;
    this.boltLocked = this.current.ammo <= 0;
    this.magVisible = true;
    this.magOffset.set(0, 0, 0);
    this.kick.reset(); this.kickRot.reset();
    this._pushAmmo();
  };

  // on = true/undefined -> aim. instant skips the transition (capture path).
  WeaponSystem.prototype.setADS = function (on, instant) {
    this._adsWanted = (on === undefined) ? true : !!on;
    if (instant) {
      this.adsT = this._adsWanted ? 1 : 0;
      this.adsEase = this.adsT;
      if (this.ctx.viewCamera && this.current) {
        this.ctx.viewCamera.fov = M.lerp(this.current.hipFov, this.current.adsFov, this.adsEase);
        this.ctx.viewCamera.updateProjectionMatrix();
      }
    }
    return this._adsWanted;
  };

  WeaponSystem.prototype.inspect = function (on) {
    this.inspecting = (on === undefined) ? true : !!on;
    if (this.inspecting) { this._adsWanted = false; this.adsT = 0; this.adsEase = 0; }
    return this.inspecting;
  };

  // World-space position of the visible muzzle. viewScene coordinates are
  // camera-relative, so the round trip is viewCamera^-1 then camera.
  WeaponSystem.prototype._viewToWorld = function (out) {
    var ctx = this.ctx;
    if (ctx.viewCamera) {
      ctx.viewCamera.updateMatrixWorld();
      out.applyMatrix4(_m2.copy(ctx.viewCamera.matrixWorld).invert());
    }
    if (ctx.camera) {
      ctx.camera.updateMatrixWorld();
      out.applyMatrix4(ctx.camera.matrixWorld);
    }
    return out;
  };

  WeaponSystem.prototype.muzzleWorldPosition = function (out) {
    out = out || new THREE.Vector3();
    var m = this.model;
    if (!m || !m.muzzle) {
      if (this.ctx.camera) out.setFromMatrixPosition(this.ctx.camera.matrixWorld);
      else out.set(0, 0, 0);
      return out;
    }
    this.rig.updateMatrixWorld(true);
    out.setFromMatrixPosition(m.muzzle.matrixWorld);
    return this._viewToWorld(out);
  };

  WeaponSystem.prototype.ejectWorldPosition = function (out) {
    out = out || new THREE.Vector3();
    var m = this.model;
    if (!m || !m.eject) return this.muzzleWorldPosition(out);
    this.rig.updateMatrixWorld(true);
    out.setFromMatrixPosition(m.eject.matrixWorld);
    return this._viewToWorld(out);
  };

  // Cone half-angle in radians: designed base + per-shot bloom + movement,
  // large from the hip, effectively nil aimed and stationary.
  WeaponSystem.prototype.currentSpread = function () {
    var w = this.current;
    if (!w) return 0.002;
    var s = w.spread, ads = this.adsEase;
    var a = s.base + this.bloom * M.lerp(1, 0.45, ads);
    a += s.hip * (1 - ads);
    var pl = this.ctx.player;
    if (pl) {
      var sp = (typeof pl.speed === 'number') ? pl.speed
        : (pl.velocity ? Math.sqrt(pl.velocity.x * pl.velocity.x + pl.velocity.z * pl.velocity.z) : 0);
      a += s.move * M.clamp(sp / 4.2, 0, 1) * M.lerp(1, 0.30, ads);
      if (pl.state === 'air') a += s.air;
      else if (pl.state === 'crouch' || pl.state === 'slide') a *= s.crouch;
    }
    return Math.max(0.00022, a);
  };

  WeaponSystem.prototype.getSpreadDirection = function (out) {
    out = out || new THREE.Vector3();
    var ctx = this.ctx;
    if (!ctx.camera) return out.set(0, 0, -1);
    ctx.camera.updateMatrixWorld();
    ctx.camera.getWorldDirection(this._tmpA);
    var a = this.currentSpread();
    if (a > 1e-5 && ctx.rng && ctx.rng.inCone) ctx.rng.inCone(this._tmpA, a, out);
    else out.copy(this._tmpA);
    return out.normalize();
  };

  WeaponSystem.prototype.resize = function (w, h, ctx) {
    ctx = ctx || this.ctx;
    if (ctx.viewCamera && this.current) {
      ctx.viewCamera.fov = M.lerp(this.current.hipFov, this.current.adsFov, this.adsEase);
      ctx.viewCamera.updateProjectionMatrix();
    }
  };

  GAME.WeaponSystem = WeaponSystem;


})(window.GAME, window.THREE);
