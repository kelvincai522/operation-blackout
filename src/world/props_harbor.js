// ============================================================================
// OPERATION BLACKOUT - LEVEL 2 "COLD HARBOR" - set dressing
// Module owner: props_harbor.  Exports GAME.PropsHarbor.
//
// A container terminal at 02:00 in a storm.  Level 1 sold its atmosphere with
// dust; this one sells it with WATER, and the props carry more than half of
// that: a dry crate in a downpour destroys the illusion faster than any
// lighting mistake.
//
// Design constraints that shaped the code:
//   * < 80 draw calls for ALL props.  Everything repeated goes through
//     THREE.InstancedMesh; everything one-off is merged per material into a
//     handful of static batches.
//   * Nothing floats.  Every placement raycasts down against ctx.level, and
//     every site is rejected if a level collider already occupies it - which
//     is what lets this file dress a level (level_harbor.js) that is being
//     written in parallel and whose exact metres are not knowable here.
//   * Nothing is scattered uniformly.  Litter banks against the DOWNWIND face
//     of the fence, pallets stack against walls, water pools in the low spots
//     the apron camber makes, wear appears on the walking lines, weed and scum
//     collect at the quay lip.
//   * Everything exposed is WET.  A single shared shader snippet biases
//     roughness and albedo by surface orientation (up-facing surfaces hold a
//     film, undersides stay dry) scaled by ctx.weather.wetness, and the same
//     value is baked into the vertex-colour G channel for anyone downstream
//     who wants it.
//   * Cloth, rope, chain, net and fence-caught litter move in the wind, driven
//     by ctx.weather.windDir / windSpeed when weather exists.
//   * Every cross-module call is guarded.  ctx.level, ctx.textures, ctx.materials
//     and ctx.weather may all be missing or broken; we degrade, never throw.
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  if (!GAME || !THREE) return;

  var M = GAME.Math;
  var Geo = GAME.Geo;

  // --------------------------------------------------------------------------
  // Scratch.  Build-time code runs thousands of placements; a Matrix4 per
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
  var _vb = new THREE.Vector3();
  var _vc = new THREE.Vector3();
  var _vd = new THREE.Vector3();
  var _col = new THREE.Color();
  var _bmin = new THREE.Vector3();
  var _bmax = new THREE.Vector3();
  var _rayO = new THREE.Vector3();
  var _rayD = new THREE.Vector3(0, -1, 0);

  var UP = new THREE.Vector3(0, 1, 0);
  var SIDE_X = new THREE.Vector3(1, 0, 0);
  var WHITE = new THREE.Color(1, 1, 1);

  // --------------------------------------------------------------------------
  // Tinting.
  //
  // An InstancedMesh colour and a material colour BOTH multiply the albedo map,
  // and the library material already carries a calibrated gain solved from its
  // own map.  Writing a real mid-tone hex into both squares the albedo and the
  // prop renders as a cut-out silhouette.  So every tint here is normalised by
  // its own max channel and pulled back toward white: the hex becomes a HUE
  // SHIFT, not a second coat of paint.  Same helper as props.js/level.js,
  // deliberately, so the two levels agree.
  // --------------------------------------------------------------------------
  var _tc = new THREE.Color();
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
  // Transform helpers
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

  // Matrix mapping a unit-height Y-up primitive onto the segment a->b.  "From
  // here to there" is the natural description for a brace, a conduit or a
  // hydraulic ram; an Euler is not.
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

  function mergeParts(parts, uvScale) {
    if (!parts || !parts.length) return null;
    var g = null;
    try { g = Geo.mergeAll(parts); }
    catch (e) { GAME.logError('propsH.merge', e); return null; }
    if (!g) return null;
    if (uvScale) {
      try { Geo.worldUV(g, uvScale); } catch (e2) { GAME.logError('propsH.worldUV', e2); }
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

  // Displace every vertex by fbm.  The cheapest way to stop a primitive reading
  // as a primitive: a drum that has been kicked around a working quay for ten
  // years does not have a perfectly circular section.
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

  // A closed 2D profile extruded along Z with fan-triangulated caps.  Jersey
  // barriers, kerbs, channel sections, corrugated brackets - anything with a
  // recognisable cross-section.
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
  // TubeBuilder - swept tubes carrying a per-vertex wind-flex attribute.
  // three.js TubeGeometry cannot carry a custom attribute through mergeAll, and
  // every mooring rope on the quay has to be ONE mesh, so we sweep our own.
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

  // Parabolic catenary.  Indistinguishable from cosh() at the sags real rope
  // and chain actually have, and far cheaper.
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
  // Shader plumbing
  //
  // WETNESS IS NOT OURS.  materials.js owns the wet layer for this level: it
  // reads ctx.weather every frame, and every DEFS entry in the harbor set
  // carries its own solved wetDark / wetRough / puddle / streak constants,
  // driven off world position and world normal.  Injecting a second wetness
  // pass here would double-darken every surface and fight a calibrated model
  // with a guess.  What this file contributes instead is the PER-VERTEX
  // channel that model multiplies on top of - see paintWear() below.
  //
  // What we do inject is WIND, because the library's built-in sway is a
  // few-centimetre foliage flutter and a tarpaulin in a gale is not that.
  // The injection CHAINS onto the library's own onBeforeCompile rather than
  // replacing it: materials.js does triplanar projection, detail normals,
  // parallax and the whole wet layer in there, and clobbering it turns a
  // calibrated surface into flat plastic.  Program identity is controlled with
  // customProgramCacheKey, which three.js uses in preference to
  // onBeforeCompile.toString(), so the per-material closures below do not each
  // get their own compiled program.
  // ==========================================================================

  // uWind = (amplitude m, frequency rad/s, vertical billow, spatial phase).
  // uWindDir = (x, z) of the prevailing wind, so rope and cloth stream the same
  // way the rain does instead of waving in an arbitrary direction.
  var WIND_VERT_PARS = [
    'uniform float hbTime;',
    'uniform vec4 hbWind;',
    'uniform vec2 hbWindDir;',
    'attribute float aFlex;'
  ].join('\n');

  var WIND_VERT_BODY = [
    'vec3 hbOrg = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;',
    '#ifdef USE_INSTANCING',
    'hbOrg = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;',
    '#endif',
    'vec3 hbP = hbOrg + transformed;',
    // Storm gusting: a slow travelling envelope so the whole quay does not
    // breathe in unison, plus a faster ripple running along each object.
    'float hbG = 0.58 + 0.42 * sin( hbTime * 0.53 + hbP.x * 0.062 + hbP.z * 0.047 );',
    'hbG *= 0.78 + 0.22 * sin( hbTime * 0.171 + hbP.z * 0.026 - hbP.x * 0.019 );',
    'float hbPh = hbTime * hbWind.y + ( hbP.x * 0.31 + hbP.z * 0.23 ) * hbWind.w;',
    'float hbS1 = sin( hbPh );',
    'float hbS2 = sin( hbPh * 2.31 + 1.7 );',
    'float hbS3 = sin( hbPh * 4.70 + hbP.y * 5.3 + hbP.x * 1.9 );',
    'float hbA = hbWind.x * aFlex * hbG;',
    // A steady lean downwind PLUS the oscillation about it.  Cloth in a gale
    // does not swing symmetrically about its rest pose; it is pushed and held.
    'transformed.x += hbA * ( hbWindDir.x * 0.85 + hbS1 * 0.62 + hbS2 * 0.17 );',
    'transformed.z += hbA * ( hbWindDir.y * 0.85 + hbS2 * 0.42 - hbS1 * 0.13 );',
    'transformed.y += hbA * hbWind.z * ( hbS3 * 0.50 - 0.26 );'
  ].join('\n');

  // Anchors, most-correct first.  Falls through if the library already consumed
  // the include (its own wind path replaces begin_vertex, so project_vertex is
  // the backstop - `transformed` is still live there).
  var WIND_V_ANCHOR = ['#include <begin_vertex>', '#include <project_vertex>'];

  function injectAfter(src, anchors, code) {
    for (var i = 0; i < anchors.length; i++) {
      if (src.indexOf(anchors[i]) >= 0) {
        return { src: src.replace(anchors[i], anchors[i] + '\n' + code), idx: i };
      }
    }
    return { src: src, idx: -1 };
  }
  // Chain a compile step onto a material without losing the library's own.
  //
  // ORDER MATTERS: materials.js overrides clone() to reinstate its
  // onBeforeCompile on the copy, so this must be applied AFTER cloning or it
  // is silently discarded.
  function chainCompile(mat, key, fn) {
    var prev = (mat.onBeforeCompile && mat.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile)
      ? mat.onBeforeCompile : null;
    var prevKey = mat.customProgramCacheKey;
    var hadKey = typeof prevKey === 'function' &&
      prevKey !== THREE.Material.prototype.customProgramCacheKey;
    mat.onBeforeCompile = function (shader, renderer) {
      if (prev) { try { prev.call(mat, shader, renderer); } catch (e) { GAME.logError('propsH.chain', e); } }
      try { fn(shader, mat); } catch (e2) { GAME.logError('propsH.inject', e2); }
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
    mat.userData.hbTime = uTime;
    mat.userData.hbWind = uWind;
    return chainCompile(mat, 'hbwind' + (keySuffix || ''), function (shader) {
      shader.uniforms.hbTime = uTime;
      shader.uniforms.hbWind = uWind;
      shader.uniforms.hbWindDir = uWindDir;
      var v = injectAfter(shader.vertexShader, WIND_V_ANCHOR, WIND_VERT_BODY);
      if (v.idx < 0) return;
      shader.vertexShader = v.src.replace('#include <common>', '#include <common>\n' + WIND_VERT_PARS);
    });
  }

  // Alpha-tested cloth with a rigid shadow is a very obvious tell, so anything
  // that moves gets a depth material running the SAME displacement.
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

  // ---- the wear / wetness vertex channel -----------------------------------
  //
  // materials.js get(name, {vertexColors:true}) reads the geometry `color`
  // attribute as a WEAR MASK, white = pristine, each channel darkening toward a
  // different kind of damage:
  //
  //     R -> grime      G -> WETNESS      B -> edge wear / exposed substrate
  //
  // So wetness is written as 1 - wet, not wet.  Getting that inverted paints a
  // soaking quay bone dry, which is exactly the failure this level cannot
  // afford, hence the arithmetic living in one function with its own name.
  //
  // The defaults are physical rather than decorative:
  //   * up-facing surfaces hold a film and go near-mirror; undersides and
  //     steep overhangs stay comparatively dry.  That contrast is what makes
  //     rain read on a still frame - a uniformly soaked prop reads as dipped.
  //   * grime collects low down and in the crevices, where spray and tyre
  //     wash throw it.
  //   * edge wear appears on the up-facing edges and the outer extremities -
  //     the corners hands, forks and chains actually hit.
  //
  // NOTE: Geo.mergeAll drops custom attributes but KEEPS nothing but position/
  // normal/uv, so merged static geometry must be painted AFTER the merge.  Every
  // caller here does.
  function paintWear(geo, o) {
    var p = geo.attributes.position, n = geo.attributes.normal;
    if (!p || !n) return geo;
    o = o || {};
    var wet = o.wet === undefined ? 1.0 : o.wet;         // 0..1 exposure scale
    var grime = o.grime === undefined ? 0.24 : o.grime;
    var edge = o.edge === undefined ? 0.16 : o.edge;
    var noise = o.noise || null;
    var ph = o.seed || 0;
    var loY = o.loY === undefined ? 0 : o.loY;
    var hiY = o.hiY === undefined ? 1.6 : o.hiY;
    var c = new Float32Array(p.count * 3);
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      var up = n.getY(i) * 0.5 + 0.5;
      // exposure: 0.30 on a pure underside, 1.0 on a pure up-face
      var expo = 0.30 + 0.70 * up * up;
      var w = M.saturate(wet * expo);
      // grime is heaviest at the base and lightest at the top
      var lowness = 1 - M.saturate((y - loY) / Math.max(0.2, hiY - loY));
      var gr = grime * (0.35 + 0.9 * lowness * lowness);
      // edge wear rides the up-facing extremities
      var reach = M.saturate((Math.sqrt(x * x + z * z) - 0.1) * 1.6);
      var ed = edge * (0.25 + 0.85 * reach) * (0.35 + 0.75 * M.saturate(n.getY(i)));
      if (noise) {
        var nv = noise.fbm3(x * 2.3 + ph, y * 2.3, z * 2.3 - ph, 3, 2.1, 0.55);
        gr = M.saturate(gr * (1 + nv * 0.9));
        ed = M.saturate(ed * (1 + nv * 1.1));
        w = M.saturate(w * (1 + nv * 0.18));
      }
      c[i * 3] = M.saturate(1 - gr);
      c[i * 3 + 1] = M.saturate(1 - w);       // <- G is INVERTED wetness
      c[i * 3 + 2] = M.saturate(1 - ed);
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
      1 - rng.range(0, 0.14),      // wetness
      1 - rng.range(0, 0.16));     // edge wear
    return out;
  }

  // ==========================================================================
  // Batch - thin wrapper over InstancedMesh that counts up as you place.
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
    this.mesh.name = name || 'harbor_inst';
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    try { this.mesh.computeBoundingSphere(); } catch (e) { /* older three */ }
    parent.add(this.mesh);
    return this.mesh;
  };

  // ==========================================================================
  // Local texture kit.
  //
  // Generic surfaces (steel, concrete, rubber, rope) come from ctx.materials by
  // the names the level contract fixes.  Everything in here is props-specific
  // ART the shared library cannot know about: hazard diagonals, chain-link and
  // cargo-net alphas, coated tarpaulin, the invented terminal branding, litter,
  // gull plumage, ripple normals.
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

  TX.normalFromHeight = function (h, size, strength) {
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

  TX.heightFromCanvas = function (canvas) {
    var g = canvas.getContext('2d');
    var d = g.getImageData(0, 0, canvas.width, canvas.height).data;
    var n = canvas.width * canvas.height;
    var h = new Float32Array(n);
    for (var i = 0; i < n; i++) h[i] = d[i * 4] / 255;
    return h;
  };

  // Packed ORM (r = AO, g = roughness, b = metalness) - glTF convention, which
  // is what MeshStandardMaterial samples when the same texture is assigned to
  // aoMap / roughnessMap / metalnessMap.
  TX.orm = function (size, fn) {
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

  // Shared tileable grunge, composited as a multiply layer under everything
  // generated locally.  One field is an order of magnitude cheaper than running
  // fbm per pixel per material.
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

  // Rust weeping downward from a seed point.  Every weld and fastener on a
  // marine steel surface bleeds; without this, steel reads as painted board.
  TX.rustStreaks = function (g, size, rng, count, alpha) {
    for (var i = 0; i < count; i++) {
      var x = rng.range(0, size), y = rng.range(0, size * 0.72);
      var len = rng.range(size * 0.08, size * 0.42);
      var w = rng.range(1.2, 4.5);
      var grd = g.createLinearGradient(x, y, x, y + len);
      var a = alpha * rng.range(0.5, 1);
      grd.addColorStop(0, 'rgba(126,66,32,' + a.toFixed(3) + ')');
      grd.addColorStop(0.35, 'rgba(104,52,26,' + (a * 0.72).toFixed(3) + ')');
      grd.addColorStop(1, 'rgba(72,38,22,0)');
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

  // ---- invented script -----------------------------------------------------
  // Deliberately NOT any real alphabet, company or logo: connected baseline
  // strokes with random ascenders and diacritic dots, which reads as "shipping
  // line branding in a language I do not speak" without impersonating anyone.
  TX.scriptRun = function (g, x, y, size, width, rng, weight) {
    g.lineWidth = Math.max(1, size * (weight || 0.15));
    g.lineCap = 'round';
    g.lineJoin = 'round';
    var cx = x, end = x + width, dots = [], guard = 0;
    g.beginPath();
    g.moveTo(cx, y);
    while (cx < end && guard++ < 60) {
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
      if (rng.bool(0.34)) dots.push([cx + w * 0.5, y - size * (rng.bool(0.6) ? 0.95 : -0.35), size * 0.09]);
      cx += w;
      if (rng.bool(0.14)) { cx += size * 0.35; g.moveTo(cx, y); }
    }
    g.stroke();
    for (var i = 0; i < dots.length; i++) {
      g.beginPath();
      g.arc(dots[i][0], dots[i][1], dots[i][2], 0, Math.PI * 2);
      g.fill();
    }
  };

  // Blocky stencil glyphs for serial numbers and unit codes.  Same idea, a
  // different hand: invented, monospaced, sprayed through a plate.
  TX.stencilRun = function (g, x, y, cell, count, rng) {
    for (var i = 0; i < count; i++) {
      var ox = x + i * cell * 1.16;
      var seg = rng.int(0, 63) | 1;
      g.lineWidth = Math.max(1, cell * 0.19);
      g.lineCap = 'butt';
      var h = cell * 1.5, w = cell * 0.82;
      // seven-segment-ish, but with the stencil bridges real stencils have
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

  // ---- hazard diagonals ----------------------------------------------------
  // Yellow/black, worn through to primer on the leading edge where forklift
  // tines and boots hit it.  Used on barriers, the skip, the bowser cabinet and
  // the spreader corner castings.
  TX.hazard = function (size, seed, grunge) {
    var c = TX.canvas(size, size);
    if (!c) return null;
    var g = c.getContext('2d');
    var rng = new GAME.RNG(seed);
    g.fillStyle = '#c8a534';
    g.fillRect(0, 0, size, size);
    g.save();
    g.translate(size * 0.5, size * 0.5);
    g.rotate(-Math.PI / 4);
    g.translate(-size, -size);
    var band = size * 0.19;
    g.fillStyle = '#1a1a1c';
    for (var i = 0; i < 16; i++) {
      g.fillRect(i * band * 2, 0, band, size * 2);
    }
    g.restore();
    // chipped paint: worley cells knocked back to grey primer
    g.globalAlpha = 0.5;
    for (var k = 0; k < 90; k++) {
      var x = rng.range(0, size), y = rng.range(0, size);
      var r = rng.range(1, 5.5);
      g.fillStyle = rng.bool(0.5) ? '#565a5e' : '#6b5a44';
      g.beginPath();
      g.ellipse(x, y, r, r * rng.range(0.5, 1.4), rng.range(0, 3.14), 0, 6.2832);
      g.fill();
    }
    g.globalAlpha = 1;
    TX.rustStreaks(g, size, rng, 14, 0.34);
    if (grunge) {
      g.globalCompositeOperation = 'multiply';
      g.globalAlpha = 0.5;
      g.drawImage(grunge, 0, 0, size, size);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
    }
    return c;
  };

  // ---- chain-link alpha ----------------------------------------------------
  // A real diamond mesh: two opposed helices of wire with the knuckle where
  // they cross.  Drawn once, tiled hard, and alpha tested - a fence painted as
  // a flat grey plane is one of the great giveaways of a cheap scene.
  TX.chainlink = function (size, seed) {
    var c = TX.canvas(size, size);
    if (!c) return null;
    var g = c.getContext('2d');
    var rng = new GAME.RNG(seed);
    g.clearRect(0, 0, size, size);
    var cells = 4;
    var step = size / cells;
    var lw = Math.max(1.4, size * 0.014);
    function wire(dirn, shade) {
      g.strokeStyle = shade;
      g.lineWidth = lw;
      g.lineCap = 'round';
      for (var i = -cells; i <= cells * 2; i++) {
        g.beginPath();
        for (var t = 0; t <= cells * 2; t++) {
          var x = (i + t * 0.5) * step;
          var y = t * step * 0.5;
          var wob = Math.sin(t * 1.7 + i) * step * 0.045;
          if (t === 0) g.moveTo(x + wob, y);
          else g.lineTo(x + dirn * 0 + wob, y);
        }
        g.stroke();
      }
    }
    // first helix runs down-right, second down-left; the second is drawn
    // slightly darker so the weave reads which wire is in front
    g.save();
    wire(1, 'rgba(150,156,162,1)');
    g.restore();
    g.save();
    g.translate(size, 0);
    g.scale(-1, 1);
    wire(-1, 'rgba(96,102,108,1)');
    g.restore();
    // knuckles at the crossings catch the lamps
    g.fillStyle = 'rgba(176,182,188,1)';
    for (var i2 = 0; i2 <= cells * 2; i2++) {
      for (var j = 0; j <= cells * 2; j++) {
        var kx = (i2 * 0.5) * step + (j % 2 ? step * 0.5 : 0);
        var ky = j * step * 0.5;
        g.beginPath();
        g.arc(kx % size, ky % size, lw * 0.72, 0, 6.2832);
        g.fill();
      }
    }
    // corrosion: a few wires gone dark and furred
    g.globalAlpha = 0.55;
    for (var r2 = 0; r2 < 26; r2++) {
      g.strokeStyle = 'rgba(112,58,30,1)';
      g.lineWidth = lw * rng.range(1.0, 1.9);
      g.beginPath();
      var sx = rng.range(0, size), sy = rng.range(0, size);
      g.moveTo(sx, sy);
      g.lineTo(sx + rng.range(-step, step), sy + rng.range(-step, step));
      g.stroke();
    }
    g.globalAlpha = 1;
    return c;
  };

  // ---- cargo net alpha -----------------------------------------------------
  TX.cargoNet = function (size, seed) {
    var c = TX.canvas(size, size);
    if (!c) return null;
    var g = c.getContext('2d');
    var rng = new GAME.RNG(seed);
    g.clearRect(0, 0, size, size);
    var cells = 6, step = size / cells;
    g.lineCap = 'round';
    for (var i = 0; i <= cells; i++) {
      for (var pass = 0; pass < 2; pass++) {
        g.strokeStyle = pass ? 'rgba(58,52,44,1)' : 'rgba(122,110,88,1)';
        g.lineWidth = Math.max(1.6, size * (pass ? 0.020 : 0.015));
        // hand-laid rope wanders
        g.beginPath();
        for (var t = 0; t <= 12; t++) {
          var f = t / 12;
          var w = Math.sin(f * 9 + i * 2.1) * step * 0.07;
          if (pass === 0) {
            if (t === 0) g.moveTo(0, i * step + w); else g.lineTo(f * size, i * step + w);
          } else {
            if (t === 0) g.moveTo(i * step + w, 0); else g.lineTo(i * step + w, f * size);
          }
        }
        g.stroke();
      }
    }
    // whipped knots at every intersection
    g.fillStyle = 'rgba(92,80,62,1)';
    for (var a = 0; a <= cells; a++) {
      for (var b = 0; b <= cells; b++) {
        g.beginPath();
        g.ellipse(a * step, b * step, size * 0.019, size * 0.026, rng.range(0, 3), 0, 6.2832);
        g.fill();
      }
    }
    return c;
  };

  // ---- coated tarpaulin ----------------------------------------------------
  // PVC-coated polyester: a woven scrim under a gloss coat, with seams, taped
  // hems, brass eyelets, a repair patch and the mildew that lives on anything
  // left lashed down through a winter.
  TX.tarp = function (size, seed, grunge, hue) {
    var c = TX.canvas(size, size);
    if (!c) return null;
    var g = c.getContext('2d');
    var rng = new GAME.RNG(seed);
    var base = hue || '#2f4a4e';
    g.fillStyle = base;
    g.fillRect(0, 0, size, size);
    // scrim weave
    g.globalAlpha = 0.16;
    for (var i = 0; i < size; i += 3) {
      g.fillStyle = i % 6 ? '#000000' : '#ffffff';
      g.fillRect(i, 0, 1.4, size);
      g.fillRect(0, i, size, 1.4);
    }
    g.globalAlpha = 1;
    // welded seams
    g.strokeStyle = 'rgba(0,0,0,0.30)';
    g.lineWidth = size * 0.010;
    for (var s = 1; s < 4; s++) {
      g.beginPath();
      g.moveTo(0, s * size / 4 + rng.range(-3, 3));
      g.lineTo(size, s * size / 4 + rng.range(-3, 3));
      g.stroke();
    }
    g.strokeStyle = 'rgba(255,255,255,0.10)';
    g.lineWidth = size * 0.004;
    for (var s2 = 1; s2 < 4; s2++) {
      g.beginPath();
      g.moveTo(0, s2 * size / 4 - size * 0.006);
      g.lineTo(size, s2 * size / 4 - size * 0.006);
      g.stroke();
    }
    // taped hem top and bottom
    g.fillStyle = 'rgba(0,0,0,0.24)';
    g.fillRect(0, 0, size, size * 0.045);
    g.fillRect(0, size * 0.955, size, size * 0.045);
    // brass eyelets along the hem
    for (var e = 0; e < 8; e++) {
      var ex = (e + 0.5) * size / 8;
      for (var side = 0; side < 2; side++) {
        var ey = side ? size * 0.975 : size * 0.025;
        g.fillStyle = '#8a7038';
        g.beginPath(); g.arc(ex, ey, size * 0.016, 0, 6.2832); g.fill();
        g.fillStyle = '#141618';
        g.beginPath(); g.arc(ex, ey, size * 0.008, 0, 6.2832); g.fill();
      }
    }
    // mildew and a patch
    g.globalAlpha = 0.30;
    for (var m2 = 0; m2 < 40; m2++) {
      g.fillStyle = rng.bool(0.6) ? '#3b4a36' : '#20262a';
      g.beginPath();
      g.ellipse(rng.range(0, size), rng.range(0, size), rng.range(3, 22), rng.range(3, 16),
        rng.range(0, 3.14), 0, 6.2832);
      g.fill();
    }
    g.globalAlpha = 1;
    var px = rng.range(size * 0.2, size * 0.6), py = rng.range(size * 0.2, size * 0.6);
    g.fillStyle = 'rgba(70,60,44,0.85)';
    g.fillRect(px, py, size * 0.18, size * 0.13);
    g.strokeStyle = 'rgba(20,20,20,0.7)';
    g.lineWidth = 1.5;
    g.setLineDash([4, 4]);
    g.strokeRect(px, py, size * 0.18, size * 0.13);
    g.setLineDash([]);
    if (grunge) {
      g.globalCompositeOperation = 'multiply';
      g.globalAlpha = 0.42;
      g.drawImage(grunge, 0, 0, size, size);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
    }
    return c;
  };

  // ---- terminal signage ----------------------------------------------------
  // Invented branding for an invented operator.  A reflective sign face is one
  // of the few things in a night scene that reliably reads at distance, so it
  // gets a real layout: a colour field, a rule, a script run and a stencilled
  // code, all half-eaten by salt.
  TX.sign = function (w, h, seed, grunge, scheme) {
    var c = TX.canvas(w, h);
    if (!c) return null;
    var g = c.getContext('2d');
    var rng = new GAME.RNG(seed);
    var S = scheme || { bg: '#123244', fg: '#cfe2ee', bar: '#c46a1e' };
    g.fillStyle = S.bg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = S.bar;
    g.fillRect(0, 0, w, h * 0.16);
    g.fillRect(0, h * 0.86, w, h * 0.14);
    g.fillStyle = S.fg;
    g.strokeStyle = S.fg;
    TX.scriptRun(g, w * 0.06, h * 0.50, h * 0.26, w * 0.62, rng, 0.16);
    g.globalAlpha = 0.9;
    TX.scriptRun(g, w * 0.06, h * 0.74, h * 0.13, w * 0.5, rng, 0.14);
    g.globalAlpha = 1;
    g.strokeStyle = S.fg;
    TX.stencilRun(g, w * 0.72, h * 0.34, h * 0.13, 5, rng);
    // bolt holes at the corners
    g.fillStyle = 'rgba(10,12,14,0.9)';
    var pad = Math.min(w, h) * 0.06;
    var corners = [[pad, pad], [w - pad, pad], [pad, h - pad], [w - pad, h - pad]];
    for (var i = 0; i < 4; i++) {
      g.beginPath(); g.arc(corners[i][0], corners[i][1], Math.min(w, h) * 0.022, 0, 6.2832); g.fill();
    }
    TX.rustStreaks(g, Math.max(w, h), rng, 10, 0.30);
    g.globalAlpha = 0.24;
    for (var d = 0; d < 30; d++) {
      g.fillStyle = '#d8dde2';
      g.beginPath();
      g.ellipse(rng.range(0, w), rng.range(0, h), rng.range(1, 6), rng.range(1, 4), 0, 0, 6.2832);
      g.fill();
    }
    g.globalAlpha = 1;
    if (grunge) {
      g.globalCompositeOperation = 'multiply';
      g.globalAlpha = 0.34;
      g.drawImage(grunge, 0, 0, w, h);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
    }
    return c;
  };

  // ---- litter atlas --------------------------------------------------------
  // Four cells: a torn sheet of packing paper, a shredded polythene bag, a
  // flattened carton flap, a strip of ripped strapping.  These are what a gale
  // pins against the downwind face of a perimeter fence.
  TX.litter = function (size, seed) {
    var c = TX.canvas(size, size);
    if (!c) return null;
    var g = c.getContext('2d');
    var rng = new GAME.RNG(seed);
    g.clearRect(0, 0, size, size);
    var hs = size / 2;
    function ragged(cx, cy, rw, rh, fill, jitter) {
      g.fillStyle = fill;
      g.beginPath();
      var n = 22;
      for (var i = 0; i <= n; i++) {
        var a = i / n * Math.PI * 2;
        var r = 1 + rng.range(-jitter, jitter);
        var x = cx + Math.cos(a) * rw * r;
        var y = cy + Math.sin(a) * rh * r;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath();
      g.fill();
    }
    // cell 0: packing paper
    ragged(hs * 0.5, hs * 0.5, hs * 0.40, hs * 0.34, '#b6ac96', 0.24);
    g.globalAlpha = 0.4;
    g.strokeStyle = '#7c735f'; g.lineWidth = 1.4;
    for (var i = 0; i < 7; i++) {
      g.beginPath();
      g.moveTo(hs * 0.14, hs * (0.22 + i * 0.09));
      g.lineTo(hs * 0.86, hs * (0.24 + i * 0.09) + rng.range(-3, 3));
      g.stroke();
    }
    g.globalAlpha = 1;
    // cell 1: polythene
    ragged(hs * 1.5, hs * 0.5, hs * 0.42, hs * 0.36, 'rgba(196,204,206,0.72)', 0.32);
    g.globalAlpha = 0.5;
    ragged(hs * 1.55, hs * 0.46, hs * 0.24, hs * 0.20, 'rgba(232,240,242,0.6)', 0.4);
    g.globalAlpha = 1;
    // cell 2: carton flap
    g.fillStyle = '#8a6f4c';
    g.save();
    g.translate(hs * 0.5, hs * 1.5);
    g.rotate(rng.range(-0.4, 0.4));
    g.fillRect(-hs * 0.36, -hs * 0.26, hs * 0.72, hs * 0.52);
    g.fillStyle = 'rgba(60,46,30,0.5)';
    for (var f = 0; f < 5; f++) g.fillRect(-hs * 0.36, -hs * 0.26 + f * hs * 0.11, hs * 0.72, 2);
    g.restore();
    // cell 3: strapping band
    g.strokeStyle = '#20303c';
    g.lineWidth = size * 0.035;
    g.beginPath();
    g.moveTo(hs * 1.12, hs * 1.80);
    g.bezierCurveTo(hs * 1.30, hs * 1.20, hs * 1.72, hs * 1.86, hs * 1.90, hs * 1.24);
    g.stroke();
    g.strokeStyle = 'rgba(180,200,210,0.35)';
    g.lineWidth = size * 0.008;
    g.stroke();
    return c;
  };

  // ---- seaweed / scum cards ------------------------------------------------
  TX.weed = function (size, seed) {
    var c = TX.canvas(size, size);
    if (!c) return null;
    var g = c.getContext('2d');
    var rng = new GAME.RNG(seed);
    g.clearRect(0, 0, size, size);
    g.lineCap = 'round';
    for (var i = 0; i < 46; i++) {
      var x0 = rng.range(size * 0.1, size * 0.9);
      var y0 = size * rng.range(0.86, 1.0);
      var len = rng.range(size * 0.18, size * 0.62);
      var lean = rng.range(-0.5, 0.5);
      g.strokeStyle = ['#2c3b26', '#39482a', '#233022', '#43441f'][rng.int(0, 3)];
      g.lineWidth = rng.range(2.5, 7.5);
      g.beginPath();
      g.moveTo(x0, y0);
      g.bezierCurveTo(x0 + lean * len * 0.4, y0 - len * 0.4,
        x0 + lean * len * 1.1, y0 - len * 0.75, x0 + lean * len * 1.4, y0 - len);
      g.stroke();
      if (rng.bool(0.4)) {
        g.lineWidth = rng.range(6, 13);
        g.globalAlpha = 0.75;
        g.beginPath();
        g.moveTo(x0 + lean * len * 0.5, y0 - len * 0.45);
        g.lineTo(x0 + lean * len * 0.9 + rng.range(-8, 8), y0 - len * 0.72);
        g.stroke();
        g.globalAlpha = 1;
      }
    }
    // foam scum along the top of the waterline
    g.globalAlpha = 0.5;
    for (var b = 0; b < 90; b++) {
      g.fillStyle = 'rgba(196,204,196,1)';
      g.beginPath();
      g.arc(rng.range(0, size), size * rng.range(0.88, 1.0), rng.range(1, 5), 0, 6.2832);
      g.fill();
    }
    g.globalAlpha = 1;
    return c;
  };

  // ---- gull plumage --------------------------------------------------------
  TX.gull = function (size, seed) {
    var c = TX.canvas(size, size);
    if (!c) return null;
    var g = c.getContext('2d');
    var rng = new GAME.RNG(seed);
    var grd = g.createLinearGradient(0, 0, 0, size);
    grd.addColorStop(0, '#d8dade');
    grd.addColorStop(0.45, '#b9bfc6');
    grd.addColorStop(0.62, '#6d757e');
    grd.addColorStop(1, '#3c4249');
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
    g.globalAlpha = 0.3;
    for (var i = 0; i < 260; i++) {
      g.fillStyle = rng.bool(0.5) ? '#ffffff' : '#5a6068';
      g.beginPath();
      g.ellipse(rng.range(0, size), rng.range(0, size), rng.range(1, 4), rng.range(0.6, 2), rng.range(0, 3), 0, 6.2832);
      g.fill();
    }
    g.globalAlpha = 1;
    // dark primaries band
    g.fillStyle = '#23282e';
    g.fillRect(0, size * 0.80, size, size * 0.20);
    return c;
  };

  // ---- ripple normal -------------------------------------------------------
  // Interfering circular wavefronts.  Scrolled and cross-faded at two scales in
  // update(), which is what stops a puddle reading as a mirror decal.
  TX.ripple = function (size, seed) {
    var noise = new GAME.Noise(seed);
    var h = new Float32Array(size * size);
    var inv = 1 / size;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var u = x * inv * Math.PI * 2, v = y * inv * Math.PI * 2;
        var n = noise.fbm3(Math.cos(u) * 2.6, Math.sin(u) * 2.6, Math.cos(v) * 2.6, 3, 2.2, 0.55);
        var w = noise.worley2(x * inv * 9, y * inv * 9, 1.0);
        // concentric rings around each cell centre = raindrop impact rings
        var ring = Math.sin(w.f1 * 34.0) * Math.exp(-w.f1 * 3.2);
        h[y * size + x] = M.saturate(0.5 + n * 0.28 + ring * 0.42);
      }
    }
    return TX.normalFromHeight(h, size, 1.35);
  };

  // ---- oil film ------------------------------------------------------------
  // Thin-film interference painted as swirling hue bands over near-black.  A
  // MeshPhysicalMaterial iridescence layer does the physics; this supplies the
  // varying film thickness that makes the bands wander.
  TX.oil = function (size, seed) {
    var c = TX.canvas(size, size);
    if (!c) return null;
    var g = c.getContext('2d');
    var noise = new GAME.Noise(seed);
    var img = g.createImageData(size, size);
    var d = img.data;
    var inv = 1 / size;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var u = x * inv * Math.PI * 2, v = y * inv * Math.PI * 2;
        var n = noise.fbm3(Math.cos(u) * 1.8, Math.sin(u) * 1.8, Math.cos(v) * 1.8, 4, 2.1, 0.55);
        var t = (n * 3.4 + 1.2);
        var r = 0.5 + 0.5 * Math.sin(t * 6.0);
        var gg = 0.5 + 0.5 * Math.sin(t * 6.0 + 2.1);
        var b = 0.5 + 0.5 * Math.sin(t * 6.0 + 4.2);
        var i = (y * size + x) * 4;
        // very dark base: the colour comes from the iridescence layer, not albedo
        d[i] = (0.045 + r * 0.055) * 255;
        d[i + 1] = (0.045 + gg * 0.055) * 255;
        d[i + 2] = (0.050 + b * 0.060) * 255;
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  };

  // ---- generic fallback surface -------------------------------------------
  // Used only when ctx.materials is unavailable or does not (yet) know a name
  // from the level contract.  Deliberately plain; the point is that a missing
  // library degrades to a plausible dark marine surface instead of magenta.
  TX.surface = function (size, grunge, spec, seed) {
    var c = TX.canvas(size);
    if (!c) return null;
    var g = c.getContext('2d');
    var rng = new GAME.RNG(seed || 5);
    g.fillStyle = spec.base || '#3a3f44';
    g.fillRect(0, 0, size, size);
    if (spec.planks) {
      var rows = 6, hgt = size / rows;
      for (var r = 0; r < rows; r++) {
        g.fillStyle = 'rgba(0,0,0,' + (0.05 + rng.range(0, 0.13)).toFixed(3) + ')';
        g.fillRect(0, r * hgt, size, hgt);
        g.strokeStyle = 'rgba(0,0,0,0.45)';
        g.lineWidth = 2;
        g.beginPath(); g.moveTo(0, r * hgt); g.lineTo(size, r * hgt); g.stroke();
        g.globalAlpha = 0.25;
        for (var gr = 0; gr < 14; gr++) {
          g.strokeStyle = rng.bool(0.5) ? '#2a2018' : '#7a6b52';
          g.lineWidth = rng.range(0.6, 2);
          g.beginPath();
          var yy = r * hgt + rng.range(2, hgt - 2);
          g.moveTo(0, yy);
          g.bezierCurveTo(size * 0.33, yy + rng.range(-4, 4), size * 0.66, yy + rng.range(-4, 4), size, yy + rng.range(-3, 3));
          g.stroke();
        }
        g.globalAlpha = 1;
      }
    }
    if (spec.corrode) TX.rustStreaks(g, size, rng, 40, 0.55);
    if (spec.speck) {
      g.globalAlpha = 0.28;
      for (var s = 0; s < 900; s++) {
        g.fillStyle = 'rgba(' + spec.speck + ',1)';
        g.fillRect(rng.range(0, size), rng.range(0, size), rng.range(0.6, 2.2), rng.range(0.6, 2.2));
      }
      g.globalAlpha = 1;
    }
    if (grunge) {
      g.globalCompositeOperation = 'multiply';
      g.globalAlpha = 0.5;
      g.drawImage(grunge, 0, 0, size, size);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
    }
    return c;
  };

  // ==========================================================================
  // Geometry kit
  //
  // Every builder returns geometry whose origin is at the BASE CENTRE of the
  // prop (y = 0 is ground contact), so placing it is "put it at the ground
  // height".  Silhouette detail is the priority: flanges, ribs, handles,
  // brackets, guards - the things that read at twenty metres in a wet frame
  // lit only by a sodium cone.
  // ==========================================================================
  var K = {};

  function box(w, h, d, bevel) { return Geo.bevelBox(w, h, d, bevel === undefined ? 0.008 : bevel); }
  function cyl(rt, rb, h, seg, open) {
    return new THREE.CylinderGeometry(rt, rb, h, seg || 12, 1, !!open);
  }
  function tube(r, t, seg, tseg) {
    return new THREE.TorusGeometry(r, t, tseg || 6, seg || 14);
  }

  // ---- dock ----------------------------------------------------------------

  // Tee-head mooring bollard.  Cast iron, ~0.95 m, on a bolted base flange.
  K.bollard = function (noise) {
    var p = [];
    function v(r, y) { p.push(new THREE.Vector2(Math.max(0.001, r), y)); }
    v(0.001, 0); v(0.40, 0); v(0.40, 0.055); v(0.34, 0.085);
    v(0.235, 0.135); v(0.215, 0.44); v(0.235, 0.60);
    v(0.315, 0.70); v(0.315, 0.775); v(0.245, 0.845);
    v(0.15, 0.885); v(0.001, 0.895);
    var g = new THREE.LatheGeometry(p, 16);
    roughen(g, noise, 0.011, 3.0, 'radial');
    var parts = [part(g, null)];
    // cross bar through the head - the thing a mooring line is actually taken
    // around, and the feature that makes the silhouette readable
    var bar = cyl(0.085, 0.085, 0.70, 10);
    parts.push(part(bar, Tn(0, 0.735, 0, 0, 0, Math.PI / 2)));
    parts.push(part(new THREE.SphereGeometry(0.095, 10, 8), Tn(0.35, 0.735, 0)));
    parts.push(part(new THREE.SphereGeometry(0.095, 10, 8), Tn(-0.35, 0.735, 0)));
    // foundation bolts
    for (var i = 0; i < 4; i++) {
      var a = i * Math.PI / 2 + 0.39;
      parts.push(part(cyl(0.038, 0.042, 0.05, 6),
        Tn(Math.cos(a) * 0.32, 0.062, Math.sin(a) * 0.32)));
    }
    var out = mergeParts(parts, 1.6);
    disposeParts(parts);
    return out;
  };

  // Horn cleat for smaller lines.
  K.cleat = function () {
    var parts = [];
    parts.push(part(box(0.42, 0.05, 0.18, 0.012), Tn(0, 0.025, 0)));
    parts.push(part(cyl(0.045, 0.05, 0.16, 8), Tn(-0.11, 0.10, 0)));
    parts.push(part(cyl(0.045, 0.05, 0.16, 8), Tn(0.11, 0.10, 0)));
    parts.push(part(cyl(0.042, 0.042, 0.50, 8), Tn(0, 0.185, 0, 0, 0, Math.PI / 2)));
    parts.push(part(new THREE.SphereGeometry(0.05, 8, 6), Tn(0.25, 0.185, 0)));
    parts.push(part(new THREE.SphereGeometry(0.05, 8, 6), Tn(-0.25, 0.185, 0)));
    var out = mergeParts(parts, 1.8);
    disposeParts(parts);
    return out;
  };

  // Capstan / warping drum.
  K.capstan = function (noise) {
    var p = [];
    function v(r, y) { p.push(new THREE.Vector2(Math.max(0.001, r), y)); }
    v(0.001, 0); v(0.52, 0); v(0.52, 0.09); v(0.44, 0.14);
    v(0.30, 0.20); v(0.235, 0.46); v(0.30, 0.66); v(0.315, 0.72);
    v(0.22, 0.78); v(0.001, 0.80);
    var g = new THREE.LatheGeometry(p, 18);
    roughen(g, noise, 0.008, 3.4, 'radial');
    var parts = [part(g, null)];
    // vertical whelps on the drum - the ribs that grip a line
    for (var i = 0; i < 8; i++) {
      var a = i * Math.PI / 4;
      parts.push(part(box(0.035, 0.30, 0.06, 0.006),
        Tn(Math.cos(a) * 0.245, 0.36, Math.sin(a) * 0.245, 0, -a, 0)));
    }
    parts.push(part(cyl(0.055, 0.055, 0.20, 8), Tn(0.20, 0.85, 0)));
    var out = mergeParts(parts, 1.5);
    disposeParts(parts);
    return out;
  };

  // Cylindrical rubber quay fender, hung on chains.  Origin at the TOP so it
  // hangs off the quay lip rather than standing on the ground.
  K.fender = function (noise) {
    var g = cyl(0.36, 0.34, 1.35, 14);
    roughen(g, noise, 0.014, 2.4, 'radial');
    var parts = [part(g, Tn(0, -0.72, 0))];
    for (var i = 0; i < 3; i++) {
      parts.push(part(tube(0.375, 0.045, 14, 6), Tn(0, -0.32 - i * 0.40, 0, Math.PI / 2, 0, 0)));
    }
    // top and bottom end plates with lifting lugs
    parts.push(part(cyl(0.30, 0.30, 0.06, 12), Tn(0, -0.05, 0)));
    parts.push(part(cyl(0.30, 0.30, 0.06, 12), Tn(0, -1.40, 0)));
    parts.push(part(box(0.06, 0.16, 0.10, 0.01), Tn(0.16, 0.03, 0)));
    parts.push(part(box(0.06, 0.16, 0.10, 0.01), Tn(-0.16, 0.03, 0)));
    var out = mergeParts(parts, 1.3);
    disposeParts(parts);
    return out;
  };

  // Chain-rail stanchion with two eyes.
  K.railPost = function () {
    var parts = [];
    parts.push(part(box(0.16, 0.022, 0.16, 0.006), Tn(0, 0.011, 0)));
    parts.push(part(cyl(0.038, 0.046, 1.02, 10), Tn(0, 0.53, 0)));
    parts.push(part(new THREE.SphereGeometry(0.048, 10, 8), Tn(0, 1.05, 0)));
    parts.push(part(tube(0.052, 0.013, 10, 5), Tn(0, 0.92, 0, 0, Math.PI / 2, 0)));
    parts.push(part(tube(0.052, 0.013, 10, 5), Tn(0, 0.56, 0, 0, Math.PI / 2, 0)));
    var out = mergeParts(parts, 1.9);
    disposeParts(parts);
    return out;
  };

  // Life ring on its bracket.  Four painted quadrants come from the material
  // tint; the geometry supplies the grab lines.
  K.lifeRing = function () {
    var parts = [];
    parts.push(part(tube(0.34, 0.075, 18, 8), Tn(0, 0.36, 0, 0, 0, 0)));
    // grab line loops
    for (var i = 0; i < 4; i++) {
      var a = i * Math.PI / 2 + 0.4;
      var x = Math.cos(a) * 0.34, y = 0.36 + Math.sin(a) * 0.34;
      parts.push(part(tube(0.075, 0.014, 8, 5), Tn(x, y, 0, 0, 0, a)));
    }
    // wall bracket
    parts.push(part(box(0.09, 0.32, 0.05, 0.008), Tn(0, 0.16, -0.08)));
    parts.push(part(box(0.24, 0.05, 0.05, 0.008), Tn(0, 0.72, -0.06)));
    var out = mergeParts(parts, 1.9);
    disposeParts(parts);
    return out;
  };

  // Rat guard.  A shallow open cone threaded onto a mooring line so vermin
  // cannot walk aboard.  Sixteen triangles, and it is the single most
  // recognisable object on any working quay on earth - a berth with mooring
  // lines and no rat guards reads as a model of a quay rather than a quay.
  // Built about the ORIGIN with its axis along +Y so it can be dropped onto a
  // rope tangent.
  K.ratGuard = function () {
    var P = [];
    var c = new THREE.ConeGeometry(0.45, 0.30, 16, 1, true);
    P.push(part(c, Tn(0, 0, 0)));
    // rolled rim, and the collar the line passes through
    P.push(part(tube(0.448, 0.014, 16, 5), Tn(0, -0.15, 0, Math.PI / 2, 0, 0)));
    P.push(part(cyl(0.058, 0.058, 0.11, 8), Tn(0, 0.17, 0)));
    P.push(part(cyl(0.075, 0.075, 0.018, 8), Tn(0, 0.225, 0)));
    var out = mergeParts(P, 2.2);
    disposeParts(P);
    return out;
  };

  // The spliced eye of a mooring line dropped over a bollard head: three turns
  // of rope round the casting plus the tail running off.  A line that
  // terminates at a mathematical point on the bollard is the tell that nobody
  // looked at a photograph.
  K.ropeEye = function () {
    var P = [];
    for (var i = 0; i < 3; i++) {
      P.push(part(tube(0.285 + i * 0.014, 0.044, 14, 5),
        Tn(0, i * 0.082, 0, Math.PI / 2, 0, 0)));
    }
    // the thimble - a steel liner in the eye, worn bright
    P.push(part(tube(0.075, 0.020, 10, 5), Tn(0.30, 0.13, 0, 0, 0, 0.5)));
    var out = mergeParts(P, 2.2);
    disposeParts(P);
    return out;
  };

  // Life ring on a quayside stand, which is the one place a life ring ever is.
  // Post, bracket arms, the ring itself and the coiled throw line beneath it.
  K.lifebuoyStand = function () {
    var P = [];
    P.push(part(box(0.32, 0.035, 0.32, 0.008), Tn(0, 0.018, 0)));
    P.push(part(cyl(0.046, 0.058, 1.10, 10), Tn(0, 0.59, 0)));
    // bracket arms carrying the ring proud of the post
    P.push(part(box(0.05, 0.05, 0.26, 0.006), Tn(0, 1.06, 0.13)));
    P.push(part(box(0.44, 0.05, 0.05, 0.006), Tn(0, 1.06, 0.25)));
    P.push(part(box(0.05, 0.05, 0.20, 0.006), Tn(0.20, 0.93, 0.25, -0.6, 0, 0)));
    P.push(part(box(0.05, 0.05, 0.20, 0.006), Tn(-0.20, 0.93, 0.25, -0.6, 0, 0)));
    // the ring, hanging upright on the arms
    P.push(part(tube(0.34, 0.072, 18, 8), Tn(0, 0.80, 0.27)));
    for (var i = 0; i < 4; i++) {
      var a = i * Math.PI / 2 + 0.4;
      P.push(part(tube(0.072, 0.013, 8, 5),
        Tn(Math.cos(a) * 0.34, 0.80 + Math.sin(a) * 0.34, 0.27, 0, 0, a)));
    }
    // the throw line, flaked in a bag on the post
    for (var t = 0; t < 4; t++) {
      P.push(part(tube(0.115 + t * 0.014, 0.024, 12, 5),
        Tn(0, 0.30 + t * 0.045, -0.10, Math.PI / 2, 0, 0)));
    }
    var out = mergeParts(P, 1.9);
    disposeParts(P);
    return out;
  };

  // A quay ladder recess: the two grab rails that stand proud of the coping.
  // Origin at the coping lip, rails curving landward.
  K.quayLadder = function () {
    var P = [];
    for (var s = -1; s <= 1; s += 2) {
      P.push(part(cyl(0.026, 0.026, 1.05, 7), Tn(s * 0.24, 0.52, 0.34)));
      P.push(part(tube(0.17, 0.026, 8, 5), Tn(s * 0.24, 1.05, 0.17, 0, Math.PI / 2, 0)));
      P.push(part(cyl(0.026, 0.026, 0.34, 7), Tn(s * 0.24, 1.13, -0.02, Math.PI / 2, 0, 0)));
      P.push(part(box(0.11, 0.04, 0.16, 0.006), Tn(s * 0.24, 0.03, 0.34)));
    }
    // the top rung of the ladder itself, showing in the recess
    P.push(part(cyl(0.020, 0.020, 0.48, 6), Tn(0, 0.02, 0.02, 0, 0, Math.PI / 2)));
    P.push(part(cyl(0.020, 0.020, 0.48, 6), Tn(0, -0.34, 0.02, 0, 0, Math.PI / 2)));
    var out = mergeParts(P, 2.0);
    disposeParts(P);
    return out;
  };

  // ---- cargo ---------------------------------------------------------------

  // Euro pallet, 1.2 x 0.8 x 0.144.  Nine blocks, three bearers, seven deck
  // boards with the real gaps: the gaps are the silhouette.
  K.pallet = function (noise, broken) {
    var parts = [];
    var L = 1.20, W = 0.80;
    var i, j;
    // bottom boards
    for (i = 0; i < 3; i++) {
      var bz = -W / 2 + 0.05 + i * (W - 0.10) / 2;
      parts.push(part(box(L, 0.022, 0.10, 0.004), Tn(0, 0.011, bz)));
    }
    // blocks
    for (i = 0; i < 3; i++) {
      for (j = 0; j < 3; j++) {
        var bx = -L / 2 + 0.05 + i * (L - 0.10) / 2;
        var bz2 = -W / 2 + 0.05 + j * (W - 0.10) / 2;
        parts.push(part(box(0.10, 0.078, 0.10, 0.005), Tn(bx, 0.061, bz2)));
      }
    }
    // bearers
    for (i = 0; i < 3; i++) {
      var cz = -W / 2 + 0.05 + i * (W - 0.10) / 2;
      parts.push(part(box(L, 0.022, 0.10, 0.004), Tn(0, 0.111, cz)));
    }
    // deck boards
    var nb = 5;
    for (i = 0; i < nb; i++) {
      if (broken && i === 2) continue;
      var dx = -L / 2 + 0.0725 + i * (L - 0.145) / (nb - 1);
      var wdt = (i === 0 || i === nb - 1) ? 0.145 : 0.10;
      var g = box(wdt, 0.022, W, 0.004);
      if (broken && i === 3) {
        // a split board hangs proud - the tell that this pallet is scrap
        parts.push(part(g, Tn(dx, 0.133, 0.06, 0.10, 0.03, 0)));
      } else {
        parts.push(part(g, Tn(dx, 0.133, 0)));
      }
    }
    var out = mergeParts(parts, 2.2);
    disposeParts(parts);
    if (out && noise) roughen(out, noise, 0.0035, 6.0);
    return out;
  };

  // 205 L steel drum with rolling hoops, bungs and a lever-ring closure.
  //
  // `dent` pushes ONE hoop-to-hoop panel in by ~4 cm.  Sixty-four instances of
  // one perfect lathe read as sixty-four instances of one perfect lathe no
  // matter how the wear channel is jittered; a dent changes the SILHOUETTE, and
  // silhouette is the only thing that survives to twenty metres in a night
  // frame.  A drum that has been round a working quay for ten years has one.
  K.drum = function (noise, dent) {
    var R = 0.29, H = 0.89;
    var p = [];
    function v(r, y) { p.push(new THREE.Vector2(Math.max(0.001, r), y)); }
    v(0.001, 0); v(R * 0.84, 0); v(R * 0.97, 0.026); v(R * 0.97, 0.058);
    v(R * 0.92, 0.088); v(R * 0.92, 0.27); v(R * 1.01, 0.305); v(R * 1.01, 0.357);
    v(R * 0.92, 0.392); v(R * 0.92, 0.52); v(R * 1.01, 0.556); v(R * 1.01, 0.608);
    v(R * 0.92, 0.643); v(R * 0.92, 0.80); v(R * 0.97, 0.832); v(R * 0.97, 0.862);
    v(R * 0.84, H); v(0.001, H);
    var g = new THREE.LatheGeometry(p, 16);
    roughen(g, noise, 0.020, 2.6, 'radial');
    if (dent) {
      var pa = g.attributes.position;
      var da = 2.05;                                  // azimuth of the impact
      for (var di = 0; di < pa.count; di++) {
        var dxv = pa.getX(di), dyv = pa.getY(di), dzv = pa.getZ(di);
        var rr = Math.sqrt(dxv * dxv + dzv * dzv);
        if (rr < 0.05) continue;
        // only the unstiffened panel between the two rolling hoops gives
        var band = M.saturate(1 - Math.abs(dyv - 0.455) / 0.12);
        var az = Math.atan2(dzv, dxv) - da;
        while (az > Math.PI) az -= M.TAU;
        while (az < -Math.PI) az += M.TAU;
        var arc = M.saturate(1 - Math.abs(az) / 0.62);
        var push = band * band * arc * arc * 0.040;
        if (push < 1e-4) continue;
        var sc = (rr - push) / rr;
        pa.setXYZ(di, dxv * sc, dyv, dzv * sc);
      }
      pa.needsUpdate = true;
      g.computeVertexNormals();
    }
    var parts = [part(g, null)];
    // 2 in and 3/4 in bungs on the lid
    parts.push(part(cyl(0.046, 0.046, 0.022, 8), Tn(0.13, H + 0.006, 0.05)));
    parts.push(part(cyl(0.029, 0.029, 0.018, 8), Tn(-0.11, H + 0.005, -0.08)));
    // lever-ring closure round the lid seam, with its lug and drop pin
    parts.push(part(tube(R * 0.965, 0.018, 18, 5), Tn(0, H - 0.013, 0, Math.PI / 2, 0, 0)));
    parts.push(part(box(0.10, 0.052, 0.05, 0.006), Tn(R * 0.84, H - 0.038, R * 0.46, 0, -0.50, 0)));
    parts.push(part(cyl(0.011, 0.011, 0.085, 5), Tn(R * 0.88, H - 0.078, R * 0.48)));
    var out = mergeParts(parts, 1.5);
    disposeParts(parts);
    return out;
  };

  // Plank shipping crate with corner battens and a stencil face.
  K.crate = function (W, H, D, noise, damaged) {
    var parts = [];
    var t = 0.022;
    var rows = Math.max(2, Math.round(H / 0.24));
    var i;
    function planksFace(w, h, depth, mtxFn) {
      for (var r = 0; r < rows; r++) {
        if (damaged && r === rows - 2) continue;
        var y = -h / 2 + (r + 0.5) * (h / rows);
        var ph = (h / rows) * 0.90;
        parts.push(part(box(w, ph, t, 0.004), mtxFn(y, depth)));
      }
    }
    planksFace(W, H, D / 2, function (y, d) { return Tn(0, H / 2 + y, d); });
    planksFace(W, H, -D / 2, function (y, d) { return Tn(0, H / 2 + y, d); });
    for (var r2 = 0; r2 < rows; r2++) {
      if (damaged && r2 === 1) continue;
      var y2 = -H / 2 + (r2 + 0.5) * (H / rows);
      var ph2 = (H / rows) * 0.90;
      parts.push(part(box(t, ph2, D, 0.004), Tn(W / 2, H / 2 + y2, 0)));
      parts.push(part(box(t, ph2, D, 0.004), Tn(-W / 2, H / 2 + y2, 0)));
    }
    // lid
    parts.push(part(box(W + 0.02, t, D + 0.02, 0.004), Tn(0, H, 0)));
    // corner battens
    var cx = [1, -1], cz = [1, -1];
    for (i = 0; i < 2; i++) {
      for (var j = 0; j < 2; j++) {
        parts.push(part(box(0.045, H, 0.045, 0.005),
          Tn(cx[i] * (W / 2 + 0.008), H / 2, cz[j] * (D / 2 + 0.008))));
      }
    }
    // diagonal brace on one face
    parts.push(part(box(Math.sqrt(W * W + H * H) * 0.94, 0.05, 0.018, 0.004),
      Tn(0, H / 2, D / 2 + 0.015, 0, 0, Math.atan2(H, W))));
    var out = mergeParts(parts, 2.0);
    disposeParts(parts);
    if (out && noise) roughen(out, noise, 0.004, 5.0);
    return out;
  };

  // A dropped twistlock: the cast fitting that locks one box to the next.  They
  // live loose all over a working terminal, in the lanes, because that is where
  // they are dropped.  0.18 m of steel and completely specific to this level.
  K.twistlock = function () {
    var P = [];
    P.push(part(box(0.155, 0.062, 0.115, 0.010), Tn(0, 0.031, 0)));
    P.push(part(box(0.058, 0.052, 0.098, 0.008), Tn(0, 0.086, 0)));
    P.push(part(box(0.098, 0.028, 0.052, 0.006), Tn(0, 0.118, 0, 0, 0.5, 0)));
    P.push(part(cyl(0.014, 0.014, 0.115, 6), Tn(0.055, 0.052, 0, 0, 0, Math.PI / 2)));
    P.push(part(new THREE.SphereGeometry(0.020, 8, 6), Tn(0.112, 0.052, 0)));
    var out = mergeParts(P, 3.2);
    disposeParts(P);
    return out;
  };

  // A lashing bar with its turnbuckle, lying where it was thrown down.  Built
  // along X, resting on the deck.
  K.lashingBar = function () {
    var P = [];
    P.push(part(cyl(0.017, 0.017, 1.90, 7), Tn(0, 0.017, 0, 0, 0, Math.PI / 2)));
    // hook end
    P.push(part(tube(0.055, 0.016, 8, 5), Tn(-1.00, 0.030, 0, 0, Math.PI / 2, 0)));
    // turnbuckle body and its two eyes
    P.push(part(cyl(0.040, 0.040, 0.34, 8), Tn(1.10, 0.040, 0, 0, 0, Math.PI / 2)));
    P.push(part(box(0.26, 0.020, 0.055, 0.004), Tn(1.10, 0.062, 0)));
    P.push(part(tube(0.048, 0.014, 8, 5), Tn(1.34, 0.040, 0, 0, Math.PI / 2, 0)));
    P.push(part(cyl(0.012, 0.012, 0.16, 6), Tn(1.34, 0.100, 0, 0, 0, 0.35)));
    var out = mergeParts(P, 2.4);
    disposeParts(P);
    return out;
  };

  // A coiled air/water hose dumped on the deck.
  K.hoseCoil = function () {
    var P = [];
    for (var i = 0; i < 5; i++) {
      var r = 0.26 + (i % 3) * 0.075;
      P.push(part(tube(r, 0.026, 16, 5), Tn((i % 2) * 0.05, 0.028 + Math.floor(i / 3) * 0.052, 0,
        Math.PI / 2, i * 0.7, 0)));
    }
    // the tail and its coupling
    P.push(part(cyl(0.026, 0.026, 0.56, 6), Tn(0.42, 0.028, 0.26, 0, 0.7, Math.PI / 2)));
    P.push(part(cyl(0.036, 0.030, 0.09, 8), Tn(0.66, 0.030, 0.44, 0, 0.7, Math.PI / 2)));
    var out = mergeParts(P, 2.2);
    disposeParts(P);
    return out;
  };

  // Timber dunnage baulk.
  K.dunnage = function (noise, len) {
    var g = box(len || 1.6, 0.09, 0.10, 0.006);
    g.translate(0, 0.045, 0);
    if (noise) roughen(g, noise, 0.006, 4.0);
    return g;
  };

  // Wrapped-and-strapped bale: the polythene-shrunk unit load that spills out
  // of a burst container.
  // The top face gets the same treatment as the tarpaulin crown and for the
  // same reason: a 0.92 x 0.68 m dead-flat horizontal plate at full storm
  // wetness is standing water as far as the wet contract and the screen-space
  // reflection are concerned, and four of these stacked under a sheet sit two
  // and a half metres from the lens in five of the shared framings.  A
  // polythene-shrunk unit load does not have a flat top anyway - the wrap tents
  // over the corners and slumps in the middle - so the honest shape is also the
  // one that stops the mirror.  Subdivided 3x so the slump has somewhere to go.
  K.bale = function (noise) {
    var parts = [];
    var g = Geo.bevelBox(0.92, 0.62, 0.68, 0.05, 3);
    var bp = g.attributes.position;
    for (var bi = 0; bi < bp.count; bi++) {
      var by = bp.getY(bi);
      if (by < 0.24) continue;                       // top face only
      var fx = bp.getX(bi) / 0.46, fz = bp.getZ(bi) / 0.34;
      // tented at the corners, slumped across the middle, and off-centre so the
      // ridge does not sit exactly on the axis of symmetry
      bp.setY(bi, by + 0.052 * (1 - fx * fx * 0.85) * (0.30 + 0.70 * Math.abs(fz))
        - 0.030 - 0.016 * Math.cos(fx * 2.1 + 0.7));
    }
    bp.needsUpdate = true;
    roughen(g, noise, 0.024, 3.2);
    parts.push(part(g, Tn(0, 0.31, 0)));
    // strapping bands
    parts.push(part(box(0.95, 0.035, 0.012, 0.003), Tn(0, 0.31, 0.345)));
    parts.push(part(box(0.95, 0.035, 0.012, 0.003), Tn(0, 0.31, -0.345)));
    parts.push(part(box(0.012, 0.035, 0.71, 0.003), Tn(0.30, 0.63, 0)));
    parts.push(part(box(0.012, 0.035, 0.71, 0.003), Tn(-0.30, 0.63, 0)));
    var out = mergeParts(parts, 1.6);
    disposeParts(parts);
    return out;
  };

  // ---- machinery -----------------------------------------------------------

  // Counterbalance forklift.  Mast, carriage, forks, overhead guard, seat,
  // hydraulic rams - the parts that make the silhouette unmistakable.
  K.forklift = function () {
    var P = [];
    // chassis and counterweight
    P.push(part(box(1.10, 0.55, 2.05, 0.03), Tn(0, 0.55, -0.15)));
    P.push(part(box(1.02, 0.62, 0.62, 0.05), Tn(0, 0.66, -1.05)));
    P.push(part(box(1.08, 0.22, 1.20, 0.03), Tn(0, 0.30, -0.55)));
    // engine bay louvres
    for (var l = 0; l < 5; l++) {
      P.push(part(box(0.86, 0.030, 0.02, 0.003), Tn(0, 0.52 + l * 0.075, -1.36)));
    }
    // operator step + seat + backrest
    P.push(part(box(0.86, 0.06, 0.44, 0.01), Tn(0, 0.86, -0.62)));
    P.push(part(box(0.52, 0.12, 0.44, 0.03), Tn(0, 0.95, -0.68)));
    P.push(part(box(0.50, 0.46, 0.10, 0.03), Tn(0, 1.20, -0.90)));
    // steering column + wheel
    P.push(part(cyl(0.035, 0.04, 0.46, 8), Tn(0, 1.12, -0.32, -0.32, 0, 0)));
    P.push(part(tube(0.135, 0.022, 12, 6), Tn(0, 1.33, -0.40, 1.25, 0, 0)));
    // overhead guard
    var gy = 2.12;
    var posts = [[0.48, 0.22], [-0.48, 0.22], [0.48, -0.95], [-0.48, -0.95]];
    for (var i = 0; i < 4; i++) {
      P.push(part(box(0.055, gy - 0.86, 0.055, 0.008),
        Tn(posts[i][0], 0.86 + (gy - 0.86) / 2, posts[i][1])));
    }
    for (var b = 0; b < 5; b++) {
      P.push(part(box(1.06, 0.035, 0.06, 0.006), Tn(0, gy, 0.20 - b * 0.30)));
    }
    P.push(part(box(0.07, 0.035, 1.22, 0.006), Tn(0.48, gy, -0.36)));
    P.push(part(box(0.07, 0.035, 1.22, 0.006), Tn(-0.48, gy, -0.36)));
    // mast: two channel rails plus an inner stage
    P.push(part(box(0.10, 2.55, 0.14, 0.012), Tn(0.40, 1.30, 0.92)));
    P.push(part(box(0.10, 2.55, 0.14, 0.012), Tn(-0.40, 1.30, 0.92)));
    P.push(part(box(0.08, 2.10, 0.10, 0.010), Tn(0.29, 1.16, 0.94)));
    P.push(part(box(0.08, 2.10, 0.10, 0.010), Tn(-0.29, 1.16, 0.94)));
    P.push(part(box(0.98, 0.09, 0.11, 0.008), Tn(0, 2.54, 0.92)));
    P.push(part(box(0.98, 0.09, 0.11, 0.008), Tn(0, 0.34, 0.92)));
    // lift cylinder
    P.push(part(cyl(0.055, 0.055, 1.70, 10), Tn(0, 1.02, 0.80)));
    P.push(part(cyl(0.035, 0.035, 0.95, 8), Tn(0, 2.05, 0.80)));
    // carriage and forks
    P.push(part(box(0.92, 0.34, 0.06, 0.008), Tn(0, 0.52, 1.00)));
    P.push(part(box(0.11, 0.42, 0.05, 0.006), Tn(0.30, 0.42, 1.03)));
    P.push(part(box(0.11, 0.42, 0.05, 0.006), Tn(-0.30, 0.42, 1.03)));
    P.push(part(box(0.11, 0.030, 1.05, 0.004), Tn(0.30, 0.225, 1.55)));
    P.push(part(box(0.11, 0.030, 1.05, 0.004), Tn(-0.30, 0.225, 1.55)));
    // wheels: big drive wheels forward, small steer wheels aft
    P.push(part(cyl(0.34, 0.34, 0.20, 14), Tn(0.55, 0.34, 0.62, 0, 0, Math.PI / 2)));
    P.push(part(cyl(0.34, 0.34, 0.20, 14), Tn(-0.55, 0.34, 0.62, 0, 0, Math.PI / 2)));
    P.push(part(cyl(0.24, 0.24, 0.16, 12), Tn(0.44, 0.24, -1.02, 0, 0, Math.PI / 2)));
    P.push(part(cyl(0.24, 0.24, 0.16, 12), Tn(-0.44, 0.24, -1.02, 0, 0, Math.PI / 2)));
    // beacon
    P.push(part(cyl(0.07, 0.08, 0.11, 10), Tn(0.36, gy + 0.09, -0.30)));
    var out = mergeParts(P, 1.5);
    disposeParts(P);
    return out;
  };

  // Towed fuel bowser: tank, chassis, drawbar, pump cabinet, hose reel.
  K.bowser = function (noise) {
    var P = [];
    var tank = cyl(0.72, 0.72, 3.10, 18);
    roughen(tank, noise, 0.010, 2.0, 'radial');
    P.push(part(tank, Tn(0, 1.18, 0, 0, 0, Math.PI / 2)));
    // dished ends
    P.push(part(new THREE.SphereGeometry(0.72, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      Tn(1.55, 1.18, 0, 0, 0, -Math.PI / 2)));
    P.push(part(new THREE.SphereGeometry(0.72, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      Tn(-1.55, 1.18, 0, 0, 0, Math.PI / 2)));
    // stiffening bands
    for (var b = -1; b <= 1; b++) {
      P.push(part(tube(0.745, 0.035, 18, 6), Tn(b * 0.95, 1.18, 0, 0, 0, Math.PI / 2)));
    }
    // manhole + breather
    P.push(part(cyl(0.24, 0.24, 0.10, 12), Tn(-0.30, 1.90, 0)));
    P.push(part(cyl(0.06, 0.06, 0.26, 8), Tn(0.55, 2.02, 0.20)));
    // chassis
    P.push(part(box(3.30, 0.14, 0.14, 0.01), Tn(0, 0.50, 0.42)));
    P.push(part(box(3.30, 0.14, 0.14, 0.01), Tn(0, 0.50, -0.42)));
    P.push(part(box(0.16, 0.14, 1.00, 0.01), Tn(1.55, 0.50, 0)));
    P.push(part(box(0.16, 0.14, 1.00, 0.01), Tn(-1.55, 0.50, 0)));
    // drawbar and jockey wheel
    P.push(part(box(1.30, 0.10, 0.10, 0.008), Tn(2.20, 0.50, 0)));
    P.push(part(cyl(0.08, 0.08, 0.14, 8), Tn(2.80, 0.50, 0, 0, 0, Math.PI / 2)));
    P.push(part(cyl(0.035, 0.035, 0.42, 8), Tn(2.55, 0.28, 0)));
    P.push(part(cyl(0.10, 0.10, 0.06, 10), Tn(2.55, 0.10, 0, 0, 0, Math.PI / 2)));
    // wheels
    var wz = [0.62, -0.62];
    for (var w = 0; w < 2; w++) {
      P.push(part(cyl(0.42, 0.42, 0.24, 14), Tn(0.70, 0.42, wz[w], 0, 0, Math.PI / 2)));
      P.push(part(cyl(0.42, 0.42, 0.24, 14), Tn(-0.70, 0.42, wz[w], 0, 0, Math.PI / 2)));
    }
    // pump cabinet with door and hazard placard
    P.push(part(box(0.72, 0.86, 0.62, 0.02), Tn(-1.30, 0.95, 0.72)));
    P.push(part(box(0.62, 0.70, 0.03, 0.006), Tn(-1.30, 0.95, 1.04)));
    P.push(part(cyl(0.026, 0.026, 0.16, 6), Tn(-1.02, 0.95, 1.06, 0, 0, Math.PI / 2)));
    // hose reel
    P.push(part(cyl(0.30, 0.30, 0.06, 14), Tn(-0.35, 1.05, 0.86, 0, 0, Math.PI / 2)));
    P.push(part(cyl(0.30, 0.30, 0.06, 14), Tn(-0.35, 1.05, 1.10, 0, 0, Math.PI / 2)));
    P.push(part(cyl(0.20, 0.20, 0.22, 12), Tn(-0.35, 1.05, 0.98, 0, 0, Math.PI / 2)));
    // ladder to the manhole
    for (var s = 0; s < 4; s++) {
      P.push(part(cyl(0.016, 0.016, 0.34, 5), Tn(-0.30, 1.42 + s * 0.16, 0.66, 0, 0, Math.PI / 2)));
    }
    var out = mergeParts(P, 1.4);
    disposeParts(P);
    return out;
  };

  // Terminal tractor (yard hostler): stubby cab, fifth wheel, big stacks.
  K.tractor = function () {
    var P = [];
    P.push(part(box(1.90, 0.30, 4.20, 0.03), Tn(0, 0.72, 0)));
    // cab
    P.push(part(box(1.86, 1.42, 1.70, 0.05), Tn(0, 1.58, 1.05)));
    P.push(part(box(1.90, 0.10, 1.76, 0.03), Tn(0, 2.30, 1.05)));
    // windows as recessed panels
    P.push(part(box(1.62, 0.78, 0.05, 0.01), Tn(0, 1.80, 1.92)));
    P.push(part(box(0.05, 0.72, 1.30, 0.01), Tn(0.94, 1.78, 1.02)));
    P.push(part(box(0.05, 0.72, 1.30, 0.01), Tn(-0.94, 1.78, 1.02)));
    // bonnet
    P.push(part(box(1.50, 0.55, 0.90, 0.04), Tn(0, 1.14, 2.30)));
    P.push(part(box(1.36, 0.42, 0.06, 0.01), Tn(0, 1.10, 2.76)));
    // exhaust stacks
    P.push(part(cyl(0.075, 0.075, 2.10, 10), Tn(0.86, 2.10, 1.80)));
    P.push(part(cyl(0.095, 0.075, 0.20, 10), Tn(0.86, 3.20, 1.80)));
    // mirrors
    P.push(part(box(0.05, 0.55, 0.16, 0.01), Tn(1.10, 2.00, 1.80)));
    P.push(part(box(0.05, 0.55, 0.16, 0.01), Tn(-1.10, 2.00, 1.80)));
    P.push(part(cyl(0.018, 0.018, 0.30, 5), Tn(1.02, 2.10, 1.80, 0, 0, Math.PI / 2)));
    P.push(part(cyl(0.018, 0.018, 0.30, 5), Tn(-1.02, 2.10, 1.80, 0, 0, Math.PI / 2)));
    // fifth wheel + lift ramp
    P.push(part(cyl(0.62, 0.62, 0.10, 16), Tn(0, 0.94, -1.10)));
    P.push(part(box(1.30, 0.06, 0.70, 0.01), Tn(0, 1.00, -1.55, -0.20, 0, 0)));
    // fuel tank
    P.push(part(cyl(0.28, 0.28, 1.10, 12), Tn(0.98, 0.62, -0.10, 0, 0, Math.PI / 2)));
    // wheels
    P.push(part(cyl(0.55, 0.55, 0.30, 16), Tn(0.98, 0.55, 1.55, 0, 0, Math.PI / 2)));
    P.push(part(cyl(0.55, 0.55, 0.30, 16), Tn(-0.98, 0.55, 1.55, 0, 0, Math.PI / 2)));
    P.push(part(cyl(0.60, 0.60, 0.52, 16), Tn(1.00, 0.60, -1.15, 0, 0, Math.PI / 2)));
    P.push(part(cyl(0.60, 0.60, 0.52, 16), Tn(-1.00, 0.60, -1.15, 0, 0, Math.PI / 2)));
    // beacon and grab handle
    P.push(part(cyl(0.08, 0.09, 0.13, 10), Tn(0, 2.42, 1.05)));
    P.push(part(cyl(0.022, 0.022, 0.70, 6), Tn(0.93, 1.30, 0.30)));
    var out = mergeParts(P, 1.4);
    disposeParts(P);
    return out;
  };

  // Skid-mounted generator set in an acoustic canopy.
  K.genset = function () {
    var P = [];
    P.push(part(box(2.90, 0.24, 1.24, 0.02), Tn(0, 0.12, 0)));
    P.push(part(box(2.60, 1.42, 1.10, 0.04), Tn(0, 0.95, 0)));
    // roof with a slight fall
    P.push(part(box(2.72, 0.09, 1.20, 0.02), Tn(0, 1.70, 0)));
    // radiator louvres one end
    for (var l = 0; l < 7; l++) {
      P.push(part(box(0.03, 0.05, 0.94, 0.004), Tn(1.31, 0.62 + l * 0.13, 0, 0, 0, 0.42)));
    }
    // access doors with handles
    P.push(part(box(0.90, 1.00, 0.04, 0.008), Tn(-0.55, 0.92, 0.56)));
    P.push(part(box(0.90, 1.00, 0.04, 0.008), Tn(0.55, 0.92, 0.56)));
    P.push(part(cyl(0.02, 0.02, 0.14, 6), Tn(-0.16, 0.92, 0.60, Math.PI / 2, 0, 0)));
    P.push(part(cyl(0.02, 0.02, 0.14, 6), Tn(0.94, 0.92, 0.60, Math.PI / 2, 0, 0)));
    // control panel
    P.push(part(box(0.46, 0.56, 0.06, 0.01), Tn(-1.05, 1.10, -0.58)));
    // exhaust
    P.push(part(cyl(0.085, 0.085, 0.90, 10), Tn(-1.02, 2.10, 0.30)));
    P.push(part(cyl(0.10, 0.085, 0.14, 10), Tn(-1.02, 2.60, 0.30, 0.22, 0, 0)));
    // lifting frame
    P.push(part(box(0.06, 0.30, 0.06, 0.008), Tn(1.20, 1.85, 0.50)));
    P.push(part(box(0.06, 0.30, 0.06, 0.008), Tn(-1.20, 1.85, 0.50)));
    P.push(part(box(2.50, 0.06, 0.06, 0.008), Tn(0, 2.00, 0.50)));
    var out = mergeParts(P, 1.5);
    disposeParts(P);
    return out;
  };

  // Cable reel: two flanges, a hub, and the wound cable itself as stacked rings
  // so it catches a rim light instead of reading as a solid cylinder.
  K.cableReel = function () {
    var P = [];
    P.push(part(cyl(0.92, 0.92, 0.07, 20), Tn(0, 0.92, -0.42, 0, 0, Math.PI / 2)));
    P.push(part(cyl(0.92, 0.92, 0.07, 20), Tn(0, 0.92, 0.42, 0, 0, Math.PI / 2)));
    P.push(part(cyl(0.30, 0.30, 0.84, 14), Tn(0, 0.92, 0, 0, 0, Math.PI / 2)));
    // spokes
    for (var s = 0; s < 6; s++) {
      var a = s * Math.PI / 3;
      P.push(part(box(0.09, 0.62, 0.05, 0.006),
        Tn(Math.cos(a) * 0.58, 0.92 + Math.sin(a) * 0.58, -0.46, 0, 0, a + Math.PI / 2)));
    }
    // wound cable
    for (var i = 0; i < 9; i++) {
      var r = 0.36 + Math.floor(i / 3) * 0.085;
      P.push(part(tube(r, 0.042, 18, 6), Tn(0, 0.92, -0.30 + (i % 3) * 0.30, 0, 0, Math.PI / 2)));
    }
    // loose tail running off onto the ground
    P.push(part(cyl(0.035, 0.035, 0.70, 6), Tn(0.55, 0.10, 0.70, 0, 0.6, Math.PI / 2)));
    var out = mergeParts(P, 1.5);
    disposeParts(P);
    return out;
  };

  // Waste skip, tapered, with the rim tube and lifting lugs that identify it.
  K.skip = function (noise) {
    var P = [];
    // Four panels plus a floor rather than one solid box, so the inside is open
    // and the debris in it reads as being IN it.
    P.push(part(box(3.10, 0.05, 1.55, 0.01), Tn(0, 0.04, 0)));
    P.push(part(box(3.30, 1.20, 0.05, 0.01), Tn(0, 0.62, 0.82, 0.22, 0, 0)));
    P.push(part(box(3.30, 1.20, 0.05, 0.01), Tn(0, 0.62, -0.82, -0.22, 0, 0)));
    P.push(part(box(0.05, 1.20, 1.75, 0.01), Tn(1.62, 0.62, 0, 0, 0, -0.22)));
    P.push(part(box(0.05, 1.20, 1.75, 0.01), Tn(-1.62, 0.62, 0, 0, 0, 0.22)));
    // rim
    P.push(part(box(3.75, 0.07, 0.09, 0.01), Tn(0, 1.22, 0.98)));
    P.push(part(box(3.75, 0.07, 0.09, 0.01), Tn(0, 1.22, -0.98)));
    P.push(part(box(0.09, 0.07, 2.05, 0.01), Tn(1.83, 1.22, 0)));
    P.push(part(box(0.09, 0.07, 2.05, 0.01), Tn(-1.83, 1.22, 0)));
    // lifting lugs and chains anchor points
    for (var i = 0; i < 2; i++) {
      var sx = i ? 1 : -1;
      P.push(part(box(0.10, 0.26, 0.10, 0.01), Tn(sx * 1.10, 1.34, 0.96)));
      P.push(part(box(0.10, 0.26, 0.10, 0.01), Tn(sx * 1.10, 1.34, -0.96)));
    }
    // skids
    P.push(part(box(3.10, 0.10, 0.14, 0.01), Tn(0, 0.05, 0.55)));
    P.push(part(box(3.10, 0.10, 0.14, 0.01), Tn(0, 0.05, -0.55)));
    var out = mergeParts(P, 1.3);
    disposeParts(P);
    if (out && noise) roughen(out, noise, 0.008, 3.0);
    return out;
  };

  // Container spreader parked on the ground: the beam a crane picks boxes with.
  K.spreader = function () {
    var P = [];
    var L = 12.20, W = 2.44;
    P.push(part(box(L, 0.42, 0.34, 0.02), Tn(0, 0.55, W / 2 - 0.17)));
    P.push(part(box(L, 0.42, 0.34, 0.02), Tn(0, 0.55, -W / 2 + 0.17)));
    P.push(part(box(0.36, 0.40, W, 0.02), Tn(0, 0.55, 0)));
    P.push(part(box(0.30, 0.34, W - 0.7, 0.02), Tn(3.60, 0.55, 0)));
    P.push(part(box(0.30, 0.34, W - 0.7, 0.02), Tn(-3.60, 0.55, 0)));
    // corner twistlock heads
    var cx = [L / 2 - 0.16, -L / 2 + 0.16], cz = [W / 2 - 0.17, -W / 2 + 0.17];
    for (var i = 0; i < 2; i++) {
      for (var j = 0; j < 2; j++) {
        P.push(part(box(0.42, 0.30, 0.42, 0.02), Tn(cx[i], 0.20, cz[j])));
        P.push(part(cyl(0.07, 0.07, 0.20, 8), Tn(cx[i], 0.06, cz[j])));
      }
    }
    // head block with sheaves
    P.push(part(box(2.20, 0.55, 1.60, 0.03), Tn(0, 1.10, 0)));
    for (var s = 0; s < 4; s++) {
      P.push(part(cyl(0.30, 0.30, 0.12, 14), Tn(-0.75 + s * 0.50, 1.55, 0, 0, 0, Math.PI / 2)));
    }
    // telescoping rams
    P.push(part(cyl(0.09, 0.09, 3.20, 10), Tn(1.90, 0.92, 0.55, 0, 0, Math.PI / 2)));
    P.push(part(cyl(0.09, 0.09, 3.20, 10), Tn(-1.90, 0.92, -0.55, 0, 0, Math.PI / 2)));
    // hydraulic hose loops
    P.push(part(tube(0.30, 0.035, 12, 5), Tn(1.10, 1.20, 0.70, 0, 0.4, 0)));
    P.push(part(tube(0.26, 0.030, 12, 5), Tn(-1.20, 1.16, -0.68, 0, -0.3, 0)));
    var out = mergeParts(P, 1.1);
    disposeParts(P);
    return out;
  };

  // Aluminium gangway.  Returns TWO geometries: the solid structure and the
  // grating treads.  They are separated because steel_grate is an alpha-CUT
  // material - putting it on the handrails would make them see-through, and
  // putting a solid material on the treads would lose the one surface in the
  // level you can see the black water through.
  // Built lying along +Z from y=0; the caller turns it to face the ship.
  K.gangway = function (length, rise, treads) {
    var P = [], TR = [];
    var W = 1.10;
    var ang = Math.atan2(rise, length);
    var runLen = Math.sqrt(length * length + rise * rise);
    // stringers
    P.push(part(box(0.10, 0.30, runLen, 0.01), Tn(W / 2, rise / 2, length / 2, ang, 0, 0)));
    P.push(part(box(0.10, 0.30, runLen, 0.01), Tn(-W / 2, rise / 2, length / 2, ang, 0, 0)));
    // treads: horizontal, stepping up the slope
    var n = treads || 14;
    for (var i = 0; i < n; i++) {
      var t = (i + 0.5) / n;
      TR.push(part(box(W - 0.06, 0.035, runLen / n * 0.80, 0.004),
        Tn(0, rise * t + 0.03, length * t, 0, 0, 0)));
    }
    // stanchions and rails, both sides
    var posts = 5;
    for (var s = 0; s <= posts; s++) {
      var ts = s / posts;
      for (var sd = 0; sd < 2; sd++) {
        var sx = sd ? W / 2 : -W / 2;
        P.push(part(cyl(0.022, 0.026, 1.02, 7), Tn(sx, rise * ts + 0.55, length * ts)));
      }
    }
    for (var sd2 = 0; sd2 < 2; sd2++) {
      var sx2 = sd2 ? W / 2 : -W / 2;
      P.push(part(cyl(0.026, 0.026, runLen, 7), Tn(sx2, rise / 2 + 1.04, length / 2, Math.PI / 2 - ang, 0, 0)));
      P.push(part(cyl(0.020, 0.020, runLen, 6), Tn(sx2, rise / 2 + 0.58, length / 2, Math.PI / 2 - ang, 0, 0)));
      // toe board
      P.push(part(box(0.02, 0.11, runLen, 0.004), Tn(sx2 - (sd2 ? 0.03 : -0.03), rise / 2 + 0.20, length / 2, ang, 0, 0)));
    }
    // bottom wheels and top landing plate
    P.push(part(cyl(0.12, 0.12, 0.07, 10), Tn(W / 2 - 0.02, 0.12, 0.12, 0, 0, Math.PI / 2)));
    P.push(part(cyl(0.12, 0.12, 0.07, 10), Tn(-W / 2 + 0.02, 0.12, 0.12, 0, 0, Math.PI / 2)));
    TR.push(part(box(W + 0.10, 0.05, 0.70, 0.008), Tn(0, rise + 0.03, length + 0.30)));
    var frame = mergeParts(P, 1.6);
    var tread = mergeParts(TR, 1.6);
    disposeParts(P);
    disposeParts(TR);
    return { frame: frame, treads: tread };
  };

  // ---- reefer --------------------------------------------------------------
  // The refrigeration end of a reefer container: recessed housing, louvred
  // condenser grille, two fan guards, a control box with a live display, a
  // compressor bulge and the drain that keeps a permanent wet stripe under it.
  K.reefer = function () {
    var P = [];
    var W = 2.28, H = 2.20;
    // recessed back plate + surrounding frame
    P.push(part(box(W, H, 0.05, 0.01), Tn(0, H / 2, 0.02)));
    P.push(part(box(W + 0.10, 0.11, 0.20, 0.012), Tn(0, H + 0.05, 0.10)));
    P.push(part(box(W + 0.10, 0.11, 0.20, 0.012), Tn(0, -0.05, 0.10)));
    P.push(part(box(0.11, H + 0.20, 0.20, 0.012), Tn(W / 2 + 0.05, H / 2, 0.10)));
    P.push(part(box(0.11, H + 0.20, 0.20, 0.012), Tn(-W / 2 - 0.05, H / 2, 0.10)));
    // condenser louvres across the top third
    for (var l = 0; l < 9; l++) {
      P.push(part(box(W - 0.24, 0.055, 0.10, 0.005),
        Tn(0, H - 0.18 - l * 0.062, 0.10, 0.55, 0, 0)));
    }
    // two fan guards
    for (var f = 0; f < 2; f++) {
      var fx = f ? 0.50 : -0.50;
      var fy = 0.86;
      P.push(part(cyl(0.40, 0.40, 0.05, 18, true), Tn(fx, fy, 0.10, Math.PI / 2, 0, 0)));
      for (var r = 0; r < 4; r++) {
        P.push(part(tube(0.10 + r * 0.095, 0.012, 16, 4), Tn(fx, fy, 0.14)));
      }
      for (var sp = 0; sp < 6; sp++) {
        var a = sp * Math.PI / 3;
        P.push(part(box(0.016, 0.78, 0.016, 0.002), Tn(fx, fy, 0.14, 0, 0, a)));
      }
      // hub + blades behind the guard
      P.push(part(cyl(0.10, 0.10, 0.10, 10), Tn(fx, fy, 0.04, Math.PI / 2, 0, 0)));
      for (var bl = 0; bl < 5; bl++) {
        var ba = bl * Math.PI * 2 / 5;
        P.push(part(box(0.12, 0.62, 0.03, 0.004), Tn(fx, fy, 0.03, 0, 0.35, ba)));
      }
    }
    // control box with recessed display
    P.push(part(box(0.56, 0.46, 0.22, 0.012), Tn(-0.72, 0.28, 0.14)));
    P.push(part(box(0.20, 0.10, 0.03, 0.004), Tn(-0.72, 0.38, 0.26)));
    for (var sw = 0; sw < 3; sw++) {
      P.push(part(cyl(0.022, 0.022, 0.04, 8), Tn(-0.86 + sw * 0.14, 0.18, 0.26, Math.PI / 2, 0, 0)));
    }
    // compressor bulge and pipework
    P.push(part(box(0.62, 0.42, 0.26, 0.03), Tn(0.72, 0.24, 0.16)));
    P.push(part(cyl(0.035, 0.035, 0.52, 8), Tn(0.40, 0.30, 0.22, 0, 0, Math.PI / 2)));
    P.push(part(tube(0.12, 0.032, 12, 5), Tn(0.30, 0.44, 0.22, 0, Math.PI / 2, 0)));
    // drain pipe: the reason there is always a wet stripe under a reefer
    P.push(part(cyl(0.028, 0.028, 0.34, 6), Tn(0.20, 0.10, 0.20)));
    P.push(part(cyl(0.028, 0.028, 0.14, 6), Tn(0.20, -0.02, 0.26, Math.PI / 2, 0, 0)));
    // power lead running off to the reefer rack
    P.push(part(cyl(0.030, 0.030, 0.40, 6), Tn(-1.02, 0.60, 0.16, 0, 0, 0.5)));
    var out = mergeParts(P, 1.7);
    disposeParts(P);
    return out;
  };

  // ---- infrastructure ------------------------------------------------------

  // Lattice light mast.  lighting.js supplies the actual lights; this is the
  // structure they hang on, and it has to read as a truss against the sky - a
  // solid pole silhouette would waste the one vertical element in the frame
  // that the storm cloud can backlight.
  K.lightMast = function (height, heads) {
    var P = [];
    var H = height || 15.0;
    var base = 0.62, top = 0.24;
    var i, s;
    function legXZ(idx, t) {
      var w = M.lerp(base, top, t);
      var sx = (idx === 0 || idx === 3) ? 1 : -1;
      var sz = (idx < 2) ? 1 : -1;
      return { x: sx * w, z: sz * w };
    }
    // base plate + grouting pad
    P.push(part(box(1.70, 0.16, 1.70, 0.02), Tn(0, 0.08, 0)));
    P.push(part(box(1.42, 0.10, 1.42, 0.015), Tn(0, 0.21, 0)));
    // four legs, tapering
    var segs = 10;
    for (i = 0; i < 4; i++) {
      for (s = 0; s < segs; s++) {
        var t0 = s / segs, t1 = (s + 1) / segs;
        var a = legXZ(i, t0), b = legXZ(i, t1);
        var m = strut(a.x, 0.25 + t0 * (H - 0.25), a.z, b.x, 0.25 + t1 * (H - 0.25), b.z);
        P.push(part(cyl(0.055, 0.055, 1, 6), m));
      }
    }
    // horizontal rings and X bracing
    for (s = 1; s < segs; s++) {
      var t = s / segs;
      var y = 0.25 + t * (H - 0.25);
      var w2 = M.lerp(base, top, t);
      P.push(part(cyl(0.030, 0.030, w2 * 2, 5), Tn(0, y, w2, 0, 0, Math.PI / 2)));
      P.push(part(cyl(0.030, 0.030, w2 * 2, 5), Tn(0, y, -w2, 0, 0, Math.PI / 2)));
      P.push(part(cyl(0.030, 0.030, w2 * 2, 5), Tn(w2, y, 0, Math.PI / 2, 0, 0)));
      P.push(part(cyl(0.030, 0.030, w2 * 2, 5), Tn(-w2, y, 0, Math.PI / 2, 0, 0)));
      if (s < segs) {
        var tn = (s + 1) / segs;
        var yn = 0.25 + tn * (H - 0.25);
        var wn = M.lerp(base, top, tn);
        P.push(part(cyl(0.024, 0.024, 1, 5), strut(-w2, y, w2, wn, yn, wn)));
        P.push(part(cyl(0.024, 0.024, 1, 5), strut(w2, y, -w2, -wn, yn, -wn)));
      }
    }
    // ladder up one face
    for (s = 0; s < Math.floor(H / 0.36); s++) {
      P.push(part(cyl(0.013, 0.013, 0.44, 4), Tn(0, 0.4 + s * 0.36, base + 0.10, 0, 0, Math.PI / 2)));
    }
    P.push(part(cyl(0.018, 0.018, H - 0.4, 5), Tn(0.22, 0.4 + (H - 0.4) / 2, base + 0.10)));
    P.push(part(cyl(0.018, 0.018, H - 0.4, 5), Tn(-0.22, 0.4 + (H - 0.4) / 2, base + 0.10)));
    // head frame + maintenance platform
    P.push(part(box(2.40, 0.08, 2.40, 0.012), Tn(0, H + 0.04, 0)));
    for (i = 0; i < 4; i++) {
      var ha = i * Math.PI / 2 + Math.PI / 4;
      P.push(part(cyl(0.022, 0.022, 1.0, 5),
        Tn(Math.cos(ha) * 1.10, H + 0.55, Math.sin(ha) * 1.10)));
    }
    P.push(part(tube(1.12, 0.022, 16, 5), Tn(0, H + 1.05, 0, Math.PI / 2, 0, 0)));
    // floodlight housings, tilted down and outward
    var nh = heads || 4;
    for (i = 0; i < nh; i++) {
      var a2 = i * Math.PI * 2 / nh + 0.4;
      var hx = Math.cos(a2) * 0.95, hz = Math.sin(a2) * 0.95;
      P.push(part(box(0.86, 0.20, 0.62, 0.02), Tn(hx, H + 0.34, hz, -0.62, -a2, 0)));
      P.push(part(box(0.20, 0.26, 0.20, 0.01), Tn(hx * 0.7, H + 0.18, hz * 0.7)));
      // hood over the lens so the cone has a hard edge
      P.push(part(box(0.94, 0.04, 0.30, 0.006), Tn(hx * 1.10, H + 0.46, hz * 1.10, -0.62, -a2, 0)));
    }
    var out = mergeParts(P, 1.2);
    disposeParts(P);
    return out;
  };

  // The emissive lens plate for a mast head, kept separate so it can carry its
  // own unlit material.  If lighting.js drops real lamps here they coincide.
  K.mastLens = function (heads) {
    var P = [];
    var nh = heads || 4;
    for (var i = 0; i < nh; i++) {
      var a = i * Math.PI * 2 / nh + 0.4;
      var hx = Math.cos(a) * 0.95, hz = Math.sin(a) * 0.95;
      P.push(part(box(0.74, 0.04, 0.50, 0.008), Tn(hx, -0.09, hz, -0.62, -a, 0)));
    }
    var out = mergeParts(P, 1);
    disposeParts(P);
    return out;
  };

  // CCTV pole: column, cranked arm, camera in a weather housing with a
  // sunshade, and the cable gland and junction box at the base.
  K.cctv = function () {
    var P = [];
    var H = 5.6;
    P.push(part(box(0.52, 0.10, 0.52, 0.012), Tn(0, 0.05, 0)));
    P.push(part(cyl(0.075, 0.10, H, 12), Tn(0, H / 2 + 0.05, 0)));
    for (var b = 0; b < 4; b++) {
      var a = b * Math.PI / 2 + 0.4;
      P.push(part(box(0.10, 0.20, 0.05, 0.008), Tn(Math.cos(a) * 0.13, 0.16, Math.sin(a) * 0.13, 0, -a, 0)));
    }
    // cranked arm
    P.push(part(cyl(0.045, 0.045, 0.85, 8), Tn(0, H + 0.05, 0.42, Math.PI / 2, 0, 0)));
    P.push(part(cyl(0.040, 0.040, 0.30, 8), Tn(0, H - 0.08, 0.82)));
    // housing + shade
    P.push(part(box(0.17, 0.17, 0.52, 0.02), Tn(0, H - 0.28, 0.86, 0.24, 0, 0)));
    P.push(part(box(0.22, 0.02, 0.58, 0.004), Tn(0, H - 0.17, 0.86, 0.24, 0, 0)));
    P.push(part(cyl(0.065, 0.065, 0.05, 10), Tn(0, H - 0.34, 1.11, Math.PI / 2 + 0.24, 0, 0)));
    // IR ring
    P.push(part(tube(0.085, 0.016, 12, 4), Tn(0, H - 0.34, 1.12, 0.24, 0, 0)));
    // base junction box and conduit
    P.push(part(box(0.24, 0.34, 0.16, 0.012), Tn(0.16, 0.55, 0)));
    P.push(part(cyl(0.028, 0.028, 0.60, 6), Tn(0.16, 0.90, 0, 0, 0, -0.18)));
    var out = mergeParts(P, 1.6);
    disposeParts(P);
    return out;
  };

  // Wall/post junction box with a hinged door, cable glands and a conduit stub.
  K.junctionBox = function () {
    var P = [];
    P.push(part(box(0.42, 0.56, 0.22, 0.014), Tn(0, 0.28, 0)));
    P.push(part(box(0.38, 0.50, 0.03, 0.006), Tn(0, 0.28, 0.12)));
    P.push(part(cyl(0.014, 0.014, 0.50, 5), Tn(-0.20, 0.28, 0.09)));
    P.push(part(cyl(0.014, 0.014, 0.50, 5), Tn(0.20, 0.28, 0.09)));
    P.push(part(cyl(0.022, 0.022, 0.05, 6), Tn(0.14, 0.28, 0.14, Math.PI / 2, 0, 0)));
    for (var gl = 0; gl < 3; gl++) {
      P.push(part(cyl(0.026, 0.032, 0.06, 8), Tn(-0.12 + gl * 0.12, -0.02, 0)));
    }
    P.push(part(cyl(0.030, 0.030, 0.42, 6), Tn(0, -0.22, 0)));
    var out = mergeParts(P, 2.0);
    disposeParts(P);
    return out;
  };

  // Sign board on two posts.  Face is a separate geometry so it can carry the
  // printed material while the frame stays steel.
  K.signFrame = function (w, h, postH) {
    var P = [];
    P.push(part(cyl(0.05, 0.055, postH, 8), Tn(-w * 0.36, postH / 2, 0)));
    P.push(part(cyl(0.05, 0.055, postH, 8), Tn(w * 0.36, postH / 2, 0)));
    P.push(part(box(w + 0.06, 0.05, 0.06, 0.008), Tn(0, postH - 0.06, 0)));
    P.push(part(box(w + 0.06, 0.05, 0.06, 0.008), Tn(0, postH - h + 0.06, 0)));
    P.push(part(box(w + 0.06, h + 0.04, 0.035, 0.006), Tn(0, postH - h / 2, -0.03)));
    var out = mergeParts(P, 1.8);
    disposeParts(P);
    return out;
  };
  K.signFace = function (w, h, postH) {
    var g = new THREE.PlaneGeometry(w, h, 1, 1);
    g.translate(0, postH - h / 2, 0.005);
    return g;
  };

  // Traffic cone with a moulded base and a ribbed body.
  K.cone = function (noise) {
    var p = [];
    function v(r, y) { p.push(new THREE.Vector2(Math.max(0.001, r), y)); }
    v(0.001, 0); v(0.185, 0); v(0.185, 0.035); v(0.155, 0.055);
    v(0.125, 0.085); v(0.105, 0.20); v(0.082, 0.38); v(0.062, 0.55);
    v(0.045, 0.66); v(0.038, 0.71); v(0.001, 0.725);
    var g = new THREE.LatheGeometry(p, 13);
    if (noise) roughen(g, noise, 0.004, 6.0, 'radial');
    var parts = [part(g, null)];
    parts.push(part(box(0.30, 0.030, 0.30, 0.012), Tn(0, 0.015, 0)));
    var out = mergeParts(parts, 2.4);
    disposeParts(parts);
    return out;
  };
  // The retroreflective sleeve, batched separately so it can be bright.
  K.coneBand = function () {
    return cyl(0.079, 0.093, 0.15, 13, true);
  };

  // Jersey barrier: real profile, lifting slots, and the joint pin lugs.
  K.jersey = function (noise) {
    var pts = [
      new THREE.Vector2(-0.30, 0), new THREE.Vector2(0.30, 0),
      new THREE.Vector2(0.30, 0.075), new THREE.Vector2(0.145, 0.33),
      new THREE.Vector2(0.105, 0.82), new THREE.Vector2(-0.105, 0.82),
      new THREE.Vector2(-0.145, 0.33), new THREE.Vector2(-0.30, 0.075)
    ];
    var g = extrudeProfile(pts, 2.20, 1.0);
    if (noise) roughen(g, noise, 0.006, 3.0);
    var P = [part(g, null)];
    // lifting slots (as raised lugs, cheaper than boolean holes)
    P.push(part(box(0.16, 0.09, 0.13, 0.01), Tn(0, 0.86, 0.55)));
    P.push(part(box(0.16, 0.09, 0.13, 0.01), Tn(0, 0.86, -0.55)));
    // end connector lugs
    P.push(part(box(0.10, 0.30, 0.07, 0.008), Tn(0, 0.50, 1.13)));
    P.push(part(box(0.10, 0.30, 0.07, 0.008), Tn(0, 0.50, -1.13)));
    var out = mergeParts(P, 1.2);
    disposeParts(P);
    return out;
  };

  // Chain-link fence: the frame only.  The mesh itself is a separate alpha
  // plane so it can be one instanced draw for the whole perimeter.
  K.fenceFrame = function (span, height, barb) {
    var P = [];
    P.push(part(cyl(0.042, 0.048, height, 8), Tn(-span / 2, height / 2, 0)));
    P.push(part(cyl(0.042, 0.048, height, 8), Tn(span / 2, height / 2, 0)));
    P.push(part(cyl(0.028, 0.028, span, 6), Tn(0, height - 0.06, 0, 0, 0, Math.PI / 2)));
    P.push(part(cyl(0.024, 0.024, span, 6), Tn(0, 0.10, 0, 0, 0, Math.PI / 2)));
    // tension bar mid-height
    P.push(part(cyl(0.018, 0.018, span, 5), Tn(0, height * 0.5, 0, 0, 0, Math.PI / 2)));
    if (barb) {
      // cranked barbed-wire arms leaning outward, three strands each
      for (var s = 0; s < 2; s++) {
        var sx = s ? span / 2 : -span / 2;
        P.push(part(cyl(0.020, 0.020, 0.52, 5), Tn(sx, height + 0.20, 0.16, 0.75, 0, 0)));
      }
      for (var w = 0; w < 3; w++) {
        var wy = height + 0.13 + w * 0.14;
        var wz = 0.07 + w * 0.11;
        P.push(part(cyl(0.010, 0.010, span, 4), Tn(0, wy, wz, 0, 0, Math.PI / 2)));
      }
    }
    var out = mergeParts(P, 1.6);
    disposeParts(P);
    return out;
  };

  // Barbs threaded onto the top wires - tiny, but a barbed-wire line with no
  // barbs is just a cable, and the eye knows.
  K.barbs = function (span, height, rng) {
    var P = [];
    var n = Math.floor(span / 0.14);
    for (var w = 0; w < 3; w++) {
      var wy = height + 0.13 + w * 0.14;
      var wz = 0.07 + w * 0.11;
      for (var i = 0; i < n; i++) {
        var x = -span / 2 + (i + 0.5) * span / n;
        var a = rng.range(0, Math.PI);
        P.push(part(box(0.008, 0.055, 0.008, 0), Tn(x, wy, wz, 0.7, a, 0)));
        P.push(part(box(0.008, 0.055, 0.008, 0), Tn(x, wy, wz, -0.7, a, 0)));
      }
    }
    var out = mergeParts(P, 1);
    disposeParts(P);
    return out;
  };

  // A-frame hazard barrier with a striped board.
  K.hazardBarrier = function () {
    var P = [];
    P.push(part(box(1.30, 0.05, 0.30, 0.008), Tn(0, 0.025, 0.30)));
    P.push(part(box(1.30, 0.05, 0.30, 0.008), Tn(0, 0.025, -0.30)));
    P.push(part(box(0.06, 0.98, 0.06, 0.006), Tn(-0.55, 0.50, 0.26, -0.26, 0, 0)));
    P.push(part(box(0.06, 0.98, 0.06, 0.006), Tn(0.55, 0.50, 0.26, -0.26, 0, 0)));
    P.push(part(box(0.06, 0.98, 0.06, 0.006), Tn(-0.55, 0.50, -0.26, 0.26, 0, 0)));
    P.push(part(box(0.06, 0.98, 0.06, 0.006), Tn(0.55, 0.50, -0.26, 0.26, 0, 0)));
    P.push(part(box(1.34, 0.26, 0.04, 0.006), Tn(0, 0.86, 0)));
    P.push(part(box(1.34, 0.20, 0.04, 0.006), Tn(0, 0.52, 0)));
    var out = mergeParts(P, 1.5);
    disposeParts(P);
    return out;
  };

  // Bulk head / conduit clip run - built inline by the caller from segments.
  K.conduitBend = function (r) {
    return new THREE.TorusGeometry(r || 0.12, 0.024, 6, 8, Math.PI / 2);
  };

  // ---- life ----------------------------------------------------------------

  // A roosting herring gull.  Small, but a terminal with no gulls on the
  // bollards is a diorama, and the eye reads "alive" from very little.
  K.gull = function () {
    var P = [];
    var body = new THREE.SphereGeometry(0.105, 12, 9);
    body.scale(1.0, 0.92, 2.05);
    P.push(part(body, Tn(0, 0.115, 0, 0.10, 0, 0)));
    // breast
    var br = new THREE.SphereGeometry(0.085, 10, 8);
    br.scale(1, 1.05, 1.1);
    P.push(part(br, Tn(0, 0.115, 0.12)));
    // neck + head
    P.push(part(cyl(0.045, 0.055, 0.09, 8), Tn(0, 0.195, 0.155, -0.35, 0, 0)));
    var head = new THREE.SphereGeometry(0.052, 10, 8);
    head.scale(1, 1, 1.18);
    P.push(part(head, Tn(0, 0.235, 0.185)));
    // beak
    P.push(part(cyl(0.006, 0.021, 0.075, 6), Tn(0, 0.228, 0.245, Math.PI / 2 + 0.10, 0, 0)));
    // folded wings
    var wg = new THREE.SphereGeometry(0.062, 8, 6);
    wg.scale(0.55, 0.72, 2.2);
    P.push(part(wg, Tn(0.072, 0.118, -0.02, 0, 0.12, 0.15)));
    P.push(part(wg.clone(), Tn(-0.072, 0.118, -0.02, 0, -0.12, -0.15)));
    // tail
    P.push(part(box(0.10, 0.016, 0.16, 0.004), Tn(0, 0.115, -0.20, 0.16, 0, 0)));
    // legs
    P.push(part(cyl(0.008, 0.008, 0.07, 5), Tn(0.032, 0.035, 0.02)));
    P.push(part(cyl(0.008, 0.008, 0.07, 5), Tn(-0.032, 0.035, 0.02)));
    P.push(part(box(0.036, 0.008, 0.05, 0.002), Tn(0.032, 0.004, 0.035)));
    P.push(part(box(0.036, 0.008, 0.05, 0.002), Tn(-0.032, 0.004, 0.035)));
    var out = mergeParts(P, 3.0);
    disposeParts(P);
    return out;
  };

  // ---- soft goods ----------------------------------------------------------

  // A tarpaulin lashed over a pallet stack.  The shape does the work: the sheet
  // sits on the load, breaks over the corners and hangs in slack folds down the
  // sides, with the free hem lifting in the gale.  aFlex rises with the drop so
  // the crown stays pinned and the skirts snap.
  // Where the lashings cross the sheet, in normalised x.  The sheet is pulled
  // hard IN under each strap and bellies OUT between them, and that alternation
  // is the only silhouette that says "fabric under tension" rather than "box
  // with a cloth texture on it".
  var TARP_ANCH = [-0.60, 0.0, 0.60];

  // THE CROWN IS NOT A LID, AND THAT IS A RENDERING FACT AS WELL AS AN ART ONE.
  //
  // This sheet had a flat top.  Over the load footprint the old height field
  // varied by about +-0.13 m across two square metres, i.e. under ten degrees
  // of slope everywhere, so its world normal sat at y > 0.98 over the whole
  // crown.  In this level that is not "slightly too tidy", it is a different
  // material: materials.js's wet contract calls any surface with normal.y above
  // 0.70 at full storm wetness STANDING WATER (gbWetSolve's flatN term), and
  // postfx's screen-space reflection applies the same test to a normal it
  // reconstructs from the depth buffer.  A two-square-metre horizontal plane
  // three metres from the lens therefore came back as a full-strength mirror -
  // and because a depth-derived normal is CONSTANT ACROSS A TRIANGLE, a mirror
  // on a 16x14 sheet prints as a mosaic of flat-shaded triangles with no
  // texture in it at all.  That is the pale faceted mound that was sitting in
  // the foreground of seven harbor framings.  It was never a missing material:
  // the material was correct throughout, the geometry was presenting it as a
  // pond.
  //
  // Two changes, both of them things a real lashed tarpaulin has:
  //
  //   CAMBER - the sheet is pulled over a load and stands proud along its
  //   spine, falling away to both eaves.  Most of the crown ends up between 10
  //   and 30 degrees instead of 2.
  //
  //   CREASES - it is cinched HARD under every lashing.  Each strap pulls a
  //   narrow groove with 35-45 degree walls across the sheet, and the cloth
  //   bellies up between them.  Those grooves are what break the crown into
  //   ridges: the ridge lines still catch a lamp (which is what a wet sheet in
  //   a downpour should do), the flanks between them no longer qualify as
  //   water.
  //
  // Tessellation goes with them.  ~10 cm quads rather than ~20, because this is
  // a FOREGROUND prop - the pose pass deliberately stands one three metres from
  // the lens - and at 20 cm the sheet reads as faceted in its own silhouette
  // before any screen-space pass gets near it.  ~2000 triangles per sheet
  // against a level budget of 2M, for the one prop the player is closest to.
  var TARP_CAMBER = 0.20;       // fraction of H the spine stands proud
  var TARP_CINCH = 0.086;       // metres the sheet is pulled down under a strap

  K.tarp = function (W, H, D, noise, seed) {
    var nx = 30, nz = 26;
    var g = new THREE.PlaneGeometry(W, D, nx, nz);
    g.rotateX(-Math.PI / 2);
    var p = g.attributes.position;
    var rng = new GAME.RNG(seed || 7);
    var phase = rng.range(0, 6.28);
    var hw = W * 0.5, hd = D * 0.5;
    // The load underneath is a good deal smaller than the sheet, because a
    // sheet that only overhangs by 16 cm cannot HANG - it sits on the load like
    // a lid, which is exactly how the old numbers read: a rigid pale plate with
    // a 30 cm valance.  A tarpaulin over a pallet stack comes most of the way
    // down the sides, and the drape is the silhouette.
    var lw = W * 0.5 - 0.42, ld = D * 0.5 - 0.38;
    var i, a;
    for (i = 0; i < p.count; i++) {
      var x = p.getX(i), z = p.getZ(i);
      var ax = Math.abs(x), az = Math.abs(z);
      // how far outside the load footprint this vertex is (0 on the crown)
      var ox = Math.max(0, ax - lw), oz = Math.max(0, az - ld);
      // Chebyshev, not Euclidean.  A radial drop makes the four CORNERS hang
      // half a metre lower than the edge midpoints, which reads as four torn
      // spikes rather than as a skirt; real sheeting hangs level and folds at
      // the corners.
      var drop = Math.max(ox, oz) + 0.22 * Math.min(ox, oz);
      // 1.10 m of drape at the corners, the same for both lots, so the caller
      // can solve one scale that lands the hem just clear of the deck.
      var y = H - Math.min(H + 0.30, drop * 1.95);
      // 1 on the crown, 0 once the sheet has broken over the corner
      var crown = 1 - M.saturate(drop * 2.2);
      // slack: the cloth bellies between the lashings
      var slack = Math.cos(x / hw * 2.4 + phase) * Math.cos(z / hd * 2.1 - phase) * 0.055;
      y += slack * crown;
      // ---- camber ------------------------------------------------------------
      // Highest along the spine (z = 0), falling to both eaves, with a gentle
      // fore-and-aft fall as well.  The -0.16 bias is SOLVED, not chosen: the
      // caller hangs the sheet with only about 5 cm of clearance over the load
      // (see _palletStack), so the camber has to be biased far enough up that
      // the deepest lashing crease still sits above the load's own top inside
      // the load footprint - otherwise the bales under it poke through the
      // sheet at every strap.  It leaves the eaves within 3 cm of the old flat
      // crown and the spine 17 cm proud of it.
      var ux = M.clamp(x / Math.max(lw, 1e-3), -1, 1);
      var uz = M.clamp(z / Math.max(ld, 1e-3), -1, 1);
      y += crown * H * TARP_CAMBER * ((1 - uz * uz) * (1 - 0.30 * ux * ux) - 0.16);
      // ---- lashing creases ---------------------------------------------------
      // A narrow, deep groove under each strap.  exp(-d^2*200) over a half-width
      // of hw metres is a ~8 cm sigma, so TARP_CINCH of drop puts the groove
      // wall at roughly 35-45 degrees - which is what a strap winched down over
      // a pallet stack actually does, and is also the angle at which a surface
      // stops qualifying as standing water.  Deepest along the spine, because
      // that is where a strap over a crowned load bites; tapered at the eaves so
      // the sheet cannot be pulled into the corner of the load underneath it.
      var crease = 0;
      for (a = 0; a < TARP_ANCH.length; a++) {
        var dxc = (x / hw) - TARP_ANCH[a];
        crease += Math.exp(-dxc * dxc * 200.0);
      }
      crease = M.saturate(crease) * (1 - 0.55 * uz * uz);
      y -= crown * (crease * TARP_CINCH - 0.024);
      // Folds.  The crown of a sheet over a load is never flat: it takes the
      // shape of what is under it and it ponds between the high points.
      if (noise) {
        y += noise.fbm3(x * 2.6, z * 2.6, phase, 3, 2.2, 0.5) * 0.10;
        y += noise.fbm2(x * 5.1 - phase, z * 5.1 + phase, 2, 2.3, 0.5) * 0.035;
        // A third, sharper band, crown only.  ~0.65 m wrinkles, six samples per
        // period on the new grid: too fine for the old one to carry, and the
        // reason the crown could stay smooth enough to mirror even after it was
        // cambered.  A tarpaulin that has been folded, stowed wet and dragged
        // over a stack is CRUMPLED at this scale; a sheet that is smooth at 20 cm
        // is a sheet straight off the roll.
        // Deliberately SMALL.  Measured: at 0.050 the crown's grazing ridge
        // stopped being a coherent wet highlight and became a field of isolated
        // over-bright pixels - the screen-space reflection reconstructs its
        // normal from depth, and a surface that changes direction faster than
        // the depth buffer can resolve reads as specular glitter, not as cloth.
        y += crown * noise.fbm2(x * 9.4 + phase * 1.7, z * 9.4 - phase, 2, 2.2, 0.5) * 0.026;
      }
      var skirt = M.saturate(drop * 2.0);
      // The free hem does not hang level: it is cut, worn and weighted unevenly,
      // so it hangs in scallops.  A dead-straight bottom edge is the single
      // loudest tell that a tarpaulin is a scaled box.
      if (noise) {
        y += noise.fbm2(x * 1.9 + phase, z * 1.9 - phase, 3, 2.1, 0.55) * 0.17 * skirt;
      }
      // cinch under each strap, belly between them
      var cin = 0;
      for (a = 0; a < TARP_ANCH.length; a++) {
        var dxa = (x / hw) - TARP_ANCH[a];
        cin += Math.exp(-dxa * dxa * 22.0);
      }
      cin = M.saturate(cin);
      var cinch = (cin - 0.30) * 0.15 * skirt;         // + = pulled inward
      // pull the hem inward slightly - cloth over a corner is not a right angle
      var pull = M.saturate(drop * 1.4) * 0.06;
      var nxp = x - Math.sign(x) * pull * (ox > 0 ? 1 : 0);
      var nzp = z - Math.sign(z) * (pull + cinch) * (oz > 0 ? 1 : 0);
      // The rolled hem.  The outermost ring curls back under and inward so the
      // bottom edge reads as a rounded, doubled lip instead of a knife cut.
      if (ax > hw - 1e-4 || az > hd - 1e-4) {
        y -= 0.048;
        if (ax > hw - 1e-4) nxp -= Math.sign(nxp) * 0.036;
        if (az > hd - 1e-4) nzp -= Math.sign(nzp) * 0.036;
      }
      p.setXYZ(i, nxp, y, nzp);
    }
    p.needsUpdate = true;
    g.computeVertexNormals();

    // Grommets punched through the hem, three on each free edge, sitting on the
    // deformed hem rather than on a remembered height.
    var parts = [part(g, null)];
    var eyes = [];
    for (a = 0; a < TARP_ANCH.length; a++) {
      for (var sd = -1; sd <= 1; sd += 2) {
        var tx = TARP_ANCH[a] * hw * 0.86, tz = sd * hd;
        var best = -1, bd = 1e9;
        for (i = 0; i < p.count; i++) {
          var qx = p.getX(i) - tx, qz = p.getZ(i) - tz;
          var q2 = qx * qx + qz * qz;
          if (q2 < bd) { bd = q2; best = i; }
        }
        if (best < 0) continue;
        var eg = tube(0.030, 0.010, 9, 4);
        eyes.push(eg);
        parts.push(part(eg, Tn(p.getX(best), p.getY(best) + 0.030, p.getZ(best) + sd * 0.008)));
      }
    }
    var out = mergeParts(parts, 0);
    if (!out) {
      for (i = 0; i < eyes.length; i++) eyes[i].dispose();
      out = g;
    } else {
      disposeParts(parts);
    }
    setFlex(out, function (x, y) {
      // stiff on the crown, loose at the hem, loosest at the very bottom
      var d = M.saturate((H - y) / Math.max(0.35, H + 0.30));
      return d * d * 0.85;
    });
    Geo.copyUV1(out);
    return out;
  };

  // A hanging cargo net, pegged along its top edge.
  K.net = function (W, H) {
    var g = new THREE.PlaneGeometry(W, H, 10, 10);
    g.translate(0, -H / 2, 0);
    setFlex(g, function (x, y) {
      var d = M.saturate(-y / Math.max(0.2, H));
      return d * d * 1.0 + Math.abs(x) / W * 0.2;
    });
    Geo.copyUV1(g);
    return g;
  };

  // Litter caught on a fence: a small crumpled card, pinned along one edge.
  K.litterCard = function (w, h, cell, rng) {
    var g = new THREE.PlaneGeometry(w, h, 3, 3);
    var p = g.attributes.position;
    for (var i = 0; i < p.count; i++) {
      p.setZ(i, rng.range(-0.02, 0.02));
      p.setX(i, p.getX(i) + rng.range(-0.012, 0.012));
      p.setY(i, p.getY(i) + rng.range(-0.012, 0.012));
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    // atlas cell
    var uv = g.attributes.uv;
    var ox = (cell % 2) * 0.5, oy = (cell < 2 ? 0.5 : 0);
    for (var u = 0; u < uv.count; u++) {
      uv.setXY(u, ox + uv.getX(u) * 0.5, oy + uv.getY(u) * 0.5);
    }
    uv.needsUpdate = true;
    setFlex(g, function (x, y) {
      return M.saturate((y + h / 2) / h) * 0.9;
    });
    Geo.copyUV1(g);
    return g;
  };

  // A weed / scum card standing at the quay lip.
  K.weedCard = function (w, h) {
    var g = new THREE.PlaneGeometry(w, h, 2, 3);
    g.translate(0, h / 2, 0);
    setFlex(g, function (x, y) { return M.saturate(y / h) * 0.6; });
    Geo.copyUV1(g);
    return g;
  };

  // An irregular flat pool.  Used for standing water and for oil film; the
  // outline is what sells it, so the radius wanders with fbm rather than being
  // a scaled circle.
  K.pool = function (radius, noise, seed, squash) {
    var seg = 30;
    var pos = [0, 0, 0];
    var uv = [0.5, 0.5];
    var nrm = [0, 1, 0];
    var idx = [];
    var ph = (seed || 0) * 3.77;
    for (var i = 0; i <= seg; i++) {
      var a = i / seg * Math.PI * 2;
      var r = radius * (0.72 + 0.42 * (noise ? (noise.fbm2(Math.cos(a) * 1.3 + ph, Math.sin(a) * 1.3 - ph, 3, 2.1, 0.55) * 0.5 + 0.5) : 0.6));
      var x = Math.cos(a) * r;
      var z = Math.sin(a) * r * (squash || 1);
      pos.push(x, 0, z);
      nrm.push(0, 1, 0);
      uv.push(0.5 + x / (radius * 2.4), 0.5 + z / (radius * 2.4));
      if (i > 0) idx.push(0, i, i + 1 > seg ? 1 : i + 1);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return g;
  };

  // A condensate drip: a stretched teardrop that falls on a loop.
  K.drip = function () {
    var g = new THREE.PlaneGeometry(0.022, 0.16, 1, 1);
    g.translate(0, -0.08, 0);
    return g;
  };

  // ==========================================================================
  // GAME.PropsHarbor
  // ==========================================================================
  function PropsHarbor(ctx) {
    this.ctx = ctx || {};
    this.root = new THREE.Object3D();
    this.root.name = 'props_harbor';
    this.root.matrixAutoUpdate = false;
    this.colliders = [];

    // Deterministic and independent of every other system's RNG stream, so
    // adding a raindrop somewhere else cannot reshuffle the quay.
    var seed = ((this.ctx.seed || 20260801) ^ 0x5F3A91C7) >>> 0;
    this.rng = new GAME.RNG(seed);
    this.noise = new GAME.Noise((seed ^ 0x2545F491) >>> 0);

    this.time = 0;
    this.uTime = { value: 0 };
    // amplitude (m), frequency (rad/s), vertical billow, spatial phase
    this.uWind = { value: new THREE.Vector4(0.10, 2.4, 0.55, 0.55) };
    // Nominal storm wind until ctx.weather exists: onshore, out of the
    // north-west across the water and up the apron.  Placement (litter drift,
    // hem direction, weed lean) is baked against this at build time; the
    // animation adopts ctx.weather.windDir the moment weather appears.
    this.uWindDir = { value: new THREE.Vector2(0.34, 0.94) };
    this.windDir = new THREE.Vector2(0.34, 0.94);
    this.windSpeed = 16;

    this.tex = {};
    this.mats = {};
    this.B = {};                  // instanced batches
    this.S = {                    // one-off geometry, merged per material
      steel: [], rust: [], deck: [], concrete: [], wood: [], rubber: [],
      grate: [], corr: [], paint: [], dry: [], lineDry: []
    };
    this.windMeshes = [];
    this.lightMasts = [];
    this.pools = [];              // {mesh} standing water, ripples animated
    this.gulls = [];              // {x,y,z,yaw,scale,phase} for the startle pass
    this._gullBatch = null;
    this._gullStartle = 0;
    this._occ = new Map();        // coarse occupancy grid for our own props
    this._skipped = 0;
    this._rayOK = true;

    this.stats = { instances: 0, drawCalls: 0, tris: 0, colliders: 0, skipped: 0, full: [] };

    // Nominal terminal footprint from the art direction (~90 x 70 m, apron
    // running along -Z, quay at the north end).  Every one of these is
    // OVERWRITTEN by _probeLayout when the level publishes something better;
    // they exist so a level that is still being written does not take this
    // module down with it.
    this.bounds = { x0: -44, x1: 44, z0: -34, z1: 30 };
    this.groundY = 0;
    this.quayZ = -32.5;
    this.apron = { x0: -13, x1: 13 };
    this.containers = [];
    this.toppled = null;

    try {
      if (this.ctx.scene) this.ctx.scene.add(this.root);
    } catch (e) { GAME.logError('propsH.ctor', e); }
  }

  PropsHarbor.prototype._phase = function (name, fn) {
    try { fn.call(this); } catch (e) { GAME.logError('propsH.' + name, e); }
    return GAME.yieldFrame();
  };

  PropsHarbor.prototype.build = async function () {
    await this._phase('textures', this._initTextures);
    await this._phase('materials', this._initMaterials);
    await this._phase('layout', this._probeLayout);
    await this._phase('kit', this._buildKit);
    await this._phase('quay', this._dressQuay);
    await this._phase('moorings', this._dressMoorings);
    // Machinery BEFORE cargo, deliberately.  A forklift, a bowser, a spreader,
    // a genset and a skip are the five biggest things in the kit and the only
    // ones that need four metres of clear ground; running them after the cargo
    // pass had filled every flank site meant three of the five simply never
    // landed.  A yard is blocked out with its plant and then filled in around
    // it, which is also how it is actually laid out.
    await this._phase('machinery', this._dressMachinery);
    await this._phase('cargo', this._dressCargo);
    await this._phase('interior', this._dressWarehouse);
    await this._phase('reefers', this._dressReefers);
    await this._phase('infrastructure', this._dressInfrastructure);
    await this._phase('perimeter', this._dressPerimeter);
    await this._phase('spill', this._dressSpill);
    await this._phase('debris', this._dressDebris);
    await this._phase('life', this._dressLife);
    // Runs late on purpose: it reads back everything already placed and only
    // adds a foreground mass where a published framing has nothing in the near
    // third, which is the difference between a shot and a survey photograph.
    await this._phase('poses', this._dressCameraPoses);
    await this._phase('commit', this._commit);
    return this;
  };

  // --------------------------------------------------------------------------
  // Textures
  // --------------------------------------------------------------------------
  PropsHarbor.prototype._initTextures = function () {
    var t = this.tex;
    var aniso = 8;
    try {
      if (this.ctx.renderer && this.ctx.renderer.capabilities) {
        aniso = Math.min(8, this.ctx.renderer.capabilities.getMaxAnisotropy() || 8);
      }
    } catch (e) { /* headless */ }
    this._aniso = aniso;

    var grunge = TX.grunge(256, 0x4C01D, 1.25);
    this._grunge = grunge;

    t.hazard = TX.tex(TX.hazard(256, 0x11, grunge), true, 1, 1, aniso);
    t.hazardN = grunge ? TX.normalFromHeight(TX.heightFromCanvas(grunge), 256, 1.1) : null;

    // Local chain-link and net alphas.  The library exposes a `chainlink`
    // material and it is the preferred source; these are the fallback AND the
    // alpha for the props-only cargo net, which the library does not carry.
    t.chainlink = TX.tex(TX.chainlink(256, 0x21), true, 1, 1, aniso);
    t.net = TX.tex(TX.cargoNet(256, 0x22), true, 1, 1, aniso);

    t.tarpA = TX.tex(TX.tarp(384, 0x31, grunge, '#2f4a4e'), true, 1, 1, aniso);
    t.tarpB = TX.tex(TX.tarp(384, 0x32, grunge, '#3a3a44'), true, 1, 1, aniso);
    var tarpCv = TX.tarp(256, 0x33, grunge, '#2f4a4e');
    if (tarpCv) t.tarpN = TX.normalFromHeight(TX.heightFromCanvas(tarpCv), 256, 1.0);
    t.tarpORM = TX.orm(64, function (u, v, o) {
      // PVC coat: a real sheen lobe, dulled where the mildew sits
      o.rough = 0.44 + Math.sin(u * 33) * 0.05 + Math.cos(v * 29) * 0.05;
      o.metal = 0;
      o.ao = 0.92;
    });

    t.sign = TX.tex(TX.sign(512, 256, 0x41, grunge,
      { bg: '#123244', fg: '#cfe2ee', bar: '#c46a1e' }), true, 1, 1, aniso);
    if (t.sign) t.sign.wrapS = t.sign.wrapT = THREE.ClampToEdgeWrapping;
    t.sign2 = TX.tex(TX.sign(512, 256, 0x42, grunge,
      { bg: '#1d1f22', fg: '#d8c65a', bar: '#8a2f22' }), true, 1, 1, aniso);
    if (t.sign2) t.sign2.wrapS = t.sign2.wrapT = THREE.ClampToEdgeWrapping;

    t.litter = TX.tex(TX.litter(256, 0x51), true, 1, 1, aniso);
    if (t.litter) t.litter.wrapS = t.litter.wrapT = THREE.ClampToEdgeWrapping;
    t.weed = TX.tex(TX.weed(256, 0x61), true, 1, 1, aniso);
    if (t.weed) t.weed.wrapS = t.weed.wrapT = THREE.ClampToEdgeWrapping;
    t.gull = TX.tex(TX.gull(128, 0x71), true, 1, 1, aniso);
    t.oil = TX.tex(TX.oil(256, 0x81), true, 1, 1, aniso);

    // Our OWN ripple field, deliberately not ctx.materials.rippleTexture().
    //
    // Sharing the library's field would put prop puddles in phase with the
    // level's, which sounds better than it is: this material animates its
    // ripples by scrolling texture.offset every frame, and texture.offset is a
    // property of the TEXTURE, not of the material using it.  Scrolling a
    // texture the library also samples would drag the level's puddles, the
    // apron streaking and the sea with it - a whole-level artefact caused by a
    // prop.  A local copy costs 64 KB and cannot reach anybody else's surface.
    t.ripple = TX.ripple(128, 0x91);
  };

  // --------------------------------------------------------------------------
  // Materials
  //
  // Names come from the level-2 contract; the second argument is the level-1
  // library name to fall back to if the harbor set is not present, which is
  // what lets this file be developed against a materials.js that is still
  // being written.  Everything is CLONED - mutating a cached library material
  // would corrupt it for level.js and every other consumer.
  // --------------------------------------------------------------------------
  PropsHarbor.prototype._material = function (name, fallback, opts) {
    opts = opts || {};
    var lib = this.ctx.materials;
    var mat = null;
    var want = name;
    try {
      if (lib && lib.get) {
        if (lib.has && !lib.has(name) && fallback && lib.has(fallback)) want = fallback;
        var m = lib.get(want, opts);
        // clone() is overridden by materials.js to preserve its shader work;
        // the wind chain therefore has to be applied AFTER this call, never
        // before, or the clone throws it away.
        if (m && m.clone) mat = m.clone();
      }
    } catch (e) { GAME.logError('propsH.mat:' + name, e); }
    if (!mat) mat = this._fallbackMaterial(name, opts);
    mat.name = 'hb_' + name;
    return mat;
  };

  var FALLBACK_SPECS = {
    container_steel: { base: '#585d61', corrode: true, seed: 12, rough: 0.58, metal: 0.85 },
    container_red: { base: '#5c2620', corrode: true, seed: 13, rough: 0.52, metal: 0.5 },
    container_blue: { base: '#1b3c56', corrode: true, seed: 14, rough: 0.52, metal: 0.5 },
    container_green: { base: '#254036', corrode: true, seed: 15, rough: 0.52, metal: 0.5 },
    ship_hull: { base: '#242a30', corrode: true, seed: 16, rough: 0.58, metal: 0.55 },
    wet_concrete: { base: '#5d6367', speck: '40,44,48', seed: 17, rough: 0.55, metal: 0 },
    dock_concrete: { base: '#5a6064', speck: '40,44,48', seed: 18, rough: 0.72, metal: 0 },
    steel_grate: { base: '#42474b', corrode: true, seed: 19, rough: 0.52, metal: 0.9 },
    deck_plate: { base: '#3e4348', corrode: true, seed: 20, rough: 0.52, metal: 0.88 },
    corrugated_roof: { base: '#4a4f4c', corrode: true, seed: 21, rough: 0.58, metal: 0.8 },
    reefer_panel: { base: '#7d858a', speck: '60,66,70', seed: 22, rough: 0.42, metal: 0.35 },
    rubber_fender: { base: '#191b1d', speck: '60,64,68', seed: 23, rough: 0.62, metal: 0 },
    rope: { base: '#6d6250', speck: '46,40,32', seed: 24, rough: 0.88, metal: 0 },
    tarpaulin: { base: '#2f4a4e', seed: 25, rough: 0.48, metal: 0 },
    chainlink: { base: '#7b8288', seed: 26, rough: 0.45, metal: 0.9 },
    painted_line: { base: '#a89540', seed: 27, rough: 0.62, metal: 0 },
    wood_plank: { base: '#5a4c3a', planks: true, seed: 28, rough: 0.84, metal: 0 },
    rusted_metal: { base: '#5e3b26', corrode: true, seed: 29, rough: 0.72, metal: 0.7 }
  };

  PropsHarbor.prototype._fallbackMaterial = function (name, opts) {
    var spec = FALLBACK_SPECS[name] || FALLBACK_SPECS.deck_plate;
    var key = 'fb_' + name;
    if (!this.tex[key]) {
      this.tex[key] = TX.tex(TX.surface(256, this._grunge, spec, spec.seed), true, 1, 1, this._aniso);
    }
    var m = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: this.tex[key] || null,
      roughness: spec.rough === undefined ? 0.7 : spec.rough,
      metalness: spec.metal === undefined ? 0 : spec.metal,
      envMapIntensity: 1.0
    });
    if (this.tex.hazardN) { m.normalMap = this.tex.hazardN; m.normalScale = new THREE.Vector2(0.6, 0.6); }
    if (opts) {
      if (opts.side !== undefined) m.side = opts.side;
      if (opts.alphaTest !== undefined) m.alphaTest = opts.alphaTest;
      if (opts.vertexColors) m.vertexColors = true;
      if (opts.transparent) m.transparent = true;
      if (opts.emissive !== undefined) {
        m.emissive = new THREE.Color(opts.emissive);
        m.emissiveIntensity = opts.emissiveIntensity || 1;
      }
    }
    return m;
  };

  PropsHarbor.prototype._initMaterials = function () {
    var m = this.mats;
    var W = { vertexColors: true };            // wear mode: R grime, G wet, B edge
    var Mul = { vertexColors: false };

    // ---- structural / hardware ---------------------------------------------
    m.steel = this._material('container_steel', 'rusted_metal', W);
    m.rust = this._material('rusted_metal', 'rusted_metal', W);
    m.deck = this._material('deck_plate', 'painted_metal', W);
    m.grate = this._material('steel_grate', 'painted_metal',
      { vertexColors: true, side: THREE.DoubleSide, alphaTest: 0.5 });
    m.concrete = this._material('dock_concrete', 'concrete', W);
    m.wetConcrete = this._material('wet_concrete', 'concrete', W);
    m.corr = this._material('corrugated_roof', 'corrugated_metal', W);
    m.reefer = this._material('reefer_panel', 'painted_metal', W);
    m.hull = this._material('ship_hull', 'painted_metal', W);
    m.rubber = this._material('rubber_fender', 'rubber', W);
    m.rope = this._material('rope', 'fabric', W);
    // The library's default "exposed substrate" for a dielectric is 0xb9ae9a, a
    // pale beige, and the edge-wear channel blends toward it.  On a soaking
    // pallet stack that reads as BLEACHED DRIFTWOOD - the one thing wet timber
    // in a downpour is not.  Weathered damp softwood is a dark silver-brown.
    m.wood = this._material('wood_plank', 'wood_plank',
      { vertexColors: true, wearColor: 0x6f6353 });
    m.line = this._material('painted_line', 'painted_metal', W);

    // The three container lots, reused for painted plant, drums and cones so
    // the level's own colour story runs through the props instead of a second,
    // unrelated palette.
    m.red = this._material('container_red', 'painted_metal', W);
    m.blue = this._material('container_blue', 'painted_metal', W);
    m.green = this._material('container_green', 'painted_metal', W);

    // Shrink-wrapped unit loads.  The same coated sheet as the tarpaulins, but
    // pale and stretched tight, so it reads as polythene rather than canvas -
    // and NO wind, because a wrapped bale does not flap.
    //
    // MULTIPLY, not copy.  Same reasoning as the two tarpaulin lots below, and
    // this pair was left behind when those were fixed: `.copy` throws away the
    // library's calibrated albedo gain (the ~1.63 that puts the tarpaulin map
    // on its declared 0.10 reflectance) and replaces it with a normalised tint
    // whose max channel is 1.0 by construction, so the load came out DARKER
    // than its own definition and the pale-polythene read the tint exists to
    // buy never landed.  Multiplying keeps the gain and lets the hex do the one
    // job it was meant to do, which is shift the hue.
    // A bale also does not pond: same argument as the sheet (see TW below).
    m.wrap = this._material('tarpaulin', 'fabric',
      { vertexColors: true, puddle: 0 });
    normTint(0xb9c2c4, 0.55, _col);
    m.wrap.color.multiply(_col);

    // Warehouse interior: opt OUT of the wet layer entirely.  Rain does not
    // reach under a roof, and props that soak indoors break the one place in
    // the level where the player gets relief from the storm.
    m.dry = this._material('dock_concrete', 'concrete', { vertexColors: true, wet: false });
    m.dryWood = this._material('wood_plank', 'wood_plank',
      { vertexColors: true, wet: false, wearColor: 0x7c705d });
    m.drySteel = this._material('deck_plate', 'painted_metal', { vertexColors: true, wet: false });
    // Pale polythene-wrapped unit loads and painted floor markings: the two
    // lightest surfaces in the kit, and the reason the interior floor is not a
    // black plate under a lit roof.
    m.wrapDry = this._material('tarpaulin', 'fabric',
      { vertexColors: true, wet: false, puddle: 0 });
    normTint(0xc4ccce, 0.55, _col);
    m.wrapDry.color.multiply(_col);
    m.lineDry = this._material('painted_line', 'painted_metal', { vertexColors: true, wet: false });

    // ---- hazard striping ----------------------------------------------------
    // Local art: the library has no diagonal-stripe surface and the striping is
    // the single most legible marking in a night frame.
    m.hazard = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: this.tex.hazard || null,
      normalMap: this.tex.hazardN || null,
      roughness: 0.52, metalness: 0.25, envMapIntensity: 1.15,
      vertexColors: true
    });
    if (m.hazard.normalMap) m.hazard.normalScale = new THREE.Vector2(0.55, 0.55);

    // ---- fence --------------------------------------------------------------
    m.fence = this._material('chainlink', 'painted_metal',
      { side: THREE.DoubleSide, alphaTest: 0.42, vertexColors: true });
    // If the library did not supply a map (fallback path) attach ours, or the
    // fence renders as a solid plate - the exact instant-fail this texture was
    // generated to avoid.
    if (!m.fence.map && this.tex.chainlink) {
      m.fence.map = this.tex.chainlink;
      m.fence.alphaMap = this.tex.chainlink;
      m.fence.transparent = false;
      m.fence.alphaTest = 0.42;
      m.fence.side = THREE.DoubleSide;
      m.fence.needsUpdate = true;
    }
    if (m.fence.map) { m.fence.map.wrapS = m.fence.map.wrapT = THREE.RepeatWrapping; }

    // ---- tarpaulin (wind) ---------------------------------------------------
    // wearColor: the scrim under a scuffed PVC coat is a dull grey-blue, not
    // the library's default pale beige - which was blending the CROWN of every
    // sheet (up-facing, so maximum edge-wear weight) toward 0xb9ae9a and is the
    // reason the tarpaulin photographed as poured concrete.
    // puddle: ZERO, not the 0.16 this used to hold and not the def's 0.65.
    // `puddle` is not a dial for "how wet"; it is the answer to "can standing
    // water lie here at all", and for a domed sheet lashed over a load the
    // answer is no - it sheds.  Any non-zero value trips three separate things
    // in materials.js: gbWetSolve's pud term (which collapses the roughness to
    // 0.030, i.e. a mirror, wherever the world-space basin field peaks), the
    // `sheet` floor on film thickness (step(0.004, cfg.z) - a sustained
    // downpour is allowed to sheet a SLAB, and a tarpaulin is not one), and the
    // ripple sampler, whose presence disables the stochastic tile low-pass and
    // costs the sheet the repetition-breaking every other surface in the level
    // gets.  Zeroing it turns all three off with one number that is also the
    // physically true one.
    // wetRough: the def polishes to 0.070, which on an up-facing crown makes
    // the sheet a horizontal mirror - and a horizontal mirror under a sodium
    // head returns the lamp at full strength, which is how a dark blue
    // tarpaulin ended up the brightest object in the level.
    // Still glossy, still the wettest-reading soft good in the yard, but
    // no longer a flooded roof pan.
    var TW = {
      side: THREE.DoubleSide, vertexColors: true, wearColor: 0x5d6a70,
      puddle: 0, wetRough: 0.170, wetDark: 0.62, envMapIntensity: 0.60
    };
    m.tarpA = this._material('tarpaulin', 'fabric', TW);
    m.tarpB = this._material('tarpaulin', 'fabric', TW);
    // and a wet PVC sheet gets its read from a tight specular lobe, not from a
    // broad retroreflective sheen wash across the crown
    if (m.tarpA.sheen !== undefined) m.tarpA.sheen = 0.06;
    if (m.tarpB.sheen !== undefined) m.tarpB.sheen = 0.06;
    if (!m.tarpA.map && this.tex.tarpA) {
      m.tarpA.map = this.tex.tarpA; m.tarpA.normalMap = this.tex.tarpN || null;
      m.tarpA.roughnessMap = m.tarpA.aoMap = this.tex.tarpORM || null;
      m.tarpA.needsUpdate = true;
    }
    if (!m.tarpB.map && this.tex.tarpB) {
      m.tarpB.map = this.tex.tarpB; m.tarpB.normalMap = this.tex.tarpN || null;
      m.tarpB.roughnessMap = m.tarpB.aoMap = this.tex.tarpORM || null;
      m.tarpB.needsUpdate = true;
    }
    // A tarpaulin is NEVER grey, and it is never the brightest thing in a
    // sodium-lit yard at two in the morning.
    //
    // These two lines used to be `.copy(_col)`, which is the bug: the library's
    // `tarpaulin` entry carries a CALIBRATED albedo gain (alb 0.10) baked into
    // mat.color, and overwriting that with a normalised tint - whose max
    // channel is 1.0 by construction - multiplied the map by near-white.  The
    // result was a large pale-grey wedge reading as poured concrete, brighter
    // than any sodium-lit steel in the same frame, sitting in the foreground of
    // three captures.  MULTIPLY keeps the gain and makes the hex do the one job
    // it was ever meant to do.
    //
    // Two saturated lots rather than one: PVC blue and faded orange are what a
    // terminal's sheets actually are, and the hue has to come from the MATERIAL
    // because the instance colour on these batches is the wear mask (R grime,
    // G wetness, B edge) - writing hue into it would paint a tarpaulin dry.
    normTint(0x1f5f95, 0.86, _col); m.tarpA.color.multiply(_col);   // PVC blue
    normTint(0x9a4a0e, 0.86, _col); m.tarpB.color.multiply(_col);   // faded orange
    applyWind(m.tarpA, this.uTime, this.uWind, this.uWindDir, 'ta');
    applyWind(m.tarpB, this.uTime, this.uWind, this.uWindDir, 'tb');

    // ---- cargo net (wind, alpha) -------------------------------------------
    m.net = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: this.tex.net || null, alphaMap: this.tex.net || null,
      alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.86, metalness: 0.0,
      envMapIntensity: 1.0
    });
    applyWind(m.net, this.uTime, this.uWind, this.uWindDir, 'nt');

    // ---- rope and chain (wind) ---------------------------------------------
    m.ropeWind = this._material('rope', 'fabric', W);
    applyWind(m.ropeWind, this.uTime, this.uWind, this.uWindDir, 'rp');
    m.chain = this._material('rusted_metal', 'rusted_metal', W);
    applyWind(m.chain, this.uTime, this.uWind, this.uWindDir, 'ch');

    // ---- litter (wind, alpha) ----------------------------------------------
    m.litter = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: this.tex.litter || null, alphaMap: this.tex.litter || null,
      alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.72, metalness: 0.0,
      envMapIntensity: 1.0
    });
    applyWind(m.litter, this.uTime, this.uWind, this.uWindDir, 'lt');

    m.weed = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: this.tex.weed || null, alphaMap: this.tex.weed || null,
      alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.42, metalness: 0.0,
      envMapIntensity: 1.2
    });
    applyWind(m.weed, this.uTime, this.uWind, this.uWindDir, 'wd');

    // ---- signage ------------------------------------------------------------
    m.sign = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: this.tex.sign || null,
      roughness: 0.40, metalness: 0.10, envMapIntensity: 1.25, side: THREE.DoubleSide
    });
    m.sign2 = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: this.tex.sign2 || null,
      roughness: 0.42, metalness: 0.10, envMapIntensity: 1.25, side: THREE.DoubleSide
    });

    // ---- gull ---------------------------------------------------------------
    // A gull is WHITE, and at 02:00 in a terminal the only thing that makes a
    // white bird read is that it picks up more sky and more sodium bounce than
    // anything around it.  With envMapIntensity 1.0 and no emissive floor they
    // rendered as black dashes indistinguishable from dirt on the sensor, so
    // the plumage now takes a strong environment response plus a very small
    // cold lift that keeps it off the toe of the tone curve.
    m.gull = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: this.tex.gull || null,
      roughness: 0.58, metalness: 0.0, envMapIntensity: 2.4,
      emissive: new THREE.Color(0.020, 0.026, 0.034), emissiveIntensity: 1.0
    });

    // ---- standing water and oil --------------------------------------------
    // A pool is not a decal: near-zero roughness, a real ripple normal that
    // scrolls, and enough transmission-free darkness that it reads as depth.
    var PhysCtor = THREE.MeshPhysicalMaterial || THREE.MeshStandardMaterial;
    // A puddle is a FILM OF WATER OVER CONCRETE, not a hole cut in the apron.
    //
    // It used to be modelled as one: near-black albedo, opacity 0.94, roughness
    // 0.035.  In daylight that is invisible; in a night terminal with no
    // screen-space reflections it is catastrophic, because a 0.035 mirror
    // reflects the environment - and the environment at 02:00 is black storm
    // cloud.  Every pool rendered as a flat black disc punched into a lit
    // floor, which is the "wet ground that is not reflective" instant-fail with
    // the sign reversed.
    //
    // Three changes, all physical rather than cosmetic: the water is
    // TRANSLUCENT so the concrete under it still reads; roughness is high
    // enough that a lamp makes a stretched streak across the pool instead of a
    // point that only exists at one exact angle; and the env response is raised
    // to compensate for the light lost to the alpha.
    m.pool = new PhysCtor({
      color: new THREE.Color(0.020, 0.025, 0.031),
      roughness: 0.115, metalness: 0.0,
      normalMap: this.tex.ripple || null,
      envMapIntensity: 2.0,
      transparent: true, opacity: 0.50, depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    });
    if (m.pool.normalMap) {
      m.pool.normalMap.wrapS = m.pool.normalMap.wrapT = THREE.RepeatWrapping;
      m.pool.normalScale = new THREE.Vector2(0.28, 0.28);
    }
    m.oil = new PhysCtor({
      color: 0xffffff, map: this.tex.oil || null,
      roughness: 0.10, metalness: 0.0,
      normalMap: this.tex.ripple || null,
      envMapIntensity: 1.8,
      transparent: true, opacity: 0.62, depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3
    });
    if (m.oil.iridescence !== undefined) {
      // Thin-film interference is the whole point of a fuel slick; three has a
      // real iridescence lobe in r180, so use it rather than painting rainbows.
      m.oil.iridescence = 1.0;
      m.oil.iridescenceIOR = 1.32;
      if (m.oil.iridescenceThicknessRange) m.oil.iridescenceThicknessRange = [180, 780];
    }
    if (m.oil.normalMap) m.oil.normalScale = new THREE.Vector2(0.18, 0.18);

    // ---- condensate drips ---------------------------------------------------
    m.drip = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0.42, 0.48, 0.55),
      transparent: true, opacity: 0.55, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide
    });
    this._dripUniform = { value: 0 };
    chainCompile(m.drip, 'hbdrip', dripCompile(this.uTime));

    // ---- reefer display -----------------------------------------------------
    m.display = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.10, 0.85, 0.42) });
    m.lens = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.62, 0.26) });

    // Every wind material needs a matching depth material or its shadow stays
    // rigid while the cloth moves.
    m.tarpDepth = windDepthMaterial(this.uTime, this.uWind, this.uWindDir, null, 0, THREE.DoubleSide);
    m.alphaDepth = windDepthMaterial(this.uTime, this.uWind, this.uWindDir,
      this.tex.litter || null, 0.45, THREE.DoubleSide);
  };

  // Falling-drip vertex animation, kept out of _initMaterials so the closure
  // captures nothing but the shared time uniform.
  function dripCompile(uTime) {
    return function (shader) {
      shader.uniforms.hbTime = uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float hbTime;')
        .replace('#include <begin_vertex>', [
          '#include <begin_vertex>',
          '#ifdef USE_INSTANCING',
          'vec3 dOrg = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;',
          'float dPh = fract( dOrg.x * 7.31 + dOrg.y * 3.17 + dOrg.z * 11.7 );',
          'float dT = fract( hbTime * 0.62 + dPh );',
          // accelerate under gravity, then reset - a drip does not fall linearly
          'transformed.y -= dT * dT * 1.30;',
          'transformed.xz *= mix( 1.35, 0.75, dT );',
          '#endif'
        ].join('\n'));
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float hbTime;');
    };
  }

  // --------------------------------------------------------------------------
  // Layout
  //
  // The level owns the metres; this file discovers them.  Everything below is
  // derived from what ctx.level actually publishes - its floor colliders, its
  // container-sized boxes, its camera framings - with the art direction's
  // nominal terminal as the floor under the whole thing.  That is what allows
  // props_harbor and level_harbor to be written at the same time without one
  // hard-coding the other's numbers.
  // --------------------------------------------------------------------------
  PropsHarbor.prototype._probeLayout = function () {
    var lvl = this.ctx.level;
    this.hash = new GAME.SpatialHash(4);
    this._qout = [];
    this._noLevel = !(lvl && lvl.colliders && lvl.colliders.length);

    var fx0 = Infinity, fx1 = -Infinity, fz0 = Infinity, fz1 = -Infinity;
    var ax0 = Infinity, ax1 = -Infinity, az0 = Infinity, az1 = -Infinity;
    var i;

    // The yard floor, before anything else: everything downstream is measured
    // relative to it.  Taken from the level's own sampleGround rather than
    // averaged out of the floor colliders, because a harbor level's floor set
    // includes the SEA - a single collider three hundred metres across sitting
    // 2.6 m below the quay - and averaging it in drags the datum underwater,
    // which then throws off the bounds, the quay edge and every probe that
    // uses them.
    this.groundY = this._probeGroundY();

    if (!this._noLevel) {
      var cs = lvl.colliders;
      for (i = 0; i < cs.length; i++) {
        var c = cs[i];
        if (!c || c.type !== 'box' || !c.center || !c.halfExtents) continue;
        GAME.Collision.boxBounds(c, _bmin, _bmax);
        this.hash.insert(c, _bmin, _bmax);
        var he = c.halfExtents;
        if (c.floor) {
          // Only floors at yard level define the yard: the sea, the ship's deck
          // and the crane walkway are all floors and none of them is the apron.
          if (Math.abs(_bmax.y - this.groundY) > 1.6) continue;
          if (_bmax.x - _bmin.x > 60 || _bmax.z - _bmin.z > 60) continue;
          if (_bmin.x < fx0) fx0 = _bmin.x;
          if (_bmax.x > fx1) fx1 = _bmax.x;
          if (_bmin.z < fz0) fz0 = _bmin.z;
          if (_bmax.z > fz1) fz1 = _bmax.z;
          continue;
        }
        if (_bmin.x < ax0) ax0 = _bmin.x;
        if (_bmax.x > ax1) ax1 = _bmax.x;
        if (_bmin.z < az0) az0 = _bmin.z;
        if (_bmax.z > az1) az1 = _bmax.z;
        // ---- container detection ------------------------------------------
        // An ISO box is 2.438 wide and 2.591 high; a STACK of them is the same
        // footprint n courses tall, and a level publishes the stack as one
        // collider.  So the test is on the footprint - the short horizontal
        // half-extent is always ~1.22 and the long one ~3.03 (20 ft) or ~6.10
        // (40 ft) - with the height free to be any whole number of courses.
        // Sorting all three half-extents together (the obvious approach) fails
        // the moment a four-high 20 ft stack is taller than it is long.
        var hMin = Math.min(he.x, he.z), hMax = Math.max(he.x, he.z);
        if (hMin > 1.04 && hMin < 1.50 && hMax > 2.6 && hMax < 6.9 &&
            he.y > 1.05 && he.y < 6.0) {
          var up = _va.set(0, 1, 0);
          if (c.quaternion) up.applyQuaternion(c.quaternion);
          this.containers.push({
            c: c,
            x: c.center.x, y: c.center.y, z: c.center.z,
            base: _bmin.y, top: _bmax.y,
            hx: he.x, hy: he.y, hz: he.z,
            minx: _bmin.x, maxx: _bmax.x, minz: _bmin.z, maxz: _bmax.z,
            toppled: up.y < 0.90
          });
        }
      }
    }

    if (isFinite(fx0) && fx1 - fx0 > 12) {
      this.bounds = { x0: fx0, x1: fx1, z0: fz0, z1: fz1 };
    } else if (isFinite(ax0)) {
      this.bounds = {
        x0: Math.max(ax0, -70), x1: Math.min(ax1, 70),
        z0: Math.max(az0, -70), z1: Math.min(az1, 70)
      };
    }
    // Guard against a degenerate or absurd published extent.
    if (!(this.bounds.x1 - this.bounds.x0 > 8) || !(this.bounds.z1 - this.bounds.z0 > 8)) {
      this.bounds = { x0: -44, x1: 44, z0: -34, z1: 30 };
    }
    if (!isFinite(this.groundY)) this.groundY = 0;

    // ---- quay edge ----------------------------------------------------------
    // March in from the seaward end until three consecutive probes find solid
    // ground at about apron height.  Robust against the sea being a collider,
    // against the apron starting somewhere other than the collider bound, and
    // against there being no raycast at all.
    this.quayZ = this._findQuayEdge();

    // ---- apron --------------------------------------------------------------
    // The open lane is wherever the containers are NOT.  Take the widest gap in
    // the container footprint histogram across x; fall back to the middle third.
    this.apron = this._findApron();

    // ---- a toppled container, if the level built one ------------------------
    for (i = 0; i < this.containers.length; i++) {
      if (this.containers[i].toppled) { this.toppled = this.containers[i]; break; }
    }

    // ---- camera framings ----------------------------------------------------
    this.poses = (lvl && lvl.cameraPoses) || null;

    // ---- who owns what, and where the level put it --------------------------
    this._resolveOwnership();
    this._readAnchors();
    this.interior = this._findInterior();

    // ---- walking lines ------------------------------------------------------
    // Where feet and tyres actually go: the apron centreline, the quay edge and
    // the line from the gate to the warehouse.  Used to KEEP CLEAR - clutter
    // dumped across a walking line is the thing that makes set dressing read as
    // scattered rather than placed.
    //
    // The ribbon is 1.8 m, not 4.2 m.  A 4.2 m keep-clear plus the prop's own
    // radius swept a corridor six metres wide down the middle of the yard and
    // another five along the quay - and every published camera pose looks
    // straight down one of them, so the entire prop kit was being built into
    // the two strips the camera never photographs.  A swept lane is a WALKABLE
    // RIBBON; the yard either side of it is where the set lives.
    var ac = (this.apron.x0 + this.apron.x1) * 0.5;
    this.lanes = [
      { x0: ac, z0: this.bounds.z1 - 2, x1: ac, z1: this.quayZ + 3, w: 1.8 },
      { x0: this.bounds.x0 + 6, z0: this.quayZ + 3.2, x1: this.bounds.x1 - 6, z1: this.quayZ + 3.2, w: 1.8 }
    ];
  };

  PropsHarbor.prototype._findQuayEdge = function () {
    var b = this.bounds;
    var lanes = [(b.x0 + b.x1) * 0.5, (b.x0 * 0.7 + b.x1 * 0.3), (b.x0 * 0.3 + b.x1 * 0.7)];
    var best = [];
    for (var l = 0; l < lanes.length; l++) {
      var run = 0, firstZ = null;
      for (var z = b.z0 - 2; z < b.z1; z += 0.4) {
        if (this._hasGround(lanes[l], z)) {
          if (run === 0) firstZ = z;
          if (++run >= 3) { best.push(firstZ); break; }
        } else { run = 0; firstZ = null; }
      }
    }
    if (!best.length) return Math.min(b.z0 + 1.5, b.z1 - 4);
    best.sort(function (a, c) { return a - c; });
    var q = best[Math.floor(best.length / 2)];
    if (!isFinite(q) || q > b.z1 - 4) q = Math.min(b.z0 + 1.5, b.z1 - 4);
    return q;
  };

  // The yard datum.  sampleGround is the level's own answer and is preferred;
  // failing that, take the MEDIAN of a spread of downward raycasts, which is
  // robust against the handful that land on a container roof or in the water.
  PropsHarbor.prototype._probeGroundY = function () {
    var lvl = this.ctx.level;
    var hits = [];
    var i, j;
    if (lvl && lvl.sampleGround) {
      for (i = -1; i <= 1; i++) {
        for (j = -1; j <= 1; j++) {
          try {
            var s = lvl.sampleGround(i * 6, j * 6);
            if (isFinite(s)) hits.push(s);
          } catch (e) { break; }
        }
      }
    }
    if (!hits.length && lvl && lvl.raycast) {
      for (i = -2; i <= 2; i++) {
        for (j = -2; j <= 2; j++) {
          _rayO.set(i * 7, 40, j * 7);
          _rayD.set(0, -1, 0);
          try {
            var r = lvl.raycast(_rayO, _rayD, 80);
            if (r && r.hit && r.point && isFinite(r.point.y)) hits.push(r.point.y);
          } catch (e2) { this._rayOK = false; break; }
        }
      }
    }
    if (!hits.length) return 0;
    hits.sort(function (a, b) { return a - b; });
    return hits[Math.floor(hits.length / 2)];
  };

  // ==========================================================================
  // Ownership
  //
  // Resolved ONCE, from what the level PUBLISHES, and never from a geometric
  // probe.  Two heuristics used to live here and both were quietly wrong:
  //
  //   * "the level owns the quay" was read off level.bollards being non-empty,
  //     and then ALSO silently skipped the fenders, the chain rail, the mooring
  //     lines and the gangway.  Four separate features hidden behind one test,
  //     with nothing in the build output to say they had been dropped.
  //   * "there is already a perimeter" was decided by firing sphere queries at
  //     chest height along the landward bound and calling it a fence if 45% of
  //     them hit something.  A parked trailer reads as a fence; an open gate
  //     reads as no fence; and either answer silently doubles or deletes forty
  //     metres of chain-link.
  //
  // What replaces them: one named flag per feature, resolved in a fixed order a
  // reader can check against the level source, and reported in the propsdbg
  // blob so the answer is visible instead of inferred.
  //
  //   1. level.ownedProps[feature] is a boolean  -> the level states it
  //   2. level[<that feature's own anchor>] is a non-empty array -> published
  //   3. the feature rides the FIXED-INFRASTRUCTURE bundle -> see below
  //   4. otherwise props builds it
  //
  // (3) is the one judgement call, and it is now DECLARED rather than being an
  // invisible side effect of an `if`: a level that authors its own fixed
  // infrastructure authors all of it in one pass and has no reason to publish a
  // separate anchor per piece.  level_harbor.js builds bollards, fenders, the
  // chain rail, the mooring lines, the accommodation ladder and the perimeter
  // together and publishes only `bollards`, `practicalLights`, `reefers` and
  // `wetPatches` out of that set.  Any one of those four is proof the level
  // dressed itself; a level that publishes none of them is a bare shell and
  // props builds the lot.
  // ==========================================================================
  var INFRA_ANCHORS = ['bollards', 'practicalLights', 'reefers', 'wetPatches'];

  // feature -> the array the level would publish if it owned that feature.
  // Features whose anchor no level currently publishes still get their own
  // name here, so a level that starts publishing one is honoured immediately
  // and so the propsdbg blob names the feature that was skipped.
  var FEATURE_ANCHOR = {
    bollards: 'bollards',
    fenders: 'fenders',
    chainRail: 'chainRails',
    moorings: 'moorings',
    gangway: 'gangways',
    masts: 'practicalLights',
    reefers: 'reefers',
    fence: 'perimeter',
    puddles: 'wetPatches'
  };

  PropsHarbor.prototype._resolveOwnership = function () {
    var lvl = this.ctx.level;
    var decl = (lvl && lvl.ownedProps) || null;
    var infra = false, i;
    for (i = 0; i < INFRA_ANCHORS.length; i++) {
      var a = lvl && lvl[INFRA_ANCHORS[i]];
      if (a && a.length) { infra = true; break; }
    }
    this.own = {};
    this.ownWhy = {};
    for (var f in FEATURE_ANCHOR) {
      if (!Object.prototype.hasOwnProperty.call(FEATURE_ANCHOR, f)) continue;
      var arr = lvl && lvl[FEATURE_ANCHOR[f]];
      var mine, why;
      if (decl && typeof decl[f] === 'boolean') { mine = !decl[f]; why = 'declared'; }
      else if (arr && arr.length) { mine = false; why = FEATURE_ANCHOR[f]; }
      else if (infra) { mine = false; why = 'bundle'; }
      else { mine = true; why = 'unclaimed'; }
      this.own[f] = mine;
      this.ownWhy[f] = why;
    }
    // The quay pass reads this name; it is exactly the bollard flag.
    this.own.quay = this.own.bollards;
  };

  // The level's anchors, converted once into the shape the dressing passes
  // want.  Nothing downstream re-derives a published coordinate.
  PropsHarbor.prototype._readAnchors = function () {
    var lvl = this.ctx.level, i;
    // Bollards are published AT THE HEAD.  Both heights are kept: the base is
    // where anything standing beside one goes, and the perch is the actual top
    // of the casting, measured off the collider instead of guessed with a
    // constant - which is how gulls ended up sunk into the bollard heads.
    if (lvl && lvl.bollards && lvl.bollards.length) {
      this.bollards = [];
      for (i = 0; i < lvl.bollards.length; i++) {
        var lb = lvl.bollards[i];
        if (!lb || !isFinite(lb.x) || !isFinite(lb.z)) continue;
        var head = isFinite(lb.y) ? lb.y : this.groundY + 0.82;
        var base = this._ground(lb.x, lb.z);
        if (!isFinite(base)) base = head - 0.82;
        var top = this._solidTop(lb.x, lb.z, head + 1.4);
        this.bollards.push({
          x: lb.x, z: lb.z, y: base, headY: head,
          perchY: isFinite(top) && top > base + 0.4 ? top : head + 0.12
        });
      }
    }
    if (lvl && lvl.toppled && isFinite(lvl.toppled.x)) this.toppledAt = lvl.toppled;
    // Published volumetric cones.  props does not draw them, but their GROUND
    // FOOTPRINT is the single most useful anchor in the level: standing water
    // under a lamp is what turns a cone in the air into a pool of light on the
    // deck, and it is the one thing a props pass can put exactly where the
    // light already is instead of scattering and hoping.
    this.shafts = [];
    var sh = lvl && lvl.lightShafts;
    if (sh && sh.length) {
      for (i = 0; i < sh.length; i++) {
        var s = sh[i];
        if (!s || !s.origin || !s.dir) continue;
        var dy = s.dir.y;
        if (!(dy < -0.2)) continue;                 // not pointed at the ground
        var gy = this._ground(s.origin.x, s.origin.z);
        var t = (s.origin.y - gy) / -dy;
        if (!(t > 0.5) || !isFinite(t)) continue;
        this.shafts.push({
          x: s.origin.x + s.dir.x * t,
          z: s.origin.z + s.dir.z * t,
          w: isFinite(s.width) ? s.width : 2.4,
          kind: s.kind || 'mast',
          strength: isFinite(s.strength) ? s.strength : 1
        });
      }
    }
  };

  // The highest solid (non-floor) surface under (x,z) at or below yMax.  Used
  // to perch things on top of geometry somebody else authored.
  PropsHarbor.prototype._solidTop = function (x, z, yMax) {
    if (!this.hash) return NaN;
    _bmin.set(x - 0.05, -1e4, z - 0.05);
    _bmax.set(x + 0.05, yMax, z + 0.05);
    var list = this.hash.query(_bmin, _bmax, this._qout);
    var best = NaN;
    for (var i = 0; i < list.length; i++) {
      if (list[i].floor) continue;
      GAME.Collision.boxBounds(list[i], _va, _vb);
      if (x < _va.x || x > _vb.x || z < _va.z || z > _vb.z) continue;
      if (_vb.y > yMax) continue;
      if (!(best > _vb.y)) best = _vb.y;
    }
    return best;
  };

  // The container collider the published point sits inside, if any.  Published
  // anchors carry a centre and a course count but no orientation, so the box
  // itself is the only honest source for "which way does this thing face".
  PropsHarbor.prototype._containerAt = function (x, z) {
    var best = null, bestD = Infinity;
    for (var i = 0; i < this.containers.length; i++) {
      var c = this.containers[i];
      if (x < c.minx - 0.4 || x > c.maxx + 0.4 || z < c.minz - 0.4 || z > c.maxz + 0.4) continue;
      var dx = x - c.x, dz = z - c.z;
      var d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  };

  // Is (x,z) under a roof this module has no business raining on?
  PropsHarbor.prototype._indoor = function (x, z, pad) {
    var it = this.interior;
    if (!it) return false;
    pad = pad || 0;
    return x > it.x0 - pad && x < it.x1 + pad && z > it.z0 - pad && z < it.z1 + pad;
  };

  // The enterable structure, found from PUBLISHED anchors rather than from a
  // remembered footprint: the level's interior practicals (a fluorescent tube
  // is never an outdoor fixture) and its `warehouse` framing are both inside
  // the building, and the floor collider they stand on is the building's slab.
  // The shed moved twice during the build; this survives it moving again.
  PropsHarbor.prototype._findInterior = function () {
    var lvl = this.ctx.level;
    if (!lvl || !this.hash) return null;
    var pts = [], i;
    var pl = lvl.practicalLights || [];
    for (i = 0; i < pl.length; i++) {
      var L = pl[i];
      if (!L || !L.pos || !isFinite(L.pos[0])) continue;
      if (L.kind !== 'fluoro' && L.fixture !== 'interior') continue;
      pts.push([L.pos[0], L.pos[2]]);
    }
    var wp = lvl.cameraPoses && lvl.cameraPoses.warehouse;
    if (wp && wp.position) pts.push([wp.position.x, wp.position.z]);
    if (pts.length < 2) return null;
    // The slab they all agree on.  A floor collider whose top is at a different
    // height from the yard is exactly what a building sits on, and taking the
    // collider means the footprint is the level's, to the centimetre.
    var counts = new Map(), best = null, bestN = 0;
    for (i = 0; i < pts.length; i++) {
      _bmin.set(pts[i][0] - 0.1, -1e4, pts[i][1] - 0.1);
      _bmax.set(pts[i][0] + 0.1, 1e4, pts[i][1] + 0.1);
      var list = this.hash.query(_bmin, _bmax, this._qout);
      for (var k = 0; k < list.length; k++) {
        var c = list[k];
        if (!c.floor) continue;
        GAME.Collision.boxBounds(c, _va, _vb);
        if (_vb.x - _va.x < 6 || _vb.z - _va.z < 6) continue;
        var n = (counts.get(c) || 0) + 1;
        counts.set(c, n);
        if (n > bestN) { bestN = n; best = c; }
      }
    }
    if (!best || bestN < 2) return null;
    GAME.Collision.boxBounds(best, _va, _vb);
    return {
      x0: _va.x + 1.1, x1: _vb.x - 1.1,
      z0: _va.z + 1.1, z1: _vb.z - 1.1,
      y: _vb.y
    };
  };

  PropsHarbor.prototype._hasGround = function (x, z) {
    if (!this._rayOK || !this.ctx.level || !this.ctx.level.raycast) return false;
    _rayO.set(x, this.groundY + 4, z);
    _rayD.set(0, -1, 0);
    try {
      var r = this.ctx.level.raycast(_rayO, _rayD, 6.5);
      return !!(r && r.hit && r.point && isFinite(r.point.y) &&
        r.point.y < this.groundY + 1.2 && r.point.y > this.groundY - 3.0);
    } catch (e) {
      this._rayOK = false;
      return false;
    }
  };

  PropsHarbor.prototype._findApron = function () {
    var b = this.bounds;
    var span = b.x1 - b.x0;
    if (!this.containers.length || span < 12) {
      return { x0: b.x0 + span * 0.36, x1: b.x0 + span * 0.64 };
    }
    var N = 48, bins = new Float32Array(N), i;
    for (i = 0; i < this.containers.length; i++) {
      var c = this.containers[i];
      var i0 = Math.max(0, Math.floor((c.minx - b.x0) / span * N));
      var i1 = Math.min(N - 1, Math.ceil((c.maxx - b.x0) / span * N));
      for (var k = i0; k <= i1; k++) bins[k] += 1;
    }
    var bestStart = 0, bestLen = 0, curStart = -1;
    for (i = 0; i < N; i++) {
      if (bins[i] < 0.5) {
        if (curStart < 0) curStart = i;
        if (i - curStart + 1 > bestLen) { bestLen = i - curStart + 1; bestStart = curStart; }
      } else curStart = -1;
    }
    if (bestLen < 3) return { x0: b.x0 + span * 0.36, x1: b.x0 + span * 0.64 };
    return {
      x0: b.x0 + (bestStart / N) * span,
      x1: b.x0 + ((bestStart + bestLen) / N) * span
    };
  };

  // --------------------------------------------------------------------------
  // Placement helpers
  // --------------------------------------------------------------------------

  // Ground height under (x,z).  Keeps casting through anything that is neither
  // flagged as a floor by the level nor sitting near the apron height, so a
  // pallet meant for the yard cannot end up on a container roof.
  PropsHarbor.prototype._ground = function (x, z, fromY, maxDist) {
    var expect = this.groundY;
    if (this._rayOK && this.ctx.level && this.ctx.level.raycast) {
      var oy = fromY === undefined ? expect + 3.0 : fromY;
      var remain = maxDist === undefined ? 7 : maxDist;
      for (var pass = 0; pass < 4 && remain > 0.03; pass++) {
        _rayO.set(x, oy, z);
        _rayD.set(0, -1, 0);
        var r;
        try { r = this.ctx.level.raycast(_rayO, _rayD, remain); }
        catch (e) { this._rayOK = false; GAME.logError('propsH.ground', e); return expect; }
        if (!(r && r.hit && r.point && isFinite(r.point.y))) break;
        var hy = r.point.y;
        if ((r.collider && r.collider.floor) || hy <= expect + 0.45) return hy;
        this._skipped++;
        remain -= (oy - hy) + 0.04;
        oy = hy - 0.04;
      }
    }
    if (this.ctx.level && this.ctx.level.sampleGround) {
      try {
        var s = this.ctx.level.sampleGround(x, z);
        if (isFinite(s)) return s;
      } catch (e2) { /* not published */ }
    }
    return expect;
  };

  // Does level geometry already occupy this sphere?
  //
  // FLOOR COLLIDERS ARE EXCLUDED, and that exclusion is the whole point of the
  // function.  A ground slab is a box whose top face is the ground, so a test
  // sphere sitting ON the ground always overlaps it - which made every single
  // site in the yard read as blocked and silently rejected the entire props
  // pass except for the placements that happened to bypass this test.  We are
  // asking "is something in the way", never "is there a floor here".
  PropsHarbor.prototype._blocked = function (x, y, z, r) {
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

  // Our own occupancy, so props do not interpenetrate each other.
  PropsHarbor.prototype._occupied = function (x, z, r) {
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
  PropsHarbor.prototype._occupy = function (x, z, r) {
    var cs = 3;
    var k = Math.floor(x / cs) * 73856093 ^ Math.floor(z / cs) * 19349663;
    var l = this._occ.get(k);
    if (!l) { l = []; this._occ.set(k, l); }
    l.push(x, z, r);
  };

  // Is this spot inside the yard, out of the level's geometry, and not already
  // taken by one of our own props?  Used by the passes that place directly
  // rather than through _drop (the spill fan, the stack courses).
  PropsHarbor.prototype._freeSpot = function (x, z, r, h, indoor) {
    if (!this._inBounds(x, z, Math.max(0.3, r), indoor)) return false;
    if (this._occupied(x, z, r)) return false;
    if (this._blocked(x, this._ground(x, z) + (h === undefined ? 0.4 : h), z, r * 0.85)) return false;
    return true;
  };

  // Distance from a walking line, so standing masses can be kept out of it.
  //
  // `low` is the height gate.  A lane is a cost, not a wall: anything under
  // about half a metre - dunnage, litter, a cone, a coiled hose, a dropped
  // twistlock, a lashing bar - belongs INSIDE it, because a swept lane with
  // nothing whatever on it is not a working yard, it is a corridor somebody
  // hoovered.  Low props are kept out of only the middle fifth of the ribbon,
  // which is still enough clear tread to walk and to drive a pallet truck down.
  PropsHarbor.prototype._laneClear = function (x, z, r, low) {
    if (!this.lanes) return true;
    for (var i = 0; i < this.lanes.length; i++) {
      var L = this.lanes[i];
      var vx = L.x1 - L.x0, vz = L.z1 - L.z0;
      var len2 = vx * vx + vz * vz;
      var t = len2 > 1e-6 ? M.saturate(((x - L.x0) * vx + (z - L.z0) * vz) / len2) : 0;
      var px = L.x0 + vx * t, pz = L.z0 + vz * t;
      var dx = x - px, dz = z - pz;
      var half = low ? L.w * 0.22 : L.w * 0.5 + r;
      if (dx * dx + dz * dz < half * half) return false;
    }
    return true;
  };

  // Inside the yard, and - unless the caller is the interior pass - OUTSIDE the
  // building.  Rain does not reach under a roof, so every wet prop placed
  // indoors is a lie; keeping the exclusion here means the twenty-odd outdoor
  // call sites get it for free instead of each remembering to ask.
  PropsHarbor.prototype._inBounds = function (x, z, pad, allowIndoor) {
    var b = this.bounds;
    pad = pad || 0;
    if (!(x > b.x0 + pad && x < b.x1 - pad && z > this.quayZ + pad && z < b.z1 - pad)) return false;
    if (!allowIndoor && this._indoor(x, z, 0.4)) return false;
    return true;
  };

  // The one call every placement goes through.
  //
  //   opts: { r: clearance radius, tilt: max random tilt, yaw, scale,
  //           lane: false to allow standing in a walking line,
  //           color: instance colour override, sink: metres to bury }
  //
  // Returns the ground height it settled at, or null if the site was rejected.
  PropsHarbor.prototype._drop = function (batch, x, z, opts) {
    if (!batch || !batch.add) return null;
    opts = opts || {};
    var r = opts.r === undefined ? 0.5 : opts.r;
    if (!this._inBounds(x, z, 0.4, opts.indoor)) { this._skipped++; return null; }
    if (opts.lane !== false && !this._laneClear(x, z, r, opts.low)) { this._skipped++; return null; }
    if (this._occupied(x, z, r)) { this._skipped++; return null; }
    var y = this._ground(x, z);
    // clearR is the air the prop actually needs, which is not the same as its
    // keep-apart radius: a genset wants 2.2 m of elbow room from other props
    // and only needs 1.2 m of clear air, and testing it with the larger number
    // rejected every site within reach of a container flank.
    var cr = opts.clearR === undefined ? r * 0.8 : opts.clearR;
    if (this._blocked(x, y + (opts.h || 0.5) * 0.5, z, cr)) { this._skipped++; return null; }
    var yaw = opts.yaw === undefined ? this.rng.range(0, M.TAU) : opts.yaw;
    var tilt = opts.tilt === undefined ? 0.035 : opts.tilt;
    var sc = opts.scale === undefined ? 1 : opts.scale;
    var ok = batch.add(
      T(x, y - (opts.sink || 0), z,
        this.rng.gaussian(0, tilt), yaw, this.rng.gaussian(0, tilt),
        sc * (opts.sx || 1), sc * (opts.sy || 1), sc * (opts.sz || 1)),
      opts.color || wearTint(this.rng));
    if (!ok) return null;
    this._occupy(x, z, r);
    if (opts.collider) this._collider(x, y, z, opts.collider, yaw, opts.material);
    // Weld it to the floor.  Every prop in a downpour stands IN water, not on
    // top of it - see _wetHalo.
    if (opts.halo !== false && !opts.indoor && r >= 0.26) {
      this._wetHalo(x, z, Math.min(r * 1.05, 1.15));
    }
    return y;
  };

  // The wetted halo where a prop meets the apron.
  //
  // This is the specific tell that separates a wet level from a level with a
  // wet-looking floor: every drum, cone and crate used to terminate on a hard
  // line against the mirror, with no displaced water, no rust ring and no
  // reflection of its own base, which reads as a decal pasted onto the ground.
  // One quad of the pool material at 1.3x the prop's radius fixes it, because
  // the pool material is a translucent gloss film - so the halo darkens and
  // polishes the concrete under the prop exactly the way standing water does,
  // and the prop's own silhouette lands in it.
  PropsHarbor.prototype._wetHalo = function (x, z, r) {
    if (!(r > 0.12)) return;
    if (this._haloCount === undefined) this._haloCount = 0;
    if (this._haloCount >= 170) return;
    if (!this._inBounds(x, z, 0.2)) return;
    var y = this._ground(x, z);
    var g = K.pool(r * 1.3, this.noise, 200 + this._haloCount, this.rng.range(0.75, 1.2));
    if (!g) return;
    this._poolParts = this._poolParts || [];
    // 4 mm under the free-standing pools, so an overlap layers rather than
    // z-fights: both are depthWrite:false at renderOrder 2.
    this._poolParts.push(part(g, Tn(x, y + 0.008, z, 0, this.rng.range(0, M.TAU), 0)));
    this._haloCount++;
  };

  PropsHarbor.prototype._collider = function (x, y, z, he, yaw, material) {
    _eu.set(0, yaw || 0, 0, 'YXZ');
    this.colliders.push({
      type: 'box',
      center: new THREE.Vector3(x, y + he[1], z),
      halfExtents: new THREE.Vector3(he[0], he[1], he[2]),
      quaternion: new THREE.Quaternion().setFromEuler(_eu),
      material: material || 'metal'
    });
  };

  // Add a one-off merged part to a static batch.
  PropsHarbor.prototype._static = function (key, geometry, matrix) {
    var arr = this.S[key];
    if (!arr) arr = this.S[key] = [];
    arr.push(part(geometry, matrix));
  };

  // --------------------------------------------------------------------------
  // Kit
  // --------------------------------------------------------------------------
  PropsHarbor.prototype._uvScale = function (name, texels) {
    try {
      if (this.ctx.materials && this.ctx.materials.uvScaleFor) {
        var s = this.ctx.materials.uvScaleFor(name, texels || 500);
        if (isFinite(s) && s > 0) return s;
      }
    } catch (e) { /* library still booting */ }
    return 1.4;
  };

  // Re-UV a merged prop to the library's declared texel density, copy uv1 for
  // the AO channel, and paint the wear/wetness mask.  Every instanced prop goes
  // through here so texture density does not visibly jump between a 0.3 m cleat
  // and a 3 m skip - which is the tell that a prop set was authored piecemeal.
  PropsHarbor.prototype._finishGeo = function (geo, matName, wear, texels) {
    if (!geo) return null;
    try { Geo.worldUV(geo, this._uvScale(matName, texels)); } catch (e) { /* keep builder uv */ }
    Geo.copyUV1(geo);
    paintWear(geo, wear || {});
    try { geo.computeBoundingSphere(); geo.computeBoundingBox(); } catch (e2) { /* ignore */ }
    return geo;
  };

  PropsHarbor.prototype._buildKit = function () {
    var N = this.noise, R = this.rng, m = this.mats;
    var G = this.G = {};
    var self = this;
    function fin(g, name, wear, texels) { return self._finishGeo(g, name, wear, texels); }
    // A batch is ALWAYS created, even if its builder failed.  Thirty dressing
    // call sites reach into this.B by name; making one of them conditional on a
    // geometry that might be null turns a cosmetic failure into a thrown
    // exception in the middle of the pass, which loses every prop after it.
    // An empty batch is dropped in _commit and costs nothing.
    function bat(key, geo, mat, max, shadow) {
      if (!geo) geo = new THREE.BufferGeometry();
      if (!geo.attributes || !geo.attributes.position) {
        geo = new THREE.BoxGeometry(0.02, 0.02, 0.02);
      }
      self.B[key] = new Batch(geo, mat || self.mats.deck, max, shadow);
      return self.B[key];
    }

    // ---- dock ---------------------------------------------------------------
    G.bollard = fin(K.bollard(N), 'container_steel', { noise: N, grime: 0.34, edge: 0.34, wet: 1.0, hiY: 0.95 });
    bat('bollard', G.bollard, m.steel, 20);
    G.cleat = fin(K.cleat(), 'container_steel', { noise: N, grime: 0.30, edge: 0.40, hiY: 0.3 });
    bat('cleat', G.cleat, m.steel, 24);
    G.capstan = fin(K.capstan(N), 'deck_plate', { noise: N, grime: 0.34, edge: 0.32, hiY: 0.85 });
    bat('capstan', G.capstan, m.deck, 8);
    G.fender = fin(K.fender(N), 'rubber_fender', { noise: N, grime: 0.44, edge: 0.20, loY: -1.5, hiY: 0 });
    bat('fender', G.fender, m.rubber, 22, false);
    G.railPost = fin(K.railPost(), 'deck_plate', { noise: N, grime: 0.26, edge: 0.30, hiY: 1.1 });
    bat('railPost', G.railPost, m.deck, 80);
    // A life ring lives on a STAND at the chain rail; the one place it never is
    // is flat on the ground, which is where it used to be _drop'd.
    G.lifebuoy = fin(K.lifebuoyStand(), 'container_red', { noise: N, grime: 0.30, edge: 0.24, hiY: 1.3 });
    bat('lifebuoy', G.lifebuoy, m.red, 8);
    G.ratGuard = fin(K.ratGuard(), 'deck_plate', { noise: N, grime: 0.26, edge: 0.34, hiY: 0.3 });
    bat('ratGuard', G.ratGuard, m.deck, 26, false);
    G.ropeEye = fin(K.ropeEye(), 'rope', { noise: N, grime: 0.42, edge: 0.22, hiY: 0.35 });
    bat('ropeEye', G.ropeEye, m.rope, 20);
    G.quayLadder = fin(K.quayLadder(), 'deck_plate', { noise: N, grime: 0.40, edge: 0.40, hiY: 1.2 });
    bat('quayLadder', G.quayLadder, m.deck, 8);

    // ---- lane furniture -----------------------------------------------------
    // The small, specific, ANKLE-HEIGHT hardware that is allowed to live inside
    // a swept lane.  It is what turns a corridor into a set without ever
    // blocking the walking line the lane exists to protect.
    G.twistlock = fin(K.twistlock(), 'deck_plate', { noise: N, grime: 0.52, edge: 0.48, hiY: 0.16 });
    bat('twistlock', G.twistlock, m.deck, 90);
    G.lashingBar = fin(K.lashingBar(), 'deck_plate', { noise: N, grime: 0.48, edge: 0.44, hiY: 0.14 });
    bat('lashingBar', G.lashingBar, m.deck, 44);
    G.hoseCoil = fin(K.hoseCoil(), 'rubber_fender', { noise: N, grime: 0.50, edge: 0.26, hiY: 0.2 });
    bat('hoseCoil', G.hoseCoil, m.rubber, 20);

    // ---- cargo --------------------------------------------------------------
    G.pallet = fin(K.pallet(N, false), 'wood_plank', { noise: N, grime: 0.50, edge: 0.17, hiY: 0.2 });
    bat('pallet', G.pallet, m.wood, 230);
    G.palletBroken = fin(K.pallet(N, true), 'wood_plank', { noise: N, grime: 0.58, edge: 0.24, hiY: 0.2 });
    bat('palletBroken', G.palletBroken, m.wood, 30);
    // Three drum lots rather than one batch with a colour jitter: the wear
    // channel already owns the instance colour, so hue variety has to come from
    // the material, and three draws is a cheap price for a yard that does not
    // look like it took delivery of seventy identical drums.
    G.drum = fin(K.drum(N, false), 'rusted_metal', { noise: N, grime: 0.46, edge: 0.40, hiY: 0.9 });
    bat('drumRust', G.drum, m.rust, 64);
    bat('drumBlue', G.drum, m.blue, 38);
    bat('drumGreen', G.drum, m.green, 38);
    // One dented lot.  A single extra draw call buys a silhouette break across
    // roughly two in five drums, which is what stops a bund reading as a
    // delivery of twelve identical lathes.
    G.drumDent = fin(K.drum(N, true), 'rusted_metal', { noise: N, grime: 0.54, edge: 0.48, hiY: 0.9 });
    bat('drumDent', G.drumDent, m.rust, 48);
    G.crate = fin(K.crate(1.05, 0.86, 0.78, N, false), 'wood_plank', { noise: N, grime: 0.44, edge: 0.36, hiY: 0.9 });
    bat('crate', G.crate, m.wood, 80);
    G.crateTall = fin(K.crate(0.82, 1.24, 0.72, N, false), 'wood_plank', { noise: N, grime: 0.40, edge: 0.34, hiY: 1.3 });
    bat('crateTall', G.crateTall, m.wood, 30);
    G.crateBroken = fin(K.crate(1.05, 0.86, 0.78, N, true), 'wood_plank', { noise: N, grime: 0.58, edge: 0.52, hiY: 0.9 });
    bat('crateBroken', G.crateBroken, m.wood, 34);
    G.dunnage = fin(K.dunnage(N, 1.7), 'wood_plank', { noise: N, grime: 0.50, edge: 0.40, hiY: 0.12 });
    bat('dunnage', G.dunnage, m.wood, 110);
    G.bale = fin(K.bale(N), 'tarpaulin', { noise: N, grime: 0.30, edge: 0.22, hiY: 0.7 });
    bat('bale', G.bale, m.wrap || m.tarpA, 76);

    // ---- the same cargo, DRY ------------------------------------------------
    // Four extra draw calls buy the one place in the level with a roof on it.
    // The dry materials have existed since the first version of this file and
    // nothing ever used them, so every crate inside the shed was soaked by a
    // storm it is standing out of - which is the fastest way to throw away the
    // relief the interior is there to provide.
    bat('palletDry', G.pallet, m.dryWood || m.wood, 110);
    bat('crateDry', G.crate, m.dryWood || m.wood, 60);
    bat('drumDry', G.drum, m.drySteel || m.rust, 40);
    bat('dunnageDry', G.dunnage, m.dryWood || m.wood, 60);
    bat('baleDry', G.bale, m.wrapDry || m.wrap, 80);

    // ---- machinery ----------------------------------------------------------
    G.genset = fin(K.genset(), 'corrugated_roof', { noise: N, grime: 0.40, edge: 0.30, hiY: 2.0 });
    bat('genset', G.genset, m.corr, 6);
    G.cableReel = fin(K.cableReel(), 'wood_plank', { noise: N, grime: 0.46, edge: 0.38, hiY: 1.9 });
    bat('cableReel', G.cableReel, m.wood, 8);
    G.skip = fin(K.skip(N), 'rusted_metal', { noise: N, grime: 0.50, edge: 0.44, hiY: 1.4 });
    bat('skip', G.skip, m.rust, 4);
    G.tyre = fin(tube(0.42, 0.16, 16, 8), 'rubber_fender', { noise: N, grime: 0.50, edge: 0.24, hiY: 0.5 });
    bat('tyre', G.tyre, m.rubber, 52);

    // ---- reefer -------------------------------------------------------------
    G.reefer = fin(K.reefer(), 'reefer_panel', { noise: N, grime: 0.28, edge: 0.22, wet: 1.0, hiY: 2.3 });
    bat('reefer', G.reefer, m.reefer, 18, false);
    G.display = new THREE.PlaneGeometry(0.17, 0.075);
    bat('display', G.display, m.display, 18, false);
    if (this.B.display) this.B.display.mesh.castShadow = false;
    G.drip = K.drip();
    // 90 was a reefer-only budget.  Every overhanging edge in a downpour sheds
    // water, and the container top rails alone want two hundred and fifty.
    bat('drip', G.drip, m.drip, 420, false);
    if (this.B.drip) this.B.drip.mesh.castShadow = false;

    // ---- infrastructure -----------------------------------------------------
    G.lightMast = fin(K.lightMast(15.0, 4), 'deck_plate', { noise: N, grime: 0.30, edge: 0.26, hiY: 15 });
    bat('lightMast', G.lightMast, m.deck, 10);
    G.mastLens = K.mastLens(4);
    bat('mastLens', G.mastLens, m.lens, 10, false);
    G.cctv = fin(K.cctv(), 'deck_plate', { noise: N, grime: 0.30, edge: 0.22, hiY: 5.6 });
    bat('cctv', G.cctv, m.deck, 10);
    G.junctionBox = fin(K.junctionBox(), 'deck_plate', { noise: N, grime: 0.44, edge: 0.34, hiY: 0.6 });
    bat('junctionBox', G.junctionBox, m.deck, 30);
    G.cone = fin(K.cone(N), 'container_red', { noise: N, grime: 0.46, edge: 0.30, hiY: 0.75 });
    bat('cone', G.cone, m.red, 76);
    G.coneBand = fin(K.coneBand(), 'reefer_panel', { noise: N, grime: 0.36, edge: 0.24, hiY: 0.6 });
    bat('coneBand', G.coneBand, m.reefer, 76, false);
    G.jersey = fin(K.jersey(N), 'dock_concrete', { noise: N, grime: 0.44, edge: 0.36, hiY: 0.9 });
    bat('jersey', G.jersey, m.concrete, 40);
    G.hazardBarrier = fin(K.hazardBarrier(), 'painted_line', { noise: N, grime: 0.38, edge: 0.34, hiY: 1.0 });
    bat('hazardBarrier', G.hazardBarrier, m.hazard, 18);
    G.signFrame = fin(K.signFrame(2.2, 1.1, 2.6), 'deck_plate', { noise: N, grime: 0.34, edge: 0.26, hiY: 2.6 });
    bat('signFrame', G.signFrame, m.deck, 12);
    G.signFace = K.signFace(2.2, 1.1, 2.6);
    bat('signFace', G.signFace, m.sign, 8, false);
    bat('signFace2', G.signFace, m.sign2, 6, false);

    // ---- perimeter ----------------------------------------------------------
    var FSPAN = 3.0, FH = 2.6;
    G.fenceFrame = fin(K.fenceFrame(FSPAN, FH, true), 'deck_plate', { noise: N, grime: 0.34, edge: 0.28, hiY: FH });
    bat('fenceFrame', G.fenceFrame, m.deck, 90);
    G.barbs = fin(K.barbs(FSPAN, FH, R), 'deck_plate', { noise: N, grime: 0.30, edge: 0.30, hiY: FH + 0.5 });
    bat('barbs', G.barbs, m.deck, 90, false);
    // The mesh itself: one alpha plane per bay.  UVs are scaled so the diamond
    // pitch is a real ~50 mm regardless of bay width.
    G.fenceMesh = (function () {
      var g = new THREE.PlaneGeometry(FSPAN, FH - 0.16, 1, 1);
      g.translate(0, (FH - 0.16) / 2 + 0.08, 0);
      var uvA = g.attributes.uv;
      for (var i = 0; i < uvA.count; i++) uvA.setXY(i, uvA.getX(i) * FSPAN * 3.4, uvA.getY(i) * (FH - 0.16) * 3.4);
      uvA.needsUpdate = true;
      Geo.copyUV1(g);
      paintWear(g, { grime: 0.24, edge: 0.30, hiY: FH });
      return g;
    })();
    bat('fenceMesh', G.fenceMesh, m.fence, 90);
    // A sagging bay, for where a vehicle has been into it.
    G.fenceMeshSag = (function () {
      var g = new THREE.PlaneGeometry(FSPAN, FH - 0.16, 6, 4);
      g.translate(0, (FH - 0.16) / 2 + 0.08, 0);
      var p = g.attributes.position;
      for (var i = 0; i < p.count; i++) {
        var x = p.getX(i), y = p.getY(i);
        var bulge = Math.cos(x / FSPAN * Math.PI) * M.saturate(1 - Math.abs(y - 1.1) / 1.2);
        p.setZ(i, bulge * 0.42);
        p.setY(i, y - bulge * 0.10);
      }
      p.needsUpdate = true;
      g.computeVertexNormals();
      var uvB = g.attributes.uv;
      for (var j = 0; j < uvB.count; j++) uvB.setXY(j, uvB.getX(j) * FSPAN * 3.4, uvB.getY(j) * (FH - 0.16) * 3.4);
      uvB.needsUpdate = true;
      Geo.copyUV1(g);
      paintWear(g, { grime: 0.34, edge: 0.44, hiY: FH });
      return g;
    })();
    bat('fenceMeshSag', G.fenceMeshSag, m.fence, 12);
    this._fence = { span: FSPAN, height: FH };

    // ---- soft goods ---------------------------------------------------------
    G.tarpA = K.tarp(2.75, 1.55, 2.25, N, 11);
    G.tarpB = K.tarp(3.10, 1.30, 2.45, N, 23);
    // Almost no edge channel: a sheet has scuffs at its corners, not a bleached
    // crown.  Grime instead, which darkens rather than lightens.
    paintWear(G.tarpA, { noise: N, grime: 0.40, edge: 0.05, hiY: 1.6 });
    paintWear(G.tarpB, { noise: N, grime: 0.44, edge: 0.06, hiY: 1.4 });
    bat('tarpA', G.tarpA, m.tarpA, 22);
    bat('tarpB', G.tarpB, m.tarpB, 20);
    if (this.B.tarpA) this.B.tarpA.mesh.customDepthMaterial = m.tarpDepth;
    if (this.B.tarpB) this.B.tarpB.mesh.customDepthMaterial = m.tarpDepth;
    G.net = K.net(2.6, 2.2);
    bat('net', G.net, m.net, 10);
    if (this.B.net) this.B.net.mesh.customDepthMaterial = m.alphaDepth;
    G.litter = [
      K.litterCard(0.34, 0.26, 0, R), K.litterCard(0.28, 0.34, 1, R),
      K.litterCard(0.40, 0.22, 2, R), K.litterCard(0.30, 0.30, 3, R)
    ];
    for (var li = 0; li < 4; li++) {
      bat('litter' + li, G.litter[li], m.litter, 64, false);
    }
    G.weed = K.weedCard(0.55, 0.42);
    bat('weed', G.weed, m.weed, 230, false);

    // ---- life ---------------------------------------------------------------
    G.gull = fin(K.gull(), 'reefer_panel', { noise: N, grime: 0.10, edge: 0.06, wet: 0.55, hiY: 0.3 }, 900);
    bat('gull', G.gull, m.gull, 30);
    this._gullBatch = this.B.gull;
  };

  // --------------------------------------------------------------------------
  // Dressing: the quay edge
  // --------------------------------------------------------------------------
  PropsHarbor.prototype._dressQuay = function () {
    var R = this.rng, b = this.bounds;
    var qz = this.quayZ;
    var x0 = b.x0 + 3, x1 = b.x1 - 3;
    var span = x1 - x0;
    if (span < 8) return;
    this.quayLine = { x0: x0, x1: x1, z: qz };
    var i;

    // Each piece of quay furniture is now gated on ITS OWN ownership flag
    // rather than on the bollard list standing in for all five.  When the level
    // owns the bollards we contribute what a level never bothers with - the
    // cleats, the capstans, the life rings and the flaked spare line - and the
    // fender and chain-rail flags are still asked separately below.
    if (!this.own.bollards) {
      this._dressQuayExtras(x0, x1, qz);
    } else {
      this._dressBollards(x0, x1, qz, span);
    }
    if (this.own.chainRail) this._dressChainRail(x0, qz, span);
    if (this.own.fenders) this._dressFenders(x0, qz, span);
  };

  PropsHarbor.prototype._dressBollards = function (x0, x1, qz, span) {
    var R = this.rng, i;
    // Bollards on a real 9 m pitch, set back 1.3 m from the lip, with the pitch
    // broken where the gantry rail would run.
    var pitch = 9.0;
    var n = Math.max(3, Math.floor(span / pitch));
    this.bollards = [];
    for (i = 0; i <= n; i++) {
      var bx = x0 + (i + 0.5) * (span / (n + 1));
      var bz = qz + 1.35 + R.range(-0.10, 0.10);
      var y = this._drop(this.B.bollard, bx, bz, {
        r: 0.75, tilt: 0.012, yaw: R.range(0, M.TAU), lane: false,
        collider: [0.42, 0.48, 0.42], material: 'metal'
      });
      if (y === null) continue;
      this.bollards.push({ x: bx, y: y, z: bz });
      // Not every bollard gets a cleat, and the ones that do are the ones a
      // spring line would actually be taken to.
      if (R.bool(0.55)) {
        this._drop(this.B.cleat, bx + R.range(-2.4, 2.4), qz + 0.85, {
          r: 0.3, tilt: 0.02, yaw: R.range(0, M.TAU), lane: false
        });
      }
    }

    // Capstans at the ends of the run where a winch would live.
    for (i = 0; i < 3; i++) {
      var cx = M.lerp(x0 + 2, x1 - 2, i / 2) + R.range(-1.5, 1.5);
      this._drop(this.B.capstan, cx, qz + 2.6, {
        r: 0.9, tilt: 0.01, lane: false,
        collider: [0.55, 0.42, 0.55], material: 'metal'
      });
    }

    // Life rings on their STANDS at the chain rail, spaced as a harbourmaster
    // would: within throwing distance of anywhere on the quay.
    for (i = 0; i < 3; i++) {
      var lx = M.lerp(x0 + 4, x1 - 4, i / 2) + R.range(-2, 2);
      this._drop(this.B.lifebuoy, lx, qz + 1.5, {
        r: 0.5, tilt: 0.015, yaw: Math.PI + R.range(-0.2, 0.2), lane: false
      });
    }
  };

  // Chain rail between the bollards, with the stanchions and the sagging chain
  // runs.  The safety line along a live quay edge, and the strongest horizontal
  // lead-in the quay framing has.
  PropsHarbor.prototype._dressChainRail = function (x0, qz, span) {
    var R = this.rng, i;
    var postPitch = 2.4;
    var np = Math.max(1, Math.floor(span / postPitch));
    var posts = [];
    var bl = this.bollards || [];
    for (i = 0; i <= np; i++) {
      var px = x0 + i * (span / np);
      var pz = qz + 0.55;
      // leave gaps where the gangway and the bollards are
      var near = false;
      for (var k = 0; k < bl.length; k++) {
        if (Math.abs(bl[k].x - px) < 1.3) { near = true; break; }
      }
      if (near) { posts.push(null); continue; }
      var py = this._ground(px, pz);
      if (!this.B.railPost.place(px, py, pz, R.range(-0.05, 0.05), R.gaussian(0, 0.012), R.gaussian(0, 0.02),
        1, R.range(0.97, 1.03), 1, wearTint(R))) { posts.push(null); continue; }
      posts.push({ x: px, y: py, z: pz });
    }
    this._railPosts = posts;
  };

  // Rubber fenders hanging on the quay face, on the lip so they are seen
  // edge-on from the apron and full-face from the water.
  PropsHarbor.prototype._dressFenders = function (x0, qz, span) {
    var R = this.rng;
    var fn = Math.max(3, Math.floor(span / 6.5));
    for (var i = 0; i < fn; i++) {
      var fx = x0 + (i + 0.5) * (span / fn) + R.range(-0.8, 0.8);
      var fy = this._ground(fx, qz + 1.0);
      this.B.fender.place(fx, fy - 0.12, qz + 0.06,
        R.gaussian(0, 0.06), 0, R.gaussian(0, 0.05),
        R.range(0.92, 1.08), R.range(0.94, 1.10), R.range(0.92, 1.08), wearTint(R));
      // the chains it hangs on
      this._quayChain(fx - 0.18, fy + 0.06, qz + 0.10, fx - 0.16, fy - 0.10, qz + 0.02);
      this._quayChain(fx + 0.18, fy + 0.06, qz + 0.10, fx + 0.16, fy - 0.10, qz + 0.02);
    }
  };

  // What props_harbor adds to a quay edge somebody else already built: the
  // small hardware nobody models when they are laying out a level, and the
  // spare line that says the berth is in use.
  PropsHarbor.prototype._dressQuayExtras = function (x0, x1, qz) {
    var R = this.rng;
    var bl = this.bollards || [];
    var i;
    for (i = 0; i < bl.length; i++) {
      var b = bl[i];
      // A cleat offset from every second bollard, on the seaward side of it.
      if (R.bool(0.6)) {
        this._drop(this.B.cleat, b.x + R.range(-2.6, 2.6), qz + R.range(0.55, 0.95),
          { r: 0.3, tilt: 0.02, yaw: R.range(0, M.TAU), lane: false });
      }
      // Spare line flaked down beside the ones actually in use.
      if (R.bool(0.5)) this._ropeCoil(b.x + R.range(-1.4, 1.4), b.y, b.z + R.range(0.9, 2.0));
    }
    for (i = 0; i < 3; i++) {
      var cx = M.lerp(x0 + 3, x1 - 3, i / 2) + R.range(-2.5, 2.5);
      this._drop(this.B.capstan, cx, qz + R.range(2.4, 3.2), {
        r: 0.9, tilt: 0.01, lane: false, collider: [0.55, 0.42, 0.55], material: 'metal'
      });
    }
    for (i = 0; i < 3; i++) {
      var lx = M.lerp(x0 + 5, x1 - 5, i / 2) + R.range(-2.5, 2.5);
      this._drop(this.B.lifebuoy, lx, qz + R.range(1.3, 1.9),
        { r: 0.5, tilt: 0.015, yaw: Math.PI + R.range(-0.25, 0.25), lane: false });
    }
    // Quay ladder recesses, where the level publishes them.  Two grab rails
    // standing proud of the coping is the whole silhouette, and a quay with no
    // way back out of the water is not a quay anybody works.
    var la = this.ctx.level && this.ctx.level.anchors && this.ctx.level.anchors.quayEdge;
    var lxs = (la && la.ladderX) || [x0 + (x1 - x0) * 0.28, x0 + (x1 - x0) * 0.72];
    for (i = 0; i < lxs.length && this.B.quayLadder; i++) {
      var qx = lxs[i];
      if (!isFinite(qx)) continue;
      var qy = this._ground(qx, qz + 1.0);
      this.B.quayLadder.place(qx, qy, qz + 0.10, 0, 0, 0, 1, 1, 1, wearTint(R));
      this._occupy(qx, qz + 0.4, 0.6);
    }
    // Stencilled bollard numbers on the coping.  A terminal numbers its
    // bollards; the number is how a berthing plan is written down.
    this._bollardNumbers();
  };

  // ---- stencilled block digits ----------------------------------------------
  // Strokes in a 0..1 box, emitted as flat quads into the painted-line bucket
  // which already carries the painted_line material and worldUV.
  var DIGIT = {
    '0': [[0, 0, 0, 1], [1, 0, 1, 1], [0, 1, 1, 1], [0, 0, 1, 0], [0.08, 0.08, 0.92, 0.92]],
    '1': [[0.55, 0, 0.55, 1], [0.15, 0.76, 0.55, 1], [0.20, 0, 0.90, 0]],
    '2': [[0, 1, 1, 1], [1, 0.5, 1, 1], [0, 0.5, 1, 0.5], [0, 0, 0, 0.5], [0, 0, 1, 0]],
    '3': [[0, 1, 1, 1], [1, 0, 1, 1], [0.18, 0.5, 1, 0.5], [0, 0, 1, 0]],
    '4': [[0, 0.45, 0, 1], [0, 0.45, 1, 0.45], [1, 0, 1, 1]],
    '5': [[0, 1, 1, 1], [0, 0.5, 0, 1], [0, 0.5, 1, 0.5], [1, 0, 1, 0.5], [0, 0, 1, 0]],
    '6': [[0, 0, 0, 1], [0, 1, 1, 1], [0, 0.5, 1, 0.5], [1, 0, 1, 0.5], [0, 0, 1, 0]],
    '7': [[0, 1, 1, 1], [0.32, 0, 1, 1]],
    '8': [[0, 0, 0, 1], [1, 0, 1, 1], [0, 1, 1, 1], [0, 0.5, 1, 0.5], [0, 0, 1, 0]],
    '9': [[0, 0.5, 0, 1], [0, 1, 1, 1], [1, 0, 1, 1], [0, 0.5, 1, 0.5], [0, 0, 1, 0]]
  };

  PropsHarbor.prototype._stencilNumber = function (text, x, z, yaw, size, bucket) {
    var s = String(text);
    var cw = size * 0.60, gap = size * 0.26;
    var total = s.length * cw + (s.length - 1) * gap;
    var y = this._ground(x, z) + 0.014;
    for (var d = 0; d < s.length; d++) {
      var strokes = DIGIT[s.charAt(d)];
      if (!strokes) continue;
      var ox = -total * 0.5 + d * (cw + gap);
      for (var k = 0; k < strokes.length; k++) {
        var st = strokes[k];
        var x0 = ox + st[0] * cw, y0 = (st[1] - 0.5) * size;
        var x1 = ox + st[2] * cw, y1 = (st[3] - 0.5) * size;
        var dx = x1 - x0, dy = y1 - y0;
        var len = Math.sqrt(dx * dx + dy * dy);
        if (!(len > 1e-4)) continue;
        var g = new THREE.PlaneGeometry(len + size * 0.13, size * 0.15);
        g.rotateX(-Math.PI / 2);
        _va.set((x0 + x1) * 0.5, 0, (y0 + y1) * 0.5).applyAxisAngle(UP, yaw);
        this._static(bucket || 'line', g,
          Tn(x + _va.x, y, z + _va.z, 0, yaw - Math.atan2(dy, dx), 0));
      }
    }
  };

  PropsHarbor.prototype._bollardNumbers = function () {
    var bl = this.bollards || [];
    if (!bl.length) return;
    var yaw = Math.PI;            // read from the landward side, facing the sea
    for (var i = 0; i < bl.length && i < 14; i++) {
      var n = (i + 1) * 2;        // even numbers, as a real berth is laid out
      this._stencilNumber(n < 10 ? '0' + n : String(n),
        bl[i].x, bl[i].z + 1.55, yaw, 0.58);
    }
  };

  // A short chain segment, accumulated into the chain mesh built in _commit.
  PropsHarbor.prototype._quayChain = function (ax, ay, az, bx, by, bz) {
    if (!this._chainPaths) this._chainPaths = [];
    this._chainPaths.push({
      a: new THREE.Vector3(ax, ay, az), b: new THREE.Vector3(bx, by, bz),
      sag: 0.02, r: 0.016, flex: 0.12
    });
  };

  // --------------------------------------------------------------------------
  // Dressing: mooring lines and the gangway
  // --------------------------------------------------------------------------
  PropsHarbor.prototype._dressMoorings = function () {
    var R = this.rng;
    this._ropePaths = this._ropePaths || [];
    var qz = this.quayZ;
    var i;

    // Mooring lines and the gangway are now asked for SEPARATELY.  They used to
    // ride on the bollard flag, so a level that placed bollards and stopped
    // there lost both with nothing to say so.
    if (this.own.moorings && this.bollards && this.bollards.length) {
      // The freighter is moored on the seaward side; its bitts sit above and
      // beyond the quay lip.  Lines run UNDER TENSION - a mooring line is not a
      // washing line, so the sag is small and the run is long.
      var shipZ = qz - 9.5;
      var deckY = this.groundY + 5.4;
      for (i = 0; i < this.bollards.length; i++) {
        var b = this.bollards[i];
        if (R.bool(0.34)) continue;                 // not every bollard is in use
        var lines = R.bool(0.35) ? 2 : 1;
        var headY = b.headY === undefined ? b.y + 0.74 : b.headY - 0.08;
        // The spliced eye dropped over the casting.  Without it every mooring
        // line in the level terminates at a mathematical point on the bollard
        // head, which is the one detail a sailor's eye goes to first.
        if (this.B.ropeEye) {
          this.B.ropeEye.place(b.x, headY - 0.20, b.z, R.range(0, M.TAU), 0, 0,
            1, 1, 1, wearTint(R));
        }
        for (var l = 0; l < lines; l++) {
          var lead = R.range(-6.5, 6.5);
          var a = new THREE.Vector3(b.x, headY, b.z);
          var c = new THREE.Vector3(b.x + lead, deckY + R.range(-0.7, 1.4), shipZ + R.range(-1.2, 1.2));
          var sagv = R.range(0.35, 0.85);           // taut: a working spring line
          this._ropePaths.push({
            a: a, b: c, sag: sagv,
            r: R.range(0.055, 0.085),
            flex: 0.20, seg: 16
          });
          this._threadRatGuard(a, c, sagv);
        }
        // A coil of spare line flaked down beside the bollard.
        if (R.bool(0.45)) this._ropeCoil(b.x + R.range(-1.2, 1.2), b.y, b.z + R.range(0.6, 1.6));
      }
    }

    // Chain runs on the safety rail between consecutive standing posts.
    var posts = this._railPosts || [];
    for (i = 0; i < posts.length - 1; i++) {
      var p0 = posts[i], p1 = posts[i + 1];
      if (!p0 || !p1) continue;
      this._chainPaths = this._chainPaths || [];
      this._chainPaths.push({
        a: new THREE.Vector3(p0.x, p0.y + 0.92, p0.z), b: new THREE.Vector3(p1.x, p1.y + 0.92, p1.z),
        sag: R.range(0.10, 0.20), r: 0.020, flex: 0.55, seg: 10
      });
      this._chainPaths.push({
        a: new THREE.Vector3(p0.x, p0.y + 0.56, p0.z), b: new THREE.Vector3(p1.x, p1.y + 0.56, p1.z),
        sag: R.range(0.07, 0.15), r: 0.018, flex: 0.50, seg: 10
      });
    }

    // ---- the gangway --------------------------------------------------------
    // Placed at the quay edge, running out over the water toward the ship.  Its
    // own published pose exists so it has to be findable, so it goes near the
    // middle of the quay run rather than at a random bollard.
    if (!this.own.gangway) return;
    var gx = this.poses && this.poses.gangway && this.poses.gangway.position
      ? this.poses.gangway.position.x
      : (this.quayLine ? (this.quayLine.x0 + this.quayLine.x1) * 0.5 + 6 : 6);
    gx = M.clamp(gx, this.bounds.x0 + 6, this.bounds.x1 - 6);
    var gz = qz + 1.2;
    var gy = this._ground(gx, gz + 1.0);
    var gw = K.gangway(7.4, 2.85, 15);
    if (gw && (gw.frame || gw.treads)) {
      // turned to run toward -Z, out over the water toward the freighter
      var gm = Tn(gx, gy, gz, 0, Math.PI, 0);
      if (gw.frame) {
        this._finishGeo(gw.frame, 'deck_plate', { noise: this.noise, grime: 0.30, edge: 0.34, hiY: 3.2 });
        this._static('deck', gw.frame, gm);
      }
      if (gw.treads) {
        this._finishGeo(gw.treads, 'steel_grate', { noise: this.noise, grime: 0.36, edge: 0.44, hiY: 3.2 });
        this._static('grate', gw.treads, gm);
      }
      this._collider(gx, gy, gz - 3.5, [0.75, 0.9, 3.8], 0, 'metal');
      this.gangwayAt = new THREE.Vector3(gx, gy, gz);
    }
    // A pair of cleats and a stanchion where the gangway lands.
    this._drop(this.B.cleat, gx - 1.5, gz + 0.7, { r: 0.3, lane: false });
    this._drop(this.B.cleat, gx + 1.5, gz + 0.7, { r: 0.3, lane: false });
  };

  // Thread a rat guard onto a mooring line, 60% of the way out along the run,
  // squared to the rope tangent at that point.  Sixteen triangles per line and
  // it changes the read of the entire quay.
  var _rgA = new THREE.Vector3(), _rgB = new THREE.Vector3(), _rgM = new THREE.Matrix4();
  PropsHarbor.prototype._threadRatGuard = function (a, b, sag) {
    var bt = this.B.ratGuard;
    if (!bt) return;
    sagPoint(a, b, sag, 0.60, _rgA);
    sagPoint(a, b, sag, 0.645, _rgB);
    _rgB.sub(_rgA);
    if (!(_rgB.lengthSq() > 1e-8)) return;
    _rgB.normalize();
    _qs.setFromUnitVectors(UP, _rgB);
    _vs.set(1, 1, 1);
    bt.add(_rgM.compose(_rgA, _qs, _vs), wearTint(this.rng));
  };

  // A flaked coil of spare mooring line on the deck.
  PropsHarbor.prototype._ropeCoil = function (x, y, z) {
    var R = this.rng;
    var turns = R.int(3, 5);
    for (var i = 0; i < turns; i++) {
      var r = 0.24 + i * 0.085;
      var g = tube(r, 0.042, 16, 5);
      this._finishGeo(g, 'rope', { noise: this.noise, grime: 0.44, edge: 0.20, hiY: 0.2 });
      this._static('rope', g, Tn(x + R.range(-0.05, 0.05), y + 0.045 + (i % 2) * 0.012,
        z + R.range(-0.05, 0.05), Math.PI / 2 + R.range(-0.06, 0.06), R.range(0, 3), 0));
    }
  };

  // --------------------------------------------------------------------------
  // Dressing: cargo
  //
  // Nothing here is scattered.  Unit loads stack against a wall or a container
  // flank because that is where a forklift can reach them without blocking a
  // lane; drums cluster in a bund by the fuel point; dunnage lies where a load
  // was landed on it.  Uniform random placement over an apron is the single
  // fastest way to make a working terminal read as a video-game level.
  // --------------------------------------------------------------------------
  // A drum lot, dent-biased.  Four in ten are dented; the rest split across the
  // three colour lots.
  PropsHarbor.prototype._drumLot = function () {
    var R = this.rng;
    var d = this.B.drumDent;
    if (d && d.n < d.max && R.bool(0.40)) return d;
    var lots = [this.B.drumRust, this.B.drumBlue, this.B.drumGreen];
    return lots[R.int(0, 2)] || this.B.drumRust;
  };

  // A diamond hazard placard on one face of a drum.  Emitted into the hazard
  // static bucket rather than baked into the kit geometry because it belongs on
  // SOME drums, on the face that happens to be turned outward, and an instanced
  // batch cannot express either of those.  A quad and a half each.
  PropsHarbor.prototype._drumPlacard = function (x, y, z, yaw) {
    if (this._placards === undefined) this._placards = 0;
    if (this._placards >= 34) return;
    var g = new THREE.PlaneGeometry(0.30, 0.30);
    g.rotateZ(Math.PI / 4);                          // a placard is a diamond
    this._static('placard', g,
      Tn(x + Math.sin(yaw) * 0.291, y + 0.50, z + Math.cos(yaw) * 0.291, 0, yaw, 0));
    this._placards++;
  };

  PropsHarbor.prototype._dressCargo = function () {
    var R = this.rng, b = this.bounds;
    var i, j;

    // ---- sites: the flanks of container stacks ------------------------------
    // Cargo goes where there is a wall to stack against and a lane to reach it
    // from.  Container flanks give both.
    var sites = this._stackFlanks(20);
    if (!sites.length) sites = this._fallbackSites(16);

    var stacksBuilt = 0;
    for (i = 0; i < sites.length && stacksBuilt < 17; i++) {
      var s = sites[i];
      if (this._palletStack(s.x, s.z, s.yaw)) stacksBuilt++;
    }

    // ---- loose pallets leaning against things -------------------------------
    for (i = 0; i < 30; i++) {
      var lp = this._pickSite(sites, 2.6);
      if (!lp) continue;
      // A pallet on edge, leaning on the flank it was pulled off.
      var lean = R.range(1.30, 1.48) * (R.bool() ? 1 : -1);
      var by = this._ground(lp.x, lp.z);
      var bt = R.bool(0.72) ? this.B.pallet : this.B.palletBroken;
      bt.place(lp.x, by, lp.z, lp.yaw + R.range(-0.25, 0.25), lean, R.gaussian(0, 0.05),
        1, 1, 1, wearTint(R));
      this._occupy(lp.x, lp.z, 0.7);
    }

    // ---- drums --------------------------------------------------------------
    // A bund of drums by the fuel point, plus stragglers rolled against walls.
    var bund = this._pickSite(sites, 3.4) || { x: this.apron.x1 + 3, z: (this.quayZ + b.z1) * 0.5, yaw: 0 };
    var rows = 3, cols = 4;
    for (i = 0; i < rows; i++) {
      for (j = 0; j < cols; j++) {
        var dx = bund.x + (i - 1) * 0.66 + R.range(-0.05, 0.05);
        var dz = bund.z + (j - 1.5) * 0.66 + R.range(-0.05, 0.05);
        _va.set(dx - bund.x, 0, dz - bund.z).applyAxisAngle(UP, bund.yaw);
        var wx = bund.x + _va.x, wz = bund.z + _va.z;
        var db = this._drumLot();
        var dyaw = R.range(0, 6.28);
        var dy = this._ground(wx, wz);
        // one drum off the top of the block, on its side
        if (i === 0 && j === 3) {
          db.place(wx + 0.5, dy + 0.29, wz, dyaw, Math.PI / 2, 0, 1, 1, 1, wearTint(R));
        } else {
          db.place(wx, dy, wz, dyaw, R.gaussian(0, 0.02), R.gaussian(0, 0.02),
            1, R.range(0.98, 1.02), 1, wearTint(R));
          // Placard on the outward face of the outer ranks, and the wetted ring
          // that welds the drum to the mirror it is standing in.
          if (i === 0 || i === rows - 1 || j === 0 || j === cols - 1) {
            this._drumPlacard(wx, dy, wz, dyaw + bund.yaw + (i === 0 ? Math.PI : 0));
          }
          this._wetHalo(wx, wz, 0.40);
        }
        this._occupy(wx, wz, 0.32);
      }
    }
    // A drip tray and a spill under the bund - a drum stack that has never
    // leaked has never been used.
    this._oilSlick(bund.x + R.range(-1, 1), bund.z + R.range(-1.4, 1.4), R.range(0.9, 1.7));

    for (i = 0; i < 26; i++) {
      var ds = this._pickSite(sites, 1.6);
      if (!ds) continue;
      var b2 = this._drumLot();
      if (R.bool(0.24)) {
        // rolled over and abandoned
        var ry = this._ground(ds.x, ds.z);
        b2.place(ds.x, ry + 0.29, ds.z, R.range(0, 6.28), Math.PI / 2, R.gaussian(0, 0.12),
          1, 1, 1, wearTint(R));
        this._occupy(ds.x, ds.z, 0.55);
      } else {
        this._drop(b2, ds.x, ds.z, { r: 0.35, tilt: 0.02, collider: null });
      }
    }

    // ---- crates -------------------------------------------------------------
    for (i = 0; i < 34; i++) {
      var cs = this._pickSite(sites, 1.5);
      if (!cs) continue;
      var tall = R.bool(0.3);
      var cb = tall ? this.B.crateTall : (R.bool(0.22) ? this.B.crateBroken : this.B.crate);
      var cy = this._drop(cb, cs.x, cs.z, {
        r: tall ? 0.55 : 0.68, tilt: 0.02, yaw: cs.yaw + R.range(-0.3, 0.3),
        collider: tall ? [0.42, 0.62, 0.38] : [0.54, 0.43, 0.40], material: 'wood'
      });
      // a second crate on top, offset - a stack nobody squared up
      if (cy !== null && !tall && R.bool(0.4)) {
        this.B.crate.place(cs.x + R.range(-0.14, 0.14), cy + 0.87, cs.z + R.range(-0.14, 0.14),
          cs.yaw + R.range(-0.5, 0.5), R.gaussian(0, 0.02), R.gaussian(0, 0.02),
          R.range(0.86, 0.98), R.range(0.86, 0.98), R.range(0.86, 0.98), wearTint(R));
      }
    }

    // ---- timber dunnage -----------------------------------------------------
    // Baulks lie in pairs where a load was landed on them, and singles where
    // one got kicked aside.
    for (i = 0; i < 20; i++) {
      var us = this._pickSite(sites, 1.4, true);
      if (!us) continue;
      var uy = this._ground(us.x, us.z);
      var pair = R.bool(0.6) ? 2 : 1;
      for (j = 0; j < pair; j++) {
        this.B.dunnage.place(us.x + Math.cos(us.yaw + Math.PI / 2) * j * 0.9,
          uy, us.z + Math.sin(us.yaw + Math.PI / 2) * j * 0.9,
          us.yaw + R.gaussian(0, 0.10), R.gaussian(0, 0.03), R.gaussian(0, 0.03),
          R.range(0.8, 1.15), 1, 1, wearTint(R));
      }
      this._occupy(us.x, us.z, 1.1);
    }

    this._dressLaneEdges();
  };

  // Alternating masses down both walking lines, and the ankle-height hardware
  // that lives IN them.
  //
  // A corridor with clear sides is a corridor.  A corridor with a mass on the
  // left at 7 m, on the right at 14 m and on the left again at 21 m is DEPTH,
  // because the eye reads the overlaps as an ordering in Z - and every hero
  // framing in this level looks down one of these two lines.  It is the
  // cheapest composition device a dressing pass has and it costs about six
  // props per lane.
  PropsHarbor.prototype._dressLaneEdges = function () {
    if (!this.lanes) return;
    var R = this.rng;
    var side = 1;
    for (var i = 0; i < this.lanes.length; i++) {
      var L = this.lanes[i];
      var vx = L.x1 - L.x0, vz = L.z1 - L.z0;
      var len = Math.sqrt(vx * vx + vz * vz);
      if (!(len > 12)) continue;
      var ux = vx / len, uz = vz / len;
      var px = -uz, pz = ux;                          // lateral
      for (var d = R.range(6, 9); d < len - 5; d += R.range(6, 9)) {
        side = -side;
        var off = L.w * 0.5 + R.range(1.4, 2.6);
        var x = L.x0 + ux * d + px * off * side;
        var z = L.z0 + uz * d + pz * off * side;
        // facing back into the lane, so the mass presents its 3/4 to the lens
        var yaw = Math.atan2(-px * side, -pz * side) + R.range(-0.35, 0.35);
        if (!this._inBounds(x, z, 1.2)) continue;
        if (this._occupied(x, z, 1.5)) continue;
        var y = this._ground(x, z);
        if (this._blocked(x, y + 0.8, z, 1.0)) continue;
        var pick = R.int(0, 3);
        if (pick === 0 && this.B.jersey) {
          // a run of two - one barrier on its own reads as a dropped prop
          for (var k = 0; k < 2; k++) {
            this._drop(this.B.jersey, x + ux * k * 2.3, z + uz * k * 2.3, {
              r: 1.05, clearR: 0.7, tilt: 0.012, yaw: Math.atan2(ux, uz), lane: false,
              collider: [1.05, 0.41, 0.30], material: 'concrete'
            });
          }
        } else if (pick === 1 && this.B.cone) {
          for (var c = 0; c < 3; c++) {
            var cx = x + ux * (c - 1) * 1.5 + R.range(-0.2, 0.2);
            var cz = z + uz * (c - 1) * 1.5 + R.range(-0.2, 0.2);
            if (!this._inBounds(cx, cz, 0.5)) continue;
            var cy = this._ground(cx, cz);
            if (this.B.cone.place(cx, cy, cz, R.range(0, M.TAU),
              R.gaussian(0, 0.05), R.gaussian(0, 0.05), 1, 1, 1, wearTint(R))) {
              this.B.coneBand.place(cx, cy + 0.30, cz, 0, 0, 0, 1, 1, 1, WHITE);
              this._wetHalo(cx, cz, 0.30);
              this._occupy(cx, cz, 0.45);
            }
          }
        } else if (pick === 2) {
          this._palletStack(x, z, yaw);
        } else {
          for (var q = 0; q < 3; q++) {
            var a = q * 2.09 + R.range(-0.3, 0.3);
            var qx = x + Math.cos(a) * 0.36, qz = z + Math.sin(a) * 0.36;
            var qy = this._ground(qx, qz);
            var qyaw = R.range(0, M.TAU);
            this._drumLot().place(qx, qy, qz, qyaw,
              R.gaussian(0, 0.02), R.gaussian(0, 0.02), 1, 1, 1, wearTint(R));
            this._drumPlacard(qx, qy, qz, qyaw + yaw);
          }
          this._wetHalo(x, z, 0.75);
          this._occupy(x, z, 1.0);
        }
      }
      // ---- and the hardware that is ALLOWED in the ribbon -------------------
      // A swept lane is a cost, not a wall.  Twistlocks, lashing bars, a coiled
      // hose and a length of dunnage lie along the tread on any working
      // terminal, and they are what stops the corridor reading as a set that
      // was hoovered before the shoot.
      var n = Math.max(6, Math.floor(len / 5));
      for (var s = 0; s < n; s++) {
        var t = (s + R.range(0.15, 0.85)) / n;
        var lx = L.x0 + vx * t + px * R.gaussian(0, 0.55);
        var lz = L.z0 + vz * t + pz * R.gaussian(0, 0.55);
        if (!this._inBounds(lx, lz, 0.4)) continue;
        if (this._occupied(lx, lz, 0.4)) continue;
        var ly = this._ground(lx, lz);
        if (this._blocked(lx, ly + 0.3, lz, 0.3)) continue;
        var kind = R.int(0, 5);
        var bt = null, tilt = 0;
        if (kind <= 1) bt = this.B.twistlock;
        else if (kind === 2) bt = this.B.lashingBar;
        else if (kind === 3) bt = this.B.hoseCoil;
        else if (kind === 4) bt = this.B.dunnage;
        else bt = this.B['litter' + R.int(0, 3)];
        if (!bt) continue;
        if (kind === 5) tilt = Math.PI / 2;
        bt.place(lx, ly + (kind === 5 ? 0.02 : 0), lz, R.range(0, M.TAU),
          tilt + R.gaussian(0, 0.06), R.gaussian(0, 0.06),
          R.range(0.85, 1.15), 1, 1, wearTint(R));
        this._occupy(lx, lz, 0.4);
      }
    }
  };

  // A stack of pallets under a lashed tarpaulin: the silhouette this level's
  // yard is built out of.
  PropsHarbor.prototype._palletStack = function (x, z, yaw) {
    var R = this.rng;
    if (!this.B.pallet || !this.B.bale || !this.B.crate) return false;
    if (!this._inBounds(x, z, 2.2)) return false;
    if (!this._laneClear(x, z, 1.9)) return false;
    if (this._occupied(x, z, 1.9)) return false;
    var y = this._ground(x, z);
    if (this._blocked(x, y + 0.8, z, 1.5)) return false;

    var high = R.int(2, 4);
    var i, j;
    // Two pallets side by side per course, rotated a little each course.
    for (i = 0; i < high; i++) {
      var cy = y + i * 0.155;
      for (j = 0; j < 2; j++) {
        var ox = (j - 0.5) * 0.86;
        _va.set(ox, 0, 0).applyAxisAngle(UP, yaw);
        this.B.pallet.place(x + _va.x, cy, z + _va.z,
          yaw + R.gaussian(0, 0.035), R.gaussian(0, 0.010), R.gaussian(0, 0.010),
          1, 1, 1, wearTint(R));
      }
    }
    var topY = y + high * 0.155;
    // The load on top: bales or crates, then the sheet over the lot.
    var loadH = 0;
    if (R.bool(0.55)) {
      for (i = 0; i < 2; i++) {
        for (j = 0; j < 2; j++) {
          _va.set((i - 0.5) * 0.98, 0, (j - 0.5) * 0.74).applyAxisAngle(UP, yaw);
          this.B.bale.place(x + _va.x, topY, z + _va.z,
            yaw + R.gaussian(0, 0.06), R.gaussian(0, 0.02), R.gaussian(0, 0.02),
            1, R.range(0.95, 1.06), 1, wearTint(R));
        }
      }
      loadH = 0.64;
    } else {
      for (i = 0; i < 2; i++) {
        _va.set((i - 0.5) * 1.10, 0, 0).applyAxisAngle(UP, yaw);
        this.B.crate.place(x + _va.x, topY, z + _va.z,
          yaw + R.gaussian(0, 0.08), R.gaussian(0, 0.02), R.gaussian(0, 0.02),
          1, 1, 1, wearTint(R));
      }
      loadH = 0.88;
    }

    // The tarpaulin, sitting on the load and hanging down the sides of it.
    //
    // The vertical scale is SOLVED rather than jittered: both lots carry 1.10 m
    // of drape at the corners, so one scale puts the crown just proud of the
    // load and the hem 16 cm clear of the deck whatever the stack turned out to
    // be.  The old fixed offset dropped a 1.45 m sheet onto a 0.95 m stack,
    // which is why it read as a lid with a valance.
    var tarpA = R.bool(0.55);
    var tb = tarpA ? this.B.tarpA : this.B.tarpB;
    var tarpH = tarpA ? 1.55 : 1.30;
    var stackH = topY + loadH - y;
    var tsy = M.clamp((stackH - 0.10) / 1.10, 0.75, 1.35);
    var toy = y + 0.16 - (tarpH - 1.10) * tsy;
    tb.place(x, toy, z, yaw + R.gaussian(0, 0.05), 0, 0,
      R.range(0.96, 1.08), tsy, R.range(0.96, 1.08), wearTint(R));

    // Lashings over the sheet, taken down to the pallet.
    this._chainPaths = this._chainPaths || [];
    var nLash = R.int(2, 3);
    for (i = 0; i < nLash; i++) {
      var t = (i + 0.7) / (nLash + 0.4);
      var lx = (t - 0.5) * 2.4;
      _va.set(lx, 0, -1.25).applyAxisAngle(UP, yaw);
      _vb.set(lx, 0, 1.25).applyAxisAngle(UP, yaw);
      this._ropePaths = this._ropePaths || [];
      this._ropePaths.push({
        a: new THREE.Vector3(x + _va.x, y + 0.12, z + _va.z),
        b: new THREE.Vector3(x + _vb.x, y + 0.12, z + _vb.z),
        sag: -(topY - y + loadH * 0.62),          // negative sag = arch over the load
        r: 0.022, flex: 0.05, seg: 9
      });
    }

    this._occupy(x, z, 2.0);
    this._collider(x, y, z, [1.30, (topY - y + loadH) * 0.5, 1.15], yaw, 'wood');
    // Water finds the low ground beside a stack, and litter finds its lee.
    if (R.bool(0.5)) this._pool(x + R.range(-2.6, 2.6), z + R.range(-2.6, 2.6), R.range(0.7, 1.5));
    // and it stands IN water at its own feet, not on top of it
    this._wetHalo(x, z, 1.10);
    return true;
  };

  // Candidate sites along the flanks of the level's container stacks: a metre
  // and a half out from the steel, facing the open lane.
  //
  // Container rows in this level come in touching PAIRS with a working corridor
  // between the pairs, so a site a fixed 1.6 m off a flank lands inside the
  // neighbouring box half the time.  Each candidate therefore steps outward
  // until it is actually in open air - which is what puts the cargo in the
  // corridors, where a forklift could have put it, instead of throwing away
  // half the sites at placement time.
  var FLANK_OFFSETS = [1.65, 2.55, 3.60, 4.70];

  PropsHarbor.prototype._stackFlanks = function (maxPer) {
    var out = [];
    var R = this.rng;
    for (var i = 0; i < this.containers.length && out.length < 700; i++) {
      var c = this.containers[i];
      if (c.base > this.groundY + 0.9) continue;         // stacked high, not a wall we can reach
      var lx = c.maxx - c.minx, lz = c.maxz - c.minz;
      var alongX = lx > lz;
      var len = alongX ? lx : lz;
      var n = Math.max(1, Math.min(maxPer || 8, Math.floor(len / 2.6)));
      for (var k = 0; k < n; k++) {
        var t = (k + 0.5) / n;
        for (var side = -1; side <= 1; side += 2) {
          var x = 0, z = 0, yaw = 0, found = false;
          for (var o = 0; o < FLANK_OFFSETS.length && !found; o++) {
            var off = FLANK_OFFSETS[o];
            if (alongX) {
              x = M.lerp(c.minx, c.maxx, t);
              z = (side < 0 ? c.minz - off : c.maxz + off);
              yaw = side < 0 ? Math.PI : 0;
            } else {
              z = M.lerp(c.minz, c.maxz, t);
              x = (side < 0 ? c.minx - off : c.maxx + off);
              yaw = side < 0 ? -Math.PI / 2 : Math.PI / 2;
            }
            if (!this._inBounds(x, z, 1.4)) break;
            if (!this._blocked(x, this.groundY + 0.9, z, 0.95)) found = true;
          }
          if (!found) continue;
          out.push({ x: x + R.range(-0.25, 0.25), z: z + R.range(-0.25, 0.25), yaw: yaw });
        }
      }
    }
    // Shuffle deterministically so consecutive picks are not all off one stack.
    for (var s = out.length - 1; s > 0; s--) {
      var j = R.int(0, s);
      var tmp = out[s]; out[s] = out[j]; out[j] = tmp;
    }
    return out;
  };

  // When the level has no container colliders to read (a level still under
  // construction, or one that models its stacks as merged geometry), fall back
  // to sites along the yard edges, which is where cargo would be anyway.
  PropsHarbor.prototype._fallbackSites = function (n) {
    var out = [], R = this.rng, b = this.bounds;
    for (var i = 0; i < n * 6; i++) {
      var edge = R.int(0, 3);
      var x, z, yaw;
      if (edge === 0) { x = b.x0 + R.range(2.5, 6); z = R.range(this.quayZ + 6, b.z1 - 4); yaw = Math.PI / 2; }
      else if (edge === 1) { x = b.x1 - R.range(2.5, 6); z = R.range(this.quayZ + 6, b.z1 - 4); yaw = -Math.PI / 2; }
      else if (edge === 2) { x = R.range(b.x0 + 5, b.x1 - 5); z = b.z1 - R.range(3, 7); yaw = 0; }
      else { x = R.range(b.x0 + 5, b.x1 - 5); z = this.quayZ + R.range(7, 12); yaw = Math.PI; }
      out.push({ x: x, z: z, yaw: yaw });
    }
    return out;
  };

  // Keep trying sites until `want` of a thing are actually on the ground.
  //
  // Every large prop in this file used to be "take a site, try once, move on",
  // which for anything bigger than a crate means it is placed if the first
  // draw happens to be lucky and simply absent otherwise - and absent silently,
  // because a rejected _drop returns null and nobody counted it.  A retry loop
  // is four lines and it is the difference between four gensets and one.
  PropsHarbor.prototype._placeMany = function (batch, sites, want, opts, after) {
    if (!batch) return 0;
    var placed = 0, guard = 0;
    while (placed < want && guard++ < 80) {
      var s = this._pickSite(sites, opts.r);
      if (!s) break;
      var y = this._drop(batch, s.x, s.z, {
        r: opts.r, clearR: opts.clearR, tilt: opts.tilt, lane: false,
        yaw: s.yaw + (opts.yawOff || 0),
        collider: opts.collider, material: opts.material
      });
      if (y === null) continue;
      placed++;
      if (after) after.call(this, s, y);
    }
    return placed;
  };

  // Take the next usable site off the list, consuming ONLY the one it returns.
  //
  // This used to pop, and give up after forty pops.  Both halves were wrong in
  // the same direction: a site that is too tight for a three-metre genset is a
  // perfectly good spot for a tyre, but popping it on the FAILED test threw it
  // away for every later pass, and eleven calls at forty pops each drained a
  // four-hundred-entry list before the pass that needed the small sites ever
  // ran.  The yard ended up with no gensets, no skips and not one tyre, and
  // nothing said so because nobody counts a null.
  PropsHarbor.prototype._pickSite = function (sites, r, low) {
    for (var i = sites.length - 1; i >= 0; i--) {
      var s = sites[i];
      if (!s) { sites.splice(i, 1); continue; }
      if (!this._inBounds(s.x, s.z, r)) continue;
      if (!this._laneClear(s.x, s.z, r, low)) continue;
      if (this._occupied(s.x, s.z, r)) continue;
      sites.splice(i, 1);
      return s;
    }
    return null;
  };

  // --------------------------------------------------------------------------
  // Dressing: machinery
  // --------------------------------------------------------------------------
  // Sites that a published framing actually LOOKS AT.
  //
  // The plant used to be pinned to fractions of the yard - forklift at 42% of
  // the apron half-width, bowser at 55% the other way, tractor at 20% of the
  // depth - with no reference whatever to this.poses.  That is a survey, not a
  // composition, and combined with the swept lanes it meant the five biggest
  // silhouettes in the kit were built every boot and appeared in none of the
  // fourteen captures.  This marches the forward axis of each published framing
  // and records the first cell big enough to park a machine in, so the plant
  // ends up where the camera is pointed and the yard gets cover, occlusion and
  // something for a mast cone to strike.
  PropsHarbor.prototype._dressPlantOnAxis = function () {
    this.plantSites = [];
    var poses = this.poses;
    if (!poses) return;
    var R = this.rng;
    var keys = ['containers', 'crane', 'quay', 'gangway', 'overview'];
    var LAT = [0, 4.6, -4.6, 8.0, -8.0];
    for (var i = 0; i < keys.length; i++) {
      var p = poses[keys[i]];
      if (!p || !p.position) continue;
      if (this._indoor(p.position.x, p.position.z, 0.6)) continue;
      var yaw = p.yaw || 0;
      var fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      var rx = Math.cos(yaw), rz = -Math.sin(yaw);
      var found = null;
      for (var t = 8; t <= 30 && !found; t += 1.25) {
        for (var s = 0; s < LAT.length && !found; s++) {
          var x = p.position.x + fx * t + rx * LAT[s];
          var z = p.position.z + fz * t + rz * LAT[s];
          if (!this._inBounds(x, z, 3.5)) continue;
          if (this._occupied(x, z, 3.5)) continue;
          if (this._blocked(x, this._ground(x, z) + 1.3, z, 2.3)) continue;
          found = {
            x: x, z: z,
            // three-quarter to the lens: a machine square-on is a billboard
            yaw: Math.atan2(p.position.x - x, p.position.z - z) + R.range(0.55, 1.15),
            key: keys[i], dist: t
          };
        }
      }
      if (found) this.plantSites.push(found);
    }
  };

  PropsHarbor.prototype._dressMachinery = function () {
    var R = this.rng, b = this.bounds, N = this.noise;
    var ac = (this.apron.x0 + this.apron.x1) * 0.5;
    var aw = Math.max(4, this.apron.x1 - this.apron.x0);
    var self = this;

    this._dressPlantOnAxis();
    var ps = (this.plantSites || []).slice();
    // Hand out an on-axis cell if one is still free, otherwise fall back to the
    // yard fraction the machine used to be nailed to.
    function site(fbX, fbZ, fbYaw, need) {
      for (var i = 0; i < ps.length; i++) {
        var s = ps[i];
        if (self._occupied(s.x, s.z, need || 3.0)) continue;
        ps.splice(i, 1);
        return s;
      }
      return { x: fbX, z: fbZ, yaw: fbYaw };
    }

    // ---- forklift -----------------------------------------------------------
    // Parked askew with its forks down, the way one is left at the end of a
    // shift, on the first framing axis with room for it.
    var fS = site(M.clamp(ac + aw * 0.42, b.x0 + 4, b.x1 - 4),
      M.lerp(this.quayZ, b.z1, 0.42), R.range(2.1, 2.6), 2.6);
    var fx = M.clamp(fS.x, b.x0 + 4, b.x1 - 4);
    var fz = fS.z;
    var fy = this._ground(fx, fz);
    var fyaw = fS.yaw;
    var fl = K.forklift();
    if (fl) {
      this._finishGeo(fl, 'painted_line', { noise: N, grime: 0.44, edge: 0.40, hiY: 2.2 });
      this._static('paint', fl, Tn(fx, fy, fz, 0, fyaw, 0));
      this._collider(fx, fy, fz, [1.05, 1.05, 1.6], fyaw, 'metal');
      this._occupy(fx, fz, 2.4);
      // wet tyre tracks lead away from it: the walking line made visible
      this._oilSlick(fx + Math.sin(fyaw) * 2.4, fz + Math.cos(fyaw) * 2.4, 0.8);
      this._wetHalo(fx, fz, 1.15);
      this.forkliftAt = new THREE.Vector3(fx, fy, fz);
    }

    // ---- fuel bowser --------------------------------------------------------
    var bS = site(M.clamp(ac - aw * 0.55, b.x0 + 5, b.x1 - 5),
      M.lerp(this.quayZ, b.z1, 0.66), R.range(-0.3, 0.3) + Math.PI / 2, 3.2);
    var bx = M.clamp(bS.x, b.x0 + 5, b.x1 - 5);
    var bz = bS.z;
    var by = this._ground(bx, bz);
    var byaw = bS.yaw;
    var bw = K.bowser(N);
    if (bw) {
      this._finishGeo(bw, 'deck_plate', { noise: N, grime: 0.46, edge: 0.34, hiY: 2.4 });
      this._static('deck', bw, Tn(bx, by, bz, 0, byaw, 0));
      this._collider(bx, by, bz, [1.9, 1.1, 1.0], byaw, 'metal');
      this._occupy(bx, bz, 2.8);
      this.bowserAt = new THREE.Vector3(bx, by, bz);
      // The keep-clear box painted round a fuel point, and the cones enforcing
      // it - the one place on the apron with real painted markings on it.
      this._keepClear(bx, bz, 3.4, 2.4, byaw);
      for (var c = 0; c < 4; c++) {
        var ca = c * Math.PI / 2 + Math.PI / 4;
        this._drop(this.B.cone, bx + Math.cos(ca) * 3.5, bz + Math.sin(ca) * 2.6,
          { r: 0.25, tilt: 0.05, lane: false });
        this.B.coneBand.place(bx + Math.cos(ca) * 3.5,
          this._ground(bx + Math.cos(ca) * 3.5, bz + Math.sin(ca) * 2.6) + 0.30,
          bz + Math.sin(ca) * 2.6, 0, 0, 0, 1, 1, 1, wearTint(R));
      }
      this._oilSlick(bx + R.range(-1.6, 1.6), bz + R.range(-2, 2), R.range(1.1, 2.0));
      this._wetHalo(bx, bz, 1.15);
    }

    // ---- terminal tractor ---------------------------------------------------
    var tS = site(M.clamp(ac - aw * 0.30, b.x0 + 5, b.x1 - 5),
      M.lerp(this.quayZ, b.z1, 0.20), R.range(-0.35, 0.35), 3.4);
    var tx = M.clamp(tS.x, b.x0 + 5, b.x1 - 5);
    var tz = tS.z;
    var ty = this._ground(tx, tz);
    var tyaw = tS.yaw;
    var tr = K.tractor();
    if (tr) {
      this._finishGeo(tr, 'deck_plate', { noise: N, grime: 0.40, edge: 0.32, hiY: 3.2 });
      this._static('deck', tr, Tn(tx, ty, tz, 0, tyaw, 0));
      this._collider(tx, ty, tz, [1.1, 1.3, 2.3], tyaw, 'metal');
      this._occupy(tx, tz, 3.2);
      this._wetHalo(tx, tz, 1.15);
      this.tractorAt = new THREE.Vector3(tx, ty, tz);
    }

    // ---- spreader -----------------------------------------------------------
    // A spreader on the ground is a 12 m steel wall at knee height: a real
    // piece of cover, and a strong leading line across the apron.
    var sx = M.clamp(ac + aw * 0.15, b.x0 + 8, b.x1 - 8);
    var sz = M.lerp(this.quayZ, b.z1, 0.30);
    var sy = this._ground(sx, sz);
    var syaw = R.range(-0.12, 0.12) + Math.PI / 2;
    var sp = K.spreader();
    if (sp) {
      this._finishGeo(sp, 'deck_plate', { noise: N, grime: 0.42, edge: 0.44, hiY: 1.8 });
      this._static('deck', sp, Tn(sx, sy, sz, 0, syaw, 0));
      this._collider(sx, sy, sz, [1.3, 0.72, 6.1], syaw, 'metal');
      this._occupy(sx, sz, 5.0);
      this.spreaderAt = new THREE.Vector3(sx, sy, sz);
      // Timber under the corner castings so it is not sitting on the concrete.
      for (var d = -1; d <= 1; d += 2) {
        _va.set(0, 0, d * 5.9).applyAxisAngle(UP, syaw);
        this.B.dunnage.place(sx + _va.x, sy, sz + _va.z, syaw + Math.PI / 2, 0, 0,
          1.3, 1, 1, wearTint(R));
      }
    }

    // ---- generator sets, cable reels, skips ---------------------------------
    var sites = this._stackFlanks(6);
    if (!sites.length) sites = this._fallbackSites(8);
    var i, s;
    // ---- generator sets -----------------------------------------------------
    // Placed against the level's PUBLISHED anchors rather than at a container
    // flank: a genset is a 3 m box that lives where the power is needed, which
    // on this terminal is the reefer bank, and it never fitted in the 1.6 m gap
    // a flank site offers.
    var gsAt = [];
    var lvlReefers = (this.ctx.level && this.ctx.level.reefers) || [];
    for (i = 0; i < lvlReefers.length && gsAt.length < 2; i++) {
      var rf0 = lvlReefers[i];
      if (!rf0 || !isFinite(rf0.x)) continue;
      var fe = this._machineryEnd(rf0);
      if (!fe) continue;
      // Beyond the socket rack, not on top of it.
      gsAt.push({ x: fe.x + Math.sin(fe.yaw) * 7.4, z: fe.z + Math.cos(fe.yaw) * 7.4,
        yaw: fe.yaw + Math.PI });
    }
    gsAt.push({ x: M.clamp(ac + aw * 0.72, b.x0 + 5, b.x1 - 5),
      z: M.lerp(this.quayZ, b.z1, 0.80), yaw: R.range(-0.2, 0.2) });
    gsAt.push({ x: M.clamp(ac - aw * 0.62, b.x0 + 5, b.x1 - 5),
      z: M.lerp(this.quayZ, b.z1, 0.10), yaw: R.range(1.4, 1.8) });
    // Anything the anchors could not take goes to open flank ground.
    for (i = 0; i < sites.length && gsAt.length < 14; i++) gsAt.push(sites[i]);
    this._placeMany(this.B.genset, gsAt, 4,
      { r: 2.2, clearR: 1.15, tilt: 0.012, collider: [1.45, 0.9, 0.65], material: 'metal' },
      function (s, y) {
        this._ropeCoil(s.x + Math.cos(s.yaw) * 1.9, y, s.z + Math.sin(s.yaw) * 1.9);
        this._oilSlick(s.x + R.range(-1.4, 1.4), s.z + R.range(-1.4, 1.4), R.range(0.6, 1.1));
      });
    for (i = 0; i < 5; i++) {
      s = this._pickSite(sites, 1.3);
      if (!s) continue;
      // Reels lie on their side as often as they stand.
      if (R.bool(0.4)) {
        var ry = this._ground(s.x, s.z);
        this.B.cableReel.place(s.x, ry - 0.02, s.z, s.yaw, Math.PI / 2, 0, 1, 1, 1, wearTint(R));
        this._occupy(s.x, s.z, 1.1);
      } else {
        this._drop(this.B.cableReel, s.x, s.z, {
          r: 1.1, tilt: 0.02, yaw: s.yaw + Math.PI / 2 + R.range(-0.2, 0.2),
          collider: [0.5, 0.9, 0.9], material: 'wood'
        });
      }
    }
    // ---- skips --------------------------------------------------------------
    // Corners of the yard, where a 4 m skip is actually left, and where it
    // gives the two landward framings a mass to close their edges with.
    var skipAt = [
      { x: M.clamp(ac - aw * 0.95, b.x0 + 4, b.x1 - 4), z: M.lerp(this.quayZ, b.z1, 0.86), yaw: R.range(-0.25, 0.25) },
      { x: M.clamp(ac + aw * 0.88, b.x0 + 4, b.x1 - 4), z: M.lerp(this.quayZ, b.z1, 0.34), yaw: R.range(1.3, 1.9) },
      { x: M.clamp(ac - aw * 0.80, b.x0 + 4, b.x1 - 4), z: M.lerp(this.quayZ, b.z1, 0.50), yaw: R.range(-0.3, 0.3) }
    ];
    for (i = 0; i < sites.length && skipAt.length < 16; i++) skipAt.push(sites[i]);
    this._placeMany(this.B.skip, skipAt, 3,
      { r: 2.4, clearR: 1.3, tilt: 0.010, collider: [1.85, 0.65, 1.0], material: 'metal' },
      function (s, ky) {
        // Spilling over the rim: broken pallet, timber, a drum.
        this.B.palletBroken.place(s.x + R.range(-0.6, 0.6), ky + 1.10, s.z + R.range(-0.4, 0.4),
          s.yaw + R.range(-1, 1), R.range(0.3, 0.9), R.range(-0.3, 0.3), 1, 1, 1, wearTint(R));
        for (var t = 0; t < 4; t++) {
          this.B.dunnage.place(s.x + R.range(-1.2, 1.2), ky + R.range(1.05, 1.30), s.z + R.range(-0.7, 0.7),
            R.range(0, 3.14), R.range(-0.5, 0.5), R.range(-0.5, 0.5), R.range(0.6, 1.1), 1, 1, wearTint(R));
        }
        this.B.drumRust.place(s.x + R.range(-1.0, 1.0), ky + 1.15, s.z + R.range(-0.5, 0.5),
          R.range(0, 6.28), Math.PI / 2 + R.range(-0.3, 0.3), R.range(-0.3, 0.3), 1, 1, 1, wearTint(R));
      });

    // ---- tyres --------------------------------------------------------------
    for (i = 0; i < 22; i++) {
      s = this._pickSite(sites, 0.8);
      if (!s) continue;
      var tyY = this._ground(s.x, s.z);
      if (R.bool(0.55)) {
        // stacked flat
        var stack = R.int(2, 4);
        for (var q = 0; q < stack; q++) {
          this.B.tyre.place(s.x + R.range(-0.05, 0.05), tyY + 0.16 + q * 0.20, s.z + R.range(-0.05, 0.05),
            R.range(0, 6.28), Math.PI / 2, R.gaussian(0, 0.03), 1, 1, 1, wearTint(R));
        }
      } else {
        this.B.tyre.place(s.x, tyY + 0.42, s.z, R.range(0, 6.28), 0, R.gaussian(0, 0.25),
          1, 1, 1, wearTint(R));
      }
      this._occupy(s.x, s.z, 0.8);
    }
  };

  // --------------------------------------------------------------------------
  // Dressing: the warehouse interior
  //
  // The one enterable structure, and a published hero framing.  The level
  // builds the shell, the racking and the pool under the roof hole; what it has
  // no floor clutter at all, which leaves a 21 x 20 m concrete slab with two
  // rack runs on it and nothing a person ever touched.  The art direction asks
  // for a forklift in here by name.
  //
  // Everything placed here is DRY.  The footprint comes from _findInterior,
  // which reads it off the level's own floor collider via published interior
  // practicals - so the shed can move again and this follows it.
  // --------------------------------------------------------------------------
  PropsHarbor.prototype._dressWarehouse = function () {
    var it = this.interior;
    if (!it) return;
    var R = this.rng, N = this.noise;
    var cx = (it.x0 + it.x1) * 0.5, cz = (it.z0 + it.z1) * 0.5;
    var i, j;

    // ---- the forklift, parked inside ----------------------------------------
    // Angled across the floor near the middle so it reads from the doorway and
    // from the interior framing both, with its forks down.
    var fyaw = R.range(0.7, 1.2);
    var fx = cx + R.range(-2.0, 1.0), fz = cz + R.range(-3.0, 0.5);
    var fl = K.forklift();
    if (fl) {
      var fy = this._ground(fx, fz);
      this._finishGeo(fl, 'painted_line', { noise: N, grime: 0.40, edge: 0.42, hiY: 2.2 });
      this._static('dry', fl, Tn(fx, fy, fz, 0, fyaw, 0));
      this._collider(fx, fy, fz, [1.05, 1.05, 1.6], fyaw, 'metal');
      this._occupy(fx, fz, 2.6);
      this.forkliftIn = new THREE.Vector3(fx, fy, fz);
      // A pallet on the forks and one it just put down.
      if (this.B.palletDry) {
        _va.set(0, 0, 1.55).applyAxisAngle(UP, fyaw);
        this.B.palletDry.place(fx + _va.x, fy + 0.24, fz + _va.z, fyaw, 0, 0,
          1, 1, 1, wearTint(R));
      }
    }

    // ---- unit loads against the walls ---------------------------------------
    // Stacked where a forklift can reach them without blocking the run between
    // the doors: down both long walls, clear of the rack aisles.
    var sites = [];
    for (i = 0; i < 14; i++) {
      var t = (i + 0.5) / 14;
      sites.push({ x: it.x0 + 1.1, z: M.lerp(it.z0 + 1.2, it.z1 - 1.2, t), yaw: Math.PI / 2 });
      sites.push({ x: it.x1 - 1.1, z: M.lerp(it.z0 + 1.2, it.z1 - 1.2, t), yaw: -Math.PI / 2 });
    }
    for (i = sites.length - 1; i > 0; i--) {
      j = R.int(0, i);
      var tmp = sites[i]; sites[i] = sites[j]; sites[j] = tmp;
    }
    var stacks = 0;
    for (i = 0; i < sites.length && stacks < 9; i++) {
      var s = sites[i];
      if (!this._inBounds(s.x, s.z, 1.0, true)) continue;
      if (this._occupied(s.x, s.z, 1.4)) continue;
      var gy = this._ground(s.x, s.z);
      if (this._blocked(s.x, gy + 0.8, s.z, 1.0)) continue;
      var high = R.int(2, 7);
      for (j = 0; j < high; j++) {
        this.B.palletDry.place(s.x, gy + j * 0.152, s.z, s.yaw + R.gaussian(0, 0.05),
          R.gaussian(0, 0.008), R.gaussian(0, 0.008), 1, 1, 1, wearTint(R));
      }
      var loadY = gy + high * 0.152;
      if (this.B.baleDry && R.bool(0.6)) {
        // Shrink-wrapped unit loads: pale polythene, and by a long way the
        // lightest thing this file can put on a floor.  The interior reads as a
        // lit roof over a black plate without something down here with albedo.
        for (var q = 0; q < 2; q++) {
          _va.set(0, 0, (q - 0.5) * 0.72).applyAxisAngle(UP, s.yaw);
          this.B.baleDry.place(s.x + _va.x, loadY, s.z + _va.z,
            s.yaw + R.gaussian(0, 0.05), 0, 0, 1, R.range(0.94, 1.06), 1, wearTint(R));
        }
      } else if (this.B.crateDry) {
        this.B.crateDry.place(s.x + R.range(-0.14, 0.14), loadY,
          s.z + R.range(-0.14, 0.14), s.yaw + R.gaussian(0, 0.2), 0, 0,
          1, 1, 1, wearTint(R));
      }
      this._occupy(s.x, s.z, 1.3);
      this._collider(s.x, gy, s.z, [0.62, high * 0.076 + 0.05, 0.44], s.yaw, 'wood');
      stacks++;
    }

    // ---- loose loads out on the floor ---------------------------------------
    // Not everything is squared away against a wall: a shed with all its stock
    // on the perimeter is a corridor, not a working store.
    for (i = 0; i < 7; i++) {
      var lx = R.range(it.x0 + 2.6, it.x1 - 2.6);
      var lz = R.range(it.z0 + 2.2, it.z1 - 2.2);
      if (!this._freeSpot(lx, lz, 1.2, 0.5, true)) continue;
      var ly = this._ground(lx, lz);
      var lyaw = R.range(0, M.TAU);
      var lh = R.int(2, 4);
      for (j = 0; j < lh; j++) {
        this.B.palletDry.place(lx, ly + j * 0.152, lz, lyaw + R.gaussian(0, 0.05),
          0, 0, 1, 1, 1, wearTint(R));
      }
      if (this.B.baleDry) {
        for (j = 0; j < 2; j++) {
          _va.set((j - 0.5) * 0.98, 0, 0).applyAxisAngle(UP, lyaw);
          this.B.baleDry.place(lx + _va.x, ly + lh * 0.152, lz + _va.z,
            lyaw + R.gaussian(0, 0.06), 0, 0, 1, 1, 1, wearTint(R));
        }
      }
      this._occupy(lx, lz, 1.4);
      this._collider(lx, ly, lz, [0.95, (lh * 0.152 + 0.62) * 0.5, 0.55], lyaw, 'wood');
    }

    // ---- painted floor markings ---------------------------------------------
    // Aisle edges and a hatched loading bay inside the open door: real, cheap,
    // and the only pale value on a warehouse floor at two in the morning.
    this._floorMarks(it);

    // ---- drums, timber and the litter of a working shed ---------------------
    for (i = 0; i < 16; i++) {
      var dx = R.range(it.x0 + 0.8, it.x1 - 0.8);
      var dz = R.range(it.z0 + 0.8, it.z1 - 0.8);
      if (!this._freeSpot(dx, dz, 0.4, 0.4, true)) continue;
      var dy = this._ground(dx, dz);
      if (R.bool(0.45) && this.B.drumDry) {
        this.B.drumDry.place(dx, dy, dz, R.range(0, M.TAU),
          R.gaussian(0, 0.015), R.gaussian(0, 0.015), 1, 1, 1, wearTint(R));
        this._occupy(dx, dz, 0.4);
      } else if (this.B.dunnageDry) {
        var pair = R.bool(0.55) ? 2 : 1;
        for (j = 0; j < pair; j++) {
          this.B.dunnageDry.place(dx + j * 0.24, dy, dz + j * 0.9, R.range(0, M.TAU),
            R.gaussian(0, 0.03), R.gaussian(0, 0.03), R.range(0.6, 1.15), 1, 1, wearTint(R));
        }
        this._occupy(dx, dz, 0.9);
      }
    }
    // Hydraulic oil under the forklift and a stain where the drums live.
    this._oilSlick(fx + R.range(-1.2, 1.2), fz + R.range(-1.6, 1.6), R.range(0.8, 1.5), true);
    this._oilSlick(cx + R.range(-4, 4), cz + R.range(-4, 4), R.range(0.6, 1.2), true);
    this.stats.interior = stacks;
  };

  // Painted aisle edges and a hatched loading bay on the interior slab.  Flat
  // geometry a few millimetres proud of the floor, in the dry line material, so
  // it takes light from the interior practicals and the roof-hole shaft.
  PropsHarbor.prototype._floorMarks = function (it) {
    var R = this.rng;
    var cx = (it.x0 + it.x1) * 0.5;
    var y = this._ground(cx, (it.z0 + it.z1) * 0.5) + 0.011;
    var i, g;
    // two aisle lines running the length of the shed
    for (i = -1; i <= 1; i += 2) {
      var ax = cx + i * (it.x1 - it.x0) * 0.20;
      g = new THREE.PlaneGeometry(0.13, (it.z1 - it.z0) - 2.4);
      g.rotateX(-Math.PI / 2);
      this._static('lineDry', g, Tn(ax, y, (it.z0 + it.z1) * 0.5, 0, 0, 0));
    }
    // a cross aisle
    g = new THREE.PlaneGeometry((it.x1 - it.x0) - 2.4, 0.13);
    g.rotateX(-Math.PI / 2);
    this._static('lineDry', g, Tn(cx, y, (it.z0 + it.z1) * 0.5 + R.range(-1.5, 1.5), 0, 0, 0));
    // hatched loading bay against the yard face, where the forks come and go
    var bx = it.x0 + 2.4, bz = (it.z0 + it.z1) * 0.5 - 3.0;
    for (i = 0; i < 9; i++) {
      g = new THREE.PlaneGeometry(0.11, 3.4);
      g.rotateX(-Math.PI / 2);
      this._static('lineDry', g, Tn(bx + i * 0.42, y, bz, 0, 0.62, 0));
    }
    for (i = -1; i <= 1; i += 2) {
      g = new THREE.PlaneGeometry(4.0, 0.11);
      g.rotateX(-Math.PI / 2);
      this._static('lineDry', g, Tn(bx + 1.7, y, bz + i * 1.75, 0, 0, 0));
    }
  };

  // --------------------------------------------------------------------------
  // Dressing: reefer units
  //
  // Bolted onto the END of a container, always the end that faces the power
  // rack, always at ground level or one course up.  The unit is the only prop
  // in the level with its own light source, its own moving part and its own
  // permanent puddle - so it earns a lot of screen time for its triangles.
  // --------------------------------------------------------------------------
  PropsHarbor.prototype._dressReefers = function () {
    var R = this.rng;
    this.reefers = [];
    var i;

    // If the level built its own reefer bank, the machinery packs are already
    // modelled into the container ends.  What is missing from every reefer
    // stack ever built in a level editor is what makes it read as RUNNING:
    // condensate coming off the condenser and the permanent wet stripe under
    // the drain.  Add those and nothing else.
    var lvl = this.ctx.level;
    if (!this.own.reefers) {
      var bank = lvl.reefers;
      for (i = 0; i < bank.length; i++) {
        var rf = bank[i];
        if (!rf || !isFinite(rf.x)) continue;
        // The published anchor is the CENTRE of the box and carries no
        // orientation.  The machinery end therefore has to be DERIVED from the
        // box the anchor sits in, not remembered: the previous code took the
        // anchor as the face and assumed a fixed -PI/2, which put the drip
        // line, the control display and the drain puddle six metres inside a
        // 40 ft container, pointing at the stack behind it.
        var face = this._machineryEnd(rf);
        if (!face) continue;
        var n = Math.max(1, rf.n || 1);
        var base = this._ground(face.x, face.z);
        for (var k = 0; k < n; k++) {
          this._reeferCondensate(face.x, base + k * COURSE_H, face.z, face.yaw, k === 0);
        }
        this.reefers.push({ x: face.x, y: base, z: face.z, yaw: face.yaw, level: true });
      }
      return;
    }

    var ends = [];
    for (i = 0; i < this.containers.length; i++) {
      var c = this.containers[i];
      if (c.toppled) continue;
      if (c.base > this.groundY + 3.2) continue;         // too high to read
      var lx = c.maxx - c.minx, lz = c.maxz - c.minz;
      var alongX = lx > lz;
      // the two ends of the box
      if (alongX) {
        ends.push({ x: c.maxx + 0.06, z: (c.minz + c.maxz) * 0.5, yaw: Math.PI / 2, base: c.base, c: c });
        ends.push({ x: c.minx - 0.06, z: (c.minz + c.maxz) * 0.5, yaw: -Math.PI / 2, base: c.base, c: c });
      } else {
        ends.push({ x: (c.minx + c.maxx) * 0.5, z: c.maxz + 0.06, yaw: 0, base: c.base, c: c });
        ends.push({ x: (c.minx + c.maxx) * 0.5, z: c.minz - 0.06, yaw: Math.PI, base: c.base, c: c });
      }
    }
    // Deterministic shuffle, then take a run of them so the reefer stack reads
    // as a block of refrigerated boxes rather than one in every ten.
    for (var s = ends.length - 1; s > 0; s--) {
      var j = R.int(0, s);
      var t = ends[s]; ends[s] = ends[j]; ends[j] = t;
    }
    var want = Math.min(9, ends.length);
    for (i = 0; i < ends.length && this.reefers.length < want; i++) {
      var e = ends[i];
      if (!this._inBounds(e.x, e.z, 0.8)) continue;
      // needs clear air in front of it or the unit is buried in the next stack
      var fx = e.x + Math.sin(e.yaw) * 1.4, fz = e.z + Math.cos(e.yaw) * 1.4;
      if (this._blocked(fx, e.base + 1.2, fz, 0.8)) continue;
      this._placeReefer(e.x, e.base + 0.10, e.z, e.yaw);
    }
    // If the level published no containers, put a short reefer rack on the
    // apron edge so the level still has its humming, dripping units.
    if (!this.reefers.length) {
      var rx = this.apron.x1 + 2.2;
      for (i = 0; i < 4; i++) {
        this._placeReefer(rx, this.groundY + 0.10, M.lerp(this.quayZ + 8, this.bounds.z1 - 8, i / 3), -Math.PI / 2);
      }
    }
  };

  // One ISO course plus the packing gap a stacked bank actually sits at.
  var COURSE_H = 2.605;
  var C40_HALF = 6.096;

  // Which end of the published reefer box carries the machinery.
  //
  // Rule, in order: the box's own long axis decides where the two ends ARE; an
  // end with a container jammed against it cannot be the machinery end; and of
  // the ends that are left, the one facing the open lane wins, because that is
  // the side a reefer is plugged in, serviced and read from.
  PropsHarbor.prototype._machineryEnd = function (rf) {
    var c = this._containerAt(rf.x, rf.z);
    var cx = rf.x, cz = rf.z, alongX = true, half = C40_HALF, base = this.groundY;
    if (c) {
      alongX = (c.maxx - c.minx) >= (c.maxz - c.minz);
      half = (alongX ? (c.maxx - c.minx) : (c.maxz - c.minz)) * 0.5;
      cx = (c.minx + c.maxx) * 0.5;
      cz = (c.minz + c.maxz) * 0.5;
      base = c.base;
    }
    var laneX = (this.apron.x0 + this.apron.x1) * 0.5;
    var laneZ = (this.quayZ + this.bounds.z1) * 0.5;
    var cand;
    if (alongX) {
      cand = [
        { x: cx + half + 0.06, z: cz, yaw: Math.PI / 2, d: Math.abs(cx + half - laneX) },
        { x: cx - half - 0.06, z: cz, yaw: -Math.PI / 2, d: Math.abs(cx - half - laneX) }
      ];
    } else {
      cand = [
        { x: cx, z: cz + half + 0.06, yaw: 0, d: Math.abs(cz + half - laneZ) },
        { x: cx, z: cz - half - 0.06, yaw: Math.PI, d: Math.abs(cz - half - laneZ) }
      ];
    }
    var best = null;
    for (var i = 0; i < cand.length; i++) {
      var e = cand[i];
      e.clear = !this._blocked(e.x + Math.sin(e.yaw) * 1.5, base + 1.2,
        e.z + Math.cos(e.yaw) * 1.5, 0.7);
      if (!best) { best = e; continue; }
      if (e.clear !== best.clear) { if (e.clear) best = e; continue; }
      if (e.d < best.d) best = e;
    }
    return best;
  };

  PropsHarbor.prototype._placeReefer = function (x, y, z, yaw) {
    var R = this.rng;
    if (!this.B.reefer) return;
    if (!this.B.reefer.place(x, y, z, yaw, 0, 0, 1, 1, 1, wearTint(R))) return;
    this.reefers.push({ x: x, y: y, z: z, yaw: yaw });
    this._reeferCondensate(x, y, z, yaw, true);
    this._occupy(x, z, 1.2);
  };

  // The two things a reefer stack is always missing: water coming off it, and
  // the permanent puddle under the drain.  Split out so it can be attached to
  // units this module did NOT build.
  PropsHarbor.prototype._reeferCondensate = function (x, y, z, yaw, ground) {
    var R = this.rng;
    var sy = Math.sin(yaw), cy = Math.cos(yaw);
    // The live control display - one of the few point sources at eye level
    // between the mast cones, and it reads as a machine that is switched on.
    if (this.B.display && ground) {
      this.B.display.place(x + sy * 0.28 - cy * 0.72, y + 0.38, z + cy * 0.28 + sy * 0.72,
        yaw, 0, 0, 1, 1, 1, WHITE);
    }
    var px = x + sy * 0.26 - cy * 0.20;
    var pz = z + cy * 0.26 + sy * 0.20;
    if (this.B.drip) {
      // off the drain
      for (var d = 0; d < 4; d++) {
        this.B.drip.place(px + R.range(-0.07, 0.07), y + 0.20 + R.range(0, 0.05),
          pz + R.range(-0.06, 0.06), yaw, 0, 0, 1, 1, 1, WHITE);
      }
      // and a run off the condenser hood above
      for (var d2 = 0; d2 < 4; d2++) {
        this.B.drip.place(x - cy * R.range(-0.95, 0.95) + sy * 0.26, y + 2.28,
          z + sy * R.range(-0.95, 0.95) + cy * 0.26, yaw, 0, 0, 1, 1, 1, WHITE);
      }
    }
    if (ground) this._pool(px + sy * 0.25, pz + cy * 0.25, R.range(0.45, 0.80), 0.55);
    // Shore power.  A reefer that is RUNNING has a cable on it, run out to the
    // socket rack in a slack loop - and it is the only thing in the level that
    // visibly connects one prop to another, which is what makes a bank of them
    // read as plant rather than as scenery.
    if (ground) {
      this._ropePaths = this._ropePaths || [];
      var lx = x + sy * 0.20 - cy * 1.05;
      var lz = z + cy * 0.20 + sy * 1.05;
      var run = R.range(2.6, 4.2), off = R.range(-0.7, 0.7);
      var tx = lx + sy * run - cy * off;
      var tz = lz + cy * run + sy * off;
      this._ropePaths.push({
        a: new THREE.Vector3(lx, y + 0.62, lz),
        b: new THREE.Vector3(tx, this._ground(tx, tz) + 0.05, tz),
        sag: R.range(0.35, 0.75), r: 0.030, flex: 0.10, seg: 10
      });
    }
  };

  // --------------------------------------------------------------------------
  // Dressing: infrastructure
  // --------------------------------------------------------------------------
  PropsHarbor.prototype._dressInfrastructure = function () {
    // ---- light masts --------------------------------------------------------
    // Down BOTH flanks of the apron on a long pitch, so the level reads as a
    // corridor of light pools with genuine darkness between them, and one on
    // the quay so the water edge is lit from the land side.
    //
    // Skipped entirely when the level published practicalLights: it then built
    // its own masts to hang them on, and the whole point of a mast is to be
    // where the lamp is.  Where we DO build them, the head positions are
    // published back so lighting.js can hang the lamps.  Either way the FOOT of
    // every mast gets its junction box and its puddle, because that is prop
    // work and nobody else does it.
    if (this.own.masts) this._dressMasts();
    else this._dressMastFeet();
    this._dressLightPools();
    this._dressInfraRest();
  };

  // Standing water in the GROUND FOOTPRINT of every published light shaft.
  //
  // level.lightShafts publishes twelve cones - ten mast heads, the crane flood
  // and the warehouse roof hole - as {origin, dir, width, length}.  Nothing in
  // this module drew them, and nothing needed to: what props can do with that
  // anchor is put a black mirror exactly where each cone lands, which is the
  // difference between a cone hanging in the air and a POOL OF LIGHT ON THE
  // DECK.  It is also the only puddle placement in the file that is guaranteed
  // to be somewhere the camera is looking, because a lamp is what the eye goes
  // to in a night frame.
  //
  // These are "motivated" pools in the sense the debris pass means it - made by
  // a fixture, not scattered over the apron - so they are placed whether or not
  // the level runs its own puddle system.
  PropsHarbor.prototype._dressLightPools = function () {
    var sh = this.shafts;
    if (!sh || !sh.length) return;
    var R = this.rng;
    for (var i = 0; i < sh.length; i++) {
      var s = sh[i];
      var w = M.clamp(s.w, 1.6, 6.0);
      var indoor = this._indoor(s.x, s.z, 0.4);
      // The big one under the cone, then two satellites inside the pool of
      // light so the wet ground reads as broken standing water rather than one
      // suspiciously circular mirror.
      this._pool(s.x + R.range(-0.35, 0.35), s.z + R.range(-0.35, 0.35),
        w * R.range(0.42, 0.62), 1.0, indoor);
      for (var k = 0; k < 2; k++) {
        var a = R.range(0, M.TAU);
        var d = w * R.range(0.45, 0.95);
        this._pool(s.x + Math.cos(a) * d, s.z + Math.sin(a) * d,
          w * R.range(0.22, 0.40), 0, indoor);
      }
      // Something with an edge standing in the lit patch, so the pool has a
      // silhouette to reflect instead of reflecting empty sky.
      if (s.kind === 'mast' && R.bool(0.55)) {
        var ca = R.range(0, M.TAU);
        var cx = s.x + Math.cos(ca) * (w * 0.75 + 0.7);
        var cz = s.z + Math.sin(ca) * (w * 0.75 + 0.7);
        if (this.B.cone && this._freeSpot(cx, cz, 0.35, 0.2, indoor)) {
          var cy = this._ground(cx, cz);
          if (this.B.cone.place(cx, cy, cz, R.range(0, M.TAU),
            R.gaussian(0, 0.05), R.gaussian(0, 0.05), 1, 1, 1, wearTint(R))) {
            this.B.coneBand.place(cx, cy + 0.30, cz, 0, 0, 0, 1, 1, 1, WHITE);
            this._occupy(cx, cz, 0.5);
          }
        }
      }
    }
  };

  PropsHarbor.prototype._dressMasts = function () {
    var R = this.rng, b = this.bounds;
    var ac = (this.apron.x0 + this.apron.x1) * 0.5;
    var pitch = Math.max(18, (b.z1 - this.quayZ) / 3.2);
    var lanes = [this.apron.x0 - 2.2, this.apron.x1 + 2.2];
    for (var l = 0; l < lanes.length; l++) {
      for (var k = 0; k < 3; k++) {
        var mx = M.clamp(lanes[l] + R.range(-0.6, 0.6), b.x0 + 2.5, b.x1 - 2.5);
        var mz = this.quayZ + 6 + k * pitch + R.range(-1.2, 1.2);
        if (mz > b.z1 - 4) continue;
        var my = this._ground(mx, mz);
        if (this._blocked(mx, my + 3, mz, 1.2)) continue;
        if (this._occupied(mx, mz, 2.0)) continue;
        var yaw = R.range(0, M.TAU);
        if (!this.B.lightMast.place(mx, my, mz, yaw, 0, 0, 1, 1, 1, wearTint(R))) continue;
        if (this.B.mastLens) this.B.mastLens.place(mx, my + 15.0 + 0.34, mz, yaw, 0, 0, 1, 1, 1, WHITE);
        this._occupy(mx, mz, 2.0);
        this._collider(mx, my, mz, [0.85, 1.2, 0.85], yaw, 'metal');
        // Published for lighting.js: where the lamps are, how high, which way
        // each head points.  A geometry-only mast with no lamp in it would be
        // the level's single worst prop.
        var heads = [];
        for (var h = 0; h < 4; h++) {
          var ha = h * Math.PI / 2 + 0.4 + yaw;
          heads.push(new THREE.Vector3(mx + Math.cos(ha) * 0.95, my + 15.0 + 0.30, mz + Math.sin(ha) * 0.95));
        }
        this.lightMasts.push({
          position: new THREE.Vector3(mx, my, mz), height: 15.0, yaw: yaw, heads: heads
        });
        // A junction box and a puddle at the foot of every mast.
        this._drop(this.B.junctionBox, mx + Math.cos(yaw) * 1.05, mz + Math.sin(yaw) * 1.05,
          { r: 0.35, tilt: 0.02, yaw: yaw + Math.PI, lane: false });
        this._pool(mx + R.range(-2.5, 2.5), mz + R.range(-2.5, 2.5), R.range(0.8, 1.6));
      }
    }
    // One on the quay itself.
    var qx = M.clamp(ac + R.range(-6, 6), b.x0 + 3, b.x1 - 3);
    var qy = this._ground(qx, this.quayZ + 4.5);
    if (!this._occupied(qx, this.quayZ + 4.5, 2.0)) {
      var qyaw = R.range(0, M.TAU);
      if (this.B.lightMast.place(qx, qy, this.quayZ + 4.5, qyaw, 0, 0, 1, 1, 1, wearTint(R))) {
        if (this.B.mastLens) this.B.mastLens.place(qx, qy + 15.34, this.quayZ + 4.5, qyaw, 0, 0, 1, 1, 1, WHITE);
        this._occupy(qx, this.quayZ + 4.5, 2.0);
        var qheads = [];
        for (var qh = 0; qh < 4; qh++) {
          var qa = qh * Math.PI / 2 + 0.4 + qyaw;
          qheads.push(new THREE.Vector3(qx + Math.cos(qa) * 0.95, qy + 15.30, this.quayZ + 4.5 + Math.sin(qa) * 0.95));
        }
        this.lightMasts.push({
          position: new THREE.Vector3(qx, qy, this.quayZ + 4.5), height: 15.0, yaw: qyaw, heads: qheads
        });
      }
    }
  };

  // The level built its own masts.  A mast still needs its feeder box, its
  // cable and the standing water that always collects round a foundation pad -
  // and the lamp position is published, so we know exactly where to put them.
  PropsHarbor.prototype._dressMastFeet = function () {
    var R = this.rng;
    var lights = (this.ctx.level && this.ctx.level.practicalLights) || [];
    for (var i = 0; i < lights.length; i++) {
      var L = lights[i];
      if (!L || !L.pos || !isFinite(L.pos[0])) continue;
      // Only the outdoor masts: an interior fluoro tube has no foundation.
      if (!(L.pos[1] > 5.0)) continue;
      var x = L.pos[0], z = L.pos[2];
      if (!this._inBounds(x, z, 1.5)) continue;
      var yaw = R.range(0, M.TAU);
      this._drop(this.B.junctionBox, x + Math.cos(yaw) * 1.15, z + Math.sin(yaw) * 1.15,
        { r: 0.35, tilt: 0.02, yaw: yaw + Math.PI, lane: false });
      // The standing water that always collects round a foundation pad.  The
      // cone footprint itself is handled from the published shafts in
      // _dressLightPools, which knows the cone WIDTH; this is the pad.
      this._pool(x + R.range(-2.6, 2.6), z + R.range(-2.6, 2.6), R.range(0.9, 1.8));
      // A cone or two round the base, where the yard keeps clipping it.
      if (R.bool(0.45)) {
        var cx = x + R.range(-2.2, 2.2), cz = z + R.range(-2.2, 2.2);
        if (this.B.cone.place(cx, this._ground(cx, cz), cz, R.range(0, M.TAU),
          R.gaussian(0, 0.05), R.gaussian(0, 0.05), 1, 1, 1, wearTint(R))) {
          this.B.coneBand.place(cx, this._ground(cx, cz) + 0.30, cz, 0, 0, 0, 1, 1, 1, wearTint(R));
          this._occupy(cx, cz, 0.5);
        }
      }
    }
  };

  PropsHarbor.prototype._dressInfraRest = function () {
    var R = this.rng, b = this.bounds, N = this.noise;
    var ac = (this.apron.x0 + this.apron.x1) * 0.5;
    var i;

    // ---- CCTV ---------------------------------------------------------------
    var cctvAt = [
      [b.x0 + 4, b.z1 - 5], [b.x1 - 4, b.z1 - 5],
      [ac, this.quayZ + 5], [b.x0 + 5, this.quayZ + 9], [b.x1 - 5, this.quayZ + 9]
    ];
    for (i = 0; i < cctvAt.length; i++) {
      this._drop(this.B.cctv, cctvAt[i][0], cctvAt[i][1], {
        r: 0.9, tilt: 0.008, yaw: Math.atan2(ac - cctvAt[i][0], -cctvAt[i][1]) + R.range(-0.4, 0.4),
        lane: false, collider: [0.2, 1.2, 0.2], material: 'metal'
      });
    }

    // ---- signage ------------------------------------------------------------
    // At the gate, at the quay edge and on the lane between them.  Signs face
    // the way somebody arriving would read them.
    var signAt = [
      { x: ac - 5.5, z: b.z1 - 6.5, yaw: Math.PI, face: 0 },
      { x: this.apron.x1 + 1.6, z: M.lerp(this.quayZ, b.z1, 0.55), yaw: -Math.PI / 2, face: 1 },
      { x: ac + 6.5, z: this.quayZ + 7.5, yaw: 0, face: 0 },
      { x: this.apron.x0 - 1.6, z: M.lerp(this.quayZ, b.z1, 0.30), yaw: Math.PI / 2, face: 1 },
      { x: ac + 5.0, z: b.z1 - 9.5, yaw: Math.PI, face: 1 },
      { x: this.apron.x1 + 1.8, z: this.quayZ + 12.0, yaw: -Math.PI / 2, face: 0 },
      { x: this.apron.x0 - 1.8, z: M.lerp(this.quayZ, b.z1, 0.72), yaw: Math.PI / 2, face: 0 }
    ];
    for (i = 0; i < signAt.length; i++) {
      var sg = signAt[i];
      var sy = this._drop(this.B.signFrame, sg.x, sg.z, {
        r: 0.8, clearR: 0.5, tilt: 0.012, yaw: sg.yaw, lane: false,
        collider: [1.1, 0.06, 0.08], material: 'metal'
      });
      if (sy === null) continue;
      var fb = sg.face ? this.B.signFace2 : this.B.signFace;
      if (fb) fb.place(sg.x, sy, sg.z, sg.yaw, 0, 0, 1, 1, 1, WHITE);
    }

    // ---- junction boxes and conduit runs ------------------------------------
    // Along the flanks of the container rows, where a reefer power rack lives.
    var sites = this._stackFlanks(4);
    for (i = 0; i < 10 && sites.length; i++) {
      var js = this._pickSite(sites, 0.6);
      if (!js) continue;
      this._drop(this.B.junctionBox, js.x, js.z, {
        r: 0.4, tilt: 0.02, yaw: js.yaw + Math.PI, lane: false
      });
      // conduit stub running along the ground away from it
      var cy = this._ground(js.x, js.z);
      var cg = cyl(0.030, 0.030, R.range(1.4, 3.2), 6);
      this._finishGeo(cg, 'deck_plate', { noise: N, grime: 0.5, edge: 0.2, hiY: 0.2 });
      this._static('deck', cg, Tn(js.x, cy + 0.05, js.z, 0, js.yaw + Math.PI / 2, Math.PI / 2));
    }

    // ---- hazard barriers and cones on the walking lines ---------------------
    for (i = 0; i < 8; i++) {
      var hx = ac + R.gaussian(0, 5.5);
      var hz = M.lerp(this.quayZ + 4, b.z1 - 5, R.next());
      this._drop(this.B.hazardBarrier, hx, hz, {
        r: 1.0, tilt: 0.03, yaw: R.range(0, M.TAU),
        lane: false, collider: [0.7, 0.5, 0.35], material: 'metal'
      });
    }
    // A cordon of cones round something that has been reported: an open
    // drainage cover in the middle of the apron.
    var dcx = ac + R.range(-3, 3), dcz = M.lerp(this.quayZ + 6, b.z1 - 8, R.next());
    var dcy = this._ground(dcx, dcz);
    for (i = 0; i < 5; i++) {
      var a = i * M.TAU / 5 + 0.3;
      var cx2 = dcx + Math.cos(a) * 1.5, cz2 = dcz + Math.sin(a) * 1.5;
      if (this.B.cone.place(cx2, this._ground(cx2, cz2), cz2, R.range(0, M.TAU),
        R.gaussian(0, 0.05), R.gaussian(0, 0.05), 1, 1, 1, wearTint(R))) {
        this.B.coneBand.place(cx2, this._ground(cx2, cz2) + 0.30, cz2, 0, 0, 0, 1, 1, 1, wearTint(R));
      }
    }
    // the cover itself, lifted and leaning
    var gr = box(0.62, 0.045, 0.62, 0.006);
    this._finishGeo(gr, 'steel_grate', { noise: N, grime: 0.5, edge: 0.4, hiY: 0.3 });
    this._static('grate', gr, Tn(dcx + 0.85, dcy + 0.30, dcz, 0.1, R.range(0, 3), 1.32));
    this._pool(dcx, dcz, 1.1, 1.0);

    // ---- scattered cones on the lanes ---------------------------------------
    for (i = 0; i < 26; i++) {
      var kx = ac + R.gaussian(0, 7.0);
      var kz = M.lerp(this.quayZ + 3, b.z1 - 3, R.next());
      if (!this._inBounds(kx, kz, 1)) continue;
      if (this._occupied(kx, kz, 0.6)) continue;
      var ky2 = this._ground(kx, kz);
      var knocked = R.bool(0.22);
      if (this.B.cone.place(kx, ky2 + (knocked ? 0.18 : 0), kz, R.range(0, M.TAU),
        knocked ? R.range(1.3, 1.7) : R.gaussian(0, 0.05), R.gaussian(0, 0.06),
        1, 1, 1, wearTint(R))) {
        if (!knocked) this.B.coneBand.place(kx, ky2 + 0.30, kz, 0, 0, 0, 1, 1, 1, wearTint(R));
        this._occupy(kx, kz, 0.6);
      }
    }
  };

  // --------------------------------------------------------------------------
  // Dressing: perimeter
  // --------------------------------------------------------------------------
  PropsHarbor.prototype._dressPerimeter = function () {
    var R = this.rng, b = this.bounds;
    var F = this._fence || { span: 3.0, height: 2.6 };
    var i;
    this.fenceRuns = [];
    var ac = (this.apron.x0 + this.apron.x1) * 0.5;

    // The level already has a perimeter: do not build a second one two metres
    // inside it.  The jersey chicane below is still ours - a level lays out a
    // gate, it does not lay out the traffic management inside it.
    if (!this.own.fence) { this._dressChicane(ac); return; }

    // Landward fence with a sliding gate on the apron centreline, plus short
    // returns down both flanks.  The quay end is deliberately open - you do
    // not fence a working quay off from its own ship.
    var gateHalf = 4.2;
    var zLand = b.z1 - 2.2;
    this._fenceRun(b.x0 + 1.5, zLand, ac - gateHalf, zLand, F, true);
    this._fenceRun(ac + gateHalf, zLand, b.x1 - 1.5, zLand, F, true);
    // flank returns
    this._fenceRun(b.x0 + 1.5, zLand, b.x0 + 1.5, M.lerp(this.quayZ, zLand, 0.45), F, true);
    this._fenceRun(b.x1 - 1.5, zLand, b.x1 - 1.5, M.lerp(this.quayZ, zLand, 0.45), F, true);

    // ---- the sliding gate ---------------------------------------------------
    // Open, parked to one side on its track, with the counterweight tail
    // sticking out - which is what makes a slider read as a slider.
    var gy = this._ground(ac, zLand);
    var gateW = gateHalf * 2 * 0.86;
    var track = box(gateW + 2.6, 0.06, 0.16, 0.008);
    this._finishGeo(track, 'deck_plate', { noise: this.noise, grime: 0.6, edge: 0.4, hiY: 0.1 });
    this._static('deck', track, Tn(ac - 1.2, gy + 0.03, zLand, 0, 0, 0));
    // gate frame
    var gf = K.fenceFrame(gateW, F.height, true);
    this._finishGeo(gf, 'deck_plate', { noise: this.noise, grime: 0.36, edge: 0.34, hiY: F.height });
    this._static('deck', gf, Tn(ac - gateHalf - gateW * 0.42, gy, zLand, 0, 0, 0));
    if (this.B.fenceMesh) {
      this.B.fenceMesh.place(ac - gateHalf - gateW * 0.42, gy, zLand, 0, 0, 0,
        gateW / F.span, 1, 1, wearTint(R));
    }
    // gate posts each side of the opening
    for (i = -1; i <= 1; i += 2) {
      var pg = cyl(0.09, 0.10, F.height + 0.5, 10);
      this._finishGeo(pg, 'deck_plate', { noise: this.noise, grime: 0.34, edge: 0.3, hiY: 3 });
      this._static('deck', pg, Tn(ac + i * gateHalf, gy + (F.height + 0.5) / 2, zLand, 0, 0, 0));
      this._collider(ac + i * gateHalf, gy, zLand, [0.12, 1.5, 0.12], 0, 'metal');
    }
    this.gateAt = new THREE.Vector3(ac, gy, zLand);

    this._dressChicane(ac);
  };

  // Jersey barriers: a chicane inside the gate - the standard way a terminal
  // slows a lorry down - plus short runs where the yard needed a line drawn.
  PropsHarbor.prototype._dressChicane = function (ac) {
    var R = this.rng, b = this.bounds;
    var zLand = b.z1 - 2.2;
    var i;
    var chic = [
      [ac - 3.4, zLand - 6.0, 0.06], [ac - 1.2, zLand - 6.0, 0.06],
      [ac + 1.4, zLand - 9.4, -0.05], [ac + 3.6, zLand - 9.4, -0.05],
      [ac - 3.0, zLand - 12.8, 0.03], [ac - 0.8, zLand - 12.8, 0.03]
    ];
    for (i = 0; i < chic.length; i++) {
      this._drop(this.B.jersey, chic[i][0], chic[i][1], {
        r: 1.2, clearR: 0.75, tilt: 0.012, yaw: chic[i][2] + Math.PI / 2, lane: false,
        collider: [1.05, 0.41, 0.30], material: 'concrete'
      });
    }
    var sites = this._stackFlanks(4);
    var self = this;
    this._placeMany(this.B.jersey, sites, 12,
      { r: 1.15, clearR: 0.72, tilt: 0.012, collider: [1.05, 0.41, 0.30], material: 'concrete' },
      function (js) {
        // A line of barriers, not one orphan: a jersey unit on its own reads as
        // a dropped prop, a run of three reads as traffic management.
        var run = R.int(1, 3);
        for (var k = 1; k <= run; k++) {
          var jx = js.x + Math.cos(js.yaw + Math.PI / 2) * k * 2.25;
          var jz = js.z + Math.sin(js.yaw + Math.PI / 2) * k * 2.25;
          self._drop(self.B.jersey, jx, jz, {
            r: 1.05, clearR: 0.72, tilt: 0.012, yaw: js.yaw, lane: false,
            collider: [1.05, 0.41, 0.30], material: 'concrete'
          });
        }
      });
  };

  // Lay a run of fence bays between two points, following the ground.
  PropsHarbor.prototype._fenceRun = function (x0, z0, x1, z1, F, barb) {
    var R = this.rng;
    var dx = x1 - x0, dz = z1 - z0;
    var len = Math.sqrt(dx * dx + dz * dz);
    if (!(len > F.span)) return;
    var n = Math.max(1, Math.round(len / F.span));
    var yaw = Math.atan2(dx, dz) + Math.PI / 2;
    var run = { x0: x0, z0: z0, x1: x1, z1: z1, yaw: yaw, bays: [] };
    for (var i = 0; i < n; i++) {
      var t = (i + 0.5) / n;
      var bx = x0 + dx * t, bz = z0 + dz * t;
      var by = this._ground(bx, bz);
      // A run that has been hit: two bays out of every twenty are bowed.
      var hit = R.bool(0.10);
      var tilt = hit ? R.range(0.05, 0.13) : R.gaussian(0, 0.016);
      if (!this.B.fenceFrame.place(bx, by, bz, yaw, 0, tilt, len / n / F.span, 1, 1, wearTint(R))) break;
      var mesh = hit && this.B.fenceMeshSag && this.B.fenceMeshSag.n < this.B.fenceMeshSag.max
        ? this.B.fenceMeshSag : this.B.fenceMesh;
      mesh.place(bx, by, bz, yaw, 0, tilt, len / n / F.span, 1, 1, wearTint(R));
      if (barb && this.B.barbs) {
        this.B.barbs.place(bx, by, bz, yaw, 0, tilt, len / n / F.span, 1, 1, wearTint(R));
      }
      this._collider(bx, by, bz,
        [Math.abs(Math.cos(yaw)) * F.span * 0.5 + 0.06, F.height * 0.5,
         Math.abs(Math.sin(yaw)) * F.span * 0.5 + 0.06], 0, 'metal');
      this._occupy(bx, bz, 0.7);
      run.bays.push({ x: bx, y: by, z: bz, yaw: yaw, hit: hit });
    }
    this.fenceRuns.push(run);
  };

  // --------------------------------------------------------------------------
  // Dressing: the spill from the toppled container
  //
  // Cargo does not fall out of a box in a tidy heap.  It leaves a fan whose
  // axis is the direction the box went over, densest at the mouth, thinning
  // out, with the strapping that was holding it still attached to the
  // doorframe.
  // --------------------------------------------------------------------------
  PropsHarbor.prototype._dressSpill = function () {
    var R = this.rng, N = this.noise;
    var src = this.toppled;
    var ox, oz, axis;
    // Prefer the level's own published spill point over our collider-shape
    // guess: level_harbor.js states where it toppled the box and which way it
    // fell, and its BIG items - bales, drums - are already lying in that fan
    // with colliders on them.  Ours is the small debris that goes between and
    // beyond them, and every placement below is rejected if it would land
    // inside something that is already there.
    var lt = this.toppledAt;
    if (lt) {
      // the level's fan runs along (cos yaw, sin yaw); ours along (sin a, cos a)
      var lyaw = (lt.yaw === undefined ? 0 : lt.yaw);
      axis = Math.atan2(Math.cos(lyaw), Math.sin(lyaw));
      ox = lt.x + Math.cos(lyaw) * 6.4;
      oz = lt.z + Math.sin(lyaw) * 6.4;
    } else if (src) {
      ox = src.x; oz = src.z;
      // fan out along the box's long axis, away from the centre of the yard
      var lx = src.maxx - src.minx, lz = src.maxz - src.minz;
      axis = (lx > lz) ? (src.x > (this.bounds.x0 + this.bounds.x1) * 0.5 ? 0 : Math.PI)
                       : (src.z > (this.quayZ + this.bounds.z1) * 0.5 ? Math.PI / 2 : -Math.PI / 2);
      ox += Math.sin(axis) * (Math.max(lx, lz) * 0.5 + 1.2);
      oz += Math.cos(axis) * (Math.max(lx, lz) * 0.5 + 1.2);
    } else {
      // No toppled box published: put the spill somewhere it still reads, at
      // the edge of the apron where a box would have been dropped.
      ox = M.clamp((this.apron.x0 + this.apron.x1) * 0.5 + R.range(6, 10),
        this.bounds.x0 + 6, this.bounds.x1 - 6);
      oz = M.lerp(this.quayZ + 8, this.bounds.z1 - 10, 0.45);
      axis = R.range(0, M.TAU);
    }
    if (!this._inBounds(ox, oz, 3)) return;
    this.spillAt = new THREE.Vector3(ox, this._ground(ox, oz), oz);

    var fanW = 0.55;
    var i;
    // bales, densest near the mouth
    for (i = 0; i < 14; i++) {
      var t = Math.pow(R.next(), 0.6);
      var d = 0.6 + t * 7.5;
      var off = R.gaussian(0, fanW * d * 0.5);
      var bx = ox + Math.sin(axis) * d + Math.cos(axis) * off;
      var bz = oz + Math.cos(axis) * d - Math.sin(axis) * off;
      if (!this._freeSpot(bx, bz, 0.62, 0.45)) continue;
      var by = this._ground(bx, bz);
      var tumbled = R.bool(0.6);
      this.B.bale.place(bx, by + (tumbled ? 0.30 : 0), bz,
        R.range(0, M.TAU), tumbled ? R.range(1.2, 1.9) : R.gaussian(0, 0.10),
        R.gaussian(0, 0.35), R.range(0.9, 1.1), R.range(0.9, 1.1), R.range(0.9, 1.1),
        wearTint(R));
      this._occupy(bx, bz, 0.6);
    }
    // burst crates and loose timber
    for (i = 0; i < 9; i++) {
      var t2 = Math.pow(R.next(), 0.7);
      var d2 = 0.8 + t2 * 8.0;
      var off2 = R.gaussian(0, fanW * d2 * 0.55);
      var cx = ox + Math.sin(axis) * d2 + Math.cos(axis) * off2;
      var cz = oz + Math.cos(axis) * d2 - Math.sin(axis) * off2;
      if (!this._freeSpot(cx, cz, 0.68, 0.45)) continue;
      var cy = this._ground(cx, cz);
      this.B.crateBroken.place(cx, cy + R.range(0, 0.25), cz,
        R.range(0, M.TAU), R.range(-0.9, 0.9), R.range(-0.9, 0.9), 1, 1, 1, wearTint(R));
      this._occupy(cx, cz, 0.7);
    }
    for (i = 0; i < 16; i++) {
      var d3 = 0.5 + Math.pow(R.next(), 0.5) * 9.0;
      var off3 = R.gaussian(0, fanW * d3 * 0.6);
      var dx = ox + Math.sin(axis) * d3 + Math.cos(axis) * off3;
      var dz = oz + Math.cos(axis) * d3 - Math.sin(axis) * off3;
      if (!this._freeSpot(dx, dz, 0.28, 0.15)) continue;
      this.B.dunnage.place(dx, this._ground(dx, dz) + R.range(0, 0.06), dz,
        R.range(0, M.TAU), R.gaussian(0, 0.06), R.gaussian(0, 0.06),
        R.range(0.55, 1.2), 1, 1, wearTint(R));
    }
    // strapping still attached to the doorframe, whipping in the wind
    this._ropePaths = this._ropePaths || [];
    for (i = 0; i < 4; i++) {
      var sy = this._ground(ox, oz);
      var ex = ox + Math.sin(axis) * R.range(1.6, 3.4) + Math.cos(axis) * R.range(-1.6, 1.6);
      var ez = oz + Math.cos(axis) * R.range(1.6, 3.4) - Math.sin(axis) * R.range(-1.6, 1.6);
      this._ropePaths.push({
        a: new THREE.Vector3(ox - Math.sin(axis) * 0.8, sy + R.range(0.9, 2.1), oz - Math.cos(axis) * 0.8),
        b: new THREE.Vector3(ex, sy + 0.03, ez),
        sag: R.range(0.25, 0.6), r: 0.016, flex: 1.0, seg: 10
      });
    }
    // a cargo net dragged clear of the mouth
    if (this.B.net) {
      var ny = this._ground(ox, oz);
      this.B.net.place(ox + Math.cos(axis) * 1.9, ny + 2.05, oz - Math.sin(axis) * 1.9,
        axis + R.range(-0.4, 0.4), 0, 0, 1, 1, 1, wearTint(R));
    }
    // and the fluid that came out with it
    this._oilSlick(ox + R.range(-1.5, 1.5), oz + R.range(-1.5, 1.5), R.range(1.4, 2.4));
  };

  // --------------------------------------------------------------------------
  // Dressing: water, oil, litter, weed
  // --------------------------------------------------------------------------

  // Standing water.  A pool is a MESH, not a decal: it needs a real specular
  // response and a scrolling ripple normal, because the whole level is built on
  // the reflection of the lamps in it.
  PropsHarbor.prototype._pool = function (x, z, r, depthMul, indoor) {
    if (!this._inBounds(x, z, 0.5, indoor)) return;
    if (this._poolCount === undefined) this._poolCount = 0;
    if (this._poolCount >= 92) return;
    var y = this._ground(x, z);
    // A pool is a film on the deck, not a volume: testing it with a sphere half
    // its own radius rejected every puddle wider than about a metre and a half
    // anywhere near a container flank, which is exactly where water collects.
    if (this._blocked(x, y + 0.22, z, Math.min(r * 0.45, 0.55))) return;
    var g = K.pool(r, this.noise, this._poolCount, this.rng.range(0.6, 1.0));
    if (!g) return;
    this._poolParts = this._poolParts || [];
    this._poolParts.push(part(g, Tn(x, y + 0.012 + (depthMul ? 0.002 : 0), z, 0, this.rng.range(0, M.TAU), 0)));
    this._poolCount++;
  };

  // Standing water at an EXPLICIT height - a roof pan, a deck, a ledge - rather
  // than on the ground the raycast finds.  Same mesh, same material.
  PropsHarbor.prototype._poolAt = function (x, y, z, r) {
    if (this._poolCount === undefined) this._poolCount = 0;
    if (this._poolCount >= 92) return;
    var g = K.pool(r, this.noise, this._poolCount, this.rng.range(0.6, 1.0));
    if (!g) return;
    this._poolParts = this._poolParts || [];
    this._poolParts.push(part(g, Tn(x, y + 0.012, z, 0, this.rng.range(0, M.TAU), 0)));
    this._poolCount++;
  };

  // A fuel/hydraulic slick.  Sits ON the water film, so it goes a hair higher.
  PropsHarbor.prototype._oilSlick = function (x, z, r, indoor) {
    if (!this._inBounds(x, z, 0.5, indoor)) return;
    if (this._oilCount === undefined) this._oilCount = 0;
    if (this._oilCount >= 22) return;
    var y = this._ground(x, z);
    if (this._blocked(x, y + 0.22, z, Math.min(r * 0.4, 0.5))) return;
    var g = K.pool(r, this.noise, 40 + this._oilCount, this.rng.range(0.5, 1.1));
    if (!g) return;
    this._oilParts = this._oilParts || [];
    this._oilParts.push(part(g, Tn(x, y + 0.018, z, 0, this.rng.range(0, M.TAU), 0)));
    this._oilCount++;
  };

  // A painted keep-clear box, worn through by tyres along its long edges.
  PropsHarbor.prototype._keepClear = function (x, z, hw, hd, yaw) {
    var y = this._ground(x, z);
    var t = 0.10;
    var parts = [
      [0, hd, hw * 2 + t, t], [0, -hd, hw * 2 + t, t],
      [hw, 0, t, hd * 2], [-hw, 0, t, hd * 2]
    ];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var g = new THREE.PlaneGeometry(p[2], p[3]);
      g.rotateX(-Math.PI / 2);
      _va.set(p[0], 0, p[1]).applyAxisAngle(UP, yaw);
      this._static('line', g, Tn(x + _va.x, y + 0.014, z + _va.z, 0, yaw, 0));
    }
    // diagonal hatching inside it
    for (var d = -3; d <= 3; d++) {
      var hg = new THREE.PlaneGeometry(0.09, hd * 2.6);
      hg.rotateX(-Math.PI / 2);
      _vb.set(d * (hw / 3.2), 0, 0).applyAxisAngle(UP, yaw);
      this._static('line', hg, Tn(x + _vb.x, y + 0.013, z + _vb.z, 0, yaw + 0.62, 0));
    }
  };

  // Litter, placed by simulating what actually happened to it.
  //
  // The wind is a vector, not a mood: everything loose in this yard has been
  // pushed the same way for two days and has piled against the first thing that
  // stopped it.  So rather than guessing where the obstacles are - the fence,
  // a container flank, a jersey barrier, the wheel of a bowser - each scrap is
  // seeded on the apron and MARCHED downwind until the broadphase says it hit
  // something, then pinned to that face.  It costs a few hundred sphere queries
  // at build time and it is completely level-agnostic: whatever the level put
  // in the way is what catches the rubbish, which is the whole point.
  PropsHarbor.prototype._driftLitter = function (count) {
    var R = this.rng, b = this.bounds;
    var placed = 0, tries = 0;
    var wx = this.windDir.x, wz = this.windDir.y;
    var wl = Math.sqrt(wx * wx + wz * wz) || 1;
    wx /= wl; wz /= wl;
    while (placed < count && tries < count * 6) {
      tries++;
      // Seed upwind of the yard so a scrap can travel right across it.
      var x = R.range(b.x0 + 2, b.x1 - 2);
      var z = R.range(this.quayZ + 1, b.z1 - 2);
      var y = this.groundY;
      var hit = false, hx = x, hz = z, nx = 0, nz = 0;
      // Wander as it travels: rubbish does not roll in a straight line.
      var driftA = R.gaussian(0, 0.22);
      var dx = wx * Math.cos(driftA) - wz * Math.sin(driftA);
      var dz = wx * Math.sin(driftA) + wz * Math.cos(driftA);
      for (var s = 0; s < 70; s++) {
        var px = x + dx * s * 0.4, pz = z + dz * s * 0.4;
        if (!this._inBounds(px, pz, 0.3)) break;
        y = this._ground(px, pz);
        if (this._blocked(px, y + 0.45, pz, 0.22)) {
          hit = true;
          hx = px - dx * 0.28; hz = pz - dz * 0.28;
          nx = -dx; nz = -dz;
          break;
        }
      }
      if (!hit) continue;
      var bt = this.B['litter' + R.int(0, 3)];
      if (!bt) break;
      // Most of it is pinned low; a little has blown up whatever caught it.
      var h = Math.pow(R.next(), 2.3) * 1.25 + 0.025;
      var yawTo = Math.atan2(nx, nz);
      var gy = this._ground(hx, hz);
      if (bt.place(hx + R.range(-0.18, 0.18), gy + h, hz + R.range(-0.18, 0.18),
        yawTo + R.range(-0.55, 0.55),
        // scraps on the ground lie flat; scraps up the mesh stand against it
        h < 0.10 ? Math.PI / 2 + R.range(-0.4, 0.4) : R.range(-0.5, 0.5),
        R.range(-0.8, 0.8),
        R.range(0.7, 1.45), R.range(0.7, 1.45), 1, wearTint(R))) placed++;
    }
    this.stats.litter = placed;
  };

  PropsHarbor.prototype._dressDebris = function () {
    var R = this.rng, b = this.bounds;
    var i;

    this._driftLitter(150);

    // ---- seaweed and scum at the quay lip -----------------------------------
    if (this.quayLine && this.B.weed) {
      var q = this.quayLine;
      var n = Math.floor((q.x1 - q.x0) / 0.55);
      for (i = 0; i < n; i++) {
        var wx = q.x0 + (i + 0.5) * (q.x1 - q.x0) / n + R.range(-0.16, 0.16);
        var wz = q.z + R.range(0.02, 0.30);
        var wy = this._ground(wx, wz + 0.5);
        // thicker where the tide sets it, thinner elsewhere
        var dens = 0.35 + 0.65 * (this.noise.fbm2(wx * 0.18, 3.1, 3, 2.1, 0.55) * 0.5 + 0.5);
        if (R.next() > dens) continue;
        this.B.weed.place(wx, wy - R.range(0.02, 0.12), wz,
          R.range(0, M.TAU), R.range(-0.35, 0.15), R.range(-0.25, 0.25),
          R.range(0.7, 1.5), R.range(0.6, 1.3), 1, wearTint(R));
      }
    }
    // Weed and scum also grow in the corners the yard never sweeps.
    for (i = 0; i < 26; i++) {
      var gx = R.range(b.x0 + 2, b.x1 - 2);
      var gz = R.range(this.quayZ + 2, b.z1 - 2);
      if (!this._laneClear(gx, gz, 0.5, true)) continue;
      // only against something: sample four directions for a wall
      if (!this._blocked(gx + 0.8, this.groundY + 0.4, gz, 0.5) &&
          !this._blocked(gx - 0.8, this.groundY + 0.4, gz, 0.5) &&
          !this._blocked(gx, this.groundY + 0.4, gz + 0.8, 0.5) &&
          !this._blocked(gx, this.groundY + 0.4, gz - 0.8, 0.5)) continue;
      if (!this.B.weed) break;
      this.B.weed.place(gx, this._ground(gx, gz) - 0.04, gz,
        R.range(0, M.TAU), R.range(-0.2, 0.1), 0,
        R.range(0.5, 0.9), R.range(0.4, 0.8), 1, wearTint(R));
    }

    // ---- standing water in the low spots ------------------------------------
    // Water finds the camber.  Without a published height field the best proxy
    // is "away from the crown of the apron and near something that blocks the
    // run-off", which is where puddles really are.
    //
    // Skipped when the level runs its own puddle system: two uncorrelated sets
    // of standing water on one apron is worse than either alone.  The motivated
    // pools - under a reefer drain, at a mast foot, beside a stack, in the
    // foreground of a published framing - are placed regardless, because those
    // are made by a PROP and no level can know about them.
    if (!this.own.puddles) return;
    for (i = 0; i < 34; i++) {
      var px = R.range(b.x0 + 2, b.x1 - 2);
      var pz = R.range(this.quayZ + 1.5, b.z1 - 2);
      var bias = this.noise.fbm2(px * 0.09, pz * 0.09, 3, 2.2, 0.55);
      if (bias < 0.02) continue;                 // only the low half of the field
      this._pool(px, pz, R.range(0.7, 2.3));
    }
    // and always a long one along the quay edge, where the apron falls to the sea
    if (this.quayLine) {
      for (i = 0; i < 7; i++) {
        var qx2 = M.lerp(this.quayLine.x0, this.quayLine.x1, (i + 0.5) / 7) + R.range(-1.5, 1.5);
        this._pool(qx2, this.quayZ + R.range(2.2, 4.0), R.range(1.2, 2.6));
      }
    }
  };

  // --------------------------------------------------------------------------
  // Dressing: life
  // --------------------------------------------------------------------------
  PropsHarbor.prototype._dressLife = function () {
    var R = this.rng;
    if (!this.B.gull) return;
    var i, k;
    // Gulls face into the wind, all of them.  A flock where every bird faces a
    // different way is the tell that they were placed rather than observed.
    var into = Math.atan2(-this.windDir.x, -this.windDir.y);

    // Candidate perches, gathered from everything in the level a bird would
    // actually stand on rather than from the one list that happened to be to
    // hand.  The previous pass had exactly two sources - our own bollards and
    // our own rail posts - and on a level that owns both it produced five
    // birds, all in a line along the quay, none of them in any framing but one.
    var perch = [];
    function add(x, y, z, w) { perch.push({ x: x, y: y, z: z, w: w }); }

    var bl = this.bollards || [];
    for (i = 0; i < bl.length; i++) {
      // perchY is the measured top of the casting, not head height plus a guess
      add(bl[i].x, bl[i].perchY === undefined ? bl[i].y + 0.94 : bl[i].perchY, bl[i].z, 1.0);
    }
    var posts = this._railPosts || [];
    for (i = 0; i < posts.length; i++) {
      if (posts[i]) add(posts[i].x, posts[i].y + 1.09, posts[i].z, 0.45);
    }
    // Container tops, but only the LOW courses: a gull silhouetted on a box a
    // player can see the top of reads; one on a stack four high is three pixels
    // of noise against the cloud.
    for (i = 0; i < this.containers.length; i++) {
      var c = this.containers[i];
      if (c.toppled) continue;
      var h = c.top - this.groundY;
      if (h < 1.6 || h > 5.6) continue;
      var alongX = (c.maxx - c.minx) > (c.maxz - c.minz);
      for (k = 0; k < 2; k++) {
        var t = 0.16 + k * 0.68;
        add(alongX ? M.lerp(c.minx, c.maxx, t) : (c.minx + c.maxx) * 0.5,
          c.top + 0.02,
          alongX ? (c.minz + c.maxz) * 0.5 : M.lerp(c.minz, c.maxz, t), 0.85);
      }
    }
    // And on our own big flat things.
    if (this.spreaderAt) add(this.spreaderAt.x, this.spreaderAt.y + 1.40, this.spreaderAt.z, 0.9);
    if (this.bowserAt) add(this.bowserAt.x, this.bowserAt.y + 1.92, this.bowserAt.z, 0.7);
    if (this.tractorAt) add(this.tractorAt.x, this.tractorAt.y + 2.36, this.tractorAt.z, 0.6);

    // Weight by how visible they are: a bird nobody photographs is triangles
    // spent on nothing, so perches near a published framing win.
    // Eye-level framings only.  Weighting perches toward the OVERVIEW put a
    // line of birds 23 m below a 23 m lens, where a gull is four pixels of dark
    // dash and reads as a dead sprite rather than as life.
    var poses = this.poses, keys = ['quay', 'containers', 'crane', 'gangway'];
    for (i = 0; i < perch.length; i++) {
      var best = 1e9;
      if (poses) {
        for (k = 0; k < keys.length; k++) {
          var p = poses[keys[k]];
          if (!p || !p.position) continue;
          var dx = perch[i].x - p.position.x, dz = perch[i].z - p.position.z;
          var d = Math.sqrt(dx * dx + dz * dz);
          if (d < best) best = d;
        }
      }
      // 8-30 m is the band a gull reads in; closer is a bird in your face.
      var vis = best > 900 ? 0.4 : M.saturate(1 - Math.abs(best - 17) / 26);
      perch[i].score = perch[i].w * (0.35 + 0.95 * vis) * R.range(0.7, 1.3);
    }
    perch.sort(function (a, b) { return b.score - a.score; });

    var want = Math.min(22, perch.length);
    for (i = 0; i < perch.length && this.gulls.length < want; i++) {
      var e = perch[i];
      // never two on the same spot
      var clash = false;
      for (k = 0; k < this.gulls.length; k++) {
        var gx = this.gulls[k].x - e.x, gz = this.gulls[k].z - e.z;
        var gy2 = this.gulls[k].y - e.y;
        if (gx * gx + gz * gz < 0.55 * 0.55 && Math.abs(gy2) < 0.6) { clash = true; break; }
      }
      if (clash) continue;
      this.gulls.push({
        x: e.x + R.range(-0.18, 0.18), y: e.y, z: e.z + R.range(-0.14, 0.14),
        yaw: into + R.gaussian(0, 0.24), scale: R.range(0.86, 1.16),
        pitch: R.gaussian(0, 0.07), roll: R.gaussian(0, 0.06),
        phase: R.range(0, M.TAU)
      });
    }
    // Two birds working the gale over the quay, banked hard.  Two, at very
    // different altitudes and very different attitudes - a row of six identical
    // dashes at one height is the tell that they were placed rather than seen.
    var qz = this.quayZ, ac = (this.apron.x0 + this.apron.x1) * 0.5;
    for (i = 0; i < 2; i++) {
      var ax = ac + R.range(-16, 16), az = qz + R.range(1, 14);
      this.gulls.push({
        x: ax, y: this._ground(ax, az) + (i ? R.range(16, 25) : R.range(8, 13)), z: az,
        yaw: into + R.gaussian(0, 0.9), scale: R.range(1.0, 1.25),
        pitch: R.range(-0.18, 0.10),
        roll: (i ? 1 : -1) * R.range(0.26, 0.70),        // 15-40 degrees of bank
        phase: R.range(0, M.TAU), air: true
      });
    }
    for (i = 0; i < this.gulls.length; i++) {
      var gg = this.gulls[i];
      this.B.gull.place(gg.x, gg.y, gg.z, gg.yaw, gg.pitch, gg.roll,
        gg.scale, gg.scale, gg.scale, wearTint(R));
    }
    this._gullBase = this.gulls.slice();
  };

  // --------------------------------------------------------------------------
  // Dressing: camera framings
  //
  // Runs last so it can see what is already there.  For every framing the level
  // published, check whether the near third of the shot has anything in it and
  // drop a foreground mass if it does not.  A strong foreground is what makes a
  // frame read as a shot rather than a survey photograph, and it is the one
  // composition rule a procedural dressing pass can actually enforce.
  // --------------------------------------------------------------------------
  // How far abreast of a point one can go before running into something, in
  // the given direction, capped at maxLat.
  //
  // This is the whole fix for the `containers` framing.  The offsets used to be
  // a fixed table - 2.2 m, 2.5 m, 3.0 m of lateral - which is fine on an open
  // apron and useless in a container canyon: that framing stands in a corridor
  // 3.8 m wide, so every candidate was inside a steel wall, every one was
  // rejected, and the hero shot of the level got no foreground and no
  // foreground puddle at all.  Measuring the room instead of assuming it makes
  // the same code work in a corridor and on the quay.
  PropsHarbor.prototype._freeLateral = function (x, z, dx, dz, maxLat) {
    var step = 0.35, last = 0;
    for (var t = step; t <= maxLat; t += step) {
      if (this._blocked(x + dx * t, this._ground(x + dx * t, z + dz * t) + 0.85,
        z + dz * t, 0.34)) return last;
      if (!this._inBounds(x + dx * t, z + dz * t, 0.2, true)) return last;
      last = t;
    }
    return maxLat;
  };

  // Is (x,z) clear of every published sightline?
  //
  // Anything this pass adds as MASS has to be provably unable to stand in front
  // of a hero framing's subject, or "fill the establishing shot" turns into
  // "block the other five".  A point is rejected if it is inside a corridor of
  // half-width `halfW` running along any pose's forward axis for `maxT` metres.
  PropsHarbor.prototype._poseSightlineClear = function (x, z, halfW, maxT, except) {
    var poses = this.poses;
    if (!poses) return true;
    var keys = ['quay', 'containers', 'warehouse', 'crane', 'gangway', 'overview'];
    for (var i = 0; i < keys.length; i++) {
      var p = poses[keys[i]];
      if (!p || !p.position) continue;
      var dx = x - p.position.x, dz = z - p.position.z;
      if (dx * dx + dz * dz < 64) return false;             // never within 8 m of a lens
      if (keys[i] === except) continue;
      var yaw = p.yaw || 0;
      var fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      var t = dx * fx + dz * fz;
      if (t < 0 || t > maxT) continue;
      var lat = Math.abs(dx * Math.cos(yaw) - dz * Math.sin(yaw));
      if (lat < halfW) return false;
    }
    return true;
  };

  // Silhouette-only container mass for the establishing shot.
  //
  // harbor_overview reads as fifteen boxes in an orange haze because the whole
  // south-west third of the yard - which is what the frame's mid-ground
  // actually is - is bare apron.  An establishing shot is bought with MASS, and
  // the cheapest possible way to say "terminal" rather than "car park" is more
  // boxes on the skyline.  These carry no door hardware and no corner castings
  // because nothing ever gets closer than twenty-five metres to them: the
  // placement rejects any cell within 8 m of a lens or inside any published
  // sightline, so they cannot appear in - or block - one of the other five
  // framings.  Three merged draws, no instancing, and they take colliders so
  // the player cannot walk through them.
  PropsHarbor.prototype._dressHorizonFill = function () {
    var p = this.poses && this.poses.overview;
    if (!p || !p.position) return;
    var R = this.rng;
    var CW = 2.438, CH = 2.591, CL = 12.192;
    var keys = ['hznRed', 'hznBlue', 'hznGreen'];
    var yaw0 = p.yaw || 0;
    var fx = -Math.sin(yaw0), fz = -Math.cos(yaw0);
    var rx = Math.cos(yaw0), rz = -Math.sin(yaw0);
    // Never in the apron: that lane is the level's main sightline and the mark
    // the player spawns looking up.
    var ac = (this.apron.x0 + this.apron.x1) * 0.5;
    var ah = Math.abs(this.apron.x1 - this.apron.x0) * 0.5 + 2.5;
    // A GRID SWEEP of the whole yard, not a march down the overview axis.
    //
    // Marching the axis was the obvious reading of "fill the horizon" and it is
    // the wrong one twice over: on the axis a four-high block is twenty degrees
    // of frame and OCCLUDES the terminal it was added to describe, and off the
    // axis the cells it reaches happen to be the quay and the apron, so it
    // placed nothing at all.  Sweeping instead finds whatever dead ground the
    // yard actually has, and every wide framing gets the benefit rather than
    // one.  Every cell must clear the apron, every published sightline and a
    // 12 m radius round every lens, so none of this can block a shot.
    var built = 0, blocks = 0, t, s;
    var b = this.bounds;
    var nx = 9, nz = 8;
    for (t = 0; t < nx && blocks < 6; t++) {
      for (s = 0; s < nz && blocks < 6; s++) {
        var x = M.lerp(b.x0 + 9, b.x1 - 9, (t + 0.5) / nx) + R.range(-2, 2);
        var z = M.lerp(this.quayZ + 10, b.z1 - 9, (s + 0.5) / nz) + R.range(-2, 2);
        if (Math.abs(x - ac) < ah) continue;
        if (!this._inBounds(x, z, 8.0)) continue;
        if (this._occupied(x, z, 8.0)) continue;
        if (!this._poseSightlineClear(x, z, 10.0, 60)) continue;
        var y = this._ground(x, z);
        if (this._blocked(x, y + 3.4, z, 7.0)) continue;
        // Align the block to the level's own grid rather than to the camera:
        // the west block stows fore-and-aft, the east block athwartships.
        var yaw = (x < ac) ? Math.PI / 2 : 0;
        var ux = Math.sin(yaw + Math.PI / 2), uz = Math.cos(yaw + Math.PI / 2);
        // Two or three courses.  Four is a wall; two is a horizon.
        var high = R.int(2, 3);
        for (var row = 0; row < 2; row++) {
          var bx = x + ux * row * (CW + 0.06), bz = z + uz * row * (CW + 0.06);
          var hi = Math.max(2, high - row);
          for (var c = 0; c < hi; c++) {
            this._static(keys[R.int(0, 2)], box(CL - 0.02, CH - 0.02, CW - 0.02, 0.03),
              Tn(bx, y + CH * 0.5 + c * (CH + 0.012), bz, 0, yaw + R.gaussian(0, 0.012), 0));
            built++;
          }
        }
        var lx = Math.abs(Math.cos(yaw)) * CL * 0.5 + Math.abs(Math.sin(yaw)) * (CW + 0.06);
        var lz = Math.abs(Math.sin(yaw)) * CL * 0.5 + Math.abs(Math.cos(yaw)) * (CW + 0.06);
        this._occupy(x + ux * (CW * 0.5), z + uz * (CW * 0.5), 7.5);
        this._collider(x + ux * (CW * 0.5), y, z + uz * (CW * 0.5),
          [lx, high * CH * 0.5, lz], 0, 'metal');
        blocks++;
      }
    }
    this.stats.horizon = built;
  };

  PropsHarbor.prototype._dressCameraPoses = function () {
    var poses = this.poses;
    if (!poses) return;
    var R = this.rng;
    this._dressHorizonFill();
    var keys = ['quay', 'containers', 'warehouse', 'crane', 'gangway', 'overview'];
    // Distances only - the lateral offset is MEASURED per candidate, above.
    // Nothing nearer than four metres: a 2.5 m pallet stack at 2.4 m from a
    // 1.7 m eye is not a foreground, it is a wall, and the near plane of the
    // depth of field turns it into a brown smear.
    var CAND = [4.2, 5.4, 3.6, 6.6, 8.0, 3.2];
    // From a 23 m standpoint the near lens is BARE GROUND - a prop at 4 m is
    // twenty metres below the camera and out of frame.  The overview buys its
    // read at fifteen to forty-five metres, and it needs six masses, not two.
    var OVER_CAND = [15, 21, 27, 33, 39, 45];
    for (var i = 0; i < keys.length; i++) {
      var p = poses[keys[i]];
      if (!p || !p.position) continue;
      var over = keys[i] === 'overview';
      var inside = this._indoor(p.position.x, p.position.z, 0.6);
      var yaw = p.yaw || 0;
      var fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      var rx = Math.cos(yaw), rz = -Math.sin(yaw);
      var cands = over ? OVER_CAND : CAND;
      var want = over ? 6 : 2;
      var placed = 0, ci, x, z, side, room, lat;
      for (ci = 0; ci < cands.length && placed < want; ci++) {
        var dist = cands[ci];
        var ax = p.position.x + fx * dist, az = p.position.z + fz * dist;
        if (!this._inBounds(ax, az, 1.0, inside)) continue;
        side = ((ci + i) & 1) ? 1 : -1;
        room = this._freeLateral(ax, az, rx * side, rz * side, over ? 9 : 4.4);
        // Sit the mass just inside whatever room there is: hard against the
        // wall in a canyon, well out of the sightline on an open apron.
        lat = side * Math.min(Math.max(room - 1.05, 0), over ? 6.0 : 3.0);
        x = ax + rx * lat; z = az + rz * lat;
        if (Math.abs(lat) < 0.55 && room < 1.5) continue;   // nothing fits abreast
        if (!this._inBounds(x, z, 0.9, inside)) continue;
        if (this._occupied(x, z, 1.3)) continue;
        if (this._blocked(x, this._ground(x, z) + 0.9, z, 1.0)) continue;
        var yawTo = Math.atan2(p.position.x - x, p.position.z - z);
        var ok = false;
        if (inside) {
          // Under a roof, so nothing here may be wet.
          ok = this._dryForeground(x, z, yawTo);
        } else {
          // Something with a silhouette that can carry a near-black foreground:
          // a trio of drums, a stack under a sheet, and - only where the quay
          // furniture is OURS - a bollard and its coil.  Dropping a second
          // bollard beside one the level already composed its framing around
          // is a duplicate, not a foreground, so on a level that publishes them
          // the cable reel and its flaked tail take that slot instead.
          var pick = (ci + i) % 3;
          if (pick === 0 && this.own.bollards && this.B.bollard) {
            var by = this._drop(this.B.bollard, x, z, {
              r: 0.9, tilt: 0.01, yaw: yawTo, lane: false,
              collider: [0.42, 0.48, 0.42], material: 'metal'
            });
            if (by !== null) { this._ropeCoil(x + rx * 0.9, by, z + rz * 0.9); ok = true; }
          } else if (pick === 0 && this.B.cableReel) {
            var ry2 = this._drop(this.B.cableReel, x, z, {
              r: 1.0, tilt: 0.02, yaw: yawTo + Math.PI / 2 + R.range(-0.3, 0.3),
              lane: false, collider: [0.5, 0.9, 0.9], material: 'wood'
            });
            if (ry2 !== null) { this._ropeCoil(x + rx * 1.25, ry2, z + rz * 1.25); ok = true; }
          } else if (pick === 1) {
            for (var d = 0; d < 3; d++) {
              var db = this._drumLot();
              var a = d * 2.09 + R.range(-0.3, 0.3);
              var dx = x + Math.cos(a) * 0.36, dz = z + Math.sin(a) * 0.36;
              var dyw = R.range(0, M.TAU);
              db.place(dx, this._ground(dx, dz), dz, dyw,
                R.gaussian(0, 0.02), R.gaussian(0, 0.02), 1, 1, 1, wearTint(R));
              this._drumPlacard(dx, this._ground(dx, dz), dz, dyw + yawTo);
              this._wetHalo(dx, dz, 0.40);
            }
            this._occupy(x, z, 1.0);
            this._oilSlick(x + R.range(-1, 1), z + R.range(-1, 1), R.range(0.7, 1.2));
            ok = true;
          } else {
            ok = this._palletStack(x, z, yawTo + R.range(-0.4, 0.4));
          }
        }
        if (ok) placed++;
      }
      this.stats.poseProps = (this.stats.poseProps || 0) + placed;

      // A standpoint metres above the yard: dress the surface it stands on,
      // because nothing this pass puts on the ground can be seen from up there.
      var elev = p.position.y > this.groundY + 3.0;
      if (elev) this._dressElevated(p, fx, fz, rx, rz);

      if (over || elev) {
        // An elevated standpoint photographs MASS.  The near-lens dressing this pass
        // used to spend its whole budget on - four pools and seven scraps of
        // litter - subtends well under a pixel from up here and was pure waste;
        // what an establishing shot can actually resolve is broad standing
        // water carrying a mast reflection across the mid-ground.
        for (var ow = 0; ow < 6; ow++) {
          var od = 16 + ow * 8.5;
          var oax = p.position.x + fx * od, oaz = p.position.z + fz * od;
          var oside = (ow & 1) ? 1 : -1;
          var olat = oside * R.range(1.5, 11.0);
          this._pool(oax + rx * olat, oaz + rz * olat, R.range(2.2, 4.0), 0, false);
        }
        continue;
      }

      // Standing water in front of the lens catches the lamps and gives the
      // shot its darkest darks and brightest brights in the same square metre.
      // Staggered in depth, and again LATERALLY CLAMPED - three of the six
      // framings look down something narrower than the offsets used to assume.
      for (var w = 0; w < 4; w++) {
        // The first one starts at 3.8 m, not 2.6: a two-metre pool two and a
        // half metres from the lens is not a foreground element, it is the
        // bottom third of the frame.
        var wd = 3.8 + w * 3.2;
        var wax = p.position.x + fx * wd, waz = p.position.z + fz * wd;
        var wside = (w & 1) ? 1 : -1;
        var wroom = this._freeLateral(wax, waz, rx * wside, rz * wside, 3.4);
        var wl = wside * Math.min(wroom * 0.55, 2.2);
        var wr = Math.min(R.range(0.8, 1.7), Math.max(0.5, wroom * 0.8));
        this._pool(wax + rx * wl, waz + rz * wl, wr, 0, inside);
      }
      // and a little loose debris right under the lens, which is what stops a
      // near-empty foreground reading as a clean studio floor
      for (var q = 0; q < 7; q++) {
        var qd = 1.9 + R.range(0, 4.5);
        var qax = p.position.x + fx * qd, qaz = p.position.z + fz * qd;
        var qside = R.bool() ? 1 : -1;
        var qroom = this._freeLateral(qax, qaz, rx * qside, rz * qside, 3.2);
        var qlat = qside * Math.abs(R.gaussian(0, 1.1));
        if (Math.abs(qlat) > qroom - 0.3) qlat = qside * Math.max(0, qroom - 0.35);
        var qx = qax + rx * qlat, qz = qaz + rz * qlat;
        if (!this._freeSpot(qx, qz, 0.30, 0.12, inside)) continue;
        if (R.bool(0.5)) {
          var dn = inside && this.B.dunnageDry ? this.B.dunnageDry : this.B.dunnage;
          dn.place(qx, this._ground(qx, qz), qz, R.range(0, M.TAU),
            R.gaussian(0, 0.05), R.gaussian(0, 0.05), R.range(0.5, 1.0), 1, 1, wearTint(R));
        } else {
          var lb = this.B['litter' + R.int(0, 3)];
          if (lb) {
            lb.place(qx, this._ground(qx, qz) + R.range(0.01, 0.05), qz,
              R.range(0, M.TAU), Math.PI / 2 + R.range(-0.4, 0.4), R.range(0, M.TAU),
              R.range(0.9, 1.5), R.range(0.9, 1.5), 1, wearTint(R));
          }
        }
      }
      if (!inside) this._brightNearKit(p, fx, fz, rx, rz);
    }
  };

  // Dress the SURFACE THE CAMERA IS STANDING ON.
  //
  // A framing whose standpoint is metres above the yard gets nothing at all
  // from a pass that dresses the ground: every prop it places is twenty metres
  // below the lens and out of frame, and the near third of the shot is the bare
  // top of whatever the camera is standing on.  A container roof in a working
  // terminal is not bare - it holds standing water in its pans, loose
  // twistlocks that came off the box below, a lashing bar, a coil of wire rope
  // and the run-off from its own corner castings.  Wet steel at thirty degrees
  // to a mast head is the brightest surface in this level, so this both fixes
  // the composition and lifts the frame mean in one move.
  PropsHarbor.prototype._dressElevated = function (p, fx, fz, rx, rz) {
    var R = this.rng;
    var eye = p.position;
    var yMax = eye.y - 0.35;
    var top = this._solidTop(eye.x, eye.z, yMax);
    if (!isFinite(top) || !(top > this.groundY + 1.4)) return 0;
    // The neighbouring stacks are rarely the same height, and a camera on the
    // OUTERMOST row has open air on one side, so "must be exactly this roof"
    // rejected all sixteen candidates and the establishing shot got nothing.
    // Any solid surface between three metres below the standpoint and level
    // with it is still the near ground of this frame.
    var placed = 0, k, x, z, st;
    for (k = 0; k < 24 && placed < 6; k++) {
      var d = 1.1 + R.range(0, 3.1);
      var side = (k & 1) ? 1 : -1;
      var lat = side * R.range(0.20, 2.6);
      x = eye.x + fx * d + rx * lat;
      z = eye.z + fz * d + rz * lat;
      st = this._solidTop(x, z, yMax);
      if (!isFinite(st) || st < top - 3.2 || st > top + 0.4) continue;
      if (this._occupied(x, z, 0.45)) continue;
      var kind = k % 4;
      var bt = kind === 0 ? this.B.twistlock
        : kind === 1 ? this.B.lashingBar
          : kind === 2 ? this.B.hoseCoil : this.B.dunnage;
      if (!bt) continue;
      if (!bt.place(x, st + 0.010, z, R.range(0, M.TAU),
        R.gaussian(0, 0.04), R.gaussian(0, 0.04),
        R.range(0.85, 1.2), 1, 1, wearTint(R))) continue;
      this._occupy(x, z, 0.45);
      placed++;
    }
    // The pans.  A container roof holds water in every trough, and it is the
    // one thing up here that can return a lamp.
    var pooled = 0;
    for (k = 0; k < 8 && pooled < 4; k++) {
      var pd = 1.6 + k * 0.9;
      var pls = ((k & 1) ? 1 : -1) * R.range(0.3, 2.2);
      var px = eye.x + fx * pd + rx * pls;
      var pz = eye.z + fz * pd + rz * pls;
      var pt = this._solidTop(px, pz, yMax);
      if (!isFinite(pt) || pt < top - 3.2 || pt > top + 0.4) continue;
      this._poolAt(px, pt + 0.006, pz, R.range(0.5, 1.2));
      pooled++;
    }
    // A coil of wire rope left up here after the last lift, on whatever surface
    // is actually under it.
    for (k = 0; k < 5; k++) {
      x = eye.x + fx * (2.4 + k * 0.5) + rx * R.range(-1.4, 1.4);
      z = eye.z + fz * (2.4 + k * 0.5) + rz * R.range(-1.4, 1.4);
      st = this._solidTop(x, z, yMax);
      if (!isFinite(st) || st < top - 3.2 || st > top + 0.4) continue;
      this._ropeCoil(x, st + 0.01, z);
      break;
    }
    this.stats.elevated = (this.stats.elevated || 0) + placed;
    return placed;
  };

  // A SPECULAR near-third for a framing that is pitched up.
  //
  // crane.png is the one capture still under the 0.10 luminance flag, and the
  // set-dressing cause is that its near half carries nothing a mast lamp can
  // strike: the camera is at eye level pitched up 21 degrees, so the ground
  // dressing this pass places at four to eight metres sits below the bottom of
  // frame and the lower-left forty per cent of the image is a featureless black
  // wedge.  (The finding blamed an elevated standpoint and _freeLateral; the
  // pose is in fact at gy + 1.70, so the real cause is the PITCH.)
  //
  // What fixes it is height plus albedo in the near third, so this places the
  // three brightest things in the whole kit: retroreflective cone sleeves, the
  // hazard-striped A-frame, and a hoop-lit drum pair, each standing in its own
  // wetted halo so the apron beneath returns them.  Wet steel at thirty degrees
  // to a sodium head is the brightest surface in this level.
  PropsHarbor.prototype._brightNearKit = function (p, fx, fz, rx, rz) {
    if (!(p.pitch > 0.10)) return;
    var R = this.rng;
    var placed = 0;
    for (var k = 0; k < 16 && placed < 4; k++) {
      var d = 3.0 + (k % 8) * 0.75;
      var side = (k & 1) ? 1 : -1;
      var ax = p.position.x + fx * d, az = p.position.z + fz * d;
      var room = this._freeLateral(ax, az, rx * side, rz * side, 5.0);
      if (room < 0.85) continue;
      var lat = side * M.clamp(room - 0.55, 0.55, 3.4);
      var x = ax + rx * lat, z = az + rz * lat;
      if (!this._inBounds(x, z, 0.7)) continue;
      if (this._occupied(x, z, 0.9)) continue;
      var y = this._ground(x, z);
      if (this._blocked(x, y + 0.7, z, 0.7)) continue;
      var yawTo = Math.atan2(p.position.x - x, p.position.z - z);
      if (k % 3 === 0 && this.B.hazardBarrier) {
        if (this._drop(this.B.hazardBarrier, x, z, {
          r: 0.95, clearR: 0.6, tilt: 0.03, yaw: yawTo + R.range(-0.5, 0.5),
          lane: false, collider: [0.7, 0.5, 0.35], material: 'metal'
        }) === null) continue;
      } else if (k % 3 === 1 && this.B.cone) {
        var any = false;
        for (var c = 0; c < 2; c++) {
          var cx = x + Math.cos(yawTo + c * 2.1) * 0.55;
          var cz = z + Math.sin(yawTo + c * 2.1) * 0.55;
          var cy = this._ground(cx, cz);
          if (!this.B.cone.place(cx, cy, cz, R.range(0, M.TAU),
            R.gaussian(0, 0.05), R.gaussian(0, 0.05), 1, 1, 1, wearTint(R))) continue;
          this.B.coneBand.place(cx, cy + 0.30, cz, 0, 0, 0, 1, 1, 1, WHITE);
          this._wetHalo(cx, cz, 0.32);
          any = true;
        }
        if (!any) continue;
        this._occupy(x, z, 0.9);
      } else {
        var ok = false;
        for (var q = 0; q < 2; q++) {
          var qx = x + Math.cos(yawTo + q * 3.14) * 0.34;
          var qz = z + Math.sin(yawTo + q * 3.14) * 0.34;
          var qy = this._ground(qx, qz);
          var qyaw = R.range(0, M.TAU);
          if (!this._drumLot().place(qx, qy, qz, qyaw,
            R.gaussian(0, 0.02), R.gaussian(0, 0.02), 1, 1, 1, wearTint(R))) continue;
          this._drumPlacard(qx, qy, qz, qyaw + yawTo);
          this._wetHalo(qx, qz, 0.40);
          ok = true;
        }
        if (!ok) continue;
        this._occupy(x, z, 0.9);
      }
      // the pool that makes the mass pay twice
      this._pool(x + rx * side * R.range(0.8, 1.6), z + rz * side * R.range(0.8, 1.6),
        R.range(0.9, 1.6));
      placed++;
    }
    this.stats.brightNear = (this.stats.brightNear || 0) + placed;
  };

  // A foreground mass for a framing that stands under a roof: same job, dry
  // materials, and no puddle.
  PropsHarbor.prototype._dryForeground = function (x, z, yawTo) {
    var R = this.rng;
    var y = this._ground(x, z);
    if (this.B.palletDry && R.bool(0.55)) {
      var high = R.int(3, 6);
      for (var i = 0; i < high; i++) {
        this.B.palletDry.place(x, y + i * 0.152, z, yawTo + R.gaussian(0, 0.04),
          R.gaussian(0, 0.008), R.gaussian(0, 0.008), 1, 1, 1, wearTint(R));
      }
      if (this.B.crateDry) {
        this.B.crateDry.place(x + R.range(-0.12, 0.12), y + high * 0.152, z + R.range(-0.12, 0.12),
          yawTo + R.gaussian(0, 0.14), 0, 0, 1, 1, 1, wearTint(R));
      }
      this._occupy(x, z, 1.1);
      this._collider(x, y, z, [0.65, (high * 0.152 + 0.9) * 0.5, 0.48], yawTo, 'wood');
      return true;
    }
    if (!this.B.drumDry) return false;
    for (var d = 0; d < 4; d++) {
      var a = d * 1.57 + R.range(-0.2, 0.2);
      var dx = x + Math.cos(a) * 0.34, dz = z + Math.sin(a) * 0.34;
      this.B.drumDry.place(dx, this._ground(dx, dz), dz, R.range(0, M.TAU),
        R.gaussian(0, 0.02), R.gaussian(0, 0.02), 1, 1, 1, wearTint(R));
    }
    this._occupy(x, z, 1.0);
    return true;
  };

  // --------------------------------------------------------------------------
  // Commit
  // --------------------------------------------------------------------------
  var STATIC_MATERIAL = {
    steel: 'steel', rust: 'rust', deck: 'deck', concrete: 'concrete',
    wood: 'wood', rubber: 'rubber', grate: 'grate', corr: 'corr',
    paint: 'line', rope: 'rope', line: 'line', dry: 'drySteel', lineDry: 'lineDry',
    placard: 'hazard',
    hznRed: 'red', hznBlue: 'blue', hznGreen: 'green'
  };
  var STATIC_UVNAME = {
    steel: 'container_steel', rust: 'rusted_metal', deck: 'deck_plate',
    concrete: 'dock_concrete', wood: 'wood_plank', rubber: 'rubber_fender',
    grate: 'steel_grate', corr: 'corrugated_roof', paint: 'painted_line',
    rope: 'rope', line: 'painted_line', dry: 'deck_plate', lineDry: 'painted_line',
    placard: 'painted_line',
    hznRed: 'container_red', hznBlue: 'container_blue', hznGreen: 'container_green'
  };

  // Water running off every overhanging edge in the level.
  //
  // The art direction calls drips off container edges, ledges and the crane
  // NON-NEGOTIABLE, and K.drip has existed since the first version of this file
  // driving nothing but four streaks under a reefer drain - so in a downpour
  // the only thing in the terminal shedding water was a refrigeration unit.
  // The container top rails are already published geometry (this.containers is
  // read off the level's own colliders at layout time) so no new probing is
  // needed: march each long edge and hang three to six streaks off it.  The
  // drip material animates the fall off this.uTime in its own vertex patch, so
  // this is one instanced draw for the whole level.
  PropsHarbor.prototype._dressDrips = function () {
    var bt = this.B.drip;
    if (!bt) return;
    var R = this.rng;
    var placed = 0, i, k;
    for (i = 0; i < this.containers.length && placed < 300; i++) {
      var c = this.containers[i];
      if (c.toppled) continue;
      var h = c.top - this.groundY;
      if (h < 2.0 || h > 12.0) continue;
      var alongX = (c.maxx - c.minx) > (c.maxz - c.minz);
      for (var side = 0; side < 2; side++) {
        var n = R.int(3, 6);
        for (k = 0; k < n; k++) {
          var t = (k + R.range(0.15, 0.85)) / n;
          var x, z;
          if (alongX) {
            x = M.lerp(c.minx, c.maxx, t);
            z = side ? c.maxz + 0.035 : c.minz - 0.035;
          } else {
            z = M.lerp(c.minz, c.maxz, t);
            x = side ? c.maxx + 0.035 : c.minx - 0.035;
          }
          if (this._indoor(x, z, 0)) continue;
          if (!bt.place(x, c.top - 0.03, z, alongX ? 0 : Math.PI / 2, 0, 0,
            R.range(0.8, 1.5), R.range(1.0, 2.3), 1, WHITE)) return;
          placed++;
        }
      }
    }
    // The crane portal beam and the warehouse eave, where the level publishes
    // them: the two other big overhangs in the terminal.
    var A = this.ctx.level && this.ctx.level.anchors;
    if (!A) return;
    if (A.crane && isFinite(A.crane.sill) && isFinite(A.crane.legX)) {
      for (k = 0; k < 16 && placed < 340; k++) {
        var cx = M.lerp(-A.crane.legX, A.crane.legX, (k + 0.5) / 16) + R.range(-0.6, 0.6);
        var cz = (isFinite(A.crane.railA) ? A.crane.railA : this.quayZ) + R.range(-0.5, 0.5);
        if (!bt.place(cx, A.crane.sill - 0.15, cz, R.range(0, M.TAU), 0, 0,
          R.range(0.9, 1.6), R.range(1.4, 2.8), 1, WHITE)) return;
        placed++;
      }
    }
    if (A.warehouse && isFinite(A.warehouse.eave) && isFinite(A.warehouse.faceX)) {
      for (k = 0; k < 14 && placed < 360; k++) {
        var wz = M.lerp(A.warehouse.z0 + 1, A.warehouse.z1 - 1, (k + 0.5) / 14);
        if (!bt.place(A.warehouse.faceX + (A.warehouse.outX || -1) * 0.35,
          A.warehouse.eave - 0.08, wz, 0, 0, 0,
          R.range(0.9, 1.5), R.range(1.2, 2.4), 1, WHITE)) return;
        placed++;
      }
    }
    this.stats.drips = placed;
  };

  PropsHarbor.prototype._commit = function () {
    var key, i;

    this._dressDrips();

    // ---- rope and chain -----------------------------------------------------
    // Every mooring line, lashing and rail chain in the level is ONE mesh each.
    // They carry aFlex so the wind snippet can move them, which is why they are
    // swept here rather than merged with Geo.mergeAll (which drops custom
    // attributes).
    this._buildTubes('_ropePaths', this.mats.ropeWind, 'harbor_ropes', 5);
    this._buildTubes('_chainPaths', this.mats.chain, 'harbor_chains', 4);

    // ---- static merges ------------------------------------------------------
    for (key in this.S) {
      var parts = this.S[key];
      if (!parts || !parts.length) continue;
      var geo = mergeParts(parts, 0);
      disposeParts(parts);
      if (!geo) continue;
      // Re-UV to the library's declared density, then paint the wear mask -
      // AFTER the merge, because mergeAll does not carry attributes through.
      try { Geo.worldUV(geo, this._uvScale(STATIC_UVNAME[key] || 'deck_plate', 500)); }
      catch (e) { /* keep the builder's uv */ }
      Geo.copyUV1(geo);
      paintWear(geo, { noise: this.noise, grime: 0.40, edge: 0.30, hiY: 2.4 });
      var mat = this.mats[STATIC_MATERIAL[key] || 'deck'] || this.mats.deck;
      var flat = (key === 'line' || key === 'lineDry');
      var mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'harbor_static_' + key;
      mesh.castShadow = !flat;
      mesh.receiveShadow = true;
      if (flat) mesh.renderOrder = 1;
      this.root.add(mesh);
    }

    // ---- pooled water and oil ----------------------------------------------
    if (this._poolParts && this._poolParts.length) {
      var pg = Geo.mergeAll(this._poolParts);
      disposeParts(this._poolParts);
      if (pg) {
        Geo.copyUV1(pg);
        var pm = new THREE.Mesh(pg, this.mats.pool);
        pm.name = 'harbor_pools';
        pm.castShadow = false;
        pm.receiveShadow = false;
        pm.renderOrder = 2;
        this.root.add(pm);
        this.poolMesh = pm;
      }
    }
    if (this._oilParts && this._oilParts.length) {
      var og = Geo.mergeAll(this._oilParts);
      disposeParts(this._oilParts);
      if (og) {
        Geo.copyUV1(og);
        var om = new THREE.Mesh(og, this.mats.oil);
        om.name = 'harbor_oil';
        om.castShadow = false;
        om.receiveShadow = false;
        om.renderOrder = 3;
        this.root.add(om);
        this.oilMesh = om;
      }
    }

    // ---- instanced batches --------------------------------------------------
    this.stats.batch = {};
    for (key in this.B) {
      var b = this.B[key];
      if (!b) continue;
      if (b.full) this.stats.full.push(key + ':' + b.max);
      this.stats.batch[key] = b.n;
      if (b.finish(this.root, 'harbor_' + key)) this.stats.instances += b.n;
      else delete this.B[key];
    }
    this._gullBatch = this.B.gull || null;

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
    // Offered to lighting.js: it supplies the lamps, we supply the masts, and
    // neither has to guess where the other put them.
    this.root.userData.lightMasts = this.lightMasts;
    this.root.updateMatrixWorld(true);

    // Opt-in build diagnostic (index.html?...&propsdbg=1).  Inert otherwise,
    // and it is the only way to see instance-budget overflow, which is
    // otherwise silent: Batch.add just returns false and the last pass built
    // gets nothing.  Written into the DOM as well as the console because
    // headless --dump-dom can read the DOM and cannot read the console.
    try {
      if (typeof location !== 'undefined' && /propsdbg=1/.test(location.search || '')) {
        var dbg = JSON.stringify({
          st: this.stats, quay: this.quayZ, apron: this.apron,
          own: this.own, ownWhy: this.ownWhy,
          bounds: this.bounds, groundY: this.groundY,
          interior: this.interior, shafts: (this.shafts || []).length,
          containers: this.containers.length, masts: this.lightMasts.length,
          reefers: (this.reefers || []).length, gulls: this.gulls.length,
          pools: this._poolCount || 0, oil: this._oilCount || 0
        });
        if (window.console && console.log) console.log('HARBORPROPS ' + dbg);
        if (typeof document !== 'undefined' && document.body) {
          var d = document.createElement('div');
          d.id = 'harborpropstat';
          d.style.display = 'none';
          d.textContent = dbg;
          document.body.appendChild(d);
        }
      }
    } catch (e2) { /* diagnostics never break a build */ }

    // Opt-in isolation (?propshide=drum,static or =1 for all).  "Which module
    // owns that object?" is otherwise unanswerable from a screenshot, and props
    // is the module most likely to be blamed for somebody else's mesh.
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
      this.ctx.bus.emit('harbor:lightmasts', this.lightMasts);
    }
  };

  PropsHarbor.prototype._buildTubes = function (listKey, material, name, maxDraws) {
    var list = this[listKey];
    if (!list || !list.length || !material) return;
    var tb = new TubeBuilder();
    var built = 0;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var pts = sagPath(p.a, p.b, p.sag, p.seg || 12);
      var flex = p.flex || 0;
      /* jshint loopfunc:true */
      tb.addPath(pts, p.r, 5, (function (f) {
        // free in the middle of a span, pinned at both ends
        return function (t) { return Math.sin(t * Math.PI) * f; };
      })(flex), Math.max(1, Math.round(p.a.distanceTo(p.b) * 1.6)));
      built++;
      if (built > 260) break;
    }
    if (!tb.count()) return;
    var g = tb.geometry(true);
    Geo.copyUV1(g);
    paintWear(g, { noise: this.noise, grime: 0.34, edge: 0.20, wet: 1.0, loY: 0, hiY: 4 });
    var mesh = new THREE.Mesh(g, material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;         // one mesh spanning the whole quay
    this.root.add(mesh);
    this.windMeshes.push(mesh);
    if (maxDraws) { /* documented budget marker; the mesh is always one draw */ }
  };

  // --------------------------------------------------------------------------
  // Per-frame
  // --------------------------------------------------------------------------
  var _wdir = new THREE.Vector2();

  PropsHarbor.prototype.update = function (dt, ctx) {
    if (!(dt > 0)) dt = 0;
    ctx = ctx || this.ctx;
    // Drive from ctx.time when the engine provides it so deterministic capture
    // runs reproduce exactly; integrate dt otherwise.
    if (ctx && typeof ctx.time === 'number' && isFinite(ctx.time)) this.time = ctx.time;
    else this.time += dt;
    this.uTime.value = this.time;

    // ---- the weather contract, consumer side -------------------------------
    // weather.js owns all of this; we only read it, and only ever through a
    // guard, because props builds BEFORE weather in the boot order and the
    // first frames legitimately have no weather at all.
    var w = ctx && ctx.weather;
    var rain = 1;
    if (w) {
      if (w.windDir && isFinite(w.windDir.x) && isFinite(w.windDir.y)) {
        _wdir.copy(w.windDir);
        if (_wdir.lengthSq() > 1e-6) {
          _wdir.normalize();
          this.uWindDir.value.copy(_wdir);
          this.windDir.copy(_wdir);
        }
      }
      if (typeof w.windSpeed === 'number' && isFinite(w.windSpeed)) {
        this.windSpeed = w.windSpeed;
      }
      if (typeof w.rainIntensity === 'number' && isFinite(w.rainIntensity)) {
        rain = M.saturate(w.rainIntensity);
      }
    }
    // Amplitude and frequency both rise with wind speed - cloth in a gale
    // moves further AND faster, and only scaling one of them reads as slow
    // motion.
    var s = M.clamp(this.windSpeed / 16, 0.25, 2.2);
    var wv = this.uWind.value;
    wv.x = 0.055 + 0.085 * s;
    wv.y = 1.7 + 1.5 * s;
    wv.z = 0.45 + 0.35 * s;

    // ---- puddle ripples ------------------------------------------------------
    // Two layers scrolling at different rates and directions so the surface
    // never resolves into a repeating pattern, with the amplitude driven by how
    // hard it is actually raining.
    if (this.mats.pool && this.mats.pool.normalMap) {
      var nm = this.mats.pool.normalMap;
      nm.offset.x = (this.time * 0.021 + this.windDir.x * this.time * 0.004) % 1;
      nm.offset.y = (this.time * 0.017 + this.windDir.y * this.time * 0.004) % 1;
      if (this.mats.pool.normalScale) {
        this.mats.pool.normalScale.set(0.08 + 0.16 * rain, 0.08 + 0.16 * rain);
      }
    }
    // The oil film shares the pool's ripple texture, so it inherits the scroll
    // above; what it gets of its own is a slow thickness drift, which is what
    // makes the interference bands wander instead of sitting still.
    if (this.mats.oil && this.mats.oil.iridescenceThicknessRange) {
      var t0 = 220 + Math.sin(this.time * 0.11) * 60;
      this.mats.oil.iridescenceThicknessRange[0] = t0;
      this.mats.oil.iridescenceThicknessRange[1] = t0 + 520;
    }

    // ---- gulls ---------------------------------------------------------------
    // A lightning strike puts a roosting flock up.  It is three lines of code
    // and it is the single clearest signal in the level that this is a place
    // rather than a diorama.
    if (w && typeof w.flash === 'number' && w.flash > 0.25) this._gullStartle = 1;
    if (this._gullStartle > 0.001) {
      this._gullStartle = Math.max(0, this._gullStartle - dt * 0.55);
      this._updateGulls();
    } else if (this._gullSettled !== true) {
      this._updateGulls();
      this._gullSettled = true;
    }
  };

  PropsHarbor.prototype._updateGulls = function () {
    var b = this._gullBatch;
    if (!b || !b.mesh || !this.gulls.length) return;
    var k = this._gullStartle;
    var mesh = b.mesh;
    for (var i = 0; i < this.gulls.length && i < mesh.count; i++) {
      var g = this.gulls[i];
      // startled: lift, pitch nose-up, and yaw off the perch.  A bird already
      // airborne does not startle - it just keeps working the wind.
      var air = !!g.air;
      var k2 = air ? 0 : k;
      var lift = k2 * k2 * (0.55 + 0.35 * Math.sin(this.time * 11 + g.phase));
      var flap = k2 * Math.sin(this.time * 17 + g.phase) * 0.35;
      var idle = (1 - k2) * Math.sin(this.time * 0.7 + g.phase) * (air ? 0.16 : 0.045);
      mesh.setMatrixAt(i, T(
        g.x + k2 * Math.sin(g.phase) * 0.35 + (air ? Math.sin(this.time * 0.31 + g.phase) * 1.6 : 0),
        g.y + lift + (air ? Math.sin(this.time * 0.44 + g.phase * 1.7) * 0.55 : 0),
        g.z + k2 * Math.cos(g.phase) * 0.35 + (air ? Math.cos(this.time * 0.27 + g.phase) * 1.6 : 0),
        (g.pitch || 0) - k2 * 0.45 + idle,
        g.yaw + idle * 2.5 + k2 * Math.sin(g.phase * 3) * 0.7,
        (g.roll || 0) + flap,
        g.scale, g.scale, g.scale));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (k > 0.001) this._gullSettled = false;
  };

  PropsHarbor.prototype.resize = function () { /* nothing viewport-dependent */ };

  PropsHarbor.prototype.dispose = function () {
    try {
      this.root.traverse(function (o) {
        if (o.geometry && o.geometry.dispose) o.geometry.dispose();
        if (o.isInstancedMesh && o.dispose) o.dispose();
      });
      var k;
      for (k in this.mats) { if (this.mats[k] && this.mats[k].dispose) this.mats[k].dispose(); }
      for (k in this.tex) { if (this.tex[k] && this.tex[k].dispose) this.tex[k].dispose(); }
      if (this.root.parent) this.root.parent.remove(this.root);
    } catch (e) { GAME.logError('propsH.dispose', e); }
    this.colliders.length = 0;
  };


  GAME.PropsHarbor = PropsHarbor;

})(window.GAME, window.THREE);
