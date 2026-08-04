// ============================================================================
// OPERATION BLACKOUT - LEVEL 3 "KIROVSK PASS" - set dressing
// Module owner: props_snowbound.  Exports GAME.PropsSnowbound.
//
// level_snowbound.js builds the PLACE: the road, nine dachas, a church, a barn,
// five stalled trucks, a broken bridge and the snowfield they all stand in.
// This file builds the EVIDENCE THAT PEOPLE LIVE THERE - the firewood stacked
// under the eaves, the shovel by the door, the crates that came off a tailgate,
// the graves behind the church, the ravens that have not moved all day.
//
// Design constraints that shaped the code:
//
//   * PLACEMENT IS PHYSICAL, NEVER SCATTERED.  Firewood stacks against the
//     WINDWARD flank of a house (the side the wind scours, which is the side
//     you can still get at in February) and the drift banks against the LEE
//     one.  Cargo lies behind a tailgate, not beside it.  Rubble collects in
//     the inside corner of a wall.  Graves sit in rows.  Dead grass shows only
//     on the crests the wind strips, never in a hollow where a metre of snow is
//     lying.  Everything is placed against `level.anchors`, never a camera pose.
//
//   * SNOW IS A PROP MATERIAL, NOT A COLOUR.  Every outdoor prop carries actual
//     snow GEOMETRY - a domed cap on its up-facing surfaces, a drift banked on
//     its downwind flank, an icicle fringe under anything that overhangs.  A
//     bone-dry crate in a whiteout is the same lie as a dry crate in a
//     downpour, and it is the fastest way to lose the frame.
//
//   * The snow, ice and lit-glass materials are BORROWED FROM THE LEVEL
//     (level.material('snow')), so a prop's snow cap and the drift it sits in
//     are literally the same shader, the same sparkle map and the same sheen.
//     Authoring a second snow here would guarantee a seam.
//
//   * Wear uses the materials.js vertex convention (R grime, G wetness, B edge
//     wear, white = pristine).  G stays HIGH: weather.js's blizzard carries
//     wetness 0.10 because snow is not water.  Grime is heaviest at the base,
//     along the road where the plough throws grit, and around the stoves.
//
//   * Under ~80 draw calls for everything.  Anything repeated goes through
//     THREE.InstancedMesh with per-instance yaw/tilt/scale/wear jitter;
//     everything terrain-conforming (snow caps, drifts, icicles) is merged per
//     material, because a snow cap has to be SHAPED to the thing it is lying on
//     and an instanced one would clone across the whole village.
//
//   * Every cross-module call is guarded.  ctx.level, ctx.materials and
//     ctx.weather may be missing or half-built; we degrade, never throw.
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  if (!GAME || !THREE) return;

  var M = GAME.Math;
  var Geo = GAME.Geo;

  // --------------------------------------------------------------------------
  // Scratch.  A few thousand placements happen at build time; a Matrix4 per
  // placement is a measurable slice of the boot budget.
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
  var _bmin = new THREE.Vector3();
  var _bmax = new THREE.Vector3();
  var _rayO = new THREE.Vector3();
  var _rayD = new THREE.Vector3(0, -1, 0);

  var UP = new THREE.Vector3(0, 1, 0);
  var SIDE_X = new THREE.Vector3(1, 0, 0);
  var WHITE = new THREE.Color(1, 1, 1);

  // weather.js's blizzard blows toward (+0.822, -0.569) in (X, Z), and
  // level_snowbound banks every one of its drifts against that.  Taken from
  // those files rather than guessed: a drift, a leaning tuft and a streaming
  // rag that disagree with the falling snow is the loudest tell in the level.
  var WIND_X = 0.8221, WIND_Z = -0.5693;

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

  // Unit-height +Y primitive mapped onto the segment a->b.  "From here to
  // there" is how a brace, a rail or a bent rebar is actually described.
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
    catch (e) { GAME.logError('propsS.merge', e); return null; }
    if (!g) return null;
    if (uvScale) {
      try { Geo.worldUV(g, uvScale); } catch (e2) { GAME.logError('propsS.worldUV', e2); }
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
  // as a primitive: a drum that has spent ten winters in a yard has no
  // perfectly circular section left, and a snow cap is never a slab.
  function roughen(geo, noise, amount, freq, mode) {
    var p = geo.attributes.position;
    if (!p || !noise) return geo;
    freq = freq || 3;
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      var n1 = noise.fbm3(x * freq, y * freq, z * freq, 3, 2.1, 0.55);
      if (mode === 'radial') {
        var r = Math.sqrt(x * x + z * z);
        if (r > 1e-5) p.setXYZ(i, x * (1 + n1 * amount), y + n1 * amount * 0.25, z * (1 + n1 * amount));
      } else if (mode === 'dome') {
        // Only the up-facing shell moves, so the base stays welded to whatever
        // it is lying on - a snow cap that floats at one corner is worse than
        // no snow cap at all.
        var k = M.saturate(y * 4.0);
        p.setXYZ(i, x + n1 * amount * 0.5 * k, y + n1 * amount * k, z + n1 * amount * 0.5 * k);
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

  // A closed 2D profile extruded along Z with fan-triangulated caps.  Jerry can
  // flanks, sledge runners, cross-arms, kerb sections - anything with a
  // recognisable section.
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
      var u1 = len * (uvScale || 1), vd = depth * (uvScale || 1);
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

  // An alpha card standing on its base edge.  Grass, twigs, needle sprays.
  function card(w, h, u0, v0, u1, v1) {
    var hw = w * 0.5;
    var pos = new Float32Array([
      -hw, 0, 0, hw, 0, 0, hw, h, 0,
      -hw, 0, 0, hw, h, 0, -hw, h, 0]);
    var nor = new Float32Array(18);
    for (var i = 0; i < 6; i++) { nor[i * 3 + 2] = 1; }
    if (u0 === undefined) { u0 = 0; v0 = 0; u1 = 1; v1 = 1; }
    var uv = new Float32Array([u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1]);
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return g;
  }

  // A flat card lying on the ground, for the mark atlas.
  function flatCard(w, d, u0, v0, u1, v1) {
    var hw = w * 0.5, hd = d * 0.5;
    var pos = new Float32Array([
      -hw, 0, -hd, hw, 0, -hd, hw, 0, hd,
      -hw, 0, -hd, hw, 0, hd, -hw, 0, hd]);
    var nor = new Float32Array(18);
    for (var i = 0; i < 6; i++) { nor[i * 3 + 1] = 1; }
    var uv = new Float32Array([u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1]);
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return g;
  }

  // Parabolic catenary.  Indistinguishable from cosh() at the sags a frozen
  // washing line or a tow cable actually has, and far cheaper.
  function sagPath(a, b, sag, segments) {
    var pts = [];
    for (var i = 0; i <= segments; i++) {
      var t = i / segments;
      var p = new THREE.Vector3().lerpVectors(a, b, t);
      p.y -= sag * 4 * t * (1 - t);
      pts.push(p);
    }
    return pts;
  }

  // ==========================================================================
  // TubeBuilder - swept tubes carrying a per-vertex wind-flex attribute.
  // three.js TubeGeometry cannot carry a custom attribute through mergeAll, and
  // every rope, cable and washing line in the level has to be ONE mesh.
  // ==========================================================================
  function TubeBuilder() { this.pos = []; this.nrm = []; this.uv = []; this.flex = []; }
  TubeBuilder.prototype.addPath = function (points, radius, radial, flexFn, uRepeat) {
    var n = points.length;
    if (n < 2) return;
    radial = radial || 4;
    uRepeat = uRepeat || 1;
    var rings = [], i, j;
    var tan = new THREE.Vector3(), nb = new THREE.Vector3(), bi = new THREE.Vector3();
    for (i = 0; i < n; i++) {
      var pPrev = points[Math.max(0, i - 1)], pNext = points[Math.min(n - 1, i + 1)];
      tan.copy(pNext).sub(pPrev);
      if (tan.lengthSq() < 1e-10) tan.set(0, 0, 1);
      tan.normalize();
      nb.crossVectors(tan, Math.abs(tan.y) > 0.92 ? SIDE_X : UP).normalize();
      bi.crossVectors(nb, tan).normalize();
      var r = typeof radius === 'function' ? radius(i / (n - 1)) : radius;
      var ring = [];
      for (j = 0; j <= radial; j++) {
        var ang = (j / radial) * Math.PI * 2;
        var ca = Math.cos(ang), sa = Math.sin(ang);
        var nx = nb.x * ca + bi.x * sa, ny = nb.y * ca + bi.y * sa, nz = nb.z * ca + bi.z * sa;
        ring.push({ x: points[i].x + nx * r, y: points[i].y + ny * r, z: points[i].z + nz * r,
          nx: nx, ny: ny, nz: nz });
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

  // ==========================================================================
  // Wind.
  //
  // materials.js has its own built-in sway (opts.wind) and the grass and scrub
  // use it - a few centimetres of object-space flutter is exactly right for a
  // frozen tuft.  What it cannot do is stream a rag, a tarpaulin corner or a
  // washing line ALONG THE WIND DIRECTION, and in a 13 m/s blizzard the
  // direction is the whole point: cloth that waves symmetrically about its rest
  // pose in a gale reads as a flag on a still day.
  //
  // The injection CHAINS onto the library's own onBeforeCompile - materials.js
  // does triplanar, detail normals, parallax and the wear layer in there and
  // clobbering it turns a calibrated surface into flat plastic.  Program
  // identity is controlled with customProgramCacheKey so the per-material
  // closures do not each compile their own program.
  // ==========================================================================
  var WIND_PARS = [
    'uniform float sbTime;',
    'uniform vec4 sbWind;',
    'uniform vec2 sbWindDir;',
    'attribute float aFlex;'
  ].join('\n');

  var WIND_BODY = [
    'vec3 sbOrg = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;',
    '#ifdef USE_INSTANCING',
    'sbOrg = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;',
    '#endif',
    'vec3 sbP = sbOrg + transformed;',
    // A blizzard gusts hard and travels: a slow envelope crossing the valley so
    // the whole village does not breathe in unison, plus a fast ripple per
    // object.  Both keyed off world position, so two rags 30 m apart are never
    // in phase.
    'float sbG = 0.52 + 0.48 * sin( sbTime * 0.61 + sbP.x * 0.071 + sbP.z * 0.053 );',
    'sbG *= 0.74 + 0.26 * sin( sbTime * 0.203 + sbP.z * 0.031 - sbP.x * 0.024 );',
    'float sbPh = sbTime * sbWind.y + ( sbP.x * 0.29 + sbP.z * 0.21 ) * sbWind.w;',
    'float sbS1 = sin( sbPh );',
    'float sbS2 = sin( sbPh * 2.27 + 1.7 );',
    'float sbS3 = sin( sbPh * 4.63 + sbP.y * 5.1 + sbP.x * 1.9 );',
    'float sbA = sbWind.x * aFlex * sbG;',
    // A steady lean downwind PLUS the oscillation about it.  Cloth in a gale is
    // pushed and held, not swung.
    'transformed.x += sbA * ( sbWindDir.x * 0.92 + sbS1 * 0.55 + sbS2 * 0.15 );',
    'transformed.z += sbA * ( sbWindDir.y * 0.92 + sbS2 * 0.38 - sbS1 * 0.12 );',
    'transformed.y += sbA * sbWind.z * ( sbS3 * 0.46 - 0.22 );'
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
    var prev = (mat.onBeforeCompile && mat.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile)
      ? mat.onBeforeCompile : null;
    var prevKey = mat.customProgramCacheKey;
    var hadKey = typeof prevKey === 'function' &&
      prevKey !== THREE.Material.prototype.customProgramCacheKey;
    mat.onBeforeCompile = function (shader, renderer) {
      if (prev) { try { prev.call(mat, shader, renderer); } catch (e) { GAME.logError('propsS.chain', e); } }
      try { fn(shader, mat); } catch (e2) { GAME.logError('propsS.inject', e2); }
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
    return chainCompile(mat, 'sbwind' + (keySuffix || ''), function (shader) {
      shader.uniforms.sbTime = uTime;
      shader.uniforms.sbWind = uWind;
      shader.uniforms.sbWindDir = uWindDir;
      var v = injectAfter(shader.vertexShader, WIND_ANCHOR, WIND_BODY);
      if (v.idx < 0) return;
      shader.vertexShader = v.src.replace('#include <common>', '#include <common>\n' + WIND_PARS);
    });
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
  // The wear / wetness vertex channel.
  //
  // materials.js get(name, {vertexColors:true}) reads the geometry `color`
  // attribute as a WEAR MASK: white = pristine, and each channel darkens toward
  // a different kind of damage.
  //
  //     R -> grime      G -> WETNESS      B -> edge wear / exposed substrate
  //
  // Wetness is written as 1 - wet, so `wet` DEFAULTS TO 0.10 here rather than
  // to the harbor's 1.0: weather.js's blizzard carries wetness 0.10 because
  // snow is not water.  A soaking-wet prop set in a whiteout is exactly as
  // wrong as a bone-dry one in a downpour, and the arithmetic lives in one
  // named function so it cannot silently invert.
  // ==========================================================================
  function paintWear(geo, o) {
    var p = geo.attributes.position, n = geo.attributes.normal;
    if (!p || !n) return geo;
    o = o || {};
    var wet = o.wet === undefined ? 0.10 : o.wet;
    var grime = o.grime === undefined ? 0.26 : o.grime;
    var edge = o.edge === undefined ? 0.18 : o.edge;
    var noise = o.noise || null;
    var ph = o.seed || 0;
    var loY = o.loY === undefined ? 0 : o.loY;
    var hiY = o.hiY === undefined ? 1.4 : o.hiY;
    var c = new Float32Array(p.count * 3);
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      var ny = n.getY(i);
      var up = ny * 0.5 + 0.5;
      // An up-face holds meltwater against a stove or an engine; an underside
      // is bone dry and stays that way for four months.
      var w = M.saturate(wet * (0.18 + 0.82 * up * up));
      // grime is heaviest at the base, where boots, grit and the plough put it
      var lowness = 1 - M.saturate((y - loY) / Math.max(0.2, hiY - loY));
      var gr = grime * (0.32 + 0.95 * lowness * lowness);
      // edge wear rides the up-facing extremities: the corners hands, axes and
      // tailgates actually hit
      var reach = M.saturate((Math.sqrt(x * x + z * z) - 0.08) * 1.7);
      var ed = edge * (0.22 + 0.88 * reach) * (0.30 + 0.80 * M.saturate(ny));
      if (noise) {
        var nv = noise.fbm3(x * 2.4 + ph, y * 2.4, z * 2.4 - ph, 3, 2.1, 0.55);
        gr = M.saturate(gr * (1 + nv * 0.95));
        ed = M.saturate(ed * (1 + nv * 1.1));
      }
      c[i * 3] = M.saturate(1 - gr);
      c[i * 3 + 1] = M.saturate(1 - w);        // <- G is INVERTED wetness
      c[i * 3 + 2] = M.saturate(1 - ed);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return geo;
  }

  // The level's snow / ice / lit materials are plain multiply-vertexColor
  // materials, NOT the wear convention - so they need their own paint, and it
  // is the same one level_snowbound uses on its own snow: up-facing snow keeps
  // its full sky-lit albedo, a vertical face or an underside is lit only by
  // bounce off more snow and goes darker AND bluer.  Without this every cap and
  // drift in the level reads as one flat white shape.
  function paintSnow(geo, noise, seed) {
    var p = geo.attributes.position, n = geo.attributes.normal;
    if (!p || !n) return geo;
    var c = new Float32Array(p.count * 3);
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), z = p.getZ(i);
      var facing = M.saturate(n.getY(i) * 0.5 + 0.5);
      var down = 1 - facing;
      var v = noise ? noise.fbm2(x * 0.55 + (seed || 0), z * 0.55 - (seed || 0), 2) : 0;
      c[i * 3] = (0.80 + 0.20 * facing) * (1 + v * 0.030);
      c[i * 3 + 1] = (0.845 + 0.155 * facing) * (1 + v * 0.026);
      c[i * 3 + 2] = (0.925 + 0.075 * facing) * (1 + v * 0.020) * (1 + down * 0.045);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return geo;
  }

  // Per-instance modulation of the three wear channels.  Multiplies the vertex
  // mask, so this is jitter and not a second coat: 1.0 leaves a channel alone.
  function wearTint(rng, out) {
    out = out || _col;
    out.setRGB(
      1 - rng.range(0, 0.22),      // grime
      1 - rng.range(0, 0.05),      // wetness - a frozen level barely varies
      1 - rng.range(0, 0.18));     // edge wear
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
    this.mesh.name = name || 'snowbound_inst';
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    try { this.mesh.computeBoundingSphere(); } catch (e) { /* older three */ }
    parent.add(this.mesh);
    return this.mesh;
  };

  // ==========================================================================
  // Local texture kit.
  //
  // Generic surfaces (timber, rusted steel, painted steel, canvas, stone,
  // rubber, sandbag, rope) come from ctx.materials by the names the contract
  // fixes.  Everything in here is props-specific ART the shared library cannot
  // know about, and on THIS level the alphas matter more than usual: the
  // library's `foliage` is a green summer leaf card, and a green leaf card in a
  // whiteout is the single most expensive mistake this file could make.  Dead
  // winter grass is straw and umber; scrub is bare rimed twig; the only green
  // in the level is the near-black of a snow-loaded conifer.
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
    if (clamp) t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    else t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx || 1, ry || rx || 1);
    if (aniso) t.anisotropy = aniso;
    t.needsUpdate = true;
    return t;
  };

  // A tapered blade of dead grass, bent downwind.  `bend` is signed.
  function blade(g, x0, y0, len, wid, bend, col, alpha) {
    var tipX = x0 + bend * len, tipY = y0 - len;
    var midX = x0 + bend * len * 0.30, midY = y0 - len * 0.58;
    g.beginPath();
    g.moveTo(x0 - wid, y0);
    g.quadraticCurveTo(midX - wid * 0.55, midY, tipX, tipY);
    g.quadraticCurveTo(midX + wid * 0.55, midY, x0 + wid, y0);
    g.closePath();
    g.fillStyle = 'rgba(' + col + ',' + alpha.toFixed(3) + ')';
    g.fill();
  }

  // ---- dead winter grass ---------------------------------------------------
  // The palette is the point.  Nothing in a February pass is green: this is
  // bleached straw through umber, with the frost that collects on the upwind
  // edge of every stem as the only bright value.  It is also the ONLY warm
  // (very slightly) mark in the mid-field, which is what stops a hundred metres
  // of snowfield reading as one temperature.
  TX.grass = function (size, rng) {
    var c = TX.canvas(size, size);
    if (!c) return null;
    var g = c.getContext('2d');
    if (!g) return null;
    g.clearRect(0, 0, size, size);
    var base = size * 0.985;
    var cols = ['168,152,112', '140,126,92', '112,100,72', '186,170,132', '96,84,60'];
    var i, n = Math.round(size * 0.42);
    // the mat of collapsed last-summer growth at the base
    for (i = 0; i < n * 0.55; i++) {
      var lx = rng.range(size * 0.10, size * 0.90);
      var ll = rng.range(size * 0.05, size * 0.20);
      blade(g, lx, base - rng.range(0, size * 0.05), ll, rng.range(1.0, 2.2),
        rng.range(-1.4, 1.4), rng.pick(cols), rng.range(0.45, 0.85));
    }
    // the standing stems.  They lean downwind as a POPULATION, with spread -
    // a clump where every blade leans identically is a hair comb.
    for (i = 0; i < n; i++) {
      var x = size * 0.5 + rng.gaussian(0, size * 0.16);
      var len = rng.range(size * 0.26, size * 0.86) * (1 - Math.abs(x / size - 0.5) * 0.55);
      var bend = 0.34 + rng.gaussian(0, 0.20);
      var w = rng.range(0.9, 2.3) * (size / 256);
      blade(g, x, base, len, w, bend, rng.pick(cols), rng.range(0.62, 1.0));
      // seed head on the taller ones
      if (rng.next() < 0.22 && len > size * 0.5) {
        g.fillStyle = 'rgba(196,182,146,0.85)';
        g.beginPath();
        g.ellipse(x + bend * len, base - len + size * 0.02, w * 1.5, size * 0.028, bend * 0.6, 0, 6.283);
        g.fill();
      }
    }
    // rime: a pale edge on the windward side of the clump plus frozen granules
    g.globalCompositeOperation = 'source-atop';
    var grd = g.createLinearGradient(0, 0, size, 0);
    grd.addColorStop(0, 'rgba(226,236,248,0.34)');
    grd.addColorStop(0.55, 'rgba(226,236,248,0.05)');
    grd.addColorStop(1, 'rgba(226,236,248,0.0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
    g.globalCompositeOperation = 'source-over';
    for (i = 0; i < size * 0.5; i++) {
      var gx = rng.range(0, size), gy = rng.range(size * 0.35, size);
      g.fillStyle = 'rgba(236,244,255,' + rng.range(0.20, 0.62).toFixed(2) + ')';
      g.fillRect(gx, gy, rng.range(0.8, 2.0), rng.range(0.8, 2.0));
    }
    // snow lying in the bottom of the clump, so the card is not cut off flat
    g.fillStyle = 'rgba(232,240,250,0.92)';
    g.beginPath();
    g.moveTo(0, size);
    for (var t = 0; t <= 16; t++) {
      g.lineTo(size * t / 16, size - size * 0.055 - Math.sin(t * 1.31) * size * 0.022);
    }
    g.lineTo(size, size);
    g.closePath();
    g.fill();
    return c;
  };

  // ---- bare scrub, rimed ---------------------------------------------------
  TX.twig = function (size, rng) {
    var c = TX.canvas(size, size);
    if (!c) return null;
    var g = c.getContext('2d');
    if (!g) return null;
    g.clearRect(0, 0, size, size);
    g.lineCap = 'round';
    function branch(x, y, ang, len, wid, depth) {
      var x2 = x + Math.cos(ang) * len, y2 = y + Math.sin(ang) * len;
      g.strokeStyle = 'rgba(58,49,40,' + (0.62 + depth * 0.10).toFixed(2) + ')';
      g.lineWidth = wid;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
      // rime rides the upwind (left) shoulder of every twig
      g.strokeStyle = 'rgba(220,232,246,0.50)';
      g.lineWidth = Math.max(0.6, wid * 0.42);
      g.beginPath();
      g.moveTo(x - wid * 0.42, y); g.lineTo(x2 - wid * 0.42, y2); g.stroke();
      if (depth <= 0 || len < size * 0.05) return;
      var k = rng.int(2, 3);
      for (var b = 0; b < k; b++) {
        branch(M.lerp(x, x2, rng.range(0.45, 0.95)), M.lerp(y, y2, rng.range(0.45, 0.95)),
          ang + rng.range(-0.72, 0.72) + 0.16, len * rng.range(0.45, 0.72),
          Math.max(0.7, wid * 0.62), depth - 1);
      }
    }
    for (var s = 0; s < 5; s++) {
      branch(size * (0.32 + s * 0.09), size * 0.99,
        -Math.PI * 0.5 + rng.range(-0.5, 0.5) + 0.20, size * rng.range(0.24, 0.36),
        size * 0.016, 3);
    }
    // snow caught in the fork of the bush
    for (var i = 0; i < 26; i++) {
      g.fillStyle = 'rgba(234,242,252,' + rng.range(0.35, 0.85).toFixed(2) + ')';
      g.beginPath();
      g.ellipse(rng.range(size * 0.18, size * 0.86), rng.range(size * 0.45, size * 0.96),
        rng.range(size * 0.012, size * 0.045), rng.range(size * 0.008, size * 0.022),
        rng.range(0, 3), 0, 6.283);
      g.fill();
    }
    g.fillStyle = 'rgba(230,239,250,0.92)';
    g.beginPath();
    g.moveTo(0, size);
    for (var t = 0; t <= 12; t++) {
      g.lineTo(size * t / 12, size - size * 0.05 - Math.sin(t * 1.7) * size * 0.02);
    }
    g.lineTo(size, size); g.closePath(); g.fill();
    return c;
  };

  // ---- snow-loaded conifer spray ------------------------------------------
  // Near-black green under a heavy white load.  The value structure IS the
  // read: at 40 m in a whiteout a sapling is a white wedge with a dark core.
  TX.needle = function (size, rng) {
    var c = TX.canvas(size, size);
    if (!c) return null;
    var g = c.getContext('2d');
    if (!g) return null;
    g.clearRect(0, 0, size, size);
    var midX = size * 0.5;
    g.lineCap = 'round';
    // trunk
    g.strokeStyle = 'rgba(48,38,30,0.95)';
    g.lineWidth = size * 0.022;
    g.beginPath(); g.moveTo(midX, size); g.lineTo(midX, size * 0.06); g.stroke();
    var tiers = 7, i, j;
    for (i = 0; i < tiers; i++) {
      var t = i / (tiers - 1);
      var y = size * (0.10 + t * 0.86);
      var half = size * (0.06 + t * 0.40);
      for (var sgn = -1; sgn <= 1; sgn += 2) {
        var nS = 5 + Math.round(t * 7);
        for (j = 0; j < nS; j++) {
          var u = (j + 0.5) / nS;
          var ex = midX + sgn * half * u * rng.range(0.85, 1.05);
          var ey = y + half * u * rng.range(0.15, 0.42);
          g.strokeStyle = 'rgba(' + rng.pick(['34,46,36', '26,36,29', '44,58,44']) + ',0.94)';
          g.lineWidth = size * rng.range(0.010, 0.020);
          g.beginPath();
          g.moveTo(midX + sgn * size * 0.01, y);
          g.quadraticCurveTo(midX + sgn * half * u * 0.55, y + half * u * 0.12, ex, ey);
          g.stroke();
        }
      }
    }
    // the load: snow sits on the UPPER surface of each tier and nowhere else
    for (i = 0; i < tiers; i++) {
      var t2 = i / (tiers - 1);
      var y2 = size * (0.10 + t2 * 0.86);
      var half2 = size * (0.06 + t2 * 0.40);
      g.fillStyle = 'rgba(236,243,253,0.94)';
      g.beginPath();
      g.moveTo(midX - half2 * 1.02, y2 + half2 * 0.30);
      g.quadraticCurveTo(midX, y2 - size * 0.045 - half2 * 0.10, midX + half2 * 1.02, y2 + half2 * 0.30);
      g.quadraticCurveTo(midX, y2 + half2 * 0.06, midX - half2 * 1.02, y2 + half2 * 0.30);
      g.closePath();
      g.fill();
      for (j = 0; j < 8; j++) {
        g.fillStyle = 'rgba(228,238,250,' + rng.range(0.5, 0.95).toFixed(2) + ')';
        g.beginPath();
        g.ellipse(midX + rng.range(-half2, half2), y2 + rng.range(-size * 0.01, half2 * 0.32),
          size * rng.range(0.012, 0.038), size * rng.range(0.008, 0.020), 0, 0, 6.283);
        g.fill();
      }
    }
    return c;
  };

  // ---- ground mark atlas ---------------------------------------------------
  // 2x2, alpha-cut, laid as merged flat cards.  These are the marks a PROP
  // makes, which is a different set from the level's boot prints and tyre
  // tread: wood chips around a chopping block, the ash ring under a brazier,
  // spilled straw at a barn door, diesel and grit under a stalled lorry.
  var ATLAS_N = 2;
  var CELL = { chips: 0, ash: 1, straw: 2, diesel: 3 };
  function atlasUV(cell) {
    var s = 1 / ATLAS_N;
    var cx = (cell % ATLAS_N) * s, cy = Math.floor(cell / ATLAS_N) * s;
    var pad = 0.004 * s;
    return [cx + pad, cy + pad, cx + s - pad, cy + s - pad];
  }

  TX.marks = function (px, rng) {
    var c = TX.canvas(px, px);
    if (!c) return null;
    var g = c.getContext('2d');
    if (!g) return null;
    g.clearRect(0, 0, px, px);
    var S = px / ATLAS_N;
    function origin(n) { return [(n % ATLAS_N) * S, Math.floor(n / ATLAS_N) * S]; }
    var o, i;

    // ---- chips: splinters thrown from an axe, densest downwind of the block -
    o = origin(CELL.chips);
    g.save(); g.translate(o[0], o[1]);
    for (i = 0; i < 420; i++) {
      var a = rng.range(0, 6.283);
      var r = Math.pow(rng.next(), 0.55) * S * 0.47;
      var px2 = S * 0.5 + Math.cos(a) * r * 1.15, py2 = S * 0.5 + Math.sin(a) * r * 0.85;
      var L = rng.range(S * 0.012, S * 0.055), W = rng.range(S * 0.004, S * 0.016);
      g.save(); g.translate(px2, py2); g.rotate(rng.range(0, 6.283));
      g.fillStyle = 'rgba(' + rng.pick(['176,152,112', '148,124,90', '120,98,70', '196,176,140']) +
        ',' + rng.range(0.55, 0.98).toFixed(2) + ')';
      g.fillRect(-L * 0.5, -W * 0.5, L, W);
      g.restore();
    }
    // sawdust haze under them
    g.globalCompositeOperation = 'destination-over';
    var cg = g.createRadialGradient(S * 0.5, S * 0.5, S * 0.04, S * 0.5, S * 0.5, S * 0.5);
    cg.addColorStop(0, 'rgba(164,144,110,0.42)');
    cg.addColorStop(0.6, 'rgba(150,132,102,0.16)');
    cg.addColorStop(1, 'rgba(150,132,102,0)');
    g.fillStyle = cg; g.fillRect(0, 0, S, S);
    g.globalCompositeOperation = 'source-over';
    g.restore();

    // ---- ash and soot, with the melt ring a fire leaves in lying snow -------
    o = origin(CELL.ash);
    g.save(); g.translate(o[0], o[1]);
    var ag = g.createRadialGradient(S * 0.5, S * 0.5, S * 0.03, S * 0.5, S * 0.5, S * 0.5);
    ag.addColorStop(0, 'rgba(22,20,19,0.92)');
    ag.addColorStop(0.32, 'rgba(48,44,42,0.62)');
    ag.addColorStop(0.62, 'rgba(96,92,90,0.30)');
    ag.addColorStop(1, 'rgba(120,118,118,0.0)');
    g.fillStyle = ag; g.fillRect(0, 0, S, S);
    for (i = 0; i < 260; i++) {
      var aa = rng.range(0, 6.283), ar = Math.pow(rng.next(), 0.7) * S * 0.42;
      g.fillStyle = 'rgba(' + rng.pick(['16,14,13', '210,206,200', '68,62,58']) + ',' +
        rng.range(0.25, 0.85).toFixed(2) + ')';
      g.fillRect(S * 0.5 + Math.cos(aa) * ar, S * 0.5 + Math.sin(aa) * ar,
        rng.range(1, 3.4), rng.range(1, 3.4));
    }
    // charcoal ends
    for (i = 0; i < 14; i++) {
      g.save();
      g.translate(S * 0.5 + rng.gaussian(0, S * 0.13), S * 0.5 + rng.gaussian(0, S * 0.13));
      g.rotate(rng.range(0, 6.283));
      g.fillStyle = 'rgba(14,12,11,0.95)';
      g.fillRect(-S * 0.035, -S * 0.010, S * 0.07, S * 0.02);
      g.restore();
    }
    g.restore();

    // ---- straw and chaff ----------------------------------------------------
    o = origin(CELL.straw);
    g.save(); g.translate(o[0], o[1]);
    for (i = 0; i < 520; i++) {
      var sa = rng.range(0, 6.283);
      var sr = Math.pow(rng.next(), 0.6) * S * 0.48;
      g.save();
      g.translate(S * 0.5 + Math.cos(sa) * sr, S * 0.5 + Math.sin(sa) * sr);
      g.rotate(rng.range(0, 6.283));
      // straw is warm, but only just: this is the one legitimately warm mark in
      // the level and it is 4 m from a barn door, not in the middle of a road
      g.fillStyle = 'rgba(' + rng.pick(['186,174,140', '164,150,116', '138,126,98', '198,188,160']) +
        ',' + rng.range(0.5, 0.95).toFixed(2) + ')';
      g.fillRect(0, 0, rng.range(S * 0.02, S * 0.10), rng.range(S * 0.003, S * 0.010));
      g.restore();
    }
    g.restore();

    // ---- diesel, grit and the slush a stalled lorry stands in ---------------
    // COOLED, deliberately. The warm version of this cell produced a salmon
    // ground patch at the checkpoint measuring RGB (0.537, 0.487, 0.483) at
    // saturation 0.101 in a frame whose global saturation is 0.055 - the most
    // chromatic thing on screen, in a level whose brief is white and pale blue.
    // A single warm blotch in a whiteout reads as a bug, not as storytelling.
    // Trodden slush IS blue-grey: it is snow with grit in it, seen under a sky
    // that is the only light source in the level.
    o = origin(CELL.diesel);
    g.save(); g.translate(o[0], o[1]);
    var dg = g.createRadialGradient(S * 0.5, S * 0.5, S * 0.02, S * 0.5, S * 0.5, S * 0.5);
    // Half the old opacity. At 0.80 in the centre this photographed on lying
    // snow as a hard-edged black ELLIPSE - an oil slick with a perfectly round
    // outline, which is two items on the instant-fail list in one card. A
    // diesel drip in a snow-covered village is a stain you notice, not a pool.
    dg.addColorStop(0, 'rgba(19,21,27,0.40)');
    dg.addColorStop(0.30, 'rgba(35,39,49,0.27)');
    dg.addColorStop(0.68, 'rgba(64,71,84,0.13)');
    dg.addColorStop(1, 'rgba(80,88,102,0.0)');
    g.fillStyle = dg; g.fillRect(0, 0, S, S);
    // the rainbow film at the edge of a fuel spill, faint - it is a wet mark on
    // a frozen level and overselling it would be a lie
    for (i = 0; i < 5; i++) {
      g.strokeStyle = 'rgba(' + ['104,96,132', '86,112,128', '96,104,96'][i % 3] + ',0.11)';
      g.lineWidth = S * 0.02;
      g.beginPath();
      g.ellipse(S * 0.5, S * 0.5, S * (0.18 + i * 0.055), S * (0.14 + i * 0.048),
        0.4, 0, 6.283);
      g.stroke();
    }
    for (i = 0; i < 700; i++) {
      var ga = rng.range(0, 6.283), gr2 = Math.pow(rng.next(), 0.5) * S * 0.5;
      var v = rng.range(0.12, 0.5);
      g.fillStyle = 'rgba(' + Math.round(44 + v * 84) + ',' + Math.round(51 + v * 92) +
        ',' + Math.round(63 + v * 106) + ',' + (0.22 + v).toFixed(2) + ')';
      g.fillRect(S * 0.5 + Math.cos(ga) * gr2, S * 0.5 + Math.sin(ga) * gr2,
        rng.range(0.6, 2.2), rng.range(0.6, 2.2));
    }
    g.restore();
    return c;
  };

  // ---- an invented Cyrillic-ish village board -----------------------------
  // Letterforms only: real words would be an assertion this build cannot back
  // up, and a legible language nobody can read is more distracting than a
  // plausible one nobody tries to.
  function glyph(g, x, y, h, rng) {
    var w = h * rng.range(0.44, 0.72);
    g.lineWidth = Math.max(1.4, h * 0.15);
    g.lineCap = 'square';
    var kind = rng.int(0, 7);
    g.beginPath();
    if (kind === 0) { g.moveTo(x, y); g.lineTo(x, y - h); g.lineTo(x + w, y - h); g.lineTo(x + w, y); }
    else if (kind === 1) {
      g.moveTo(x, y); g.lineTo(x, y - h); g.moveTo(x, y - h * 0.52); g.lineTo(x + w, y - h * 0.52);
      g.moveTo(x + w, y); g.lineTo(x + w, y - h);
    } else if (kind === 2) {
      g.moveTo(x, y); g.lineTo(x + w * 0.5, y - h); g.lineTo(x + w, y);
      g.moveTo(x + w * 0.18, y - h * 0.34); g.lineTo(x + w * 0.82, y - h * 0.34);
    } else if (kind === 3) {
      g.moveTo(x, y - h); g.lineTo(x + w, y - h); g.moveTo(x + w * 0.5, y - h); g.lineTo(x + w * 0.5, y);
    } else if (kind === 4) {
      g.moveTo(x, y); g.lineTo(x, y - h); g.lineTo(x + w * 0.8, y - h);
      g.lineTo(x + w * 0.8, y - h * 0.5); g.lineTo(x, y - h * 0.5);
    } else if (kind === 5) {
      g.moveTo(x, y - h); g.lineTo(x, y); g.lineTo(x + w, y); g.lineTo(x + w, y - h);
      g.moveTo(x + w, y - h * 0.5); g.lineTo(x + w * 1.22, y - h * 0.5);
    } else if (kind === 6) {
      g.moveTo(x, y - h); g.lineTo(x + w, y); g.moveTo(x + w, y - h); g.lineTo(x, y);
    } else {
      g.moveTo(x, y - h); g.lineTo(x, y); g.moveTo(x, y - h * 0.5); g.lineTo(x + w, y - h * 0.5);
      g.moveTo(x + w, y - h); g.lineTo(x + w, y);
    }
    g.stroke();
    return w * 1.42;
  }

  TX.sign = function (w, h, rng, opt) {
    var c = TX.canvas(w, h);
    if (!c) return null;
    var g = c.getContext('2d');
    if (!g) return null;
    opt = opt || {};
    g.fillStyle = opt.bg || '#4a5a63';
    g.fillRect(0, 0, w, h);
    // plank grain
    var i;
    for (i = 0; i < 220; i++) {
      g.fillStyle = 'rgba(0,0,0,' + rng.range(0.02, 0.10).toFixed(3) + ')';
      g.fillRect(0, rng.range(0, h), w, rng.range(0.6, 2.0));
    }
    g.strokeStyle = opt.frame || '#8d9aa2';
    g.lineWidth = Math.max(2, h * 0.045);
    g.strokeRect(h * 0.06, h * 0.06, w - h * 0.12, h - h * 0.12);
    g.strokeStyle = opt.fg || '#dbe6ee';
    var x = w * 0.13, base = h * 0.62, gh = h * 0.30;
    var nG = opt.glyphs || 8;
    for (i = 0; i < nG && x < w * 0.90; i++) {
      x += glyph(g, x, base, gh, rng);
      if (rng.next() < 0.12) x += gh * 0.4;
    }
    if (opt.sub) {
      g.strokeStyle = 'rgba(219,230,238,0.72)';
      var x2 = w * 0.16, gh2 = h * 0.15;
      for (i = 0; i < 6 && x2 < w * 0.86; i++) x2 += glyph(g, x2, h * 0.90, gh2, rng);
    }
    // paint loss, rust bleed from the fixings, and snow plastered on the
    // windward third
    for (i = 0; i < 90; i++) {
      g.fillStyle = 'rgba(74,58,44,' + rng.range(0.10, 0.50).toFixed(2) + ')';
      g.beginPath();
      g.ellipse(rng.range(0, w), rng.range(0, h), rng.range(1, h * 0.06),
        rng.range(1, h * 0.05), rng.range(0, 3), 0, 6.283);
      g.fill();
    }
    var sg = g.createLinearGradient(0, 0, w * 0.55, h);
    sg.addColorStop(0, 'rgba(234,242,252,0.62)');
    sg.addColorStop(1, 'rgba(234,242,252,0.0)');
    g.fillStyle = sg;
    g.fillRect(0, 0, w, h * 0.42);
    return c;
  };

  // ---- chimney smoke -------------------------------------------------------
  // A vertical alpha ribbon.  Woodsmoke in a whiteout is a DARK mark, not a
  // white one - which is exactly why it is worth having: it is one of the few
  // things in the level that separates from the sky at 30 m.
  TX.smoke = function (size, rng) {
    var c = TX.canvas(size, size);
    if (!c) return null;
    var g = c.getContext('2d');
    if (!g) return null;
    g.clearRect(0, 0, size, size);
    var i, j;
    for (i = 0; i < 150; i++) {
      var t = i / 150;
      var x = size * (0.5 + Math.sin(t * 5.1 + 1.2) * 0.16 * t + rng.gaussian(0, 0.045));
      var y = size * (0.98 - t * 0.96);
      var r = size * (0.035 + t * 0.30) * rng.range(0.6, 1.25);
      var a = (1 - t) * (1 - t) * 0.30 * rng.range(0.5, 1.2);
      var gg = g.createRadialGradient(x, y, 0, x, y, r);
      var v = Math.round(78 + t * 74);
      gg.addColorStop(0, 'rgba(' + v + ',' + (v + 3) + ',' + (v + 8) + ',' + a.toFixed(3) + ')');
      gg.addColorStop(1, 'rgba(' + v + ',' + (v + 3) + ',' + (v + 8) + ',0)');
      g.fillStyle = gg;
      g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
    }
    // hot dense core just off the pot
    for (j = 0; j < 22; j++) {
      var ty = size * (0.98 - j * 0.006);
      var gr = g.createRadialGradient(size * 0.5, ty, 0, size * 0.5, ty, size * 0.05);
      gr.addColorStop(0, 'rgba(56,54,52,0.42)');
      gr.addColorStop(1, 'rgba(56,54,52,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(size * 0.5, ty, size * 0.05, 0, 6.283); g.fill();
    }
    return c;
  };

  // ==========================================================================
  // Geometry kit.
  //
  // Every builder returns geometry whose origin is at the BASE CENTRE of the
  // prop (y = 0 is ground contact), so placing it is "put it at the ground
  // height".  Silhouette detail is the priority, because in a whiteout the
  // silhouette is very nearly all there is: at 30 m through 0.026 fog a crate
  // is a dark rectangle and the only thing telling you it is a crate is the
  // corner batten, the lid lip and the broken slat.
  // ==========================================================================
  var K = {};

  function box(w, h, d, bevel) { return Geo.bevelBox(w, h, d, bevel === undefined ? 0.008 : bevel); }
  function cyl(rt, rb, h, seg, open) {
    return new THREE.CylinderGeometry(rt, rb, h, seg || 10, 1, !!open);
  }
  function tube(r, t, seg, tseg) { return new THREE.TorusGeometry(r, t, tseg || 6, seg || 12); }

  // ---- firewood ------------------------------------------------------------
  // A split billet: one flat riven face, the rest round with bark.  ~0.36 m,
  // which is a stove length.  Six hundred of these make the woodpiles, so it is
  // deliberately cheap - the read comes from the STACK, not the stick.
  K.billet = function (noise, rng, split) {
    var seg = split ? 5 : 7;
    var g = cyl(rng.range(0.048, 0.070), rng.range(0.052, 0.076), 0.36, seg);
    var p = g.attributes.position;
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      // the riven face: everything past the split plane is pushed onto it, so
      // the billet has one dead-flat side like a real split log
      if (split && x > 0.012) x = 0.012 + (x - 0.012) * 0.12;
      var n = noise ? noise.fbm3(x * 9, y * 5, z * 9, 2, 2.1, 0.5) : 0;
      p.setXYZ(i, x * (1 + n * 0.16), y, z * (1 + n * 0.16));
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    g.rotateZ(Math.PI * 0.5);         // lie it down along X
    g.translate(0, 0.058, 0);
    return g;
  };

  // A sawn round: the chopping block, and the ends of a timber stack.
  K.logRound = function (noise, rng) {
    var h = rng.range(0.30, 0.44);
    var g = cyl(rng.range(0.17, 0.24), rng.range(0.19, 0.26), h, 11);
    roughen(g, noise, 0.018, 4.0, 'radial');
    var P = [part(g, Tn(0, h * 0.5, 0))];
    // the radial checking a round always splits into as it dries
    for (var i = 0; i < 3; i++) {
      var a = rng.range(0, 6.283);
      P.push(part(box(0.012, 0.02, rng.range(0.10, 0.20)),
        Tn(Math.cos(a) * 0.08, h - 0.006, Math.sin(a) * 0.08, 0, -a, 0)));
    }
    var out = mergeParts(P, 2.2);
    disposeParts(P);
    return out;
  };

  // A loose board.  One end broken rather than sawn, two nails still in it.
  K.plank = function (rng) {
    var L = rng.range(0.85, 1.35), W = rng.range(0.13, 0.20);
    var P = [part(box(L, 0.028, W, 0.004), Tn(0, 0.014, 0))];
    // splintered end
    for (var i = 0; i < 4; i++) {
      P.push(part(box(rng.range(0.03, 0.11), 0.020, W / 4.6, 0.002),
        Tn(L * 0.5 + rng.range(0.01, 0.05), 0.014 + rng.range(-0.006, 0.006),
          -W * 0.5 + (i + 0.5) * W / 4, 0, rng.range(-0.2, 0.2), rng.range(-0.25, 0.25))));
    }
    P.push(part(cyl(0.006, 0.006, 0.05, 5), Tn(-L * 0.34, 0.035, W * 0.22)));
    P.push(part(cyl(0.010, 0.010, 0.006, 6), Tn(-L * 0.34, 0.058, W * 0.22)));
    var out = mergeParts(P, 2.4);
    disposeParts(P);
    return out;
  };

  // ---- containers ----------------------------------------------------------
  // A slatted wooden crate.  Gaps between the slats are what makes it read as a
  // crate rather than a box, and they are also where the snow gets in.
  K.crate = function (rng, w, h, d) {
    w = w || 0.62; h = h || 0.50; d = d || 0.52;
    var P = [];
    var hw = w * 0.5, hd = d * 0.5;
    var nS = 4, i, s;
    for (s = 0; s < 4; s++) {
      var alongX = s < 2;
      var len = alongX ? w : d;
      var off = alongX ? (s ? hd : -hd) : (s === 2 ? -hw : hw);
      for (i = 0; i < nS; i++) {
        var y = 0.045 + (i + 0.5) * (h - 0.06) / nS;
        var th = (h - 0.06) / nS * rng.range(0.66, 0.86);
        var jit = rng.range(-0.006, 0.006);
        if (alongX) P.push(part(box(len, th, 0.022, 0.003), Tn(0, y + jit, off)));
        else P.push(part(box(0.022, th, len, 0.003), Tn(off, y + jit, 0)));
      }
    }
    // corner battens - the structural read, and the bit that survives at 30 m
    for (i = 0; i < 4; i++) {
      var sx = (i & 1) ? 1 : -1, sz = (i & 2) ? 1 : -1;
      P.push(part(box(0.05, h, 0.05, 0.005), Tn(sx * (hw - 0.012), h * 0.5, sz * (hd - 0.012))));
    }
    // lid, sat slightly proud and skewed on one crate in three
    var lidR = rng.next() < 0.34 ? rng.range(-0.10, 0.10) : 0;
    for (i = 0; i < 3; i++) {
      P.push(part(box(w * 0.99, 0.024, d / 3 * 0.90, 0.004),
        Tn(0, h + 0.012, -hd + (i + 0.5) * d / 3, 0, lidR, 0)));
    }
    P.push(part(box(w * 0.99, 0.022, 0.05, 0.004), Tn(0, h + 0.030, 0, 0, lidR, 0)));
    // a stencil batten and a rope handle end
    P.push(part(box(0.06, 0.16, 0.014, 0.003), Tn(-hw * 0.45, h * 0.55, -hd - 0.010)));
    var out = mergeParts(P, 2.0);
    disposeParts(P);
    return out;
  };

  // A military ammunition chest: steel-strapped corners, a lid rim, two throw
  // latches and a rope becket at each end.
  K.ammoBox = function () {
    var w = 0.74, h = 0.30, d = 0.34;
    var P = [part(box(w, h, d, 0.010), Tn(0, h * 0.5, 0))];
    P.push(part(box(w * 1.01, 0.045, d * 1.01, 0.008), Tn(0, h + 0.020, 0)));
    P.push(part(box(w * 0.94, 0.018, d * 0.94, 0.005), Tn(0, h + 0.050, 0)));
    var i, s;
    for (i = 0; i < 4; i++) {
      var sx = (i & 1) ? 1 : -1, sz = (i & 2) ? 1 : -1;
      P.push(part(box(0.10, h + 0.05, 0.020, 0.003), Tn(sx * (w * 0.5 - 0.03), h * 0.5 + 0.02, sz * (d * 0.5 + 0.004))));
      P.push(part(box(0.020, h + 0.05, 0.10, 0.003), Tn(sx * (w * 0.5 + 0.004), h * 0.5 + 0.02, sz * (d * 0.5 - 0.03))));
    }
    for (s = -1; s <= 1; s += 2) {
      P.push(part(box(0.09, 0.075, 0.028, 0.005), Tn(s * 0.22, h - 0.03, d * 0.5 + 0.014)));
      P.push(part(box(0.05, 0.030, 0.020, 0.004), Tn(s * 0.22, h + 0.028, d * 0.5 + 0.016)));
      // rope becket
      P.push(part(tube(0.055, 0.014, 10, 5), Tn(s * (w * 0.5 + 0.012), h * 0.62, 0, 0, Math.PI * 0.5, 0)));
    }
    P.push(part(box(0.34, 0.11, 0.006, 0.002), Tn(0.04, h * 0.52, d * 0.5 + 0.006)));
    var out = mergeParts(P, 2.2);
    disposeParts(P);
    return out;
  };

  // 200 litre drum.  Two rolling hoops and a chime at each end - without them a
  // drum is a cylinder, and a cylinder is a placeholder.
  K.drum = function (noise) {
    var pr = [];
    function v(r, y) { pr.push(new THREE.Vector2(Math.max(0.001, r), y)); }
    v(0.001, 0); v(0.275, 0); v(0.286, 0.020); v(0.286, 0.055);
    v(0.276, 0.085); v(0.276, 0.235); v(0.300, 0.262); v(0.300, 0.300);
    v(0.276, 0.328); v(0.276, 0.545); v(0.300, 0.572); v(0.300, 0.610);
    v(0.276, 0.638); v(0.276, 0.800); v(0.286, 0.830); v(0.286, 0.865);
    v(0.272, 0.884); v(0.001, 0.884);
    var g = new THREE.LatheGeometry(pr, 16);
    roughen(g, noise, 0.010, 3.2, 'radial');
    var P = [part(g, null)];
    P.push(part(cyl(0.040, 0.040, 0.022, 8), Tn(0.16, 0.892, 0.05)));
    P.push(part(cyl(0.026, 0.026, 0.018, 6), Tn(-0.14, 0.890, -0.09)));
    var out = mergeParts(P, 1.7);
    disposeParts(P);
    return out;
  };

  // 20 litre jerrycan: X-swaged flanks, the three-finger handle, a screw spout.
  K.jerry = function () {
    var prof = [
      new THREE.Vector2(-0.083, 0.0), new THREE.Vector2(0.083, 0.0),
      new THREE.Vector2(0.083, 0.40), new THREE.Vector2(0.060, 0.455),
      new THREE.Vector2(-0.060, 0.455), new THREE.Vector2(-0.083, 0.40)
    ];
    var P = [part(extrudeProfile(prof, 0.34, 2.0), Tn(0, 0, 0))];
    var i, s;
    // the pressed X on each flank
    for (s = -1; s <= 1; s += 2) {
      for (i = -1; i <= 1; i += 2) {
        P.push(part(box(0.020, 0.30, 0.012, 0.002),
          Tn(s * 0.084, 0.21, 0, 0, Math.PI * 0.5, i * 0.72)));
      }
      P.push(part(box(0.012, 0.34, 0.014, 0.002), Tn(s * 0.086, 0.21, 0, 0, Math.PI * 0.5, 0)));
    }
    // handles
    for (i = -1; i <= 1; i++) {
      P.push(part(box(0.030, 0.030, 0.11, 0.006), Tn(i * 0.052, 0.485, -0.02)));
    }
    P.push(part(box(0.150, 0.026, 0.028, 0.005), Tn(0, 0.500, 0.03)));
    P.push(part(cyl(0.032, 0.034, 0.055, 8), Tn(0.0, 0.485, 0.115)));
    P.push(part(cyl(0.038, 0.038, 0.016, 8), Tn(0.0, 0.516, 0.115)));
    var out = mergeParts(P, 2.4);
    disposeParts(P);
    return out;
  };

  // A slumped hessian sack.  Built as a lathe and then squashed, because a sack
  // with a circular plan has never held anything.
  K.sack = function (noise, rng) {
    var pr = [];
    function v(r, y) { pr.push(new THREE.Vector2(Math.max(0.001, r), y)); }
    v(0.001, 0); v(0.20, 0.005); v(0.245, 0.10); v(0.250, 0.26);
    v(0.205, 0.40); v(0.115, 0.475); v(0.055, 0.510); v(0.070, 0.545);
    v(0.030, 0.575); v(0.001, 0.580);
    var g = new THREE.LatheGeometry(pr, 12);
    var p = g.attributes.position;
    var sx = rng.range(0.86, 1.14), sz = rng.range(0.86, 1.14);
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i) * sx, y = p.getY(i), z = p.getZ(i) * sz;
      var n = noise ? noise.fbm3(x * 5.5, y * 5.5, z * 5.5, 3, 2.1, 0.55) : 0;
      p.setXYZ(i, x + n * 0.030, y + n * 0.012, z + n * 0.030);
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    var P = [part(g, null)];
    P.push(part(tube(0.052, 0.016, 8, 4), Tn(0, 0.520, 0, Math.PI * 0.5, 0, 0)));
    var out = mergeParts(P, 2.0);
    disposeParts(P);
    return out;
  };

  // Galvanised pail: tapered body, rolled rim, swing bail.
  K.pail = function () {
    var P = [];
    var pr = [];
    function v(r, y) { pr.push(new THREE.Vector2(Math.max(0.001, r), y)); }
    v(0.001, 0); v(0.112, 0); v(0.115, 0.012); v(0.140, 0.24);
    v(0.147, 0.265); v(0.140, 0.278); v(0.134, 0.262); v(0.108, 0.020);
    v(0.001, 0.016);
    P.push(part(new THREE.LatheGeometry(pr, 14), null));
    P.push(part(tube(0.144, 0.010, 14, 5), Tn(0, 0.266, 0, Math.PI * 0.5, 0, 0)));
    P.push(part(tube(0.128, 0.006, 14, 4), Tn(0, 0.150, 0, Math.PI * 0.5, 0, 0)));
    // bail, fallen to one side the way a bucket handle always is
    var seg = 7;
    for (var i = 0; i < seg; i++) {
      var a0 = Math.PI * i / seg, a1 = Math.PI * (i + 1) / seg;
      var x0 = Math.cos(a0) * 0.140, y0 = 0.255 + Math.sin(a0) * 0.055;
      var x1 = Math.cos(a1) * 0.140, y1 = 0.255 + Math.sin(a1) * 0.055;
      P.push(part(cyl(0.006, 0.006, Math.hypot(x1 - x0, y1 - y0), 5),
        strut(x0, y0, 0.03, x1, y1, 0.03)));
    }
    var out = mergeParts(P, 2.4);
    disposeParts(P);
    return out;
  };

  // A truck tyre with real tread blocks and a wheel centre.
  K.tyre = function (noise, rng) {
    var R = 0.50, sec = 0.155;
    var g = tube(R, sec, 18, 8);
    roughen(g, noise, 0.010, 3.0, 'radial');
    var P = [part(g, Tn(0, 0, 0, Math.PI * 0.5, 0, 0))];
    var n = 16, i;
    for (i = 0; i < n; i++) {
      var a = i / n * 6.283;
      P.push(part(box(0.115, 0.052, sec * 1.55, 0.008),
        Tn(Math.cos(a) * (R + sec * 0.86), Math.sin(a) * (R + sec * 0.86), 0,
          0, 0, a + Math.PI * 0.5 + (i % 2 ? 0.18 : -0.18))));
    }
    P.push(part(cyl(0.20, 0.20, sec * 1.5, 12), Tn(0, 0, 0, Math.PI * 0.5, 0, 0)));
    P.push(part(cyl(0.085, 0.085, sec * 1.7, 8), Tn(0, 0, 0, Math.PI * 0.5, 0, 0)));
    for (i = 0; i < 6; i++) {
      var b = i / 6 * 6.283;
      P.push(part(cyl(0.020, 0.020, sec * 1.8, 5),
        Tn(Math.cos(b) * 0.13, Math.sin(b) * 0.13, 0, Math.PI * 0.5, 0, 0)));
    }
    var out = mergeParts(P, 1.9);
    disposeParts(P);
    void rng;
    return out;
  };

  K.pallet = function (rng) {
    var P = [];
    var i;
    for (i = 0; i < 3; i++) {
      P.push(part(box(0.10, 0.075, 0.80, 0.006), Tn(-0.55 + i * 0.55, 0.038, 0)));
    }
    for (i = 0; i < 7; i++) {
      var g2 = 1.20 / 7;
      P.push(part(box(g2 * 0.80, 0.020, 0.80, 0.004),
        Tn(-0.60 + (i + 0.5) * g2, 0.086, rng.range(-0.012, 0.012))));
    }
    for (i = 0; i < 3; i++) {
      P.push(part(box(1.20, 0.020, 0.09, 0.004), Tn(0, 0.0095, -0.34 + i * 0.34)));
    }
    var out = mergeParts(P, 2.0);
    disposeParts(P);
    return out;
  };

  // ---- churchyard ----------------------------------------------------------
  // The three-bar Orthodox cross.  It is the single most recognisable
  // silhouette a Russian village can put on a skyline, the slanted footrest is
  // the whole read, and a plain Latin cross here would be quietly wrong.
  K.cross = function (rng) {
    var H = rng.range(1.15, 1.55);
    var P = [part(box(0.085, H, 0.070, 0.006), Tn(0, H * 0.5, 0))];
    P.push(part(box(0.34, 0.060, 0.055, 0.005), Tn(0, H * 0.80, 0)));
    P.push(part(box(0.56, 0.075, 0.060, 0.006), Tn(0, H * 0.62, 0)));
    P.push(part(box(0.34, 0.055, 0.052, 0.005), Tn(0, H * 0.34, 0, 0, 0, rng.range(0.32, 0.46))));
    // a small roof over the head, which most of them have
    if (rng.next() < 0.45) {
      P.push(part(box(0.24, 0.030, 0.16, 0.004), Tn(0, H + 0.02, 0, 0.22, 0, 0)));
      P.push(part(box(0.24, 0.030, 0.16, 0.004), Tn(0, H + 0.02, 0, -0.22, 0, 0)));
    }
    var out = mergeParts(P, 2.2);
    disposeParts(P);
    return out;
  };

  K.headstone = function (noise, rng) {
    var w = rng.range(0.34, 0.52), h = rng.range(0.46, 0.80), d = rng.range(0.09, 0.15);
    var P = [part(box(w, h, d, 0.012), Tn(0, h * 0.5, 0))];
    P.push(part(cyl(w * 0.5, w * 0.5, d, 8, false), Tn(0, h, 0, Math.PI * 0.5, 0, 0)));
    P.push(part(box(w * 1.35, 0.10, d * 2.0, 0.010), Tn(0, 0.05, 0)));
    var out = mergeParts(P, 1.6);
    disposeParts(P);
    if (out) roughen(out, noise, 0.010, 3.4);
    return out;
  };

  // Masonry / concrete rubble.  Angular, never spherical: this is broken
  // material, not a pebble.
  K.chunk = function (noise, rng) {
    var g = new THREE.BoxGeometry(1, 0.7, 0.85, 2, 2, 2);
    var p = g.attributes.position;
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      var n1 = noise.fbm3(x * 2.2 + 4, y * 2.2, z * 2.2 - 3, 2, 2.1, 0.6);
      var n2 = noise.fbm3(x * 4.6 - 9, y * 4.6 + 2, z * 4.6 + 7, 2, 2.1, 0.6);
      p.setXYZ(i, x * (1 + n1 * 0.34) + n2 * 0.06,
        Math.max(-0.35, y * (1 + n1 * 0.26)) + n2 * 0.05,
        z * (1 + n1 * 0.30) + n2 * 0.06);
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    g.translate(0, 0.35, 0);
    g.scale(rng.range(0.5, 1.0), rng.range(0.4, 0.9), rng.range(0.5, 1.0));
    return g;
  };

  // ---- life ----------------------------------------------------------------
  // A hooded crow, hunched.  In a blizzard nothing flies; they sit with their
  // backs to the wind and their heads down, and that pose is the whole point -
  // a bird with its wings out would say "fair weather" louder than any sky.
  K.raven = function () {
    var P = [];
    var body = new THREE.SphereGeometry(0.085, 10, 8);
    body.scale(1.0, 0.92, 1.7);
    P.push(part(body, Tn(0, 0.095, 0)));
    var head = new THREE.SphereGeometry(0.050, 8, 6);
    P.push(part(head, Tn(0, 0.145, -0.105)));
    P.push(part(cyl(0.004, 0.020, 0.055, 5), Tn(0, 0.140, -0.165, Math.PI * 0.5, 0, 0)));
    // folded wing coverts, and the tail
    for (var s = -1; s <= 1; s += 2) {
      var wg = new THREE.SphereGeometry(0.055, 8, 6);
      wg.scale(0.45, 0.75, 1.55);
      P.push(part(wg, Tn(s * 0.062, 0.100, 0.012, 0, s * 0.10, 0)));
    }
    P.push(part(box(0.055, 0.016, 0.13, 0.004), Tn(0, 0.075, 0.155, -0.28, 0, 0)));
    for (var f = -1; f <= 1; f += 2) {
      P.push(part(cyl(0.006, 0.006, 0.045, 4), Tn(f * 0.028, 0.022, -0.02)));
    }
    var out = mergeParts(P, 3.0);
    disposeParts(P);
    return out;
  };

  // ---- snow ----------------------------------------------------------------
  // A snow cap over a w x d footprint.  Not a slab: it is a pillow, thickest a
  // little downwind of centre, with the rim rolled over and hanging BELOW the
  // surface it is lying on so it welds to the prop instead of sitting on it,
  // and with the windward edge scoured thinner than the lee edge.  That
  // asymmetry is most of why a cap reads as wind-made rather than as a lid.
  K.snowCap = function (w, d, h, noise, seed, lee) {
    var n = 6, i, j;
    var pos = [], idx = [];
    var lx = lee ? lee[0] : WIND_X, lz = lee ? lee[1] : WIND_Z;
    for (j = 0; j <= n; j++) {
      for (i = 0; i <= n; i++) {
        var u = i / n - 0.5, v = j / n - 0.5;
        var x = u * w, z = v * d;
        // A SUPERELLIPSE, not a Chebyshev square. The old max(|u|,|v|) metric
        // gives a cap with four right-angled plan corners and a rim that steps
        // to a constant negative in one cell, and 1,500 of those lying on props
        // is the same "rectangular white slab" the berm blocks were rightly
        // called out for. At exponent 3.0 the cap keeps its rectangular identity
        // and loses its points.
        var au = Math.abs(u * 2), av = Math.abs(v * 2);
        var rr = Math.pow(au * au * au + av * av * av, 1 / 3);            // 0..~1
        var fall = 1 - M.smoothstep(0.50, 1.02, rr);
        // drift bias: thicker on the lee side of the top face
        var bias = 1 + 0.42 * ((u * 2) * lx + (v * 2) * lz);
        var nz2 = noise ? noise.fbm2(x * 2.3 + (seed || 0), z * 2.3 - (seed || 0), 3) : 0;
        var y = h * fall * bias * (0.82 + nz2 * 0.42);
        // the lip rolls over the arris and finishes BELOW the face it lies on,
        // continuously, so there is no rim to catch a highlight on
        y -= Math.min(0.055, h * 0.5) * M.smoothstep(0.72, 1.02, rr);
        pos.push(x, Math.max(-0.08, y), z);
      }
    }
    for (j = 0; j < n; j++) {
      for (i = 0; i < n; i++) {
        var a = j * (n + 1) + i, b = a + 1, c = a + n + 1, e = c + 1;
        idx.push(a, c, b, b, c, e);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g.toNonIndexed ? (function () { var t = g.toNonIndexed(); g.dispose(); return t; })() : g;
  };

  // ---- THE COLLAR ----------------------------------------------------------
  // A ring of snow banked round the foot of something standing in it, welded
  // into the surface rather than sitting on it.
  //
  // This is the fix for the level's most damaging measured defect. A vertical
  // luminance profile through the marker pole in enemy_closeup: pole 0.368,
  // snow 0.434, then 0.437 +/- 0.004 for the next 64 pixels - sixty-four pixels
  // of mathematically flat snow directly beneath a 1.55 m post. Under bucket A:
  // body 0.307, then a 0.21 jump to 0.518 in nine pixels with no gradient. The
  // _settle() machinery is elaborate and correct and it solves Y; Y was never
  // what the eye reads. What reads is contact - a drift collar, a scour seam,
  // and a darkening in the ground under the object, and this is the first of
  // the three.
  //
  // Deliberately not a circle: proud and banked on the lee (+WIND_X, +WIND_Z),
  // scoured to nothing upwind, and the outer rim sinks BELOW the surrounding
  // surface so it cannot read as a washer lying on the ground.
  K.snowCollar = function (r, h, noise, seed) {
    var seg = 10, rings = 3;
    var inR = Math.max(0.030, r * 0.55);
    var grid = [], ri, si;
    for (ri = 0; ri <= rings; ri++) {
      var t = ri / rings;
      var row = [];
      for (si = 0; si <= seg; si++) {
        var a = (si % seg) / seg * Math.PI * 2;
        var c = Math.cos(a), s = Math.sin(a);
        var lee = M.saturate((c * WIND_X + s * WIND_Z) * 0.5 + 0.5);
        // Smooth and periodic in the azimuth. A per-vertex hash here makes
        // adjacent segments differ by half their radius, and a ten-segment ring
        // carrying that is a white star sitting on the snow rather than a bank
        // growing out of it.
        var ph = (seed || 0) * 0.618;
        var jit = 0.88 + 0.13 * Math.sin(a * 2 + ph) + 0.08 * Math.sin(a * 3 - ph * 1.7);
        var rOut = r * (0.92 + 0.78 * lee * lee) * jit;
        var rr = inR + (rOut - inR) * t;
        var prof = (1 - t) * 0.50 + Math.max(0, 1 - Math.abs((t - 0.32) / 0.64)) * 0.78;
        var yy = h * (0.28 + 1.15 * lee) * jit * prof - 0.045 * t * t;
        row.push([c * rr, yy, s * rr]);
      }
      grid.push(row);
    }
    var pos = [], nor = [];
    function tri(A, Bv, C) {
      var ux = Bv[0] - A[0], uy = Bv[1] - A[1], uz = Bv[2] - A[2];
      var vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      pos.push(A[0], A[1], A[2], Bv[0], Bv[1], Bv[2], C[0], C[1], C[2]);
      nor.push(nx / l, ny / l, nz / l, nx / l, ny / l, nz / l, nx / l, ny / l, nz / l);
    }
    for (ri = 0; ri < rings; ri++) {
      for (si = 0; si < seg; si++) {
        tri(grid[ri][si], grid[ri][si + 1], grid[ri + 1][si + 1]);
        tri(grid[ri][si], grid[ri + 1][si + 1], grid[ri + 1][si]);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    return g;
  };

  // A free drift lump: banked snow against a wall, a wheel, a fence post.
  //
  // NORMALISED, AND THAT IS A BUG FIX WITH A MEASUREMENT BEHIND IT. The first
  // version squashed a 0.5-radius sphere with `Math.max(0, y * (0.44 + n))`, so
  // its local height came out at 0.22-0.31 while its half-width stayed 0.5 - and
  // _drift then scaled y by r * (0.40..0.88) and sank the whole thing by
  // r * 0.55 "to nearly half its height". Work it through: the world height is
  // 0.31 x 0.64 x r = 0.20r and the sink is 0.55r, so the top of every drift in
  // the level sat 0.35r BELOW the surface it was banked against. All 900 of them
  // were invisible, which is exactly why the verifier saw only the hard-edged
  // pieces and called the drift field polystyrene: the smooth wind-made half of
  // it was never on screen.
  //
  // The shape is now normalised to x, z in [-0.5, 0.5] and y in [-0.13, 1], so
  // the instance scale in _drift IS the bank's size in metres and the shallow
  // negative skirt is what beds the rim into the ground instead of ending it on
  // a hard circle.
  K.snowLump = function (noise, rng) {
    // 12 x 7 rather than 9 x 6, and flatter. At the old tessellation a bank
    // scaled out to four metres across resolved into a faceted pyramid with a
    // hard apex - a drift is a smooth wind-made surface and a visible facet on
    // one is the same failure as a flat wall, just curved.
    var g = new THREE.SphereGeometry(0.5, 12, 7);
    var p = g.attributes.position;
    var i, hi = 1e-5;
    for (i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      var n1 = noise.fbm3(x * 2.6 + 11, y * 2.6, z * 2.6 - 5, 3, 2.1, 0.55);
      // squashed, and drawn out downwind into a tail
      var tail = 1 + 0.72 * M.saturate((x * WIND_X + z * WIND_Z) * 2);
      // above the waist it is a dome; below it, a shallow skirt that goes under
      // the surrounding surface so the rim can never read as a circle lying on it
      var ny = y >= 0 ? y * (0.44 + n1 * 0.18) : y * 0.13;
      if (ny > hi) hi = ny;
      p.setXYZ(i, x * (1 + n1 * 0.26) * tail, ny, z * (1 + n1 * 0.26) * tail);
    }
    // normalise the dome to exactly 1.0 tall, keeping the width at 0.5 half-extent
    var inv = 1 / hi;
    for (i = 0; i < p.count; i++) p.setY(i, p.getY(i) * inv);
    p.needsUpdate = true;
    g.computeVertexNormals();
    g.scale(rng.range(0.8, 1.3), 1, rng.range(0.8, 1.3));
    return g;
  };

  // An icicle fringe hanging from an eave.  Lengths follow a run-off pattern -
  // long where the roof valley concentrates the melt, short at the ends - and
  // never a uniform comb.
  K.icicleRow = function (span, maxLen, rng, noise) {
    var P = [];
    var n = Math.max(3, Math.round(span / rng.range(0.11, 0.19)));
    for (var i = 0; i < n; i++) {
      var t = (i + rng.range(0.2, 0.8)) / n;
      var env = Math.sin(t * Math.PI);
      var L = maxLen * (0.18 + 0.82 * env * env) * rng.range(0.45, 1.15);
      if (L < 0.05) continue;
      var r = M.clamp(0.010 + L * 0.055, 0.010, 0.045);
      var x = (t - 0.5) * span;
      var g = cyl(r * rng.range(0.85, 1.15), 0.004, L, 5);
      P.push(part(g, Tn(x, -L * 0.5, rng.range(-0.020, 0.020),
        rng.range(-0.05, 0.05), 0, rng.range(-0.09, 0.09))));
      // the shoulder of frozen run-off it grows out of
      P.push(part(cyl(r * 2.0, r * 1.1, 0.035, 5), Tn(x, -0.014, 0)));
    }
    if (!P.length) return null;
    var out = mergeParts(P, 2.6);
    disposeParts(P);
    if (out && noise) roughen(out, noise, 0.004, 8.0, 'radial');
    return out;
  };

  // ---- alpha cards ---------------------------------------------------------
  // Three cards at 60 degrees.  Two is cheaper and reads as a cross from
  // directly above, which in a level with an overview pose from a ledge is a
  // visible failure.
  K.cardCluster = function (w, h, blades, rng) {
    var P = [];
    var n = blades || 3;
    for (var i = 0; i < n; i++) {
      var a = (i / n) * Math.PI + rng.range(-0.12, 0.12);
      var ww = w * rng.range(0.82, 1.16), hh = h * rng.range(0.80, 1.20);
      P.push(part(card(ww, hh), Tn(rng.range(-0.05, 0.05) * w, 0, rng.range(-0.05, 0.05) * w,
        rng.range(-0.05, 0.05), a, rng.range(-0.06, 0.06))));
    }
    var g = null;
    try { g = Geo.mergeAll(P); } catch (e) { GAME.logError('propsS.cards', e); }
    disposeParts(P);
    if (g) Geo.copyUV1(g);
    return g;
  };

  // ---- hand tools and yard furniture --------------------------------------
  // Origin at the BUTT of the handle for the leaning tools, so "lean it against
  // the porch post" is one transform instead of trigonometry at every site.

  K.shovel = function () {
    var P = [];
    P.push(part(cyl(0.019, 0.022, 1.02, 7), Tn(0, 0.51, 0)));
    // D-grip
    P.push(part(box(0.030, 0.16, 0.020, 0.004), Tn(-0.045, 1.10, 0, 0, 0, 0.26)));
    P.push(part(box(0.030, 0.16, 0.020, 0.004), Tn(0.045, 1.10, 0, 0, 0, -0.26)));
    P.push(part(cyl(0.014, 0.014, 0.10, 5), Tn(0, 1.185, 0, 0, 0, Math.PI * 0.5)));
    // socket and the blade - a big square snow scoop, dished
    P.push(part(cyl(0.026, 0.030, 0.14, 6), Tn(0, 0.035, 0.010, 0.12, 0, 0)));
    var bl = new THREE.BoxGeometry(0.30, 0.012, 0.34, 3, 1, 3);
    var p = bl.attributes.position;
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), z = p.getZ(i);
      p.setXYZ(i, x, p.getY(i) + (x * x * 0.30 + z * z * 0.14), z);
    }
    p.needsUpdate = true; bl.computeVertexNormals();
    P.push(part(bl, Tn(0, -0.035, 0.10, 0.12, 0, 0)));
    P.push(part(box(0.32, 0.014, 0.020, 0.003), Tn(0, -0.048, 0.262, 0.12, 0, 0)));
    var out = mergeParts(P, 2.6);
    disposeParts(P);
    return out;
  };

  K.axe = function () {
    var P = [];
    P.push(part(cyl(0.017, 0.023, 0.70, 6), Tn(0, 0.35, 0)));
    P.push(part(box(0.036, 0.075, 0.13, 0.006), Tn(0, 0.70, 0.02)));
    var bit = extrudeProfile([
      new THREE.Vector2(0, -0.055), new THREE.Vector2(0.115, -0.090),
      new THREE.Vector2(0.128, 0.0), new THREE.Vector2(0.115, 0.090),
      new THREE.Vector2(0, 0.055)], 0.030, 3.0);
    P.push(part(bit, Tn(0.02, 0.705, 0.0, 0, Math.PI * 0.5, 0)));
    var out = mergeParts(P, 3.0);
    disposeParts(P);
    return out;
  };

  K.broom = function () {
    var P = [];
    P.push(part(cyl(0.015, 0.018, 1.15, 6), Tn(0, 0.575, 0)));
    for (var i = 0; i < 16; i++) {
      var a = (i / 16) * 6.283;
      P.push(part(cyl(0.004, 0.008, 0.30, 4),
        Tn(Math.cos(a) * 0.035, 0.135, Math.sin(a) * 0.035,
          Math.cos(a) * 0.30, 0, -Math.sin(a) * 0.30)));
    }
    P.push(part(tube(0.045, 0.008, 8, 4), Tn(0, 0.27, 0, Math.PI * 0.5, 0, 0)));
    var out = mergeParts(P, 2.8);
    disposeParts(P);
    return out;
  };

  // A bench: one riven slab on two log ends.  Every yard has one and it is the
  // cheapest possible signal that people sit outside here in summer.
  K.bench = function (rng) {
    var L = rng.range(1.6, 2.2);
    var P = [part(box(L, 0.075, 0.36, 0.008), Tn(0, 0.44, 0))];
    for (var s = -1; s <= 1; s += 2) {
      P.push(part(cyl(0.13, 0.15, 0.44, 9), Tn(s * (L * 0.5 - 0.28), 0.22, 0)));
    }
    P.push(part(box(L * 0.86, 0.045, 0.05, 0.005), Tn(0, 0.30, -0.13)));
    var out = mergeParts(P, 2.0);
    disposeParts(P);
    return out;
  };

  // A hand sledge (sanki) - runners, a slatted bed, a rope eye.
  K.sledge = function () {
    var P = [];
    for (var s = -1; s <= 1; s += 2) {
      var run = extrudeProfile([
        new THREE.Vector2(-0.60, 0.0), new THREE.Vector2(0.44, 0.0),
        new THREE.Vector2(0.60, 0.10), new THREE.Vector2(0.60, 0.155),
        new THREE.Vector2(0.42, 0.055), new THREE.Vector2(-0.60, 0.055)], 0.045, 2.4);
      P.push(part(run, Tn(s * 0.20, 0.0, 0, 0, Math.PI * 0.5, 0)));
      P.push(part(box(0.045, 0.20, 0.045, 0.005), Tn(s * 0.20, 0.16, -0.30)));
      P.push(part(box(0.045, 0.20, 0.045, 0.005), Tn(s * 0.20, 0.16, 0.28)));
    }
    for (var i = 0; i < 6; i++) {
      P.push(part(box(0.52, 0.020, 0.085, 0.004), Tn(0, 0.265, -0.32 + i * 0.128, 0, Math.PI * 0.5, 0)));
    }
    P.push(part(box(0.44, 0.030, 0.030, 0.005), Tn(0, 0.30, -0.42, 0, Math.PI * 0.5, 0)));
    var out = mergeParts(P, 2.2);
    disposeParts(P);
    return out;
  };

  K.ladder = function (len) {
    var P = [];
    len = len || 3.4;
    for (var s = -1; s <= 1; s += 2) {
      P.push(part(box(0.055, len, 0.070, 0.006), Tn(s * 0.19, len * 0.5, 0)));
    }
    var n = Math.round(len / 0.30);
    for (var i = 1; i < n; i++) {
      P.push(part(cyl(0.019, 0.019, 0.40, 6), Tn(0, i * len / n, 0, 0, 0, Math.PI * 0.5)));
    }
    var out = mergeParts(P, 2.4);
    disposeParts(P);
    return out;
  };

  // A road trestle: the A-frame the roads authority drops across a closed
  // carriageway.  The striped board is a separate card so it can carry paint.
  K.trestle = function () {
    var P = [];
    for (var s = -1; s <= 1; s += 2) {
      P.push(part(box(0.070, 1.02, 0.060, 0.006), Tn(s * 0.60, 0.51, -0.22, 0.36, 0, 0)));
      P.push(part(box(0.070, 1.02, 0.060, 0.006), Tn(s * 0.60, 0.51, 0.22, -0.36, 0, 0)));
      P.push(part(box(0.055, 0.030, 0.44, 0.004), Tn(s * 0.60, 0.36, 0)));
    }
    P.push(part(box(1.40, 0.045, 0.055, 0.005), Tn(0, 0.96, 0)));
    P.push(part(box(1.40, 0.030, 0.045, 0.004), Tn(0, 0.60, 0)));
    var out = mergeParts(P, 2.2);
    disposeParts(P);
    return out;
  };

  // A potbelly stove with its flue: the church is unheated and ruined, but a
  // stove that somebody dragged in and lit once is exactly the kind of detail
  // that says people sheltered here.
  K.stove = function () {
    var P = [];
    var pr = [];
    function v(r, y) { pr.push(new THREE.Vector2(Math.max(0.001, r), y)); }
    v(0.001, 0); v(0.20, 0); v(0.20, 0.055); v(0.145, 0.10);
    v(0.185, 0.24); v(0.235, 0.42); v(0.215, 0.60); v(0.150, 0.68);
    v(0.120, 0.70); v(0.120, 0.735); v(0.001, 0.735);
    P.push(part(new THREE.LatheGeometry(pr, 14), null));
    P.push(part(cyl(0.062, 0.062, 1.55, 8), Tn(0, 1.51, 0)));
    P.push(part(cyl(0.075, 0.075, 0.05, 8), Tn(0, 0.745, 0)));
    P.push(part(box(0.20, 0.19, 0.030, 0.005), Tn(0, 0.30, 0.205)));
    P.push(part(cyl(0.016, 0.016, 0.10, 5), Tn(0, 0.30, 0.235, 0, 0, Math.PI * 0.5)));
    for (var i = 0; i < 3; i++) {
      var a = i / 3 * 6.283 + 0.5;
      P.push(part(box(0.045, 0.12, 0.045, 0.005),
        Tn(Math.cos(a) * 0.15, 0.06, Math.sin(a) * 0.15, 0, -a, 0)));
    }
    var out = mergeParts(P, 2.0);
    disposeParts(P);
    return out;
  };

  // An analogion - the sloping lectern an icon is laid on.  It is the one piece
  // of furniture the interior framing genuinely needs, because without it the
  // nave is a stone box with a hole in the roof.
  K.lectern = function () {
    var P = [];
    P.push(part(box(0.46, 0.045, 0.40, 0.006), Tn(0, 0.022, 0)));
    P.push(part(box(0.14, 0.95, 0.14, 0.008), Tn(0, 0.50, 0)));
    P.push(part(box(0.56, 0.040, 0.44, 0.006), Tn(0, 1.00, 0, -0.42, 0, 0)));
    P.push(part(box(0.56, 0.030, 0.055, 0.005), Tn(0, 0.915, 0.185, -0.42, 0, 0)));
    for (var s = -1; s <= 1; s += 2) {
      P.push(part(box(0.030, 0.24, 0.030, 0.004), Tn(s * 0.13, 0.80, 0, 0, 0, s * 0.5)));
    }
    var out = mergeParts(P, 2.4);
    disposeParts(P);
    return out;
  };

  // The village well: a log crib, two posts, a windlass with a crank, a shingle
  // roof, and the bucket.  The ice cascade down the crib is added at the site.
  K.wellCrib = function (rng) {
    var P = [];
    var R = 0.62, courses = 6, i, c;
    for (c = 0; c < courses; c++) {
      var y = 0.10 + c * 0.155;
      var alt = c % 2;
      for (i = -1; i <= 1; i += 2) {
        if (alt) P.push(part(cyl(0.075, 0.080, R * 2.16, 7), Tn(i * R, y, 0, 0, 0, Math.PI * 0.5)));
        else P.push(part(cyl(0.075, 0.080, R * 2.16, 7), Tn(0, y, i * R, Math.PI * 0.5, 0, 0)));
      }
    }
    for (i = -1; i <= 1; i += 2) {
      P.push(part(box(0.11, 1.35, 0.11, 0.008), Tn(i * (R - 0.02), 1.68, 0)));
    }
    // windlass
    P.push(part(cyl(0.085, 0.085, R * 1.9, 9), Tn(0, 1.70, 0, 0, 0, Math.PI * 0.5)));
    P.push(part(cyl(0.022, 0.022, 0.24, 5), Tn(R + 0.10, 1.70, 0, 0, 0, Math.PI * 0.5)));
    P.push(part(cyl(0.020, 0.020, 0.22, 5), Tn(R + 0.20, 1.60, 0)));
    P.push(part(cyl(0.018, 0.018, 0.16, 5), Tn(R + 0.20, 1.50, 0, Math.PI * 0.5, 0, 0)));
    // roof
    for (var s = -1; s <= 1; s += 2) {
      for (i = 0; i < 5; i++) {
        P.push(part(box(0.90, 0.022, 0.26, 0.003),
          Tn(s * 0.30, 2.42 - Math.abs(s) * 0.0, -0.55 + i * 0.28, 0, 0, s * -0.62)));
      }
    }
    P.push(part(box(0.14, 0.06, 1.5, 0.006), Tn(0, 2.62, 0)));
    var out = mergeParts(P, 1.9);
    disposeParts(P);
    void rng;
    return out;
  };

  // A brazier: the top third of a drum, punched, on three legs.
  K.brazier = function (noise) {
    var P = [];
    var g = cyl(0.30, 0.275, 0.46, 14, true);
    roughen(g, noise, 0.012, 3.2, 'radial');
    P.push(part(g, Tn(0, 0.52, 0)));
    P.push(part(tube(0.298, 0.014, 14, 5), Tn(0, 0.745, 0, Math.PI * 0.5, 0, 0)));
    P.push(part(cyl(0.27, 0.27, 0.02, 12), Tn(0, 0.30, 0)));
    for (var i = 0; i < 3; i++) {
      var a = i / 3 * 6.283 + 0.4;
      P.push(part(box(0.045, 0.32, 0.045, 0.005),
        Tn(Math.cos(a) * 0.22, 0.16, Math.sin(a) * 0.22, Math.sin(a) * 0.22, -a, -Math.cos(a) * 0.22)));
    }
    var out = mergeParts(P, 2.2);
    disposeParts(P);
    return out;
  };

  // An A-frame fodder rack, and the round bale that lives beside it.
  K.fodderRack = function () {
    var P = [];
    var L = 2.6;
    for (var s = -1; s <= 1; s += 2) {
      for (var e = -1; e <= 1; e += 2) {
        P.push(part(box(0.075, 1.35, 0.075, 0.006), Tn(s * 0.46, 0.66, e * L * 0.42, 0, 0, -s * 0.34)));
      }
      for (var i = 0; i < 6; i++) {
        P.push(part(cyl(0.024, 0.024, L * 0.94, 5),
          Tn(s * (0.42 - i * 0.055), 0.28 + i * 0.19, 0, Math.PI * 0.5, 0, 0)));
      }
    }
    P.push(part(box(0.90, 0.055, L, 0.006), Tn(0, 0.10, 0)));
    var out = mergeParts(P, 2.0);
    disposeParts(P);
    return out;
  };

  K.hayBale = function (noise, rng) {
    var g = cyl(0.62, 0.62, 1.05, 14);
    var p = g.attributes.position;
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      var n = noise.fbm3(x * 3.2, y * 3.2, z * 3.2, 3, 2.1, 0.55);
      p.setXYZ(i, x * (1 + n * 0.10), y * (1 + n * 0.05), z * (1 + n * 0.10));
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    g.rotateZ(Math.PI * 0.5);
    g.translate(0, 0.60, 0);
    g.scale(1, rng.range(0.92, 1.06), rng.range(0.94, 1.08));
    return g;
  };

  // ---- cloth ---------------------------------------------------------------
  // A draped sheet.  `pin(u,v) -> 0..1` says how hard a point is held: 1 is
  // nailed down, 0 is a free corner.  The flex attribute is 1 - pin, so the
  // wind snippet lifts exactly the parts that are not tied.
  K.sheet = function (w, d, sag, nu, nv, pin, noise) {
    nu = nu || 6; nv = nv || 6;
    var pos = [], idx = [], flx = [];
    var i, j;
    for (j = 0; j <= nv; j++) {
      for (i = 0; i <= nu; i++) {
        var u = i / nu, v = j / nv;
        var hold = pin ? M.saturate(pin(u, v)) : 1;
        var slack = 1 - hold;
        var n = noise ? noise.fbm2(u * 3.1 + 5, v * 3.1 - 2, 2) : 0;
        var y = -sag * slack * (0.75 + n * 0.5) - sag * 0.10 * Math.sin(u * 5.3) * slack;
        pos.push((u - 0.5) * w, y, (v - 0.5) * d);
        flx.push(slack * slack);
      }
    }
    for (j = 0; j < nv; j++) {
      for (i = 0; i < nu; i++) {
        var a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, e = c + 1;
        idx.push(a, c, b, b, c, e);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('aFlex', new THREE.BufferAttribute(new Float32Array(flx), 1));
    g.setIndex(idx);
    g.computeVertexNormals();
    var out = g.toNonIndexed();
    g.dispose();
    return out;
  };

  // A stiff frozen garment on a line.  Boards, not folds: laundry left out in
  // this is a plank with sleeves, and that is funnier and truer than a
  // fluttering shirt.
  K.frozenGarment = function (w, h, rng) {
    var P = [];
    P.push(part(box(w, h, 0.018, 0.004), Tn(0, -h * 0.5, 0)));
    if (rng.next() < 0.6) {
      for (var s = -1; s <= 1; s += 2) {
        P.push(part(box(w * 0.34, h * 0.30, 0.016, 0.003),
          Tn(s * w * 0.58, -h * 0.30, 0, 0, 0, s * rng.range(0.10, 0.55))));
      }
    }
    var g = mergeParts(P, 2.0);
    disposeParts(P);
    if (g) setFlex(g, function (x, y) { return M.saturate(-y / Math.max(0.2, h)) * 0.55; });
    return g;
  };

  // ==========================================================================
  // GAME.PropsSnowbound
  // ==========================================================================
  function PropsSnowbound(ctx) {
    this.ctx = ctx || {};
    this.root = new THREE.Object3D();
    this.root.name = 'props_snowbound';
    this.root.matrixAutoUpdate = false;
    this.colliders = [];

    // Deterministic and independent of every other system's RNG stream, so
    // adding a snowflake somewhere else cannot reshuffle the village.
    var seed = ((this.ctx.seed || 20260801) ^ 0x5B10C4A1) >>> 0;
    this.rng = new GAME.RNG(seed);
    this.noise = new GAME.Noise((seed ^ 0x2545F491) >>> 0);

    this.time = 0;
    this.uTime = { value: 0 };
    // amplitude (m), frequency (rad/s), vertical billow, spatial phase
    this.uWind = { value: new THREE.Vector4(0.075, 3.1, 0.42, 0.62) };
    // The blizzard's own direction until ctx.weather exists.  Placement (drift
    // side, tuft lean, rag stream, the scoured flank a woodpile stands on) is
    // baked against this at build time; the animation adopts weather.windDir
    // the moment weather appears.
    this.uWindDir = { value: new THREE.Vector2(WIND_X, WIND_Z) };
    this.windDir = new THREE.Vector2(WIND_X, WIND_Z);
    this.windSpeed = 13;

    this.tex = {};
    this.mats = {};
    this.B = {};                    // instanced batches
    this.S = {                      // one-off geometry, merged per material
      wood: [], steel: [], rust: [], green: [], stone: [], concrete: [],
      canvas: [], sack: [], snow: [], ice: [], lit: [], marks: [], sign: []
    };
    this.windMeshes = [];
    this.ropePaths = [];
    this.clothParts = [];
    this.smokeParts = [];
    this.ravens = [];
    this._occ = new Map();
    this._contact = [];             // {x,z,r} handed to level.paintGroundContact
    this._skipped = 0;
    this._capCount = 0;
    this._collarCount = 0;

    this.stats = { instances: 0, drawCalls: 0, tris: 0, colliders: 0, skipped: 0, full: [] };

    // Nominal valley, overwritten by _probeLayout from level.anchors.  They
    // exist so a level that failed to build does not take this module with it.
    this.bounds = { x0: -42, x1: 42, z0: -46, z1: 62 };
    this.roadHalf = 4.6;
    this.bermW = 2.4;
    this.roadX = function () { return 0; };
    this.dachas = [];
    this.convoy = [];
    this.paths = [];

    try { if (this.ctx.scene) this.ctx.scene.add(this.root); }
    catch (e) { GAME.logError('propsS.ctor', e); }
  }

  PropsSnowbound.prototype._phase = function (name, fn) {
    try { fn.call(this); } catch (e) { GAME.logError('propsS.' + name, e); }
    return GAME.yieldFrame();
  };

  PropsSnowbound.prototype.build = async function (ctx) {
    if (ctx) this.ctx = ctx;
    await this._phase('textures', this._initTextures);
    await this._phase('materials', this._initMaterials);
    await this._phase('layout', this._probeLayout);
    await this._phase('kit', this._buildKit);
    // Order matters the same way it does in a real yard: the big fixed things
    // are sited first and the small stuff fills in around them, because a pass
    // that runs after the clutter has taken every clear site simply never
    // lands.
    await this._phase('woodpiles', this._dressWoodpiles);
    await this._phase('yards', this._dressYards);
    await this._phase('convoy', this._dressConvoy);
    await this._phase('barn', this._dressBarn);
    await this._phase('churchyard', this._dressChurchyard);
    await this._phase('interior', this._dressInterior);
    await this._phase('bridge', this._dressBridge);
    await this._phase('roadside', this._dressRoadside);
    await this._phase('vegetation', this._dressVegetation);
    await this._phase('drifts', this._dressDrifts);
    await this._phase('icicles', this._dressIcicles);
    await this._phase('life', this._dressLife);
    // Runs late on purpose: it reads back everything already placed and only
    // adds a foreground mass where a published framing has nothing in its near
    // third, which is the difference between a shot and a survey photograph.
    await this._phase('poses', this._dressPoses);
    await this._phase('nearmarks', this._dressNearMarks);
    await this._phase('commit', this._commit);
    return this;
  };

  // --------------------------------------------------------------------------
  // Textures
  // --------------------------------------------------------------------------
  PropsSnowbound.prototype._initTextures = function () {
    var t = this.tex;
    var aniso = 8;
    try {
      if (this.ctx.renderer && this.ctx.renderer.capabilities) {
        aniso = Math.min(8, this.ctx.renderer.capabilities.getMaxAnisotropy() || 8);
      }
    } catch (e) { /* headless */ }
    this._aniso = aniso;
    var R = this.rng;

    t.grass = TX.tex(TX.grass(256, R), true, 1, 1, aniso, true);
    t.twig = TX.tex(TX.twig(256, R), true, 1, 1, aniso, true);
    t.needle = TX.tex(TX.needle(256, R), true, 1, 1, aniso, true);
    t.marks = TX.tex(TX.marks(512, R), true, 1, 1, aniso, true);
    t.smoke = TX.tex(TX.smoke(256, R), true, 1, 1, aniso, true);
    t.sign = TX.tex(TX.sign(512, 192, R, { bg: '#43555e', fg: '#e2ecf4', glyphs: 8, sub: 1 }),
      true, 1, 1, aniso, true);
    t.sign2 = TX.tex(TX.sign(384, 256, R, { bg: '#632922', fg: '#e3d8c6', frame: '#c3b8a4', glyphs: 5 }),
      true, 1, 1, aniso, true);
  };

  // --------------------------------------------------------------------------
  // Materials.
  //
  // Everything generic comes from ctx.materials by a name the library actually
  // has, CLONED - mutating a cached library material would corrupt it for the
  // level and every other consumer.  Snow, ice and lit glass come from the
  // LEVEL, deliberately: level_snowbound authors those three itself (they are
  // not in the shared library at all) and a prop's snow cap has to be the same
  // shader, sparkle map and sheen as the drift it is sitting in or the seam is
  // visible at ten metres.
  // --------------------------------------------------------------------------
  PropsSnowbound.prototype._material = function (name, opts) {
    opts = opts || {};
    var lib = this.ctx.materials;
    var mat = null;
    try {
      if (lib && lib.get && (!lib.has || lib.has(name))) {
        var m = lib.get(name, opts);
        // clone() is overridden by materials.js to preserve its shader work, so
        // any injection of ours has to happen AFTER this call, never before.
        if (m && m.clone) mat = m.clone();
      }
    } catch (e) { GAME.logError('propsS.mat:' + name, e); }
    if (!mat) mat = this._fallbackMaterial(name, opts);
    mat.name = 'sb_' + name;
    return mat;
  };

  var FALLBACK_SPECS = {
    wood_plank: [0x6b5540, 0.88, 0.0],
    painted_metal: [0x59606a, 0.58, 0.80],
    rusted_metal: [0x6f4530, 0.86, 0.60],
    paint_green: [0x4b563f, 0.66, 0.35],
    stone: [0x8f8a80, 0.90, 0.0],
    concrete: [0x8a8781, 0.92, 0.0],
    canvas_awning: [0x6d6650, 0.94, 0.0],
    sandbag: [0x736a55, 0.95, 0.0],
    rubber: [0x1c1e21, 0.90, 0.0],
    rope: [0x8a7c60, 0.92, 0.0],
    laundry: [0xb9bcc2, 0.92, 0.0]
  };

  PropsSnowbound.prototype._fallbackMaterial = function (name, opts) {
    var spec = FALLBACK_SPECS[name] || FALLBACK_SPECS.wood_plank;
    var m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(spec[0], THREE.SRGBColorSpace),
      roughness: spec[1], metalness: spec[2], envMapIntensity: 1.0
    });
    if (opts) {
      if (opts.vertexColors) m.vertexColors = true;
      if (opts.side !== undefined) m.side = opts.side;
      if (opts.alphaTest !== undefined) m.alphaTest = opts.alphaTest;
      if (opts.transparent) m.transparent = true;
    }
    return m;
  };

  // Snow / ice / lit glass, borrowed from the level.  Guarded twice: the level
  // may be null, and it may be a level that has no material() at all.
  PropsSnowbound.prototype._levelMaterial = function (key, make) {
    var L = this.ctx.level;
    try {
      if (L && typeof L.material === 'function') {
        var m = L.material(key);
        if (m && m.isMaterial) return m;
      }
    } catch (e) { GAME.logError('propsS.levelMat:' + key, e); }
    return make.call(this);
  };

  PropsSnowbound.prototype._initMaterials = function () {
    var m = this.mats;
    var self = this;
    var W = { vertexColors: true };          // R grime, G wetness, B edge wear

    m.wood = this._material('wood_plank', W);
    m.steel = this._material('painted_metal', W);
    m.rust = this._material('rusted_metal', W);
    m.green = this._material('paint_green', W);
    m.stone = this._material('stone', W);
    m.concrete = this._material('concrete', W);
    m.canvas = this._material('canvas_awning',
      { vertexColors: true, side: THREE.DoubleSide });
    m.sack = this._material('sandbag', W);
    m.rubber = this._material('rubber', W);
    m.rope = this._material('rope', W);
    m.laundry = this._material('laundry', { vertexColors: true, side: THREE.DoubleSide });

    // ---- the level's own three -----------------------------------------------
    m.snow = this._levelMaterial('snow', function () {
      var s = new THREE.MeshPhysicalMaterial({
        color: 0xffffff, roughness: 0.62, metalness: 0.0,
        vertexColors: true, envMapIntensity: 1.2
      });
      s.sheen = 0.55; s.sheenRoughness = 0.86;
      s.sheenColor = new THREE.Color().setHex(0xa9c6ea, THREE.SRGBColorSpace);
      s.name = 'sb_snow_fallback';
      return s;
    });
    m.ice = this._levelMaterial('ice', function () {
      var s = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color().setHex(0xb9d2e6, THREE.SRGBColorSpace),
        roughness: 0.14, metalness: 0.0, vertexColors: true,
        transparent: true, opacity: 0.74, envMapIntensity: 2.0,
        side: THREE.DoubleSide, depthWrite: false
      });
      s.name = 'sb_ice_fallback';
      return s;
    });
    m.lit = this._levelMaterial('lit', function () {
      var s = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHex(0x2a1c0e, THREE.SRGBColorSpace),
        roughness: 0.35, metalness: 0.0, vertexColors: true,
        emissive: new THREE.Color().setHex(0xff9432, THREE.SRGBColorSpace),
        emissiveIntensity: 4.0, side: THREE.DoubleSide
      });
      s.name = 'sb_lit_fallback';
      return s;
    });

    // ---- alpha cards ---------------------------------------------------------
    // Own materials, not the library's `foliage`: that def is a green summer
    // leaf and the one thing this level cannot have anywhere is a green card.
    function cardMat(map, name, rough, cast) {
      var mm = new THREE.MeshStandardMaterial({
        map: map || null, color: 0xffffff,
        roughness: rough === undefined ? 0.86 : rough, metalness: 0.0,
        transparent: false, alphaTest: 0.42, side: THREE.DoubleSide,
        vertexColors: true, envMapIntensity: 1.05
      });
      mm.name = 'sb_' + name;
      void cast;
      return mm;
    }
    m.grass = cardMat(this.tex.grass, 'grass', 0.90);
    m.twig = cardMat(this.tex.twig, 'twig', 0.88);
    m.needle = cardMat(this.tex.needle, 'needle', 0.84);
    // The cards are stiff, frozen and small, so the amplitude is a couple of
    // centimetres - but it is DIRECTIONAL, which is what makes a field of dead
    // grass read as a field of dead grass in a gale rather than as a decal.
    applyWind(m.grass, this.uTime, this.uWind, this.uWindDir, 'g');
    applyWind(m.twig, this.uTime, this.uWind, this.uWindDir, 't');

    // ---- ground marks --------------------------------------------------------
    m.marks = new THREE.MeshStandardMaterial({
      map: this.tex.marks, color: 0xffffff, roughness: 0.88, metalness: 0.0,
      transparent: true, depthWrite: false, alphaTest: 0.03,
      vertexColors: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
    });
    m.marks.name = 'sb_marks';

    // ---- signage -------------------------------------------------------------
    m.sign = new THREE.MeshStandardMaterial({
      map: this.tex.sign, color: 0xffffff, roughness: 0.72, metalness: 0.0,
      vertexColors: true, side: THREE.DoubleSide, envMapIntensity: 1.0
    });
    m.sign.name = 'sb_sign';

    // ---- smoke ---------------------------------------------------------------
    // Additive would be wrong: woodsmoke against a bright overcast is a
    // SUBTRACTIVE mark, so this is a normal-blended dark card that reads as a
    // stain on the whiteout.  fog:true so a plume 40 m off dissolves with
    // everything else instead of hanging in front of the fog.
    m.smoke = new THREE.MeshBasicMaterial({
      map: this.tex.smoke, color: 0xffffff, transparent: true,
      opacity: 0.62, depthWrite: false, side: THREE.DoubleSide, fog: true
    });
    m.smoke.name = 'sb_smoke';
    applyWind(m.smoke, this.uTime, this.uWind, this.uWindDir, 's');

    // ---- cloth ---------------------------------------------------------------
    m.cloth = this._material('canvas_awning', { vertexColors: true, side: THREE.DoubleSide });
    applyWind(m.cloth, this.uTime, this.uWind, this.uWindDir, 'c');
    m.clothLight = this._material('laundry', { vertexColors: true, side: THREE.DoubleSide });
    applyWind(m.clothLight, this.uTime, this.uWind, this.uWindDir, 'l');
    m.ropeWind = this._material('rope', W);
    applyWind(m.ropeWind, this.uTime, this.uWind, this.uWindDir, 'r');
    void self;
  };

  // --------------------------------------------------------------------------
  // Layout: everything this file knows about the world comes from
  // level.anchors, which level_snowbound publishes from its constructor.  No
  // camera pose is read anywhere in this file for placement - the harbor build
  // moved four poses mid-flight and put lamps in corridors that no longer
  // existed, and this is the fix for that, written down.
  // --------------------------------------------------------------------------
  PropsSnowbound.prototype._probeLayout = function () {
    var L = this.ctx.level;
    this.L = L || null;
    var A = (L && L.anchors) || null;
    this.A = A;
    if (!A) {
      GAME.logError('propsS.layout', 'level.anchors unavailable - dressing a bare valley');
      return;
    }
    var V = A.valley;
    if (V) {
      this.bounds = { x0: V.x0 + 4, x1: V.x1 - 4, z0: V.z0 + 4, z1: V.z1 - 4 };
      if (typeof V.roadX === 'function') this.roadX = V.roadX;
      if (V.wind && isFinite(V.wind.x)) {
        this.windDir.set(V.wind.x, V.wind.y).normalize();
        this.uWindDir.value.copy(this.windDir);
      }
    }
    if (A.road) {
      if (isFinite(A.road.half)) this.roadHalf = A.road.half;
      if (isFinite(A.road.bermW)) this.bermW = A.road.bermW;
    }
    this.dachas = A.dachas || [];
    this.convoy = A.convoy || [];
    this.paths = A.paths || [];

    // Broadphase over the LEVEL's colliders so nothing we place ends up inside
    // a wall.  Floor tiles are excluded: a ground slab is a box whose top face
    // is the ground, so a test sphere standing on it always overlaps, and
    // including them made every site in the harbor read as blocked.
    this.hash = new GAME.SpatialHash(4.0);
    this._qout = [];
    var cols = (L && L.colliders) || [];
    for (var i = 0; i < cols.length; i++) {
      var c = cols[i];
      if (!c || c.floor) continue;
      try {
        GAME.Collision.boxBounds(c, _bmin, _bmax);
        this.hash.insert(c, _bmin, _bmax);
      } catch (e) { /* malformed collider - skip it, never throw */ }
    }
  };

  // --------------------------------------------------------------------------
  // Placement primitives
  // --------------------------------------------------------------------------

  // The snow surface.  sampleGround is the field the level rasterised its own
  // mesh from, so it agrees with what the camera sees to the millimetre; the
  // 4 m floor colliders take a MAXIMUM over their tile and would float a prop
  // by up to 30 cm on a drift flank.
  PropsSnowbound.prototype._ground = function (x, z) {
    var L = this.L;
    if (L && L.sampleGround) {
      try {
        var y = L.sampleGround(x, z);
        if (isFinite(y)) return y;
      } catch (e) { /* fall through */ }
    }
    return 0;
  };

  // The top of whatever is actually here, structure included - for props that
  // stand on a truck bed, a porch or the bridge deck.
  PropsSnowbound.prototype._surfaceY = function (x, z, fromY, maxDist) {
    var L = this.L;
    if (L && L.raycast) {
      _rayO.set(x, fromY === undefined ? this._ground(x, z) + 4.0 : fromY, z);
      _rayD.set(0, -1, 0);
      try {
        var r = L.raycast(_rayO, _rayD, maxDist === undefined ? 8 : maxDist);
        if (r && r.hit && r.point && isFinite(r.point.y)) return r.point.y;
      } catch (e) { /* fall through */ }
    }
    return this._ground(x, z);
  };

  // Sit a prop ON the surface, not on the tangent plane at its centre.
  //
  // This is the bug the first capture caught and it is worth naming: a snow
  // level is nothing but slopes, every drift flank runs at 25-40 degrees, and
  // a 0.6 m crate dropped LEVEL onto a 35-degree bank floats its downhill edge
  // by 0.4 m.  In a frame where the ground is a smooth white surface with no
  // texture cue at all, that reads as a prop hovering in mid-air - which is on
  // the instant-fail list, and it was.
  //
  // So the surface gradient is measured across the prop's own footprint and
  // returned as a pitch and roll in the PROP'S frame (three's YXZ order means
  // rz tips local +X up and rx tips local +Z down, hence the sign on each).
  // The tilt is deliberately partial - 0.82 - because a crate does bed into
  // soft snow rather than lying perfectly parallel to it, and the residual is
  // taken out by sinking the prop the rest of the way in.
  var _st = { y: 0, rx: 0, rz: 0, slope: 0 };
  PropsSnowbound.prototype._settle = function (x, z, r, yaw, k) {
    // `r` here is the prop's FOOTPRINT radius, not its keep-apart radius.  A
    // 1.2 m board passed its 0.22 m clearance radius and was therefore levelled
    // against a 0.19 m sample of a convex drift crest, which floated both ends;
    // elongated props declare opts.settleR so the surface is measured across
    // what actually touches it.
    var sr = Math.max(0.16, (r === undefined ? 0.4 : r) * 0.85);
    var y = this._ground(x, z);
    var ya = this._ground(x + sr, z), yb = this._ground(x - sr, z);
    var yc = this._ground(x, z + sr), yd = this._ground(x, z - sr);
    var gx = (ya - yb) / (2 * sr);
    var gz = (yc - yd) / (2 * sr);
    var c = Math.cos(yaw || 0), s = Math.sin(yaw || 0);
    var lgx = gx * c - gz * s;          // gradient along the prop's local +X
    var lgz = gx * s + gz * c;          // gradient along the prop's local +Z
    var slope = Math.sqrt(gx * gx + gz * gz);
    k = k === undefined ? 0.82 : k;
    // Roll off the tilt on extreme gradients and clamp it hard.  The level's
    // shovelled trenches are 0.7 m DEEP with near-vertical walls, so a footprint
    // that straddles one measures a gradient of three and, taken literally,
    // tipped a bucket right over onto its side in mid-air.  A prop on a step
    // sits on the step; it does not adopt its tangent plane.
    var kk = k / (1 + slope * 1.1);
    _st.rz = M.clamp(Math.atan(lgx) * kk, -0.40, 0.40);
    _st.rx = M.clamp(-Math.atan(lgz) * kk, -0.40, 0.40);
    _st.slope = slope;
    // And the height is taken mostly from the LOWEST sample under the
    // footprint, never from the centre: a prop bedded into the low side is
    // invisible, a prop hovering over it is the whole failure.
    var ymin = Math.min(y, Math.min(ya, yb), Math.min(yc, yd));
    _st.y = ymin + (y - ymin) * 0.30 - 0.012;
    return _st;
  };

  PropsSnowbound.prototype._blocked = function (x, y, z, r) {
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

  PropsSnowbound.prototype._occupied = function (x, z, r) {
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
  PropsSnowbound.prototype._occupy = function (x, z, r) {
    var cs = 3;
    var k = Math.floor(x / cs) * 73856093 ^ Math.floor(z / cs) * 19349663;
    var l = this._occ.get(k);
    if (!l) { l = []; this._occ.set(k, l); }
    l.push(x, z, r);
  };

  // Is this point INSIDE the church?
  //
  // Every other building in the level publishes one solid box collider, so
  // _blocked already keeps props out of them.  The church does not: its walls
  // are four thin slabs, which is correct (you can walk in) and which means its
  // whole interior reads as clear ground to a placement test.  The vegetation
  // scatter duly planted a snow-loaded spruce in the middle of the nave, four
  // metres from the published interior framing.  Anything placed from OUTSIDE
  // has to ask this first.
  PropsSnowbound.prototype._inChurch = function (x, z, pad) {
    var C = this.A && this.A.church;
    if (!C || !C.centre) return false;
    pad = pad || 0;
    var yaw = C.yaw || 0;
    var c = Math.cos(yaw), s = Math.sin(yaw);
    var dx = x - C.centre.x, dz = z - C.centre.z;
    var lx = c * dx - s * dz;
    var lz = s * dx + c * dz;
    var hw = ((C.nave && C.nave.hw) || 5.5) + 0.9 + pad;
    var hz = ((C.nave && C.nave.hz) || 7.8) + 0.9 + pad;
    if (Math.abs(lx) < hw && lz > -(hz + 4.6) && lz < hz) return true;
    // the tower, which level_snowbound puts 9.4 m along local +Z
    if (Math.abs(lx) < 3.9 + pad && Math.abs(lz - 9.4) < 3.9 + pad) return true;
    return false;
  };

  PropsSnowbound.prototype._inBounds = function (x, z, pad) {
    var b = this.bounds;
    pad = pad || 0;
    return x > b.x0 + pad && x < b.x1 - pad && z > b.z0 + pad && z < b.z1 - pad;
  };

  // Distance to the nearest PLANNED standpoint - level.plan.views, the level's
  // own survey of where it expects to be photographed from and walked through.
  // Never a camera pose: a pose is a composition and it moves. Anything that
  // wants to spend a detail budget where the eye is resolves against this.
  // Returns 0 when the level does not publish a survey, so a missing list means
  // "spend everywhere" rather than "spend nowhere".
  PropsSnowbound.prototype._viewDist = function (x, z) {
    var V = null;
    try { V = this.ctx && this.ctx.level && this.ctx.level.plan && this.ctx.level.plan.views; }
    catch (e) { V = null; }
    if (!V || !V.length) return 0;
    var best = 1e9;
    for (var i = 0; i < V.length; i++) {
      var dx = x - V[i][0], dz = z - V[i][1];
      var d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  };

  // Signed distance from the ploughed carriageway centreline.
  PropsSnowbound.prototype._roadOffset = function (x, z) {
    var rx = 0;
    try { rx = this.roadX(z); } catch (e) { rx = 0; }
    return x - rx;
  };

  // Is this spot on the swept carriageway?  Standing props are kept off it -
  // it is the one surface in the level that somebody cleared this morning -
  // but low ones (spilled cargo, a dropped tool, a chock) belong ON it,
  // because a swept road with literally nothing on it is a corridor somebody
  // hoovered rather than a road a convoy died on.
  PropsSnowbound.prototype._onRoad = function (x, z, low) {
    var a = Math.abs(this._roadOffset(x, z));
    return a < (low ? this.roadHalf * 0.55 : this.roadHalf + 0.5);
  };

  // Distance to the nearest shovelled path, so we do not stand a drum in the
  // one metre of trodden snow between the road and somebody's door.
  PropsSnowbound.prototype._pathDist = function (x, z) {
    var best = 1e9;
    for (var i = 0; i < this.paths.length; i++) {
      var poly = this.paths[i];
      for (var j = 0; j + 1 < poly.length; j++) {
        var ax = poly[j][0], az = poly[j][1], bx = poly[j + 1][0], bz = poly[j + 1][1];
        var vx = bx - ax, vz = bz - az;
        var len2 = vx * vx + vz * vz;
        var t = len2 > 1e-6 ? M.saturate(((x - ax) * vx + (z - az) * vz) / len2) : 0;
        var dx = x - (ax + vx * t), dz = z - (az + vz * t);
        var d = Math.sqrt(dx * dx + dz * dz);
        if (d < best) best = d;
      }
    }
    return best;
  };

  // The one call most placements go through.
  //   opts: { r, clearR, tilt, yaw, scale, sx/sy/sz, sink, color, cap, onRoad,
  //           collider:[hx,hy,hz], material, y }
  // Returns the ground height it settled at, or null if the site was rejected.
  PropsSnowbound.prototype._drop = function (batch, x, z, opts) {
    if (!batch || !batch.add) return null;
    opts = opts || {};
    var r = opts.r === undefined ? 0.45 : opts.r;
    if (!this._inBounds(x, z, 0.5)) { this._skipped++; return null; }
    if (!opts.onRoad && this._onRoad(x, z, opts.low)) { this._skipped++; return null; }
    if (!opts.indoor && this._inChurch(x, z, 0)) { this._skipped++; return null; }
    if (!opts.onPath && this._pathDist(x, z) < 0.75) { this._skipped++; return null; }
    if (this._occupied(x, z, r)) { this._skipped++; return null; }
    var yaw = opts.yaw === undefined ? this.rng.range(0, M.TAU) : opts.yaw;
    var sc = opts.scale === undefined ? 1 : opts.scale;
    var y, prx = 0, prz = 0;
    if (opts.y === undefined) {
      var st = this._settle(x, z, Math.max(r, opts.settleR || 0) * sc, yaw);
      y = st.y; prx = st.rx; prz = st.rz;
    } else { y = opts.y; }
    var cr = opts.clearR === undefined ? r * 0.78 : opts.clearR;
    if (this._blocked(x, y + (opts.h || 0.5) * 0.5, z, cr)) { this._skipped++; return null; }
    var tilt = opts.tilt === undefined ? 0.045 : opts.tilt;
    var ok = batch.add(
      T(x, y - (opts.sink || 0), z,
        prx + this.rng.gaussian(0, tilt), yaw, prz + this.rng.gaussian(0, tilt),
        sc * (opts.sx || 1), sc * (opts.sy || 1), sc * (opts.sz || 1)),
      opts.color || wearTint(this.rng));
    if (!ok) return null;
    this._occupy(x, z, r);
    if (opts.collider) this._collider(x, y, z, opts.collider, yaw, opts.material);
    // Weld it into the snow: a cap on top and a drift tail downwind.  A prop
    // that terminates on a hard line against lying snow, with nothing banked
    // against it and nothing lying on it, is a decal - and in this level that
    // is the single most likely way to lose a frame.
    if (opts.cap !== false) {
      var capW = (opts.capW || r * 1.5) * sc, capD = (opts.capD || r * 1.5) * sc;
      var capY = y + (opts.capY === undefined ? (opts.h || 0.5) : opts.capY) * sc - (opts.sink || 0);
      this._snowCap(x, capY, z, capW, capD, opts.capH === undefined ? 0.075 : opts.capH, yaw);
      if (r > 0.20) this._drift(x, z, r * this.rng.range(1.05, 1.55), y);
    }
    // The collar and its contact ring go on EVERY dropped prop, cap or no cap:
    // it is not dressing, it is the thing that stops the prop being a decal.
    if (opts.collar !== false) {
      this._collar(x, y - (opts.sink || 0), z,
        Math.max(0.20, (opts.collarR || r * 1.05) * sc), opts.collarH);
    }
    return y;
  };

  PropsSnowbound.prototype._collider = function (x, y, z, he, yaw, material) {
    _eu.set(0, yaw || 0, 0, 'YXZ');
    this.colliders.push({
      type: 'box',
      center: new THREE.Vector3(x, y + he[1], z),
      halfExtents: new THREE.Vector3(he[0], he[1], he[2]),
      quaternion: new THREE.Quaternion().setFromEuler(_eu),
      material: material || 'wood'
    });
  };

  PropsSnowbound.prototype._static = function (key, geometry, matrix) {
    if (!geometry) return;
    var arr = this.S[key];
    if (!arr) arr = this.S[key] = [];
    arr.push(part(geometry, matrix));
  };

  // A snow cap lying on a horizontal face at (x, y, z), footprint w x d.
  PropsSnowbound.prototype._snowCap = function (x, y, z, w, d, h, yaw) {
    if (this._capCount > 1500) return;
    if (!(w > 0.05 && d > 0.05)) return;
    var g = K.snowCap(w, d, h, this.noise, this._capCount * 0.37, [this.windDir.x, this.windDir.y]);
    this._static('snow', g, Tn(x, y, z, 0, yaw || 0, 0));
    this._capCount++;
  };

  // A modelled collar at the foot of a prop, plus the contact occluder that
  // goes with it.  The two are issued together on purpose: a collar with no
  // darkening under it still photographs as a cutout, and a darkening with no
  // collar reads as a stain.  The third leg - the actual vertex-colour ring in
  // the ground mesh - is rasterised by the LEVEL, from the list built here, in
  // _commit; see LevelSnowbound.paintGroundContact.
  PropsSnowbound.prototype._collar = function (x, y, z, r, h) {
    if (this._collarCount === undefined) this._collarCount = 0;
    this._contact.push({ x: x, z: z, r: r });
    if (this._collarCount > 900) return;
    if (!(r > 0.06)) return;
    if (this._inChurch(x, z, 0)) return;
    var g = K.snowCollar(r, h === undefined ? Math.min(0.14, r * 0.28) : h,
      this.noise, this._collarCount * 0.61);
    this._static('snow', g, Tn(x, (y === undefined ? this._ground(x, z) : y) - 0.02, z));
    this._collarCount++;
  };

  // A drift banked against something.  Deposition is on the LEE side, which for
  // weather.js's blizzard is +X / -Z, so the tail always points the same way
  // the falling snow does.
  PropsSnowbound.prototype._drift = function (x, z, r, y, scaleY) {
    if (this._driftCount === undefined) this._driftCount = 0;
    if (this._driftCount > 900) return;
    if (this._inChurch(x, z, 0)) return;
    var w = this.windDir;
    var gy = y === undefined ? this._ground(x, z) : y;
    var ox = x + w.x * r * 0.55, oz = z + w.y * r * 0.55;
    var g = K.snowLump(this.noise, this.rng);
    // K.snowLump is normalised (see there): x, z span [-0.5, 0.5] and y spans
    // [-0.13, 1], so the three scale terms below ARE the bank's world size in
    // metres and its own negative skirt does the bedding-in. A bank of radius r
    // stands about 0.46r tall; sinking a further sixth of that keeps the rim
    // under the surface without burying the crest, which is what the previous
    // arithmetic did to all 900 of them.
    var hgt = r * 0.46 * (scaleY || 1) * this.rng.range(0.74, 1.32);
    this._static('snow', g, Tn(ox, gy - hgt * 0.17, oz, 0,
      Math.atan2(w.x, w.y) + this.rng.range(-1.1, 1.1), 0,
      r * this.rng.range(1.15, 2.30), hgt,
      r * this.rng.range(0.95, 1.85)));
    this._driftCount++;
  };

  // Bank a run of drift against one face of a rectangle in plan.  `nx,nz` is
  // the outward normal of the face.
  PropsSnowbound.prototype._bankFace = function (cx, cz, yaw, halfLen, nx, nz, off, n, amp) {
    var tx = -nz, tz = nx;             // along the face
    for (var i = 0; i < n; i++) {
      var t = (i + this.rng.range(0.15, 0.85)) / n * 2 - 1;
      var d = off + this.rng.range(-0.10, 0.28);
      var x = cx + tx * t * halfLen + nx * d;
      var z = cz + tz * t * halfLen + nz * d;
      if (!this._inBounds(x, z, 0.5)) continue;
      this._drift(x, z, amp * this.rng.range(0.7, 1.35));
    }
    void yaw;
  };

  // Dead grass at the foot of something.  This is where it actually survives:
  // the wind accelerates round a standing obstacle and scours the snow off its
  // windward foot, so a wall, a woodpile or a fence line has a fringe of last
  // summer's growth showing along one side and a metre of drift along the
  // other.  It is also the only reliable way to get vegetation into the near
  // field of a framing that is looking at a building, because the open
  // snowfield the scatter pass covers is all beyond twenty metres.
  PropsSnowbound.prototype._tuftSkirt = function (cx, cz, yaw, halfLen, nx, nz, off, n) {
    var bat = this.B.tuft;
    if (!bat) return;
    var R = this.rng;
    var tx = -nz, tz = nx;
    for (var i = 0; i < n; i++) {
      var t = (i + R.range(0.1, 0.9)) / n * 2 - 1;
      var d = off + R.range(-0.25, 0.45);
      var x = cx + tx * t * halfLen + nx * d;
      var z = cz + tz * t * halfLen + nz * d;
      if (!this._inBounds(x, z, 0.5)) continue;
      if (this._onRoad(x, z)) continue;
      if (this._inChurch(x, z, 0)) continue;
      if (this._pathDist(x, z) < 0.8) continue;
      var y = this._ground(x, z);
      if (this._blocked(x, y + 0.3, z, 0.28)) continue;
      var sc = R.range(0.55, 1.15);
      bat.add(T(x, y - R.range(0.03, 0.14), z,
        R.gaussian(0, 0.06), R.range(0, M.TAU), R.gaussian(0, 0.06),
        sc * R.range(0.85, 1.2), sc * R.range(0.8, 1.3), sc * R.range(0.85, 1.2)),
        wearTint(R));
    }
    void yaw;
  };

  // An icicle fringe hanging from a horizontal edge at (x, y, z), running
  // `span` metres along the prop's local X.
  PropsSnowbound.prototype._icicles = function (x, y, z, yaw, span, maxLen) {
    if (this._icicleCount === undefined) this._icicleCount = 0;
    // 48 ROWS, NOT 220. Measured on the round-2 build the icicle set came to
    // 56,692 triangles - four times the whole church, the level's one landmark -
    // and not one of them was legible in any of the six published frames: a
    // 3 cm cone at 30 m through 40% fog is a smear whatever it is textured with.
    // A row is only worth its geometry within about 22 m of somewhere the level
    // expects to be photographed from, so the budget is spent THERE and the
    // remaining eaves get none. The distance test uses level.plan.views (the
    // survey), never a camera pose.
    if (this._icicleCount > 48) return;
    if (this._viewDist(x, z) > 22.0) return;
    // An icicle hangs from an EAVE.  Anything asking for a row less than a
    // metre and a half off the ground is asking for a spray of ice growing out
    // of the snow, which is the one place ice does not form - and it is the
    // failure mode when an anchor comes back with a height this file guessed
    // wrong.  Refuse it rather than draw it.
    if (!isFinite(y) || y - this._ground(x, z) < 1.5) return;
    var g = K.icicleRow(span, maxLen, this.rng, this.noise);
    if (!g) return;
    this._static('ice', g, Tn(x, y, z, 0, yaw || 0, 0));
    this._icicleCount++;
  };

  // A ground mark from the prop atlas.
  PropsSnowbound.prototype._mark = function (cell, x, z, w, d, yaw, y, tintC) {
    if (this._markCount === undefined) this._markCount = 0;
    // 1100, not 420. The whole ground-mark system across both files came to
    // 734 triangles - roughly 360 quads for every footprint, tyre rut, shovel
    // scrape, wood chip, ash spill and diesel stain in a nine-house village -
    // and the brief names those marks as the specific mechanism by which snow
    // reads as depth rather than as white paint. 1100 quads is 2,200 triangles,
    // 0.07% of the frame.
    if (this._markCount > 1100) return;
    if (!this._inBounds(x, z, 0.4)) return;
    var uv = atlasUV(cell);
    var g = flatCard(w, d === undefined ? w : d, uv[0], uv[1], uv[2], uv[3]);
    var gy = (y === undefined ? this._ground(x, z) : y) + 0.016;
    var e = part(g, Tn(x, gy, z, 0, yaw === undefined ? this.rng.range(0, M.TAU) : yaw, 0));
    e.tint = tintC || null;
    var arr = this.S.marks;
    arr.push(e);
    this._markCount++;
  };

  PropsSnowbound.prototype._rope = function (ax, ay, az, bx, by, bz, sag, r, flex, seg) {
    this.ropePaths.push({
      a: new THREE.Vector3(ax, ay, az), b: new THREE.Vector3(bx, by, bz),
      sag: sag === undefined ? 0.2 : sag, r: r === undefined ? 0.016 : r,
      flex: flex || 0, seg: seg || 9
    });
  };

  // Local (lx, lz) in a structure's own frame -> world.  Matches the
  // convention level_snowbound builds in: world = centre + Ry(yaw) * local.
  function toWorld(cx, cz, yaw, lx, lz, out) {
    var c = Math.cos(yaw), s = Math.sin(yaw);
    out = out || { x: 0, z: 0 };
    out.x = cx + lx * c + lz * s;
    out.z = cz - lx * s + lz * c;
    return out;
  }
  var _lw = { x: 0, z: 0 };

  // --------------------------------------------------------------------------
  // Kit
  // --------------------------------------------------------------------------
  PropsSnowbound.prototype._uvScale = function (name, texels) {
    try {
      if (this.ctx.materials && this.ctx.materials.uvScaleFor) {
        var s = this.ctx.materials.uvScaleFor(name, texels || 500);
        if (isFinite(s) && s > 0) return s;
      }
    } catch (e) { /* library still booting */ }
    return 1.4;
  };

  // Re-UV a merged prop to the library's declared texel density, copy uv1 for
  // the AO channel, and paint the wear mask.  Every instanced prop goes through
  // here so grain does not visibly jump between a 0.06 m billet and a 1.2 m
  // pallet - which is the tell that a prop set was authored piecemeal.
  PropsSnowbound.prototype._finishGeo = function (geo, matName, wear, texels) {
    if (!geo) return null;
    try { Geo.worldUV(geo, this._uvScale(matName, texels)); } catch (e) { /* keep builder uv */ }
    Geo.copyUV1(geo);
    paintWear(geo, wear || { noise: this.noise });
    try { geo.computeBoundingSphere(); geo.computeBoundingBox(); } catch (e2) { /* ignore */ }
    return geo;
  };

  // Alpha cards keep their authored UV (it indexes the clump texture) and get a
  // flex ramp instead of a wear mask that would fight the alpha.
  PropsSnowbound.prototype._finishCard = function (geo, h) {
    if (!geo) return null;
    Geo.copyUV1(geo);
    var p = geo.attributes.position;
    var c = new Float32Array(p.count * 3);
    for (var i = 0; i < p.count; i++) {
      // a touch of grime at the base where the snow has splashed soil up it
      var lo = 1 - M.saturate(p.getY(i) / Math.max(0.05, h));
      c[i * 3] = 1 - lo * 0.20; c[i * 3 + 1] = 1; c[i * 3 + 2] = 1;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    setFlex(geo, function (x, y) { return M.saturate(y / Math.max(0.05, h)); });
    try { geo.computeBoundingSphere(); } catch (e) { /* ignore */ }
    return geo;
  };

  PropsSnowbound.prototype._buildKit = function () {
    var N = this.noise, R = this.rng, m = this.mats;
    var self = this;
    // A batch is ALWAYS created, even if its builder failed: forty dressing
    // call sites reach into this.B by name, and making one conditional on a
    // geometry that might be null turns a cosmetic failure into a thrown
    // exception in the middle of a pass, which loses every prop after it.  An
    // empty batch is dropped in _commit and costs nothing.
    function bat(key, geo, mat, max, shadow) {
      if (!geo) geo = new THREE.BufferGeometry();
      self.B[key] = new Batch(geo, mat || m.wood, max, shadow);
      return self.B[key];
    }
    function fin(g, name, wear, texels) { return self._finishGeo(g, name, wear, texels); }

    var woodWear = { noise: N, grime: 0.34, edge: 0.30, hiY: 0.9 };
    var metalWear = { noise: N, grime: 0.40, edge: 0.34, hiY: 1.0 };

    // The billet budget is the one number in this file that has to be generous.
    // At 1500 the nine village woodpiles plus the barn's overflowed it, the
    // batch silently stopped accepting, and every pile after the fourth house -
    // AND every chopping block, AND the split wood beside the church stove -
    // simply did not exist.  Batch.add returning false is invisible; this is
    // the fix, and stats.full is what would have caught it.
    bat('billet', fin(K.billet(N, R, true), 'wood_plank', { noise: N, grime: 0.26, edge: 0.42, hiY: 0.2 }, 620),
      m.wood, 2800);
    bat('round', fin(K.logRound(N, R), 'wood_plank', woodWear, 520), m.wood, 140);
    bat('plank', fin(K.plank(R), 'wood_plank', { noise: N, grime: 0.44, edge: 0.34, hiY: 0.3 }, 560),
      m.wood, 320);
    bat('crate', fin(K.crate(R), 'wood_plank', woodWear, 520), m.wood, 190);
    bat('ammo', fin(K.ammoBox(), 'paint_green', metalWear, 520), m.green, 120);
    bat('drum', fin(K.drum(N), 'rusted_metal', metalWear, 480), m.rust, 90);
    bat('jerry', fin(K.jerry(), 'paint_green', metalWear, 600), m.green, 80);
    bat('sack', fin(K.sack(N, R), 'sandbag', { noise: N, grime: 0.42, edge: 0.18, hiY: 0.6 }, 520),
      m.sack, 130);
    bat('pail', fin(K.pail(), 'painted_metal', metalWear, 620), m.steel, 70);
    bat('tyre', fin(K.tyre(N, R), 'rubber', { noise: N, grime: 0.50, edge: 0.22, hiY: 0.9 }, 480),
      m.rubber, 60);
    bat('pallet', fin(K.pallet(R), 'wood_plank', woodWear, 500), m.wood, 50);
    bat('cross', fin(K.cross(R), 'wood_plank', { noise: N, grime: 0.30, edge: 0.40, hiY: 1.5 }, 520),
      m.wood, 80);
    bat('headstone', fin(K.headstone(N, R), 'stone', { noise: N, grime: 0.36, edge: 0.26, hiY: 0.8 }, 480),
      m.stone, 50);
    bat('chunk', fin(K.chunk(N, R), 'concrete', { noise: N, grime: 0.44, edge: 0.30, hiY: 0.6 }, 460),
      m.concrete, 260);
    bat('raven', fin(K.raven(), 'rubber', { noise: N, grime: 0.10, edge: 0.05, hiY: 0.3 }, 900),
      m.rubber, 18, false);

    // ---- alpha cards ---------------------------------------------------------
    var tuft = K.cardCluster(0.88, 0.64, 3, R);
    bat('tuft', this._finishCard(tuft, 0.64), m.grass, 1500, false);
    var scrub = K.cardCluster(0.95, 0.80, 3, R);
    bat('scrub', this._finishCard(scrub, 0.80), m.twig, 420, false);
    var sap = K.cardCluster(1.35, 1.90, 3, R);
    bat('sapling', this._finishCard(sap, 1.90), m.needle, 320, false);

    // Cards do not cast: three.js shadows a card through MeshDepthMaterial,
    // which does not carry the alpha map, so an alpha-tested tuft would throw a
    // solid rectangle.  In a whiteout with a 0.09-turbidity overcast the sun
    // term is soft and low anyway, so this costs nothing and removes an
    // artefact that would otherwise be all over the mid-field.
    this.B.tuft.mesh.castShadow = false;
    this.B.scrub.mesh.castShadow = false;
    this.B.sapling.mesh.castShadow = false;
  };

  // Place a one-off merged prop into a static bucket.
  PropsSnowbound.prototype._put = function (key, geo, x, y, z, yaw, tilt, roll, sx, sy, sz) {
    this._static(key, geo, Tn(x, y, z, tilt || 0, yaw || 0, roll || 0, sx, sy, sz));
  };

  // The same, but bedded into the slope it is standing on - see _settle.
  // Anything that stands on open ground goes through here rather than _put.
  PropsSnowbound.prototype._putSettled = function (key, geo, x, z, yaw, r, dy, k) {
    var st = this._settle(x, z, r === undefined ? 0.6 : r, yaw || 0, k);
    this._static(key, geo, Tn(x, st.y + (dy || 0), z, st.rx, yaw || 0, st.rz));
    // Same contract as _drop: anything standing on the snow gets a modelled
    // base, not a corrected height.
    this._collar(x, st.y + (dy || 0), z, Math.max(0.24, (r === undefined ? 0.6 : r) * 0.95));
    return st.y;
  };

  // ==========================================================================
  // WOODPILES
  //
  // The single most characteristic object a Russian village puts against a
  // wall, and the one prop in this file that carries a whole framing on its
  // own: a stack of split ends is a dense mosaic of small dark shapes, which is
  // exactly the texture a whiteout has none of.
  //
  // WHICH WALL, AND WHY IT MATTERS.  Every stack goes against the flank whose
  // outward normal points INTO the wind - the scoured side.  That is where a
  // person can still get at it in February, and it means the lee flank stays
  // free for the drift that level_snowbound's own height field is already
  // banking there.  Putting the wood on the lee side would have buried it, and
  // buried it in exactly the place the terrain is highest.
  // ==========================================================================
  PropsSnowbound.prototype._woodpile = function (x, z, yaw, len, courses, opts) {
    opts = opts || {};
    var R = this.rng, B = this.B.billet;
    if (!B) return null;
    // A stack is built LEVEL even on a bank, and the downhill end is dug in -
    // so the base is the MINIMUM ground under the footprint, never the height
    // at the centre.  Taking the centre floated the downhill third of every
    // pile in the village off the drift it was supposed to be standing on.
    var baseY;
    if (opts.y === undefined) {
      var sc0 = Math.cos(yaw), sn0 = Math.sin(yaw);
      baseY = 1e9;
      for (var q = -1; q <= 1; q++) {
        for (var q2 = -1; q2 <= 1; q2 += 2) {
          var qx = x + sn0 * q * len * 0.5 + sc0 * q2 * 0.22;
          var qz = z + sc0 * q * len * 0.5 - sn0 * q2 * 0.22;
          var gq = this._ground(qx, qz);
          if (gq < baseY) baseY = gq;
        }
      }
      if (!isFinite(baseY)) baseY = this._ground(x, z);
    } else { baseY = opts.y; }
    var dia = 0.128;
    var per = Math.max(3, Math.round(len / dia));
    var i, c;
    var cs = Math.cos(yaw), sn = Math.sin(yaw);
    // The stack settles: the bottom course is pressed into the snow and the
    // whole thing leans a degree or two off the wall.
    var lean = R.range(-0.035, 0.035);
    var placed = 0;
    for (c = 0; c < courses; c++) {
      var cy = baseY + 0.055 + c * 0.112 + R.range(-0.006, 0.006);
      // a stack loses billets off the top course, and the top of an old stack
      // is never square
      var loss = c >= courses - 2 ? R.range(0.15, 0.55) : 0;
      var off = (c % 2) * dia * 0.5;
      for (i = 0; i < per; i++) {
        if (loss > 0 && R.next() < loss) continue;
        var t = (i + 0.5) * dia + off - len * 0.5;
        if (Math.abs(t) > len * 0.5) continue;
        var wx = x + cs * (R.range(-0.035, 0.035)) + sn * t;
        var wz = z - sn * (R.range(-0.035, 0.035)) + cs * t;
        var m4 = T(wx, cy, wz,
          R.gaussian(0, 0.030), yaw + R.gaussian(0, 0.055), lean + R.gaussian(0, 0.045),
          R.range(0.88, 1.12), R.range(0.90, 1.10), R.range(0.90, 1.10));
        if (B.add(m4, wearTint(R))) placed++;
      }
    }
    // End cribs: pairs of billets stacked crosswise, which is how a free-
    // standing end is actually held up and is the detail that says somebody
    // built this rather than tipped it out of a trailer.
    for (var e = -1; e <= 1; e += 2) {
      var ex = x + sn * e * (len * 0.5 + 0.10), ez = z + cs * e * (len * 0.5 + 0.10);
      for (c = 0; c < courses - 1; c++) {
        var ey = baseY + 0.055 + c * 0.112;
        var cross = (c % 2) === 0;
        for (var k = -1; k <= 1; k += 2) {
          var jx = ex + (cross ? cs : sn) * k * 0.09;
          var jz = ez + (cross ? -sn : cs) * k * 0.09;
          B.add(T(jx, ey, jz, 0, yaw + (cross ? Math.PI * 0.5 : 0) + R.gaussian(0, 0.04),
            R.gaussian(0, 0.03), R.range(0.9, 1.1), 1, 1), wearTint(R));
          placed++;
        }
      }
    }
    var h = 0.055 + courses * 0.112;
    // The load on top, and the drift that has crept up the outboard face.
    this._snowCap(x, baseY + h + 0.02, z, len * 0.98, 0.40, opts.capH || 0.13, yaw);
    var nx = cs, nz = -sn;                        // outboard normal (local +X)
    if (opts.faceOut) { nx = opts.faceOut[0]; nz = opts.faceOut[1]; }
    this._bankFace(x, z, yaw, len * 0.5, nx, nz, 0.30, Math.max(2, Math.round(len * 0.7)), 0.34);
    // a fringe of dead grass along its scoured foot
    this._tuftSkirt(x, z, yaw, len * 0.55, nx, nz, 0.62, Math.max(3, Math.round(len * 1.6)));
    this._collider(x, baseY, z, [len * 0.5, h * 0.5, 0.24], yaw, 'wood');
    this._occupy(x, z, Math.max(0.7, len * 0.45));
    // splinters and bark on the ground in front of it
    this._mark(CELL.chips, x + nx * 0.55, z + nz * 0.55, R.range(0.9, 1.5), R.range(0.7, 1.2), yaw);
    return placed;
  };

  PropsSnowbound.prototype._dressWoodpiles = function () {
    var A = this.A;
    if (!A || !A.dachas) return;
    var R = this.rng, w = this.windDir;
    var i;
    for (i = 0; i < A.dachas.length; i++) {
      var d = A.dachas[i];
      if (!d || !d.centre) continue;
      var yaw = d.yaw || 0;
      var hw = (d.w || 7) * 0.5, hd = (d.d || 9) * 0.5;
      // outward normals of the two flanks, in world
      var nxP = Math.cos(yaw), nzP = -Math.sin(yaw);
      var dotP = nxP * w.x + nzP * w.y;
      // the scoured flank: outward normal pointing INTO the wind
      var sgn = dotP < 0 ? 1 : -1;
      var nx = sgn * nxP, nz = sgn * nzP;
      var len = M.clamp((d.d || 9) - 3.0, 1.8, 4.0) * R.range(0.85, 1.05);
      var courses = R.int(6, 10);
      // 0.20 m clear of the wall so the timber is not intersecting the logs
      var px = d.centre.x + nx * (hw + 0.38) + Math.sin(yaw) * R.range(-0.8, 0.8);
      var pz = d.centre.z + nz * (hw + 0.38) + Math.cos(yaw) * R.range(-0.8, 0.8);
      if (d.ruin && R.next() < 0.5) {
        // a collapsed stack: the billets have gone over and rolled downwind
        for (var k = 0; k < 46; k++) {
          var a = R.range(0, M.TAU), rr = Math.pow(R.next(), 0.6) * 1.9;
          var sx = px + Math.cos(a) * rr + w.x * rr * 0.6;
          var sz = pz + Math.sin(a) * rr + w.y * rr * 0.6;
          this._drop(this.B.billet, sx, sz, {
            r: 0.10, sink: R.range(0.02, 0.08), tilt: 0.24, cap: false,
            yaw: R.range(0, M.TAU)
          });
        }
        this._drift(px, pz, 1.5);
        continue;
      }
      this._woodpile(px, pz, yaw, len, courses, { faceOut: [nx, nz] });
      // a second, older, lower stack against the gable on some plots
      if (R.next() < 0.45) {
        var gx = d.centre.x - Math.sin(yaw) * (hd + 0.42) + nx * R.range(-1.4, 1.4);
        var gz = d.centre.z - Math.cos(yaw) * (hd + 0.42) + nz * R.range(-1.4, 1.4);
        this._woodpile(gx, gz, yaw + Math.PI * 0.5, R.range(1.6, 2.6), R.int(4, 7),
          { faceOut: [-Math.sin(yaw), -Math.cos(yaw)] });
      }
    }
    // and one very big one at the barn, which is where the year's wood lives
    if (A.barn && A.barn.centre) {
      var b = A.barn.centre, by = A.barn.yaw || 0;
      var bnx = Math.cos(by), bnz = -Math.sin(by);
      var bx = b.x + bnx * ((A.barn.w || 9) * 0.5 + 0.55);
      var bz = b.z + bnz * ((A.barn.w || 9) * 0.5 + 0.55);
      this._woodpile(bx, bz, by, 4.4, 10, { faceOut: [bnx, bnz], capH: 0.16 });
    }
  };

  // ==========================================================================
  // YARDS - the dressing immediately around each occupied house.
  //
  // Everything here is placed relative to the DOOR and the SHOVELLED PATH,
  // because that is what determines where a thing ends up in real life: you
  // drop the bucket where you stop walking, you lean the shovel where you can
  // reach it from the step, and you chop wood where the chips will not end up
  // in the trench you have just dug.
  // ==========================================================================
  PropsSnowbound.prototype._dressYards = function () {
    var A = this.A;
    if (!A || !A.dachas) return;
    var R = this.rng, i;
    var self = this;

    function leanAgainst(key, geo, x, z, yaw, tilt, y) {
      // A tool leaning on a post: rotate it back about its butt, which is where
      // the origin is, so the tip lands on the wall and the butt on the ground.
      // The butt is pushed 40 mm INTO the snow - a shovel standing on a drift
      // sinks, and one balanced exactly on the surface reads as a decal.
      var gy = y === undefined ? self._ground(x, z) : y;
      self._put(key, geo, x, gy - 0.04, z,
        yaw, -(tilt === undefined ? 0.30 : tilt), R.range(-0.06, 0.06));
    }

    for (i = 0; i < A.dachas.length; i++) {
      var d = A.dachas[i];
      if (!d || !d.centre || !d.doorOuter) continue;
      var yaw = d.yaw || 0;
      var hw = (d.w || 7) * 0.5, hd = (d.d || 9) * 0.5;
      // the door faces local -Z; `out` is the world direction away from it
      var ox = -Math.sin(yaw), oz = -Math.cos(yaw);
      // and the world direction along the front wall
      var tx = Math.cos(yaw), tz = -Math.sin(yaw);
      var dx = d.doorOuter.x, dz = d.doorOuter.z;
      var gy = d.centre.y;

      // ---- the porch posts, and what leans on them -------------------------
      // The porch is 2.0 m wide and stands 1.30 m proud of the gable, so the
      // posts are at local (-0.15 +- 0.9, -hd - 1.30).  Solved from the level's
      // own numbers rather than eyeballed off the door anchor.
      var postX = d.centre.x + tx * (-0.15 + 0.9) + ox * (hd + 1.30);
      var postZ = d.centre.z + tz * (-0.15 + 0.9) + oz * (hd + 1.30);
      if (!d.ruin) {
        leanAgainst('steel', this._kitShovel(), postX + ox * 0.22 + tx * 0.16,
          postZ + oz * 0.22 + tz * 0.16, yaw + R.range(-0.3, 0.3), R.range(0.20, 0.34));
        if (R.next() < 0.6) {
          leanAgainst('wood', this._kitBroom(), postX + ox * 0.20 - tx * 0.30,
            postZ + oz * 0.20 - tz * 0.30, yaw + R.range(2.6, 3.6), R.range(0.16, 0.26));
        }
      }

      // ---- the bench along the front wall ----------------------------------
      if (!d.ruin && R.next() < 0.75) {
        var bx = d.centre.x + tx * R.range(-2.6, -1.5) + ox * (hd + 0.42);
        var bz = d.centre.z + tz * R.range(-2.6, -1.5) + oz * (hd + 0.42);
        var bg = K.bench(R);
        var byy = this._putSettled('wood', bg, bx, bz, yaw + R.range(-0.06, 0.06), 1.0, -0.10);
        this._snowCap(bx, byy + 0.40, bz, 1.9, 0.40, 0.10, yaw);
        this._occupy(bx, bz, 1.1);
        this._drift(bx, bz, 0.7, byy);
      }

      // ---- the pail, the crate and the sacks by the step -------------------
      var sideSign = R.bool() ? 1 : -1;
      this._drop(this.B.pail, dx + tx * sideSign * R.range(0.8, 1.3) + ox * R.range(-0.2, 0.4),
        dz + tz * sideSign * R.range(0.8, 1.3) + oz * R.range(-0.2, 0.4),
        { r: 0.24, onPath: true, capW: 0.30, capD: 0.30, capY: 0.27, capH: 0.05,
          yaw: R.range(0, M.TAU), tilt: 0.09 });
      if (R.next() < 0.7) {
        this._drop(this.B.crate, dx - tx * sideSign * R.range(0.9, 1.6) + ox * R.range(0.1, 0.6),
          dz - tz * sideSign * R.range(0.9, 1.6) + oz * R.range(0.1, 0.6),
          { r: 0.44, onPath: true, yaw: yaw + R.range(-0.5, 0.5), capW: 0.66, capD: 0.56,
            capY: 0.53, capH: 0.09, collider: [0.32, 0.26, 0.28], material: 'wood' });
      }
      if (R.next() < 0.5) {
        for (var s = 0; s < R.int(2, 3); s++) {
          this._drop(this.B.sack, dx + tx * sideSign * R.range(1.2, 2.2) + ox * R.range(0.4, 1.1),
            dz + tz * sideSign * R.range(1.2, 2.2) + oz * R.range(0.4, 1.1),
            { r: 0.30, onPath: true, capW: 0.42, capD: 0.42, capY: 0.42, capH: 0.07,
              tilt: 0.16, scale: R.range(0.85, 1.15) });
        }
      }

      // ---- the chopping block ----------------------------------------------
      // Sited off the path, on the side the woodpile is, three or four paces
      // out - which is exactly as far as anybody carries an armful of logs.
      if (!d.ruin && R.next() < 0.8) {
        var chAng = R.range(-0.9, 0.9);
        var cxp = dx + (ox * Math.cos(chAng) - oz * Math.sin(chAng)) * R.range(2.6, 4.2);
        var czp = dz + (oz * Math.cos(chAng) + ox * Math.sin(chAng)) * R.range(2.6, 4.2);
        this._chopBlock(cxp, czp, yaw + R.range(0, 6.28));
      }

      // ---- a sledge, tipped against the wall or abandoned in the yard ------
      if (R.next() < 0.42) {
        var sx2 = d.centre.x + tx * R.range(1.4, 2.6) + ox * (hd + R.range(0.3, 1.1));
        var sz2 = d.centre.z + tz * R.range(1.4, 2.6) + oz * (hd + R.range(0.3, 1.1));
        if (!this._occupied(sx2, sz2, 0.9)) {
          var syy = this._putSettled('wood', K.sledge(), sx2, sz2, yaw + R.range(-0.6, 0.6),
            0.7, -0.06);
          this._snowCap(sx2, syy + 0.28, sz2, 0.95, 0.55, 0.08, yaw);
          this._occupy(sx2, sz2, 0.9);
        }
      }
      void hw; void gy;
    }

    // ---- the well, and the washing line ------------------------------------
    this._dressWell();
    this._dressLaundry();
  };

  // Cache the small one-off kits: seven porches want a shovel and building
  // seven identical shovels is seven merges for nothing.
  PropsSnowbound.prototype._kitShovel = function () {
    if (!this._gShovel) this._gShovel = this._finishGeo(K.shovel(), 'painted_metal',
      { noise: this.noise, grime: 0.40, edge: 0.45, hiY: 1.2 }, 640);
    return this._gShovel;
  };
  PropsSnowbound.prototype._kitBroom = function () {
    if (!this._gBroom) this._gBroom = this._finishGeo(K.broom(), 'wood_plank',
      { noise: this.noise, grime: 0.46, edge: 0.30, hiY: 1.2 }, 640);
    return this._gBroom;
  };
  PropsSnowbound.prototype._kitAxe = function () {
    if (!this._gAxe) this._gAxe = this._finishGeo(K.axe(), 'painted_metal',
      { noise: this.noise, grime: 0.34, edge: 0.55, hiY: 0.8 }, 700);
    return this._gAxe;
  };

  // A chopping block: the round, the axe buried in it, the split billets that
  // have not been carried in yet, and the ring of chips.  Nothing here is
  // scattered - the chips fan DOWNWIND of the block because that is where the
  // axe throws them and where they then blow.
  PropsSnowbound.prototype._chopBlock = function (x, z, yaw) {
    var R = this.rng, w = this.windDir;
    if (this._occupied(x, z, 1.0) || !this._inBounds(x, z, 1.2)) return;
    var y = this._ground(x, z);
    var bl = this.B.round;
    var stb = this._settle(x, z, 0.30, yaw);
    y = stb.y;
    if (bl) bl.add(T(x, y - 0.05, z, stb.rx + R.gaussian(0, 0.05), yaw,
      stb.rz + R.gaussian(0, 0.05), 1.25, 1.15, 1.25), wearTint(R));
    // The axe, left bitten into the block with the haft standing up.
    // K.axe is authored butt-at-origin with the head at the TOP, so it has to
    // be turned over: rotating pi about X puts the head 0.70 m BELOW the
    // origin, and the origin therefore goes 0.70 m above the block face.  The
    // first version skipped that and leaned the axe about its butt at block
    // height, which floated the head a metre out in mid-air beside the block.
    var lean = R.range(0.16, 0.34);
    var top = y + 0.40;
    this._put('steel', this._kitAxe(),
      x - Math.sin(lean) * 0.35, top + Math.cos(lean) * 0.66, z + R.range(-0.05, 0.05),
      yaw + R.range(-0.5, 0.5), Math.PI - lean, R.range(-0.10, 0.10));
    // split billets waiting to be carried in, thrown clear of the swing
    for (var i = 0; i < R.int(7, 14); i++) {
      var a = R.range(0, M.TAU);
      var rr = R.range(0.55, 1.7);
      var bx = x + Math.cos(a) * rr + w.x * rr * 0.45;
      var bz = z + Math.sin(a) * rr + w.y * rr * 0.45;
      // Lying flat and half sunk.  A stick of firewood dropped in snow beds
      // in; the first pass gave them a 0.55 rad tilt spread, which stood a
      // third of them on end with one tip in the air.
      this._drop(this.B.billet, bx, bz, {
        r: 0.10, settleR: 0.20, tilt: 0.22, sink: R.range(0.02, 0.07), cap: false,
        onPath: true, yaw: R.range(0, M.TAU)
      });
    }
    this._mark(CELL.chips, x + w.x * 0.5, z + w.y * 0.5, R.range(1.6, 2.4), R.range(1.3, 2.0),
      Math.atan2(w.x, w.y));
    this._snowCap(x, y + 0.36, z, 0.46, 0.46, 0.05, yaw);
    this._occupy(x, z, 1.0);
  };

  PropsSnowbound.prototype._dressWell = function () {
    var A = this.A, R = this.rng;
    if (!A || !A.dachas || A.dachas.length < 4) return;
    // Between two houses, back from the carriageway - a well is communal, so it
    // sits in the space BETWEEN plots rather than in anybody's yard.
    var a = A.dachas[2], b = A.dachas[5];
    if (!a || !b || !a.centre || !b.centre) return;
    var x = (a.centre.x + b.centre.x) * 0.5 + R.range(-1.5, 1.5);
    var z = (a.centre.z + b.centre.z) * 0.5 + R.range(-1.5, 1.5);
    // walk it off the road and out of any path before committing
    for (var tries = 0; tries < 14; tries++) {
      if (!this._onRoad(x, z) && this._pathDist(x, z) > 1.6 &&
        !this._blocked(x, this._ground(x, z) + 1.2, z, 1.4) && this._inBounds(x, z, 3)) break;
      x += R.range(-2.5, 2.5); z += R.range(-2.5, 2.5);
    }
    var yaw = R.range(0, M.TAU);
    var y = this._putSettled('wood', K.wellCrib(R), x, z, yaw, 0.9, -0.12, 0.5);
    // the bucket on its rope, hanging in the shaft mouth
    var cs = Math.cos(yaw), sn = Math.sin(yaw);
    this._rope(x, y + 1.58, z, x + sn * 0.02, y + 0.92, z + cs * 0.02, 0.02, 0.012, 0.05, 5);
    var bg = this.B.pail;
    if (bg) bg.add(T(x + sn * 0.02, y + 0.66, z + cs * 0.02, 0.06, R.range(0, 6.28), 0.04), wearTint(R));
    // snow on the roof, ice down the crib where sixty winters of spilled water
    // has frozen, and the trodden ring of grit around it
    this._snowCap(x, y + 2.52, z, 1.9, 1.75, 0.20, yaw);
    for (var i = 0; i < 7; i++) {
      var ia = R.range(0, M.TAU);
      var ix = x + Math.cos(ia) * 0.63, iz = z + Math.sin(ia) * 0.63;
      this._icicles(ix, y + 0.95 + R.range(-0.2, 0.15), iz, ia, R.range(0.25, 0.5), R.range(0.25, 0.62));
    }
    this._mark(CELL.diesel, x, z, 3.0, 2.6, R.range(0, 6.28), y, null);
    this._collider(x, y, z, [0.75, 0.85, 0.75], yaw, 'wood');
    this._occupy(x, z, 1.9);
    // a pail and a yoke dropped beside it
    this._drop(this.B.pail, x + R.range(-1.5, 1.5), z + R.range(-1.5, 1.5),
      { r: 0.24, tilt: 0.35, capH: 0.04, onPath: true });
    this.wellAt = new THREE.Vector3(x, y, z);
  };

  // Frozen washing, forgotten on the line since the weather turned.  It is a
  // joke that a Russian would recognise and it is also the only cloth in the
  // level above knee height, so it is the one thing that visibly MOVES in the
  // village half of every framing.
  PropsSnowbound.prototype._dressLaundry = function () {
    var A = this.A, R = this.rng;
    if (!A || !A.dachas) return;
    var d = null, i;
    for (i = 0; i < A.dachas.length; i++) {
      if (A.dachas[i] && !A.dachas[i].ruin && A.dachas[i].lit) { d = A.dachas[i]; break; }
    }
    if (!d) d = A.dachas[0];
    if (!d || !d.centre) return;
    var yaw = d.yaw || 0;
    var tx = Math.cos(yaw), tz = -Math.sin(yaw);
    var ox = -Math.sin(yaw), oz = -Math.cos(yaw);
    var hd = (d.d || 9) * 0.5;
    // From the gable corner out to a leaning post in the yard.
    var ax = d.centre.x + tx * ((d.w || 7) * 0.4) + ox * (hd + 0.30);
    var az = d.centre.z + tz * ((d.w || 7) * 0.4) + oz * (hd + 0.30);
    var bx = ax + ox * 3.9 + tx * R.range(-0.9, 0.9);
    var bz = az + oz * 3.9 + tz * R.range(-0.9, 0.9);
    var ay = this._ground(ax, az) + 1.95;
    var by = this._ground(bx, bz);
    // the post
    this._putSettled('wood', this._kitLinePost(), bx, bz, R.range(0, 6.28), 0.35, -0.14, 0.35);
    // The line is 20 mm, not 12.  At 12 mm it was under a pixel at twenty
    // metres, so the garments read as flat boards hanging in mid-air with
    // nothing holding them - which is exactly what the first capture showed.
    this._rope(ax, ay, az, bx, by + 1.92, bz, 0.13, 0.020, 0.40, 11);
    // Four small stiff garments rather than three big ones.  Frozen washing is
    // SMALL and there is a lot of it; the first pass hung two 0.7 x 0.95 m
    // slabs, and at that size a flat card is a sheet of plywood.
    var lineYaw = Math.atan2(bx - ax, bz - az);
    var n = 4;
    for (i = 0; i < n; i++) {
      var t = (i + 0.6) / (n + 0.5);
      var gx = M.lerp(ax, bx, t), gz = M.lerp(az, bz, t);
      var gy = M.lerp(ay, by + 1.92, t) - 0.13 * 4 * t * (1 - t) - 0.015;
      var gw = R.range(0.28, 0.44), gh = R.range(0.34, 0.58);
      var geo = K.frozenGarment(gw, gh, R);
      if (!geo) continue;
      this._clothPart(geo, gx, gy, gz, lineYaw + Math.PI * 0.5 + R.range(-0.2, 0.2), 'light');
      // the pegs, which are what make it read as hung rather than floating
      for (var pg = -1; pg <= 1; pg += 2) {
        this._put('wood', this._kitPeg(),
          gx + Math.sin(lineYaw) * pg * gw * 0.36, gy + 0.012, gz + Math.cos(lineYaw) * pg * gw * 0.36,
          lineYaw, R.range(-0.15, 0.15));
      }
      // and its own little ridge of snow along the top edge
      this._snowCap(gx, gy + 0.02, gz, gw * 0.9, 0.05, 0.025, lineYaw + Math.PI * 0.5);
    }
  };

  PropsSnowbound.prototype._kitPeg = function () {
    if (this._gPeg) return this._gPeg;
    var P = [part(box(0.016, 0.075, 0.018, 0.002), Tn(-0.011, -0.030, 0))];
    P.push(part(box(0.016, 0.075, 0.018, 0.002), Tn(0.011, -0.030, 0)));
    P.push(part(cyl(0.013, 0.013, 0.030, 5), Tn(0, 0.004, 0, 0, 0, Math.PI * 0.5)));
    var g = mergeParts(P, 0);
    disposeParts(P);
    this._gPeg = this._finishGeo(g, 'wood_plank',
      { noise: this.noise, grime: 0.30, edge: 0.35, hiY: 0.1 }, 900);
    return this._gPeg;
  };

  PropsSnowbound.prototype._kitLinePost = function () {
    if (this._gPost) return this._gPost;
    var P = [part(cyl(0.070, 0.085, 2.30, 7), Tn(0, 1.15, 0))];
    P.push(part(box(0.70, 0.055, 0.055, 0.005), Tn(0, 2.18, 0)));
    // The brace has to REACH THE GROUND.  At 1.05 m centred at 0.75 its foot
    // stopped 0.29 m short and hung in the air, which at ten metres is a rod
    // floating over a snowbank - the exact failure this file is meant to avoid.
    P.push(part(cyl(0.050, 0.050, 1.85, 5), Tn(0.36, 0.72, 0.24, 0.46, 0, 0.40)));
    var g = mergeParts(P, 2.0);
    disposeParts(P);
    this._gPost = this._finishGeo(g, 'wood_plank',
      { noise: this.noise, grime: 0.40, edge: 0.28, hiY: 2.0 }, 520);
    return this._gPost;
  };

  // Cloth goes into its own list rather than a static bucket: it carries aFlex,
  // and Geo.mergeAll keeps position/normal/uv and nothing else.
  PropsSnowbound.prototype._clothPart = function (geo, x, y, z, yaw, kind) {
    this.clothParts.push({ geo: geo, m: Tn(x, y, z, 0, yaw || 0, 0), kind: kind || 'canvas' });
  };

  // ==========================================================================
  // THE CONVOY
  //
  // Five lorries stopped nose to tail in a ploughed road is a STORY, and props
  // are how the story gets told: the tailgate is down and its load is in the
  // carriageway behind it, the fuel came off the running board, somebody put a
  // shovel in the berm and never came back for it.  Nothing here is beside a
  // truck; everything is behind, under or against one.
  // ==========================================================================
  PropsSnowbound.prototype._dressConvoy = function () {
    var A = this.A, R = this.rng, w = this.windDir;
    if (!A || !A.convoy) return;
    var i, k;
    for (i = 0; i < A.convoy.length; i++) {
      var t = A.convoy[i];
      if (!t || !t.centre) continue;
      var yaw = t.yaw || 0;
      var cx = t.centre.x, cz = t.centre.z, cy = t.centre.y;
      // truck axes: forward is local +Z, right is local +X
      var fx = Math.sin(yaw), fz = Math.cos(yaw);
      var rx = Math.cos(yaw), rz = -Math.sin(yaw);
      var burnt = t.kind === 'burnt';

      // ---- what came off the tailgate ------------------------------------
      // A dropped load lands in a fan BEHIND the tailgate, tightest near it.
      var tgx = cx - fx * 4.0, tgz = cz - fz * 4.0;
      var nLoad = burnt ? R.int(5, 8) : R.int(6, 11);
      for (k = 0; k < nLoad; k++) {
        var run = Math.pow(R.next(), 0.75) * (burnt ? 4.5 : 3.6);
        var lat = R.gaussian(0, 0.85 + run * 0.16);
        var lx = tgx - fx * run + rx * lat;
        var lz = tgz - fz * run + rz * lat;
        var which = R.next();
        var bat = which < 0.42 ? this.B.crate : (which < 0.78 ? this.B.ammo : this.B.sack);
        var sc = bat === this.B.sack ? R.range(0.9, 1.2) : 1;
        this._drop(bat, lx, lz, {
          r: bat === this.B.sack ? 0.32 : 0.42, onRoad: true, onPath: true,
          yaw: yaw + R.range(-0.9, 0.9), tilt: R.next() < 0.3 ? 0.42 : 0.10,
          scale: sc, capW: 0.62, capD: 0.55, capY: bat === this.B.ammo ? 0.33 : 0.52,
          capH: R.range(0.05, 0.11),
          color: burnt ? _col.setRGB(R.range(0.16, 0.34), 0.99, R.range(0.45, 0.7)) : undefined
        });
      }
      // one crate that never made it off, hanging on the tailgate lip
      if (!burnt && R.next() < 0.7 && this.B.crate) {
        this.B.crate.add(T(tgx - fx * 0.25, cy + 0.92, tgz - fz * 0.25,
          R.range(0.22, 0.42), yaw + R.range(-0.2, 0.2), R.range(-0.16, 0.16)), wearTint(R));
        this._snowCap(tgx - fx * 0.25, cy + 1.44, tgz - fz * 0.25, 0.6, 0.5, 0.06, yaw);
      }

      // ---- fuel, off the running board -------------------------------------
      var side = R.bool() ? 1 : -1;
      for (k = 0; k < R.int(2, 4); k++) {
        this._drop(this.B.jerry,
          cx + rx * side * R.range(1.5, 2.3) + fx * R.range(-1.0, 1.6),
          cz + rz * side * R.range(1.5, 2.3) + fz * R.range(-1.0, 1.6),
          { r: 0.22, onRoad: true, onPath: true, yaw: yaw + R.range(-0.4, 0.4),
            tilt: R.next() < 0.25 ? 0.7 : 0.06, capW: 0.20, capD: 0.34, capY: 0.47, capH: 0.04 });
      }
      // drums, always shoved to the berm where they are out of the way
      for (k = 0; k < R.int(1, 3); k++) {
        var bd = R.range(this.roadHalf + 0.4, this.roadHalf + this.bermW);
        var bs = R.bool() ? 1 : -1;
        var bx = cx + rx * bs * bd + fx * R.range(-3, 3);
        var bz2 = cz + rz * bs * bd + fz * R.range(-3, 3);
        this._drop(this.B.drum, bx, bz2, {
          r: 0.42, onRoad: true, sink: R.range(0.05, 0.22), tilt: 0.10,
          capW: 0.56, capD: 0.56, capY: 0.89, capH: 0.07,
          collider: [0.30, 0.44, 0.30], material: 'metal',
          color: burnt ? _col.setRGB(0.28, 0.99, 0.55) : undefined
        });
      }

      // ---- the spare, and a burst one on the burnt truck --------------------
      var sp = R.bool() ? 1 : -1;
      this._drop(this.B.tyre,
        cx + rx * sp * R.range(1.9, 2.6) + fx * R.range(-2.4, -1.2),
        cz + rz * sp * R.range(1.9, 2.6) + fz * R.range(-2.4, -1.2),
        { r: 0.55, onRoad: true, tilt: 0.05, sink: R.range(0.10, 0.28),
          yaw: yaw + R.range(-0.3, 0.3), capW: 0.9, capD: 0.9, capY: 0.10, capH: 0.05,
          sx: 1, sy: 1, sz: 1 });

      // ---- the tools somebody left ------------------------------------------
      if (R.next() < 0.8) {
        var shx = cx + rx * side * (this.roadHalf * 0.9) + fx * R.range(-3.5, 3.5);
        var shz = cz + rz * side * (this.roadHalf * 0.9) + fz * R.range(-3.5, 3.5);
        // a shovel STOOD IN the berm, which is where a shovel ends up
        this._put('steel', this._kitShovel(), shx, this._ground(shx, shz) - 0.22, shz,
          R.range(0, 6.28), R.range(0.10, 0.30), R.range(-0.2, 0.2));
        this._occupy(shx, shz, 0.4);
      }
      // wheel chocks, in front of and behind a wheel
      for (k = -1; k <= 1; k += 2) {
        var wcx = cx + rx * R.range(1.0, 1.3) * (R.bool() ? 1 : -1) + fx * k * 2.1;
        var wcz = cz + rz * R.range(1.0, 1.3) * (R.bool() ? 1 : -1) + fz * k * 2.1;
        this._drop(this.B.plank, wcx, wcz, {
          r: 0.16, settleR: 0.40, onRoad: true, onPath: true, cap: false, tilt: 0.10,
          yaw: yaw + Math.PI * 0.5 + R.range(-0.3, 0.3), scale: R.range(0.5, 0.75)
        });
      }

      // ---- the ground under a lorry that has stood here for two days -------
      this._mark(CELL.diesel, cx + fx * R.range(0.5, 2.2), cz + fz * R.range(0.5, 2.2),
        R.range(2.2, 3.4), R.range(1.6, 2.6), yaw, undefined, null);
      // and the drift that has built along its lee flank
      var leeS = (rx * w.x + rz * w.y) > 0 ? 1 : -1;
      this._bankFace(cx, cz, yaw, 3.4, rx * leeS, rz * leeS, 1.45, 6, 0.55);
      // icicles off the tilt bows and the tailgate
      if (t.kind === 'tilt') {
        for (k = 0; k < 3; k++) {
          var iz = R.range(-3.4, 0.6);
          this._icicles(cx + fx * iz + rx * 1.26, cy + 2.44, cz + fz * iz + rz * 1.26,
            yaw + Math.PI * 0.5, R.range(0.6, 1.3), R.range(0.16, 0.42));
          this._icicles(cx + fx * iz - rx * 1.26, cy + 2.44, cz + fz * iz - rz * 1.26,
            yaw + Math.PI * 0.5, R.range(0.6, 1.3), R.range(0.16, 0.42));
        }
      }

      // ---- the burnt one ----------------------------------------------------
      if (burnt) {
        for (k = 0; k < 22; k++) {
          var ba = R.range(0, M.TAU), br = Math.pow(R.next(), 0.6) * 5.2;
          var bx2 = cx + Math.cos(ba) * br + w.x * br * 0.4;
          var bz3 = cz + Math.sin(ba) * br + w.y * br * 0.4;
          this._drop(R.next() < 0.55 ? this.B.chunk : this.B.plank, bx2, bz3, {
            r: 0.20, settleR: 0.40, onRoad: true, onPath: true, cap: false, tilt: 0.35,
            scale: R.range(0.2, 0.55),
            color: _col.setRGB(R.range(0.10, 0.26), 0.99, R.range(0.35, 0.6))
          });
        }
        this._mark(CELL.ash, cx, cz, 7.5, 6.0, yaw);
        this._mark(CELL.ash, cx + w.x * 4.0, cz + w.y * 4.0, 5.0, 4.0, yaw);
      }

      // ---- the brazier -------------------------------------------------------
      // One fire, at the truck whose headlights are still burning, because that
      // is the truck somebody is still standing at.  It is the ONLY warm mark
      // in the northern half of the level and it is what keeps grade_split
      // positive in hero2's approach.
      if (t.lights && !this._brazierDone) {
        var brx = cx + rx * R.range(2.3, 3.1) * side + fx * R.range(-1.5, 1.5);
        var brz = cz + rz * R.range(2.3, 3.1) * side + fz * R.range(-1.5, 1.5);
        this._brazier(brx, brz);
        this._brazierDone = true;
      }
    }
  };

  PropsSnowbound.prototype._brazier = function (x, z) {
    var R = this.rng;
    var y = this._putSettled('rust', this._finishGeo(K.brazier(this.noise), 'rusted_metal',
      { noise: this.noise, grime: 0.62, edge: 0.40, hiY: 0.9 }, 480),
      x, z, R.range(0, 6.28), 0.35, -0.04);
    // the coals.  A disc of the level's lit material, which is a dark albedo
    // with a hot emissive - postfx's veiling bloom is what turns it into a
    // source, and it is deliberately small: a metre-wide glow would fight the
    // lighting rig, which owns every actual light in this level.
    var cg = cyl(0.245, 0.255, 0.05, 12);
    this._put('lit', cg, x, y + 0.60, z, 0, 0, 0);
    // charred billets sticking out of it
    for (var i = 0; i < 4; i++) {
      var a = R.range(0, M.TAU);
      this._drop(this.B.billet, x + Math.cos(a) * 0.16, z + Math.sin(a) * 0.16, {
        r: 0.05, cap: false, onRoad: true, onPath: true, y: y + 0.62, tilt: 0.5,
        yaw: a + R.range(-0.4, 0.4),
        color: _col.setRGB(0.14, 0.99, 0.4)
      });
    }
    this._mark(CELL.ash, x, z, 2.4, 2.2, R.range(0, 6.28), y);
    // no snow cap: this one is lit, and a snow-capped fire is a contradiction
    this._occupy(x, z, 0.9);
    // a crate somebody has been sitting on
    this._drop(this.B.crate, x + R.range(-1.5, 1.5), z + R.range(-1.5, 1.5),
      { r: 0.45, onRoad: true, onPath: true, capH: 0.04, tilt: 0.07 });
  };

  // ==========================================================================
  // THE BARN
  // ==========================================================================
  PropsSnowbound.prototype._dressBarn = function () {
    var A = this.A, R = this.rng;
    if (!A || !A.barn || !A.barn.centre) return;
    var b = A.barn, yaw = b.yaw || 0;
    var cx = b.centre.x, cz = b.centre.z, cy = b.centre.y;
    var hw = (b.w || 9) * 0.5, hd = (b.d || 14) * 0.5;
    // the big doorway is in the local -Z gable
    var ox = -Math.sin(yaw), oz = -Math.cos(yaw);
    var tx = Math.cos(yaw), tz = -Math.sin(yaw);
    var i;

    // ---- the bale stack, just inside and just outside the door -------------
    var bale = this._finishGeo(K.hayBale(this.noise, R), 'sandbag',
      { noise: this.noise, grime: 0.34, edge: 0.20, hiY: 1.2 }, 420);
    var stack = [[0, 0], [1.32, 0], [0.66, 1.02]];
    for (i = 0; i < stack.length; i++) {
      var sx = cx + tx * (stack[i][0] - 0.7) + ox * (hd + 1.9);
      var sz = cz + tz * (stack[i][0] - 0.7) + oz * (hd + 1.9);
      var sy = this._putSettled('sack', bale, sx, sz, yaw + R.range(-0.12, 0.12), 0.62,
        stack[i][1] - 0.05) + stack[i][1];
      this._snowCap(sx, sy + 1.14, sz, 1.15, 1.05, 0.13, yaw);
      this._occupy(sx, sz, 0.9);
    }
    this._mark(CELL.straw, cx + ox * (hd + 2.4), cz + oz * (hd + 2.4), 4.2, 3.4, yaw);
    this._mark(CELL.straw, cx + ox * (hd + 0.9) + tx * 1.6, cz + oz * (hd + 0.9) + tz * 1.6,
      2.6, 2.2, yaw);

    // ---- the fodder rack ---------------------------------------------------
    var frx = cx + tx * R.range(3.0, 4.4) + ox * (hd + R.range(2.2, 3.6));
    var frz = cz + tz * R.range(3.0, 4.4) + oz * (hd + R.range(2.2, 3.6));
    var fry = this._putSettled('wood', this._finishGeo(K.fodderRack(), 'wood_plank',
      { noise: this.noise, grime: 0.42, edge: 0.30, hiY: 1.5 }, 480),
      frx, frz, yaw + R.range(-0.3, 0.3), 1.2, -0.10);
    this._snowCap(frx, fry + 1.30, frz, 1.5, 2.6, 0.14, yaw);
    this._occupy(frx, frz, 1.6);
    this._mark(CELL.straw, frx, frz, 3.2, 3.6, yaw, fry);

    // ---- the ladder against the gable --------------------------------------
    var lx = cx + tx * R.range(-3.2, -2.2) + ox * (hd + 0.55);
    var lz = cz + tz * R.range(-3.2, -2.2) + oz * (hd + 0.55);
    this._put('wood', this._finishGeo(K.ladder(4.2), 'wood_plank',
      { noise: this.noise, grime: 0.38, edge: 0.34, hiY: 3.0 }, 520),
      lx, this._ground(lx, lz) - 0.16, lz, yaw + Math.PI * 0.5, 0.22);
    this._occupy(lx, lz, 0.6);

    // ---- long timber, stacked on bearers ------------------------------------
    // A sawn stack is a different silhouette from a firewood stack: long, low
    // and horizontal, and it gives the barn end a base line.
    var stx = cx + tx * (hw + 1.5) * 0 + ox * (hd + 5.2) + tx * R.range(-1, 1);
    var stz = cz + tz * (hw + 1.5) * 0 + oz * (hd + 5.2) + tz * R.range(-1, 1);
    var sy2 = this._ground(stx, stz);
    var P = [];
    for (var c = 0; c < 4; c++) {
      var n = 5 - Math.floor(c / 2);
      for (i = 0; i < n; i++) {
        var r2 = R.range(0.085, 0.125);
        P.push(part(cyl(r2, r2 * R.range(0.9, 1.1), R.range(4.4, 5.6), 7),
          Tn((i - (n - 1) * 0.5) * 0.27 + R.range(-0.02, 0.02), 0.13 + c * 0.23, R.range(-0.15, 0.15),
            0, 0, Math.PI * 0.5)));
      }
    }
    for (i = -1; i <= 1; i += 2) {
      P.push(part(box(0.30, 0.14, 0.30, 0.01), Tn(i * 1.9, 0.07, 0)));
    }
    var tg = mergeParts(P, 0);
    disposeParts(P);
    if (tg) {
      this._finishGeo(tg, 'wood_plank', { noise: this.noise, grime: 0.36, edge: 0.30, hiY: 1.1 }, 500);
      sy2 = this._putSettled('wood', tg, stx, stz, yaw + Math.PI * 0.5 + R.range(-0.2, 0.2), 2.2, -0.06);
      this._snowCap(stx, sy2 + 1.03, stz, 5.0, 1.35, 0.16, yaw + Math.PI * 0.5);
      this._collider(stx, sy2, stz, [2.6, 0.5, 0.75], yaw + Math.PI * 0.5, 'wood');
      this._occupy(stx, stz, 2.6);
      this._bankFace(stx, stz, yaw, 2.4, this.windDir.x, this.windDir.y, 0.9, 5, 0.5);
    }

    // ---- the yard clutter ---------------------------------------------------
    for (i = 0; i < 7; i++) {
      var a = R.range(-1.2, 1.2);
      var rr = R.range(3.0, 9.0);
      var px = cx + (ox * Math.cos(a) - oz * Math.sin(a)) * rr + tx * R.range(-4, 4);
      var pz = cz + (oz * Math.cos(a) + ox * Math.sin(a)) * rr + tz * R.range(-4, 4);
      var pick = R.next();
      if (pick < 0.3) {
        this._drop(this.B.drum, px, pz, { r: 0.42, sink: R.range(0.1, 0.4), tilt: 0.12,
          capW: 0.56, capD: 0.56, capY: 0.89, capH: 0.08 });
      } else if (pick < 0.55) {
        this._drop(this.B.pallet, px, pz, { r: 0.75, tilt: 0.06, sink: R.range(0.02, 0.16),
          capW: 1.2, capD: 0.82, capY: 0.10, capH: 0.08, yaw: R.range(0, 6.28) });
      } else if (pick < 0.8) {
        this._drop(this.B.crate, px, pz, { r: 0.45, tilt: 0.10, sink: R.range(0.02, 0.20),
          capW: 0.66, capD: 0.56, capY: 0.52, capH: 0.09 });
      } else {
        this._drop(this.B.tyre, px, pz, { r: 0.55, tilt: 0.06, sink: R.range(0.10, 0.35),
          capW: 0.9, capD: 0.9, capY: 0.10, capH: 0.05 });
      }
    }
    void cy;
  };

  // ==========================================================================
  // THE CHURCHYARD
  //
  // Graves go in ROWS, on the sheltered side of the nave, with the crosses
  // facing the same way.  Two things sell it: the rows are irregular but they
  // ARE rows, and the snow has drifted over the low end of each mound so half
  // the markers are buried to the crossbar.
  // ==========================================================================
  PropsSnowbound.prototype._dressChurchyard = function () {
    var A = this.A, R = this.rng;
    if (!A || !A.church || !A.church.centre) return;
    var C = A.church, yaw = C.yaw || 0;
    var hw = (C.nave && C.nave.hw) || 5.5, hz = (C.nave && C.nave.hz) || 7.8;
    var cx = C.centre.x, cz = C.centre.z;
    var row, i;
    // the plot: west flank of the nave and round behind the apse
    var rows = 5, perRow = 6;
    var faceYaw = yaw + R.range(-0.12, 0.12);
    for (row = 0; row < rows; row++) {
      var lx = -(hw + 3.4 + row * 2.05);
      for (i = 0; i < perRow; i++) {
        var lz = -hz - 1.0 + (i + 0.5) * (hz * 2 + 3.5) / perRow + R.range(-0.45, 0.45);
        toWorld(cx, cz, yaw, lx + R.range(-0.45, 0.45), lz, _lw);
        var gx = _lw.x, gz = _lw.z;
        if (!this._inBounds(gx, gz, 2) || this._onRoad(gx, gz)) continue;
        if (this._blocked(gx, this._ground(gx, gz) + 0.8, gz, 0.5)) continue;
        var gy = this._ground(gx, gz);
        var buried = R.next();
        var isCross = R.next() < 0.68;
        var bat = isCross ? this.B.cross : this.B.headstone;
        if (!bat) continue;
        var sink = buried < 0.35 ? R.range(0.35, 0.85) : R.range(0.02, 0.22);
        bat.add(T(gx, gy - sink, gz,
          R.gaussian(0, 0.075), faceYaw + R.gaussian(0, 0.13), R.gaussian(0, 0.085),
          R.range(0.85, 1.15), R.range(0.88, 1.16), R.range(0.85, 1.15)), wearTint(R));
        this._occupy(gx, gz, 0.55);
        // the mound, and the drift piled against the marker's lee face
        this._snowCap(gx + this.windDir.x * 0.35, gy + 0.02, gz + this.windDir.y * 0.35,
          R.range(0.9, 1.5), R.range(1.5, 2.2), R.range(0.10, 0.22), faceYaw);
        if (R.next() < 0.55) this._drift(gx, gz, R.range(0.45, 0.85), gy);
        // a few carry an arm-load of fir, which is what a Russian grave gets in
        // winter instead of flowers
        if (R.next() < 0.18) {
          this._drop(this.B.sapling, gx + R.range(-0.4, 0.4), gz + R.range(0.3, 0.7),
            { r: 0.2, cap: false, scale: R.range(0.22, 0.36), tilt: 0.5, onPath: true });
        }
      }
    }
    // a bench and a candle box by the tower door
    if (C.door) {
      var dx = C.door.x, dz = C.door.z;
      var bx = dx + R.range(-2.6, -1.4), bz2 = dz + R.range(-0.8, 0.8);
      if (!this._occupied(bx, bz2, 1.2)) {
        var byy = this._putSettled('wood', K.bench(R), bx, bz2, yaw + R.range(-0.2, 0.2), 1.0, -0.12);
        this._snowCap(bx, byy + 0.38, bz2, 1.9, 0.40, 0.11, yaw);
        this._occupy(bx, bz2, 1.1);
      }
      this._drop(this.B.crate, dx + R.range(1.2, 2.2), dz + R.range(-1.0, 1.0),
        { r: 0.45, onPath: true, tilt: 0.06, capH: 0.08 });
      this._mark(CELL.ash, dx + R.range(-1.5, 1.5), dz + R.range(-1.5, 1.5), 1.6, 1.4);
    }
  };

  // ==========================================================================
  // THE CHURCH INTERIOR
  //
  // This is the `interior` framing, and the nave as the level leaves it is a
  // stone box with a hole in the roof, a drift under the hole and a candle
  // stand.  What it needs is FURNITURE AT THREE DEPTHS: something in the near
  // third to frame the shot, something at the piers to give the middle scale,
  // and something at the iconostasis to close the far end.
  // ==========================================================================
  PropsSnowbound.prototype._dressInterior = function () {
    var A = this.A, R = this.rng;
    if (!A || !A.church || !A.church.centre) return;
    var C = A.church, yaw = C.yaw || 0;
    var cx = C.centre.x, cz = C.centre.z;
    var fy = C.floorY === undefined ? C.centre.y + 0.10 : C.floorY;
    var hw = (C.nave && C.nave.hw) || 5.5, hz = (C.nave && C.nave.hz) || 7.8;
    var i;
    var self = this;
    function place(key, geo, lx, lz, lyaw, tilt, dy) {
      toWorld(cx, cz, yaw, lx, lz, _lw);
      self._put(key, geo, _lw.x, fy + (dy || 0), _lw.z, yaw + (lyaw || 0), tilt || 0);
      return _lw;
    }

    // ---- benches down both walls -------------------------------------------
    var benchGeo = this._finishGeo(K.bench(R), 'wood_plank',
      { noise: this.noise, grime: 0.40, edge: 0.34, hiY: 0.6 }, 520);
    for (i = 0; i < 3; i++) {
      var bz = -5.2 + i * 4.1;
      place('wood', benchGeo, -(hw - 0.95), bz, Math.PI * 0.5 + R.range(-0.03, 0.03), 0, -0.02);
      if (i !== 1) place('wood', benchGeo, hw - 0.95, bz + R.range(-0.4, 0.4),
        Math.PI * 0.5 + R.range(-0.03, 0.03), 0, -0.02);
    }
    // One bench overturned in the near third.  SOLVED AGAINST THE FRAMING'S
    // OWN CONE, not guessed: the eye stands at local (-0.4, 5.7) on a 78-degree
    // lens, so anything at local z = 4.7 has to be inside 0.8 m of the axis to
    // be in shot at all.  The first pass put it at x = -3.35 and it was two
    // metres off the left edge of the frame, along with the stove and the
    // lectern.  Everything below is inside |x| < 0.81 * (5.7 - z).
    place('wood', benchGeo, -2.30, 2.35, R.range(0.6, 1.0), 1.45, 0.34);

    // ---- the lectern, on the axis but off-centre ---------------------------
    place('wood', this._finishGeo(K.lectern(), 'wood_plank',
      { noise: this.noise, grime: 0.34, edge: 0.30, hiY: 1.1 }, 560), 1.50, 0.80, R.range(-0.4, 0.4));

    // ---- the stove somebody dragged in, and its flue -----------------------
    place('rust', this._finishGeo(K.stove(), 'rusted_metal',
      { noise: this.noise, grime: 0.66, edge: 0.34, hiY: 1.6 }, 460), -3.45, 0.55, R.range(-0.3, 0.3));
    // a scatter of split wood beside it, and the ash it has spread
    toWorld(cx, cz, yaw, -3.45, 0.55, _lw);
    var stx = _lw.x, stz = _lw.z;
    for (i = 0; i < 9; i++) {
      var a = R.range(0, M.TAU), rr = R.range(0.55, 1.35);
      this._drop(this.B.billet, stx + Math.cos(a) * rr, stz + Math.sin(a) * rr,
        { r: 0.08, y: fy, cap: false, onPath: true, onRoad: true, indoor: true, tilt: 0.25 });
    }
    this._mark(CELL.ash, stx + R.range(-0.4, 0.4), stz + R.range(-0.4, 0.4), 1.9, 1.7,
      R.range(0, 6.28), fy);
    this._drop(this.B.pail, stx + R.range(0.7, 1.3), stz + R.range(-1.0, -0.4),
      { r: 0.24, y: fy, cap: false, onPath: true, onRoad: true, indoor: true, tilt: 0.14 });

    // ---- the iconostasis end -----------------------------------------------
    // Boards leaning against the screen, face in.  An icon lying face up would
    // be a rendered picture nobody can read; face to the wall is what a
    // stripped church actually looks like and it costs no texture.
    var boardGeo = null;
    var BP = [];
    BP.push(part(box(0.62, 0.95, 0.045, 0.006), Tn(0, 0.475, 0)));
    BP.push(part(box(0.70, 0.06, 0.070, 0.006), Tn(0, 0.95, 0)));
    BP.push(part(box(0.70, 0.06, 0.070, 0.006), Tn(0, 0.02, 0)));
    boardGeo = mergeParts(BP, 0);
    disposeParts(BP);
    this._finishGeo(boardGeo, 'wood_plank', { noise: this.noise, grime: 0.42, edge: 0.36, hiY: 1.0 }, 540);
    for (i = 0; i < 4; i++) {
      place('wood', boardGeo, -3.2 + i * 2.1 + R.range(-0.3, 0.3), -6.55 + R.range(-0.15, 0.15),
        R.range(-0.25, 0.25), R.range(-0.30, -0.16));
    }

    // ---- the fallen chandelier ---------------------------------------------
    // A khoros that came down with the roof.  It is a strong dark ellipse on a
    // pale floor, ten metres from the eye, which is exactly the mid-ground mark
    // the framing was missing.
    var CP = [];
    CP.push(part(tube(0.72, 0.038, 18, 6), Tn(0, 0.04, 0, Math.PI * 0.5, 0, 0)));
    CP.push(part(tube(0.44, 0.030, 14, 5), Tn(0.10, 0.10, 0.06, Math.PI * 0.5 + 0.22, 0, 0.1)));
    for (i = 0; i < 10; i++) {
      var ca = i / 10 * M.TAU;
      CP.push(part(cyl(0.030, 0.034, 0.15, 6),
        Tn(Math.cos(ca) * 0.72, 0.10, Math.sin(ca) * 0.72, R.range(-0.5, 0.5), 0, R.range(-0.5, 0.5))));
    }
    for (i = 0; i < 3; i++) {
      var da = i / 3 * M.TAU + 0.3;
      CP.push(part(cyl(0.012, 0.012, 1.35, 4),
        Tn(Math.cos(da) * 0.45, 0.30, Math.sin(da) * 0.45, R.range(0.9, 1.4), da, 0)));
    }
    var chGeo = mergeParts(CP, 0);
    disposeParts(CP);
    this._finishGeo(chGeo, 'rusted_metal', { noise: this.noise, grime: 0.55, edge: 0.42, hiY: 0.5 }, 520);
    place('rust', chGeo, -1.15, -0.35, R.range(0, 6.28), R.range(-0.10, 0.10));

    // ---- the roof debris under the hole -------------------------------------
    // The level drops the drift and the snapped rafters; what is missing is the
    // BROKEN MATERIAL - slate, plaster and lath - and it collects on the
    // downwind rim of the cone, not evenly around it.
    var holeX = 1.9, holeZ = -1.6;
    for (i = 0; i < 26; i++) {
      var ha = R.range(0, M.TAU);
      var hr = 1.5 + Math.pow(R.next(), 0.5) * 3.4;
      toWorld(cx, cz, yaw, holeX + Math.cos(ha) * hr, holeZ + Math.sin(ha) * hr, _lw);
      var bat2 = R.next() < 0.6 ? this.B.chunk : this.B.plank;
      this._drop(bat2, _lw.x, _lw.z, {
        r: 0.18, y: fy, cap: false, onPath: true, onRoad: true, indoor: true, tilt: 0.7,
        scale: R.range(0.18, 0.5), sink: R.range(0, 0.03)
      });
    }
    // snow that has blown in and lodged against the debris
    for (i = 0; i < 7; i++) {
      var sa = R.range(0, M.TAU), sr = R.range(1.6, 4.2);
      toWorld(cx, cz, yaw, holeX + Math.cos(sa) * sr, holeZ + Math.sin(sa) * sr, _lw);
      this._snowCap(_lw.x, fy + 0.015, _lw.z, R.range(0.7, 1.8), R.range(0.7, 1.8),
        R.range(0.05, 0.13), R.range(0, 6.28));
    }
    // and a thin skin of it right across the far half of the floor, because a
    // roof with a two-metre hole in it in a blizzard does not have a dry nave
    for (i = 0; i < 5; i++) {
      toWorld(cx, cz, yaw, R.range(-hw + 1, hw - 1), R.range(-hz + 1.5, 1.0), _lw);
      this._snowCap(_lw.x, fy + 0.008, _lw.z, R.range(1.8, 3.4), R.range(1.8, 3.4), 0.035,
        R.range(0, 6.28));
    }

    // ---- candle stubs on the ledges -----------------------------------------
    for (i = 0; i < 5; i++) {
      var lxx = (i < 3 ? -1 : 1) * (hw - 0.62);
      var lzz = R.range(-4.5, 4.5);
      toWorld(cx, cz, yaw, lxx, lzz, _lw);
      this._put('lit', cyl(0.013, 0.015, R.range(0.05, 0.13), 5),
        _lw.x, fy + 0.86, _lw.z, 0, 0, 0);
    }

    // ---- the near third ------------------------------------------------------
    // Foreground, deliberately.  A nave photographed down its own axis with an
    // empty floor for the first four metres has no scale and no depth cue; two
    // small groups at local z = 3.6 and 2.4 give the eye something to measure
    // the drift and the piers against.
    var nearJunk = [[0.55, 3.55], [-0.35, 3.15], [1.05, 2.55], [-0.95, 2.30]];
    for (i = 0; i < nearJunk.length; i++) {
      toWorld(cx, cz, yaw, nearJunk[i][0], nearJunk[i][1], _lw);
      this._drop(R.next() < 0.55 ? this.B.plank : this.B.chunk, _lw.x, _lw.z, {
        r: 0.22, y: fy, cap: false, onPath: true, onRoad: true, indoor: true, tilt: 0.30,
        scale: R.range(0.35, 0.85), yaw: R.range(0, M.TAU)
      });
    }
    // a crate and a pail somebody carried in and left
    toWorld(cx, cz, yaw, 1.85, 2.05, _lw);
    this._drop(this.B.crate, _lw.x, _lw.z, {
      r: 0.45, y: fy, cap: false, onPath: true, onRoad: true, indoor: true, tilt: 0.05,
      yaw: yaw + R.range(-0.6, 0.6)
    });
    toWorld(cx, cz, yaw, 1.35, 2.75, _lw);
    this._drop(this.B.pail, _lw.x, _lw.z, {
      r: 0.24, y: fy, cap: false, onPath: true, onRoad: true, indoor: true, tilt: 0.55,
      yaw: R.range(0, M.TAU)
    });
    // the soot trodden up and down the nave
    toWorld(cx, cz, yaw, -0.2, 3.2, _lw);
    this._mark(CELL.ash, _lw.x, _lw.z, 3.6, 4.4, yaw, fy);
    void A;
  };

  // ==========================================================================
  // THE BROKEN BRIDGE
  //
  // hero2 is the approach to the break, so everything here is composed along
  // that approach: the barrier and the sandbags read at 5 m, the drums and the
  // sign at 10, the torn concrete and the bent rebar at 15, and the gorge floor
  // debris is the only thing telling you how far down it goes.
  // ==========================================================================
  PropsSnowbound.prototype._dressBridge = function () {
    var A = this.A, R = this.rng;
    if (!A || !A.bridge || !A.bridge.nearLip) return;
    var Bg = A.bridge;
    var near = Bg.nearLip, torn = Bg.tornEdge || near;
    var i;
    // road axis at the break, pointing north (toward the gorge)
    var ax = torn.x - near.x, az = torn.z - near.z;
    var al = Math.hypot(ax, az) || 1;
    ax /= al; az /= al;
    var px = -az, pz = ax;                        // across the carriageway
    var yaw = Math.atan2(ax, az);

    // ---- the sandbag emplacement on the approach ---------------------------
    // Somebody held this end of the bridge.  Three courses, staggered, banked
    // into the berm on one side - not a neat rectangle.
    // Set back four metres from the barrier and on the WEST shoulder, which
    // is the side the sign is not on: a position covering the approach, and a
    // composition where the two heaviest man-made masses on this stretch are
    // not stacked on the same third.
    var ex = near.x - ax * 4.6 - px * R.range(2.2, 3.2);
    var ez = near.z - az * 4.6 - pz * R.range(2.2, 3.2);
    var ey = this._ground(ex, ez);
    var bagW = 0.52;
    for (var c = 0; c < 3; c++) {
      var n = 7 - c;
      for (i = 0; i < n; i++) {
        var t = (i - (n - 1) * 0.5) * bagW;
        var sx = ex + px * t + ax * R.range(-0.05, 0.05);
        var sz = ez + pz * t + az * R.range(-0.05, 0.05);
        if (this.B.sack) {
          this.B.sack.add(T(sx, ey + 0.02 + c * 0.235, sz,
            R.gaussian(0, 0.06), yaw + Math.PI * 0.5 + R.gaussian(0, 0.12), R.gaussian(0, 0.06),
            1.45, 0.62, 1.05), wearTint(R));
        }
      }
    }
    // SNOW ON EVERY UPWARD FACE. hero2 photographed a clean, sharp, snow-free
    // checkpoint in the middle of a blizzard while the dacha roofs twelve
    // metres behind it carried 30 cm - the single most obvious way this frame
    // was losing. Every crown, lid, rail and top face at this checkpoint now
    // carries a load, and every base carries a windward bank.
    this._snowCap(ex, ey + 0.78, ez, bagW * 6.4, 0.70, 0.11, yaw + Math.PI * 0.5);
    for (i = 0; i < 6; i++) {
      var bcx = ex + px * (i - 2.5) * bagW * 0.92;
      var bcz = ez + pz * (i - 2.5) * bagW * 0.92;
      this._snowCap(bcx, ey + 0.72, bcz, bagW * 1.15, 0.66, R.range(0.10, 0.19),
        yaw + Math.PI * 0.5 + R.gaussian(0, 0.14));
      // and on the middle course's step-back, where a bag ledge catches it
      if (i % 2 === 0) {
        this._snowCap(bcx + ax * 0.30, ey + 0.48, bcz + az * 0.30, bagW * 1.0, 0.30, 0.08,
          yaw + Math.PI * 0.5);
      }
    }
    this._collider(ex, ey, ez, [bagW * 3.4, 0.36, 0.42], yaw + Math.PI * 0.5, 'sandbag');
    this._occupy(ex, ez, 2.2);
    this._bankFace(ex, ez, yaw, bagW * 3.2, this.windDir.x, this.windDir.y, 0.7, 5, 0.45);
    this._bankFace(ex, ez, yaw, bagW * 3.0, -this.windDir.x, -this.windDir.y, 0.55, 4, 0.30);
    this._collar(ex + px * 1.2, ey, ez + pz * 1.2, 1.10, 0.20);
    this._collar(ex - px * 1.2, ey, ez - pz * 1.2, 1.10, 0.20);
    // the kit inside the emplacement
    this._drop(this.B.ammo, ex + ax * R.range(-1.5, -0.8) + px * R.range(-1.0, 1.0),
      ez + az * R.range(-1.5, -0.8) + pz * R.range(-1.0, 1.0),
      { r: 0.42, onRoad: true, onPath: true, yaw: yaw + R.range(-0.4, 0.4),
        capW: 0.78, capD: 0.38, capY: 0.36, capH: 0.05 });
    this._drop(this.B.jerry, ex + ax * -1.6 + px * R.range(-1.6, 1.6),
      ez + az * -1.6 + pz * R.range(-1.6, 1.6),
      { r: 0.22, onRoad: true, onPath: true, capH: 0.03 });

    // ---- the barrier across the carriageway --------------------------------
    var trx = near.x - ax * 4.2, trz = near.z - az * 4.2;
    var trg = this._finishGeo(K.trestle(), 'wood_plank',
      { noise: this.noise, grime: 0.46, edge: 0.40, hiY: 1.0 }, 520);
    for (i = -1; i <= 1; i += 2) {
      var tx2 = trx + px * i * 1.45 + R.range(-0.2, 0.2);
      var tz2 = trz + pz * i * 1.45 + R.range(-0.2, 0.2);
      var tyaw = yaw + Math.PI * 0.5 + R.range(-0.25, 0.25);
      var ty2 = this._putSettled('wood', trg, tx2, tz2, tyaw, 0.8, -0.06);
      // the top rail, the mid rail and both trestle feet all catch snow: bare
      // timber with crisp arrises in a whiteout reads as a prop from another
      // level dropped into this one
      this._snowCap(tx2, ty2 + 0.99, tz2, 1.45, 0.20, 0.12, tyaw);
      this._snowCap(tx2, ty2 + 0.63, tz2, 1.40, 0.15, 0.07, tyaw);
      for (var tl = -1; tl <= 1; tl += 2) {
        var flx = tx2 + Math.cos(tyaw) * tl * 0.58;
        var flz = tz2 - Math.sin(tyaw) * tl * 0.58;
        this._snowCap(flx, ty2 + 0.38, flz, 0.24, 0.50, 0.06, tyaw);
        this._collar(flx, ty2, flz, 0.42, 0.13);
      }
      this._drift(tx2 + this.windDir.x * 0.75, tz2 + this.windDir.y * 0.75, R.range(0.45, 0.75));
      this._occupy(tx2, tz2, 0.9);
    }
    // One of them knocked flat, which is what says a vehicle came through.
    // The height is sampled AT THE POSITION IT LIES IN, not at the standing
    // pair's - they are three metres apart across a plough berm, and using the
    // wrong one left a barrier hanging a metre over the bank.
    var kfx = trx + px * R.range(-3.2, -2.2), kfz = trz + pz * R.range(-0.6, 0.6);
    this._put('wood', trg, kfx, this._ground(kfx, kfz) + 0.06, kfz,
      yaw + R.range(0, 6.28), 1.52, R.range(-0.2, 0.2));

    // ---- hazard drums, half buried -----------------------------------------
    // Clean cylinders with no windward drift piled against them and no scour on
    // the lee is exactly what a drum in a gale does not look like.
    for (i = 0; i < 5; i++) {
      var dd = R.range(-6.4, -1.5);
      var dl = R.range(-3.6, 3.6);
      var dxx = near.x + ax * dd + px * dl, dzz = near.z + az * dd + pz * dl;
      var dyy = this._drop(this.B.drum, dxx, dzz, {
        r: 0.45, onRoad: true, onPath: true, sink: R.range(0.05, 0.32), tilt: 0.14,
        capW: 0.62, capD: 0.62, capY: 0.885, capH: 0.13,
        collarR: 0.62, collarH: 0.19,
        collider: [0.30, 0.44, 0.30], material: 'metal'
      });
      if (dyy !== null) {
        // the windward bank against the flank, and the scour hollow downwind
        this._drift(dxx - this.windDir.x * 0.44, dzz - this.windDir.y * 0.44,
          R.range(0.42, 0.62), dyy, 0.55);
        this._drift(dxx + this.windDir.x * 1.05, dzz + this.windDir.y * 1.05,
          R.range(0.30, 0.50), dyy, 0.42);
        // a ledge of snow on the top chime
        this._snowCap(dxx, dyy + 0.60, dzz, 0.66, 0.30, 0.07, R.range(0, M.TAU));
      }
    }

    // ---- the near foreground on the approach ---------------------------------
    // Measured off the BRIDGE anchor, not off a framing: 10.5 m back down the
    // carriageway from the near lip and 2.5 m onto its west side. That is where
    // a load that came off the last lorry to try this road would be, and it is
    // also - because hero2 stands 4 m further back on the east side - the near
    // LEFT of that frame, which had nothing inside six metres and therefore no
    // scale reference at all.
    var spx = near.x - ax * 10.5 - px * 2.5;
    var spz = near.z - az * 10.5 - pz * 2.5;
    var spy = this._ground(spx, spz);
    this._drop(this.B.drum, spx, spz, {
      r: 0.50, onRoad: true, onPath: true, tilt: 0.9,
      yaw: yaw + R.range(0.4, 1.1), sink: R.range(0.14, 0.30),
      capW: 0.80, capD: 0.55, capY: 0.30, capH: 0.10, collarR: 0.75, collarH: 0.20
    });
    for (i = 0; i < 3; i++) {
      this._drop(this.B.crate, spx + px * R.range(0.7, 1.9) + ax * R.range(-1.1, 0.9),
        spz + pz * R.range(0.7, 1.9) + az * R.range(-1.1, 0.9), {
          r: 0.44, onRoad: true, onPath: true, tilt: 0.30,
          sink: R.range(0.04, 0.26), scale: R.range(0.85, 1.2),
          capW: 0.72, capD: 0.62, capY: 0.50, capH: 0.13
        });
    }
    this._drop(this.B.tyre, spx - px * R.range(0.9, 1.6), spz - pz * R.range(0.9, 1.6), {
      r: 0.55, onRoad: true, onPath: true, tilt: 0.20, sink: R.range(0.16, 0.36),
      capW: 0.82, capD: 0.82, capY: 0.14, capH: 0.07
    });
    this._drift(spx + this.windDir.x * 1.3, spz + this.windDir.y * 1.3, R.range(0.7, 1.1), spy);
    this._mark(CELL.diesel, spx + ax * 1.4, spz + az * 1.4, 2.2, 1.8, yaw, spy);

    // ---- the sign ------------------------------------------------------------
    // Well off the road's centreline.  The level already puts a striped
    // barrier on this approach and calls it the only saturated thing in the
    // northern half of the map; a second red mark dead centre fights it, so
    // this one sits out on the berm where it frames rather than blocks.
    // 5.6 m short of the barrier, out on the berm.  That is where a closure
    // board actually stands - immediately before the trestles, off the
    // carriageway so a plough can still get past it - and it is measured from
    // the BRIDGE anchor, not from a framing.
    this._signBoard(near.x - ax * 5.6 + px * R.range(4.2, 4.8),
      near.z - az * 5.6 + pz * R.range(4.2, 4.8), yaw + Math.PI + R.range(-0.4, 0.4),
      1.10, 0.74, 'sign2');

    // ---- torn concrete and bent rebar at the break --------------------------
    for (i = 0; i < 20; i++) {
      var ca = R.range(0, M.TAU), cr = Math.pow(R.next(), 0.6) * 4.6;
      var cxp = torn.x + Math.cos(ca) * cr - ax * R.range(0, 2.2);
      var czp = torn.z + Math.sin(ca) * cr - az * R.range(0, 2.2);
      this._drop(this.B.chunk, cxp, czp, {
        r: 0.30, onRoad: true, onPath: true, tilt: 0.65, scale: R.range(0.3, 0.95),
        capW: 0.7, capD: 0.7, capY: 0.28, capH: 0.06
      });
    }
    // rebar whiskers standing out of the torn slab
    var RP = [];
    for (i = 0; i < 14; i++) {
      var rr = R.range(-2.6, 2.6);
      var seg = 4, prevx = rr, prevy = 0, prevz = 0;
      for (var s2 = 1; s2 <= seg; s2++) {
        var q = s2 / seg;
        var nxp = rr + R.gaussian(0, 0.12) * s2;
        var nyp = -q * R.range(0.5, 1.5);
        var nzp = -q * R.range(0.4, 1.9);
        RP.push(part(cyl(0.011, 0.011, Math.hypot(nxp - prevx, nyp - prevy, nzp - prevz) || 0.1, 4),
          strut(prevx, prevy, prevz, nxp, nyp, nzp)));
        prevx = nxp; prevy = nyp; prevz = nzp;
      }
    }
    var rbg = mergeParts(RP, 0);
    disposeParts(RP);
    if (rbg) {
      this._finishGeo(rbg, 'rusted_metal', { noise: this.noise, grime: 0.6, edge: 0.5, hiY: 1.0 }, 700);
      this._put('rust', rbg, torn.x, torn.y - 0.10, torn.z, yaw);
    }

    // ---- the gorge floor -----------------------------------------------------
    // Twelve metres down.  Two dozen chunks and a wheel is all it takes to give
    // the hole a bottom, and without a bottom hero2 is a white band.
    var gz = (Bg.gorge && Bg.gorge.z) || torn.z - 3;
    for (i = 0; i < 26; i++) {
      var gxp = torn.x + R.range(-16, 16);
      var gzp = gz + R.range(-5.5, 5.5);
      var gyp = this._ground(gxp, gzp);
      if (this.B.chunk) {
        this.B.chunk.add(T(gxp, gyp - R.range(0.05, 0.35), gzp,
          R.range(-0.6, 0.6), R.range(0, 6.28), R.range(-0.6, 0.6),
          R.range(0.5, 1.9), R.range(0.4, 1.3), R.range(0.5, 1.9)), wearTint(R));
      }
      if (R.next() < 0.22) this._snowCap(gxp, gyp + 0.10, gzp, R.range(0.9, 2.0),
        R.range(0.9, 2.0), R.range(0.06, 0.16), R.range(0, 6.28));
    }
    var wx = torn.x + R.range(-4, 4), wz = gz + R.range(-2, 2);
    this._drop(this.B.tyre, wx, wz, { r: 0.6, onRoad: true, onPath: true,
      tilt: 0.8, sink: R.range(0.1, 0.3), capH: 0.04 });
  };

  // A board on two posts.  The face is a card in its own bucket so it can carry
  // the sign texture; the posts are timber like everything else.
  PropsSnowbound.prototype._signBoard = function (x, z, yaw, w, h, texKey) {
    var R = this.rng;
    if (!this._inBounds(x, z, 1.5)) return;
    var y = this._ground(x, z);
    var lean = R.range(-0.09, 0.09);
    var postH = 1.45 + h;
    var P = [];
    for (var s = -1; s <= 1; s += 2) {
      P.push(part(box(0.085, postH, 0.085, 0.006), Tn(s * (w * 0.5 - 0.12), postH * 0.5, 0)));
    }
    P.push(part(box(w + 0.10, 0.055, 0.055, 0.005), Tn(0, 1.42, 0.045)));
    P.push(part(box(w + 0.10, 0.055, 0.055, 0.005), Tn(0, 1.42 + h, 0.045)));
    var g = mergeParts(P, 0);
    disposeParts(P);
    if (g) {
      this._finishGeo(g, 'wood_plank', { noise: this.noise, grime: 0.44, edge: 0.34, hiY: 2.0 }, 520);
      this._putSettled('wood', g, x, z, yaw, 0.7, -0.18, 0.45);
    }
    var face = card(w, h);
    var mat = texKey === 'sign2' ? 'sign2' : 'sign';
    // the two boards use two textures, so the second one gets its own bucket
    var bucket = mat === 'sign2' ? 'sign2' : 'sign';
    if (!this.S[bucket]) this.S[bucket] = [];
    this.S[bucket].push(part(face, Tn(x, y - 0.18 + 1.42, z, lean, yaw, 0)));
    this._snowCap(x, y - 0.18 + 1.42 + h, z, w * 0.98, 0.10, 0.05, yaw);
    this._collider(x, y, z, [w * 0.5, 1.2, 0.10], yaw, 'wood');
    this._occupy(x, z, 0.9);
  };

  // ==========================================================================
  // ROADSIDE
  // ==========================================================================
  PropsSnowbound.prototype._dressRoadside = function () {
    var A = this.A, R = this.rng, i;
    var b = this.bounds;

    // ---- the village board at the pass entrance -----------------------------
    var sz = 52;
    var sx = this.roadX(sz) + (this.roadHalf + this.bermW + 1.4);
    this._signBoard(sx, sz, Math.PI + R.range(-0.2, 0.2), 2.15, 0.78, 'sign');

    // ---- grit, and what the plough threw into the berm ---------------------
    for (var z = b.z0 + 6; z < b.z1 - 6; z += 7.5) {
      var side = R.bool() ? 1 : -1;
      var off = R.range(this.roadHalf + 0.3, this.roadHalf + this.bermW * 1.1);
      var x = this.roadX(z) + side * off;
      var pick = R.next();
      if (pick < 0.28) {
        this._drop(this.B.plank, x, z, {
          r: 0.22, settleR: 0.55, onRoad: true, tilt: 0.30, sink: R.range(0.04, 0.22),
          scale: R.range(0.7, 1.15), cap: false
        });
        this._drift(x, z, R.range(0.35, 0.6));
      } else if (pick < 0.44) {
        this._drop(this.B.tyre, x, z, { r: 0.55, sink: R.range(0.2, 0.5), tilt: 0.5,
          capW: 0.8, capD: 0.8, capY: 0.12, capH: 0.05 });
      } else if (pick < 0.60) {
        this._drop(this.B.crate, x, z, { r: 0.45, sink: R.range(0.05, 0.35), tilt: 0.35,
          capW: 0.7, capD: 0.6, capY: 0.48, capH: 0.10 });
      } else if (pick < 0.72) {
        this._drop(this.B.drum, x, z, { r: 0.42, sink: R.range(0.15, 0.45), tilt: 0.6,
          capW: 0.6, capD: 0.6, capY: 0.60, capH: 0.06 });
      }
      // the grit the plough spreads, on the carriageway itself
      if (R.next() < 0.5) {
        this._mark(CELL.diesel, this.roadX(z) + R.range(-2.4, 2.4), z + R.range(-2, 2),
          R.range(2.0, 3.6), R.range(1.6, 3.0), R.range(0, 6.28), undefined);
      }
    }

    // ---- rags caught on the fences ------------------------------------------
    // Litter in a blizzard does not lie about; it travels until something stops
    // it, and then it stays on the WINDWARD face of that thing, held there.
    if (A && A.dachas) {
      for (i = 0; i < A.dachas.length; i++) {
        if (R.next() > 0.45) continue;
        var d = A.dachas[i];
        if (!d || !d.centre) continue;
        var w2 = this.windDir;
        var fx = d.centre.x - w2.x * ((d.w || 7) * 0.5 + R.range(2.2, 3.0));
        var fz = d.centre.z - w2.y * ((d.d || 9) * 0.5 + R.range(2.2, 3.0));
        if (!this._inBounds(fx, fz, 1)) continue;
        var fy = this._ground(fx, fz) + R.range(0.45, 0.85);
        var rag = K.sheet(R.range(0.35, 0.65), R.range(0.4, 0.8), 0.10, 4, 4,
          function (u, v) { return M.saturate(1.35 - v * 1.8); }, this.noise);
        this._clothPart(rag, fx, fy, fz, Math.atan2(w2.x, w2.y) + R.range(-0.4, 0.4), 'canvas');
      }
    }

    // ---- the marker posts get drifts, because everything standing does ------
    if (A && A.road && A.road.marks) {
      for (i = 0; i < A.road.marks.length; i += 2) {
        var mk = A.road.marks[i];
        if (!mk) continue;
        this._drift(mk.x, mk.z, R.range(0.30, 0.55), mk.y);
      }
    }
  };

  // ==========================================================================
  // VEGETATION
  //
  // The rule that makes this read: DEAD GRASS ONLY SHOWS WHERE THE SNOW IS
  // THIN, and the snow is thin exactly where the wind has scoured - on the
  // convex crests, never in a hollow.  So the test is the discrete curvature of
  // the level's own height field, not a random number, and the result is that
  // the tufts trace the shape of the ground the way they do in a photograph.
  // Uniform scatter here would flatten the whole snowfield.
  // ==========================================================================
  PropsSnowbound.prototype._curvature = function (x, z) {
    var s = 0.9;
    var y0 = this._ground(x, z);
    var av = (this._ground(x - s, z) + this._ground(x + s, z) +
      this._ground(x, z - s) + this._ground(x, z + s)) * 0.25;
    return y0 - av;              // positive = crest
  };

  PropsSnowbound.prototype._slope = function (x, z) {
    var s = 0.8;
    var dx = this._ground(x + s, z) - this._ground(x - s, z);
    var dz = this._ground(x, z + s) - this._ground(x, z - s);
    return Math.sqrt(dx * dx + dz * dz) / (2 * s);
  };

  PropsSnowbound.prototype._dressVegetation = function () {
    var R = this.rng, b = this.bounds, i;
    var A = this.A;
    var westX = (A && A.treeline && A.treeline.westX) || null;

    // ---- dead grass ---------------------------------------------------------
    var want = 900, tries = 0;
    var got = 0;
    while (got < want && tries < want * 5) {
      tries++;
      var x = R.range(b.x0, b.x1);
      var z = R.range(b.z0, b.z1);
      var off = Math.abs(this._roadOffset(x, z));
      // never on the carriageway, and never on the berm: that is fresh thrown
      // snow a plough put there this morning, and nothing grows out of it
      if (off < this.roadHalf + this.bermW + 0.35) continue;
      if (off > 34) continue;                       // the valley walls are rock
      if (this._pathDist(x, z) < 1.2) continue;
      if (this._inChurch(x, z, 0)) continue;
      var cur = this._curvature(x, z);
      if (cur < 0.005) continue;                    // hollows stay buried
      if (this._slope(x, z) > 0.75) continue;
      var y = this._ground(x, z);
      if (this._blocked(x, y + 0.35, z, 0.35)) continue;
      // density follows how proud the crest is
      if (R.next() > M.saturate(cur * 22)) continue;
      var sc = R.range(0.62, 1.35) * (0.75 + M.saturate(cur * 9) * 0.5);
      if (!this.B.tuft) break;
      // clumps, not individuals: grass grows in company
      var nC = R.int(1, 4);
      for (var c = 0; c < nC && got < want; c++) {
        var jx = x + R.gaussian(0, 0.42), jz = z + R.gaussian(0, 0.42);
        var jy = this._ground(jx, jz);
        this.B.tuft.add(T(jx, jy - R.range(0.02, 0.10), jz,
          R.gaussian(0, 0.06), R.range(0, M.TAU), R.gaussian(0, 0.06),
          sc * R.range(0.85, 1.15), sc * R.range(0.8, 1.25), sc * R.range(0.85, 1.15)),
          wearTint(R));
        got++;
      }
    }

    // ---- scrub --------------------------------------------------------------
    // Bare rimed bushes, in the lee of anything that shelters them: the gorge
    // shoulder, the foot of the east buttress, the edge of the pines.
    var sWant = 190, sTries = 0, sGot = 0;
    while (sGot < sWant && sTries < sWant * 6) {
      sTries++;
      var sx = R.range(b.x0, b.x1), sz2 = R.range(b.z0, b.z1);
      var soff = Math.abs(this._roadOffset(sx, sz2));
      if (soff < this.roadHalf + this.bermW + 2.5 || soff > 36) continue;
      if (this._pathDist(sx, sz2) < 2.0) continue;
      if (this._inChurch(sx, sz2, 0)) continue;
      if (this._slope(sx, sz2) > 0.85) continue;
      var sy = this._ground(sx, sz2);
      if (this._blocked(sx, sy + 0.6, sz2, 0.6)) continue;
      // prefer the outer thirds - scrub survives where nobody walks
      if (R.next() > M.smoothstep(8, 26, soff) * 0.85 + 0.15) continue;
      if (!this.B.scrub) break;
      var cl = R.int(1, 3);
      for (var k = 0; k < cl && sGot < sWant; k++) {
        var bx = sx + R.gaussian(0, 0.7), bz = sz2 + R.gaussian(0, 0.7);
        var by = this._ground(bx, bz);
        var bs = R.range(0.55, 1.25);
        this.B.scrub.add(T(bx, by - R.range(0.05, 0.22), bz,
          R.gaussian(0, 0.05), R.range(0, M.TAU), R.gaussian(0, 0.05),
          bs * R.range(0.85, 1.2), bs * R.range(0.8, 1.3), bs * R.range(0.85, 1.2)),
          wearTint(R));
        sGot++;
        if (R.next() < 0.4) this._drift(bx, bz, R.range(0.30, 0.62), by);
      }
    }

    // ---- saplings -----------------------------------------------------------
    // Young spruce ahead of the treeline, thinning as they come down the slope
    // toward the village - a forest edge is a gradient, never a wall.
    var pWant = 200, pTries = 0, pGot = 0;
    while (pGot < pWant && pTries < pWant * 7) {
      pTries++;
      var px = R.range(b.x0, b.x1), pz = R.range(b.z0, b.z1);
      var poff = this._roadOffset(px, pz);
      var apoff = Math.abs(poff);
      if (apoff < 14) continue;
      var edge = westX ? Math.abs(px - westX(pz)) : Math.abs(apoff - 26);
      // density peaks at the treeline and falls off both ways
      var dens = Math.exp(-edge * edge / 90);
      if (R.next() > dens * 0.85 + 0.04) continue;
      if (this._pathDist(px, pz) < 2.5) continue;
      if (this._inChurch(px, pz, 1.5)) continue;
      var py = this._ground(px, pz);
      if (this._blocked(px, py + 1.0, pz, 0.8)) continue;
      if (this._occupied(px, pz, 0.8)) continue;
      if (!this.B.sapling) break;
      var ps = R.range(0.5, 1.35);
      this.B.sapling.add(T(px, py - R.range(0.05, 0.30), pz,
        R.gaussian(0, 0.045), R.range(0, M.TAU), R.gaussian(0, 0.045),
        ps * R.range(0.9, 1.1), ps * R.range(0.85, 1.25), ps * R.range(0.9, 1.1)),
        wearTint(R));
      this._occupy(px, pz, 0.7);
      pGot++;
      // the cone of snow that falls off a young spruce and piles at its foot
      if (R.next() < 0.55) this._drift(px, pz, ps * R.range(0.35, 0.7), py);
    }
    this.stats.veg = { tufts: got, scrub: sGot, saplings: pGot };
  };

  // ==========================================================================
  // DRIFTS AGAINST THE BUILDINGS
  //
  // level_snowbound's height field already banks a lee drift against every
  // structure it knows about, at 0.62 m sampling.  What a 0.62 m lattice cannot
  // resolve is the TOOTH of the thing: the scallops along its crest, the corner
  // where two faces meet and the drift doubles, the tail streaming off the
  // downwind corner.  These are those.
  // ==========================================================================
  PropsSnowbound.prototype._dressDrifts = function () {
    var A = this.A, R = this.rng;
    if (!A) return;
    var w = this.windDir, i;

    function faces(cx, cz, yaw, hx, hz) {
      var c = Math.cos(yaw), s = Math.sin(yaw);
      return [
        { nx: c, nz: -s, half: hz, off: hx },     // local +X
        { nx: -c, nz: s, half: hz, off: hx },     // local -X
        { nx: s, nz: c, half: hx, off: hz },      // local +Z
        { nx: -s, nz: -c, half: hx, off: hz }     // local -Z
      ];
    }

    var list = [];
    if (A.dachas) {
      for (i = 0; i < A.dachas.length; i++) {
        var d = A.dachas[i];
        if (d && d.centre) list.push({ c: d.centre, yaw: d.yaw || 0,
          hx: (d.w || 7) * 0.5, hz: (d.d || 9) * 0.5, amp: 0.85 });
      }
    }
    if (A.church && A.church.centre) {
      list.push({ c: A.church.centre, yaw: A.church.yaw || 0,
        hx: (A.church.nave && A.church.nave.hw) || 5.5,
        hz: (A.church.nave && A.church.nave.hz) || 7.8, amp: 1.15 });
      if (A.church.tower) {
        list.push({ c: A.church.tower, yaw: A.church.yaw || 0, hx: 3.1, hz: 3.1, amp: 1.0 });
      }
    }
    if (A.barn && A.barn.centre) {
      list.push({ c: A.barn.centre, yaw: A.barn.yaw || 0,
        hx: (A.barn.w || 9) * 0.5, hz: (A.barn.d || 14) * 0.5, amp: 1.1 });
    }

    for (i = 0; i < list.length; i++) {
      var it = list[i];
      var F = faces(it.c.x, it.c.z, it.yaw, it.hx, it.hz);
      for (var f = 0; f < 4; f++) {
        var ff = F[f];
        var lee = ff.nx * w.x + ff.nz * w.y;       // +1 fully downwind
        if (lee < -0.25) {
          // the windward face is SCOURED: a thin, hard, low bank, and last
          // summer's grass showing through where the snow has been stripped
          this._bankFace(it.c.x, it.c.z, it.yaw, ff.half * 0.9, ff.nx, ff.nz,
            ff.off + 0.35, 3, it.amp * 0.28);
          this._tuftSkirt(it.c.x, it.c.z, it.yaw, ff.half * 0.95, ff.nx, ff.nz,
            ff.off + 0.75, Math.max(3, Math.round(ff.half * 1.3)));
        } else {
          var n = Math.max(3, Math.round(ff.half * 0.85));
          this._bankFace(it.c.x, it.c.z, it.yaw, ff.half * 0.95, ff.nx, ff.nz,
            ff.off + 0.55 + lee * 0.45, n, it.amp * (0.45 + 0.75 * M.saturate(lee)));
        }
      }
      // the two downwind corners, where two banks meet and the drift doubles
      for (var cx2 = -1; cx2 <= 1; cx2 += 2) {
        for (var cz2 = -1; cz2 <= 1; cz2 += 2) {
          var c2 = Math.cos(it.yaw), s2 = Math.sin(it.yaw);
          var wx = it.c.x + (cx2 * it.hx) * c2 + (cz2 * it.hz) * s2;
          var wz = it.c.z - (cx2 * it.hx) * s2 + (cz2 * it.hz) * c2;
          var dot = ((wx - it.c.x) * w.x + (wz - it.c.z) * w.y);
          if (dot <= 0) continue;
          this._drift(wx + w.x * 0.8, wz + w.y * 0.8, it.amp * R.range(1.1, 1.8));
          this._drift(wx + w.x * 2.1, wz + w.y * 2.1, it.amp * R.range(0.7, 1.2));
        }
      }
    }
  };

  // ==========================================================================
  // ICICLES
  //
  // Under every eave in the village.  A roof carrying a 30 cm snow load with a
  // stove lit under it drips, and what drips freezes: this is the one detail
  // that says the houses are WARM INSIDE, which is the whole emotional content
  // of the level.  The lit houses therefore get the longest ones.
  // ==========================================================================
  PropsSnowbound.prototype._dressIcicles = function () {
    var A = this.A, R = this.rng, i, k;
    if (!A) return;

    if (A.dachas) {
      for (i = 0; i < A.dachas.length; i++) {
        var d = A.dachas[i];
        if (!d || !d.centre) continue;
        var yaw = d.yaw || 0;
        var hw = (d.w || 7) * 0.5 + 0.52, hd = (d.d || 9) * 0.5 + 0.18;
        var eave = d.eave === undefined ? d.centre.y + 3.0 : d.eave;
        var maxL = d.lit ? R.range(0.55, 1.05) : R.range(0.22, 0.55);
        if (d.ruin) maxL *= 0.5;
        for (var sgn = -1; sgn <= 1; sgn += 2) {
          var rows = 3;
          for (k = 0; k < rows; k++) {
            var lz = -hd + (k + 0.5) * (hd * 2) / rows + R.range(-0.4, 0.4);
            toWorld(d.centre.x, d.centre.z, yaw, sgn * hw, lz, _lw);
            this._icicles(_lw.x, eave - 0.04, _lw.z, yaw + Math.PI * 0.5,
              (hd * 2) / rows * 0.85, maxL * R.range(0.7, 1.25));
          }
        }
        // the porch, which is where they get longest because it is right over
        // the door and the door is what keeps opening
        toWorld(d.centre.x, d.centre.z, yaw, -0.15, -(d.d || 9) * 0.5 - 1.32, _lw);
        this._icicles(_lw.x, d.centre.y + 2.42, _lw.z, yaw, 2.0, maxL * 1.35);
      }
    }

    if (A.church && A.church.centre) {
      var C = A.church, cyaw = C.yaw || 0;
      var chw = ((C.nave && C.nave.hw) || 5.5) + 0.55;
      var chz = ((C.nave && C.nave.hz) || 7.8);
      for (var cs = -1; cs <= 1; cs += 2) {
        for (k = 0; k < 4; k++) {
          var clz = -chz + (k + 0.5) * (chz * 2) / 4;
          toWorld(C.centre.x, C.centre.z, cyaw, cs * chw, clz, _lw);
          this._icicles(_lw.x, C.eave - 0.05, _lw.z, cyaw + Math.PI * 0.5,
            (chz * 2) / 4 * 0.9, R.range(0.30, 0.75));
        }
      }
    }

    if (A.barn && A.barn.centre) {
      var b = A.barn, byaw = b.yaw || 0;
      var bhw = (b.w || 9) * 0.5 + 0.5, bhd = (b.d || 14) * 0.5;
      for (var bs = -1; bs <= 1; bs += 2) {
        for (k = 0; k < 4; k++) {
          var blz = -bhd + (k + 0.5) * (bhd * 2) / 4;
          toWorld(b.centre.x, b.centre.z, byaw, bs * bhw, blz, _lw);
          this._icicles(_lw.x, b.eave - 0.05, _lw.z, byaw + Math.PI * 0.5,
            (bhd * 2) / 4 * 0.9, R.range(0.20, 0.50));
        }
      }
    }
  };

  // ==========================================================================
  // LIFE, AND SMOKE
  // ==========================================================================
  PropsSnowbound.prototype._dressLife = function () {
    var A = this.A, R = this.rng, i;
    if (!A) return;
    var perch = [];
    // marker posts down the road: the classic perch, and they are already
    // spaced along the leading line of the hero framing
    if (A.road && A.road.marks) {
      for (i = 3; i < A.road.marks.length; i += 5) {
        var m2 = A.road.marks[i];
        if (m2) perch.push([m2.x, m2.y + 1.46, m2.z]);
      }
    }
    // truck bonnets - a bird will sit on anything that was warm this morning
    if (A.convoy) {
      for (i = 0; i < A.convoy.length; i += 2) {
        var t = A.convoy[i];
        if (!t || !t.centre) continue;
        perch.push([t.centre.x + Math.sin(t.yaw || 0) * 2.6, t.centre.y + 1.98,
          t.centre.z + Math.cos(t.yaw || 0) * 2.6]);
      }
    }
    if (this.wellAt) perch.push([this.wellAt.x, this.wellAt.y + 2.72, this.wellAt.z]);
    if (A.barn && A.barn.centre) {
      perch.push([A.barn.centre.x, A.barn.ridge + 0.10, A.barn.centre.z]);
    }
    var bat = this.B.raven;
    if (bat) {
      for (i = 0; i < perch.length && i < 14; i++) {
        var p = perch[i];
        if (R.next() < 0.28) continue;
        // hunched, and facing INTO the wind, which is what a bird actually does
        var yaw = Math.atan2(-this.windDir.x, -this.windDir.y) + R.gaussian(0, 0.35);
        var sc = R.range(0.88, 1.14);
        bat.add(T(p[0] + R.range(-0.06, 0.06), p[1], p[2] + R.range(-0.06, 0.06),
          R.gaussian(0, 0.05), yaw, R.gaussian(0, 0.04), sc, sc, sc), wearTint(R));
        this.ravens.push({ x: p[0], y: p[1], z: p[2], yaw: yaw, sc: sc,
          phase: R.range(0, 6.283) });
      }
    }

    // ---- chimney smoke -------------------------------------------------------
    // Only the houses the level says are lit.  Two cards crossed, standing on
    // the pot, with the flex ramp increasing up the plume so the wind shears the
    // top and leaves the base where the chimney is.
    if (!A.dachas) return;
    for (i = 0; i < A.dachas.length; i++) {
      var d = A.dachas[i];
      if (!d || !d.lit || !d.centre) continue;
      var dy = d.yaw || 0;
      // the level puts the chimney at local (w*0.21, d*0.10), top ridge + 1.05
      toWorld(d.centre.x, d.centre.z, dy, (d.w || 7) * 0.21, (d.d || 9) * 0.10, _lw);
      var top = (d.ridge === undefined ? d.centre.y + 5.0 : d.ridge) + 1.20;
      var H = R.range(4.2, 6.2), W = R.range(1.5, 2.4);
      for (var c = 0; c < 2; c++) {
        var g = card(W, H);
        setFlex(g, function (x, y) { return M.saturate(y / H); });
        Geo.copyUV1(g);
        this.smokeParts.push({
          geo: g,
          m: Tn(_lw.x, top, _lw.z, 0, dy + c * Math.PI * 0.5 + R.range(-0.3, 0.3), 0)
        });
      }
    }
  };

  // ==========================================================================
  // FRAMING BACKSTOP
  //
  // Runs last and reads back what is already there.  For each published
  // framing, if the near third is empty it plants a small foreground group
  // OFF the view axis - never on it.  A whiteout with nothing inside six metres
  // has no scale reference at all, which is the specific way this level would
  // fail: correct exposure, correct fog, and no idea how big anything is.
  // ==========================================================================
  PropsSnowbound.prototype._dressPoses = function () {
    var L = this.L, R = this.rng;
    if (!L || !L.cameraPoses) return;
    var keys = ['hero1', 'hero2', 'hero3', 'overview', 'interior'];
    for (var i = 0; i < keys.length; i++) {
      var p = L.cameraPoses[keys[i]];
      if (!p || !p.position) continue;
      if (keys[i] === 'interior') continue;          // dressed by hand above
      var yaw = p.yaw || 0;
      var fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      var rx = Math.cos(yaw), rz = -Math.sin(yaw);
      // is there anything at all in the near third?
      var occupied = false;
      for (var d = 2.5; d < 7.5 && !occupied; d += 1.2) {
        for (var s = -2.6; s <= 2.6 && !occupied; s += 1.3) {
          var qx = p.position.x + fx * d + rx * s;
          var qz = p.position.z + fz * d + rz * s;
          if (this._occupied(qx, qz, 0.9)) occupied = true;
          if (this._blocked(qx, this._ground(qx, qz) + 0.8, qz, 0.8)) occupied = true;
        }
      }
      if (occupied) continue;
      // Plant it to one side, low, and out of the way: 2.4-3.6 m off axis at
      // 4-6 m, nothing over 0.8 m tall.  It reads as foreground, not as a
      // barricade somebody put in front of the lens.
      // Off the carriageway, always.  A boulder standing in a road somebody
      // ploughed this morning is a worse failure than an empty near third, so
      // the drop is NOT allowed on the road and both sides are tried before
      // giving up.
      var bx = 0, bz = 0, by = 0, ok = false;
      for (var att = 0; att < 6 && !ok; att++) {
        var side = (att & 1) ? -1 : 1;
        var dd = R.range(4.0, 6.5), lat = side * R.range(2.6, 5.2);
        bx = p.position.x + fx * dd + rx * lat;
        bz = p.position.z + fz * dd + rz * lat;
        ok = this._inBounds(bx, bz, 2) && !this._onRoad(bx, bz) && this._pathDist(bx, bz) > 1.0;
      }
      if (!ok) continue;
      by = this._ground(bx, bz);
      // a snow-buried mass with grass off its crest: the cheapest honest
      // foreground this level has, and it cannot look out of place anywhere
      this._drop(this.B.chunk, bx, bz, {
        r: 0.7, onPath: true, tilt: 0.4, scale: R.range(0.75, 1.25),
        sink: R.range(0.05, 0.30), capW: 1.3, capD: 1.2, capY: 0.45, capH: 0.14
      });
      for (var k = 0; k < 6; k++) {
        var tx = bx + R.gaussian(0, 0.9), tz = bz + R.gaussian(0, 0.9);
        if (this.B.tuft) {
          this.B.tuft.add(T(tx, this._ground(tx, tz) - 0.05, tz,
            R.gaussian(0, 0.06), R.range(0, M.TAU), R.gaussian(0, 0.06),
            R.range(0.8, 1.4), R.range(0.8, 1.5), R.range(0.8, 1.4)), wearTint(R));
        }
      }
      this._drift(bx, bz, R.range(0.8, 1.4), by);
      if (R.next() < 0.5) {
        this._drop(this.B.plank, bx + R.gaussian(0, 1.2), bz + R.gaussian(0, 1.2),
          { r: 0.2, settleR: 0.55, onRoad: true, onPath: true, tilt: 0.35, cap: false });
      }
    }
  };

  // ==========================================================================
  // NEAR-FIELD MARKS
  //
  // The level owns the footprints and the tyre ruts (it owns the boot/tread
  // atlas); this file owns everything a YARD leaves on snow - chips where wood
  // was split, ash tipped out of a stove, spilt straw, diesel and dropped-load
  // scars.  Round 2 measured the whole system at 734 triangles for the entire
  // village and the brief names ground marks as the specific mechanism by which
  // snow reads as depth, so this pass spends the raised budget where fog cannot
  // wash it out: the first fifteen metres of the published standpoints, and the
  // ground around the convoy where a stalled column has been worked on.
  //
  // It runs LAST of the dressing passes on purpose - marks never block a site,
  // so it can safely take whatever budget the earlier passes left.
  // ==========================================================================
  PropsSnowbound.prototype._dressNearMarks = function () {
    var L = this.L, R = this.rng, A = this.A, i, j;
    if (!L) return;
    var poses = L.cameraPoses || {};
    var keys = ['hero1', 'hero2', 'hero3', 'overview'];
    var w = this.windDir;

    for (i = 0; i < keys.length; i++) {
      var p = poses[keys[i]];
      if (!p || !p.position) continue;
      var refY = this._ground(p.position.x, p.position.z);
      var fx = -Math.sin(p.yaw || 0), fz = -Math.cos(p.yaw || 0);
      var rx = Math.cos(p.yaw || 0), rz = -Math.sin(p.yaw || 0);
      for (j = 0; j < 16; j++) {
        var d = R.range(3.5, 15.0);
        var lat = R.range(-11.0, 11.0);
        var mx = p.position.x + fx * d + rx * lat;
        var mz = p.position.z + fz * d + rz * lat;
        if (!this._inBounds(mx, mz, 1.0)) continue;
        if (this._onRoad(mx, mz)) continue;
        if (this._inChurch(mx, mz, 0)) continue;
        var my = this._ground(mx, mz);
        // never on a different shelf from the standpoint - on the ledge that
        // is the difference between a mark on the ground and a mark on a roof
        if (Math.abs(my - refY) > 2.2) continue;
        // chips and straw only. Ash and diesel are near black and near
        // circular, and on unbroken snow at 8 m they photograph as an oil slick
        // rather than as anything a village leaves - they stay at the convoy
        // and the chopping block, where there is a reason for them.
        var cell = R.next() < 0.62 ? CELL.chips : CELL.straw;
        this._mark(cell, mx, mz, R.range(0.7, 1.9), R.range(0.6, 1.7),
          R.range(0, M.TAU), my, null);
      }
    }

    // the convoy: dropped loads, spilt fuel and the scuff of boots working
    // round a stalled column
    if (A && A.convoy) {
      for (i = 0; i < A.convoy.length; i++) {
        var t = A.convoy[i];
        if (!t || !t.centre) continue;
        for (j = 0; j < 8; j++) {
          var a = R.range(0, M.TAU), rr = R.range(2.4, 6.5);
          var cx = t.centre.x + Math.sin(a) * rr;
          var cz = t.centre.z + Math.cos(a) * rr;
          if (!this._inBounds(cx, cz, 1.0)) continue;
          var cy = this._ground(cx, cz);
          this._mark(CELL.straw, cx, cz,
            R.range(0.9, 2.4), R.range(0.8, 2.0), R.range(0, M.TAU), cy, null);
        }
        // a dragged crate: a scar running downwind off the tailgate
        var tx = t.centre.x - Math.sin(t.yaw || 0) * 4.2;
        var tz = t.centre.z - Math.cos(t.yaw || 0) * 4.2;
        for (j = 0; j < 5; j++) {
          var dx2 = tx + w.x * j * 0.85, dz2 = tz + w.y * j * 0.85;
          if (!this._inBounds(dx2, dz2, 1.0)) continue;
          this._mark(CELL.straw, dx2, dz2, R.range(0.5, 0.9), 1.0,
            Math.atan2(w.x, w.y), this._ground(dx2, dz2), null);
        }
      }
    }
  };

  // ==========================================================================
  // COMMIT
  // ==========================================================================
  var STATIC_MATERIAL = {
    wood: 'wood', steel: 'steel', rust: 'rust', green: 'green', stone: 'stone',
    concrete: 'concrete', canvas: 'canvas', sack: 'sack', snow: 'snow', ice: 'ice',
    lit: 'lit', marks: 'marks', sign: 'sign', sign2: 'sign2'
  };
  var STATIC_UVNAME = {
    wood: 'wood_plank', steel: 'painted_metal', rust: 'rusted_metal',
    green: 'paint_green', stone: 'stone', concrete: 'concrete',
    canvas: 'canvas_awning', sack: 'sandbag'
  };
  // Keep the authored UV: these index an atlas or a single board face, and
  // re-projecting them would smear the sign across the plank.
  var STATIC_KEEPUV = { marks: 1, sign: 1, sign2: 1, lit: 1 };
  // The level's own densities, so a prop cap and the drift beside it carry the
  // same grain.  Taken from level_snowbound's SURF table, not guessed.
  var STATIC_FIXEDUV = { snow: 0.55, ice: 0.90 };

  // Geo.mergeAll keeps position/normal/uv and drops everything else, which is
  // fatal for anything carrying aFlex.  Cloth and smoke merge through here.
  function mergeFlex(parts) {
    var total = 0, i, e, g;
    for (i = 0; i < parts.length; i++) {
      g = parts[i].geo;
      if (!g || !g.attributes.position) continue;
      total += g.attributes.position.count;
    }
    if (!total) return null;
    var pos = new Float32Array(total * 3);
    var nrm = new Float32Array(total * 3);
    var uv = new Float32Array(total * 2);
    var flx = new Float32Array(total);
    var nm = new THREE.Matrix3();
    var off = 0;
    for (i = 0; i < parts.length; i++) {
      e = parts[i]; g = e.geo;
      if (!g || !g.attributes.position) continue;
      var p = g.attributes.position, n = g.attributes.normal;
      var t = g.attributes.uv, f = g.attributes.aFlex;
      nm.getNormalMatrix(e.m);
      for (var v = 0; v < p.count; v++) {
        _va.fromBufferAttribute(p, v).applyMatrix4(e.m);
        pos[(off + v) * 3] = _va.x; pos[(off + v) * 3 + 1] = _va.y; pos[(off + v) * 3 + 2] = _va.z;
        if (n) {
          _vc.fromBufferAttribute(n, v).applyMatrix3(nm).normalize();
          nrm[(off + v) * 3] = _vc.x; nrm[(off + v) * 3 + 1] = _vc.y; nrm[(off + v) * 3 + 2] = _vc.z;
        }
        if (t) { uv[(off + v) * 2] = t.getX(v); uv[(off + v) * 2 + 1] = t.getY(v); }
        if (f) flx[off + v] = f.getX(v);
      }
      off += p.count;
      if (g.dispose) g.dispose();
    }
    var out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    out.setAttribute('aFlex', new THREE.BufferAttribute(flx, 1));
    out.computeBoundingSphere();
    out.computeBoundingBox();
    return out;
  }

  function whiteColors(geo, v) {
    var p = geo.attributes.position;
    if (!p) return geo;
    var c = new Float32Array(p.count * 3);
    var k = v === undefined ? 1 : v;
    for (var i = 0; i < c.length; i++) c[i] = k;
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return geo;
  }

  PropsSnowbound.prototype._commit = function () {
    var key, i;

    // ---- contact rings in the ground mesh -----------------------------------
    // The third leg of the grounding fix, and the only one that cannot be done
    // from this module alone: the level rasterises a blue-driven sky-occlusion
    // ring into its own ground vertex colours for every prop we have placed.
    // GTAO is on and delivers about a 15% drop under a dacha eave, which is
    // nowhere near enough when ambient IS the lighting.
    try {
      if (this.L && typeof this.L.paintGroundContact === 'function' && this._contact.length) {
        this.stats.contact = this.L.paintGroundContact(this._contact);
      }
    } catch (eC) { GAME.logError('propsS.contact', eC); }

    // ---- rope, cable and washing line ---------------------------------------
    this._buildTubes();

    // ---- cloth ---------------------------------------------------------------
    var kinds = { canvas: [], light: [] };
    for (i = 0; i < this.clothParts.length; i++) {
      var cp = this.clothParts[i];
      (kinds[cp.kind] || kinds.canvas).push(cp);
    }
    for (key in kinds) {
      if (!kinds[key].length) continue;
      var cg = mergeFlex(kinds[key]);
      if (!cg) continue;
      Geo.copyUV1(cg);
      paintWear(cg, { noise: this.noise, grime: 0.44, edge: 0.24, hiY: 1.2 });
      var cm = key === 'light' ? this.mats.clothLight : this.mats.cloth;
      var cMesh = new THREE.Mesh(cg, cm);
      cMesh.name = 'snowbound_cloth_' + key;
      cMesh.castShadow = true;
      cMesh.receiveShadow = true;
      cMesh.frustumCulled = false;
      this.root.add(cMesh);
      this.windMeshes.push(cMesh);
    }

    // ---- chimney smoke -------------------------------------------------------
    if (this.smokeParts.length) {
      var sg = mergeFlex(this.smokeParts);
      if (sg) {
        var sMesh = new THREE.Mesh(sg, this.mats.smoke);
        sMesh.name = 'snowbound_smoke';
        sMesh.castShadow = false;
        sMesh.receiveShadow = false;
        sMesh.renderOrder = 4;
        sMesh.frustumCulled = false;
        this.root.add(sMesh);
        this.windMeshes.push(sMesh);
      }
    }

    // ---- the second sign face needs its own map ------------------------------
    if (this.S.sign2 && this.S.sign2.length && this.mats.sign) {
      var s2 = this.mats.sign.clone();
      s2.map = this.tex.sign2 || this.tex.sign;
      s2.name = 'sb_sign2';
      this.mats.sign2 = s2;
    }

    // ---- static merges --------------------------------------------------------
    for (key in this.S) {
      var parts = this.S[key];
      if (!parts || !parts.length) continue;
      var geo = mergeParts(parts, 0);
      disposeParts(parts);
      if (!geo) continue;
      if (!STATIC_KEEPUV[key]) {
        try {
          var sc = STATIC_FIXEDUV[key] !== undefined
            ? STATIC_FIXEDUV[key] : this._uvScale(STATIC_UVNAME[key] || 'wood_plank', 500);
          Geo.worldUV(geo, sc);
        } catch (e) { /* keep the builder uv */ }
      }
      Geo.copyUV1(geo);
      if (key === 'snow' || key === 'ice') paintSnow(geo, this.noise, 3.1);
      else if (STATIC_KEEPUV[key]) whiteColors(geo, 1);
      else paintWear(geo, { noise: this.noise, grime: 0.38, edge: 0.30, hiY: 1.8 });
      var mat = this.mats[STATIC_MATERIAL[key] || 'wood'] || this.mats.wood;
      var mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'snowbound_props_' + key;
      mesh.castShadow = !(key === 'marks' || key === 'lit' || key === 'ice');
      mesh.receiveShadow = !(key === 'lit');
      if (key === 'marks') mesh.renderOrder = 3;
      if (key === 'ice') mesh.renderOrder = 1;
      this.root.add(mesh);
    }

    // ---- instanced batches -----------------------------------------------------
    this.stats.batch = {};
    for (key in this.B) {
      var b = this.B[key];
      if (!b) continue;
      if (b.full) this.stats.full.push(key + ':' + b.max);
      this.stats.batch[key] = b.n;
      if (b.finish(this.root, 'snowbound_' + key)) this.stats.instances += b.n;
      else delete this.B[key];
    }
    this._ravenBatch = this.B.raven || null;

    // ---- book-keeping ----------------------------------------------------------
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
    this.stats.caps = this._capCount;
    this.stats.collars = this._collarCount || 0;
    this.stats.drifts = this._driftCount || 0;
    this.stats.icicles = this._icicleCount || 0;
    this.stats.marks = this._markCount || 0;

    this.root.userData.colliders = this.colliders;
    this.root.userData.stats = this.stats;
    this.root.updateMatrixWorld(true);

    // Opt-in build diagnostic (index.html?...&propsdbg=1).  Inert otherwise,
    // and it is the only way to see instance-budget overflow, which is
    // otherwise silent: Batch.add just returns false and the last pass built
    // gets nothing.  Written into the DOM as well as the console because
    // headless --dump-dom can read the DOM and cannot read the console.
    try {
      if (typeof location !== 'undefined' && /propsdbg=1/.test(location.search || '')) {
        var dbg = JSON.stringify({ st: this.stats, bounds: this.bounds,
          dachas: this.dachas.length, convoy: this.convoy.length });
        if (window.console && console.log) console.log('SNOWPROPS ' + dbg);
        if (typeof document !== 'undefined' && document.body) {
          var el = document.createElement('div');
          el.id = 'snowpropstat';
          el.style.display = 'none';
          el.textContent = dbg;
          document.body.appendChild(el);
        }
      }
    } catch (e2) { /* diagnostics never break a build */ }

    // Opt-in isolation (?propshide=billet,snow or =1 for all).  "Which module
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
    } catch (e3) { /* diagnostics never break a build */ }

    if (this.ctx && this.ctx.bus && this.ctx.bus.emit) {
      this.ctx.bus.emit('props:ready', this);
    }
  };

  PropsSnowbound.prototype._buildTubes = function () {
    var list = this.ropePaths;
    if (!list || !list.length || !this.mats.ropeWind) return;
    var tb = new TubeBuilder();
    for (var i = 0; i < list.length && i < 200; i++) {
      var p = list[i];
      var pts = sagPath(p.a, p.b, p.sag, p.seg || 9);
      /* jshint loopfunc:true */
      tb.addPath(pts, p.r, 5, (function (f) {
        // free in the middle of a span, pinned at both ends
        return function (t) { return Math.sin(t * Math.PI) * f; };
      })(p.flex || 0), Math.max(1, Math.round(p.a.distanceTo(p.b) * 1.6)));
    }
    if (!tb.count()) return;
    var g = tb.geometry(true);
    Geo.copyUV1(g);
    paintWear(g, { noise: this.noise, grime: 0.42, edge: 0.22, hiY: 2.4 });
    var mesh = new THREE.Mesh(g, this.mats.ropeWind);
    mesh.name = 'snowbound_ropes';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.root.add(mesh);
    this.windMeshes.push(mesh);
  };

  // --------------------------------------------------------------------------
  // Per-frame
  // --------------------------------------------------------------------------
  var _wdir = new THREE.Vector2();

  PropsSnowbound.prototype.update = function (dt, ctx) {
    if (!(dt > 0)) dt = 0;
    ctx = ctx || this.ctx;
    // Drive from ctx.time where the engine provides it so a deterministic
    // capture reproduces exactly; integrate dt otherwise.
    if (ctx && typeof ctx.time === 'number' && isFinite(ctx.time)) this.time = ctx.time;
    else this.time += dt;
    this.uTime.value = this.time;

    // ---- the weather contract, consumer side --------------------------------
    // weather.js owns all of this; we only read it, and only through a guard,
    // because props builds BEFORE weather in the boot order and the first
    // frames legitimately have no weather at all.
    var w = ctx && ctx.weather;
    if (w) {
      if (w.windDir && isFinite(w.windDir.x) && isFinite(w.windDir.y)) {
        _wdir.copy(w.windDir);
        if (_wdir.lengthSq() > 1e-6) {
          _wdir.normalize();
          this.uWindDir.value.copy(_wdir);
          this.windDir.copy(_wdir);
        }
      }
      if (typeof w.windSpeed === 'number' && isFinite(w.windSpeed)) this.windSpeed = w.windSpeed;
    }
    // Amplitude AND frequency both rise with wind speed - cloth in a gale moves
    // further and faster, and scaling only one of them reads as slow motion.
    var s = M.clamp(this.windSpeed / 13, 0.25, 2.4);
    var wv = this.uWind.value;
    wv.x = 0.035 + 0.075 * s;
    wv.y = 2.0 + 1.9 * s;
    wv.z = 0.32 + 0.30 * s;

    // Smoke thins in a gust: a plume that is unaffected by a 13 m/s wind is the
    // single most obvious way a chimney reads as a decal.
    if (this.mats.smoke) {
      var gust = 0.5 + 0.5 * Math.sin(this.time * 0.47) * Math.sin(this.time * 0.19 + 1.1);
      this.mats.smoke.opacity = M.clamp(0.70 - 0.20 * M.saturate((this.windSpeed - 8) / 10) -
        0.10 * gust, 0.18, 0.80);
    }

    // ---- the birds ------------------------------------------------------------
    // Hunched and mostly still.  What they do is shuffle and duck, and doing it
    // out of phase per bird is the whole trick - fourteen instances moving
    // together would read as one animation, not as fourteen animals.
    var b = this._ravenBatch;
    if (b && b.mesh && this.ravens.length) {
      var mesh = b.mesh;
      for (var i = 0; i < this.ravens.length && i < mesh.count; i++) {
        var r = this.ravens[i];
        var ph = this.time * 0.9 + r.phase;
        var duck = Math.max(0, Math.sin(ph * 0.7)) * 0.018;
        var shuffle = Math.sin(ph * 0.31) * 0.10;
        mesh.setMatrixAt(i, T(r.x, r.y - duck, r.z,
          0.05 + duck * 2.0, r.yaw + shuffle, 0, r.sc, r.sc, r.sc));
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  };

  PropsSnowbound.prototype.resize = function () { /* nothing viewport-dependent */ };

  PropsSnowbound.prototype.dispose = function () {
    var self = this;
    try {
      this.root.traverse(function (o) {
        if (o.geometry && o.geometry.dispose) o.geometry.dispose();
      });
      if (this.root.parent) this.root.parent.remove(this.root);
      for (var k in this.mats) {
        var m = this.mats[k];
        // the level owns snow / ice / lit - disposing them would take the
        // valley's own surfaces with them
        if (!m || m === self.mats.snow || m === self.mats.ice || m === self.mats.lit) continue;
        if (m.dispose) m.dispose();
      }
      for (var t in this.tex) { if (this.tex[t] && this.tex[t].dispose) this.tex[t].dispose(); }
    } catch (e) { GAME.logError('propsS.dispose', e); }
  };

  GAME.PropsSnowbound = PropsSnowbound;
})(window.GAME, window.THREE);
