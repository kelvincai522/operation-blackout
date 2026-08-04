// ============================================================================
// OPERATION BLACKOUT - LEVEL 8 "MEKONG DELTA" - set dressing
// Module owner: props_jungle.  Exports GAME.PropsJungle.
//
// level_jungle.js builds the PLACE: the river, the track, the canopy, the
// firebase, the bunker, the tower, the wreck, the bridge, the sluice and the
// shrine.  This file builds the EVIDENCE THAT THIS PLACE WAS USED - the crates
// that came off a resupply that never got sorted, the drums somebody rolled to
// the edge of the pad and left, the sampan pulled up the mud below the broken
// bridge, the fish traps stacked where the creek meets the river, the bracket
// fungus eating the fallen trunks, the bicycle that carried rice up this track
// until it hit the log across it.
//
// SEVEN RULES SHAPED EVERY PLACEMENT DECISION IN THIS FILE:
//
//  1. NOTHING IS SCATTERED.  Every prop belongs to a SITE with a reason - a
//     resupply drop, a water point, a burn pit, a boat landing, a shrine, a
//     trap.  The only pass that runs over open ground is the forest litter,
//     and even that is deposition-driven: deadfall collects in the concave
//     hollows and on the UPHILL side of anything that stops it rolling, which
//     is measured (`_concavity`, `_uphill`), not guessed.
//
//  2. EVERYTHING SETTLES.  This level is nothing but slopes: the bank runs at
//     20-35 degrees, the knoll at 12, the track is a 25 cm cut with a spoil
//     berm either side.  `_settle` measures the ground gradient ACROSS THE
//     PROP'S OWN FOOTPRINT and returns a pitch and roll in the prop's frame,
//     and the height comes mostly from the LOWEST sample under that footprint.
//     A crate dropped level on the bank floats its downhill edge by 25 cm, and
//     in a frame with this much visual noise that reads as a bug, not a prop.
//
//  3. THE FOLIAGE IS THE LEVEL'S, NOT MINE.  level.foliage publishes the two
//     materials, the atlas cell table and the six plant generators that grew
//     every leaf out there.  Anything green in this file is grown from those,
//     so a fern sprouting out of the wreck's engine deck is literally the same
//     plant, the same shader and the same sway as the one at its skid.  Two
//     greens in one level is the same defect as two grades in one level.
//
//  4. WET IS THE DEFAULT.  weather.js's `drizzle` preset carries wetness 0.58,
//     so paintWear's `wet` defaults to 0.55 here (the harbor's is 1.0, the
//     snowbound's 0.10) and it is weighted onto up-faces, because an underside
//     in a rain forest is the only dry surface there is.  Grime is heaviest at
//     the base where the mud is, biological growth rides the same ramp, and
//     the whole thing is modulated per instance so no two read the same.
//
//  5. METAL IS NOT SEALED HERE, BUT IT IS DEAD.  The sky is `overcast`, so the
//     probe is real and metalness is safe - but nothing in a delta firebase is
//     polished.  Every metal in this file is capped at 0.55 and roughened, and
//     the aluminium of the wreck comes from the level so the panels lying in
//     the mud are the same alloy as the airframe they came off.
//
//  6. THE CAPS ARE DECLARED AND COUNTED.  Every InstancedMesh reports `full`
//     into this.stats, and `?propsdbg=1` prints the whole census into the DOM.
//     An overflowing batch drops everything past the cap silently, and the only
//     defence is to count.
//
//  7. NOTHING IS PLACED AGAINST A CAMERA POSE.  Sites resolve through
//     level.anchors and through the objects the level publishes after its own
//     build (level.builtHeli, .builtBunker, ...), both guarded.  The one thing
//     that reads the camera at all is the standpoint clearance list the LEVEL
//     itself published (plan.camMarks) - and it is used only to keep props OUT
//     of a place, never to put one in.
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  if (!GAME || !THREE) return;

  var M = GAME.Math;
  var Geo = GAME.Geo;

  // --------------------------------------------------------------------- --
  // Scratch.  A few thousand placements happen at build time and a Matrix4 per
  // placement is a measurable slice of the boot budget.
  // --------------------------------------------------------------------- --
  var _m4 = new THREE.Matrix4();
  var _m4b = new THREE.Matrix4();
  var _qt = new THREE.Quaternion();
  var _qs = new THREE.Quaternion();
  var _eu = new THREE.Euler();
  var _vp = new THREE.Vector3();
  var _vsc = new THREE.Vector3();
  var _va = new THREE.Vector3();
  var _vb = new THREE.Vector3();
  var _vd = new THREE.Vector3();
  var _bmin = new THREE.Vector3();
  var _bmax = new THREE.Vector3();
  var _col = new THREE.Color();
  var _rayO = new THREE.Vector3();
  var _rayD = new THREE.Vector3(0, -1, 0);

  var UP = new THREE.Vector3(0, 1, 0);
  var SIDE_X = new THREE.Vector3(1, 0, 0);
  var WHITE = new THREE.Color(1, 1, 1);

  // weather.js's drizzle blows toward (0.70, 0.71) at 1.6 m/s.  Under a closed
  // canopy that is nearly still air, so it decides only which flank of a post
  // carries the wet streak, which way a hung poncho hangs off true, and which
  // side of an obstacle the leaf drift banks against.  Taken from the level,
  // which took it from weather.js, rather than guessed.
  var WIND_X = 0.70, WIND_Z = 0.71;

  // ------------------------------------------------------------ transforms --
  function T(px, py, pz, rx, ry, rz, sx, sy, sz) {
    _eu.set(rx || 0, ry || 0, rz || 0, 'YXZ');
    _qt.setFromEuler(_eu);
    _vp.set(px || 0, py || 0, pz || 0);
    _vsc.set(sx === undefined ? 1 : sx, sy === undefined ? 1 : sy,
      sz === undefined ? 1 : sz);
    return _m4.compose(_vp, _qt, _vsc);
  }
  function Tn(px, py, pz, rx, ry, rz, sx, sy, sz) {
    return T(px, py, pz, rx, ry, rz, sx, sy, sz).clone();
  }

  // Unit-height +Y primitive mapped onto the segment a->b.  "From here to
  // there" is how a brace, a lashing, a skid rail or a bent rod is described.
  function strut(ax, ay, az, bx, by, bz) {
    _vb.set(bx - ax, by - ay, bz - az);
    var len = _vb.length();
    if (!(len > 1e-6)) len = 1e-6;
    _vd.copy(_vb).multiplyScalar(1 / len);
    _qs.setFromUnitVectors(UP, _vd);
    _vp.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
    _vsc.set(1, len, 1);
    return _m4b.compose(_vp, _qs, _vsc);
  }

  function part(geometry, matrix) {
    return { geometry: geometry, matrix: matrix ? matrix.clone() : null };
  }

  function mergeParts(parts, uvScale) {
    if (!parts || !parts.length) return null;
    var g = null;
    try { g = Geo.mergeAll(parts); }
    catch (e) { GAME.logError('propsJ.merge', e); return null; }
    if (!g) return null;
    if (uvScale) {
      try { Geo.worldUV(g, uvScale); }
      catch (e2) { GAME.logError('propsJ.worldUV', e2); }
    }
    Geo.copyUV1(g);
    return g;
  }

  // Geo.mergeAll drops every attribute that is not position/normal/uv, so no
  // per-vertex wind-flex ramp can survive a merge.  That is why the cloth here
  // sways on materials.js's own `wind` option (object-space, driven by the
  // library's clock) rather than on a hand-written flex attribute: the sway
  // has to survive the merge that keeps this whole module inside 80 draws.
  function disposeParts(parts) {
    var seen = new Set();
    for (var i = 0; i < parts.length; i++) {
      var g = parts[i].geometry;
      if (g && !seen.has(g)) { seen.add(g); if (g.dispose) g.dispose(); }
    }
    parts.length = 0;
  }

  // ------------------------------------------------------------ primitives --
  function box(w, h, d, bevel) {
    return Geo.bevelBox(Math.max(w, 0.002), Math.max(h, 0.002), Math.max(d, 0.002),
      bevel === undefined ? Math.min(0.012, Math.min(w, Math.min(h, d)) * 0.22) : bevel);
  }
  function cyl(rt, rb, h, seg, open) {
    return new THREE.CylinderGeometry(Math.max(rt, 0.0005), Math.max(rb, 0.0005),
      Math.max(h, 0.002), seg || 8, 1, !!open);
  }
  function sph(r, wseg, hseg) {
    return new THREE.SphereGeometry(Math.max(r, 0.002), wseg || 8, hseg || 6);
  }
  function torus(r, tube, rseg, tseg) {
    return new THREE.TorusGeometry(r, tube, tseg || 5, rseg || 12);
  }
  function lathe(pts, seg) {
    return new THREE.LatheGeometry(pts, seg || 12);
  }
  function V2(x, y) { return new THREE.Vector2(Math.max(x, 0.0008), y); }

  // A quad standing on its base edge (cards, boards, cloth panels).
  function cardGeo(w, h, u0, v0, u1, v1) {
    var hw = w * 0.5;
    if (u0 === undefined) { u0 = 0; v0 = 0; u1 = 1; v1 = 1; }
    var pos = new Float32Array([
      -hw, 0, 0, hw, 0, 0, hw, h, 0,
      -hw, 0, 0, hw, h, 0, -hw, h, 0]);
    var nor = new Float32Array(18);
    for (var i = 0; i < 6; i++) nor[i * 3 + 2] = 1;
    var uv = new Float32Array([u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1]);
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return g;
  }

  // A quad lying flat, +Y up, for the ground-mark atlas.
  function flatGeo(w, d, u0, v0, u1, v1) {
    var hw = w * 0.5, hd = d * 0.5;
    var pos = new Float32Array([
      -hw, 0, -hd, hw, 0, -hd, hw, 0, hd,
      -hw, 0, -hd, hw, 0, hd, -hw, 0, hd]);
    var nor = new Float32Array(18);
    for (var i = 0; i < 6; i++) nor[i * 3 + 1] = 1;
    var uv = new Float32Array([u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1]);
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return g;
  }

  // A closed 2D profile extruded along Z with fan caps.  Jerrycan flanks, a
  // sampan's midship section, a cart wheel's felloe - anything with a
  // recognisable silhouette section.
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

  // A bent tube through [x,y,z,r] stations.  Every vine, hose, lashing, wire
  // coil and dead branch in the file is one of these: a straight cylinder in a
  // forest reads as pipework and pipework is the loudest possible tell.
  function tubePath(stations, seg, capEnds) {
    seg = seg || 6;
    var n = stations.length;
    if (n < 2) return new THREE.BufferGeometry();
    var pos = [], nor = [], uv = [];
    var frames = [], i, j;
    for (i = 0; i < n; i++) {
      var a = stations[Math.max(0, i - 1)], b = stations[Math.min(n - 1, i + 1)];
      var tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
      var tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      var ux = 0, uy = 1, uz = 0;
      if (Math.abs(ty) > 0.94) { ux = 1; uy = 0; uz = 0; }
      var nx = uy * tz - uz * ty, ny = uz * tx - ux * tz, nz = ux * ty - uy * tx;
      var nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      frames.push([nx, ny, nz, ty * nz - tz * ny, tz * nx - tx * nz, tx * ny - ty * nx]);
    }
    var vlen = 0, vs = [0];
    for (i = 1; i < n; i++) {
      var dx = stations[i][0] - stations[i - 1][0];
      var dy = stations[i][1] - stations[i - 1][1];
      var dz = stations[i][2] - stations[i - 1][2];
      vlen += Math.sqrt(dx * dx + dy * dy + dz * dz);
      vs.push(vlen);
    }
    function ring(k, j2) {
      var s = stations[k], f = frames[k];
      var th = j2 / seg * Math.PI * 2;
      var c = Math.cos(th), sn = Math.sin(th);
      var dx2 = f[0] * c + f[3] * sn, dy2 = f[1] * c + f[4] * sn, dz2 = f[2] * c + f[5] * sn;
      return [s[0] + dx2 * s[3], s[1] + dy2 * s[3], s[2] + dz2 * s[3], dx2, dy2, dz2];
    }
    for (i = 0; i + 1 < n; i++) {
      for (j = 0; j < seg; j++) {
        var A = ring(i, j), B2 = ring(i, j + 1), C = ring(i + 1, j + 1), D = ring(i + 1, j);
        var u0 = j / seg, u1 = (j + 1) / seg, v0 = vs[i], v1 = vs[i + 1];
        pos.push(A[0], A[1], A[2], B2[0], B2[1], B2[2], C[0], C[1], C[2]);
        nor.push(A[3], A[4], A[5], B2[3], B2[4], B2[5], C[3], C[4], C[5]);
        uv.push(u0, v0, u1, v0, u1, v1);
        pos.push(A[0], A[1], A[2], C[0], C[1], C[2], D[0], D[1], D[2]);
        nor.push(A[3], A[4], A[5], C[3], C[4], C[5], D[3], D[4], D[5]);
        uv.push(u0, v0, u1, v1, u0, v1);
      }
    }
    if (capEnds) {
      for (var e = 0; e < 2; e++) {
        var k2 = e ? n - 1 : 0;
        var t = stations[k2];
        var sgn = e ? 1 : -1;
        for (j = 0; j < seg; j++) {
          var P = ring(k2, e ? j : j + 1), Q = ring(k2, e ? j + 1 : j);
          pos.push(t[0], t[1], t[2], P[0], P[1], P[2], Q[0], Q[1], Q[2]);
          nor.push(0, sgn, 0, 0, sgn, 0, 0, sgn, 0);
          uv.push(0.5, vs[k2], 0, vs[k2], 1, vs[k2]);
        }
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    g.computeBoundingSphere();
    return g;
  }

  // A parabolic sag between two points - indistinguishable from a catenary at
  // the sags a lashing, a clothesline or a hanging vine actually has.
  function sagStations(ax, ay, az, bx, by, bz, sag, r, segs) {
    var out = [];
    segs = segs || 7;
    for (var i = 0; i <= segs; i++) {
      var t = i / segs;
      out.push([ax + (bx - ax) * t,
        ay + (by - ay) * t - sag * 4 * t * (1 - t),
        az + (bz - az) * t,
        typeof r === 'function' ? r(t) : r]);
    }
    return out;
  }

  // Displace every vertex by fbm.  The cheapest way to stop a primitive reading
  // as a primitive: a drum that has stood ten monsoons in a firebase has no
  // circular section left anywhere, and a rock is never a box.
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
          p.setXYZ(i, x * (1 + n1 * amount), y + n1 * amount * 0.22, z * (1 + n1 * amount));
        }
      } else if (mode === 'dome') {
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

  // ==========================================================================
  // THE WEAR CONTRACT
  //
  // materials.js get(name, {vertexColors:true}) reads the geometry `color`
  // attribute as a WEAR MASK - white is pristine and each channel darkens
  // toward a different kind of damage:
  //
  //     R -> grime / mud     G -> WETNESS      B -> edge wear / bare substrate
  //
  // G is written as 1 - wet, and `wet` defaults to 0.55 because weather.js's
  // drizzle preset publishes wetness 0.58.  A bone-dry crate in a rain forest
  // is exactly as wrong as a soaking one in a whiteout, and putting the
  // arithmetic in one named function is what stops it silently inverting.
  //
  // The two jungle-specific terms are BIOGROWTH and SPLASH.  Growth is a
  // function of how near the ground a surface is and how much it faces up (it
  // needs standing water and it needs light), and it is written into R because
  // in the wear shader R is what darkens and desaturates.  Splash is the mud
  // thrown up the first 30 cm of anything standing in a churned track.
  // ==========================================================================
  function paintWear(geo, o) {
    var p = geo.attributes.position, n = geo.attributes.normal;
    if (!p || !n) return geo;
    o = o || {};
    var wet = o.wet === undefined ? 0.55 : o.wet;
    var grime = o.grime === undefined ? 0.30 : o.grime;
    var edge = o.edge === undefined ? 0.20 : o.edge;
    var growth = o.growth === undefined ? 0.26 : o.growth;
    var splash = o.splash === undefined ? 0.34 : o.splash;
    var noise = o.noise || null;
    var ph = o.seed || 0;
    var loY = o.loY === undefined ? 0 : o.loY;
    var hiY = o.hiY === undefined ? 1.2 : o.hiY;
    var c = new Float32Array(p.count * 3);
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      var ny = n.getY(i);
      var up = ny * 0.5 + 0.5;
      // An up-face is rained on all day; an underside is the only dry surface
      // in the level and it is also where the wood stays pale.
      var w = M.saturate(wet * (0.30 + 0.70 * up * up));
      var lowness = 1 - M.saturate((y - loY) / Math.max(0.2, hiY - loY));
      var gr = grime * (0.34 + 0.92 * lowness * lowness);
      gr += splash * Math.pow(M.saturate(1 - (y - loY) / 0.34), 2.2);
      // biological growth: it needs water lying on the surface and it starts at
      // the bottom, which is the difference between "dirty" and "in a jungle"
      gr += growth * M.saturate(up * up * 1.15) * (0.20 + 0.90 * lowness);
      var reach = M.saturate((Math.sqrt(x * x + z * z) - 0.06) * 1.8);
      var ed = edge * (0.20 + 0.90 * reach) * (0.28 + 0.82 * M.saturate(ny));
      if (noise) {
        var nv = noise.fbm3(x * 2.6 + ph, y * 2.6, z * 2.6 - ph, 3, 2.1, 0.55);
        gr = gr * (1 + nv * 1.05);
        ed = ed * (1 + nv * 1.05);
        w = w * (1 + nv * 0.35);
      }
      c[i * 3] = M.saturate(1 - M.saturate(gr));
      c[i * 3 + 1] = M.saturate(1 - M.saturate(w));   // <- G is INVERTED wetness
      c[i * 3 + 2] = M.saturate(1 - M.saturate(ed));
    }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return geo;
  }

  // The materials BORROWED FROM THE LEVEL (mud, bark, blade, canopy, lit, alu)
  // are plain multiply-vertexColor materials, NOT the wear convention - the
  // level asks materials.js for wearMode 'multiply' on all of them.  Painting a
  // wear mask onto one of those would come out as a flat grey tint, so they get
  // their own paint: a value spread plus, on anything organic, the same
  // warm-low / cool-high ramp level_jungle uses on its own planting.
  function paintTint(geo, o) {
    var p = geo.attributes.position, n = geo.attributes.normal;
    if (!p) return geo;
    o = o || {};
    var noise = o.noise || null;
    var base = o.base || [1, 1, 1];
    var spread = o.spread === undefined ? 0.16 : o.spread;
    var lift = o.lift === undefined ? 0 : o.lift;      // up-faces catch the sky
    var ph = o.seed || 0;
    var c = new Float32Array(p.count * 3);
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      var v = noise ? noise.fbm3(x * 1.4 + ph, y * 1.4, z * 1.4 - ph, 3, 2.1, 0.55) : 0;
      var up = n ? (n.getY(i) * 0.5 + 0.5) : 0.5;
      var k = 1 + v * spread + lift * (up - 0.5);
      c[i * 3] = M.clamp(base[0] * k, 0.02, 2);
      c[i * 3 + 1] = M.clamp(base[1] * k, 0.02, 2);
      c[i * 3 + 2] = M.clamp(base[2] * k, 0.02, 2);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return geo;
  }

  // Per-instance modulation of the three wear channels.  It MULTIPLIES the
  // vertex mask, so 1.0 leaves a channel alone: this is jitter, not a coat.
  function wearTint(rng, out) {
    out = out || _col;
    out.setRGB(
      1 - rng.range(0, 0.30),      // grime / growth
      1 - rng.range(0, 0.16),      // wetness
      1 - rng.range(0, 0.22));     // edge wear
    return out;
  }

  // The same idea for the multiply-mode materials: a plain value/hue jitter.
  function hueTint(rng, r, g, b, out) {
    out = out || _col;
    var v = rng.range(0.82, 1.16);
    out.setRGB(r * v, g * v, b * v);
    return out;
  }

  // ==========================================================================
  // Batch - a thin wrapper over InstancedMesh that counts as you place and
  // REPORTS the overflow.  A full batch silently drops every instance past its
  // cap and there is no way to see that in a frame; `full` is the only defence.
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
  Batch.prototype.finish = function (root, name) {
    if (!this.n) {
      if (this.mesh.geometry && this.mesh.geometry.dispose) this.mesh.geometry.dispose();
      return false;
    }
    this.mesh.count = this.n;
    this.mesh.name = name;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.frustumCulled = true;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    root.add(this.mesh);
    return true;
  };

  // ==========================================================================
  // PROCEDURAL TEXTURES
  //
  // Two sheets, both small, both drawn once.  Everything else in the file uses
  // materials.js or the level's own surfaces - authoring a third bark or a
  // second mud here would guarantee a seam.
  // ==========================================================================
  function canvasOf(w, h) {
    var doc = (typeof document !== 'undefined') ? document : null;
    if (!doc) return null;
    var c = doc.createElement('canvas');
    c.width = w; c.height = h === undefined ? w : h;
    return c;
  }

  function texOf(canvas, srgb, aniso, clamp) {
    if (!canvas) return null;
    var t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    if (aniso) t.anisotropy = aniso;
    t.needsUpdate = true;
    return t;
  }

  // 2 x 2 ground-mark atlas at 512.  CANVAS Y RUNS DOWN AND TEXTURE V RUNS UP,
  // and CanvasTexture leaves flipY true - so the row index has to be inverted
  // or every cell samples the one below it.  level_jungle lost its entire
  // canopy to exactly that bug; it is not going to happen twice in one level.
  var MK_N = 2, MK_PX = 512, MK_CELL = MK_PX / MK_N;
  var MARK = { oil: 0, trample: 1, ash: 2, rust: 3 };

  function markUV(cell) {
    var s = 1 / MK_N;
    var cx = (cell % MK_N) * s;
    var cy = (MK_N - 1 - Math.floor(cell / MK_N)) * s;
    var pad = 0.008 * s;
    return [cx + pad, cy + pad, cx + s - pad, cy + s - pad];
  }

  function buildMarkAtlas(rng) {
    var c = canvasOf(MK_PX);
    if (!c) return null;
    var g = c.getContext('2d');
    if (!g) return null;
    g.clearRect(0, 0, MK_PX, MK_PX);
    var S = MK_CELL, i, j;
    function origin(n) { return [(n % MK_N) * S, Math.floor(n / MK_N) * S]; }
    function blob(cx, cy, r, wob, fill) {
      g.beginPath();
      for (var k = 0; k <= 22; k++) {
        var a = k / 22 * Math.PI * 2;
        var rr = r * (1 + Math.sin(a * 3.1 + wob) * 0.20 + Math.sin(a * 5.7 - wob) * 0.13);
        var px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr * 0.82;
        if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath();
      g.fillStyle = fill;
      g.fill();
    }

    // ---- 0 : a fuel/oil stain under a drum stand --------------------------
    var o = origin(MARK.oil);
    g.save(); g.translate(o[0], o[1]);
    blob(S * 0.5, S * 0.5, S * 0.34, 0.7, 'rgba(18,17,13,0.62)');
    blob(S * 0.46, S * 0.53, S * 0.24, 2.3, 'rgba(9,9,7,0.80)');
    // the iridescent rim a fuel spill has where the film goes thin
    for (i = 0; i < 3; i++) {
      g.globalCompositeOperation = 'lighter';
      blob(S * 0.5, S * 0.5, S * (0.30 - i * 0.045), 1.1 + i,
        i === 0 ? 'rgba(38,26,52,0.20)' : (i === 1 ? 'rgba(20,44,34,0.16)' : 'rgba(52,34,12,0.14)'));
      g.globalCompositeOperation = 'source-over';
    }
    for (i = 0; i < 90; i++) {
      g.fillStyle = 'rgba(10,10,8,' + rng.range(0.10, 0.45).toFixed(2) + ')';
      var sa = rng.range(0, 6.28), sr = Math.pow(rng.next(), 0.6) * S * 0.44;
      g.fillRect(S * 0.5 + Math.cos(sa) * sr, S * 0.5 + Math.sin(sa) * sr * 0.8,
        rng.range(1, 5), rng.range(1, 4));
    }
    g.restore();

    // ---- 1 : a trampled patch - where boots have killed the cover ----------
    o = origin(MARK.trample);
    g.save(); g.translate(o[0], o[1]);
    blob(S * 0.5, S * 0.5, S * 0.42, 1.7, 'rgba(46,40,24,0.50)');
    blob(S * 0.52, S * 0.47, S * 0.30, 3.1, 'rgba(30,27,17,0.46)');
    // heel scuffs and the standing water they hold
    for (i = 0; i < 26; i++) {
      var bx = S * rng.range(0.18, 0.82), by = S * rng.range(0.18, 0.82);
      var ba = rng.range(0, 6.28);
      g.save(); g.translate(bx, by); g.rotate(ba);
      g.fillStyle = 'rgba(16,16,11,' + rng.range(0.20, 0.52).toFixed(2) + ')';
      g.fillRect(-S * 0.035, -S * 0.055, S * 0.07, S * 0.11);
      g.fillStyle = 'rgba(140,152,132,' + rng.range(0.05, 0.16).toFixed(2) + ')';
      g.fillRect(-S * 0.028, -S * 0.045, S * 0.056, S * 0.05);
      g.restore();
    }
    for (i = 0; i < 200; i++) {
      g.fillStyle = 'rgba(96,104,60,' + rng.range(0.06, 0.22).toFixed(2) + ')';
      g.fillRect(S * rng.range(0, 1), S * rng.range(0, 1), rng.range(1, 4), rng.range(1, 3));
    }
    g.restore();

    // ---- 2 : the burn pit - charcoal, white ash, burnt tin ----------------
    o = origin(MARK.ash);
    g.save(); g.translate(o[0], o[1]);
    blob(S * 0.5, S * 0.5, S * 0.40, 0.4, 'rgba(22,20,18,0.72)');
    blob(S * 0.5, S * 0.5, S * 0.26, 2.8, 'rgba(150,146,138,0.42)');
    for (i = 0; i < 120; i++) {
      var aa = rng.range(0, 6.28), ar = Math.pow(rng.next(), 0.7) * S * 0.40;
      var cxx = S * 0.5 + Math.cos(aa) * ar, cyy = S * 0.5 + Math.sin(aa) * ar * 0.88;
      var lv = rng.next();
      g.fillStyle = lv > 0.72
        ? 'rgba(206,202,192,' + rng.range(0.25, 0.55).toFixed(2) + ')'
        : 'rgba(14,13,12,' + rng.range(0.35, 0.80).toFixed(2) + ')';
      g.save(); g.translate(cxx, cyy); g.rotate(rng.range(0, 6.28));
      g.fillRect(0, 0, rng.range(2, 11), rng.range(2, 6));
      g.restore();
    }
    // a couple of burnt-through ration tins
    for (i = 0; i < 4; i++) {
      g.strokeStyle = 'rgba(84,54,32,0.55)';
      g.lineWidth = 3;
      g.beginPath();
      g.ellipse(S * rng.range(0.28, 0.72), S * rng.range(0.28, 0.72),
        S * 0.035, S * 0.022, rng.range(0, 3.14), 0, 6.283);
      g.stroke();
    }
    g.restore();

    // ---- 3 : rust runoff, for the VERTICAL face under a drum or a bracket --
    o = origin(MARK.rust);
    g.save(); g.translate(o[0], o[1]);
    for (i = 0; i < 34; i++) {
      var rx = S * rng.range(0.05, 0.95);
      var w = rng.range(2, 13);
      var h = S * rng.range(0.35, 0.98);
      var gr = g.createLinearGradient(0, 0, 0, h);
      var rr2 = Math.round(rng.range(96, 148)), gg = Math.round(rng.range(52, 84));
      gr.addColorStop(0, 'rgba(' + rr2 + ',' + gg + ',26,' + rng.range(0.30, 0.62).toFixed(2) + ')');
      gr.addColorStop(0.65, 'rgba(' + Math.round(rr2 * 0.7) + ',' + Math.round(gg * 0.7) + ',18,0.24)');
      gr.addColorStop(1, 'rgba(60,34,14,0.0)');
      g.fillStyle = gr;
      g.save(); g.translate(rx, 0);
      g.fillRect(0, 0, w, h);
      g.restore();
    }
    for (j = 0; j < 60; j++) {
      g.fillStyle = 'rgba(120,64,28,' + rng.range(0.10, 0.34).toFixed(2) + ')';
      g.fillRect(S * rng.range(0, 1), S * rng.range(0, 0.6), rng.range(1, 5), rng.range(3, 16));
    }
    g.restore();

    return c;
  }

  // A 2 x 1 board sheet: a hand-painted hazard board and a stencilled steel
  // plate.  No invented script - the marks are painted STROKES, which is what
  // a unit sign in a firebase actually is and which cannot accidentally read as
  // a language this level has no business having.
  var BD_N = 2, BD_W = 512, BD_H = 256;
  var BOARD = { hazard: 0, plate: 1 };
  function boardUV(cell) {
    var s = 1 / BD_N;
    var cx = cell * s;
    return [cx + 0.004, 0.02, cx + s - 0.004, 0.98];
  }
  function buildBoardTex(rng) {
    var c = canvasOf(BD_W, BD_H);
    if (!c) return null;
    var g = c.getContext('2d');
    if (!g) return null;
    var CW = BD_W / BD_N, i;
    // ---- 0: painted plank board, red/white chevrons, weathered ------------
    g.fillStyle = '#6d6247';
    g.fillRect(0, 0, CW, BD_H);
    for (i = 0; i < 5; i++) {
      g.fillStyle = 'rgba(0,0,0,' + rng.range(0.05, 0.12).toFixed(2) + ')';
      g.fillRect(0, i * BD_H / 5, CW, 3);
    }
    g.save();
    g.beginPath(); g.rect(0, 0, CW, BD_H); g.clip();
    for (i = -2; i < 10; i++) {
      g.fillStyle = (i & 1) ? '#b8442c' : '#cfc7b4';
      g.save();
      g.translate(i * 62, 0); g.rotate(0.42);
      g.fillRect(0, -40, 34, BD_H + 90);
      g.restore();
    }
    // hand-painted strokes over the top
    g.strokeStyle = 'rgba(24,26,20,0.82)';
    g.lineWidth = 11;
    g.lineCap = 'round';
    var strokes = [[40, 70, 96, 70], [68, 62, 68, 132], [120, 132, 120, 66],
      [120, 66, 164, 66], [164, 66, 164, 132], [196, 66, 196, 132],
      [196, 100, 236, 100], [236, 66, 236, 132]];
    for (i = 0; i < strokes.length; i++) {
      var s = strokes[i];
      g.beginPath();
      g.moveTo(s[0] + rng.range(-3, 3), s[1] + rng.range(-3, 3));
      g.lineTo(s[2] + rng.range(-3, 3), s[3] + rng.range(-3, 3));
      g.stroke();
    }
    // and the weather that has been eating it since
    for (i = 0; i < 900; i++) {
      g.fillStyle = 'rgba(' + Math.round(rng.range(40, 92)) + ',' +
        Math.round(rng.range(46, 88)) + ',' + Math.round(rng.range(24, 50)) + ',' +
        rng.range(0.05, 0.30).toFixed(2) + ')';
      g.fillRect(rng.range(0, CW), rng.range(0, BD_H), rng.range(1, 7), rng.range(1, 5));
    }
    g.restore();

    // ---- 1: a stencilled steel plate --------------------------------------
    g.save();
    g.translate(CW, 0);
    g.fillStyle = '#4a4a3e';
    g.fillRect(0, 0, CW, BD_H);
    for (i = 0; i < 700; i++) {
      g.fillStyle = 'rgba(' + Math.round(rng.range(90, 150)) + ',' +
        Math.round(rng.range(50, 84)) + ',26,' + rng.range(0.06, 0.34).toFixed(2) + ')';
      g.fillRect(rng.range(0, CW), rng.range(0, BD_H), rng.range(2, 16), rng.range(2, 10));
    }
    g.fillStyle = 'rgba(212,206,186,0.72)';
    for (i = 0; i < 5; i++) {
      g.fillRect(36 + i * 40, 88, 9, 62);
      if (i & 1) g.fillRect(36 + i * 40, 88, 30, 9);
      else g.fillRect(36 + i * 40, 140, 30, 9);
    }
    g.strokeStyle = 'rgba(206,200,180,0.55)';
    g.lineWidth = 6;
    g.strokeRect(14, 14, CW - 28, BD_H - 28);
    g.restore();
    return c;
  }

  // ==========================================================================
  // THE KIT
  //
  // Every generator returns geometry in LOCAL space with its origin at the
  // point that touches the ground and +Z forward, so the settle transform and
  // the collider half-extents mean the same thing everywhere.
  //
  // Nothing here is a box standing in for an object.  The test each one has to
  // pass is the silhouette test: switch the albedo off and the shape still has
  // to read as what it is - a crate has proud cleats and a lid lip, a drum has
  // rolling hoops, a jerrycan has its three handles, a fish trap is a cage you
  // can see through.
  // ==========================================================================
  var K = {};

  // A wooden supply crate.  Cleats proud of the boards, a lid lip, rope beckets
  // at both ends, and (optionally) a board sprung off one corner.
  K.crate = function (rng, noise, broken) {
    var P = [];
    var w = 0.86, h = 0.36, d = 0.46;
    var i;
    P.push(part(box(w, h, d, 0.012), Tn(0, h * 0.5, 0)));
    for (i = 0; i < 2; i++) {
      P.push(part(box(w * 0.995, 0.012, d * 1.006, 0.003), Tn(0, h * (0.34 + i * 0.36), 0)));
    }
    for (var sx = -1; sx <= 1; sx += 2) {
      for (var sz = -1; sz <= 1; sz += 2) {
        P.push(part(box(0.055, h * 0.98, 0.055, 0.006),
          Tn(sx * (w * 0.5 - 0.02), h * 0.5, sz * (d * 0.5 - 0.02))));
      }
    }
    P.push(part(box(w + 0.03, 0.042, d + 0.03, 0.008), Tn(0, h + 0.02, 0)));
    P.push(part(box(w * 0.62, 0.022, d * 0.30, 0.005), Tn(0, h + 0.052, 0)));
    for (i = -1; i <= 1; i += 2) {
      P.push(part(tubePath(sagStations(i * (w * 0.5 + 0.005), h * 0.72, -d * 0.22,
        i * (w * 0.5 + 0.005), h * 0.72, d * 0.22, 0.055, 0.011, 5), 4), null));
    }
    if (broken) {
      P.push(part(box(w * 0.52, 0.028, 0.06, 0.004),
        Tn(w * 0.16, h * 0.30, d * 0.5 + 0.03, 0, 0, 0.16)));
      P.push(part(box(0.30, 0.026, 0.05, 0.004),
        Tn(-w * 0.22, h * 0.86, d * 0.5 + 0.05, 0.28, 0.12, 0)));
    }
    var out = mergeParts(P, 2.2);
    disposeParts(P);
    if (out && noise) roughen(out, noise, 0.004, 6, 'jitter');
    void rng;
    return out;
  };

  // An open crate, lid off and leaning, half emptied - the difference between
  // a stack of crates and a stack somebody was working through.
  K.crateOpen = function (rng) {
    var P = [];
    var w = 0.86, h = 0.36, d = 0.46, t = 0.026, i;
    P.push(part(box(w, t, d, 0.004), Tn(0, t * 0.5, 0)));
    for (var s = -1; s <= 1; s += 2) {
      P.push(part(box(w, h, t, 0.004), Tn(0, h * 0.5, s * (d * 0.5 - t * 0.5))));
      P.push(part(box(t, h, d - t * 2, 0.004), Tn(s * (w * 0.5 - t * 0.5), h * 0.5, 0)));
      P.push(part(box(0.05, h, 0.05, 0.006), Tn(s * (w * 0.5 - 0.02), h * 0.5, d * 0.5 - 0.02)));
      P.push(part(box(0.05, h, 0.05, 0.006), Tn(s * (w * 0.5 - 0.02), h * 0.5, -d * 0.5 + 0.02)));
    }
    for (i = 0; i < 4; i++) {
      P.push(part(cyl(0.055, 0.055, 0.40, 8),
        Tn(-w * 0.28 + i * 0.13, 0.075, rng.range(-0.06, 0.06), 0, 0, Math.PI * 0.5)));
    }
    P.push(part(box(0.26, 0.06, 0.20, 0.01), Tn(w * 0.24, 0.06, 0.06, 0, 0.4, 0.03)));
    P.push(part(box(w + 0.03, 0.042, d + 0.03, 0.008),
      Tn(w * 0.5 + 0.30, h * 0.46, 0.02, 0, 0.10, -1.16)));
    var out = mergeParts(P, 2.2);
    disposeParts(P);
    return out;
  };

  // A steel ammunition can: rounded body, a proud lid, hinge lugs at the back,
  // the cam latch at the front and a folding bail.
  K.ammoCan = function (rng, open) {
    var P = [];
    var w = 0.30, h = 0.185, d = 0.155;
    P.push(part(box(w, h, d, 0.018), Tn(0, h * 0.5, 0)));
    P.push(part(box(w * 0.99, 0.016, d * 0.99, 0.005), Tn(0, h * 0.62, 0)));
    if (open) {
      P.push(part(box(w + 0.012, 0.030, d + 0.012, 0.008),
        Tn(0, h + 0.10, -d * 0.62, -1.05, 0, 0)));
    } else {
      P.push(part(box(w + 0.012, 0.030, d + 0.012, 0.008), Tn(0, h + 0.014, 0)));
      P.push(part(box(w * 0.80, 0.012, d * 0.70, 0.004), Tn(0, h + 0.034, 0)));
    }
    for (var s = -1; s <= 1; s += 2) {
      P.push(part(box(0.045, 0.030, 0.030, 0.005), Tn(s * w * 0.28, h + 0.006, -d * 0.52)));
    }
    P.push(part(box(0.09, 0.055, 0.026, 0.006), Tn(0, h - 0.005, d * 0.54)));
    P.push(part(box(0.055, 0.016, 0.055, 0.005), Tn(0, h + 0.03, d * 0.58, 0.5, 0, 0)));
    var lift = open ? 0.06 : 0.0;
    P.push(part(tubePath([[-w * 0.30, h + 0.03 + lift, -0.02, 0.008],
      [-w * 0.31, h + 0.075 + lift, 0.0, 0.008],
      [0, h + 0.090 + lift, 0.01, 0.008],
      [w * 0.31, h + 0.075 + lift, 0.0, 0.008],
      [w * 0.30, h + 0.03 + lift, -0.02, 0.008]], 5), null));
    var out = mergeParts(P, 3.4);
    disposeParts(P);
    void rng;
    return out;
  };

  // A 200 litre drum: two rolling hoops, rolled rims, both bungs, and no
  // circular section left anywhere on it.
  K.drum = function (rng, noise, kind) {
    var P = [];
    var r = 0.288, h = 0.875, i;
    var body = cyl(r, r, h, 16, true);
    roughen(body, noise, 0.011, 3.6, 'radial');
    P.push(part(body, Tn(0, h * 0.5, 0)));
    for (i = 0; i < 2; i++) {
      P.push(part(cyl(r + 0.017, r + 0.017, 0.052, 16), Tn(0, h * (0.34 + i * 0.32), 0)));
    }
    P.push(part(cyl(r + 0.012, r + 0.012, 0.035, 16), Tn(0, 0.018, 0)));
    if (kind === 'open') {
      P.push(part(cyl(r + 0.012, r + 0.012, 0.035, 16), Tn(0, h - 0.02, 0)));
      for (i = 0; i < 5; i++) {
        var a = rng.range(0, 6.28);
        P.push(part(box(0.10, 0.035, 0.012, 0.003),
          Tn(Math.cos(a) * r, h + rng.range(0.00, 0.03), Math.sin(a) * r,
            rng.range(-0.4, 0.4), -a, rng.range(-0.5, 0.5))));
      }
    } else {
      P.push(part(cyl(r, r, 0.030, 16), Tn(0, h - 0.015, 0)));
      P.push(part(cyl(r + 0.012, r + 0.012, 0.035, 16), Tn(0, h - 0.018, 0)));
      P.push(part(cyl(0.035, 0.040, 0.022, 8), Tn(r * 0.55, h + 0.004, 0)));
      P.push(part(cyl(0.022, 0.025, 0.018, 6), Tn(-r * 0.45, h + 0.002, r * 0.30)));
    }
    var out = mergeParts(P, 2.0);
    disposeParts(P);
    return out;
  };

  // A jerrycan.  The silhouette IS the prop: three handles, the X pressing on
  // the flank, the spout offset to one side.
  K.jerry = function (rng) {
    var P = [];
    var w = 0.34, h = 0.47, d = 0.165, i;
    var pts = [];
    function pv(x, y) { pts.push(new THREE.Vector2(x, y)); }
    pv(-w * 0.5, 0.02); pv(-w * 0.5 + 0.03, 0.0); pv(w * 0.5 - 0.03, 0.0);
    pv(w * 0.5, 0.02); pv(w * 0.5, h - 0.06); pv(w * 0.42, h);
    pv(-w * 0.42, h); pv(-w * 0.5, h - 0.06);
    P.push(part(extrudeProfile(pts, d, 2.4), null));
    for (var s = -1; s <= 1; s += 2) {
      P.push(part(box(0.30, 0.028, 0.012, 0.003),
        Tn(0, h * 0.50, s * (d * 0.5 + 0.004), 0, 0, 0.62)));
      P.push(part(box(0.30, 0.028, 0.012, 0.003),
        Tn(0, h * 0.50, s * (d * 0.5 + 0.004), 0, 0, -0.62)));
    }
    for (i = -1; i <= 1; i++) {
      P.push(part(tubePath([[i * 0.10 - 0.035, h + 0.005, -d * 0.30, 0.014],
        [i * 0.10 - 0.030, h + 0.055, -d * 0.05, 0.014],
        [i * 0.10, h + 0.062, d * 0.10, 0.014],
        [i * 0.10 + 0.030, h + 0.055, -d * 0.05, 0.014],
        [i * 0.10 + 0.035, h + 0.005, -d * 0.30, 0.014]], 4), null));
    }
    P.push(part(cyl(0.036, 0.042, 0.045, 8), Tn(w * 0.24, h + 0.02, d * 0.16)));
    P.push(part(cyl(0.045, 0.045, 0.016, 8), Tn(w * 0.24, h + 0.05, d * 0.16)));
    var out = mergeParts(P, 2.8);
    disposeParts(P);
    void rng;
    return out;
  };

  // A knot of ration tins.  Instanced as a CLUSTER, never singly: one 6 cm tin
  // is invisible, but the litter of a meal is a readable mark.
  K.tins = function (rng) {
    var P = [];
    var i;
    for (i = 0; i < 3; i++) {
      var a = rng.range(0, 6.28), rr = rng.range(0.02, 0.10);
      P.push(part(cyl(0.038, 0.038, 0.062, 9),
        Tn(Math.cos(a) * rr, 0.031, Math.sin(a) * rr,
          rng.range(-0.12, 0.12), 0, rng.range(-0.12, 0.12))));
      P.push(part(cyl(0.040, 0.040, 0.006, 9),
        Tn(Math.cos(a) * rr, 0.062, Math.sin(a) * rr)));
    }
    P.push(part(cyl(0.036, 0.036, 0.060, 9),
      Tn(rng.range(-0.10, 0.10), 0.036, rng.range(0.05, 0.14), Math.PI * 0.5, 0.6, 0)));
    P.push(part(cyl(0.044, 0.040, 0.014, 9),
      Tn(rng.range(-0.14, -0.04), 0.007, rng.range(-0.12, -0.02), 0.1, 0, 0.2)));
    P.push(part(box(0.062, 0.004, 0.055, 0.002),
      Tn(rng.range(-0.08, 0.08), 0.004, rng.range(-0.10, 0.10), 0.2, rng.range(0, 3), 0.1)));
    var out = mergeParts(P, 4.5);
    disposeParts(P);
    return out;
  };

  // Bottles - two standing, one on its side.
  K.bottles = function (rng) {
    var P = [];
    var prof = [];
    prof.push(V2(0.001, 0)); prof.push(V2(0.036, 0)); prof.push(V2(0.038, 0.012));
    prof.push(V2(0.038, 0.140)); prof.push(V2(0.028, 0.172)); prof.push(V2(0.014, 0.196));
    prof.push(V2(0.014, 0.245)); prof.push(V2(0.017, 0.252)); prof.push(V2(0.001, 0.252));
    for (var i = 0; i < 3; i++) {
      var g = lathe(prof, 9);
      var a = rng.range(0, 6.28), rr = rng.range(0.03, 0.11);
      if (i === 2) {
        P.push(part(g, Tn(Math.cos(a) * rr, 0.038, Math.sin(a) * rr,
          Math.PI * 0.5, rng.range(0, 6.28), 0)));
      } else {
        P.push(part(g, Tn(Math.cos(a) * rr, 0, Math.sin(a) * rr,
          rng.range(-0.05, 0.05), rng.range(0, 6.28), rng.range(-0.05, 0.05))));
      }
    }
    var out = mergeParts(P, 4.0);
    disposeParts(P);
    return out;
  };

  // A steel helmet shell with its band and the chin strap hanging.
  K.helmet = function (rng, noise) {
    var P = [];
    var shell = sph(0.145, 12, 8);
    var p = shell.attributes.position;
    for (var i = 0; i < p.count; i++) {
      var y = p.getY(i);
      if (y < -0.005) p.setY(i, -0.005 + (y + 0.005) * 0.16);
      else p.setXYZ(i, p.getX(i) * 1.02, y * 0.88, p.getZ(i) * 1.08);
    }
    p.needsUpdate = true;
    shell.computeVertexNormals();
    roughen(shell, noise, 0.004, 7, 'jitter');
    P.push(part(shell, Tn(0, 0.126, 0)));
    P.push(part(torus(0.148, 0.010, 14, 4), Tn(0, 0.122, 0, Math.PI * 0.5, 0, 0)));
    P.push(part(tubePath([[-0.13, 0.118, 0.02, 0.008], [-0.15, 0.055, 0.05, 0.008],
      [-0.11, 0.012, 0.10, 0.008], [-0.02, 0.008, 0.13, 0.008]], 4), null));
    var out = mergeParts(P, 3.0);
    disposeParts(P);
    void rng;
    return out;
  };

  // A filled sandbag - a squashed pillow with the tied neck folded under.
  K.sandbag = function (rng, noise) {
    var g = box(0.52, 0.26, 0.34, 0.10);
    roughen(g, noise, 0.022, 4.2, 'jitter');
    var p = g.attributes.position;
    for (var i = 0; i < p.count; i++) {
      var y = p.getY(i);
      p.setY(i, y * (0.86 + 0.14 * M.saturate(1 - Math.abs(y) * 6)));
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    var P = [part(g, Tn(0, 0.13, 0))];
    P.push(part(box(0.10, 0.06, 0.09, 0.02), Tn(0.24, 0.05, 0.02, 0.3, 0.4, 0.5)));
    var out = mergeParts(P, 2.6);
    disposeParts(P);
    void rng;
    return out;
  };

  // A woven carrying basket: lathe body plus the weave courses, so the rim
  // reads as woven rather than turned.
  K.basket = function (rng) {
    var P = [];
    var prof = [];
    prof.push(V2(0.001, 0)); prof.push(V2(0.13, 0)); prof.push(V2(0.155, 0.06));
    prof.push(V2(0.20, 0.22)); prof.push(V2(0.215, 0.32)); prof.push(V2(0.205, 0.345));
    P.push(part(lathe(prof, 12), null));
    for (var i = 0; i < 5; i++) {
      var y = 0.045 + i * 0.068;
      P.push(part(torus(0.155 + (y / 0.345) * 0.062, 0.008, 12, 4),
        Tn(0, y, 0, Math.PI * 0.5, 0, 0)));
    }
    P.push(part(torus(0.213, 0.014, 14, 4), Tn(0, 0.345, 0, Math.PI * 0.5, 0, 0)));
    var out = mergeParts(P, 3.2);
    disposeParts(P);
    void rng;
    return out;
  };

  // A bamboo fish trap: a cage you can see through, which is the only reason
  // it is worth building rather than painting.
  K.fishTrap = function (rng) {
    var P = [];
    var len = 0.95, r0 = 0.24, r1 = 0.09;
    var n = 11, i;
    for (i = 0; i < n; i++) {
      var a = (i / n) * Math.PI * 2;
      P.push(part(tubePath([[Math.cos(a) * r0, 0.0, Math.sin(a) * r0, 0.010],
        [Math.cos(a) * r0 * 1.02, len * 0.45, Math.sin(a) * r0 * 0.98, 0.009],
        [Math.cos(a) * r1, len, Math.sin(a) * r1, 0.008]], 4), null));
    }
    for (i = 0; i < 4; i++) {
      var t = i / 3;
      P.push(part(torus(r0 + (r1 - r0) * t + 0.004, 0.008, 12, 4),
        Tn(0, len * t, 0, Math.PI * 0.5, 0, 0)));
    }
    for (i = 0; i < 7; i++) {
      var a2 = (i / 7) * Math.PI * 2;
      P.push(part(tubePath([[Math.cos(a2) * r0 * 0.95, 0.02, Math.sin(a2) * r0 * 0.95, 0.007],
        [Math.cos(a2) * 0.07, 0.19, Math.sin(a2) * 0.07, 0.006]], 4), null));
    }
    var out = mergeParts(P, 3.0);
    disposeParts(P);
    void rng;
    return out;
  };

  // A glazed water jar: the one round, soft, domestic shape in a level full of
  // military boxes.
  K.jar = function (rng, noise) {
    var prof = [];
    prof.push(V2(0.001, 0)); prof.push(V2(0.11, 0)); prof.push(V2(0.17, 0.06));
    prof.push(V2(0.215, 0.20)); prof.push(V2(0.20, 0.34)); prof.push(V2(0.14, 0.42));
    prof.push(V2(0.125, 0.46)); prof.push(V2(0.145, 0.475)); prof.push(V2(0.132, 0.485));
    prof.push(V2(0.001, 0.485));
    var g = lathe(prof, 14);
    roughen(g, noise, 0.005, 5, 'radial');
    Geo.worldUV(g, 2.4);
    Geo.copyUV1(g);
    void rng;
    return g;
  };

  // A bamboo culm with its nodes.  The nodes are the whole read: without them
  // a bamboo pole is a dowel.
  K.pole = function (rng, len) {
    var P = [];
    len = len || 2.6;
    var r = 0.032, st = [];
    for (var i = 0; i <= 14; i++) {
      var t = i / 14;
      st.push([Math.sin(t * 2.2) * 0.02, len * t, 0,
        r * (1 - t * 0.30) * ((i % 2) === 1 ? 1.16 : 1.0)]);
    }
    P.push(part(tubePath(st, 6, true), null));
    var out = mergeParts(P, 2.2);
    disposeParts(P);
    void rng;
    return out;
  };

  // Deadfall: a main limb through four jittered stations plus two side twigs -
  // the shape that says "this fell" rather than "this was cut".
  K.branch = function (rng, noise, scale) {
    var P = [];
    scale = scale || 1;
    var len = rng.range(1.1, 2.3) * scale;
    var r = rng.range(0.035, 0.075) * scale;
    var st = [], i, t;
    var bx = rng.range(-0.3, 0.3), bz = rng.range(-0.25, 0.25);
    for (i = 0; i <= 4; i++) {
      t = i / 4;
      st.push([bx * t * t + rng.range(-0.03, 0.03),
        r * (1 - t * 0.2) + rng.range(-0.02, 0.02),
        len * t + bz * t * t, r * (1 - t * 0.72)]);
    }
    P.push(part(tubePath(st, 5), null));
    for (i = 0; i < 2; i++) {
      var at = rng.range(0.25, 0.75);
      var ax = bx * at * at, az = len * at;
      var ang = rng.range(0, 6.28), tl = rng.range(0.25, 0.6) * scale;
      P.push(part(tubePath([[ax, r * 0.9, az, r * 0.42],
        [ax + Math.cos(ang) * tl * 0.6, r * 0.9 + rng.range(0.02, 0.14),
          az + Math.sin(ang) * tl * 0.6, r * 0.24],
        [ax + Math.cos(ang) * tl, r * 0.9 + rng.range(0.0, 0.10),
          az + Math.sin(ang) * tl, r * 0.08]], 4), null));
    }
    var out = mergeParts(P, 1.8);
    disposeParts(P);
    if (out && noise) roughen(out, noise, 0.006, 5, 'jitter');
    return out;
  };

  // A rock.  Boxes roughened hard - the only mineral things in this level are
  // the outcrop and the creek bed, and both are broken.
  K.rock = function (rng, noise, scale) {
    scale = scale || 1;
    var g = box(rng.range(0.30, 0.62) * scale, rng.range(0.20, 0.40) * scale,
      rng.range(0.28, 0.58) * scale, 0.06 * scale);
    roughen(g, noise, 0.055 * scale, 3.4, 'jitter');
    Geo.worldUV(g, 1.6);
    Geo.copyUV1(g);
    return g;
  };

  // Bracket fungus - shelves stepping up a trunk.  The one place in the level
  // where something pale grows on something dark, which is what makes a trunk
  // read as rotting rather than as a pole.
  // A STACK OF NEAR-FLAT DISCS IS NOT A BRACKET. The old kit lathed three to
  // five level plates and gave them a -0.05 to -0.22 rad pitch, i.e. tilted
  // DOWN, so even correctly placed they photographed as pale ellipses lying on
  // the log like stickers. A bracket fungus is a half-disc that grows OUT of
  // the trunk and tilts UP: it has a thick attached root, a thin free edge, a
  // concave gilled underside and concentric growth banding.
  K.fungus = function (rng) {
    var P = [];
    var n = rng.int(3, 5);
    for (var i = 0; i < n; i++) {
      var y = i * rng.range(0.055, 0.115);
      var r = rng.range(0.075, 0.165) * (1 - i * 0.09);
      var a = rng.range(-0.9, 0.9);
      // A half-disc lathed from a profile: thick at the trunk, feathering to a
      // wavy lip, with the underside dished so the shelf reads as a shelf from
      // below as well as from above.
      var g = cyl(r, r * 0.55, 0.030 + r * 0.10, 11);
      var p = g.attributes.position;
      for (var v = 0; v < p.count; v++) {
        var vx = p.getX(v), vy = p.getY(v), vz = p.getZ(v);
        // collapse the back half into the trunk face
        if (vz < 0) p.setZ(v, vz * 0.14);
        // the free edge falls away and ripples; the attached edge thickens
        var rad = Math.sqrt(vx * vx + vz * vz) / Math.max(r, 1e-4);
        var wave = Math.sin(Math.atan2(vx, vz) * 5.0 + i * 1.7) * 0.16;
        p.setY(v, vy * (1.0 + (1 - rad) * 1.4) +
          Math.max(0, vz) * (0.30 + wave * 0.1) - rad * 0.012);
        p.setX(v, vx * (1 + wave * 0.10));
      }
      p.needsUpdate = true;
      g.computeVertexNormals();
      // +0.28 rad: it grows UPWARD off the flank, which is what makes a shelf
      // catch light on top and go dark underneath.
      P.push(part(g, Tn(Math.sin(a) * 0.02, y, r * 0.42, rng.range(0.24, 0.52), a, 0)));
    }
    var out = mergeParts(P, 4.0);
    disposeParts(P);
    return out;
  };

  // A termite mound at the foot of a buttress.
  K.termite = function (rng, noise) {
    var prof = [];
    var h = rng.range(0.55, 1.35);
    prof.push(V2(0.001, 0)); prof.push(V2(0.34, 0.0)); prof.push(V2(0.30, h * 0.22));
    prof.push(V2(0.20, h * 0.52)); prof.push(V2(0.13, h * 0.78));
    prof.push(V2(0.05, h * 0.96)); prof.push(V2(0.001, h));
    var g = lathe(prof, 11);
    roughen(g, noise, 0.035, 2.6, 'radial');
    Geo.worldUV(g, 1.7);
    Geo.copyUV1(g);
    return g;
  };

  // A sharpened stake: punji beside the track, fish weir in the shallows.
  K.stake = function (rng, len) {
    var P = [];
    len = len || 1.05;
    var r = rng.range(0.020, 0.034);
    P.push(part(cyl(r * 0.9, r, len, 6), Tn(0, len * 0.5, 0)));
    P.push(part(cyl(0.001, r * 0.9, 0.16, 6), Tn(0, len + 0.08, 0)));
    P.push(part(cyl(r * 1.14, r * 1.14, 0.012, 6), Tn(0, len * 0.42, 0)));
    var out = mergeParts(P, 3.0);
    disposeParts(P);
    return out;
  };

  // A wooden cable drum, half unwound.
  K.spool = function (rng) {
    var P = [];
    var R = 0.42, w = 0.40, i;
    for (var s = -1; s <= 1; s += 2) {
      P.push(part(cyl(R, R, 0.035, 14), Tn(s * w * 0.5, 0, 0, 0, 0, Math.PI * 0.5)));
      for (i = 0; i < 6; i++) {
        P.push(part(box(0.05, R * 1.9, 0.026, 0.004),
          Tn(s * (w * 0.5 + 0.026), 0, 0, 0, 0, i / 6 * Math.PI * 2)));
      }
    }
    P.push(part(cyl(0.145, 0.145, w, 12), Tn(0, 0, 0, 0, 0, Math.PI * 0.5)));
    P.push(part(cyl(0.30, 0.30, w * 0.78, 14), Tn(0, 0, 0, 0, 0, Math.PI * 0.5)));
    for (i = 0; i < 5; i++) {
      P.push(part(torus(0.305 + i * 0.004, 0.012, 14, 4),
        Tn(-w * 0.30 + i * 0.15, 0, 0, 0, Math.PI * 0.5, 0)));
    }
    var out = mergeParts(P, 2.4);
    disposeParts(P);
    void rng;
    return out;
  };

  // The fibre tube a mortar bomb ships in.
  K.mortarTube = function (rng) {
    var P = [];
    var h = 0.62;
    P.push(part(cyl(0.062, 0.062, h, 10), Tn(0, h * 0.5, 0)));
    P.push(part(cyl(0.068, 0.068, 0.045, 10), Tn(0, h - 0.02, 0)));
    P.push(part(cyl(0.068, 0.068, 0.030, 10), Tn(0, 0.015, 0)));
    P.push(part(torus(0.064, 0.006, 10, 4), Tn(0, h * 0.42, 0, Math.PI * 0.5, 0, 0)));
    var out = mergeParts(P, 3.4);
    disposeParts(P);
    void rng;
    return out;
  };

  // A truck tyre - a step, a fender and a chock.
  K.tyre = function (rng, noise) {
    var P = [];
    var g = torus(0.44, 0.155, 16, 7);
    roughen(g, noise, 0.010, 4.0, 'jitter');
    P.push(part(g, Tn(0, 0.44, 0, Math.PI * 0.5, 0, 0)));
    for (var i = 0; i < 14; i++) {
      var a = i / 14 * Math.PI * 2;
      P.push(part(box(0.10, 0.05, 0.30, 0.012),
        Tn(Math.cos(a) * 0.585, 0.44, Math.sin(a) * 0.585, 0, 0, a + Math.PI * 0.5)));
    }
    var out = mergeParts(P, 2.6);
    disposeParts(P);
    void rng;
    return out;
  };

  // A fallen palm nut, split, with its fibre.
  K.husk = function (rng) {
    var P = [];
    var g = sph(0.105, 9, 7);
    var p = g.attributes.position;
    for (var i = 0; i < p.count; i++) {
      p.setXYZ(i, p.getX(i) * 1.06, p.getY(i) * 0.80, p.getZ(i) * 0.92);
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    P.push(part(g, Tn(0, 0.078, 0)));
    for (i = 0; i < 5; i++) {
      var a = rng.range(0, 6.28);
      P.push(part(box(0.02, 0.008, 0.09, 0.002),
        Tn(Math.cos(a) * 0.09, 0.02, Math.sin(a) * 0.09, 0.1, -a, rng.range(-0.3, 0.3))));
    }
    var out = mergeParts(P, 4.0);
    disposeParts(P);
    return out;
  };

  // A coil of field-telephone wire, dropped where it ran out.
  K.wireCoil = function (rng) {
    var P = [];
    var turns = 4, R = 0.20;
    for (var t = 0; t < turns; t++) {
      var st = [];
      for (var i = 0; i <= 12; i++) {
        var a = (i / 12) * Math.PI * 2;
        var rr = R * (1 - t * 0.09) + Math.sin(a * 3 + t) * 0.015;
        st.push([Math.cos(a) * rr, 0.014 + t * 0.026 + Math.sin(a * 2) * 0.008,
          Math.sin(a) * rr, 0.011]);
      }
      P.push(part(tubePath(st, 4), null));
    }
    P.push(part(tubePath([[R * 0.9, 0.02, 0, 0.010], [R + 0.30, 0.012, 0.22, 0.010],
      [R + 0.55, 0.010, 0.62, 0.010]], 4), null));
    var out = mergeParts(P, 3.0);
    disposeParts(P);
    void rng;
    return out;
  };

  // A folding cot.  Two geometries, because the frame is steel and the bed is
  // canvas and one material cannot be both.
  K.cot = function (rng) {
    var F = [], C = [];
    var L = 1.90, W = 0.66, H = 0.42;
    var s, e, i, j, k;
    for (s = -1; s <= 1; s += 2) {
      F.push(part(cyl(0.018, 0.018, L, 6), Tn(s * W * 0.5, H, 0, Math.PI * 0.5, 0, 0)));
      for (e = -1; e <= 1; e += 2) {
        F.push(part(cyl(0.016, 0.016, H * 1.06, 6),
          Tn(s * W * 0.5, H * 0.5, e * (L * 0.5 - 0.16), 0, 0, s * 0.12)));
        F.push(part(cyl(0.014, 0.014, W * 1.02, 6),
          Tn(0, 0.02, e * (L * 0.5 - 0.16), 0, 0, Math.PI * 0.5)));
      }
    }
    F.push(part(cyl(0.016, 0.016, W, 6), Tn(0, H, L * 0.5, 0, 0, Math.PI * 0.5)));
    F.push(part(cyl(0.016, 0.016, W, 6), Tn(0, H, -L * 0.5, 0, 0, Math.PI * 0.5)));
    var pos = [], nor = [], uv = [];
    var NX = 4, NZ = 8;
    function sag(x, z) {
      return H - 0.055 * Math.cos(x / W * 3.1) * Math.cos(z / L * 3.1) - 0.02;
    }
    for (i = 0; i < NX; i++) {
      for (j = 0; j < NZ; j++) {
        var x0 = -W * 0.5 + (i / NX) * W, x1 = -W * 0.5 + ((i + 1) / NX) * W;
        var z0 = -L * 0.5 + (j / NZ) * L, z1 = -L * 0.5 + ((j + 1) / NZ) * L;
        var q = [[x0, sag(x0, z0), z0], [x1, sag(x1, z0), z0],
          [x1, sag(x1, z1), z1], [x0, sag(x0, z1), z1]];
        var tri = [0, 1, 2, 0, 2, 3];
        for (k = 0; k < 6; k++) {
          var vtx = q[tri[k]];
          pos.push(vtx[0], vtx[1], vtx[2]);
          nor.push(0, 1, 0);
          uv.push(vtx[0], vtx[2]);
        }
      }
    }
    var bed = new THREE.BufferGeometry();
    bed.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    bed.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    bed.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    bed.computeVertexNormals();
    C.push(part(bed, null));
    var frame = mergeParts(F, 3.0);
    var cloth = mergeParts(C, 1.6);
    disposeParts(F); disposeParts(C);
    void rng;
    return { frame: frame, cloth: cloth };
  };

  // A field radio: the set, its faceplate, the carrying frame, the handset, and
  // the whip antenna bending over under its own weight.
  K.radio = function (rng) {
    var P = [];
    var w = 0.28, h = 0.32, d = 0.20, i;
    P.push(part(box(w, h, d, 0.012), Tn(0, h * 0.5, 0)));
    P.push(part(box(w * 0.94, h * 0.42, 0.018, 0.004), Tn(0, h * 0.66, d * 0.5)));
    for (i = 0; i < 3; i++) {
      P.push(part(cyl(0.026, 0.028, 0.022, 8),
        Tn(-w * 0.28 + i * 0.09, h * 0.70, d * 0.5 + 0.014, Math.PI * 0.5, 0, 0)));
    }
    P.push(part(box(0.09, 0.05, 0.014, 0.003), Tn(w * 0.28, h * 0.44, d * 0.5 + 0.01)));
    for (var s = -1; s <= 1; s += 2) {
      P.push(part(cyl(0.010, 0.010, h + 0.06, 5),
        Tn(s * (w * 0.5 + 0.014), h * 0.52, -d * 0.3)));
    }
    P.push(part(cyl(0.010, 0.010, w + 0.028, 5), Tn(0, h + 0.05, -d * 0.3, 0, 0, Math.PI * 0.5)));
    var st = [];
    for (i = 0; i <= 5; i++) {
      var t = i / 5;
      st.push([Math.pow(t, 2.2) * 0.55, h + 0.02 + t * 1.35 - Math.pow(t, 2.4) * 0.30,
        Math.pow(t, 2.4) * 0.20, 0.010 - t * 0.005]);
    }
    P.push(part(tubePath(st, 4), null));
    P.push(part(box(0.055, 0.16, 0.045, 0.012),
      Tn(w * 0.5 + 0.07, h * 0.62, -d * 0.05, 0.1, 0.3, 0.25)));
    var out = mergeParts(P, 3.2);
    disposeParts(P);
    void rng;
    return out;
  };

  // A stretcher: two poles, a canvas bed, four feet.
  K.stretcher = function (rng) {
    var P = [], C = [];
    var L = 2.05, W = 0.56;
    for (var s = -1; s <= 1; s += 2) {
      P.push(part(cyl(0.022, 0.022, L, 6), Tn(s * W * 0.5, 0.055, 0, Math.PI * 0.5, 0, 0)));
      for (var e = -1; e <= 1; e += 2) {
        P.push(part(cyl(0.018, 0.018, 0.11, 5), Tn(s * W * 0.5, 0.03, e * L * 0.34)));
        P.push(part(cyl(0.014, 0.014, W, 5), Tn(0, 0.06, e * L * 0.34, 0, 0, Math.PI * 0.5)));
      }
    }
    C.push(part(cardGeo(W * 0.94, L * 0.80, 0, 0, 1, 1),
      Tn(0, 0.072, -L * 0.40, -Math.PI * 0.5, 0, 0)));
    var frame = mergeParts(P, 3.0);
    var cloth = mergeParts(C, 1.4);
    disposeParts(P); disposeParts(C);
    void rng;
    return { frame: frame, cloth: cloth };
  };

  // A dugout sampan pulled up the mud: a real hull section swept along a curved
  // sheer, gunwale strakes, three thwarts.
  K.sampan = function (rng, noise) {
    var P = [];
    var L = 4.6, halfW = 0.52, depth = 0.42;
    var rings = 9, SEG = 7, i, j;
    function hull(k) {
      var t = k / (rings - 1);
      var taper = Math.sin(Math.pow(t, 0.85) * Math.PI);
      return { w: halfW * (0.22 + 0.78 * taper),
        d: depth * (0.35 + 0.65 * taper),
        y: 0.30 * Math.pow(Math.abs(t - 0.5) * 2, 2.6),
        z: -L * 0.5 + t * L };
    }
    function pt(h, k) {
      var a = -Math.PI * 0.5 + (k / SEG) * Math.PI;
      return [Math.sin(a) * h.w, h.y + h.d + (Math.cos(a) - 1) * h.d * 0.85, h.z];
    }
    var pos = [], nor = [], uv = [];
    for (i = 0; i + 1 < rings; i++) {
      var h0 = hull(i), h1 = hull(i + 1);
      for (j = 0; j < SEG; j++) {
        var a0 = pt(h0, j), b0 = pt(h0, j + 1), a1 = pt(h1, j), b1 = pt(h1, j + 1);
        pos.push(a0[0], a0[1], a0[2], b0[0], b0[1], b0[2], b1[0], b1[1], b1[2]);
        pos.push(a0[0], a0[1], a0[2], b1[0], b1[1], b1[2], a1[0], a1[1], a1[2]);
        for (var q = 0; q < 6; q++) nor.push(0, 1, 0);
        uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    g.computeVertexNormals();
    roughen(g, noise, 0.010, 3.0, 'jitter');
    P.push(part(g, null));
    for (var s = -1; s <= 1; s += 2) {
      var st = [];
      for (i = 0; i < rings; i++) {
        var h = hull(i);
        st.push([s * h.w, h.y + h.d, h.z, 0.030]);
      }
      P.push(part(tubePath(st, 4), null));
    }
    for (i = -1; i <= 1; i++) {
      var hz = hull(4 + i * 2);
      P.push(part(box(hz.w * 2.0, 0.035, 0.16, 0.006), Tn(0, hz.y + hz.d * 0.86, hz.z)));
    }
    var out = mergeParts(P, 1.8);
    disposeParts(P);
    void rng;
    return out;
  };

  // A porter's bicycle - the thing that actually moved rice up this track.
  K.bicycle = function (rng) {
    var P = [];
    var R = 0.34, k;
    for (var s = -1; s <= 1; s += 2) {
      P.push(part(torus(R, 0.026, 16, 5), Tn(0, R, s * 0.53)));
      P.push(part(torus(R * 0.55, 0.006, 14, 4), Tn(0, R, s * 0.53)));
      P.push(part(cyl(0.030, 0.030, 0.09, 7), Tn(0, R, s * 0.53, 0, 0, Math.PI * 0.5)));
      for (k = 0; k < 6; k++) {
        P.push(part(cyl(0.004, 0.004, R * 1.9, 4), Tn(0, R, s * 0.53, 0, 0, k / 6 * Math.PI)));
      }
    }
    function tube2(ax, ay, az, bx, by, bz, r) {
      P.push(part(tubePath([[ax, ay, az, r], [bx, by, bz, r]], 5), null));
    }
    tube2(0, R + 0.02, 0.50, 0, 0.72, 0.10, 0.020);
    tube2(0, 0.72, 0.10, 0, 0.60, -0.28, 0.018);
    tube2(0, 0.60, -0.28, 0, R + 0.02, -0.50, 0.018);
    tube2(0, R + 0.02, -0.50, 0, 0.30, -0.02, 0.018);
    tube2(0, 0.30, -0.02, 0, 0.72, 0.10, 0.018);
    P.push(part(box(0.10, 0.05, 0.22, 0.02), Tn(0, 0.66, -0.30, 0.12, 0, 0)));
    tube2(-0.22, 0.86, 0.14, 0.22, 0.86, 0.14, 0.014);
    tube2(0, 0.72, 0.10, 0, 0.88, 0.13, 0.016);
    tube2(-0.16, 0.52, -0.62, 0.16, 0.52, -0.62, 0.012);
    tube2(-0.16, 0.52, -0.62, -0.14, 0.52, -0.16, 0.012);
    tube2(0.16, 0.52, -0.62, 0.14, 0.52, -0.16, 0.012);
    tube2(0.20, 0.88, 0.16, 0.66, 1.02, 0.80, 0.016);
    var out = mergeParts(P, 3.4);
    disposeParts(P);
    void rng;
    return out;
  };

  // A cart wheel, half sunk in the verge.
  K.cartWheel = function (rng) {
    var P = [];
    var R = 0.58;
    P.push(part(torus(R, 0.045, 18, 5), null));
    P.push(part(torus(R + 0.035, 0.014, 18, 4), null));
    P.push(part(cyl(0.085, 0.085, 0.20, 9), Tn(0, 0, 0, Math.PI * 0.5, 0, 0)));
    for (var i = 0; i < 10; i++) {
      P.push(part(box(0.036, R * 1.86, 0.036, 0.004), Tn(0, 0, 0, 0, 0, i / 10 * Math.PI * 2)));
    }
    var out = mergeParts(P, 2.6);
    disposeParts(P);
    void rng;
    return out;
  };

  // A net of crossed cords, not a texture.  There are two of them in the whole
  // level, so they can afford to be real - and a real net is the only thing
  // that reads as a net at three metres.
  K.netSheet = function (w, h, cols, rows, sag) {
    var P = [];
    var i, j;
    function ny(u, v) {
      return -sag * Math.sin(u * Math.PI) * Math.sin(v * Math.PI) - v * h;
    }
    for (i = 0; i <= cols; i++) {
      var u = i / cols;
      var st = [];
      for (j = 0; j <= rows; j++) {
        var v = j / rows;
        st.push([(u - 0.5) * w, ny(u, v), Math.sin(u * 3.1) * 0.06 + v * 0.04, 0.006]);
      }
      P.push(part(tubePath(st, 3), null));
    }
    for (j = 0; j <= rows; j++) {
      var v2 = j / rows;
      var st2 = [];
      for (i = 0; i <= cols; i++) {
        var u2 = i / cols;
        st2.push([(u2 - 0.5) * w, ny(u2, v2), Math.sin(u2 * 3.1) * 0.06 + v2 * 0.04, 0.006]);
      }
      P.push(part(tubePath(st2, 3), null));
    }
    var out = mergeParts(P, 3.0);
    disposeParts(P);
    return out;
  };

  // A hanging cloth panel with a real sag: ponchos, the tarp over the
  // ammunition, laundry, the mosquito net.  v runs 0 at the hung edge to 1 at
  // the free one, which _commit turns into the wind-flex ramp after the merge.
  K.clothPanel = function (w, h, sagX, sagY, nx, ny) {
    nx = nx || 5; ny = ny || 5;
    var pos = [], nor = [], uv = [];
    function P3(u, v) {
      return [(u - 0.5) * w, -v * h,
        sagX * Math.sin(u * Math.PI) * (0.35 + 0.65 * v) +
        sagY * Math.sin(v * Math.PI) * 0.5];
    }
    for (var i = 0; i < nx; i++) {
      for (var j = 0; j < ny; j++) {
        var u0 = i / nx, u1 = (i + 1) / nx, v0 = j / ny, v1 = (j + 1) / ny;
        var q = [P3(u0, v0), P3(u1, v0), P3(u1, v1), P3(u0, v1)];
        var uvq = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
        var tri = [0, 1, 2, 0, 2, 3];
        for (var k = 0; k < 6; k++) {
          var t = tri[k];
          pos.push(q[t][0], q[t][1], q[t][2]);
          nor.push(0, 0, 1);
          uv.push(uvq[t][0], uvq[t][1]);
        }
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    g.computeVertexNormals();
    return g;
  };

  // Small stuff.  The eye finds the SMALL objects first when it is deciding
  // whether a place is inhabited, which is why these exist at all.
  K.bucket = function () {
    var prof = [];
    prof.push(V2(0.001, 0)); prof.push(V2(0.105, 0)); prof.push(V2(0.135, 0.24));
    prof.push(V2(0.140, 0.26)); prof.push(V2(0.128, 0.265)); prof.push(V2(0.001, 0.265));
    var P = [part(lathe(prof, 12), null)];
    P.push(part(torus(0.138, 0.008, 12, 4), Tn(0, 0.255, 0, Math.PI * 0.5, 0, 0)));
    P.push(part(tubePath([[-0.132, 0.24, 0, 0.007], [-0.10, 0.33, 0, 0.007],
      [0, 0.36, 0, 0.007], [0.10, 0.33, 0, 0.007], [0.132, 0.24, 0, 0.007]], 4), null));
    var out = mergeParts(P, 3.4);
    disposeParts(P);
    return out;
  };

  K.shovel = function () {
    var P = [];
    P.push(part(cyl(0.017, 0.020, 0.98, 6), Tn(0, 0.49, 0)));
    P.push(part(box(0.055, 0.10, 0.018, 0.006), Tn(0, 1.02, 0)));
    P.push(part(box(0.19, 0.26, 0.014, 0.010), Tn(0, 0.09, 0.02, 0.16, 0, 0)));
    P.push(part(box(0.19, 0.05, 0.020, 0.006), Tn(0, 0.20, 0.03, 0.16, 0, 0)));
    var out = mergeParts(P, 3.2);
    disposeParts(P);
    return out;
  };

  K.canteen = function () {
    var P = [];
    var g = cyl(0.075, 0.075, 0.20, 10);
    var p = g.attributes.position;
    for (var i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) * 0.55);
    p.needsUpdate = true;
    g.computeVertexNormals();
    P.push(part(g, Tn(0, 0.10, 0)));
    P.push(part(cyl(0.022, 0.024, 0.035, 8), Tn(0, 0.21, 0)));
    P.push(part(box(0.14, 0.10, 0.09, 0.012), Tn(0, 0.055, 0)));
    var out = mergeParts(P, 4.0);
    disposeParts(P);
    return out;
  };

  K.boots = function (rng) {
    var P = [];
    for (var s = -1; s <= 1; s += 2) {
      var yaw = rng.range(-0.5, 0.5) + (s > 0 ? 0.2 : -0.2);
      P.push(part(box(0.11, 0.09, 0.29, 0.03), Tn(s * 0.08, 0.045, 0, 0, yaw, 0)));
      P.push(part(box(0.115, 0.020, 0.30, 0.008), Tn(s * 0.08, 0.008, 0, 0, yaw, 0)));
      P.push(part(box(0.105, 0.17, 0.11, 0.025),
        Tn(s * 0.08 - Math.sin(yaw) * 0.09, 0.12, -Math.cos(yaw) * 0.09, 0, yaw, 0)));
    }
    var out = mergeParts(P, 3.4);
    disposeParts(P);
    return out;
  };

  // ==========================================================================
  // Static bucket tables.  One merged mesh per key, one draw call each.
  //
  // TINT_BUCKETS are the ones drawn with a material BORROWED FROM THE LEVEL.
  // Those are multiply-vertexColor materials (level_jungle asks materials.js
  // for wearMode 'multiply' on every library surface it uses), so a wear mask
  // painted onto them would come out as a flat grey wash.  They get paintTint
  // instead.  Getting this table wrong is invisible in code and obvious in a
  // capture, which is why it is a table and not a condition buried in a loop.
  // ==========================================================================
  var STATIC_MATERIAL = {
    wood: 'wood', bamboo: 'bamboo', rust: 'rust', steel: 'steel', olive: 'olive',
    canvas: 'canvas', cloth: 'cloth', rope: 'rope', sack: 'sack', stone: 'stone',
    rubber: 'rubber', pot: 'pot', vine: 'bark', leaf: 'leaf', hang: 'hang',
    alu: 'alu', marks: 'marks', board: 'board', ember: 'ember'
  };
  var TINT_BUCKET = { vine: 1, leaf: 1, hang: 1, alu: 1, marks: 1, ember: 1 };
  var KEEPUV_BUCKET = { leaf: 1, hang: 1, marks: 1, board: 1, ember: 1 };
  var STATIC_UV = {
    wood: 2.2, bamboo: 2.6, rust: 2.2, steel: 2.8, olive: 2.4, canvas: 1.7,
    cloth: 1.9, rope: 3.2, sack: 2.0, stone: 1.5, rubber: 2.6, pot: 2.6,
    vine: 2.0, alu: 2.0
  };
  var NOSHADOW_BUCKET = { marks: 1, ember: 1 };

  var FALLBACK_SPEC = {
    wood_plank: [0x6a583f, 0.92, 0.0],
    rusted_metal: [0x6b4229, 0.90, 0.45],
    painted_metal: [0x6a6d63, 0.62, 0.45],
    paint_green: [0x44503a, 0.72, 0.20],
    canvas_awning: [0x5c5b44, 0.95, 0.0],
    cloth_olive: [0x53573c, 0.94, 0.0],
    sandbag: [0x8b8161, 0.96, 0.0],
    rope: [0x6a604c, 0.95, 0.0],
    rubber: [0x1b1d1d, 0.92, 0.0],
    stone: [0x6f7168, 0.93, 0.0],
    brick: [0x8a5b3c, 0.92, 0.0],
    plaster: [0xb2a888, 0.90, 0.0],
    glass: [0x8fa0a2, 0.16, 0.0]
  };

  // ==========================================================================
  // PropsJungle
  // ==========================================================================
  function PropsJungle(ctx) {
    this.ctx = ctx || {};
    this.root = new THREE.Object3D();
    this.root.name = 'props_jungle';
    this.root.matrixAutoUpdate = false;
    this.colliders = [];

    // Deterministic and independent of every other system's stream, so adding
    // a raindrop somewhere else cannot reshuffle the firebase.
    var seed = ((this.ctx.seed || 20260801) ^ 0x1A7E4C21) >>> 0;
    this.rng = new GAME.RNG(seed);
    this.noise = new GAME.Noise((seed ^ 0x2545F491) >>> 0);

    this.time = 0;
    this.windSpeed = 1.6;
    this.windDir = new THREE.Vector2(WIND_X, WIND_Z);

    this.tex = {};
    this.mats = {};
    this.B = {};
    this.S = {};
    for (var k in STATIC_MATERIAL) this.S[k] = [];

    this.hyacinth = [];
    this._occ = new Map();
    this._skipped = 0;
    this._markCount = 0;
    // WHY a placement was rejected, by reason.  Without this a site that has
    // been quietly eaten by one over-broad test is indistinguishable from a
    // site that was never authored - which is exactly how the first build lost
    // the whole fire ring to a road that stops at the gate.
    this._why = { bounds: 0, track: 0, water: 0, cam: 0, occ: 0, solid: 0 };
    this.stats = { instances: 0, drawCalls: 0, tris: 0, colliders: 0,
      skipped: 0, full: [], sites: 0 };

    // Nominal delta, overwritten by _probeLayout from level.anchors.  These
    // exist so a level that failed to build does not take this module with it.
    this.bounds = { x0: -62, x1: 58, z0: -58, z1: 66 };
    this.waterY = 0;
    this.A = null;
    this.L = null;
    this.camMarks = [];
    this.foliage = null;

    try { if (this.ctx.scene) this.ctx.scene.add(this.root); }
    catch (e) { GAME.logError('propsJ.ctor', e); }
  }

  PropsJungle.prototype._phase = function (name, fn) {
    try { fn.call(this); } catch (e) { GAME.logError('propsJ.' + name, e); }
    return GAME.yieldFrame();
  };

  PropsJungle.prototype.build = async function (ctx) {
    if (ctx) this.ctx = ctx;
    await this._phase('textures', this._initTextures);
    await this._phase('materials', this._initMaterials);
    await this._phase('layout', this._probeLayout);
    await this._phase('kit', this._buildKit);
    // Order is the order a place accumulates: the big sited things first, the
    // clutter around them, the growth over the top, the ground marks last.  A
    // pass that runs after the clutter has taken every clear site never lands.
    await this._phase('firebase', this._dressFirebase);
    await this._phase('bunker', this._dressBunker);
    await this._phase('tower', this._dressTower);
    await this._phase('wreck', this._dressWreck);
    await this._phase('creek', this._dressCreek);
    await this._phase('shrine', this._dressShrine);
    await this._phase('track', this._dressTrack);
    await this._phase('river', this._dressRiver);
    await this._phase('forest', this._dressForest);
    await this._phase('marks', this._dressMarks);
    await this._phase('commit', this._commit);
    return this;
  };

  // --------------------------------------------------------------- textures --
  PropsJungle.prototype._initTextures = function () {
    var aniso = 8;
    try {
      if (this.ctx.renderer && this.ctx.renderer.capabilities) {
        aniso = Math.min(8, this.ctx.renderer.capabilities.getMaxAnisotropy() || 8);
      }
    } catch (e) { /* headless */ }
    this._aniso = aniso;
    this.tex.marks = texOf(buildMarkAtlas(this.rng.fork ? this.rng.fork(0x4D41) : this.rng),
      true, aniso, true);
    this.tex.board = texOf(buildBoardTex(this.rng.fork ? this.rng.fork(0x424F) : this.rng),
      true, aniso, true);
  };

  // -------------------------------------------------------------- materials --
  PropsJungle.prototype._material = function (name, opts) {
    opts = opts || {};
    var lib = this.ctx.materials;
    var mat = null;
    try {
      if (lib && lib.get && (!lib.has || lib.has(name))) {
        var m = lib.get(name, opts);
        // clone() is overridden by materials.js to preserve its shader work, so
        // anything of ours has to be applied AFTER this call, never before.
        if (m && m.clone) mat = m.clone();
      }
    } catch (e) { GAME.logError('propsJ.mat:' + name, e); }
    if (!mat) {
      var spec = FALLBACK_SPEC[name] || FALLBACK_SPEC.wood_plank;
      mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHex(spec[0], THREE.SRGBColorSpace),
        roughness: spec[1], metalness: spec[2], envMapIntensity: 1.0
      });
      if (opts.vertexColors) mat.vertexColors = true;
      if (opts.side !== undefined) mat.side = opts.side;
      if (opts.transparent) mat.transparent = true;
    }
    // NOTHING IN A DELTA FIREBASE IS POLISHED.  The sky here is `overcast`, so
    // the probe is real and metal does not render black the way it does in a
    // sealed level - but a mirror-finish drum in a rain forest is its own kind
    // of wrong, and a high roughness plus a capped metalness is what makes a
    // steel can read as steel that has been outdoors for a year.
    // 0.30, not 0.55, and the reason is physics rather than taste: rust is iron
    // OXIDE and an oxide is a dielectric, so a drum that has stood ten monsoons
    // has almost no conductive surface left. At 0.55 the six oil drums in the
    // establishing shot threw away half their diffuse response and photographed
    // as near-black cylinders (0.026 luminance) on mud at 0.112 - the "props
    // read as black stickers on a bright field" finding, in its purest form.
    if (typeof mat.metalness === 'number' && mat.metalness > 0.30) mat.metalness = 0.30;
    mat.name = 'jp_' + name;
    return mat;
  };

  // The level's own surfaces - the foliage, the bark, the mud and the wreck's
  // aluminium.  Borrowed, never re-authored: a fern growing out of the engine
  // deck has to be the same plant, the same shader and the same sway as the one
  // at the skid, and a panel lying in the mud has to be the same alloy as the
  // airframe it came off.
  PropsJungle.prototype._levelMaterial = function (key) {
    var L = this.ctx.level;
    try {
      if (L && typeof L.material === 'function') {
        var m = L.material(key);
        if (m && m.isMaterial) return m;
      }
    } catch (e) { GAME.logError('propsJ.levelMat:' + key, e); }
    return null;
  };

  PropsJungle.prototype._initMaterials = function () {
    var m = this.mats;
    var W = { vertexColors: true };            // R grime/growth, G wet, B edge

    m.wood = this._material('wood_plank', W);
    m.bamboo = this._material('wood_plank',
      { vertexColors: true, albedoTarget: 0x9c9564, hue: 0.85 });
    // albedoTarget, and it matches level_jungle's SURF.rust exactly - a drum
    // and the culvert twelve metres from it have to be the same steel.
    // genRustedMetal's own mean measures 0.067 linear luminance, which is the
    // albedo of wet coal: against a forest floor at 0.11 every drum, jerrycan
    // and length of pipe in the level rendered as a black cut-out, which is the
    // "props read as black stickers pasted onto a bright field" finding.
    m.rust = this._material('rusted_metal',
      { vertexColors: true, albedoTarget: 0x7d5a42 });
    m.steel = this._material('painted_metal', W);
    m.olive = this._material('paint_green',
      { vertexColors: true, albedoTarget: 0x3f4a33, hue: 0.9 });
    // OLIVE, not the library's default awning grey.  Every piece of cloth in
    // this level is army canvas that has been rained on for a year, and a pale
    // grey sheet in a frame that is chlorophyll from edge to edge reads as
    // polythene - it is the one prop that can pull the eye off the subject
    // from forty metres.
    m.canvas = this._material('canvas_awning',
      { vertexColors: true, side: THREE.DoubleSide, wind: 0.020,
        albedoTarget: 0x565a41, hue: 0.9 });
    m.cloth = this._material('cloth_olive',
      { vertexColors: true, side: THREE.DoubleSide, wind: 0.026 });
    m.sack = this._material('sandbag', W);
    m.rope = this._material('rope', W);
    m.rubber = this._material('rubber', W);
    m.stone = this._material('stone', W);
    m.pot = this._material('brick',
      { vertexColors: true, albedoTarget: 0x7d5238, hue: 0.9 });
    // The fungus is the one prop whose colour has to vary per instance rather
    // than per material, so it takes a MULTIPLY material and hueTint instead of
    // the wear mask - shelf fungus runs from bone white to liver brown on one
    // trunk and a single tint would print it as a row of identical stickers.
    // 0x8d8460, not 0xbdb28c.  A shelf fungus is PALE RELATIVE TO WET BARK,
    // which in this level's light means about 0.10 linear - the first value
    // was the albedo of dry paper and printed a row of white stickers up the
    // side of every fallen trunk in the frame.
    m.mould = this._material('plaster',
      { vertexColors: true, wearMode: 'multiply', albedoTarget: 0x8d8460 });
    m.glass = this._material('glass',
      { vertexColors: true, wearMode: 'multiply', envMapIntensity: 0.9 });

    // ---- borrowed from the level -------------------------------------------
    m.leaf = this._levelMaterial('blade');
    m.hang = this._levelMaterial('canopy');
    m.bark = this._levelMaterial('bark');
    m.mud = this._levelMaterial('mud');
    m.alu = this._levelMaterial('alu');
    if (!m.leaf) m.leaf = this._material('foliage',
      { vertexColors: true, wearMode: 'multiply', side: THREE.DoubleSide });
    if (!m.hang) m.hang = m.leaf;
    if (!m.bark) m.bark = this._material('wood_plank',
      { vertexColors: true, wearMode: 'multiply', albedoTarget: 0x4a4438 });
    if (!m.mud) m.mud = this._material('dirt',
      { vertexColors: true, wearMode: 'multiply', albedoTarget: 0x545f38 });
    if (!m.alu) m.alu = this._material('painted_metal',
      { vertexColors: true, wearMode: 'multiply' });

    // ---- our own two -------------------------------------------------------
    m.marks = new THREE.MeshStandardMaterial({
      map: this.tex.marks || null, color: 0xffffff,
      roughness: 0.90, metalness: 0.0,
      transparent: true, depthWrite: false, alphaTest: 0.03,
      vertexColors: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3
    });
    m.marks.name = 'jp_marks';
    m.board = new THREE.MeshStandardMaterial({
      map: this.tex.board || null, color: 0xffffff,
      roughness: 0.92, metalness: 0.0, vertexColors: true,
      side: THREE.DoubleSide
    });
    m.board.name = 'jp_board';
    // An ember is not a lamp.  It is 4 cm of glowing charcoal and its whole job
    // is to be the visible SOURCE sitting inside a practical the level already
    // published - a light with no visible source is not a light.
    m.ember = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(0x2a1206, THREE.SRGBColorSpace),
      emissive: new THREE.Color().setHex(0xff7a22, THREE.SRGBColorSpace),
      emissiveIntensity: 3.2, roughness: 0.62, metalness: 0.0,
      vertexColors: true, side: THREE.DoubleSide
    });
    m.ember.name = 'jp_ember';
    this._emberBase = 3.2;
  };

  // ----------------------------------------------------------------- layout --
  PropsJungle.prototype._probeLayout = function () {
    var L = this.ctx.level || null;
    this.L = L;
    var A = (L && L.anchors) || {};
    this.A = A;
    var D = A.delta || {};
    var self = this;

    if (D.x0 !== undefined) {
      this.bounds = { x0: D.x0, x1: D.x1, z0: D.z0, z1: D.z1 };
    }
    this.waterY = (D.waterY !== undefined) ? D.waterY : 0;
    if (D.wind && isFinite(D.wind.x)) {
      this.windDir.set(D.wind.x, D.wind.y);
    }

    // Every one of these is a function the level published; each gets a
    // constant fallback so a half-built level degrades into a flat delta
    // instead of throwing on the first placement.
    this.riverC = (typeof D.riverC === 'function') ? D.riverC : function () { return -30; };
    this.riverHalf = (typeof D.riverHalf === 'function') ? D.riverHalf : function () { return 11; };
    this.trackXf = (typeof D.trackX === 'function') ? D.trackX : function () { return 3; };
    this.skyOpenF = (typeof D.skyOpen === 'function') ? D.skyOpen : function () { return 0.4; };
    var C = A.creek || {};
    this.creekZf = (typeof C.centreZ === 'function') ? C.centreZ : function () { return 26; };
    this.creekHalf = C.half || 3.9;

    // The level's own standpoint clearance list.  Used in ONE direction only:
    // to keep props out of a place.  Nothing here ever derives a position from
    // it, and nothing reads level.cameraPoses at all.
    this.camMarks = [];
    try {
      var cm = L && L.plan && L.plan.camMarks;
      if (cm && cm.length) {
        for (var i = 0; i < cm.length; i++) {
          this.camMarks.push({ x: cm[i].x, z: cm[i].z, r: cm[i].r || 2.6 });
        }
      }
    } catch (e) { /* a level without a plan simply gets no exclusions */ }

    this.foliage = (L && L.foliage) || null;

    // Broadphase over the level's own colliders, so nothing is ever placed
    // inside a wall, a sandbag revetment or a tree.
    this.hash = new GAME.SpatialHash(4.0);
    this._qout = [];
    var cols = (L && L.colliders) || [];
    for (var c = 0; c < cols.length; c++) {
      var col = cols[c];
      if (!col || col.floor) continue;
      try {
        GAME.Collision.boxBounds(col, _bmin, _bmax);
        this.hash.insert(col, _bmin, _bmax);
      } catch (e2) { /* malformed collider - skip it, never throw */ }
    }

    // The firebase local frame, recovered from the anchor if the level
    // published its own helper and reconstructed from centre+yaw if not.
    var F = A.firebase;
    if (F && typeof F.local === 'function') {
      this.fbW = F.local;
    } else if (F && F.centre) {
      var fc = Math.cos(F.yaw || 0), fs = Math.sin(F.yaw || 0);
      var fx = F.centre.x, fz = F.centre.z;
      this.fbW = function (lx, lz) { return [fx + lx * fc + lz * fs, fz - lx * fs + lz * fc]; };
    } else {
      this.fbW = function (lx, lz) { return [11 + lx, -24 + lz]; };
    }
    void self;
  };

  // ------------------------------------------------------ placement queries --
  PropsJungle.prototype._ground = function (x, z) {
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
  // stand on a bunker floor, a platform, a deck or a helipad.
  PropsJungle.prototype._surfaceY = function (x, z, fromY, maxDist) {
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

  // SIT A PROP ON THE SURFACE, NOT ON THE TANGENT PLANE AT ITS CENTRE.
  //
  // The delta is all slope - the bank runs 20-35 degrees, the knoll 12, the
  // track is a 25 cm cut with a berm either side - and a 0.9 m crate dropped
  // level onto a 25 degree bank floats its downhill edge by 21 cm.  So the
  // gradient is measured ACROSS THE PROP'S OWN FOOTPRINT and returned as a
  // pitch and roll in the PROP'S frame (three's YXZ order means rz tips local
  // +X up and rx tips local +Z down, hence the sign on each), and the height
  // comes mostly from the LOWEST sample under that footprint - a prop bedded
  // into the low side is invisible, one hovering over it is the whole failure.
  var _st = { y: 0, rx: 0, rz: 0, slope: 0 };
  PropsJungle.prototype._settle = function (x, z, r, yaw, k) {
    var sr = Math.max(0.14, (r === undefined ? 0.4 : r) * 0.85);
    var y = this._ground(x, z);
    var ya = this._ground(x + sr, z), yb = this._ground(x - sr, z);
    var yc = this._ground(x, z + sr), yd = this._ground(x, z - sr);
    var gx = (ya - yb) / (2 * sr);
    var gz = (yc - yd) / (2 * sr);
    var c = Math.cos(yaw || 0), s = Math.sin(yaw || 0);
    var lgx = gx * c - gz * s;
    var lgz = gx * s + gz * c;
    var slope = Math.sqrt(gx * gx + gz * gz);
    k = k === undefined ? 0.85 : k;
    // Roll the tilt off on extreme gradients: the track cut and the creek lip
    // are near-vertical steps, and a footprint straddling one measures a
    // gradient of three.  A prop on a step sits on the step; it does not adopt
    // the tangent plane of the step.
    var kk = k / (1 + slope * 1.15);
    _st.rz = M.clamp(Math.atan(lgx) * kk, -0.42, 0.42);
    _st.rx = M.clamp(-Math.atan(lgz) * kk, -0.42, 0.42);
    _st.slope = slope;
    var ymin = Math.min(y, Math.min(ya, yb), Math.min(yc, yd));
    _st.y = ymin + (y - ymin) * 0.32 - 0.010;
    return _st;
  };

  // How CONCAVE is the ground here?  Positive means a hollow, which is where
  // water stands, leaves drift and everything that rolls ends up.  This is what
  // makes the forest litter deposition rather than scatter.
  PropsJungle.prototype._concavity = function (x, z, r) {
    r = r || 1.2;
    var c = this._ground(x, z);
    var s = 0;
    for (var i = 0; i < 6; i++) {
      var a = i / 6 * Math.PI * 2;
      s += this._ground(x + Math.cos(a) * r, z + Math.sin(a) * r);
    }
    return (s / 6) - c;
  };

  // Which way is uphill?  Deadfall piles against the UPHILL face of whatever
  // stopped it, never the downhill one.
  PropsJungle.prototype._uphill = function (x, z, out) {
    var d = 1.0;
    var gx = this._ground(x + d, z) - this._ground(x - d, z);
    var gz = this._ground(x, z + d) - this._ground(x, z - d);
    var l = Math.sqrt(gx * gx + gz * gz) || 1;
    out = out || { x: 0, z: 0 };
    out.x = gx / l; out.z = gz / l;
    return out;
  };

  PropsJungle.prototype._blocked = function (x, y, z, r) {
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

  PropsJungle.prototype._occupied = function (x, z, r) {
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
  PropsJungle.prototype._occupy = function (x, z, r) {
    var cs = 3;
    var k = Math.floor(x / cs) * 73856093 ^ Math.floor(z / cs) * 19349663;
    var l = this._occ.get(k);
    if (!l) { l = []; this._occ.set(k, l); }
    l.push(x, z, r);
  };

  PropsJungle.prototype._inBounds = function (x, z, pad) {
    var b = this.bounds;
    pad = pad || 0;
    return x > b.x0 + pad && x < b.x1 - pad && z > b.z0 + pad && z < b.z1 - pad;
  };

  // Signed distance from the river centreline, in half-widths.  Under 1 is
  // open water; 1 to 1.25 is the mud shelf that is under water half the time.
  PropsJungle.prototype._riverA = function (x, z) {
    var rc = this.riverC(z), rh = this.riverHalf(z) || 1;
    return Math.abs(x - rc) / rh;
  };
  PropsJungle.prototype._inWater = function (x, z, pad) {
    if (this._riverA(x, z) < 1 + (pad || 0)) return true;
    var cd = Math.abs(z - this.creekZf(x));
    return (x > this.riverC(z) && cd < this.creekHalf * (1 + (pad || 0)) &&
      this._ground(x, z) < this.waterY - 0.10);
  };
  // Is this spot on the carriageway?  Standing props are kept off it - it is
  // the one surface in the level somebody drives on.
  //
  // THE CLAMP AT THE END OF THE TRACK IS A TRAP, and it cost most of the
  // firebase dressing on the first build.  level_jungle's trackX() is a
  // polyline that ENDS at (11, -18) and returns the last point's x for every z
  // beyond it - so at the firebase, which is centred on x = 11, this test
  // reported a 4 m wide road running straight through the middle of the base.
  // The fire ring, the fuel point and half the stores were all rejected by a
  // road that stops at the gate.  Inside the wire there is no track.
  PropsJungle.prototype._onTrack = function (x, z, half) {
    var F = this.A && this.A.firebase;
    if (F && F.centre) {
      var dx = x - F.centre.x, dz = z - F.centre.z;
      if (dx * dx + dz * dz < (F.radius || 17) * (F.radius || 17)) return false;
    }
    var P = this.A && this.A.track && this.A.track.pts;
    if (P && P.length) {
      // beyond either end of the polyline there is no carriageway at all
      if (z > P[0][1] + 2 || z < P[P.length - 1][1] - 2) return false;
    }
    return Math.abs(x - this.trackXf(z)) < (half === undefined ? 2.45 : half);
  };
  PropsJungle.prototype._nearCam = function (x, z, extra) {
    for (var i = 0; i < this.camMarks.length; i++) {
      var c = this.camMarks[i];
      var dx = x - c.x, dz = z - c.z;
      var rr = c.r + (extra || 0);
      if (dx * dx + dz * dz < rr * rr) return true;
    }
    return false;
  };

  // The one call most placements go through.
  //   opts: { r, clearR, settleR, yaw, scale, sx/sy/sz, tilt, sink, y, colour,
  //           collider:[hx,hy,hz], material, onTrack, inWater, camOK, k }
  // Returns the height it settled at, or null if the site was rejected.
  PropsJungle.prototype._drop = function (batch, x, z, opts) {
    if (!batch || !batch.add) return null;
    opts = opts || {};
    var r = opts.r === undefined ? 0.42 : opts.r;
    var W = this._why;
    if (!this._inBounds(x, z, 0.5)) { this._skipped++; W.bounds++; return null; }
    if (!opts.onTrack && this._onTrack(x, z, 2.1)) { this._skipped++; W.track++; return null; }
    if (!opts.inWater && this._inWater(x, z, -0.02)) { this._skipped++; W.water++; return null; }
    if (!opts.camOK && this._nearCam(x, z, 0)) { this._skipped++; W.cam++; return null; }
    if (!opts.noOcc && this._occupied(x, z, r)) { this._skipped++; W.occ++; return null; }
    var yaw = opts.yaw === undefined ? this.rng.range(0, Math.PI * 2) : opts.yaw;
    var sc = opts.scale === undefined ? 1 : opts.scale;
    var y, prx = 0, prz = 0;
    if (opts.y === undefined) {
      var st = this._settle(x, z, Math.max(r, opts.settleR || 0) * sc, yaw, opts.k);
      y = st.y; prx = st.rx; prz = st.rz;
    } else { y = opts.y; }
    var cr = opts.clearR === undefined ? r * 0.70 : opts.clearR;
    if (!opts.noBlock && this._blocked(x, y + (opts.h || 0.4) * 0.5, z, cr)) {
      this._skipped++; W.solid++; return null;
    }
    var tilt = opts.tilt === undefined ? 0.035 : opts.tilt;
    var ok = batch.add(
      T(x, y - (opts.sink || 0), z,
        prx + this.rng.gaussian(0, tilt), yaw, prz + this.rng.gaussian(0, tilt),
        sc * (opts.sx || 1), sc * (opts.sy || 1), sc * (opts.sz || 1)),
      opts.colour || wearTint(this.rng));
    if (!ok) return null;
    if (!opts.noOcc) this._occupy(x, z, r);
    if (opts.collider) this._collider(x, y, z, opts.collider, yaw, opts.material);
    return y;
  };

  PropsJungle.prototype._collider = function (x, y, z, he, yaw, material) {
    _eu.set(0, yaw || 0, 0, 'YXZ');
    this.colliders.push({
      type: 'box',
      center: new THREE.Vector3(x, y + he[1], z),
      halfExtents: new THREE.Vector3(he[0], he[1], he[2]),
      quaternion: new THREE.Quaternion().setFromEuler(_eu),
      material: material || 'wood'
    });
  };

  PropsJungle.prototype._static = function (key, geometry, matrix) {
    if (!geometry) return;
    var arr = this.S[key];
    if (!arr) arr = this.S[key] = [];
    arr.push(part(geometry, matrix));
  };

  // A ground mark from the atlas, lying on the surface and following it.
  PropsJungle.prototype._mark = function (cell, x, z, w, d, yaw, colour, y) {
    if (this._markCount > 900) return;
    var uv = markUV(cell);
    var g = flatGeo(w, d, uv[0], uv[1], uv[2], uv[3]);
    var st = this._settle(x, z, Math.max(w, d) * 0.5, yaw || 0, 1.0);
    var mt = Tn(x, (y === undefined ? st.y + 0.014 : y), z, st.rx, yaw || 0, st.rz);
    var p = part(g, mt);
    p.tintColour = colour || null;
    this.S.marks.push(p);
    this._markCount++;
  };

  // A mark on a VERTICAL face - rust runoff below a bracket, a bilge stain down
  // a hull.  Same atlas, different orientation, and the reason the atlas has a
  // streak cell at all.
  PropsJungle.prototype._markWall = function (cell, x, y, z, w, h, yaw, colour) {
    if (this._markCount > 900) return;
    var uv = markUV(cell);
    var g = cardGeo(w, h, uv[0], uv[1], uv[2], uv[3]);
    var p = part(g, Tn(x, y, z, 0, yaw || 0, 0));
    p.tintColour = colour || null;
    this.S.marks.push(p);
    this._markCount++;
  };

  // A run of trodden ground between two points.  Wear follows the walking
  // lines, and the walking lines in a firebase are short, straight and obvious:
  // gate to fire, fire to bunker, bunker to pad, landing to bridge.
  PropsJungle.prototype._path = function (ax, az, bx, bz, w, n) {
    var R = this.rng;
    n = n || 8;
    for (var i = 0; i < n; i++) {
      var t = (i + 0.5) / n;
      var x = ax + (bx - ax) * t + R.gaussian(0, 0.22);
      var z = az + (bz - az) * t + R.gaussian(0, 0.22);
      if (!this._inBounds(x, z, 1)) continue;
      if (this._inWater(x, z, 0)) continue;
      this._mark(MARK.trample, x, z, w * R.range(0.8, 1.25), w * R.range(0.8, 1.25),
        R.range(0, Math.PI * 2),
        new THREE.Color(R.range(0.8, 1.1), R.range(0.85, 1.1), R.range(0.75, 1.0)));
    }
  };

  // ------------------------------------------------------------------- kit --
  PropsJungle.prototype._batch = function (key, geo, matName, cap, cast) {
    if (!geo) return null;
    var mat = this.mats[matName] || this.mats.wood;
    var b = new Batch(geo, mat, cap, cast);
    this.B[key] = b;
    return b;
  };

  PropsJungle.prototype._finishGeo = function (geo, wear) {
    if (!geo) return null;
    Geo.copyUV1(geo);
    paintWear(geo, wear || { noise: this.noise });
    geo.computeBoundingSphere();
    return geo;
  };
  PropsJungle.prototype._finishTinted = function (geo, tint) {
    if (!geo) return null;
    Geo.copyUV1(geo);
    paintTint(geo, tint || { noise: this.noise });
    geo.computeBoundingSphere();
    return geo;
  };

  PropsJungle.prototype._buildKit = function () {
    var R = this.rng, N = this.noise;
    var self = this;
    function W(o) { o = o || {}; o.noise = N; return o; }

    this._batch('crate', this._finishGeo(K.crate(R, N, false), W({ hiY: 0.45 })), 'wood', 200);
    this._batch('crateB', this._finishGeo(K.crate(R, N, true), W({ hiY: 0.45, edge: 0.34 })), 'wood', 120);
    this._batch('crateOpen', this._finishGeo(K.crateOpen(R), W({ hiY: 0.45, edge: 0.30 })), 'wood', 40);
    this._batch('ammoCan', this._finishGeo(K.ammoCan(R, false), W({ hiY: 0.22 })), 'olive', 200);
    this._batch('ammoOpen', this._finishGeo(K.ammoCan(R, true), W({ hiY: 0.22 })), 'olive', 40);
    this._batch('drum', this._finishGeo(K.drum(R, N, 'closed'), W({ hiY: 0.9, grime: 0.36 })), 'rust', 90);
    this._batch('drumOpen', this._finishGeo(K.drum(R, N, 'open'), W({ hiY: 0.9, grime: 0.42 })), 'rust', 40);
    this._batch('jerry', this._finishGeo(K.jerry(R), W({ hiY: 0.5 })), 'olive', 90);
    this._batch('tins', this._finishGeo(K.tins(R), W({ hiY: 0.10, grime: 0.44, edge: 0.34 })), 'rust', 380);
    this._batch('bottles', this._finishTinted(K.bottles(R), { noise: N, base: [0.72, 0.86, 0.66], spread: 0.22 }), 'glass', 90, false);
    this._batch('helmet', this._finishGeo(K.helmet(R, N), W({ hiY: 0.26 })), 'olive', 40);
    this._batch('sack', this._finishGeo(K.sandbag(R, N), W({ hiY: 0.28, grime: 0.40, growth: 0.34 })), 'sack', 420);
    this._batch('basket', this._finishGeo(K.basket(R), W({ hiY: 0.35 })), 'bamboo', 60);
    this._batch('trap', this._finishGeo(K.fishTrap(R), W({ hiY: 0.95, wet: 0.72 })), 'bamboo', 50);
    this._batch('jar', this._finishGeo(K.jar(R, N), W({ hiY: 0.48 })), 'pot', 50);
    this._batch('pole', this._finishGeo(K.pole(R, 2.6), W({ hiY: 2.6, grime: 0.22 })), 'bamboo', 220);
    this._batch('branch', this._finishTinted(K.branch(R, N, 1.0), { noise: N, base: [0.86, 0.84, 0.74], spread: 0.24 }), 'bark', 560);
    this._batch('branchS', this._finishTinted(K.branch(R, N, 0.6), { noise: N, base: [0.92, 0.88, 0.76], spread: 0.26 }), 'bark', 420);
    this._batch('rock', this._finishGeo(K.rock(R, N, 1.0), W({ hiY: 0.42, growth: 0.40 })), 'stone', 380);
    this._batch('fungus', this._finishTinted(K.fungus(R), { noise: N, base: [1, 1, 1], spread: 0.18, lift: 0.22 }), 'mould', 460, false);
    this._batch('termite', this._finishTinted(K.termite(R, N), { noise: N, base: [1.06, 0.96, 0.78], spread: 0.20 }), 'mud', 70);
    this._batch('stake', this._finishGeo(K.stake(R, 1.05), W({ hiY: 1.0 })), 'bamboo', 300);
    this._batch('spool', this._finishGeo(K.spool(R), W({ hiY: 0.8 })), 'wood', 24);
    this._batch('mortar', this._finishGeo(K.mortarTube(R), W({ hiY: 0.62 })), 'olive', 80);
    this._batch('tyre', this._finishGeo(K.tyre(R, N), W({ hiY: 0.9, grime: 0.44 })), 'rubber', 30);
    this._batch('husk', this._finishTinted(K.husk(R), { noise: N, base: [0.90, 0.82, 0.66], spread: 0.24 }), 'bark', 280);
    this._batch('wire', this._finishGeo(K.wireCoil(R), W({ hiY: 0.2, grime: 0.40 })), 'rust', 40);
    this._batch('bucket', this._finishGeo(K.bucket(), W({ hiY: 0.3 })), 'steel', 30);
    this._batch('canteen', this._finishGeo(K.canteen(), W({ hiY: 0.22 })), 'olive', 40);
    this._batch('boots', this._finishGeo(K.boots(R), W({ hiY: 0.24, grime: 0.52 })), 'rubber', 30);
    this._batch('shovel', this._finishGeo(K.shovel(), W({ hiY: 1.0 })), 'wood', 24);

    // ---- the green, grown from the LEVEL'S OWN generators --------------------
    var F = this.foliage;
    if (F && typeof F.fernPlant === 'function') {
      this._batch('fernP', this._finishTinted(F.fernPlant(R, 0.62),
        { noise: N, base: [0.92, 1.04, 0.78], spread: 0.24 }), 'leaf', 320, false);
    }
    if (F && typeof F.grassClump === 'function') {
      this._batch('tuft', this._finishTinted(F.grassClump(R, 0.44, 8),
        { noise: N, base: [0.98, 1.06, 0.74], spread: 0.26 }), 'leaf', 420, false);
    }
    // Water hyacinth: the mat of floating weed that is on every slow delta
    // reach.  It is the one thing that makes the river read as a LIVE surface
    // with a current rather than as a mirror laid on the mud.
    if (F && typeof F.blade === 'function') {
      var parts = [];
      var nb = 9;
      for (var i = 0; i < nb; i++) {
        var a = (i / nb) * Math.PI * 2 + R.range(-0.2, 0.2);
        var ln = R.range(0.16, 0.30);
        var g = F.blade(ln, ln * 0.42, ln * 0.30, 0, 0.6, 4, 1);
        parts.push(part(g, Tn(Math.cos(a) * 0.05, 0, Math.sin(a) * 0.05,
          R.range(0.55, 1.05), -a, 0)));
      }
      var hy = mergeParts(parts, 0);
      disposeParts(parts);
      this._batch('hyacinth', this._finishTinted(hy,
        { noise: N, base: [0.84, 1.10, 0.66], spread: 0.28 }), 'leaf', 340, false);
    }
    void self;
  };

  // A leaf sprig grown from the level's own blade generator, in WORLD space,
  // for the vines that are reclaiming the wreck and the sluice.
  PropsJungle.prototype._sprig = function (x, y, z, yaw, pitch, scale) {
    var F = this.foliage;
    if (!F || typeof F.blade !== 'function') return;
    var R = this.rng;
    var n = R.int(3, 5);
    for (var i = 0; i < n; i++) {
      var ln = R.range(0.13, 0.26) * scale;
      var g = F.blade(ln, ln * 0.46, ln * 0.35, ln * R.range(-0.1, 0.1), 0.6, 4, 1);
      var a = yaw + (i / n) * Math.PI * 2 * 0.6 + R.range(-0.3, 0.3);
      this._static('leaf', g, Tn(x + Math.sin(a) * 0.03, y, z + Math.cos(a) * 0.03,
        pitch + R.range(-0.4, 0.4), a, R.range(-0.3, 0.3)));
    }
  };

  // A vine: a woody tube from `a` to `b` with a sag, leaves along it.  This is
  // how growth reclaims a hard object - it does not sit ON it, it runs OVER it
  // and hangs off the far side.
  PropsJungle.prototype._vine = function (ax, ay, az, bx, by, bz, sag, r, leaves) {
    var st = sagStations(ax, ay, az, bx, by, bz, sag, r || 0.028, 7);
    this._static('vine', tubePath(st, 5), null);
    var R = this.rng;
    var n = leaves === undefined ? 5 : leaves;
    for (var i = 0; i < n; i++) {
      var t = (i + 0.5) / n;
      var k = Math.floor(t * (st.length - 1));
      var s = st[k];
      this._sprig(s[0], s[1] - 0.02, s[2], R.range(0, Math.PI * 2),
        R.range(-1.1, -0.2), R.range(0.8, 1.3));
    }
  };

  // ==========================================================================
  // THE FIREBASE
  //
  // Eight sites, and every one of them is a REASON rather than a decoration:
  // the ammunition point inside its own horseshoe of bags, the fuel and water
  // point where the ground is flattest, the fire that everyone sits round, the
  // burn pit downwind of it, the comms stores at the foot of the mast, the
  // gate, the pad, and the fighting positions round the wire.  Laid out this
  // way the OVERVIEW framing - which looks straight down on all of it from the
  // tower - reads as a place somebody organised, which is the only thing that
  // separates a base from a scatter of boxes.
  // ==========================================================================
  PropsJungle.prototype._dressFirebase = function () {
    var A = this.A, R = this.rng, B = this.B;
    var F = A && A.firebase;
    if (!F || !F.centre) return;
    var built = (this.L && this.L.builtFirebase) || null;
    var W = this.fbW;
    var i, p, y;
    var yawBase = F.yaw || 0;
    this.stats.sites += 8;

    // ---- 1 : the ammunition point -----------------------------------------
    // Inside the low horseshoe the level revetted for it, stacked two high on
    // dunnage, with a tarp over the half somebody bothered to cover.
    var ap = (built && built.ammo) ? [built.ammo.x, built.ammo.z] : W(9.6, -0.5);
    var apY = this._ground(ap[0], ap[1]);
    // dunnage first - ammunition never sits on wet ground
    for (i = -1; i <= 1; i += 2) {
      this._static('wood', box(2.6, 0.09, 0.16, 0.01),
        Tn(ap[0] + Math.sin(yawBase + 1.57) * i * 0.5, apY + 0.045,
          ap[1] + Math.cos(yawBase + 1.57) * i * 0.5, 0, yawBase, 0));
    }
    for (i = 0; i < 6; i++) {
      var col = i % 3, row = (i / 3) | 0;
      var lx = -0.9 + col * 0.92, lz = -0.30 + row * 0.60;
      p = [ap[0] + lx * Math.cos(yawBase) + lz * Math.sin(yawBase),
        ap[1] - lx * Math.sin(yawBase) + lz * Math.cos(yawBase)];
      // noOcc, deliberately: this is a STACK, and the keep-apart radius that
      // stops random clutter interpenetrating is exactly the thing that turns
      // an authored stack into two crates and four rejections.  The positions
      // here are solved, not sampled, so there is nothing to keep apart from.
      y = this._drop(B.crate, p[0], p[1], {
        r: 0.30, yaw: yawBase + R.gaussian(0, 0.06), y: apY + 0.09,
        tilt: 0.012, h: 0.4, noOcc: true, collider: [0.46, 0.20, 0.26],
        material: 'wood'
      });
      this._occupy(p[0], p[1], 0.30);
      // the second course, short of the top row so it reads as a stack being
      // worked down rather than as a wall
      if (y !== null && i < 4 && R.bool(0.8)) {
        this._drop(R.bool(0.7) ? B.crate : B.crateB, p[0] + R.gaussian(0, 0.04),
          p[1] + R.gaussian(0, 0.04), {
            r: 0.30, yaw: yawBase + R.gaussian(0, 0.10), y: y + 0.40,
            tilt: 0.02, noOcc: true, noBlock: true
          });
      }
    }
    p = [ap[0] + 1.35 * Math.cos(yawBase) - 0.9 * Math.sin(yawBase),
      ap[1] + 1.35 * Math.sin(yawBase) - 0.9 * Math.cos(yawBase)];
    this._drop(B.crateOpen, p[0], p[1], { r: 0.6, yaw: yawBase + 0.7, y: apY + 0.02 });
    // mortar bombs still in their tubes, leaning on the revetment
    for (i = 0; i < 5; i++) {
      var ma = -0.9 + i * 0.34;
      p = [ap[0] + Math.sin(ma) * 1.95, ap[1] + Math.cos(ma) * 1.95];
      this._drop(B.mortar, p[0], p[1], {
        r: 0.14, yaw: R.range(0, 6.28), tilt: 0.0, k: 0.4,
        sx: 1, sy: 1, sz: 1, noBlock: true
      });
    }
    for (i = 0; i < 4; i++) {
      p = [ap[0] + R.gaussian(0, 1.1), ap[1] + R.gaussian(0, 1.1)];
      this._drop(i < 2 ? B.ammoCan : B.ammoOpen, p[0], p[1],
        { r: 0.24, yaw: R.range(0, 6.28), tilt: 0.05 });
    }
    // the tarp: four bamboo legs and a sagging sheet with the wind in it
    var tp = [ap[0] - 0.9 * Math.cos(yawBase), ap[1] + 0.9 * Math.sin(yawBase)];
    this._tarp(tp[0], tp[1], yawBase, 2.4, 1.9, apY);

    // ---- 2 : the fuel and water point --------------------------------------
    var fp = W(-3.2, 8.6);
    var fpY = this._ground(fp[0], fp[1]);
    this._static('wood', box(2.2, 0.10, 1.1, 0.012), Tn(fp[0], fpY + 0.05, fp[1], 0, yawBase + 0.3, 0));
    for (i = 0; i < 3; i++) {
      p = [fp[0] + Math.sin(yawBase + 0.3) * (-0.72 + i * 0.72),
        fp[1] + Math.cos(yawBase + 0.3) * (-0.72 + i * 0.72)];
      this._drop(B.drum, p[0], p[1], {
        r: 0.30, yaw: R.range(0, 6.28), y: fpY + 0.10, tilt: 0.01, h: 0.88,
        noOcc: true, collider: [0.30, 0.44, 0.30], material: 'metal'
      });
      this._occupy(p[0], p[1], 0.30);
    }
    // two on their sides, rolled off the dunnage and chocked
    for (i = 0; i < 2; i++) {
      p = [fp[0] + 1.9 + i * 0.72, fp[1] - 1.3 + R.range(-0.2, 0.2)];
      var st = this._settle(p[0], p[1], 0.5, yawBase);
      if (B.drum) {
        B.drum.add(T(p[0], st.y + 0.29, p[1],
          st.rx + Math.PI * 0.5, yawBase + 0.9 + R.range(-0.2, 0.2), st.rz,
          1, 1, 1), wearTint(R));
        this._occupy(p[0], p[1], 0.5);
        this._collider(p[0], st.y, p[1], [0.46, 0.29, 0.30], yawBase + 0.9, 'metal');
      }
      this._mark(MARK.oil, p[0] + 0.2, p[1] + 0.3, 1.5, 1.4, R.range(0, 6.28));
    }
    this._drop(B.drumOpen, fp[0] - 1.5, fp[1] + 0.9, { r: 0.36, y: fpY + 0.02 });
    // A ROW of cans, and a row is 42 cm of can plus 16 cm of gap - so the
    // keep-apart radius has to come off too, or every second one is rejected
    // by the one before it and the row photographs as three cans and a hole.
    for (i = 0; i < 5; i++) {
      p = [fp[0] - 1.2 + i * 0.44 * Math.cos(yawBase),
        fp[1] + 1.7 - i * 0.44 * Math.sin(yawBase)];
      this._drop(B.jerry, p[0], p[1], {
        r: 0.20, yaw: yawBase + 1.57 + R.gaussian(0, 0.12), noOcc: true
      });
      this._occupy(p[0], p[1], 0.20);
    }
    this._drop(B.bucket, fp[0] + 0.6, fp[1] + 1.5, { r: 0.2 });
    this._drop(B.wire, fp[0] - 2.1, fp[1] - 0.6, { r: 0.3 });
    this._mark(MARK.oil, fp[0], fp[1] + 0.2, 2.6, 2.2, R.range(0, 6.28));
    // the shower: a drum on three bamboo legs with a pipe under it
    this._shower(fp[0] + 2.9, fp[1] + 2.3, yawBase + 0.8);

    // ---- 3 : the fire, and what lives round it -----------------------------
    var dr = (built && built.drum) ? [built.drum.x, built.drum.z] : W(-1.6, 2.6);
    var drY = this._ground(dr[0], dr[1]);
    for (i = 0; i < 7; i++) {
      var sa = (i / 7) * Math.PI * 2 + 0.4;
      var sr = R.range(1.35, 1.75);
      p = [dr[0] + Math.sin(sa) * sr, dr[1] + Math.cos(sa) * sr];
      if (i === 2 || i === 5) {
        this._drop(B.crate, p[0], p[1], { r: 0.55, yaw: sa + 1.57 + R.gaussian(0, 0.2),
          collider: [0.46, 0.20, 0.26], material: 'wood', h: 0.4 });
      } else {
        this._drop(B.sack, p[0], p[1], { r: 0.34, yaw: sa + 1.57 + R.gaussian(0, 0.25), tilt: 0.06 });
      }
    }
    for (i = 0; i < 5; i++) {
      p = [dr[0] + R.gaussian(0, 1.5), dr[1] + R.gaussian(0, 1.5)];
      this._drop(i < 3 ? B.tins : B.bottles, p[0], p[1], { r: 0.20, tilt: 0.09 });
    }
    // embers in the drum: the level published the practical, this is the thing
    // that is actually burning inside it
    for (i = 0; i < 5; i++) {
      var ea = R.range(0, 6.28), er = R.range(0.02, 0.17);
      this._static('ember', sph(R.range(0.028, 0.055), 6, 4),
        Tn(dr[0] + Math.cos(ea) * er, drY + 0.86 + R.range(0, 0.05), dr[1] + Math.sin(ea) * er));
    }
    for (i = 0; i < 4; i++) {
      this._static('vine', tubePath([[dr[0] + R.range(-0.2, 0.2), drY + 0.84, dr[1] + R.range(-0.2, 0.2), 0.022],
        [dr[0] + R.range(-0.3, 0.3), drY + 1.02, dr[1] + R.range(-0.3, 0.3), 0.014]], 4), null);
    }
    this._mark(MARK.ash, dr[0], dr[1], 2.3, 2.3, R.range(0, 6.28));

    // The billet: a poncho lean-to over a cot, and the laundry line.
    //
    // Sited in the firebase's LOCAL frame, not by adding a world offset to the
    // shelter anchor.  The base is turned 15 degrees off world north, so "2.6
    // east of the shelter" is not 2.6 along the row the shelter is in - it put
    // the whole billet inside the command bunker, whose walls the static half
    // of this prop does not test against.
    var bl = W(-13.0, -8.5);
    this._billet(bl[0], bl[1], yawBase + 1.1);

    // ---- 4 : the burn pit, downwind ----------------------------------------
    var bp = W(7.4, 10.2);
    var bpY = this._ground(bp[0], bp[1]);
    this._mark(MARK.ash, bp[0], bp[1], 3.1, 2.8, R.range(0, 6.28));
    this._drop(B.drumOpen, bp[0] + 1.5, bp[1] - 0.5, { r: 0.36, tilt: 0.06 });
    for (i = 0; i < 6; i++) {
      p = [bp[0] + R.gaussian(0, 0.9), bp[1] + R.gaussian(0, 0.9)];
      this._drop(B.tins, p[0], p[1], { r: 0.16, tilt: 0.12,
        colour: new THREE.Color(0.42, 0.9, 0.5) });
    }
    for (i = 0; i < 4; i++) {
      p = [bp[0] + R.gaussian(0, 1.3), bp[1] + R.gaussian(0, 1.3)];
      this._drop(B.branchS, p[0], p[1], { r: 0.3, tilt: 0.10,
        colour: new THREE.Color(0.34, 0.34, 0.32) });
    }
    this._drop(B.shovel, bp[0] - 1.6, bp[1] + 0.9,
      { r: 0.3, yaw: R.range(0, 6.28), tilt: 0.0, k: 0.2, sy: 1, noBlock: true,
        noOcc: true });
    void bpY;

    // ---- 5 : the comms stores at the foot of the mast ----------------------
    var ms = F.mast ? [F.mast.x, F.mast.z] : W(10.2, -7.4);
    this._drop(B.spool, ms[0] + 1.9, ms[1] + 1.2,
      { r: 0.5, yaw: R.range(0, 6.28), collider: [0.44, 0.42, 0.22], material: 'wood' });
    this._drop(B.wire, ms[0] + 2.6, ms[1] - 0.4, { r: 0.3 });
    this._drop(B.wire, ms[0] + 1.1, ms[1] - 1.5, { r: 0.3 });
    var cp = [ms[0] - 1.6, ms[1] + 1.0];
    var cpY = this._drop(B.crate, cp[0], cp[1], { r: 0.55, yaw: R.range(0, 6.28) });
    if (cpY !== null) {
      var rg = K.radio(R);
      this._finishGeo(rg, { noise: this.noise, hiY: 0.4, grime: 0.34 });
      this._static('olive', rg, Tn(cp[0], cpY + 0.40, cp[1], 0, R.range(0, 6.28), 0));
    }

    // ---- 6 : the gate ------------------------------------------------------
    if (F.gate) {
      var gx = F.gate.x, gz = F.gate.z;
      var gYaw = Math.atan2(F.centre.x - gx, F.centre.z - gz);
      // Inside the wire beside the gateway, not out on the wall line: at 3.6 m
      // abeam the gate the sign posts land in the 17.4 m revetment ring, and a
      // sign is a static so it would have been erected through it.
      this._sign(gx + Math.sin(gYaw) * 1.5 - Math.cos(gYaw) * 2.6,
        gz + Math.cos(gYaw) * 1.5 + Math.sin(gYaw) * 2.6, gYaw + 0.15);
      // INSIDE the wire, not in the gateway.  Two rounds of this prop were
      // rejected in silence: first by the gate posts (2.4 m out on this axis,
      // 18 cm colliders), then by the revetment itself, whose 0.62 m half-depth
      // plus the tyre's own clearance reaches 1 m either side of a wall that
      // the gate gap is only 0.19 rad wide.  Three metres in and 1.4 aside
      // clears both, and a tyre that lives inside the gate is where a tyre
      // actually is - it is a chock and a step, not a bollard.
      this._drop(B.tyre,
        gx + Math.sin(gYaw) * 3.0 + Math.cos(gYaw) * 1.4,
        gz + Math.cos(gYaw) * 3.0 - Math.sin(gYaw) * 1.4,
        { r: 0.55, yaw: R.range(0, 6.28), onTrack: true, tilt: 0.04 });
      for (i = 0; i < 5; i++) {
        p = [gx + R.gaussian(0, 1.8), gz + R.gaussian(0, 1.8)];
        if (this._onTrack(p[0], p[1], 1.4)) continue;
        this._drop(B.sack, p[0], p[1], { r: 0.32, tilt: 0.10 });
      }
      this._path(gx, gz, dr[0], dr[1], 1.5, 10);
    }

    // ---- 7 : the pad ------------------------------------------------------
    if (F.helipad && F.helipad.centre) {
      var hc = F.helipad.centre, hr = F.helipad.r || 6.4;
      var ha = (F.helipad.yaw || 0) + 2.1;
      var hx = hc.x + Math.sin(ha) * (hr + 1.3), hz = hc.z + Math.cos(ha) * (hr + 1.3);
      for (i = 0; i < 3; i++) {
        this._drop(B.crate, hx + R.gaussian(0, 0.7), hz + R.gaussian(0, 0.7),
          { r: 0.55, yaw: R.range(0, 6.28), collider: [0.46, 0.20, 0.26], material: 'wood' });
      }
      this._stretcher(hx + 1.6, hz - 1.2, ha + 1.2);
      this._drop(B.ammoCan, hx - 1.1, hz + 0.9, { r: 0.24 });
      this._path(hc.x, hc.z, dr[0], dr[1], 1.4, 9);
    }

    // ---- 8 : the fighting positions ----------------------------------------
    // A perimeter with nothing behind it is a fence.  Every third bay gets the
    // kit of a position somebody stands in: a can of link, two spare bags, and
    // the litter of a night on stag.
    var per = (built && built.perimeter) || null;
    var nper = per ? per.length : 18;
    for (i = 0; i < nper; i += 3) {
      var bx, bz, ba;
      if (per) { bx = per[i].x; bz = per[i].z; ba = per[i].yaw; }
      else {
        ba = (i / nper) * Math.PI * 2 - Math.PI;
        bx = F.centre.x + Math.sin(ba) * F.radius;
        bz = F.centre.z + Math.cos(ba) * F.radius;
      }
      var ix = F.centre.x - bx, iz = F.centre.z - bz;
      var il = Math.sqrt(ix * ix + iz * iz) || 1;
      ix /= il; iz /= il;
      this._drop(B.ammoCan, bx + ix * 1.5 + R.gaussian(0, 0.2),
        bz + iz * 1.5 + R.gaussian(0, 0.2), { r: 0.26, yaw: ba + R.gaussian(0, 0.3) });
      if (R.bool(0.6)) {
        this._drop(B.sack, bx + ix * 1.9 + R.gaussian(0, 0.3),
          bz + iz * 1.9 + R.gaussian(0, 0.3), { r: 0.32, yaw: ba + 1.57, tilt: 0.08 });
      }
      if (R.bool(0.5)) {
        this._drop(B.tins, bx + ix * 2.3 + R.gaussian(0, 0.4),
          bz + iz * 2.3 + R.gaussian(0, 0.4), { r: 0.18, tilt: 0.10 });
      }
    }

    // ---- 9 : the stores dump ------------------------------------------------
    // Between the pad and the mast: off the landing area, out of the bunker
    // doorway, on the flattest ground on the knoll.  It is also the ONE piece
    // of man-made mass in hero3's middle distance - that framing is a tower at
    // 19 m with nothing between it and the lens, and a frame with an empty
    // middle third has no depth cue at all.
    //
    // Local (7.9, -4.8), not (2.0, -1.0).  The first site was solved for
    // distance and forgot the VIEWMODEL: 12 m dead on the hero3 axis puts a
    // prop behind the player's own rifle, which occupies the entire lower
    // centre-right of the frame.  This one sits 26 degrees to the left of that
    // axis, which is the widest part of the frame that is not gun.
    var dp2 = W(7.9, -4.8);
    this._dump(dp2[0], dp2[1], yawBase + 0.42, 'mil');
    this._path(dp2[0], dp2[1], dr[0], dr[1], 1.4, 8);
  };

  // A tarpaulin on four bamboo legs, sagging between them and with one corner
  // untied - the corner is the whole prop, because a taut sheet reads as a
  // solid and a loose one reads as cloth.
  PropsJungle.prototype._tarp = function (x, z, yaw, w, d, y) {
    var R = this.rng;
    var h = 1.05;
    var c = Math.cos(yaw), s = Math.sin(yaw);
    var i;
    var sheetY = (y === undefined ? this._ground(x, z) : y) + h;
    for (i = 0; i < 4; i++) {
      var lx = ((i & 1) ? 1 : -1) * w * 0.5;
      var lz = ((i & 2) ? 1 : -1) * d * 0.5;
      var px = x + lx * c + lz * s, pz = z - lx * s + lz * c;
      var py = this._ground(px, pz);
      // Each leg is cut to reach the SHEET, not to a nominal length.  On a
      // verge with 20 cm of fall across the footprint a fixed 1.05 m leg
      // leaves the downhill corner hanging in mid-air under its own tarp -
      // the same floating-prop failure as dropping a crate level on a bank,
      // just upside down.
      var hh = Math.max(0.35, sheetY - py + (i === 3 ? -0.34 : 0)) + R.range(-0.02, 0.02);
      this._static('bamboo', cyl(0.030, 0.034, hh, 6),
        Tn(px, py + hh * 0.5, pz, R.range(-0.05, 0.05), 0, R.range(-0.05, 0.05)));
    }
    var panel = K.clothPanel(w + 0.24, d + 0.24, 0.0, 0.0, 5, 5);
    var pp = panel.attributes.position;
    for (i = 0; i < pp.count; i++) {
      var u = pp.getX(i) / (w + 0.24), v = -pp.getY(i) / (d + 0.24);
      // sag in the middle of the sheet, and the untied corner dropped
      var sag = -0.16 * Math.cos(u * Math.PI) * Math.cos((v - 0.5) * Math.PI);
      var drop = -0.34 * M.saturate((u + 0.5) * 1.2) * M.saturate(v * 1.3);
      pp.setXYZ(i, pp.getX(i), sag + drop, pp.getY(i) + (d + 0.24) * 0.5);
    }
    pp.needsUpdate = true;
    panel.computeVertexNormals();
    this._static('canvas', panel, Tn(x, sheetY, z, 0, yaw, 0));
  };

  // A dump: crates stacked on dunnage under a tarp, with the odds and ends
  // that always end up round one.  Used twice - once inside the wire as a
  // stores dump, once on the track verge as a porter's cache - because it is
  // the same thing built by two different people, and because both framings
  // that matter need a piece of MAN-MADE MASS in their middle distance.  A
  // jungle level with nothing but plants in the mid-ground has no scale cue
  // and no read at all.
  PropsJungle.prototype._dump = function (x, z, yaw, kind) {
    var R = this.rng, B = this.B;
    var c = Math.cos(yaw), s = Math.sin(yaw);
    var mil = kind !== 'civ';
    var i, y0;
    function W(lx, lz) { return [x + lx * c + lz * s, z - lx * s + lz * c]; }
    var gy = this._ground(x, z);
    // THE SITE TEST HAS TO COVER THE WHOLE SITE, and it has to run before the
    // first piece is placed.  A dump is eight props and a two-metre tarp, and
    // its static half - the legs, the dunnage, the sheet - does not go through
    // _drop and therefore tests nothing: the first version of the track cache
    // was sited 0.67 m from the centreline of a 0.62 m fallen trunk, so every
    // crate was correctly rejected by the log's collider while the tarp was
    // erected straight through it.  Half a prop is worse than none.
    //
    // ...and then it NUDGES rather than giving up, because the alternative is
    // a prop that silently ceases to exist the day somebody moves a log.  The
    // second site failed too: level_jungle gives a fallen trunk one AXIS-
    // ALIGNED collider, so a 10 m log lying diagonally claims an 11 x 6 m box
    // of ground that it is nowhere near.  A site that can walk two metres to
    // find clear ground survives that; a site that cannot, does not.
    var nudge = [[0, 0], [1.6, 0], [-1.6, 0], [0, 1.8], [0, -1.8],
      [1.9, 1.9], [-1.9, -1.9], [2.8, -1.4], [-2.8, 1.4]];
    var found = false;
    for (i = 0; i < nudge.length; i++) {
      var nx = x + nudge[i][0] * c + nudge[i][1] * s;
      var nz = z - nudge[i][0] * s + nudge[i][1] * c;
      if (!this._inBounds(nx, nz, 2)) continue;
      if (this._inWater(nx, nz, 0.1)) continue;
      if (this._nearCam(nx, nz, 1.0)) continue;
      if (this._blocked(nx, this._ground(nx, nz) + 0.6, nz, 1.15)) continue;
      x = nx; z = nz; found = true; break;
    }
    if (!found) { this._skipped++; this._why.solid++; return; }
    gy = this._ground(x, z);
    this.stats.sites++;

    // the dunnage everything stands on
    for (i = -1; i <= 1; i += 2) {
      var dp = W(0, i * 0.42);
      this._static('wood', box(2.1, 0.09, 0.15, 0.01),
        Tn(dp[0], this._ground(dp[0], dp[1]) + 0.045, dp[1], 0, yaw, 0));
    }
    // two stacks of crates, the near one one course lower - a stack that is
    // being worked down has a STEP in it, and the step is the read
    var pat = [[-0.55, 0, 0], [0.52, 0, 0], [-0.52, 0, 1], [0.55, 0.06, 1],
      [-0.02, -0.04, 2]];
    for (i = 0; i < pat.length; i++) {
      if (i === 4 && !mil) continue;
      var p = W(pat[i][0], pat[i][1]);
      y0 = gy + 0.09 + pat[i][2] * 0.40;
      this._drop(i === 3 ? B.crateB : B.crate, p[0], p[1], {
        r: 0.30, yaw: yaw + R.gaussian(0, 0.07), y: y0, tilt: 0.015,
        noOcc: true, onTrack: true, camOK: true,
        collider: pat[i][2] === 0 ? [0.46, 0.20, 0.26] : null, material: 'wood'
      });
      this._occupy(p[0], p[1], 0.30);
    }
    this._tarp(x, z, yaw, 2.3, 1.7, gy);
    // the sacks that came off the top of it
    for (i = 0; i < 3; i++) {
      var sp = W(-1.35 - R.range(0, 0.5), -0.7 + i * 0.62);
      this._drop(B.sack, sp[0], sp[1], { r: 0.30, tilt: 0.14, onTrack: true,
        camOK: true, yaw: yaw + R.gaussian(0, 0.4) });
    }
    if (mil) {
      var mp = W(1.5, -0.9);
      this._drop(B.drum, mp[0], mp[1], { r: 0.34, onTrack: true, camOK: true,
        collider: [0.30, 0.44, 0.30], material: 'metal' });
      mp = W(1.9, 0.2);
      this._drop(B.jerry, mp[0], mp[1], { r: 0.24, onTrack: true, camOK: true });
      for (i = 0; i < 3; i++) {
        mp = W(1.1 + R.gaussian(0, 0.3), 1.15 + R.gaussian(0, 0.3));
        this._drop(B.mortar, mp[0], mp[1], { r: 0.14, onTrack: true, camOK: true,
          tilt: 0.05, noOcc: true });
      }
      mp = W(-1.9, 1.3);
      this._drop(B.ammoOpen, mp[0], mp[1], { r: 0.24, onTrack: true, camOK: true });
    } else {
      var cp = W(1.4, -0.8);
      this._drop(B.basket, cp[0], cp[1], { r: 0.28, onTrack: true, camOK: true });
      cp = W(1.6, 0.5);
      this._drop(B.jar, cp[0], cp[1], { r: 0.26, onTrack: true, camOK: true });
      cp = W(-1.4, -1.4);
      this._drop(B.tins, cp[0], cp[1], { r: 0.18, onTrack: true, camOK: true, tilt: 0.1 });
      // the poles somebody was going to build the rest of the shelter with
      for (i = 0; i < 4; i++) {
        var pp2 = W(1.9 + R.gaussian(0, 0.12), 1.5 + R.gaussian(0, 0.12));
        if (B.pole) {
          B.pole.add(T(pp2[0], this._ground(pp2[0], pp2[1]), pp2[1],
            R.range(0.30, 0.46), R.range(0, 6.28), R.range(-0.12, 0.12),
            1, R.range(0.8, 1.1), 1), wearTint(R));
        }
      }
    }
    this._mark(MARK.trample, x, z + 1.4, 2.6, 2.2, yaw);
  };

  // The billet: two poles, a ridge rope, a poncho over it, a cot underneath,
  // boots at the door and a line of washing that will never dry.
  PropsJungle.prototype._billet = function (x, z, yaw) {
    var R = this.rng;
    var c = Math.cos(yaw), s = Math.sin(yaw);
    var gy = this._ground(x, z);
    var i;
    function w2(lx, lz) { return [x + lx * c + lz * s, z - lx * s + lz * c]; }
    // Same site test as the dump, for the same reason: a lean-to is nearly all
    // static geometry and static geometry tests nothing on its own.
    if (this._blocked(x, gy + 0.7, z, 1.6)) { this._skipped++; this._why.solid++; return; }
    var a = w2(0, -1.35), b = w2(0, 1.35);
    var ay = this._ground(a[0], a[1]), by = this._ground(b[0], b[1]);
    this._static('bamboo', cyl(0.030, 0.034, 1.55, 6), Tn(a[0], ay + 0.775, a[1], 0.03, 0, 0.02));
    this._static('bamboo', cyl(0.030, 0.034, 1.45, 6), Tn(b[0], by + 0.725, b[1], -0.02, 0, 0.03));
    this._static('rope', tubePath(sagStations(a[0], ay + 1.55, a[1], b[0], by + 1.45, b[1],
      0.06, 0.012, 6), 4), null);
    // the poncho, pitched over the ridge
    for (i = -1; i <= 1; i += 2) {
      var panel = K.clothPanel(2.5, 1.15, 0, 0, 5, 4);
      this._static('canvas', panel,
        Tn(x + (0.52 * i) * c, gy + 1.42, z - (0.52 * i) * s,
          -1.05 * i, yaw + Math.PI * 0.5, 0));
    }
    // the cot under it
    var cot = K.cot(R);
    if (cot.frame) {
      this._finishGeo(cot.frame, { noise: this.noise, hiY: 0.5, grime: 0.34 });
      this._static('steel', cot.frame, Tn(x, gy + 0.02, z, 0, yaw + Math.PI * 0.5, 0));
    }
    if (cot.cloth) {
      this._finishGeo(cot.cloth, { noise: this.noise, hiY: 0.5, grime: 0.40, wet: 0.30 });
      this._static('cloth', cot.cloth, Tn(x, gy + 0.02, z, 0, yaw + Math.PI * 0.5, 0));
    }
    this._collider(x, gy, z, [1.05, 0.30, 0.45], yaw + Math.PI * 0.5, 'wood');
    var bp = w2(0.85, -0.9);
    this._drop(this.B.boots, bp[0], bp[1], { r: 0.22, yaw: yaw + R.range(-0.4, 0.4) });
    var hp = w2(-0.95, 0.6);
    this._drop(this.B.helmet, hp[0], hp[1], { r: 0.20, yaw: R.range(0, 6.28), tilt: 0.09 });
    // the washing line, and four things on it that will never dry
    var l0 = w2(-2.6, -1.6), l1 = w2(-2.6, 2.4);
    var ly0 = this._ground(l0[0], l0[1]) + 1.62, ly1 = this._ground(l1[0], l1[1]) + 1.52;
    this._static('bamboo', cyl(0.028, 0.032, 1.7, 6),
      Tn(l0[0], ly0 - 0.85, l0[1], 0.04, 0, 0.03));
    this._static('bamboo', cyl(0.028, 0.032, 1.6, 6),
      Tn(l1[0], ly1 - 0.80, l1[1], -0.03, 0, 0.04));
    this._static('rope', tubePath(sagStations(l0[0], ly0, l0[1], l1[0], ly1, l1[1],
      0.13, 0.010, 7), 4), null);
    for (i = 0; i < 4; i++) {
      var t = (i + 0.7) / 5.2;
      var px = l0[0] + (l1[0] - l0[0]) * t;
      var pz = l0[1] + (l1[1] - l0[1]) * t;
      var py = ly0 + (ly1 - ly0) * t - 0.13 * 4 * t * (1 - t);
      var ww = R.range(0.42, 0.68), hh = R.range(0.55, 0.95);
      var pan = K.clothPanel(ww, hh, R.range(-0.06, 0.06), 0.05, 3, 4);
      this._static('cloth', pan,
        Tn(px, py - 0.01, pz, 0, Math.atan2(l1[0] - l0[0], l1[1] - l0[1]) + R.range(-0.2, 0.2), 0));
    }
  };

  // The shower point: a drum on three bamboo legs, a pipe, and the mud under it.
  PropsJungle.prototype._shower = function (x, z, yaw) {
    var R = this.rng;
    var gy = this._ground(x, z);
    var H = 2.25;
    if (this._blocked(x, gy + 1.0, z, 1.0)) { this._skipped++; this._why.solid++; return; }
    for (var i = 0; i < 3; i++) {
      var a = yaw + i * 2.094;
      var lx = x + Math.sin(a) * 0.62, lz = z + Math.cos(a) * 0.62;
      var ly = this._ground(lx, lz);
      this._static('bamboo', cyl(0.032, 0.038, H * 1.06, 6),
        Tn((lx + x) * 0.5, ly + H * 0.53, (lz + z) * 0.5,
          Math.cos(a) * 0.14, 0, -Math.sin(a) * 0.14));
    }
    var dg = K.drum(R, this.noise, 'closed');
    this._finishGeo(dg, { noise: this.noise, hiY: 0.9, grime: 0.40 });
    this._static('rust', dg, Tn(x, gy + H - 0.10, z, 0, R.range(0, 6.28), 0));
    this._static('rust', cyl(0.016, 0.016, 0.42, 5), Tn(x, gy + H - 0.32, z));
    this._static('rust', cyl(0.038, 0.030, 0.05, 8), Tn(x, gy + H - 0.54, z));
    this._drop(this.B.bucket, x + 0.85, z + 0.35, { r: 0.22 });
    this._mark(MARK.trample, x, z, 2.2, 2.2, R.range(0, 6.28));
  };

  PropsJungle.prototype._sign = function (x, z, yaw) {
    var R = this.rng;
    var gy = this._ground(x, z);
    var w = 1.25, h = 0.62;
    for (var s = -1; s <= 1; s += 2) {
      var px = x + Math.cos(yaw) * s * w * 0.42, pz = z - Math.sin(yaw) * s * w * 0.42;
      var py = this._ground(px, pz);
      this._static('wood', box(0.085, 1.55, 0.085, 0.008),
        Tn(px, py + 0.775, pz, R.range(-0.04, 0.04), yaw, R.range(-0.05, 0.05)));
    }
    var uv = boardUV(BOARD.hazard);
    this._static('board', cardGeo(w, h, uv[0], uv[1], uv[2], uv[3]),
      Tn(x, gy + 0.86, z, 0, yaw + 0.04, 0.03));
    this._static('wood', box(w + 0.04, 0.05, 0.03, 0.004), Tn(x, gy + 0.86, z - 0.02, 0, yaw, 0));
    this._static('wood', box(w + 0.04, 0.05, 0.03, 0.004), Tn(x, gy + 1.44, z - 0.02, 0, yaw, 0));
    this._collider(x, gy, z, [w * 0.5, 0.8, 0.1], yaw, 'wood');
    this._markWall(MARK.rust, x + Math.cos(yaw) * w * 0.42, gy + 0.55, z - Math.sin(yaw) * w * 0.42,
      0.14, 0.9, yaw);
  };

  PropsJungle.prototype._stretcher = function (x, z, yaw) {
    var s = K.stretcher(this.rng);
    var st = this._settle(x, z, 0.9, yaw);
    if (s.frame) {
      this._finishGeo(s.frame, { noise: this.noise, hiY: 0.3, grime: 0.36 });
      this._static('wood', s.frame, Tn(x, st.y, z, st.rx, yaw, st.rz));
    }
    if (s.cloth) {
      this._finishGeo(s.cloth, { noise: this.noise, hiY: 0.3, grime: 0.44, wet: 0.62 });
      this._static('canvas', s.cloth, Tn(x, st.y, z, st.rx, yaw, st.rz));
    }
    this._occupy(x, z, 1.0);
  };

  // ==========================================================================
  // THE COMMAND BUNKER - the INTERIOR framing
  //
  // Everything here is placed in the bunker's own local frame and inside the
  // cone the interior pose actually sees: the desk under the lantern, the cot
  // against the back wall, the crates the far revetment is holding up, and the
  // bucket sitting in the shell hole's light catching what comes through it.
  // The fern growing in that same cone of light is the one prop in the level
  // that states the theme outright - the jungle is taking this place back.
  // ==========================================================================
  PropsJungle.prototype._dressBunker = function () {
    var A = this.A, R = this.rng, B = this.B;
    var bk = A && A.bunker;
    if (!bk || !bk.centre) return;
    var built = (this.L && this.L.builtBunker) || null;
    var floorY = (built && isFinite(built.floorY)) ? built.floorY : bk.floorY;
    var roofY = (built && isFinite(built.roofY)) ? built.roofY : bk.roofY;
    var yaw = bk.yaw || 0;
    var c = Math.cos(yaw), s = Math.sin(yaw);
    var cx = bk.centre.x, cz = bk.centre.z;
    var hw = (bk.w || 9.8) * 0.5, hd = (bk.d || 6.6) * 0.5;
    var self = this;
    function W(lx, lz) { return [cx + lx * c + lz * s, cz - lx * s + lz * c]; }
    // Where the light comes in, recovered from the level's own solve.
    var hole = built && built.holeFloor ? [built.holeFloor.x, built.holeFloor.z] : W(2.35, 0.55);
    var eye = built && built.interiorEye ? [built.interiorEye.x, built.interiorEye.z] : W(-1.8, hd - 1.15);
    function clearOfEye(x, z, r) {
      var dx = x - eye[0], dz = z - eye[1];
      return dx * dx + dz * dz > r * r;
    }
    var p, i, g;

    // ---- the field desk, under the lantern ---------------------------------
    p = W(1.1, -1.7);
    if (clearOfEye(p[0], p[1], 1.1)) {
      // two crates and a plank, which is what a field desk actually is
      for (i = -1; i <= 1; i += 2) {
        var dp = W(1.1 + i * 0.62, -1.7);
        if (B.crate) {
          B.crate.add(T(dp[0], floorY, dp[1], 0, yaw + 1.57, 0, 1, 1, 1), wearTint(R));
        }
      }
      this._static('wood', box(1.85, 0.055, 0.66, 0.008),
        Tn(p[0], floorY + 0.42, p[1], 0, yaw, 0.008));
      this._collider(p[0], floorY, p[1], [0.95, 0.22, 0.36], yaw, 'wood');
      g = K.radio(R);
      this._finishGeo(g, { noise: this.noise, hiY: 0.4, grime: 0.30 });
      var rp = W(1.55, -1.85);
      this._static('olive', g, Tn(rp[0], floorY + 0.45, rp[1], 0, yaw + 2.5, 0));
      // the map board, propped on the wall behind it
      var mp = W(1.0, -2.9);
      var uv = boardUV(BOARD.plate);
      this._static('board', cardGeo(0.95, 0.66, uv[0], uv[1], uv[2], uv[3]),
        Tn(mp[0], floorY + 0.80, mp[1], 0, yaw + Math.PI, -0.10));
      this._static('wood', box(1.0, 0.04, 0.04, 0.004),
        Tn(mp[0], floorY + 0.47, mp[1], 0, yaw, 0));
      var tp = W(0.45, -1.55);
      if (B.tins) B.tins.add(T(tp[0], floorY + 0.45, tp[1], 0, R.range(0, 6.28), 0, 0.8, 0.8, 0.8), wearTint(R));
      var cp = W(1.9, -1.45);
      if (B.canteen) B.canteen.add(T(cp[0], floorY + 0.45, cp[1], 0, R.range(0, 6.28), 0), wearTint(R));
    }

    // ---- the cot against the back wall -------------------------------------
    p = W(-2.9, -1.5);
    var cot = K.cot(R);
    if (cot.frame) {
      this._finishGeo(cot.frame, { noise: this.noise, hiY: 0.5, grime: 0.34, wet: 0.22 });
      this._static('steel', cot.frame, Tn(p[0], floorY + 0.01, p[1], 0, yaw, 0));
    }
    if (cot.cloth) {
      this._finishGeo(cot.cloth, { noise: this.noise, hiY: 0.5, grime: 0.42, wet: 0.20 });
      this._static('cloth', cot.cloth, Tn(p[0], floorY + 0.01, p[1], 0, yaw, 0));
    }
    this._collider(p[0], floorY, p[1], [0.36, 0.24, 0.98], yaw, 'wood');
    // the mosquito net over it, hung off the roof beam
    var np = W(-2.9, -1.5);
    for (i = -1; i <= 1; i += 2) {
      var pan = K.clothPanel(2.0, 1.25, 0.10 * i, 0.06, 4, 4);
      this._static('canvas', pan,
        Tn(np[0] + i * 0.42 * c, floorY + 1.72, np[1] - i * 0.42 * s,
          0, yaw + Math.PI * 0.5, i * 0.14));
    }
    var bo = W(-2.2, -0.5);
    if (B.boots) B.boots.add(T(bo[0], floorY, bo[1], 0, yaw + 0.6, 0), wearTint(R));

    // ---- the stores against the far revetment ------------------------------
    // lx 2.2 to 3.8, not 2.6 to 4.5.  The revetment is built ON the wall line
    // and its bags stand 0.4 m proud of it into the room, so a stack pushed to
    // the nominal half-width buries its outer crate in the sandbags.
    for (i = 0; i < 5; i++) {
      var lx = 2.2 + (i % 3) * 0.80, lz = 2.05 - ((i / 3) | 0) * 0.55;
      p = W(lx, lz);
      if (!clearOfEye(p[0], p[1], 1.0)) continue;
      if (B.crate) {
        B.crate.add(T(p[0], floorY + (i > 2 ? 0.40 : 0), p[1],
          0, yaw + R.gaussian(0, 0.07), 0), wearTint(R));
      }
    }
    p = W(3.9, 0.9);
    if (B.ammoOpen) B.ammoOpen.add(T(p[0], floorY, p[1], 0, yaw + 0.4, 0), wearTint(R));
    p = W(3.4, -1.9);
    if (B.jerry) B.jerry.add(T(p[0], floorY, p[1], 0, yaw - 0.5, 0), wearTint(R));

    // ---- sandbag seats by the door -----------------------------------------
    for (i = 0; i < 3; i++) {
      p = W(-0.2 + i * 0.55, 2.05);
      if (B.sack) {
        B.sack.add(T(p[0], floorY, p[1], 0, yaw + R.gaussian(0, 0.2), 0), wearTint(R));
      }
    }

    // ---- the shell hole, and what lives under it ---------------------------
    // The bucket is here because the hole is here.  A hole in a roof in a
    // rain forest means somebody put a bucket under it, and the bucket is what
    // makes the hole read as a leak rather than as a light fitting.
    if (B.bucket) {
      B.bucket.add(T(hole[0] + 0.55, floorY, hole[1] + 0.35, 0.02, R.range(0, 6.28), 0.02),
        wearTint(R));
    }
    this._mark(MARK.trample, hole[0] + 0.2, hole[1] + 0.1, 1.7, 1.7, R.range(0, 6.28),
      new THREE.Color(0.7, 0.8, 0.72), floorY + 0.012);
    // the fern in the light
    if (B.fernP) {
      B.fernP.add(T(hole[0] - 0.65, floorY, hole[1] - 0.45, 0.05, R.range(0, 6.28), 0.04,
        1.15, 1.15, 1.15), hueTint(R, 0.92, 1.06, 0.74));
    }
    if (B.tuft) {
      for (i = 0; i < 4; i++) {
        B.tuft.add(T(hole[0] + R.gaussian(0, 0.7), floorY, hole[1] + R.gaussian(0, 0.7),
          0, R.range(0, 6.28), 0, R.range(0.7, 1.2), R.range(0.7, 1.2), R.range(0.7, 1.2)),
          hueTint(R, 0.94, 1.04, 0.70));
      }
    }
    // the rubble the shell put on the floor keeps its own small stones
    for (i = 0; i < 7; i++) {
      var ra = R.range(0, 6.28), rr = R.range(0.3, 1.6);
      if (B.rock) {
        B.rock.add(T(hole[0] + Math.cos(ra) * rr, floorY, hole[1] + Math.sin(ra) * rr,
          R.range(-0.3, 0.3), R.range(0, 6.28), R.range(-0.3, 0.3),
          R.range(0.20, 0.42), R.range(0.16, 0.34), R.range(0.20, 0.42)), wearTint(R));
      }
    }

    // ---- the cable run along the beams -------------------------------------
    for (i = 0; i < 2; i++) {
      var a0 = W(-hw + 0.6, -hd + 0.9 + i * 0.35);
      var a1 = W(hw - 0.6, -hd + 0.9 + i * 0.35);
      this._static('rope', tubePath(sagStations(a0[0], roofY - 0.16 - i * 0.05, a0[1],
        a1[0], roofY - 0.16 - i * 0.05, a1[1], 0.10, 0.011, 7), 4), null);
    }
    // and the drips coming through the roof, published for weather.js
    try {
      if (this.L && Array.isArray(this.L.dripEdges)) {
        for (i = 0; i < 3; i++) {
          this.L.dripEdges.push({
            position: new THREE.Vector3(hole[0] + R.gaussian(0, 0.5), roofY - 0.2,
              hole[1] + R.gaussian(0, 0.5)),
            fall: Math.max(0.6, roofY - floorY - 0.4)
          });
        }
      }
    } catch (e) { /* weather is optional */ }
    void self;
  };

  // ==========================================================================
  // THE WATCHTOWER
  //
  // The OVERVIEW framing stands on this platform looking out over the clear
  // parapet edge, so everything here goes at the SIDES of that view: a crate
  // and a can at the left corner post, the sentry's kit at the right one, and
  // the ring of empty tins hung on the wire that is the oldest early-warning
  // device there is.  Nothing goes in the middle of the platform.
  // ==========================================================================
  PropsJungle.prototype._dressTower = function () {
    var A = this.A, R = this.rng, B = this.B;
    var T0 = A && A.tower;
    if (!T0 || !T0.base) return;
    var built = (this.L && this.L.builtTower) || null;
    var plat = built && built.platform ? built.platform : null;
    var px = plat ? plat.x : T0.base.x;
    var pz = plat ? plat.z : T0.base.z;
    var py = plat ? plat.y : (T0.platformY || (T0.base.y + 8.15));
    var yaw = T0.yaw || 0;
    var c = Math.cos(yaw), s = Math.sin(yaw);
    var Rr = T0.legR || 1.72;
    function W(lx, lz) { return [px + lx * c + lz * s, pz - lx * s + lz * c]; }
    var i, p;
    var deck = py + 0.10;

    // THE PLATFORM IS THE ESTABLISHING SHOT'S NEAR PLANE, so what stands on it
    // is composed rather than distributed. Local +Z is the direction the
    // OVERVIEW pose looks (level_jungle turns the tower so its clear parapet
    // edge faces the shot), and everything solid used to sit on that edge: a
    // sagging wire of four dark ration tins ran straight across the middle of
    // the frame with a crate, an ammo can, a jerrycan and a helmet under it.
    // Kit goes to the REAR corners now - behind the lens, where a sentry would
    // actually keep it out of his own way - and the only thing left forward is
    // the poncho, which is a soft, warm, hanging near-plane and the one prop
    // here that a wide shot wants.
    p = W(-Rr * 1.05, -Rr * 0.95);
    if (B.crate) B.crate.add(T(p[0], deck, p[1], 0, yaw + 0.3, 0, 0.9, 0.9, 0.9), wearTint(R));
    if (B.canteen) B.canteen.add(T(p[0] + 0.1, deck + 0.36, p[1], 0, 1.1, 0), wearTint(R));
    p = W(-Rr * 0.75, -Rr * 1.15);
    if (B.ammoCan) B.ammoCan.add(T(p[0], deck, p[1], 0, yaw + 1.2, 0), wearTint(R));
    p = W(Rr * 1.05, -Rr * 0.9);
    if (B.jerry) B.jerry.add(T(p[0], deck, p[1], 0, yaw - 0.4, 0), wearTint(R));
    p = W(Rr * 0.8, -Rr * 1.2);
    if (B.helmet) B.helmet.add(T(p[0], deck, p[1], 0.05, R.range(0, 6.28), 0.03), wearTint(R));
    // the tins on the wire, strung between the two REAR posts
    var a0 = W(-Rr * 1.3, -Rr * 1.3), a1 = W(Rr * 1.3, -Rr * 1.3);
    this._static('rope', tubePath(sagStations(a0[0], deck + 0.95, a0[1],
      a1[0], deck + 0.95, a1[1], 0.09, 0.007, 6), 4), null);
    for (i = 0; i < 4; i++) {
      var t = (i + 0.6) / 5;
      var tx = a0[0] + (a1[0] - a0[0]) * t;
      var tz = a0[1] + (a1[1] - a0[1]) * t;
      var ty = deck + 0.95 - 0.09 * 4 * t * (1 - t) - 0.10;
      if (B.tins) {
        B.tins.add(T(tx, ty, tz, R.range(-0.4, 0.4), R.range(0, 6.28), R.range(-0.4, 0.4),
          0.7, 0.7, 0.7), wearTint(R));
      }
    }
    // the poncho, hung off the forward-right corner post so it hangs into the
    // right edge of the establishing shot and gives it a near plane
    var pp = W(Rr * 1.24, Rr * 0.85);
    this._static('canvas', K.clothPanel(1.30, 1.05, 0.08, 0.05, 4, 4),
      Tn(pp[0], deck + 0.68, pp[1], 0, yaw + Math.PI * 0.5 - 0.25, 0.06));

    // and the stores at the foot of the ladder, where they get carried up from
    var lp = W(-Rr * 0.9, Rr * 2.4);
    this._drop(B.crate, lp[0], lp[1], { r: 0.55, yaw: yaw + 0.4,
      collider: [0.46, 0.20, 0.26], material: 'wood' });
    this._drop(B.drum, lp[0] + 1.2, lp[1] - 0.5, { r: 0.36,
      collider: [0.30, 0.44, 0.30], material: 'metal' });
    this._drop(B.wire, lp[0] - 0.9, lp[1] + 0.7, { r: 0.3 });
  };

  // ==========================================================================
  // THE WRECK - hero2's subject
  //
  // The brief says "a downed helicopter reclaimed by growth", and reclaimed is
  // a process with a direction: the vines come DOWN off the rotor mast and
  // hang off the far side, the ferns are in the two places that hold water and
  // leaf mould (the engine deck and the cargo sill), and the debris field is on
  // the LAND side because that is where the machine came apart as it slid.
  // Everything is placed in the airframe's own rolled, pitched, yawed frame -
  // the same frame the level built it in - so nothing floats off the skin.
  // ==========================================================================
  PropsJungle.prototype._dressWreck = function () {
    var A = this.A, R = this.rng, B = this.B;
    var H = A && A.heli;
    if (!H || !H.centre) return;
    var built = (this.L && this.L.builtHeli) || null;
    var mtx = new THREE.Matrix4();
    _eu.set(H.pitch || 0, H.yaw || 0, H.roll || 0, 'YXZ');
    mtx.makeRotationFromEuler(_eu);
    mtx.setPosition(H.centre.x, H.centre.y, H.centre.z);
    var i, p, w;
    function HW(lx, ly, lz) {
      return new THREE.Vector3(lx, ly, lz).applyMatrix4(mtx);
    }
    // the land side, which is the beam the framing stands off
    var beam = (H.yaw || 0) + Math.PI * 0.5;
    var bx = Math.sin(beam), bz = Math.cos(beam);
    var tx = Math.sin(H.yaw || 0), tz = Math.cos(H.yaw || 0);
    this.stats.sites += 1;

    // ---- the growth ---------------------------------------------------------
    var hub = (built && built.rotorHub) ? built.rotorHub : HW(0, 4.2, 0.55);
    for (i = 0; i < 7; i++) {
      var a = R.range(0, Math.PI * 2);
      var end = HW(Math.sin(a) * 2.4, 0.0, Math.cos(a) * 2.6);
      var gy = this._ground(end.x, end.z);
      // 5-8 cm, not 2-4.  At two centimetres and four metres a vine subtends
      // less than a pixel edge and reads as a taut WIRE strung across the
      // airframe - which is the opposite of what a vine is doing there.
      this._vine(hub.x + R.gaussian(0, 0.25), hub.y - R.range(0.1, 0.6), hub.z + R.gaussian(0, 0.25),
        end.x, Math.max(gy, this.waterY - 0.1), end.z, R.range(0.7, 1.6),
        R.range(0.048, 0.075), 7);
    }
    // hanging lianas off the boom - the card half of the level's foliage kit,
    // used the way the level uses it: only overhead, never at arm's length
    var F = this.foliage;
    if (F && typeof F.cardGeo === 'function' && F.CELL) {
      for (i = 0; i < 6; i++) {
        var t = i / 5;
        var lp = HW(R.range(-0.5, 0.5), 2.55 - t * 0.25, -1.5 - t * 3.0);
        var vh = R.range(1.3, 2.4);
        this._static('hang', F.cardGeo(vh * 0.55, vh, F.CELL.liana),
          Tn(lp.x, lp.y - vh * 0.45, lp.z, 0, R.range(0, 6.28), R.range(-0.2, 0.2)));
      }
      for (i = 0; i < 4; i++) {
        var cp = HW(R.range(-1.0, 1.0), R.range(1.8, 2.9), R.range(0.2, 3.0));
        var ch = R.range(1.0, 1.8);
        this._static('hang', F.cardGeo(ch * 0.9, ch, F.CELL.creeper),
          Tn(cp.x, cp.y, cp.z, 0, R.range(0, 6.28), R.range(-0.35, 0.35)));
      }
    }
    // ferns where the leaf mould has collected: the engine deck and the sill
    if (B.fernP) {
      p = HW(0.05, 3.74, -0.60);
      B.fernP.add(T(p.x, p.y - 0.04, p.z, 0.06, R.range(0, 6.28), 0.05, 1.2, 1.2, 1.2),
        hueTint(R, 0.90, 1.06, 0.72));
      p = HW(1.28, 1.10, 1.30);
      B.fernP.add(T(p.x, p.y, p.z, 0.05, R.range(0, 6.28), 0.03, 1.0, 1.0, 1.0),
        hueTint(R, 0.92, 1.04, 0.74));
      p = HW(-0.20, 2.90, 2.30);
      B.fernP.add(T(p.x, p.y, p.z, 0.04, R.range(0, 6.28), 0.05, 0.85, 0.85, 0.85),
        hueTint(R, 0.90, 1.08, 0.70));
    }
    if (B.tuft) {
      for (i = 0; i < 9; i++) {
        p = HW(R.range(-1.0, 1.0), 2.86, R.range(-0.4, 3.0));
        B.tuft.add(T(p.x, p.y - 0.02, p.z, R.range(-0.1, 0.1), R.range(0, 6.28),
          R.range(-0.1, 0.1), R.range(0.6, 1.0), R.range(0.6, 1.0), R.range(0.6, 1.0)),
          hueTint(R, 0.96, 1.06, 0.70));
      }
    }

    // ---- the debris field, on the land side ---------------------------------
    // Torn skin panels first - they are the biggest pieces and they went
    // furthest, and they are the level's own aluminium so they read as having
    // come off this machine rather than as sheet metal from somewhere else.
    for (i = 0; i < 7; i++) {
      var d = R.range(2.6, 8.5), off = R.gaussian(0, 3.0);
      var px = H.centre.x + bx * d + tx * off;
      var pz = H.centre.z + bz * d + tz * off;
      if (!this._inBounds(px, pz, 1)) continue;
      var st = this._settle(px, pz, 0.5, 0, 1.0);
      var pw = R.range(0.5, 1.4), pd = R.range(0.4, 1.1);
      var g = box(pw, 0.020, pd, 0.004);
      // a panel that came off an airframe is BENT, and the bend is what stops
      // it reading as a floor tile lying in the mud
      var pa = g.attributes.position;
      for (var v = 0; v < pa.count; v++) {
        var lx = pa.getX(v) / pw;
        pa.setY(v, pa.getY(v) + Math.abs(lx) * Math.abs(lx) * R.range(0.05, 0.16));
      }
      pa.needsUpdate = true;
      g.computeVertexNormals();
      this._static('alu', g, Tn(px, st.y + 0.03, pz, st.rx + R.gaussian(0, 0.08),
        R.range(0, 6.28), st.rz + R.gaussian(0, 0.08)));
      this._occupy(px, pz, 0.7);
    }
    // the blade that came off, lying half in the water
    var blz = H.centre.z + bz * 1.2 - tz * 5.5;
    var blx = H.centre.x + bx * 1.2 - tx * 5.5;
    var bst = this._settle(blx, blz, 2.0, beam, 1.0);
    for (i = 0; i < 3; i++) {
      this._static('alu', box(0.40, 0.050, 2.3, 0.010),
        Tn(blx + tx * (i - 1) * 2.2, bst.y + 0.06 + i * 0.01, blz + tz * (i - 1) * 2.2,
          bst.rx + R.gaussian(0, 0.05), beam + R.gaussian(0, 0.04) + 1.5708,
          bst.rz + R.gaussian(0, 0.05)));
    }
    // the crew's kit, spilled where the doors were
    var door = (built && built.doorSill) ? built.doorSill : HW(1.5, 1.0, 1.2);
    for (i = 0; i < 10; i++) {
      var da = R.range(0, Math.PI * 2), dr = Math.pow(R.next(), 0.6) * 5.0;
      var dx = door.x + bx * Math.abs(Math.cos(da)) * dr + tx * Math.sin(da) * dr;
      var dz = door.z + bz * Math.abs(Math.cos(da)) * dr + tz * Math.sin(da) * dr;
      var pick = R.next();
      var batch = pick < 0.34 ? B.tins : (pick < 0.58 ? B.ammoCan
        : (pick < 0.74 ? B.ammoOpen : (pick < 0.86 ? B.bottles : B.helmet)));
      this._drop(batch, dx, dz, { r: 0.26, tilt: 0.12, camOK: true, inWater: true });
    }
    this._drop(B.jerry, door.x + bx * 2.2 + tx * 1.4, door.z + bz * 2.2 + tz * 1.4,
      { r: 0.26, tilt: 0.14, camOK: true });
    // a poncho snagged on the torn boom
    var tail = (built && built.tail) ? built.tail : HW(0, 0, -6.5);
    this._static('canvas', K.clothPanel(1.1, 1.35, 0.16, 0.10, 4, 4),
      Tn(tail.x + R.range(-0.4, 0.4), tail.y + 1.25, tail.z + R.range(-0.4, 0.4),
        0, R.range(0, 6.28), 0.18));
    // the stretcher somebody carried away from it and left
    this._stretcher(H.centre.x + bx * 6.2 + tx * 2.6, H.centre.z + bz * 6.2 + tz * 2.6,
      beam + 0.9);
    // fuel on the mud, and the rust running down the flank
    this._mark(MARK.oil, H.centre.x + bx * 1.4, H.centre.z + bz * 1.4, 3.4, 3.0,
      R.range(0, 6.28));
    for (i = 0; i < 3; i++) {
      w = HW(-1.28, 2.10 - i * 0.1, 0.4 + i * 1.1);
      this._markWall(MARK.rust, w.x, w.y, w.z, 0.5, 1.1, (H.yaw || 0) + Math.PI * 0.5);
    }
    // what the river has piled against the upstream skid
    for (i = 0; i < 5; i++) {
      var wx = H.centre.x - bx * R.range(1.0, 2.6) + tx * R.range(-3, 3);
      var wz = H.centre.z - bz * R.range(1.0, 2.6) + tz * R.range(-3, 3);
      if (this._ground(wx, wz) > this.waterY + 0.15) continue;
      this._drop(B.branch, wx, wz, { r: 0.4, inWater: true, camOK: true,
        y: this.waterY - R.range(0.02, 0.10), tilt: 0.05,
        colour: new THREE.Color(0.62, 0.74, 0.55) });
    }
    try {
      if (this.L && Array.isArray(this.L.dripEdges)) {
        var dl = HW(-1.3, 2.9, 1.2);
        this.L.dripEdges.push({ position: new THREE.Vector3(dl.x, dl.y, dl.z), fall: 2.2 });
      }
    } catch (e) { /* weather is optional */ }
  };

  // ==========================================================================
  // THE CREEK CROSSING - the boat landing
  //
  // A crossing is where people STOP, so it is where their things accumulate:
  // the sampan pulled up out of the current, the traps stacked above the water
  // line, the net on its frame, the plank somebody laid across the gap the
  // bridge left.  All of it on the near bank, because the far half of the
  // bridge is in the creek and nobody has been across it in a while.
  // ==========================================================================
  PropsJungle.prototype._dressCreek = function () {
    var A = this.A, R = this.rng, B = this.B;
    var C = A && A.creek;
    if (!C || !C.bridge || !C.bridge.centre) return;
    var br = C.bridge;
    var bc = br.centre, nl = br.nearLip || bc;
    var i, p;
    this.stats.sites += 1;

    // ---- the sampan --------------------------------------------------------
    // Pulled up the bank bow-first and settled ACROSS the slope, which is the
    // only way a boat sits when somebody has dragged it out of the water.
    var sx = bc.x + 4.6, sz = nl.z + 1.2;
    var syaw = -0.5;
    var sst = this._settle(sx, sz, 1.6, syaw, 0.9);
    var hull = K.sampan(R, this.noise);
    if (hull) {
      this._finishGeo(hull, { noise: this.noise, hiY: 0.7, grime: 0.44, wet: 0.72,
        growth: 0.34 });
      this._static('wood', hull, Tn(sx, sst.y + 0.06, sz, sst.rx - 0.06, syaw, sst.rz));
      this._collider(sx, sst.y, sz, [0.6, 0.30, 2.2], syaw, 'wood');
      this._occupy(sx, sz, 2.2);
      // the pole and the bailing tin, in the boat
      this._static('bamboo', cyl(0.028, 0.034, 3.4, 6),
        Tn(sx + 0.1, sst.y + 0.52, sz - 0.2, 0, syaw + 0.06, Math.PI * 0.5));
      if (B.tins) {
        B.tins.add(T(sx - 0.12, sst.y + 0.30, sz + 0.9, 0.1, R.range(0, 6.28), 0.05,
          1.1, 1.1, 1.1), wearTint(R));
      }
      // and the mud it was dragged through
      this._mark(MARK.trample, sx - 0.6, sz + 2.4, 2.6, 3.4, syaw);
    }

    // ---- the traps ---------------------------------------------------------
    for (i = 0; i < 4; i++) {
      p = [bc.x + 3.0 + R.gaussian(0, 0.5), nl.z + 3.0 + R.gaussian(0, 0.6)];
      this._drop(B.trap, p[0], p[1], { r: 0.34, yaw: R.range(0, 6.28), tilt: 0.10, k: 0.7 });
    }
    // one still set, out in the water on its stakes
    var wx = bc.x + 1.0, wz = this.creekZf(bc.x + 1.0);
    if (B.trap) {
      B.trap.add(T(wx, this.waterY - 0.18, wz, 1.35, R.range(0, 6.28), 0.1),
        wearTint(R));
    }
    for (i = 0; i < 5; i++) {
      var kx = bc.x - 1.4 + i * 0.85;
      var kz = this.creekZf(kx) + R.range(-0.5, 0.5);
      if (B.stake) {
        B.stake.add(T(kx, this._ground(kx, kz) - 0.1, kz,
          R.range(-0.12, 0.12), R.range(0, 6.28), R.range(-0.12, 0.12),
          1, R.range(0.9, 1.5), 1), wearTint(R));
      }
    }

    // ---- the drying net ----------------------------------------------------
    var nx = bc.x + 5.4, nz = nl.z + 4.2;
    var ny = this._ground(nx, nz);
    for (i = 0; i < 3; i++) {
      var a = i * 2.094 + 0.4;
      var lx = nx + Math.sin(a) * 0.75, lz = nz + Math.cos(a) * 0.75;
      var ly = this._ground(lx, lz);
      this._static('bamboo', cyl(0.030, 0.036, 2.6, 6),
        Tn((lx + nx) * 0.5, ly + 1.28, (lz + nz) * 0.5,
          Math.cos(a) * 0.16, 0, -Math.sin(a) * 0.16));
    }
    var net = K.netSheet(2.2, 1.5, 9, 6, 0.30);
    if (net) {
      this._finishGeo(net, { noise: this.noise, hiY: 1.6, grime: 0.36, wet: 0.80 });
      this._static('rope', net, Tn(nx, ny + 2.35, nz, 0, R.range(0, 6.28), 0));
    }
    this._drop(B.basket, nx + 1.1, nz - 0.7, { r: 0.30 });
    this._drop(B.basket, nx - 0.9, nz - 1.1, { r: 0.30, tilt: 0.14 });
    this._drop(B.jar, nx + 0.3, nz + 1.2, { r: 0.28,
      collider: [0.22, 0.24, 0.22], material: 'stone' });

    // ---- the plank somebody laid across the gap ----------------------------
    var pl0 = [br.nearLip ? br.nearLip.x + 1.9 : bc.x + 1.9, br.nearLip ? br.nearLip.z : bc.z + 4];
    var pl1 = [pl0[0] + 0.35, pl0[1] - 3.6];
    var pmy = Math.max(this._ground(pl0[0], pl0[1]), this._ground(pl1[0], pl1[1]));
    this._static('wood', box(0.34, 0.055, 3.9, 0.008),
      Tn((pl0[0] + pl1[0]) * 0.5, pmy - 0.02, (pl0[1] + pl1[1]) * 0.5,
        0.02, Math.atan2(pl1[0] - pl0[0], pl1[1] - pl0[1]), 0.03));

    // ---- the creek bed -----------------------------------------------------
    for (i = 0; i < 22; i++) {
      var rx = bc.x + R.gaussian(0, 6.0);
      var rz = this.creekZf(rx) + R.gaussian(0, 1.6);
      if (!this._inBounds(rx, rz, 2)) continue;
      if (this._riverA(rx, rz) < 1.05) continue;
      this._drop(B.rock, rx, rz, { r: 0.34, inWater: true, tilt: 0.16,
        sy: R.range(0.5, 0.9), sink: R.range(0.02, 0.12),
        scale: R.range(0.45, 1.0) });
    }
    // the wear on both lips of the crossing
    this._path(nl.x - 1.2, nl.z + 3.2, nl.x, nl.z - 0.4, 1.3, 7);
    this._path(sx - 1.0, sz + 1.0, nl.x + 0.6, nl.z + 1.6, 1.2, 6);
  };

  // ==========================================================================
  // THE SPIRIT HOUSE
  //
  // The one thing in the southern half of the level that is neither military
  // nor decaying, and hero1 looks straight at it.  Somebody still walks out
  // here to leave rice and light a stick, and the evidence of that - not the
  // shrine itself, which the level built - is what this pass is for.
  // ==========================================================================
  PropsJungle.prototype._dressShrine = function () {
    var A = this.A, R = this.rng, B = this.B;
    var S = A && A.shrine;
    if (!S || !S.centre) return;
    var cx = S.centre.x, cz = S.centre.z;
    var gy = this._ground(cx, cz);
    var yaw = S.yaw || 0;
    var c = Math.cos(yaw), s = Math.sin(yaw);
    var i;
    function W(lx, lz) { return [cx + lx * c + lz * s, cz - lx * s + lz * c]; }
    this.stats.sites += 1;

    // offering bowls at the foot of the post, where the ground is flat enough
    for (i = 0; i < 3; i++) {
      var p = W(-0.35 + i * 0.34, 0.52 + R.range(-0.06, 0.06));
      var prof = [];
      var rr = R.range(0.055, 0.085);
      prof.push(V2(0.001, 0)); prof.push(V2(rr * 0.55, 0));
      prof.push(V2(rr, rr * 0.75)); prof.push(V2(rr * 0.94, rr * 0.85));
      prof.push(V2(0.001, rr * 0.80));
      var st = this._settle(p[0], p[1], 0.12, 0, 1.0);
      this._static('pot', lathe(prof, 10), Tn(p[0], st.y, p[1], st.rx, R.range(0, 6.28), st.rz));
      // rice, heaped
      this._static('pot', sph(rr * 0.62, 7, 5), Tn(p[0], st.y + rr * 0.68, p[1], 0, 0, 0, 1, 0.5, 1));
    }
    // a jar of water and a bunch of bananas somebody left this morning
    var jp = W(0.55, 0.42);
    this._drop(B.jar, jp[0], jp[1], { r: 0.26, camOK: true, tilt: 0.04 });
    var bp = W(-0.62, 0.30);
    this._drop(B.basket, bp[0], bp[1], { r: 0.26, camOK: true, tilt: 0.05 });
    // the joss sticks, and the ember on the end of each one
    for (i = 0; i < 3; i++) {
      var sp = W(-0.06 + i * 0.06, 0.30);
      var h = R.range(0.24, 0.32);
      this._static('bamboo', cyl(0.004, 0.005, h, 4),
        Tn(sp[0], gy + h * 0.5 + 0.02, sp[1], R.range(-0.08, 0.08), 0, R.range(-0.08, 0.08)));
      this._static('ember', sph(0.009, 5, 4), Tn(sp[0], gy + h + 0.02, sp[1]));
    }
    // the ash of every stick before them
    this._mark(MARK.ash, W(0, 0.34)[0], W(0, 0.34)[1], 0.85, 0.85, yaw,
      new THREE.Color(0.9, 0.88, 0.82));
    // and the path worn out to it from the track
    var tp = [this.trackXf(cz) + 1.9, cz - 0.6];
    this._path(tp[0], tp[1], cx + 0.6, cz + 0.9, 0.9, 6);
    // marigolds - small, warm, and the only saturated non-green in the frame
    for (i = 0; i < 9; i++) {
      var fa = R.range(0, 6.28), fr = R.range(0.35, 0.75);
      var fp = [cx + Math.sin(fa) * fr, cz + Math.cos(fa) * fr];
      this._static('ember', sph(R.range(0.022, 0.034), 6, 4),
        Tn(fp[0], this._ground(fp[0], fp[1]) + 0.03, fp[1]));
    }
  };

  // ==========================================================================
  // THE TRACK
  //
  // Four incidents down its length, not a sprinkle along it.  A road tells its
  // story at the places where something HAPPENED on it: where a load came off,
  // where the tree came down and everything had to be manhandled round it,
  // where somebody dug in a trap, and where it meets the wire.  Between those
  // the verge carries only what the traffic pushed aside.
  // ==========================================================================
  PropsJungle.prototype._dressTrack = function () {
    var A = this.A, R = this.rng, B = this.B;
    var i, p, z, x;
    this.stats.sites += 4;

    // ---- 0 : the porter's cache on the west verge --------------------------
    // Eleven metres off the hero1 standpoint, 19 degrees left of its axis, on
    // the near edge of the clearing the shaft lands in - so it is the one
    // man-made mass in the signature frame AND it is lit.  hero1 is otherwise
    // a corridor of plants with a fallen trunk across it: no scale cue, no
    // third depth, and no reason to believe anybody uses this road.
    //
    // It sits SOUTH of the trunk, clear of the 11 x 6 m axis-aligned box that
    // trunk claims (see _dump): at z = 41 it was inside it and the whole cache
    // was rejected.
    this._dump(this.trackXf(37.5) - 4.4, 37.5, 1.15, 'civ');

    // ---- 1 : a load that came off, z = 52 ----------------------------------
    z = 52.0; x = this.trackXf(z) + 3.4;
    this._drop(B.crateB, x, z, { r: 0.6, yaw: 0.4, collider: [0.46, 0.20, 0.26],
      material: 'wood' });
    this._drop(B.crateOpen, x + 1.2, z - 1.1, { r: 0.6, yaw: 1.5 });
    // the contents went DOWNHILL from the break, which is what makes it read
    // as a spill rather than as a display
    var dh = this._uphill(x, z);
    for (i = 0; i < 9; i++) {
      var t = R.range(0.4, 3.4);
      p = [x - dh.x * t + R.gaussian(0, 0.5), z - dh.z * t + R.gaussian(0, 0.5)];
      this._drop(R.bool(0.6) ? B.tins : B.bottles, p[0], p[1],
        { r: 0.18, tilt: 0.14, onTrack: true });
    }
    this._drop(B.sack, x - dh.x * 1.4 + 0.5, z - dh.z * 1.4 + 0.7,
      { r: 0.32, tilt: 0.12, onTrack: true });
    this._drop(B.sack, x - dh.x * 2.1 - 0.4, z - dh.z * 2.1 + 0.2,
      { r: 0.32, tilt: 0.16, onTrack: true });

    // ---- 2 : the log across the road ---------------------------------------
    // Everything that meets an obstacle piles against its UPHILL face, and the
    // people who had to get round it left the ground bare either side.
    var logs = (A && A.logs) || [];
    if (logs.length) {
      var lg = logs[0];
      var mx = (lg.a.x + lg.b.x) * 0.5, mz = (lg.a.z + lg.b.z) * 0.5;
      var up = this._uphill(mx, mz);
      var laxis = Math.atan2(lg.b.x - lg.a.x, lg.b.z - lg.a.z);
      // the bicycle, leaned against the trunk where the track meets it
      var bxp = mx + up.x * 0.9 + Math.sin(laxis) * 1.6;
      var bzp = mz + up.z * 0.9 + Math.cos(laxis) * 1.6;
      var bst = this._settle(bxp, bzp, 0.6, laxis + 1.2);
      var bike = K.bicycle(R);
      if (bike) {
        // RUST, not painted steel.  A bicycle is thin tube: in this light the
        // only part of it that catches anything is the wheel rim, and on the
        // painted-metal albedo that came out as a bright white wagon wheel
        // floating in a dark frame with no machine attached to it.
        this._finishGeo(bike, { noise: this.noise, hiY: 1.0, grime: 0.52,
          edge: 0.34, growth: 0.30 });
        this._static('rust', bike, Tn(bxp, bst.y, bzp, bst.rx + 0.22, laxis + 1.2, bst.rz));
        this._collider(bxp, bst.y, bzp, [0.35, 0.45, 0.75], laxis + 1.2, 'metal');
        this._occupy(bxp, bzp, 1.0);
        // THE LOAD IS THE PROP.  A porter's bicycle carries 200 kg of rice and
        // it is the sacks, not the frame, that read at ten metres - without
        // them the silhouette is two circles and some wire.
        var bc = Math.cos(laxis + 1.2), bs2 = Math.sin(laxis + 1.2);
        for (i = 0; i < 3; i++) {
          var slx = (i - 1) * 0.02, slz = -0.62 + i * 0.04;
          var sly = bst.y + 0.60 + i * 0.24;
          if (B.sack) {
            B.sack.add(T(bxp + slx * bc + slz * bs2, sly, bzp - slx * bs2 + slz * bc,
              R.gaussian(0, 0.08), laxis + 1.2 + R.gaussian(0, 0.12) + (i === 1 ? 1.4 : 0),
              R.gaussian(0, 0.08), 0.92, 0.92, 0.92), wearTint(R));
          }
        }
        // lashed on, and the lashing is what says somebody tied it there
        this._static('rope', tubePath(sagStations(
          bxp - 0.34 * bc - 0.62 * bs2, bst.y + 0.48, bzp + 0.34 * bs2 - 0.62 * bc,
          bxp + 0.34 * bc - 0.58 * bs2, bst.y + 0.52, bzp - 0.34 * bs2 - 0.58 * bc,
          -0.42, 0.011, 6), 4), null);
      }
      this._drop(B.sack, bxp + 0.9, bzp + 0.5, { r: 0.32, tilt: 0.10, onTrack: true });
      this._drop(B.sack, bxp + 0.35, bzp + 1.25, { r: 0.32, tilt: 0.16, onTrack: true });
      // deadfall banked on the uphill face, along the whole trunk
      for (i = 0; i < 14; i++) {
        var lt = R.next();
        var lx = lg.a.x + (lg.b.x - lg.a.x) * lt + up.x * R.range(0.35, 1.5);
        var lz2 = lg.a.z + (lg.b.z - lg.a.z) * lt + up.z * R.range(0.35, 1.5);
        this._drop(R.bool(0.5) ? B.branch : B.branchS, lx, lz2,
          { r: 0.30, yaw: laxis + R.gaussian(0, 0.5), tilt: 0.14, onTrack: true,
            colour: new THREE.Color(0.74, 0.82, 0.62) });
      }
      // fungus eating it, on the shaded flank
      if (B.fungus) {
        for (i = 0; i < 9; i++) {
          var ft = R.next();
          var fx = lg.a.x + (lg.b.x - lg.a.x) * ft;
          var fz = lg.a.z + (lg.b.z - lg.a.z) * ft;
          var fa = laxis + (R.bool() ? 1.5708 : -1.5708);
          var fr = (lg.r || 0.5) * 0.9;
          B.fungus.add(T(fx + Math.sin(fa) * fr, this._ground(fx, fz) + R.range(0.15, 0.55),
            fz + Math.cos(fa) * fr, 0, fa, 0,
            R.range(0.7, 1.3), R.range(0.7, 1.3), R.range(0.7, 1.3)),
            hueTint(R, 1.0, 0.94, 0.78));
        }
      }
      // and the two boot-worn ends where everybody stepped over
      this._path(lg.a.x, lg.a.z - 1.6, lg.a.x, lg.a.z + 1.6, 1.1, 5);
      this._path(mx + 1.4, mz - 1.8, mx + 1.4, mz + 1.8, 1.1, 5);
    }

    // ---- 3 : the trap, z = 30 ----------------------------------------------
    z = 30.0; x = this.trackXf(z) - 3.6;
    var ty = this._ground(x, z);
    for (i = 0; i < 11; i++) {
      var sa = R.range(0, 6.28), sr = Math.sqrt(R.next()) * 0.75;
      if (B.stake) {
        B.stake.add(T(x + Math.cos(sa) * sr, ty - 0.42, z + Math.sin(sa) * sr,
          R.range(-0.22, 0.22), R.range(0, 6.28), R.range(-0.22, 0.22),
          1, R.range(0.55, 0.95), 1), wearTint(R));
      }
    }
    this._mark(MARK.trample, x, z, 2.0, 2.0, R.range(0, 6.28),
      new THREE.Color(0.55, 0.72, 0.6));
    // the branches that were over it, thrown aside
    for (i = 0; i < 5; i++) {
      this._drop(B.branchS, x + R.gaussian(0, 1.4), z + R.gaussian(0, 1.4),
        { r: 0.26, tilt: 0.12, colour: new THREE.Color(0.66, 0.78, 0.54) });
    }
    // a marker stake with a rag on it, because somebody had to warn the rest
    var wpx = x + 1.9, wpz = z + 1.2;
    var wpy = this._ground(wpx, wpz);
    this._static('bamboo', cyl(0.024, 0.028, 1.35, 6), Tn(wpx, wpy + 0.67, wpz, 0.05, 0, 0.03));
    this._static('cloth', K.clothPanel(0.28, 0.42, 0.06, 0.04, 3, 3),
      Tn(wpx + 0.02, wpy + 1.30, wpz, 0, R.range(0, 6.28), 0.12));

    // a cart wheel rotting in the verge a little further on
    var cw = K.cartWheel(R);
    if (cw) {
      var cwx = this.trackXf(24) + 3.9, cwz = 24.0;
      var cst = this._settle(cwx, cwz, 0.6, 0.8);
      this._finishGeo(cw, { noise: this.noise, hiY: 0.9, grime: 0.50, growth: 0.42 });
      this._static('wood', cw, Tn(cwx, cst.y + 0.42, cwz, cst.rx + 1.2, 0.8, cst.rz + 0.2));
      this._occupy(cwx, cwz, 0.8);
    }

    // ---- 4 : the verge, everywhere else ------------------------------------
    // Only what the traffic pushed aside, and only where the traffic is: the
    // density falls off hard away from the wheel tracks.
    for (i = 0; i < 90; i++) {
      z = R.range(-18, 62);
      var side = R.bool() ? 1 : -1;
      x = this.trackXf(z) + side * R.range(2.6, 5.4);
      if (!this._inBounds(x, z, 3)) continue;
      var roll = R.next();
      var batch = roll < 0.52 ? B.branchS : (roll < 0.72 ? B.branch
        : (roll < 0.84 ? B.rock : (roll < 0.93 ? B.tins : B.husk)));
      this._drop(batch, x, z, {
        r: 0.28, tilt: 0.13,
        scale: R.range(0.7, 1.15),
        colour: (roll < 0.72) ? new THREE.Color(0.80, 0.86, 0.66) : undefined
      });
    }
    // bamboo poles leaning where somebody stacked them against a tree
    var pz2 = 34.0, pxx = this.trackXf(pz2) + 4.6;
    for (i = 0; i < 5; i++) {
      var py2 = this._ground(pxx, pz2);
      if (B.pole) {
        B.pole.add(T(pxx + R.gaussian(0, 0.18), py2, pz2 + R.gaussian(0, 0.18),
          R.range(0.24, 0.40), R.range(0, 6.28), R.range(-0.10, 0.10),
          1, R.range(0.85, 1.15), 1), wearTint(R));
      }
    }
    this._occupy(pxx, pz2, 0.8);
  };

  // ==========================================================================
  // THE RIVER
  //
  // The channel is the level's only bright floor and the bottom band of every
  // framing that looks west, so it cannot be an empty plane.  What goes on it
  // is what a delta river actually carries: rafts of hyacinth caught on the
  // slack inside of every bend, driftwood grounded on the bars, and a fish
  // weir of stakes across the shallows.
  // ==========================================================================
  PropsJungle.prototype._dressRiver = function () {
    var R = this.rng, B = this.B;
    var i, j;
    var b = this.bounds;
    this.stats.sites += 1;

    // ---- hyacinth, in RAFTS -------------------------------------------------
    // Free-floating weed does not distribute evenly - it collects on the slack
    // water of the inside bend and against anything that stops it.  Fourteen
    // raft centres, chosen on the inner bank, and the mat grows from each.
    if (B.hyacinth) {
      for (i = 0; i < 15; i++) {
        var rz = b.z0 + 6 + (i / 15) * (b.z1 - b.z0 - 12) + R.range(-3, 3);
        var rc = this.riverC(rz), rh = this.riverHalf(rz);
        // which way is the channel turning?  the raft goes on the inside.
        var turn = this.riverC(rz + 8) - this.riverC(rz - 8);
        var side = turn > 0 ? -1 : 1;
        var cxr = rc + side * rh * R.range(0.52, 0.86);
        var n = R.int(10, 22);
        for (j = 0; j < n; j++) {
          var a = R.range(0, 6.28), rr = Math.pow(R.next(), 0.55) * R.range(1.4, 3.6);
          var hx = cxr + Math.cos(a) * rr, hz = rz + Math.sin(a) * rr * 1.6;
          if (this._riverA(hx, hz) > 0.97) continue;
          if (this._ground(hx, hz) > this.waterY - 0.25) continue;
          var hyaw = R.range(0, 6.28), hsc = R.range(0.75, 1.45);
          // Only record the entry if the batch actually TOOK it.  update()
          // walks this list against the mesh's instance slots, and a rejected
          // add would slide every later plant onto the wrong slot - which is
          // the quiet half of the overflowing-batch failure.
          if (B.hyacinth.add(T(hx, this.waterY - 0.03, hz,
            R.range(-0.06, 0.06), hyaw, R.range(-0.06, 0.06), hsc, hsc, hsc),
            hueTint(R, 0.84, 1.10, 0.66))) {
            this.hyacinth.push({ x: hx, z: hz, yaw: hyaw, sc: hsc, ph: R.range(0, 6.28) });
          }
        }
      }
    }

    // ---- driftwood grounded on the bars ------------------------------------
    for (i = 0; i < 26; i++) {
      var dz = R.range(b.z0 + 4, b.z1 - 4);
      var drc = this.riverC(dz), drh = this.riverHalf(dz);
      var dside = R.bool() ? 1 : -1;
      var dx = drc + dside * drh * R.range(0.88, 1.06);
      if (!this._inBounds(dx, dz, 2)) continue;
      this._drop(B.branch, dx, dz, {
        r: 0.45, inWater: true, tilt: 0.10, camOK: true,
        yaw: R.range(0, 6.28), scale: R.range(0.8, 1.5),
        colour: new THREE.Color(0.68, 0.80, 0.60)
      });
    }

    // ---- the fish weir ------------------------------------------------------
    // A line of stakes angled across the shallow inside of a bend, funnelling
    // into a trap.  It is the clearest read in the level that this river is
    // WORKED, and it is a strong vertical rhythm on an otherwise flat band.
    for (var wv = 0; wv < 2; wv++) {
      var wz = wv ? -12.0 : 30.0;
      var wc = this.riverC(wz), wh = this.riverHalf(wz);
      var wside = wv ? -1 : 1;
      var n2 = 16;
      for (i = 0; i < n2; i++) {
        var t = i / (n2 - 1);
        var sxp = wc + wside * wh * (1.02 - t * 0.55);
        var szp = wz + t * 5.5 * (wv ? -1 : 1);
        var gyw = this._ground(sxp, szp);
        if (gyw > this.waterY + 0.05) continue;
        if (B.stake) {
          B.stake.add(T(sxp + R.gaussian(0, 0.10), gyw - 0.05, szp + R.gaussian(0, 0.10),
            R.range(-0.10, 0.10), R.range(0, 6.28), R.range(-0.10, 0.10),
            1, R.range(1.05, 1.75), 1), wearTint(R));
        }
      }
      var tx2 = wc + wside * wh * 0.46, tz2 = wz + 5.6 * (wv ? -1 : 1);
      if (B.trap && this._ground(tx2, tz2) < this.waterY) {
        B.trap.add(T(tx2, this.waterY - 0.30, tz2, 1.15, R.range(0, 6.28), 0.2),
          wearTint(R));
      }
    }
  };

  // ==========================================================================
  // THE FOREST FLOOR
  //
  // Deposition, not scatter.  Branches fall from directly overhead and then
  // ROLL, so they end up in the hollows and against the uphill face of the
  // first thing that stops them - a buttress, a log, a rock.  Fungus grows on
  // dead wood and on the shaded flank of living trunks; termites build against
  // the roots; palm nuts land under the crown that dropped them.
  // ==========================================================================
  PropsJungle.prototype._dressForest = function () {
    var A = this.A, R = this.rng, B = this.B;
    var trees = (A && A.trees) || [];
    var logs = (A && A.logs) || [];
    var i, j, p;

    // ---- what has collected against the trees ------------------------------
    for (i = 0; i < trees.length; i++) {
      var Tt = trees[i];
      if (!Tt.centre) continue;
      var tx = Tt.centre.x, tz = Tt.centre.z, tr = Tt.r || 0.8;
      if (!this._inBounds(tx, tz, 4)) continue;
      var up = this._uphill(tx, tz);
      // deadfall on the uphill side of the buttress
      var nb = R.int(0, 3);
      for (j = 0; j < nb; j++) {
        var d = tr + R.range(0.4, 1.9);
        var ja = R.gaussian(0, 0.75);
        var dx = tx + (up.x * Math.cos(ja) - up.z * Math.sin(ja)) * d;
        var dz = tz + (up.z * Math.cos(ja) + up.x * Math.sin(ja)) * d;
        this._drop(R.bool(0.55) ? B.branchS : B.branch, dx, dz, {
          r: 0.30, tilt: 0.16, yaw: R.range(0, 6.28), scale: R.range(0.7, 1.25),
          colour: new THREE.Color(R.range(0.70, 0.92), R.range(0.76, 0.94), R.range(0.54, 0.72))
        });
      }
      // fungus on the shaded flank of a third of the trunks
      if (B.fungus && R.bool(0.34)) {
        var fn = R.int(1, 3);
        for (j = 0; j < fn; j++) {
          var fa = R.range(0, 6.28);
          B.fungus.add(T(tx + Math.sin(fa) * tr * 0.95,
            this._ground(tx, tz) + R.range(0.25, 2.1),
            tz + Math.cos(fa) * tr * 0.95, 0, fa, 0,
            R.range(0.7, 1.5), R.range(0.7, 1.5), R.range(0.7, 1.5)),
            hueTint(R, 1.0, 0.95, 0.80));
        }
      }
      // a termite mound against the roots of one tree in eight
      if (B.termite && R.bool(0.12)) {
        var ma = R.range(0, 6.28);
        this._drop(B.termite, tx + Math.sin(ma) * (tr + 0.5),
          tz + Math.cos(ma) * (tr + 0.5),
          { r: 0.42, yaw: R.range(0, 6.28), tilt: 0.05, k: 0.5,
            collider: [0.32, 0.45, 0.32], material: 'dirt' });
      }
      // palm nuts under the crown
      if (B.husk && R.bool(0.22)) {
        for (j = 0; j < R.int(2, 5); j++) {
          var ha = R.range(0, 6.28), hr = R.range(tr, tr + 2.6);
          this._drop(B.husk, tx + Math.sin(ha) * hr, tz + Math.cos(ha) * hr,
            { r: 0.14, tilt: 0.2, scale: R.range(0.7, 1.2) });
        }
      }
    }

    // ---- the fallen trunks -------------------------------------------------
    for (i = 0; i < logs.length; i++) {
      var lg = logs[i];
      if (!lg.a || !lg.b) continue;
      var ax = lg.a.x, az = lg.a.z, bxx = lg.b.x, bzz = lg.b.z;
      var axis = Math.atan2(bxx - ax, bzz - az);
      var lup = this._uphill((ax + bxx) * 0.5, (az + bzz) * 0.5);
      // BRACKET FUNGUS IS DERIVED FROM THE LOG, NOT FROM THE TERRAIN. The
      // shelves used to sit at `ground + range(0.10, 0.55)` with a lateral
      // offset of r * 0.85, while the log AXIS sits at ground + r * (1 - sink)
      // with r = 0.46-0.62 - so a shelf at ground + 0.10 was inside the trunk
      // and one at ground + 0.55 was hovering beside it. At four metres in
      // enemy_closeup they read exactly as they were: stickers.
      //
      // Sample the axis at t, offset perpendicular by r * 0.95, and put the
      // shelf at axisY + r * sin(theta) for a theta in the LOWER hemisphere so
      // the growth clings to the shaded flank. Four or five per log, in one or
      // two clusters rather than distributed on R.next() - fungus fruits where
      // the mycelium already is.
      if (B.fungus) {
        var lr = lg.r || 0.5;
        var ay0 = lg.a.y, by0 = lg.b.y;
        var clusters = R.int(1, 2);
        for (var cl = 0; cl < clusters; cl++) {
          var ct = R.range(0.18, 0.82);
          var cside = R.bool() ? 1.5708 : -1.5708;
          var cn = R.int(2, 3);
          for (j = 0; j < cn; j++) {
            var t2 = M.clamp(ct + R.gaussian(0, 0.055), 0.06, 0.94);
            var fx = ax + (bxx - ax) * t2, fz = az + (bzz - az) * t2;
            var axisY = ay0 + (by0 - ay0) * t2;
            // lower hemisphere: -0.95 .. -0.05 rad off horizontal
            var th = R.range(-0.95, -0.05);
            var fy = axisY + Math.sin(th) * lr;
            var perp = lr * 0.95 * Math.cos(th);
            B.fungus.add(T(fx + Math.sin(axis + cside) * perp, fy,
              fz + Math.cos(axis + cside) * perp,
              0, axis + cside + R.range(-0.35, 0.35), 0,
              R.range(0.8, 1.5), R.range(0.8, 1.5), R.range(0.8, 1.5)),
              hueTint(R, 1.0, 0.92, 0.74));
          }
        }
      }
      if (B.tuft) {
        for (j = 0; j < 7; j++) {
          var t3 = R.next();
          var gx = ax + (bxx - ax) * t3 + R.gaussian(0, 0.3);
          var gz = az + (bzz - az) * t3 + R.gaussian(0, 0.3);
          B.tuft.add(T(gx, this._ground(gx, gz) + (lg.r || 0.5) * R.range(0.3, 0.9), gz,
            R.range(-0.2, 0.2), R.range(0, 6.28), R.range(-0.2, 0.2),
            R.range(0.5, 0.9), R.range(0.5, 0.9), R.range(0.5, 0.9)),
            hueTint(R, 0.96, 1.06, 0.68));
        }
      }
      for (j = 0; j < 7; j++) {
        var t4 = R.next();
        this._drop(R.bool(0.6) ? B.branchS : B.branch,
          ax + (bxx - ax) * t4 + lup.x * R.range(0.5, 1.4),
          az + (bzz - az) * t4 + lup.z * R.range(0.5, 1.4),
          { r: 0.28, tilt: 0.15, yaw: axis + R.gaussian(0, 0.6),
            colour: new THREE.Color(0.78, 0.84, 0.60) });
      }
    }

    // ---- the hollows -------------------------------------------------------
    // 260 candidates, and only the CONCAVE ones are taken.  This is the whole
    // difference between deposition and scatter, and it costs one extra
    // sample of the height field per candidate.
    var b = this.bounds;
    for (i = 0; i < 260; i++) {
      var x = R.range(b.x0 + 4, b.x1 - 4);
      var z = R.range(b.z0 + 4, b.z1 - 4);
      if (this._riverA(x, z) < 1.15) continue;
      var conc = this._concavity(x, z, 1.4);
      if (conc < 0.06 + R.range(0, 0.14)) continue;
      var roll = R.next();
      var bt = roll < 0.46 ? B.branchS : (roll < 0.68 ? B.branch
        : (roll < 0.86 ? B.rock : B.husk));
      this._drop(bt, x, z, {
        r: 0.30, tilt: 0.16, yaw: R.range(0, 6.28), scale: R.range(0.65, 1.2),
        colour: (roll < 0.68)
          ? new THREE.Color(R.range(0.70, 0.92), R.range(0.76, 0.94), R.range(0.52, 0.70))
          : undefined
      });
    }

    // ---- the rock outcrop --------------------------------------------------
    var O = A && A.outcrop;
    if (O && O.centre) {
      for (i = 0; i < 26; i++) {
        var oa = R.range(0, 6.28), or2 = R.range(2.0, (O.r || 9) + 3.0);
        p = [O.centre.x + Math.sin(oa) * or2, O.centre.z + Math.cos(oa) * or2];
        this._drop(B.rock, p[0], p[1], {
          r: 0.34, tilt: 0.18, yaw: R.range(0, 6.28), scale: R.range(0.5, 1.3),
          sink: R.range(0.02, 0.14)
        });
      }
      if (B.tuft) {
        for (i = 0; i < 16; i++) {
          var ga2 = R.range(0, 6.28), gr2 = R.range(1.0, (O.r || 9));
          var gx2 = O.centre.x + Math.sin(ga2) * gr2, gz2 = O.centre.z + Math.cos(ga2) * gr2;
          B.tuft.add(T(gx2, this._surfaceY(gx2, gz2, this._ground(gx2, gz2) + 6, 9), gz2,
            0, R.range(0, 6.28), 0, R.range(0.6, 1.1), R.range(0.6, 1.1), R.range(0.6, 1.1)),
            hueTint(R, 0.98, 1.04, 0.70));
        }
      }
    }

    // ---- the sluice, which the growth is also taking -----------------------
    var S = A && A.sluice;
    if (S && S.centre) {
      var syaw = S.yaw || 0;
      for (i = 0; i < 4; i++) {
        var vx = S.centre.x + Math.cos(syaw) * R.range(-2.4, 2.4);
        var vz = S.centre.z - Math.sin(syaw) * R.range(-2.4, 2.4);
        this._vine(vx, S.centre.y + (S.h || 3.4) - 0.4, vz + 0.45,
          vx + R.gaussian(0, 0.5), S.centre.y - 0.2, vz + R.range(0.6, 1.6),
          R.range(0.1, 0.3), 0.022, 3);
      }
      this._markWall(MARK.rust, S.centre.x, S.centre.y + 1.2, S.centre.z + 0.46,
        1.2, 1.8, syaw);
      for (i = 0; i < 8; i++) {
        this._drop(B.rock, S.centre.x + R.gaussian(0, 2.6), S.centre.z + R.gaussian(0, 2.6),
          { r: 0.34, inWater: true, tilt: 0.2, scale: R.range(0.5, 1.1) });
      }
    }
  };

  // ==========================================================================
  // GROUND MARKS
  //
  // Wear follows the walking lines and nothing else.  The lines in this level
  // are short and obvious: the gate to the fire, the fire to the bunker door,
  // the bunker to the pad, the landing to the bridge.  Everything else on the
  // floor was put there by the level's own mark pass.
  // ==========================================================================
  PropsJungle.prototype._dressMarks = function () {
    var A = this.A, R = this.rng;
    var F = A && A.firebase;
    var bk = A && A.bunker;
    if (F && F.centre && bk && bk.centre) {
      var built = (this.L && this.L.builtFirebase) || null;
      var dr = (built && built.drum) ? built.drum : { x: F.centre.x, z: F.centre.z };
      var bdoor = this.fbW(-5.2, 0.4);
      this._path(dr.x, dr.z, bdoor[0], bdoor[1], 1.5, 9);
      if (F.mortarPit) this._path(dr.x, dr.z, F.mortarPit.x, F.mortarPit.z, 1.3, 8);
      if (F.mast) this._path(dr.x, dr.z, F.mast.x, F.mast.z, 1.2, 9);
    }
    // and the rust that has run off every steel thing standing in a rain forest
    var i;
    for (i = 0; i < 5; i++) {
      if (!F || !F.centre) break;
      var a = R.range(0, 6.28), r = R.range(3, (F.radius || 17) - 3);
      var x = F.centre.x + Math.sin(a) * r, z = F.centre.z + Math.cos(a) * r;
      this._mark(MARK.oil, x, z, R.range(0.9, 1.8), R.range(0.9, 1.8), R.range(0, 6.28),
        new THREE.Color(0.85, 0.92, 0.8));
    }
  };

  // ==========================================================================
  // COMMIT
  //
  // One merged mesh per static bucket, one InstancedMesh per batch, and a
  // census of both.  The census is not decoration: a batch that overflowed its
  // cap drops every instance past it and there is NOTHING in the frame that
  // says so, which is exactly the failure mode the brief names.
  // ==========================================================================
  PropsJungle.prototype._commit = function () {
    var key, i;

    for (key in this.S) {
      var parts = this.S[key];
      if (!parts || !parts.length) continue;

      // Per-part vertex counts, captured BEFORE the merge, for the one bucket
      // that needs a per-PIECE colour rather than a per-vertex field.
      var counts = null;
      if (key === 'marks') {
        counts = [];
        for (i = 0; i < parts.length; i++) {
          var pg = parts[i].geometry;
          counts.push(pg.index ? pg.index.count : pg.attributes.position.count);
        }
      }

      var uv = KEEPUV_BUCKET[key] ? 0 : (STATIC_UV[key] || 2.0);
      var geo = mergeParts(parts, uv);
      if (!geo) { disposeParts(parts); continue; }

      if (key === 'marks' && counts) {
        var n = geo.attributes.position.count;
        var carr = new Float32Array(n * 3);
        var vi = 0;
        for (i = 0; i < parts.length; i++) {
          var tc = parts[i].tintColour;
          var cr = tc ? tc.r : 1, cg = tc ? tc.g : 1, cb = tc ? tc.b : 1;
          for (var v = 0; v < counts[i] && vi < n; v++, vi++) {
            carr[vi * 3] = cr; carr[vi * 3 + 1] = cg; carr[vi * 3 + 2] = cb;
          }
        }
        for (; vi < n; vi++) { carr[vi * 3] = 1; carr[vi * 3 + 1] = 1; carr[vi * 3 + 2] = 1; }
        geo.setAttribute('color', new THREE.BufferAttribute(carr, 3));
      } else if (TINT_BUCKET[key]) {
        paintTint(geo, { noise: this.noise,
          base: key === 'leaf' ? [0.92, 1.06, 0.74] : [1, 1, 1],
          spread: key === 'ember' ? 0.06 : 0.18,
          lift: key === 'vine' ? 0.14 : 0, seed: 3.1 });
      } else {
        paintWear(geo, { noise: this.noise, grime: 0.34, edge: 0.24,
          growth: key === 'canvas' || key === 'cloth' ? 0.34 : 0.28,
          wet: key === 'canvas' || key === 'cloth' ? 0.62 : 0.55,
          hiY: 2.2, seed: 1.7 });
      }
      disposeParts(parts);

      var mat = this.mats[STATIC_MATERIAL[key]] || this.mats.wood;
      if (!mat) continue;
      var mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'jungle_props_' + key;
      mesh.castShadow = !NOSHADOW_BUCKET[key];
      mesh.receiveShadow = key !== 'ember';
      if (key === 'marks') mesh.renderOrder = 3;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.root.add(mesh);
    }

    // ---- the instanced batches ---------------------------------------------
    this.stats.batch = {};
    for (key in this.B) {
      var b = this.B[key];
      if (!b) continue;
      if (b.full) this.stats.full.push(key + ':' + b.max + '+' + b.full);
      this.stats.batch[key] = b.n;
      if (b.finish(this.root, 'jungle_props_' + key)) this.stats.instances += b.n;
      else this.B[key] = null;
    }

    // ---- book-keeping ------------------------------------------------------
    var draws = 0, tris = 0;
    this.root.traverse(function (o) {
      if (!o.isMesh) return;
      draws++;
      var g = o.geometry;
      if (!g || !g.attributes || !g.attributes.position) return;
      var c = g.index ? g.index.count : g.attributes.position.count;
      tris += (c / 3) * (o.isInstancedMesh ? o.count : 1);
    });
    this.stats.drawCalls = draws;
    this.stats.tris = Math.round(tris);
    this.stats.colliders = this.colliders.length;
    this.stats.skipped = this._skipped;
    this.stats.why = this._why;
    this.stats.marks = this._markCount;

    this.root.userData.colliders = this.colliders;
    this.root.userData.stats = this.stats;
    this.root.updateMatrixWorld(true);

    // Opt-in build diagnostic (index.html?...&propsdbg=1).  Written into the
    // DOM as well as the console, because headless --dump-dom can read the DOM
    // and cannot read the console.
    try {
      if (typeof location !== 'undefined' && /propsdbg=1/.test(location.search || '')) {
        var dbg = JSON.stringify({ st: this.stats, bounds: this.bounds });
        if (typeof window !== 'undefined' && window.console && console.log) {
          console.log('JUNGLEPROPS ' + dbg);
        }
        if (typeof document !== 'undefined' && document.body) {
          var el = document.createElement('div');
          el.id = 'junglepropstat';
          el.style.display = 'none';
          el.textContent = dbg;
          document.body.appendChild(el);
        }
      }
    } catch (e) { /* diagnostics never break a build */ }

    // Opt-in isolation (?propshide=marks,leaf or =1 for all).  "Which module
    // owns that object?" is otherwise unanswerable from a screenshot.
    try {
      var hm = typeof location !== 'undefined' &&
        /propshide=([A-Za-z0-9_,]+)/.exec(location.search || '');
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
    } catch (e2) { /* diagnostics never break a build */ }

    if (this.ctx && this.ctx.bus && this.ctx.bus.emit) {
      this.ctx.bus.emit('props:ready', this);
    }
  };

  // ==========================================================================
  // PER-FRAME
  //
  // Three things move.  The foliage and the cloth sway on their materials'
  // own vertex shaders (the level's for anything green, materials.js's `wind`
  // for the canvas and the laundry), so they cost nothing here.  What is left
  // is the fire, which has to flicker or it reads as a painted light, and the
  // weed on the river, which has to turn on the current or the river reads as
  // a mirror laid on the mud.
  // ==========================================================================
  var _wdir = new THREE.Vector2();

  PropsJungle.prototype.update = function (dt, ctx) {
    if (!(dt > 0)) dt = 0;
    ctx = ctx || this.ctx;
    // Drive from ctx.time where the engine provides it, so a deterministic
    // capture reproduces exactly; integrate dt otherwise.
    if (ctx && typeof ctx.time === 'number' && isFinite(ctx.time)) this.time = ctx.time;
    else this.time += dt;
    var t = this.time;

    // ---- the weather contract, consumer side -------------------------------
    // weather.js owns all of this and builds AFTER props, so the first frames
    // legitimately have no weather at all.  Read it, never write it.
    var w = ctx && ctx.weather;
    if (w) {
      if (w.windDir && isFinite(w.windDir.x) && isFinite(w.windDir.y)) {
        _wdir.copy(w.windDir);
        if (_wdir.lengthSq() > 1e-6) { _wdir.normalize(); this.windDir.copy(_wdir); }
      }
      if (typeof w.windSpeed === 'number' && isFinite(w.windSpeed)) {
        this.windSpeed = w.windSpeed;
      }
    }

    // ---- the fire ----------------------------------------------------------
    // Two beat frequencies plus a fast one: a single sine reads as a pulse,
    // and a pulse reads as an animation rather than as combustion.
    if (this.mats.ember) {
      var f = 0.80 + 0.26 * Math.sin(t * 6.3) * Math.sin(t * 2.17 + 1.1) +
        0.11 * Math.sin(t * 14.7 + 0.4);
      this.mats.ember.emissiveIntensity = this._emberBase * M.clamp(f, 0.42, 1.55);
    }

    // ---- the weed on the river ---------------------------------------------
    var hb = this.B && this.B.hyacinth;
    if (hb && hb.mesh && this.hyacinth.length) {
      var mesh = hb.mesh;
      var n = Math.min(this.hyacinth.length, mesh.count);
      var gust = 0.55 + 0.45 * M.saturate(this.windSpeed / 4);
      for (var i = 0; i < n; i++) {
        var h = this.hyacinth[i];
        var ph = t * 0.30 + h.ph;
        // it TURNS on the current and rides the swell; it does not translate,
        // because a raft that drifts leaves its own raft behind
        mesh.setMatrixAt(i, T(
          h.x + Math.sin(ph * 0.8) * 0.05 * gust,
          this.waterY - 0.03 + Math.sin(ph * 1.7) * 0.012,
          h.z + Math.cos(ph * 0.62) * 0.05 * gust,
          Math.sin(ph * 1.1) * 0.05, h.yaw + Math.sin(ph * 0.44) * 0.16,
          Math.cos(ph * 0.9) * 0.05,
          h.sc, h.sc, h.sc));
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  };

  PropsJungle.prototype.resize = function () { /* nothing viewport-dependent */ };

  PropsJungle.prototype.dispose = function () {
    var self = this;
    try {
      this.root.traverse(function (o) {
        if (o.geometry && o.geometry.dispose) o.geometry.dispose();
      });
      if (this.root.parent) this.root.parent.remove(this.root);
      // The level owns leaf / hang / bark / mud / alu - disposing one of those
      // would take the forest, the trunks, the floor or the airframe with it.
      var owned = { leaf: 1, hang: 1, bark: 1, mud: 1, alu: 1 };
      for (var k in this.mats) {
        if (owned[k]) continue;
        var m = self.mats[k];
        if (m && m.dispose) m.dispose();
      }
      for (var tkey in this.tex) {
        if (this.tex[tkey] && this.tex[tkey].dispose) this.tex[tkey].dispose();
      }
    } catch (e) { GAME.logError('propsJ.dispose', e); }
  };

  GAME.PropsJungle = PropsJungle;
})(window.GAME, window.THREE);
