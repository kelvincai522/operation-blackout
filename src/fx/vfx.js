// ============================================================================
// OPERATION BLACKOUT - src/fx/vfx.js  ->  GAME.VFX
//
// Particles, impacts, decals, tracers, shells, explosions and ambience.
//
// Design notes (the "why", so the next person does not undo them):
//
//  * Particles are simulated ENTIRELY IN THE VERTEX SHADER from spawn
//    parameters (origin, velocity, drag, gravity, spawn time). The CPU only
//    writes 26 floats per particle once, at spawn. That means a 30-round
//    magazine costs essentially nothing per frame and there is zero GC churn
//    during combat. Position is integrated analytically:
//        v' = -k*v + g    ->    p(t) = p0 + (v0 - g/k)(1-e^-kt)/k + (g/k)t
//    which is exact for linear drag, so it is perfectly frame-rate
//    independent and identical at 30fps and 144fps.
//
//  * Everything is instanced quads (InstancedBufferGeometry), not THREE.Points.
//    Point sprites cannot be stretched (sparks/tracers need it), get clipped
//    when their centre leaves the frustum, and hit a driver gl_PointSize cap.
//
//  * Soft particles: a hard quad slicing through a wall is the classic
//    amateur tell. We linearise the scene depth into our own half-res buffer
//    once per frame and fade particles against it. We copy rather than
//    sampling postfx's depth attachment directly, because reading the depth
//    texture that is currently bound to the framebuffer is a feedback loop -
//    ANGLE drops the draw call entirely and the particles vanish.
//
//  * Smoke is LIT (fake spherical normal + wrap lighting + forward-scatter
//    silver lining from the sun) instead of being flat grey. Fire/embers use
//    an analytic blackbody ramp evaluated over the particle's life.
//
//  * Nothing here throws. Every cross-module call is optional.
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  var M = GAME.Math;
  var ss = M.smoothstep;
  var sat = M.saturate;

  // ---- atlas frame indices ------------------------------------------------
  var PT = {
    SMOKE_A: 0, SMOKE_B: 1, SMOKE_C: 2, DUST: 3,
    PETAL_A: 4, PETAL_B: 5, CORE: 6, STREAK: 7,
    DOT: 8, DROP: 9, MIST: 10, CHIP: 11,
    RING: 12, GLOW: 13, FIRE: 14, EMBER: 15
  };
  var DC = {
    HOLE_A: 0, HOLE_B: 1, HOLE_METAL: 2, HOLE_WOOD: 3,
    HOLE_GLASS: 4, HOLE_SAND: 5, SCORCH: 6, SCORCH_BIG: 7,
    BLOOD_A: 8, BLOOD_B: 9, BLOOD_POOL: 10, SMEAR: 11,
    SCUFF: 12, SPALL: 13, SOOT: 14, POCK: 15
  };
  var RAMP = { NONE: 0, FIRE: 1, EMBER: 2, MUZZLE: 3 };

  var UP = new THREE.Vector3(0, 1, 0);
  var UNIT_Z = new THREE.Vector3(0, 0, 1);
  var DOWN = new THREE.Vector3(0, -1, 0);

  // scratch - module level so nothing allocates during combat
  var _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
  var _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3();
  var _v6 = new THREE.Vector3(), _v7 = new THREE.Vector3(), _v8 = new THREE.Vector3();
  var _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
  var _m1 = new THREE.Matrix4();
  var _e1 = new THREE.Euler();
  var _c1 = new THREE.Color(), _c2 = new THREE.Color();

  // ==========================================================================
  // PROCEDURAL TEXTURES
  // All particle/decal art is generated here. Tiles fade to zero alpha well
  // inside their cell so mip-mapping cannot bleed one frame into the next.
  // ==========================================================================

  // --- particle atlas tiles -------------------------------------------------
  // Each function writes straight-alpha RGBA (0..1, authored in sRGB) into out.

  function edgeMask(rn) { return 1.0 - ss(0.80, 1.0, rn); }

  // Billowing smoke card.
  //
  // The silhouette is evaluated at a DOMAIN-WARPED sample point: the position
  // fed to the noise is itself pushed around by a second, lower-frequency
  // field. That is the whole difference between "circle with fuzzy edge" and
  // "cauliflower lobes" - a plain radial-ramp-plus-noise mask cannot fold back
  // on itself, so it can only ever produce a wobbly disc. `bx/by` additionally
  // shear the silhouette off-centre so three cards do not average into a
  // circle when they overlap, and the density gradient is BAKED INTO RGB so
  // the lit branch has a core-to-rim value ramp to work with.
  function tSmoke(fq, wisp, sd, bx, by) {
    return function (u, v, N, out) {
      var dx = u - 0.5, dy = v - 0.5;
      var rn = Math.sqrt(dx * dx + dy * dy) * 2.0;
      if (rn > 1.02) return;
      var wx = N.fbm2(u * fq * 0.68 + sd, v * fq * 0.68 - sd, 3);
      var wy = N.fbm2(u * fq * 0.68 - sd * 1.7, v * fq * 0.68 + sd * 0.6, 3);
      var su = u + wx * 0.36, sv = v + wy * 0.36;
      var n = N.fbm2(su * fq, sv * fq, 4, 2.1, 0.55);
      var n2 = N.fbm2(su * fq * 3.1 + 11.0, sv * fq * 3.1 - 7.0, 3);
      var rr = rn + n * (0.34 + wisp * 0.20) + n2 * 0.15 + (dx * bx + dy * by) * 1.6;
      var a = ss(0.97, 0.26, rr);
      a *= 0.44 + 0.56 * (n2 * 0.5 + 0.5);
      a = Math.pow(sat(a), 1.20) * edgeMask(rn);
      // optical depth: thick on the axis of the lobe, thin and bright at the
      // rim where the sun gets through
      var dens = sat(1.0 - rr * 0.95);
      var d = 0.52 + 0.48 * Math.pow(1.0 - dens, 1.4);
      out[0] = d; out[1] = d * 0.995; out[2] = d * 0.975; out[3] = a;
    };
  }

  function tDust(u, v, N, out) {
    var dx = u - 0.5, dy = v - 0.5;
    var rn = Math.sqrt(dx * dx + dy * dy) * 2.0;
    if (rn > 1.02) return;
    var n = N.fbm2(u * 4.2 + 31.0, v * 4.2 - 12.0, 4);
    var grain = N.perlin2(u * 34.0, v * 34.0);
    var a = ss(1.0, 0.16, rn + n * 0.20);
    a *= 0.62 + 0.38 * (grain * 0.5 + 0.5);
    a = Math.pow(sat(a), 1.15) * edgeMask(rn);
    var d = 0.80 + 0.20 * (n * 0.5 + 0.5);
    out[0] = d; out[1] = d * 0.97; out[2] = d * 0.90; out[3] = a * 0.92;
  }

  // Muzzle flash card - a FORWARD-ONLY cone of burning propellant.
  //
  // The original tile was a symmetric N-lobed daisy radiating a full 360 deg
  // from a point kernel; five of them at random roll averaged into a
  // lens-flare starburst whose rays ran BACKWARD along the barrel. Propellant
  // gas cannot go there. +U is the bore, and everything behind the muzzle
  // plane has to fall to nothing.
  //
  // TWO things here are load-bearing and were both got wrong once already:
  //
  //  1. The forward envelope must be SMOOTH, not `max(cos(ang), 0)`. A hard
  //     mask leaves a dead-straight cut down the middle of the card, and the
  //     eye reads a straight edge on a flame as a paper cutout instantly.
  //  2. `smoothstep(radius, radius*k, rn)` is DEGENERATE when radius reaches
  //     zero - GAME.Math.smoothstep guards `e1-e0 || 1`, so it silently
  //     becomes `smoothstep(0, 1, rn)`, i.e. alpha RISING to 1 at the rim.
  //     That turned the entire back half of the card into a solid opaque
  //     half-disc: a hard-edged orange wedge sitting behind the flash hider
  //     and over the shooter's hands. Alpha is computed only where the cone
  //     actually has width, and is exactly zero elsewhere.
  function tFlash(lobes, phase, seed, spread) {
    return function (u, v, N, out) {
      var dx = u - 0.5, dy = v - 0.5;
      var rn = Math.sqrt(dx * dx + dy * dy) * 2.0;
      if (rn > 1.02) return;
      var ang = Math.atan2(dy, dx);
      var ca = Math.cos(ang), sa = Math.sin(ang);
      // smooth forward envelope: full down the bore, zero by ~95 deg off it
      var cone = Math.pow(ss(-0.10, 0.72, ca), spread);
      // seamless-in-theta noise: sample on the unit circle
      var wob = N.fbm2(ca * 2.4 + seed, sa * 2.4 - seed, 3);
      var lobe = Math.pow(Math.abs(Math.cos(ang * lobes * 0.5 + phase + wob * 0.6)), 1.6);
      // 0.32 of continuous body under the lobes: a cone whose valleys reach
      // zero is a set of separate claws, not a flame front
      var radius = (0.32 + 0.50 * lobe) * cone;
      radius += 0.30 * Math.pow(Math.max(ca, 0.0), 5.0);   // one jet down the bore
      var a = 0.0;
      if (radius > 1.5e-3) {
        a = 1.0 - ss(radius * 0.45, radius, rn);
        // erode the arms with worley, not a smooth sine: torn filaments of gas
        var w2 = N.worley2(ca * 3.6 + seed * 0.7 + 4.0, sa * 3.6 - seed * 1.3, 1.0);
        a *= 0.46 + 0.54 * ss(0.03, 0.50, w2.f1);
        // internal turbulence so the cone is burning gas, not a flat wedge
        a *= 0.52 + 0.48 * (N.fbm2(u * 7.5 + seed, v * 7.5 - seed, 4) * 0.5 + 0.5);
        a = Math.pow(sat(a), 0.62);
      }
      // opaque incandescent kernel ON the flash hider - the only part of the
      // flash allowed to clip, and what keeps the card readable when the bore
      // points at the camera and the cone is seen exactly end-on
      a = Math.max(a, 1.0 - ss(0.055, 0.115, rn));
      a = sat(a) * edgeMask(rn);
      var t = sat(rn / Math.max(radius + 0.14, 0.001));
      out[0] = 1.0;
      out[1] = M.lerp(0.94, 0.34, t);
      out[2] = M.lerp(0.76, 0.05, t);
      out[3] = a;
    };
  }

  // Hot point source with a ragged three-spike crown. Doubles as the
  // symmetric "crown" card of the muzzle flash (one card in five), the
  // detonation core and the impact pop.
  function tCore(u, v, N, out) {
    var dx = u - 0.5, dy = v - 0.5;
    var rn = Math.sqrt(dx * dx + dy * dy) * 2.0;
    if (rn > 1.02) return;
    var ang = Math.atan2(dy, dx);
    var wob = N.fbm2(Math.cos(ang) * 3.0 + 8.0, Math.sin(ang) * 3.0 - 4.0, 3);
    var spike = Math.pow(Math.abs(Math.cos(ang * 3.0 + wob * 1.5)), 22.0);
    var a = Math.pow(Math.max(0.0, 1.0 - rn), 4.6) * 0.70 + Math.exp(-rn * rn * 70.0);
    // Compact crown, NOT full-radius needles: spikes that reach the edge of
    // the card read as an anamorphic lens flare, which is the one thing a
    // muzzle flash must never look like.
    a = Math.max(a, spike * (1.0 - ss(0.06, 0.52, rn)) * 0.62);
    a = Math.max(a, 1.0 - ss(0.07, 0.14, rn));       // clipped kernel
    a = sat(a) * edgeMask(rn);
    var t = sat(rn);
    out[0] = 1.0; out[1] = M.lerp(1.0, 0.58, t); out[2] = M.lerp(0.94, 0.18, t);
    out[3] = a;
  }

  // Horizontal streak: long axis is U, bright head at u=1. The stretch mode in
  // the vertex shader aligns local X with the velocity, so this maps directly.
  function tStreak(u, v, N, out) {
    var y = v - 0.5;
    var w = 0.040 + 0.055 * u;
    var a = Math.exp(-(y * y) / (w * w)) * Math.pow(u, 1.7);
    var hx = u - 0.94, hy = y;
    a += Math.exp(-((hx * hx) + hy * hy * 1.15) / 0.0032);
    a *= 0.80 + 0.20 * (N.perlin2(u * 22.0, v * 6.0) * 0.5 + 0.5);
    a = sat(a);
    a *= 1.0 - ss(0.86, 1.0, Math.abs(y) * 2.0);
    var t = sat(u * 1.25);
    out[0] = 1.0; out[1] = M.lerp(0.45, 0.95, t); out[2] = M.lerp(0.10, 0.78, t);
    out[3] = a;
  }

  function tDot(u, v, N, out) {
    var dx = u - 0.5, dy = v - 0.5;
    var rn = Math.sqrt(dx * dx + dy * dy) * 2.0;
    if (rn > 1.02) return;
    var a = sat(Math.exp(-rn * rn * 13.0) * 0.75 + Math.exp(-rn * rn * 60.0)) * edgeMask(rn);
    out[0] = 1.0; out[1] = M.lerp(0.92, 0.5, sat(rn)); out[2] = M.lerp(0.80, 0.14, sat(rn));
    out[3] = a;
  }

  function tDrop(u, v, N, out) {
    var dx = u - 0.5, dy = v - 0.5;
    var rn = Math.sqrt(dx * dx + dy * dy) * 2.0;
    if (rn > 1.02) return;
    var ang = Math.atan2(dy, dx);
    var wob = N.fbm2(Math.cos(ang) * 3.0 + 5.0, Math.sin(ang) * 3.0 - 2.0, 3);
    var a = ss(0.86 + wob * 0.30, 0.30, rn) * edgeMask(rn);
    // blood is darker where it is thick, redder at the thin edge
    var t = sat(rn * 1.3);
    out[0] = M.lerp(0.36, 0.56, t);
    out[1] = M.lerp(0.030, 0.085, t);
    out[2] = M.lerp(0.024, 0.062, t);
    out[3] = sat(a);
  }

  function tMist(u, v, N, out) {
    var dx = u - 0.5, dy = v - 0.5;
    var rn = Math.sqrt(dx * dx + dy * dy) * 2.0;
    if (rn > 1.02) return;
    var n = N.fbm2(u * 5.5 + 19.0, v * 5.5 + 3.0, 4);
    var w = N.worley2(u * 9.0 + 2.0, v * 9.0, 1.0);
    var a = ss(1.0, 0.20, rn + n * 0.26) * (0.55 + 0.45 * (n * 0.5 + 0.5));
    a = Math.max(a, ss(0.20, 0.03, w.f1) * ss(1.0, 0.25, rn) * 0.85);
    a = sat(a) * edgeMask(rn);
    out[0] = 0.62; out[1] = 0.085; out[2] = 0.062; out[3] = a * 0.95;
  }

  function tChip(u, v, N, out) {
    var dx = u - 0.5, dy = v - 0.5;
    var rn = Math.sqrt(dx * dx + dy * dy) * 2.0;
    if (rn > 1.02) return;
    var ang = Math.atan2(dy, dx);
    // faceted polygon silhouette
    var f = Math.abs(Math.cos(ang * 2.5 + 0.9)) * 0.30 + 0.42;
    var wob = N.fbm2(Math.cos(ang) * 2.0 + 8.0, Math.sin(ang) * 2.0, 2);
    var a = ss(f + wob * 0.16, f * 0.82 + wob * 0.16, rn) * edgeMask(rn);
    var shade = 0.55 + 0.45 * ss(0.2, 0.9, 1.0 - rn) * (N.perlin2(u * 8.0, v * 8.0) * 0.5 + 0.5);
    out[0] = shade; out[1] = shade * 0.97; out[2] = shade * 0.93; out[3] = sat(a);
  }

  function tRing(u, v, N, out) {
    var dx = u - 0.5, dy = v - 0.5;
    var rn = Math.sqrt(dx * dx + dy * dy) * 2.0;
    if (rn > 1.02) return;
    var ang = Math.atan2(dy, dx);
    var wob = N.fbm2(Math.cos(ang) * 3.5 + 21.0, Math.sin(ang) * 3.5, 3);
    var r0 = 0.80 + wob * 0.05;
    var d = (rn - r0) / 0.115;
    var a = Math.exp(-d * d) * (0.60 + 0.40 * (wob * 0.5 + 0.5));
    a *= edgeMask(rn);
    out[0] = 1.0; out[1] = 0.94; out[2] = 0.86; out[3] = sat(a);
  }

  function tGlow(u, v, N, out) {
    var dx = u - 0.5, dy = v - 0.5;
    var rn = Math.sqrt(dx * dx + dy * dy) * 2.0;
    if (rn > 1.02) return;
    var a = Math.pow(Math.max(0.0, 1.0 - rn), 2.6) * edgeMask(rn);
    out[0] = 1.0; out[1] = 0.90; out[2] = 0.78; out[3] = a;
  }

  // Burning-gas card.
  //
  // The old tile was `smoothstep(1.06, 0.05, r + noise)` - a smoothstep over a
  // range of 1.01, i.e. an almost linear radial ramp - so sixteen of them
  // integrated to a uniform pale wall of noise with no lobes, no rim and no
  // volume. Three things fix that: evaluate the mask on a DOMAIN-WARPED
  // sample point (folds the field back on itself into turbulent lobes),
  // threshold TIGHTLY so the silhouette has an edge at all, and punch three
  // asymmetric tongues out of the perimeter. The density gradient is baked
  // into RGB so the blackbody ramp lookup has a core-to-rim value to bite on.
  function tFire(sd, fq) {
    return function (u, v, N, out) {
      var dx = u - 0.5, dy = v - 0.5;
      var rn = Math.sqrt(dx * dx + dy * dy) * 2.0;
      if (rn > 1.02) return;
      var ang = Math.atan2(dy, dx);
      var wx = N.fbm2(u * fq * 0.8 + sd, v * fq * 0.8 - sd, 3);
      var wy = N.fbm2(u * fq * 0.8 + sd * 2.3, v * fq * 0.8 + sd * 0.7, 3);
      var su = u + wx * 0.30, sv = v + wy * 0.30;
      var rg = N.ridged2(su * fq * 1.5 + 2.0, sv * fq * 1.5 + 9.0, 3);
      var n = N.fbm2(su * fq, sv * fq, 4, 2.2, 0.55);
      var wob = N.fbm2(Math.cos(ang) * 2.0 + sd, Math.sin(ang) * 2.0 - sd, 3);
      // Three big tongues at 0.35 normalised radii became three dead-straight
      // triangular ARMS once the card covered 300-600 screen px - a 1970s
      // star-filter, and precisely what the tCore comment warns against. Keep a
      // trace of the low-frequency asymmetry (0.10) and get the rest of the
      // silhouette break from a high-frequency ridged rim, which gives many
      // small billows instead of three giant spikes.
      var tongue = Math.pow(Math.max(0.0, Math.cos(ang * 3.0 + wob * 2.2)), 4.0) * 0.10;
      var rim = N.ridged2(Math.cos(ang) * 9.0 + sd, Math.sin(ang) * 9.0 - sd, 3);
      var rr = rn - tongue + n * 0.30 + (1.0 - rg) * 0.16 + (rim - 0.5) * 0.20;
      var a = ss(0.66, 0.30, rr);
      // a faint outer halo so 34 overlapping cards still integrate smoothly
      a = Math.max(a, ss(0.98, 0.58, rr) * 0.26);
      a = sat(a) * edgeMask(rn);
      if (a <= 0.004) return;
      var dens = sat(1.0 - rr * 1.30);
      var d = 0.20 + 0.80 * Math.pow(dens, 0.80);
      out[0] = d; out[1] = d; out[2] = d; out[3] = a;
    };
  }

  function tEmber(u, v, N, out) {
    var dx = (u - 0.5) / 0.5, dy = (v - 0.5) / 0.22;
    var rn = Math.sqrt(dx * dx + dy * dy);
    if (rn > 1.6) return;
    var a = Math.exp(-rn * rn * 3.0);
    a *= 0.70 + 0.30 * (N.perlin2(u * 18.0, v * 18.0) * 0.5 + 0.5);
    var re = Math.sqrt((u - 0.5) * (u - 0.5) + (v - 0.5) * (v - 0.5)) * 2.0;
    a = sat(a) * edgeMask(re);
    out[0] = 1.0; out[1] = 0.66; out[2] = 0.26; out[3] = a;
  }

  var PARTICLE_TILES = [
    tSmoke(2.6, 0.0, 3.0, 0.24, -0.16), tSmoke(3.9, 0.8, 21.0, -0.20, 0.22),
    tSmoke(5.4, 0.4, 47.0, 0.10, 0.26), tDust,
    tFlash(5, 0.0, 3.0, 1.00), tFlash(7, 1.1, 17.0, 1.70), tCore, tStreak,
    tDot, tDrop, tMist, tChip,
    tRing, tGlow, tFire(61.0, 3.6), tEmber
  ];

  // --- atlas builder --------------------------------------------------------
  // A hard transparent gutter is stamped into the outer 6% of every tile.
  // Without it, mip level 3+ (a 16-32 px tile) bilinear-samples across the
  // cell boundary and small particles pick up stray alpha from an unrelated
  // frame - which shows as faint square haloes on distant sparks and embers.
  function buildParticleAtlas(size, tiles, N) {
    var tile = (size / tiles) | 0;
    var data = new Uint8Array(size * size * 4);
    var out = new Float32Array(4);
    for (var idx = 0; idx < tiles * tiles; idx++) {
      var fn = PARTICLE_TILES[idx];
      if (!fn) continue;
      var ox = (idx % tiles) * tile;
      var oy = ((idx / tiles) | 0) * tile;
      for (var y = 0; y < tile; y++) {
        var v = (y + 0.5) / tile;
        var rowBase = ((oy + y) * size + ox) * 4;
        for (var x = 0; x < tile; x++) {
          out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;
          var u = (x + 0.5) / tile;
          fn(u, v, N, out);
          var gu = Math.abs(u - 0.5), gv = Math.abs(v - 0.5);
          out[3] *= 1.0 - ss(0.44, 0.494, gu > gv ? gu : gv);
          var p = rowBase + x * 4;
          data[p] = out[0] * 255; data[p + 1] = out[1] * 255;
          data[p + 2] = out[2] * 255; data[p + 3] = out[3] * 255;
        }
      }
    }
    var tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    // Colour/alpha art authored in sRGB. r180 uploads it as SRGB8_ALPHA8 so a
    // raw texture2D() in our own shader already returns LINEAR rgb. Alpha is
    // never transformed, which is exactly what we want.
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  }

  // --------------------------------------------------------------------------
  // DECAL ATLAS
  // Each tile produces albedo+alpha, a height field (converted to a tangent
  // space normal map afterwards) and an ORM triple (ao / roughness / metal).
  // A bullet hole with a dark centre, a bright cratered rim and a real normal
  // map is the difference between "sticker" and "damage".
  // out = [r,g,b,a, height, rough, metal, ao]
  // --------------------------------------------------------------------------

  function dClear(out) {
    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = 0.85; out[6] = 0; out[7] = 1;
  }

  // Shared generator for penetration damage.
  function makeHole(P) {
    return function (u, v, N, out) {
      var dx = u - 0.5, dy = v - 0.5;
      var rn = Math.sqrt(dx * dx + dy * dy) * 2.0;
      if (rn > 1.02) return;
      var ang = Math.atan2(dy, dx);
      var ca = Math.cos(ang), sa = Math.sin(ang);
      var wob = N.fbm2(ca * P.wf + P.seed, sa * P.wf - P.seed, 3);
      var det = N.fbm2(u * P.df, v * P.df + P.seed, 3);
      var grain = N.perlin2(u * 40.0 + P.seed, v * 40.0);

      var rHole = P.hole * (1.0 + wob * 0.30);
      var rRim = P.rim * (1.0 + wob * 0.42 + det * 0.10);
      var rOut = P.out * (1.0 + wob * 0.40 + det * 0.34);

      var foot = 1.0 - ss(rOut * 0.55, rOut, rn);
      if (foot <= 0.003) return;

      var inHole = 1.0 - ss(rHole * 0.60, rHole, rn);
      var rimBand = ss(rOut * 0.92, rRim, rn) * (1.0 - inHole);

      // radial fractures - concrete and glass, not metal
      var crack = 0.0;
      if (P.cracks > 0.0) {
        var cph = N.fbm2(ca * 3.0 + 40.0, sa * 3.0 + 9.0, 2);
        var sect = Math.abs(Math.sin(ang * P.cracks * 0.5 + cph * 3.4));
        crack = ss(0.11, 0.0, sect) * ss(rOut * 1.05, rHole * 0.85, rn) * P.crackAmt;
        // concentric fractures for glass
        if (P.rings > 0.0) {
          var ringPh = Math.abs(Math.sin((rn / Math.max(rOut, 0.01)) * P.rings * 3.14159 + wob * 2.0));
          crack = Math.max(crack, ss(0.12, 0.0, ringPh) * ss(rOut, rHole, rn) * P.crackAmt * 0.8);
        }
      }

      // spalled flakes around the rim (worley cells knocked out of the surface)
      var flake = 0.0;
      if (P.spall > 0.0) {
        var w = N.worley2(u * P.spallF, v * P.spallF, 1.0);
        flake = ss(0.42, 0.10, w.f1) * ss(rOut * 1.15, rRim * 0.8, rn) * P.spall;
      }

      var mix1 = M.saturate(rimBand + flake * 0.7);
      var r = M.lerp(P.baseR, P.rimR, mix1);
      var g = M.lerp(P.baseG, P.rimG, mix1);
      var b = M.lerp(P.baseB, P.rimB, mix1);
      r = M.lerp(r, P.holeR, inHole);
      g = M.lerp(g, P.holeG, inHole);
      b = M.lerp(b, P.holeB, inHole);
      var vari = 0.86 + 0.28 * (det * 0.5 + 0.5) + grain * 0.06;
      r *= vari; g *= vari; b *= vari;
      var cd = 1.0 - crack * 0.78;
      r *= cd; g *= cd; b *= cd;

      var a = sat(foot * (0.50 + 0.60 * (det * 0.5 + 0.5)));
      a = Math.max(a, inHole);
      a = Math.max(a, rimBand * 0.9);
      a = Math.max(a, crack * 0.92);
      a = Math.max(a, flake * 0.8);

      out[0] = r; out[1] = g; out[2] = b; out[3] = sat(a);
      out[4] = -1.0 * inHole + 0.55 * rimBand + 0.35 * flake - 0.55 * crack + det * 0.14 * foot;
      var rough = P.rough * (0.90 + 0.24 * (det * 0.5 + 0.5));
      rough = M.lerp(rough, P.rimRough, mix1);
      rough = M.lerp(rough, 0.96, inHole);
      out[5] = sat(rough);
      out[6] = P.rimMetal * mix1;
      out[7] = sat(1.0 - 0.90 * inHole - 0.22 * rimBand - 0.45 * crack - 0.2 * flake);
    };
  }

  function makeScorch(P) {
    return function (u, v, N, out) {
      var dx = u - 0.5, dy = v - 0.5;
      var rn = Math.sqrt(dx * dx + dy * dy) * 2.0;
      if (rn > 1.02) return;
      var ang = Math.atan2(dy, dx);
      var ca = Math.cos(ang), sa = Math.sin(ang);
      var wob = N.fbm2(ca * 2.2 + P.seed, sa * 2.2 - P.seed, 3);
      var det = N.fbm2(u * P.df, v * P.df, 4);
      var rad = P.rad * (1.0 + wob * 0.42 + det * 0.28);
      var a = ss(rad, rad * 0.20, rn) * (0.55 + 0.45 * (det * 0.5 + 0.5));
      // soot flung outward in streaks
      var streak = Math.pow(Math.abs(Math.sin(ang * P.streaks + wob * 5.0)), 3.0);
      a = Math.max(a, streak * ss(rad * 1.55, rad * 0.55, rn) * 0.55);
      a = sat(a) * edgeMask(rn);
      var t = sat(rn / Math.max(rad, 0.01));
      var lum = M.lerp(0.030, 0.115, t) * (0.75 + 0.5 * (det * 0.5 + 0.5));
      out[0] = lum * 1.05; out[1] = lum * 0.94; out[2] = lum * 0.88;
      out[3] = a * P.opacity;
      out[4] = -0.12 * a + det * 0.10 * a;
      out[5] = 0.94;
      out[6] = 0.0;
      out[7] = sat(1.0 - 0.35 * a);
    };
  }

  function makeBlood(P) {
    return function (u, v, N, out) {
      var dx = u - 0.5, dy = v - 0.5;
      var rn = Math.sqrt(dx * dx + dy * dy) * 2.0;
      if (rn > 1.02) return;
      var ang = Math.atan2(dy, dx);
      var ca = Math.cos(ang), sa = Math.sin(ang);
      var wob = N.fbm2(ca * 2.6 + P.seed, sa * 2.6 - P.seed, 3);
      var body = ss(P.rad * (1.0 + wob * 0.50), P.rad * (0.30 + wob * 0.25), rn);
      // fingers of fluid thrown out of the main pool
      var spike = Math.pow(Math.abs(Math.sin(ang * P.spikes + wob * 4.0)), 5.0);
      body = Math.max(body, ss(P.rad * (1.5 + spike * 0.85), P.rad * 0.85, rn) * spike * 0.95);
      var drop = 0.0;
      if (P.drops > 0.0) {
        var w = N.worley2(u * P.dropF + P.seed, v * P.dropF, 1.0);
        drop = ss(0.17, 0.05, w.f1) * ss(1.05, 0.45, rn) * P.drops;
      }
      var a = sat(Math.max(body, drop)) * edgeMask(rn);
      if (a <= 0.003) return;
      var t = sat(rn / Math.max(P.rad, 0.01));
      var thin = M.lerp(0.0, 1.0, t) * 0.7 + drop * 0.5;
      out[0] = M.lerp(0.30, 0.52, thin);
      out[1] = M.lerp(0.026, 0.075, thin);
      out[2] = M.lerp(0.020, 0.052, thin);
      out[3] = a;
      out[4] = 0.28 * body - 0.1 * t;
      // fresh blood is wet in the middle, tacky at the drying edge
      out[5] = M.lerp(0.16, 0.58, thin);
      out[6] = 0.0;
      out[7] = sat(1.0 - 0.30 * body);
    };
  }

  // Soft directional dust smear - stretched non-uniformly per instance.
  function tSmear(u, v, N, out) {
    var dx = u - 0.5, dy = v - 0.5;
    var rn = Math.sqrt(dx * dx + dy * dy) * 2.0;
    if (rn > 1.02) return;
    var n = N.fbm2(u * 3.4 + 71.0, v * 3.4, 4);
    var grain = N.perlin2(u * 30.0, v * 30.0);
    var a = ss(1.0, 0.12, rn + n * 0.30) * (0.45 + 0.55 * (grain * 0.5 + 0.5));
    // denser at one end so it reads as directional
    a *= M.lerp(1.0, 0.35, u);
    a = sat(a) * edgeMask(rn) * 0.75;
    var lum = 0.62 + 0.22 * (n * 0.5 + 0.5);
    out[0] = lum; out[1] = lum * 0.93; out[2] = lum * 0.79;
    out[3] = a; out[4] = 0.0; out[5] = 0.95; out[6] = 0.0; out[7] = 1.0;
  }

  function tScuff(u, v, N, out) {
    var dx = u - 0.5, dy = v - 0.5;
    var rn = Math.sqrt(dx * dx + dy * dy) * 2.0;
    if (rn > 1.02) return;
    var n = N.fbm2(u * 6.0 + 5.0, v * 6.0 + 15.0, 4);
    var w = N.worley2(u * 12.0, v * 12.0, 1.0);
    var a = ss(1.0, 0.25, rn + n * 0.30) * ss(0.55, 0.12, w.edge) * 0.8;
    a = sat(a) * edgeMask(rn);
    var lum = 0.24 + 0.18 * (n * 0.5 + 0.5);
    out[0] = lum; out[1] = lum * 0.97; out[2] = lum * 0.92;
    out[3] = a; out[4] = -0.1 * a; out[5] = 0.88; out[6] = 0.0; out[7] = sat(1.0 - 0.2 * a);
  }

  // Ring of spalled plaster - the halo left where a round chews the surface.
  function tSpall(u, v, N, out) {
    var dx = u - 0.5, dy = v - 0.5;
    var rn = Math.sqrt(dx * dx + dy * dy) * 2.0;
    if (rn > 1.02) return;
    var ang = Math.atan2(dy, dx);
    var wob = N.fbm2(Math.cos(ang) * 2.8 + 4.0, Math.sin(ang) * 2.8, 3);
    var w = N.worley2(u * 9.0, v * 9.0, 1.0);
    var band = ss(0.92 + wob * 0.14, 0.32 + wob * 0.12, rn);
    var a = band * ss(0.55, 0.16, w.f1);
    a = sat(a) * edgeMask(rn);
    var lum = 0.72 + 0.24 * (N.perlin2(u * 16.0, v * 16.0) * 0.5 + 0.5);
    out[0] = lum; out[1] = lum * 0.97; out[2] = lum * 0.90;
    out[3] = a; out[4] = 0.45 * a; out[5] = 0.90; out[6] = 0.0; out[7] = sat(1.0 - 0.25 * a);
  }

  // Soot streak - reads as a burn licking up a wall.
  function tSoot(u, v, N, out) {
    var dx = (u - 0.5) / 0.42, dy = (v - 0.5) / 0.5;
    var rn = Math.sqrt(dx * dx + dy * dy);
    if (rn > 1.4) return;
    var n = N.fbm2(u * 4.0 + 51.0, v * 2.2, 4);
    var a = ss(1.05, 0.10, rn + n * 0.32) * (0.5 + 0.5 * (n * 0.5 + 0.5));
    a *= M.lerp(1.0, 0.25, v);
    var re = Math.sqrt((u - 0.5) * (u - 0.5) + (v - 0.5) * (v - 0.5)) * 2.0;
    a = sat(a) * edgeMask(re);
    var lum = 0.045 + 0.075 * (n * 0.5 + 0.5);
    out[0] = lum; out[1] = lum * 0.95; out[2] = lum * 0.90;
    out[3] = a * 0.85; out[4] = 0.0; out[5] = 0.95; out[6] = 0.0; out[7] = sat(1.0 - 0.2 * a);
  }

  // Cluster of small pocks - a burst that did not fully penetrate.
  function tPock(u, v, N, out) {
    var dx = u - 0.5, dy = v - 0.5;
    var rn = Math.sqrt(dx * dx + dy * dy) * 2.0;
    if (rn > 1.02) return;
    var w = N.worley2(u * 5.5 + 3.0, v * 5.5 + 7.0, 1.0);
    var pock = ss(0.30, 0.06, w.f1);
    var fall = ss(1.0, 0.15, rn);
    var a = sat(pock * fall);
    if (a <= 0.003) return;
    var det = N.fbm2(u * 12.0, v * 12.0, 3);
    var deep = ss(0.16, 0.02, w.f1);
    var lum = M.lerp(0.55, 0.10, deep) * (0.85 + 0.3 * (det * 0.5 + 0.5));
    out[0] = lum; out[1] = lum * 0.98; out[2] = lum * 0.94;
    out[3] = a;
    out[4] = -0.8 * deep + 0.25 * (pock - deep);
    out[5] = sat(0.80 + 0.15 * det);
    out[6] = 0.0;
    out[7] = sat(1.0 - 0.7 * deep);
  }

  var DECAL_TILES = [
    // 0 concrete/plaster hole: pale spalled rim, radial cracks, deep dark core
    makeHole({
      seed: 3.0, wf: 2.3, df: 9.0, hole: 0.20, rim: 0.42, out: 0.72,
      baseR: 0.52, baseG: 0.50, baseB: 0.46, rimR: 0.86, rimG: 0.83, rimB: 0.75,
      holeR: 0.022, holeG: 0.021, holeB: 0.020,
      cracks: 9.0, crackAmt: 0.85, rings: 0.0, spall: 0.55, spallF: 11.0,
      rough: 0.88, rimRough: 0.78, rimMetal: 0.0
    }),
    // 1 concrete variant - wider spall, fewer cracks
    makeHole({
      seed: 19.0, wf: 3.1, df: 12.0, hole: 0.17, rim: 0.46, out: 0.80,
      baseR: 0.48, baseG: 0.47, baseB: 0.43, rimR: 0.88, rimG: 0.84, rimB: 0.74,
      holeR: 0.020, holeG: 0.019, holeB: 0.018,
      cracks: 6.0, crackAmt: 0.55, rings: 0.0, spall: 0.85, spallF: 8.0,
      rough: 0.90, rimRough: 0.72, rimMetal: 0.0
    }),
    // 2 sheet metal: tight hole, petalled bare-steel lip, no cracking
    makeHole({
      seed: 7.0, wf: 4.0, df: 16.0, hole: 0.17, rim: 0.30, out: 0.46,
      baseR: 0.16, baseG: 0.16, baseB: 0.17, rimR: 0.74, rimG: 0.76, rimB: 0.80,
      holeR: 0.012, holeG: 0.012, holeB: 0.014,
      cracks: 0.0, crackAmt: 0.0, rings: 0.0, spall: 0.0, spallF: 10.0,
      rough: 0.55, rimRough: 0.24, rimMetal: 1.0
    }),
    // 3 wood: dark fibrous hole with splinters lifting around it
    makeHole({
      seed: 23.0, wf: 5.5, df: 26.0, hole: 0.19, rim: 0.40, out: 0.66,
      baseR: 0.20, baseG: 0.14, baseB: 0.085, rimR: 0.52, rimG: 0.38, rimB: 0.21,
      holeR: 0.018, holeG: 0.013, holeB: 0.009,
      cracks: 13.0, crackAmt: 0.9, rings: 0.0, spall: 0.35, spallF: 16.0,
      rough: 0.92, rimRough: 0.86, rimMetal: 0.0
    }),
    // 4 glass: small hole, spiderweb of radial + concentric fractures
    makeHole({
      seed: 41.0, wf: 3.0, df: 10.0, hole: 0.10, rim: 0.20, out: 0.86,
      baseR: 0.62, baseG: 0.70, baseB: 0.76, rimR: 0.92, rimG: 0.96, rimB: 1.0,
      holeR: 0.05, holeG: 0.06, holeB: 0.07,
      cracks: 15.0, crackAmt: 1.0, rings: 5.0, spall: 0.0, spallF: 10.0,
      rough: 0.16, rimRough: 0.10, rimMetal: 0.0
    }),
    // 5 sand/dirt: soft crater, raised rim, no hard edge at all
    makeHole({
      seed: 11.0, wf: 2.0, df: 7.0, hole: 0.26, rim: 0.50, out: 0.86,
      baseR: 0.42, baseG: 0.35, baseB: 0.24, rimR: 0.72, rimG: 0.63, rimB: 0.45,
      holeR: 0.14, holeG: 0.11, holeB: 0.075,
      cracks: 0.0, crackAmt: 0.0, rings: 0.0, spall: 0.25, spallF: 6.0,
      rough: 0.97, rimRough: 0.95, rimMetal: 0.0
    }),
    makeScorch({ seed: 5.0, df: 7.0, rad: 0.78, streaks: 9.0, opacity: 0.85 }),
    makeScorch({ seed: 29.0, df: 4.0, rad: 0.88, streaks: 14.0, opacity: 1.0 }),
    makeBlood({ seed: 2.0, rad: 0.60, spikes: 7.0, drops: 0.85, dropF: 7.0 }),
    makeBlood({ seed: 37.0, rad: 0.44, spikes: 11.0, drops: 1.0, dropF: 5.0 }),
    makeBlood({ seed: 13.0, rad: 0.84, spikes: 4.0, drops: 0.25, dropF: 9.0 }),
    tSmear, tScuff, tSpall, tSoot, tPock
  ];

  function buildDecalAtlas(size, tiles, N) {
    var tile = (size / tiles) | 0;
    var px = size * size;
    var alb = new Uint8Array(px * 4);
    var orm = new Uint8Array(px * 4);
    var hgt = new Float32Array(px);
    var out = new Float32Array(8);
    var idx, x, y, p;
    for (idx = 0; idx < tiles * tiles; idx++) {
      var fn = DECAL_TILES[idx];
      if (!fn) continue;
      var ox = (idx % tiles) * tile;
      var oy = ((idx / tiles) | 0) * tile;
      for (y = 0; y < tile; y++) {
        var v = (y + 0.5) / tile;
        for (x = 0; x < tile; x++) {
          dClear(out);
          fn((x + 0.5) / tile, v, N, out);
          var pi = (oy + y) * size + (ox + x);
          p = pi * 4;
          alb[p] = out[0] * 255; alb[p + 1] = out[1] * 255;
          alb[p + 2] = out[2] * 255; alb[p + 3] = out[3] * 255;
          orm[p] = out[7] * 255; orm[p + 1] = out[5] * 255;
          orm[p + 2] = out[6] * 255; orm[p + 3] = 255;
          hgt[pi] = out[4];
        }
      }
    }

    // Sobel the height field into a tangent-space normal map. Sampling is
    // clamped inside each tile so one decal never leaks a slope into another.
    var nrm = new Uint8Array(px * 4);
    var strength = 2.6 * (tile / 128);
    for (idx = 0; idx < tiles * tiles; idx++) {
      var tx = (idx % tiles) * tile;
      var ty = ((idx / tiles) | 0) * tile;
      for (y = 0; y < tile; y++) {
        for (x = 0; x < tile; x++) {
          var xm = tx + (x > 0 ? x - 1 : 0);
          var xp = tx + (x < tile - 1 ? x + 1 : tile - 1);
          var ym = ty + (y > 0 ? y - 1 : 0);
          var yp = ty + (y < tile - 1 ? y + 1 : tile - 1);
          var row = (ty + y) * size;
          var dhx = (hgt[row + xp] - hgt[row + xm]) * strength;
          var dhy = (hgt[yp * size + tx + x] - hgt[ym * size + tx + x]) * strength;
          var nx = -dhx, ny = -dhy, nz = 1.0;
          var il = 1.0 / Math.sqrt(nx * nx + ny * ny + 1.0);
          p = (row + tx + x) * 4;
          nrm[p] = (nx * il * 0.5 + 0.5) * 255;
          nrm[p + 1] = (ny * il * 0.5 + 0.5) * 255;
          nrm[p + 2] = (nz * il * 0.5 + 0.5) * 255;
          nrm[p + 3] = 255;
        }
      }
    }

    function mk(buf, srgb) {
      var t = new THREE.DataTexture(buf, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.flipY = false;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = 4;
      t.needsUpdate = true;
      return t;
    }
    return { map: mk(alb, true), normalMap: mk(nrm, false), ormMap: mk(orm, false) };
  }

  // Torn paper / dry leaf card for wind-blown litter. A flat single-colour card
  // reads as white plastic at any distance, so this bakes a torn silhouette,
  // illegible newsprint, crease shading and one folded-over corner.
  function buildLitterTexture(size, N) {
    var data = new Uint8Array(size * size * 4);
    for (var y = 0; y < size; y++) {
      var v = (y + 0.5) / size;
      for (var x = 0; x < size; x++) {
        var u = (x + 0.5) / size;
        var dx = (u - 0.5) / 0.46, dy = (v - 0.5) / 0.40;
        var rn = Math.sqrt(dx * dx + dy * dy);
        // torn edge: two noise octaves so the rim is fibrous, not a smooth oval
        var tear = N.fbm2(u * 5.0 + 2.0, v * 5.0 - 3.0, 3) * 0.34 +
                   N.fbm2(u * 17.0 - 4.0, v * 17.0 + 6.0, 2) * 0.10;
        var a = rn + tear < 1.0 ? 1.0 : 0.0;
        var fold = N.fbm2(u * 7.0, v * 7.0, 3) * 0.5 + 0.5;
        var creases = 0.80 + 0.20 * fold;
        // hard crease lines: a couple of straight ridges across the sheet
        var cr = Math.abs(Math.sin((u * 0.8 + v * 1.9) * 4.7 + fold * 1.2));
        creases *= 1.0 - 0.22 * (1.0 - ss(0.0, 0.16, cr));
        var lum = creases * (0.88 + 0.12 * N.perlin2(u * 26.0, v * 26.0));

        // 4 bands of illegible newsprint at low contrast, with a masthead
        // block along the top - it is the rhythm that reads, not the letters
        var band = v * 9.0;
        var bi = Math.floor(band);
        var bf = band - bi;
        if (bi >= 2 && bi <= 7 && bf > 0.18 && bf < 0.72) {
          var glyph = N.perlin2(u * 62.0 + bi * 13.0, bi * 4.0) * 0.5 + 0.5;
          var ink = ss(0.42, 0.62, glyph);
          // ragged right margin so the column has a shape
          ink *= ss(0.90, 0.80, u) * ss(0.06, 0.14, u);
          lum *= 1.0 - 0.25 * ink;
        } else if (bi === 1 && bf > 0.25 && bf < 0.80) {
          lum *= 1.0 - 0.30 * ss(0.80, 0.62, u) * ss(0.10, 0.20, u);
        }

        // one folded-over corner: a darker triangular band in shadow
        var foldD = (u + v) - 1.62;
        if (foldD > 0.0) lum *= M.lerp(1.0, 0.58, sat(foldD * 5.0));

        var p = (y * size + x) * 4;
        // ART_DIRECTION: sun-bleached newsprint, not white plastic
        data[p] = lum * 0.52 * 255; data[p + 1] = lum * 0.50 * 255; data[p + 2] = lum * 0.45 * 255;
        data[p + 3] = a * 255;
      }
    }
    var t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    return t;
  }

  // ==========================================================================
  // SHADERS
  // ==========================================================================

  // Analytic blackbody-ish ramps.
  //
  // These are DELIBERATELY not "20x white". A filmic curve clips every channel
  // that goes far past 1, so a ramp head of (3.6, 3.0, 2.2) tone-maps to flat
  // white and throws away the colour entirely - which is exactly how a flash
  // becomes "a white sphere". The heads below keep red well above 1 while
  // holding green and blue low, so the hot band lands in saturated orange and
  // only a pinhole at the very centre is allowed to clip.
  var GLSL_RAMP = [
    'vec3 rampColor(float row, float t) {',
    '  t = clamp(t, 0.0, 1.0);',
    '  if (row < 1.5) {',                        // FIRE
    // Green and blue run LOW. postfx tonemaps with AgX, whose inset matrix
    // feeds 11-14% of red into the other two channels before the log encode:
    // a fireball at (6, 2.9, 0.7) comes out of the curve at roughly
    // (0.99, 0.93, 0.6), i.e. pale yellow-white, however saturated the source
    // was. Holding G and B down is the only lever the emitter still has.
    '    vec3 c = mix(vec3(2.45, 0.62, 0.10), vec3(1.60, 0.36, 0.055), smoothstep(0.0, 0.16, t));',
    '    c = mix(c, vec3(0.95, 0.20, 0.028), smoothstep(0.14, 0.40, t));',
    '    c = mix(c, vec3(0.30, 0.055, 0.012), smoothstep(0.38, 0.66, t));',
    '    c = mix(c, vec3(0.048, 0.043, 0.040), smoothstep(0.62, 1.0, t));',
    '    return c;',
    '  } else if (row < 2.5) {',                 // EMBER
    '    vec3 c = mix(vec3(2.6, 1.55, 0.55), vec3(1.9, 0.85, 0.22), smoothstep(0.0, 0.22, t));',
    '    c = mix(c, vec3(0.95, 0.22, 0.035), smoothstep(0.20, 0.62, t));',
    '    c = mix(c, vec3(0.22, 0.030, 0.004), smoothstep(0.58, 1.0, t));',
    '    return c;',
    '  }',
    // MUZZLE: 3200 K propellant gas. Red runs hot, blue stays down, so the
    // petal silhouette survives the tone curve as orange instead of clipping.
    // green and blue are held DOWN on purpose: at the 2.5-3.5x intensity the
    // cards run at, a head of (1.5, 0.66, 0.20) puts every channel past the
    // shoulder and the flash tone-maps to salmon-white. (1.55, 0.50, 0.09)
    // clips red only, so the gas stays orange all the way to the core.
    // Head pulled DOWN in G and B (was 1.55/0.50/0.090) while the emitters that
    // feed it were pushed up: red then clears the AgX shoulder well before
    // green does, so the gas clips to saturated ORANGE instead of arriving as a
    // low-contrast salmon body that measured 0.64 luminance against 0.90-0.95
    // sunlit plaster. Radiance now comes from the emitter, hue from here.
    '  vec3 c = mix(vec3(1.40, 0.38, 0.055), vec3(1.00, 0.24, 0.030), smoothstep(0.0, 0.30, t));',
    '  c = mix(c, vec3(0.60, 0.14, 0.024), smoothstep(0.28, 0.75, t));',
    '  c = mix(c, vec3(0.14, 0.04, 0.010), smoothstep(0.70, 1.0, t));',
    '  return c;',
    '}'
  ].join('\n');

  var PARTICLE_VERT = [
    'precision highp float;',
    'attribute vec3 aOrigin;',
    'attribute vec3 aVel;',
    'attribute vec4 aTime;',   // spawnTime, life, fadeIn, fadeOutStart
    'attribute vec4 aSize;',   // size0, size1, rot0, rotSpeed
    'attribute vec4 aColor;',  // tint.rgb, intensity
    'attribute vec4 aOpt;',    // frame, ramp, turbulence, stretch (<0 = ground plane)
    'attribute vec4 aPhys;',   // drag, gravityScale, opacity, seed',
    'attribute vec4 aMisc;',   // plumeCore (1 = optically thick axis), softDist, -, -
    'uniform float uTime;',
    'uniform vec3  uWind;',
    'uniform vec3  uAtlas;',   // tilesPerRow, 1/tilesPerRow, inset
    'uniform float uPixelScale;',
    'uniform float uMinPx;',
    // Rigid offset applied to every particle in the layer AFTER integration.
    // Zero for every world layer; the viewmodel layer writes the delta between
    // where the flash hider is NOW and where it was when the flash ignited, so
    // a 70 ms flash rides the recoil stroke instead of hanging in the air where
    // the muzzle used to be.
    'uniform vec3  uAnchor;',
    'varying vec2  vUv;',
    'varying vec2  vLocal;',
    'varying vec3  vTint;',
    'varying float vIntensity;',
    'varying float vOpacity;',
    'varying float vLifeU;',
    'varying float vRamp;',
    'varying float vViewZ;',
    'varying float vCore;',
    'varying float vSoftDist;',
    'varying vec4  vScreen;',
    '#include <fog_pars_vertex>',
    'void main() {',
    '  vUv = vec2(0.0); vLocal = vec2(0.0); vTint = vec3(0.0);',
    '  vIntensity = 0.0; vOpacity = 0.0; vLifeU = 0.0; vRamp = 0.0;',
    '  vCore = 0.0; vSoftDist = 0.25;',
    '  vViewZ = 1.0; vScreen = vec4(0.0, 0.0, 1.0, 1.0);',
    '  float t = uTime - aTime.x;',
    '  float life = max(aTime.y, 1e-4);',
    '  if (t < 0.0 || t > life) {',
    '    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);',
    '    #ifdef USE_FOG',
    '      vFogDepth = 0.0;',
    '    #endif',
    '    return;',
    '  }',
    '  float u = t / life;',
    // Exact solution of v' = -k v + g. Frame-rate independent by construction.
    '  vec3 g = vec3(0.0, -9.81 * aPhys.y, 0.0);',
    '  float k = aPhys.x;',
    '  vec3 p; vec3 vel;',
    '  if (k > 0.001) {',
    '    float e = exp(-k * t);',
    '    vec3 gk = g / k;',
    '    p = aOrigin + (aVel - gk) * ((1.0 - e) / k) + gk * t;',
    '    vel = (aVel - gk) * e + gk;',
    '  } else {',
    '    p = aOrigin + aVel * t + 0.5 * g * t * t;',
    '    vel = aVel + g * t;',
    '  }',
    '  float turb = aOpt.z;',
    '  if (turb > 0.0) {',
    '    float s = aPhys.w * 37.0;',
    '    vec3 tb = vec3(sin(t * 0.95 + s), sin(t * 0.61 + s * 1.7) * 0.55, cos(t * 1.17 + s * 2.3));',
    '    p += tb * (turb * t * 0.55);',
    '    p += uWind * (turb * t * t * 0.35);',
    '  }',
    '  p += uAnchor;',
    '  float grow = 1.0 - pow(1.0 - u, 2.2);',
    '  float size = max(mix(aSize.x, aSize.y, grow), 1e-4);',
    '  float rot = aSize.z + aSize.w * t;',
    '  float fin = max(aTime.z, 1e-4);',
    '  float fout = clamp(aTime.w, 0.02, 0.999);',
    '  float env = smoothstep(0.0, fin, u) * (1.0 - smoothstep(fout, 1.0, u));',
    '  vec2 local = position.xy;',
    '  vec4 mvPosition;',
    '  float alphaScale = 1.0;',
    '  if (aOpt.w < -0.5) {',
    // ground-plane aligned quad (shockwave rings, ground dust)
    '    float cg = cos(rot), sg = sin(rot);',
    '    vec2 lp = vec2(local.x * cg - local.y * sg, local.x * sg + local.y * cg) * size;',
    '    mvPosition = modelViewMatrix * vec4(p + vec3(lp.x, 0.0, lp.y), 1.0);',
    '  } else {',
    '    mvPosition = modelViewMatrix * vec4(p, 1.0);',
    '    vec2 off;',
    '    if (aOpt.w > 0.0) {',
    // velocity-stretched billboard: local X runs along the motion vector
    '      vec3 vv = (modelViewMatrix * vec4(vel, 0.0)).xyz;',
    '      float dl = length(vv.xy);',
    '      vec2 ax = dl > 1e-4 ? vv.xy / dl : vec2(1.0, 0.0);',
    '      vec2 pr = vec2(-ax.y, ax.x);',
    '      float stretch = 1.0 + aOpt.w * length(vel);',
    '      off = ax * (local.x * size * stretch) + pr * (local.y * size);',
    '    } else {',
    '      float cr = cos(rot), sr = sin(rot);',
    '      off = vec2(local.x * cr - local.y * sr, local.x * sr + local.y * cr) * size;',
    '    }',
    // Enforce a minimum screen size and pay for it in alpha, otherwise distant
    // sparks flicker violently as they slip between pixel centres.
    '    float viewZ = max(-mvPosition.z, 0.01);',
    '    float pxs = size * uPixelScale / viewZ;',
    '    if (pxs < uMinPx) {',
    '      float f = uMinPx / max(pxs, 1e-3);',
    '      off *= f;',
    '      alphaScale = 1.0 / (f * f);',
    '    }',
    '    mvPosition.xy += off;',
    '  }',
    '  vViewZ = max(-mvPosition.z, 0.001);',
    '  gl_Position = projectionMatrix * mvPosition;',
    '  vScreen = gl_Position;',
    '  float frame = floor(aOpt.x + 0.5);',
    '  float col = mod(frame, uAtlas.x);',
    '  float row = floor(frame / uAtlas.x);',
    '  vec2 tuv = local + 0.5;',
    '  tuv = mix(vec2(uAtlas.z), vec2(1.0 - uAtlas.z), tuv);',
    '  vUv = (vec2(col, row) + tuv) * uAtlas.y;',
    '  vLocal = local;',
    '  vTint = aColor.rgb;',
    '  vIntensity = aColor.a;',
    '  vOpacity = clamp(env * aPhys.z * alphaScale, 0.0, 4.0);',
    '  vLifeU = u;',
    '  vRamp = aOpt.y;',
    '  vCore = clamp(aMisc.x, 0.0, 1.0);',
    // Per-particle soft-particle distance: a 6 m smoke ball must dissolve over
    // ~2 m where it meets the road, a 2 cm spark over 5 cm. One uniform cannot
    // serve both, and the compromise is what makes puffs cut hard on geometry.
    '  vSoftDist = max(aMisc.y, 0.03);',
    '  #include <fog_vertex>',
    '}'
  ].join('\n');

  var PARTICLE_FRAG = [
    'precision highp float;',
    'uniform sampler2D uAtlas;',
    'uniform sampler2D uDepth;',
    'uniform float uSoft;',
    'uniform float uNearFade;',
    'uniform float uParticleFog;',
    'uniform vec3  uSunColor;',
    'uniform vec3  uSunDirView;',
    'uniform vec3  uAmbient;',
    'varying vec2  vUv;',
    'varying vec2  vLocal;',
    'varying vec3  vTint;',
    'varying float vIntensity;',
    'varying float vOpacity;',
    'varying float vLifeU;',
    'varying float vRamp;',
    'varying float vViewZ;',
    'varying float vCore;',
    'varying float vSoftDist;',
    'varying vec4  vScreen;',
    '#include <fog_pars_fragment>',
    GLSL_RAMP,
    'void main() {',
    '  vec4 tex = texture2D(uAtlas, vUv);',
    '  float a = tex.a * vOpacity;',
    '  if (a < 0.0025) discard;',
    '  vec3 col = vTint * tex.rgb;',
    '  if (vRamp > 0.5) {',
    // vCore was written for every fire puff but only ever consumed inside the
    // LIT branch, so every puff at a given age was the identical colour and a
    // fireball had no core-to-rim gradient at all. On the FIRE ramp it now
    // drives BOTH where in the blackbody ramp the puff sits (axis puffs at the
    // incandescent head, rim puffs down in the soot tail) and a 6x radiance
    // boost for the first third of life, which is the only thing in the whole
    // effect that gets past the tonemapper's shoulder. EMBER and MUZZLE are
    // deliberately left alone - they are already tuned against the curve.
    '    float tc = vLifeU;',
    '    float boost = 1.0;',
    '    if (vRamp < 1.5) {',
    '      tc = clamp(vLifeU * mix(1.55, 0.32, vCore), 0.0, 1.0);',
    // 3.2x, not 6x: past ~3x the ramp head's blue channel also clears the
    // shoulder and the axis of the fireball tone-maps to white instead of to
    // incandescent orange. Radiance is not the goal - CONTRAST against the
    // soot tail is, and 3.2x already gives a 10:1 core-to-rim ratio.
    '      boost = mix(1.0, 3.2, vCore * (1.0 - smoothstep(0.0, 0.38, vLifeU)));',
    '    }',
    '    col *= rampColor(vRamp, tc) * boost;',
    '  } else {',
    '    #ifdef LIT',
    // Fake a sphere normal from the billboard so smoke has volume, then wrap
    // light it and add a forward-scatter rim. This is what stops smoke looking
    // like a flat grey decal pasted on the screen.
    '      vec2 q = vLocal * 2.0;',
    '      float r2 = min(dot(q, q), 1.0);',
    '      vec3 n = vec3(q, sqrt(max(1.0 - r2, 0.0)));',
    '      float ndl = dot(n, uSunDirView) * 0.5 + 0.5;',
    // Self-shadow proxy: an optically thick puff cannot be lit all the way
    // through, and a puff on the plume axis is shadowed by every puff outside
    // it. Without these two terms a smoke column has a uniform interior and
    // reads as tinted fog rather than as a volume.
    '      float selfShadow = exp(-1.8 * vOpacity * (0.35 + 0.65 * vCore));',
    '      vec3 lit = uAmbient + uSunColor * (0.30 + 0.70 * ndl) * selfShadow;',
    '      float fs = pow(clamp(dot(normalize(vec3(q * 0.75, 1.0)), uSunDirView), 0.0, 1.0), 4.0);',
    // only fresh, thin smoke forward-scatters; aged soot must go dark
    '      lit += uSunColor * fs * 0.35 * (1.0 - vLifeU) * (1.0 - 0.80 * vCore);',
    '      lit *= mix(1.0, 0.30, vCore);',
    // the half of every puff facing away from the sun is visibly darker
    '      lit *= mix(1.0, 0.45, clamp(-uSunDirView.z, 0.0, 1.0) * (1.0 - ndl));',
    '      col *= lit;',
    '    #endif',
    '  }',
    '  if (uSoft > 0.5) {',
    '    vec2 suv = (vScreen.xy / max(vScreen.w, 1e-5)) * 0.5 + 0.5;',
    '    float sceneZ = texture2D(uDepth, suv).r;',
    // Reject the frame after a scenario reset, where the buffer is still the
    // clear value: fading every particle to nothing for one frame pops badly.
    '    if (sceneZ > 0.02) a *= clamp((sceneZ - vViewZ) / vSoftDist, 0.0, 1.0);',
    '  }',
    '  a *= smoothstep(uNearFade, uNearFade * 3.5, vViewZ);',
    '  vec3 outc = col * vIntensity;',
    '  #ifdef USE_FOG',
    '    #ifdef FOG_EXP2',
    '      float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);',
    '    #else',
    '      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);',
    '    #endif',
    // Particles get their OWN extinction curve. Scene fog is tuned for 60 m of
    // architecture; applying it at full strength to a fireball 30 m away
    // erases it, and applying it to deliberately dark soot replaces the soot
    // with the milky fog colour - which is how an explosion becomes pink fog.
    '    float pf = min(fogFactor * uParticleFog, 0.65);',
    '    #ifdef LIT',
    '      outc = mix(outc, fogColor, pf);',
    '    #else',
    // Emissive light punches through dust rather than being extinguished by it.
    '      outc *= mix(1.0, 1.0 - pf, 0.55);',
    '    #endif',
    '  #endif',
    '  a = clamp(a, 0.0, 1.0);',
    '  #ifdef PREMUL',
    // Premultiplied "one / one-minus-src-alpha": the puff both EMITS light and
    // OCCLUDES what is behind it. Occlusion is where 100% of a real fireball's
    // silhouette comes from - pure additive fire can only ever brighten, which
    // is why it collapses into a flat disc.
    '    gl_FragColor = vec4(outc * a, a);',
    '  #else',
    '    gl_FragColor = vec4(outc, a);',
    '  #endif',
    '  #include <colorspace_fragment>',
    '}'
  ].join('\n');

  // ==========================================================================
  // ParticleLayer - one draw call, GPU-simulated, ring-buffer allocated.
  // ==========================================================================
  var LAYER_ATTRS = [
    ['aOrigin', 3], ['aVel', 3], ['aTime', 4], ['aSize', 4],
    ['aColor', 4], ['aOpt', 4], ['aPhys', 4], ['aMisc', 4]
  ];

  // mode:
  //   'add'    additive emissive (sparks, embers, tracer smoke) - unlit
  //   'lit'    alpha-blended, wrap-lit smoke and dust
  //   'fire'   premultiplied emissive-with-occlusion (fireball, muzzle flash);
  //            emits light AND hides what is behind it, which is what gives a
  //            fireball lobes instead of a flat disc
  // (true/false are still accepted for 'lit'/'add')
  function ParticleLayer(cap, mode, atlas, sharedUniforms) {
    var lit = (mode === true || mode === 'lit');
    var premul = (mode === 'fire');
    this.mode = lit ? 'lit' : (premul ? 'fire' : 'add');
    this.cap = Math.max(16, cap | 0);
    this.head = 0;
    this.wrapped = false;
    this.maxExpire = -1;
    this._lo = 1e9;
    this._hi = -1;

    var geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0
    ]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.instanceCount = 0;
    // A huge fixed bound + frustumCulled=false: particles live in world space
    // on a mesh that never moves, so three must not try to cull them.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.arrays = {};
    this.attrs = [];
    for (var i = 0; i < LAYER_ATTRS.length; i++) {
      var name = LAYER_ATTRS[i][0], n = LAYER_ATTRS[i][1];
      var arr = new Float32Array(this.cap * n);
      var attr = new THREE.InstancedBufferAttribute(arr, n);
      attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, attr);
      this.arrays[name] = arr;
      this.attrs.push(attr);
    }
    this.geometry = geo;

    var uni = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uWind: { value: new THREE.Vector3() },
        uAtlas: { value: new THREE.Vector3(4, 0.25, 0.012) },
        uPixelScale: { value: 700 },
        uMinPx: { value: lit ? 0.0 : 1.7 },
        uAnchor: { value: new THREE.Vector3() },
        uAtlasTex: { value: null },
        uSoft: { value: 0 },
        // softness is per-particle now (aMisc.y -> vSoftDist), not per-layer
        uNearFade: { value: 0.14 },
        uParticleFog: { value: 0.45 },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        uSunDirView: { value: new THREE.Vector3(0, 1, 0) },
        uAmbient: { value: new THREE.Color(0.1, 0.12, 0.16) },
        uDepth: { value: null }
      }
    ]);
    // UniformsUtils.merge clones values; re-point the shared ones so every
    // layer sees the same live objects the VFX system updates once per frame.
    uni.uAtlas = sharedUniforms.uAtlas;
    uni.uTime = sharedUniforms.uTime;
    uni.uWind = sharedUniforms.uWind;
    uni.uPixelScale = sharedUniforms.uPixelScale;
    uni.uSoft = sharedUniforms.uSoft;
    uni.uDepth = sharedUniforms.uDepth;
    uni.uSunColor = sharedUniforms.uSunColor;
    uni.uSunDirView = sharedUniforms.uSunDirView;
    uni.uAmbient = sharedUniforms.uAmbient;
    if (sharedUniforms.uParticleFog) uni.uParticleFog = sharedUniforms.uParticleFog;
    // Only the viewmodel block declares one; everyone else keeps their own
    // permanently-zero vector, so `p += uAnchor` is a no-op there.
    if (sharedUniforms.uAnchor) uni.uAnchor = sharedUniforms.uAnchor;
    uni.uAtlasTex = { value: atlas };

    var frag = PARTICLE_FRAG.replace('uniform sampler2D uAtlas;', 'uniform sampler2D uAtlasTex;')
      .replace('texture2D(uAtlas, vUv)', 'texture2D(uAtlasTex, vUv)');
    var vert = PARTICLE_VERT;

    var defs = {};
    if (lit) defs.LIT = 1;
    if (premul) defs.PREMUL = 1;

    this.material = new THREE.ShaderMaterial({
      uniforms: uni,
      vertexShader: vert,
      fragmentShader: frag,
      defines: defs,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: premul ? THREE.CustomBlending : (lit ? THREE.NormalBlending : THREE.AdditiveBlending),
      side: THREE.DoubleSide,
      fog: true
    });
    if (premul) {
      this.material.blendSrc = THREE.OneFactor;
      this.material.blendDst = THREE.OneMinusSrcAlphaFactor;
      this.material.blendEquation = THREE.AddEquation;
      this.material.blendSrcAlpha = THREE.OneFactor;
      this.material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
      this.material.blendEquationAlpha = THREE.AddEquation;
    }

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    // lit smoke, then fire over it, then additive sparks on top
    this.mesh.renderOrder = lit ? 10 : (premul ? 11 : 12);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
  }

  ParticleLayer.prototype.emit = function (p, now) {
    var i = this.head;
    this.head = (this.head + 1) % this.cap;
    if (this.head === 0) this.wrapped = true;

    var A = this.arrays;
    var o = A.aOrigin, v = A.aVel, tm = A.aTime, sz = A.aSize;
    var cl = A.aColor, op = A.aOpt, ph = A.aPhys, ms = A.aMisc;
    var i3 = i * 3, i4 = i * 4;
    var t0 = now + p.delay;

    o[i3] = p.x; o[i3 + 1] = p.y; o[i3 + 2] = p.z;
    v[i3] = p.vx; v[i3 + 1] = p.vy; v[i3 + 2] = p.vz;
    tm[i4] = t0; tm[i4 + 1] = p.life; tm[i4 + 2] = p.fadeIn; tm[i4 + 3] = p.fadeOut;
    sz[i4] = p.size0; sz[i4 + 1] = p.size1; sz[i4 + 2] = p.rot; sz[i4 + 3] = p.rotSpd;
    cl[i4] = p.r; cl[i4 + 1] = p.g; cl[i4 + 2] = p.b; cl[i4 + 3] = p.intensity;
    op[i4] = p.frame; op[i4 + 1] = p.ramp; op[i4 + 2] = p.turb;
    op[i4 + 3] = p.ground ? -1 : p.stretch;
    ph[i4] = p.drag; ph[i4 + 1] = p.gravity; ph[i4 + 2] = p.opacity; ph[i4 + 3] = p.seed;
    ms[i4] = p.core;
    // soft-particle distance scales with the puff: derived here so no call site
    // has to think about it, overridable via p.soft.
    ms[i4 + 1] = p.soft > 0 ? p.soft : Math.max(Math.max(p.size0, p.size1) * 0.35, 0.05);
    ms[i4 + 2] = 0; ms[i4 + 3] = 0;

    if (i < this._lo) this._lo = i;
    if (i > this._hi) this._hi = i;
    var exp = t0 + p.life;
    if (exp > this.maxExpire) this.maxExpire = exp;
    return i;
  };

  ParticleLayer.prototype.flush = function (now) {
    if (this._hi >= this._lo) {
      var lo = this._lo, n = this._hi - this._lo + 1;
      for (var i = 0; i < this.attrs.length; i++) {
        var a = this.attrs[i];
        if (a.clearUpdateRanges) {
          a.clearUpdateRanges();
          a.addUpdateRange(lo * a.itemSize, n * a.itemSize);
        }
        a.needsUpdate = true;
      }
      this._lo = 1e9; this._hi = -1;
    }
    // Once every particle ever written has expired, collapse the draw to zero.
    if (now > this.maxExpire) {
      this.head = 0; this.wrapped = false;
      this.geometry.instanceCount = 0;
    } else {
      this.geometry.instanceCount = this.wrapped ? this.cap : this.head;
    }
  };

  ParticleLayer.prototype.clear = function () {
    this.head = 0; this.wrapped = false; this.maxExpire = -1;
    this.geometry.instanceCount = 0;
  };

  ParticleLayer.prototype.dispose = function () {
    this.geometry.dispose();
    this.material.dispose();
  };

  // ==========================================================================
  // TracerLayer
  // A view-space ribbon between the round's current position and a point a few
  // metres behind it. Entirely GPU driven, so a burst costs one buffer write.
  // Shape is analytic (hot core + falloff tail + bright head) - no texture.
  // ==========================================================================
  var TRACER_VERT = [
    'precision highp float;',
    'attribute vec3 aStart;',
    'attribute vec3 aDir;',
    'attribute vec4 aParams;',   // spawnTime, speed, maxDist, tailLen
    'attribute vec4 aStyle;',    // rgb, intensity
    'attribute vec4 aExtra;',    // width, fadeDist, seed, unused
    'uniform float uTime;',
    'uniform float uPixelScale;',
    'uniform float uMinPx;',
    'uniform float uMaxPx;',
    'varying vec2  vT;',
    'varying vec3  vCol;',
    'varying float vI;',
    'varying vec4  vScreen;',
    'varying float vViewZ;',
    '#include <fog_pars_vertex>',
    'void main() {',
    '  vT = vec2(0.0); vCol = vec3(0.0); vI = 0.0;',
    '  vScreen = vec4(0.0, 0.0, 1.0, 1.0); vViewZ = 1.0;',
    '  float t = uTime - aParams.x;',
    '  float travel = aParams.y * t;',
    '  float maxD = aParams.z;',
    '  float tail = max(aParams.w, 0.01);',
    '  if (t < 0.0 || travel > maxD + tail) {',
    '    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);',
    '    #ifdef USE_FOG',
    '      vFogDepth = 0.0;',
    '    #endif',
    '    return;',
    '  }',
    '  float hd = min(travel, maxD);',
    '  float td = max(0.0, hd - tail * clamp(travel / tail, 0.0, 1.0));',
    '  vec4 hv = modelViewMatrix * vec4(aStart + aDir * hd, 1.0);',
    '  vec4 tv = modelViewMatrix * vec4(aStart + aDir * td, 1.0);',
    '  float s = position.x + 0.5;',
    '  vec4 pv = mix(tv, hv, s);',
    '  vec3 axis = hv.xyz - tv.xyz;',
    '  float al = length(axis);',
    '  axis = al > 1e-5 ? axis / al : vec3(0.0, 1.0, 0.0);',
    '  vec3 toEye = normalize(-pv.xyz + vec3(0.0, 0.0, 1e-5));',
    '  vec3 perp = cross(axis, toEye);',
    '  float pl = length(perp);',
    '  perp = pl > 1e-5 ? perp / pl : vec3(1.0, 0.0, 0.0);',
    // CONSTANT screen width, clamped from BOTH ends. A 20 mm ribbon is
    // sub-pixel past ~15 m and aliases into nothing; the segment nearest the
    // lens is the exact opposite problem - 0.044 m at 0.5 m projects to ~41 px,
    // i.e. a 40 px pale wedge across the foreground that reads as a light leak
    // rather than as a tracer. A real tracer is a couple of pixels wide at any
    // range and gets its punch from RADIANCE, not from area.
    '  float widen = 1.0;',
    '  float viewZt = max(-pv.z, 0.02);',
    '  float pxw = aExtra.x * 2.0 * uPixelScale / viewZt;',
    '  if (pxw < uMinPx) widen = uMinPx / max(pxw, 1e-3);',
    '  else if (pxw > uMaxPx) widen = uMaxPx / pxw;',
    '  pv.xyz += perp * (position.y * aExtra.x * 2.0 * widen);',
    '  gl_Position = projectionMatrix * pv;',
    '  vScreen = gl_Position;',
    '  vViewZ = max(-pv.z, 0.001);',
    '  vT = vec2(s, position.y * 2.0);',
    '  vCol = aStyle.rgb;',
    '  float fade = 1.0 - smoothstep(aExtra.y * 0.45, aExtra.y, travel);',
    // No distance-travelled fade-in: the first metre out of the barrel is
    // exactly where a tracer sells the shot. Instead fade by VIEW depth, so
    // the beam never smears across the lens but is bright at the muzzle.
    '  fade *= smoothstep(0.30, 1.10, viewZt);',
    '  fade *= 1.0 - smoothstep(maxD - 0.8, maxD + tail, travel);',
    // Two-sided energy compensation. Widening a distant ribbon dims it;
    // NARROWING the near one has to brighten it, otherwise 8.0 of intensity
    // stays smeared across the 40 px it was spread over and the fix reads as
    // "the tracer got fainter" instead of "the tracer got sharper".
    '  vI = aStyle.a * fade * clamp(1.0 / max(widen, 1e-4), 0.30, 3.0);',
    '  vec4 mvPosition = pv;',
    '  #include <fog_vertex>',
    '}'
  ].join('\n');

  var TRACER_FRAG = [
    'precision highp float;',
    'uniform sampler2D uDepth;',
    'uniform float uSoft;',
    'uniform float uParticleFog;',
    'varying vec2  vT;',
    'varying vec3  vCol;',
    'varying float vI;',
    'varying vec4  vScreen;',
    'varying float vViewZ;',
    '#include <fog_pars_fragment>',
    'void main() {',
    '  float x = clamp(vT.x, 0.0, 1.0);',
    '  float y = abs(vT.y);',
    '  float core = exp(-y * y * 15.0);',
    '  float glow = exp(-y * y * 2.4) * 0.32;',
    '  float taper = pow(x, 1.6);',
    '  float head = exp(-pow((1.0 - x) * 7.5, 2.0));',
    '  float a = core * taper + glow * taper + head * 0.85;',
    '  a = clamp(a, 0.0, 1.0);',
    '  if (a * vI < 0.002) discard;',
    // Only the HEAD goes white-hot. Mixing the whole core line toward white
    // turned every tracer into a white bar and threw away the one thing that
    // identifies it as burning tracer compound: the amber body.
    '  vec3 col = mix(vCol, vec3(1.0, 0.93, 0.74), clamp(core * 0.22 + head * 0.9, 0.0, 1.0));',
    '  col *= vI;',
    '  if (uSoft > 0.5) {',
    '    vec2 suv = (vScreen.xy / max(vScreen.w, 1e-5)) * 0.5 + 0.5;',
    '    float sceneZ = texture2D(uDepth, suv).r;',
    '    if (sceneZ > 0.02) a *= clamp((sceneZ - vViewZ) / 0.25, 0.0, 1.0);',
    '  }',
    '  #ifdef USE_FOG',
    '    #ifdef FOG_EXP2',
    '      float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);',
    '    #else',
    '      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);',
    '    #endif',
    '    float pf = min(fogFactor * uParticleFog, 0.65);',
    '    col *= mix(1.0, 1.0 - pf, 0.55);',
    '  #endif',
    '  gl_FragColor = vec4(col, a);',
    '  #include <colorspace_fragment>',
    '}'
  ].join('\n');

  function TracerLayer(cap, shared) {
    this.cap = Math.max(8, cap | 0);
    this.head = 0;
    this.wrapped = false;
    this.maxExpire = -1;
    this._lo = 1e9; this._hi = -1;

    var geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0
    ]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    var defs = [['aStart', 3], ['aDir', 3], ['aParams', 4], ['aStyle', 4], ['aExtra', 4]];
    this.arrays = {}; this.attrs = [];
    for (var i = 0; i < defs.length; i++) {
      var arr = new Float32Array(this.cap * defs[i][1]);
      var attr = new THREE.InstancedBufferAttribute(arr, defs[i][1]);
      attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(defs[i][0], attr);
      this.arrays[defs[i][0]] = arr;
      this.attrs.push(attr);
    }
    this.geometry = geo;

    var uni = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 }, uDepth: { value: null }, uSoft: { value: 0 },
      uPixelScale: { value: 700 }, uMinPx: { value: 2.2 }, uMaxPx: { value: 3.6 },
      uParticleFog: { value: 0.45 }
    }]);
    uni.uTime = shared.uTime;
    uni.uDepth = shared.uDepth;
    uni.uSoft = shared.uSoft;
    uni.uPixelScale = shared.uPixelScale;
    if (shared.uParticleFog) uni.uParticleFog = shared.uParticleFog;

    this.material = new THREE.ShaderMaterial({
      uniforms: uni,
      vertexShader: TRACER_VERT,
      fragmentShader: TRACER_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: true
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 13;
  }

  TracerLayer.prototype.emit = function (from, dir, dist, speed, width, r, g, b, intensity, tail, now) {
    var i = this.head;
    this.head = (this.head + 1) % this.cap;
    if (this.head === 0) this.wrapped = true;
    var A = this.arrays, i3 = i * 3, i4 = i * 4;
    A.aStart[i3] = from.x; A.aStart[i3 + 1] = from.y; A.aStart[i3 + 2] = from.z;
    A.aDir[i3] = dir.x; A.aDir[i3 + 1] = dir.y; A.aDir[i3 + 2] = dir.z;
    A.aParams[i4] = now; A.aParams[i4 + 1] = speed;
    A.aParams[i4 + 2] = dist; A.aParams[i4 + 3] = tail;
    A.aStyle[i4] = r; A.aStyle[i4 + 1] = g; A.aStyle[i4 + 2] = b; A.aStyle[i4 + 3] = intensity;
    // aExtra.y is the distance over which the trace BURNS OUT, and it must be a
    // property of the round, not of this particular shot. Setting it to the
    // shot distance made `fade = 1 - smoothstep(0.45*d, d, travel)` reach zero
    // at exactly the moment the ribbon finished forming: a 12 m engagement got
    // a tracer that was already invisible by the time it spanned the 12 m, and
    // the persistence pass behind it was faded out on the same curve. Real
    // tracer compound burns for 700-900 m; 60 m of frame is always "fresh".
    A.aExtra[i4] = width;
    A.aExtra[i4 + 1] = Math.max(dist * 2.0, 60);
    A.aExtra[i4 + 2] = 0; A.aExtra[i4 + 3] = 0;
    if (i < this._lo) this._lo = i;
    if (i > this._hi) this._hi = i;
    var exp = now + (dist + tail) / Math.max(speed, 1);
    if (exp > this.maxExpire) this.maxExpire = exp;
  };

  TracerLayer.prototype.flush = ParticleLayer.prototype.flush;
  TracerLayer.prototype.clear = ParticleLayer.prototype.clear;
  TracerLayer.prototype.dispose = ParticleLayer.prototype.dispose;

  // ==========================================================================
  // DustField - drifting motes that wrap around the camera forever.
  // Strong forward scattering makes them blaze when you look toward the sun,
  // which is what sells "shafts of light in a dusty street".
  // ==========================================================================
  // 4 x 2 x 4 CPU-raycast sun-visibility cells around the camera. Motes only
  // blaze where the sun genuinely reaches, which is what makes a light shaft a
  // shaft instead of a fixed world-space lattice with no relationship to the
  // geometry (the old `sin(p.x*0.82)*cos(p.z*0.66)` did exactly that).
  var DUST_CELLS_X = 4, DUST_CELLS_Y = 2, DUST_CELLS_Z = 4;
  var DUST_CELLS = DUST_CELLS_X * DUST_CELLS_Y * DUST_CELLS_Z;

  var DUST_VERT = [
    'precision highp float;',
    'attribute vec4 aSeed;',    // base position inside the box + phase
    'attribute vec2 aStyle;',   // size, brightness
    'uniform float uTime;',
    'uniform vec3  uWind;',
    'uniform vec3  uCamPos;',
    'uniform vec3  uBox;',
    'uniform vec3  uSunDir;',
    'uniform float uPixelScale;',
    'uniform float uDensity;',
    'uniform float uCap;',
    'uniform float uShaftFloor;',
    'uniform float uShaft[' + DUST_CELLS + '];',
    'varying vec2  vLocal;',
    'varying float vBright;',
    'varying vec4  vScreen;',
    'varying float vViewZ;',
    '#include <fog_pars_vertex>',
    'void main() {',
    '  vLocal = vec2(0.0); vBright = 0.0;',
    '  vScreen = vec4(0.0, 0.0, 1.0, 1.0); vViewZ = 1.0;',
    '  float ph = aSeed.w;',
    '  if (ph > uDensity) {',
    '    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);',
    '    #ifdef USE_FOG',
    '      vFogDepth = 0.0;',
    '    #endif',
    '    return;',
    '  }',
    '  vec3 drift = vec3(sin(uTime * 0.21 + ph * 41.0) * 0.42,',
    '                    sin(uTime * 0.16 + ph * 27.0) * 0.26,',
    '                    cos(uTime * 0.19 + ph * 63.0) * 0.42);',
    '  vec3 p = aSeed.xyz + drift + uWind * (uTime * 0.11);',
    '  vec3 rel = mod(p - uCamPos + uBox * 0.5, uBox) - uBox * 0.5;',
    '  p = uCamPos + rel;',
    '  float dist = length(rel);',
    '  vec3 vd = rel / max(dist, 1e-3);',
    // Henyey-Greenstein, g = 0.55. The old cos^5 lobe was zero outside a ~30
    // deg cone around the sun, which switched the ENTIRE field off in any shot
    // whose camera does not face the sun - the interior hero shot being
    // exactly that. HG still peaks hard forward but holds ~0.12 at 90 deg and
    // ~0.05 looking away, so a mote standing in a sunbeam is visible from any
    // angle. "Is this mote lit" and "am I looking at the sun" are now two
    // separate terms, which is the whole reason a shaft reads as a shaft.
    '  float cosT = dot(vd, uSunDir);',
    '  const float g = 0.55;',
    '  float hgd = 1.0 + g * g - 2.0 * g * cosT;',
    '  float hg = (1.0 - g * g) / max(pow(hgd, 1.5), 1e-3) * 0.25;',
    // sun visibility of the cell this mote is currently sitting in
    '  vec3 cell = floor((rel / uBox + 0.5) * vec3(' +
      DUST_CELLS_X + '.0, ' + DUST_CELLS_Y + '.0, ' + DUST_CELLS_Z + '.0));',
    '  cell = clamp(cell, vec3(0.0), vec3(' +
      (DUST_CELLS_X - 1) + '.0, ' + (DUST_CELLS_Y - 1) + '.0, ' + (DUST_CELLS_Z - 1) + '.0));',
    '  int ci = int(cell.x + cell.y * ' + DUST_CELLS_X + '.0 + cell.z * ' +
      (DUST_CELLS_X * DUST_CELLS_Y) + '.0);',
    '  float shaft = uShaft[0];',
    '  for (int k = 0; k < ' + DUST_CELLS + '; k++) { if (k == ci) shaft = uShaft[k]; }',
    // fine structure INSIDE a lit cell: bands running along the light, not a
    // world-axis lattice, so the mote pattern follows the sun direction
    '  vec3 perp = normalize(cross(uSunDir, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));',
    '  float band = 0.55 + 0.45 * sin(dot(p, perp) * 0.9 + p.y * 0.35 + ph * 6.0);',
    // Sun visibility is MULTIPLICATIVE on a large base, not a floor that the
    // scattering lobe has to rescue: a mote in a sunlit cell blazes, a mote in
    // shadow vanishes. That contrast is what makes a light shaft legible.
    //
    // uShaftFloor is what a mote in an UNLIT cell is worth. Outdoors that is
    // essentially nothing. Indoors it cannot be: the sun-visibility probe
    // raycasts straight at the sun, and inside a room with a ceiling every
    // single cell is occluded, so a 0.05 floor switches the entire interior
    // field off - which is exactly why the interior hero shot had no motes at
    // all. A gutted shop full of skylight-lit dust is the correct read there.
    // uShaftFloor is a straight GAIN for the environment (thin outdoors, dense
    // in a gutted room) and sun/sky visibility multiplies it. Written as
    // mix(floor, 2.20, shaft) the two fought each other: raising the indoor
    // floor above 2.20 made LIT cells darker than shadowed ones and inverted
    // the shaft, which is the one thing this field exists to draw.
    '  float bright = aStyle.y * (0.25 + 1.10 * hg) * uShaftFloor',
    '               * mix(1.0, 3.4, shaft) * mix(0.72, 1.0, band);',
    // The far cut used to sit at 30-48% of the box, which in a 10 m interior
    // put the entire field inside a 3-4.8 m shell - a room's worth of dust
    // clipped away just past the counter. 45-70% keeps motes all the way to the
    // far wall indoors and 13-21 m down the street outdoors.
    '  bright *= 1.0 - smoothstep(uBox.x * 0.45, uBox.x * 0.70, dist);',
    // A mote a hand's width from the lens is not atmosphere, it is a speck on
    // the sensor - but the near motes are also the ones that subtend any solid
    // angle at all, so excluding everything inside 1.3 m threw away most of the
    // field's on-screen presence for the sake of a problem that starts at 0.3 m.
    '  bright *= smoothstep(0.35, 0.85, dist);',
    '  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);',
    '  float viewZ = max(-mvPosition.z, 0.01);',
    '  float size = aStyle.x;',
    '  float pxs = size * uPixelScale / viewZ;',
    // The Gaussian in this card falls to 2e-4 at the quad edge, so a "1.5 px"
    // mote whose brightness has ALSO been divided by f-squared for the area it
    // did not really gain covers a fraction of one pixel at a fraction of its
    // value - i.e. it integrates to nothing, which is why 900 motes were
    // invisible in every capture. Hold 2.0 px and compensate only partially:
    // energy conservation is the wrong objective for something whose whole job
    // is to be a legible speck.
    '  if (pxs < 2.4) {',
    '    float f = 2.4 / max(pxs, 1e-3);',
    '    size *= f;',
    '    bright /= (1.0 + (f - 1.0) * 1.35);',
    '  }',
    // and hard-cap the apparent size: dust is a point, never a disc
    '  else if (pxs > 4.0) { size *= 4.0 / pxs; }',
    '  mvPosition.xy += position.xy * size;',
    '  vViewZ = viewZ;',
    '  gl_Position = projectionMatrix * mvPosition;',
    '  vScreen = gl_Position;',
    '  vLocal = position.xy;',
    // Cap, not clip. Outdoors a mote is a grey-warm speck and an uncapped
    // additive value reads as sensor dust on the lens; inside a window shaft
    // motes are allowed to bloom, so the cap is driven per-environment.
    '  vBright = min(bright, uCap);',
    '  #include <fog_vertex>',
    '}'
  ].join('\n');

  var DUST_FRAG = [
    'precision highp float;',
    'uniform vec3 uTint;',
    'uniform sampler2D uDepth;',
    'uniform float uSoft;',
    'varying vec2  vLocal;',
    'varying float vBright;',
    'varying vec4  vScreen;',
    'varying float vViewZ;',
    '#include <fog_pars_fragment>',
    'void main() {',
    '  vec2 q = vLocal * 2.0;',
    '  float r2 = dot(q, q);',
    '  float a = exp(-r2 * 4.2) * (1.0 - smoothstep(0.65, 1.0, sqrt(r2)));',
    '  a *= vBright;',
    '  if (a < 0.0015) discard;',
    // depth-soften: a mote that intersects a wall must dissolve into it
    '  if (uSoft > 0.5) {',
    '    vec2 suv = (vScreen.xy / max(vScreen.w, 1e-5)) * 0.5 + 0.5;',
    '    float sceneZ = texture2D(uDepth, suv).r;',
    '    if (sceneZ > 0.02) a *= clamp((sceneZ - vViewZ) / 0.40, 0.0, 1.0);',
    '  }',
    '  vec3 col = uTint;',
    '  #ifdef USE_FOG',
    '    #ifdef FOG_EXP2',
    '      float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);',
    '    #else',
    '      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);',
    '    #endif',
    '    col *= (1.0 - fogFactor);',
    '  #endif',
    '  gl_FragColor = vec4(col * a, clamp(a, 0.0, 1.0));',
    '  #include <colorspace_fragment>',
    '}'
  ].join('\n');

  function DustField(cap, rng, shared) {
    this.cap = Math.max(32, cap | 0);
    var geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0
    ]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.instanceCount = this.cap;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    var box = new THREE.Vector3(28, 10, 28);
    var seed = new Float32Array(this.cap * 4);
    var style = new Float32Array(this.cap * 2);
    for (var i = 0; i < this.cap; i++) {
      seed[i * 4] = rng.range(0, box.x);
      seed[i * 4 + 1] = rng.range(0, box.y);
      seed[i * 4 + 2] = rng.range(0, box.z);
      // phase doubles as the density cut-off, so lowering uDensity thins the
      // field evenly instead of chopping off one corner of the box.
      seed[i * 4 + 3] = (i + 0.5) / this.cap;
      var big = rng.bool(0.14);
      // roughly 2x the old radii: at 469 px/m a 4 mm mote is a third of a pixel
      // at 5 m, which is below the point where anything can be done with it
      style[i * 2] = big ? rng.range(0.016, 0.030) : rng.range(0.006, 0.014);
      style[i * 2 + 1] = rng.range(0.35, 1.0) * (big ? 1.25 : 1.0);
    }
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
    geo.setAttribute('aStyle', new THREE.InstancedBufferAttribute(style, 2));
    this.geometry = geo;

    var shaft = new Float32Array(DUST_CELLS);
    for (i = 0; i < DUST_CELLS; i++) shaft[i] = 0.5;

    var uni = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 }, uWind: { value: new THREE.Vector3() },
      uCamPos: { value: new THREE.Vector3() }, uBox: { value: box.clone() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uPixelScale: { value: 700 }, uDensity: { value: 1 }, uCap: { value: 0.75 },
      uShaftFloor: { value: 0.05 },
      uTint: { value: new THREE.Color(1.0, 0.86, 0.66) },
      uDepth: { value: null }, uSoft: { value: 0 }
    }]);
    uni.uTime = shared.uTime;
    uni.uWind = shared.uWind;
    uni.uPixelScale = shared.uPixelScale;
    uni.uDepth = shared.uDepth;
    uni.uSoft = shared.uSoft;
    uni.uBox.value.copy(box);
    // UniformsUtils.merge cannot clone a typed-array uniform, so add it after.
    uni.uShaft = { value: shaft };

    this.material = new THREE.ShaderMaterial({
      uniforms: uni,
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: true
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 14;
    this.box = box;
    this.shaft = shaft;
    this._cell = 0;
  }

  DustField.prototype.update = function (camPos, sunDir, tint) {
    var u = this.material.uniforms;
    u.uCamPos.value.copy(camPos);
    if (sunDir) u.uSunDir.value.copy(sunDir);
    if (tint) u.uTint.value.copy(tint);
  };

  // Density/box are driven by the environment the camera is actually in: a
  // gutted interior wants a small, dense, warm field, a rooftop a thin one.
  DustField.prototype.setBox = function (x, y, z) {
    this.box.set(x, y, z);
    this.material.uniforms.uBox.value.copy(this.box);
  };
  DustField.prototype.setDensity = function (d) {
    this.material.uniforms.uDensity.value = M.clamp(d, 0.0, 1.6);
  };
  DustField.prototype.setTint = function (r, g, b) {
    this.material.uniforms.uTint.value.setRGB(r, g, b);
  };
  DustField.prototype.setCap = function (c) {
    this.material.uniforms.uCap.value = M.clamp(c, 0.05, 2.5);
  };
  DustField.prototype.setShaftFloor = function (f) {
    this.material.uniforms.uShaftFloor.value = M.clamp(f, 0.0, 16.0);
  };

  // Refresh a few sun-visibility cells per frame. 32 cells at ~6/frame means
  // the whole field is current inside 6 frames for a walking player, at a cost
  // of six raycasts - versus one raycast per mote, which we cannot afford.
  var _du1 = new THREE.Vector3();
  DustField.prototype.probe = function (camPos, sunDir, level, count) {
    if (!level || !level.raycast) return;
    var b = this.box;
    for (var k = 0; k < count; k++) {
      var i = this._cell;
      this._cell = (this._cell + 1) % DUST_CELLS;
      var cx = i % DUST_CELLS_X;
      var cy = ((i / DUST_CELLS_X) | 0) % DUST_CELLS_Y;
      var cz = (i / (DUST_CELLS_X * DUST_CELLS_Y)) | 0;
      _du1.set(
        camPos.x + ((cx + 0.5) / DUST_CELLS_X - 0.5) * b.x,
        camPos.y + ((cy + 0.5) / DUST_CELLS_Y - 0.5) * b.y,
        camPos.z + ((cz + 0.5) / DUST_CELLS_Z - 0.5) * b.z
      );
      // TWO visibilities, not one. A single ray straight at a 14 deg sun,
      // cast from inside a 14 m canyon flanked by 2-4 storey buildings, is
      // occluded in essentially every cell - so the field measured "unlit"
      // everywhere and collapsed onto the near-zero shadow floor, switching
      // itself off in exactly the scene it was written for. Open shadow still
      // scatters skylight; a mote under open sky is dim, not absent.
      var vis = 1, sky = 1;
      try {
        var r = level.raycast(_du1, sunDir, 40);
        if (r && r.hit) vis = 0;
        var ru = level.raycast(_du1, UP, 12);
        if (ru && ru.hit) sky = 0;
      } catch (e) { vis = this.shaft[i]; sky = vis; }
      var v = vis * 0.75 + sky * 0.25;
      // temporal smoothing so a mote field does not strobe as cells flip
      this.shaft[i] += (v - this.shaft[i]) * 0.5;
    }
  };

  DustField.prototype.dispose = function () {
    this.geometry.dispose(); this.material.dispose();
  };

  // ==========================================================================
  // DepthLinearizer
  // Copies whatever depth attachment postfx exposes into our own half-res
  // R-channel buffer of LINEAR view depth. We never sample postfx's depth
  // texture directly during the scene pass: that texture is bound to the
  // active framebuffer, and reading it forms a feedback loop that ANGLE
  // resolves by silently dropping the draw call.
  // ==========================================================================
  function DepthLinearizer(w, h) {
    this.rt = new THREE.WebGLRenderTarget(Math.max(2, w >> 1), Math.max(2, h >> 1), {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false
    });
    this.rt.texture.colorSpace = THREE.NoColorSpace;
    this.material = new THREE.ShaderMaterial({
      uniforms: { tDepth: { value: null }, uNF: { value: new THREE.Vector2(0.05, 600) } },
      vertexShader: [
        'varying vec2 vUv;',
        'void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }'
      ].join('\n'),
      fragmentShader: [
        'precision highp float;',
        'uniform sampler2D tDepth;',
        'uniform vec2 uNF;',
        'varying vec2 vUv;',
        'void main() {',
        '  float d = texture2D(tDepth, vUv).x;',
        '  float ndc = d * 2.0 - 1.0;',
        '  float z = (2.0 * uNF.x * uNF.y) / (uNF.y + uNF.x - ndc * (uNF.y - uNF.x));',
        '  gl_FragColor = vec4(z, 0.0, 0.0, 1.0);',
        '}'
      ].join('\n'),
      depthTest: false,
      depthWrite: false
    });
    this.mesh = new THREE.Mesh(GAME.fullscreenGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  DepthLinearizer.prototype.run = function (renderer, depthTexture, near, far) {
    this.material.uniforms.tDepth.value = depthTexture;
    this.material.uniforms.uNF.value.set(near, far);
    var prevTarget = renderer.getRenderTarget();
    var prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.rt);
    renderer.render(this.mesh, this.camera);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAuto;
  };

  DepthLinearizer.prototype.resize = function (w, h) {
    this.rt.setSize(Math.max(2, w >> 1), Math.max(2, h >> 1));
  };

  DepthLinearizer.prototype.dispose = function () {
    this.rt.dispose(); this.material.dispose();
  };

  // ==========================================================================
  // DecalField
  // One InstancedMesh, one draw call, real MeshStandardMaterial so decals are
  // lit and shadowed exactly like the surface they sit on. Per-instance atlas
  // rect / fade / roughness are injected with onBeforeCompile; per-instance
  // tint rides on instanceColor so a hole in asphalt is not concrete-coloured.
  // ==========================================================================
  // Private scratch: DecalField.add() is called with vectors that the caller
  // still needs afterwards, so it must never touch the shared temporaries.
  var _dv1 = new THREE.Vector3(), _dv2 = new THREE.Vector3(), _dv3 = new THREE.Vector3();
  var _dq1 = new THREE.Quaternion(), _dq2 = new THREE.Quaternion();
  var _dm1 = new THREE.Matrix4();

  function DecalField(cap, atlas, tiles) {
    this.cap = Math.max(8, cap | 0);
    this.tiles = tiles;

    var geo = new THREE.PlaneGeometry(1, 1);
    GAME.Geo.copyUV1(geo);      // aoMap conventionally reads the second UV set

    var uvRect = new Float32Array(this.cap * 4);
    var params = new Float32Array(this.cap * 2);
    for (var i = 0; i < this.cap; i++) {
      uvRect[i * 4 + 2] = 1 / tiles;
      uvRect[i * 4 + 3] = 1 / tiles;
      params[i * 2] = 0;      // fade
      params[i * 2 + 1] = 1;  // roughness multiplier
    }
    this.aUvRect = new THREE.InstancedBufferAttribute(uvRect, 4);
    this.aDecal = new THREE.InstancedBufferAttribute(params, 2);
    this.aUvRect.setUsage(THREE.DynamicDrawUsage);
    this.aDecal.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aUvRect', this.aUvRect);
    geo.setAttribute('aDecal', this.aDecal);

    var mat = new THREE.MeshStandardMaterial({
      map: atlas.map,
      normalMap: atlas.normalMap,
      roughnessMap: atlas.ormMap,
      metalnessMap: atlas.ormMap,
      aoMap: atlas.ormMap,
      aoMapIntensity: 0.9,
      roughness: 1.0,
      metalness: 1.0,
      transparent: true,
      depthWrite: false,
      // Push decals toward the camera in depth so they never z-fight with the
      // wall they are glued to, even on a shallow-angle view.
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
      side: THREE.FrontSide
    });
    mat.normalScale.set(1.25, 1.25);
    mat.onBeforeCompile = function (shader) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', [
          '#include <common>',
          'attribute vec4 aUvRect;',
          'attribute vec2 aDecal;',
          'varying float vDecalFade;',
          'varying float vDecalRough;'
        ].join('\n'))
        // begin_vertex is the most stable anchor and runs after uv_vertex, so
        // every *Uv varying already exists and can be remapped into the atlas.
        .replace('#include <begin_vertex>', [
          'vDecalFade = aDecal.x;',
          'vDecalRough = aDecal.y;',
          '#ifdef USE_MAP',
          '  vMapUv = aUvRect.xy + vMapUv * aUvRect.zw;',
          '#endif',
          '#ifdef USE_NORMALMAP',
          '  vNormalMapUv = aUvRect.xy + vNormalMapUv * aUvRect.zw;',
          '#endif',
          '#ifdef USE_ROUGHNESSMAP',
          '  vRoughnessMapUv = aUvRect.xy + vRoughnessMapUv * aUvRect.zw;',
          '#endif',
          '#ifdef USE_METALNESSMAP',
          '  vMetalnessMapUv = aUvRect.xy + vMetalnessMapUv * aUvRect.zw;',
          '#endif',
          '#ifdef USE_AOMAP',
          '  vAoMapUv = aUvRect.xy + vAoMapUv * aUvRect.zw;',
          '#endif',
          '#include <begin_vertex>'
        ].join('\n'));
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', [
          '#include <common>',
          'varying float vDecalFade;',
          'varying float vDecalRough;'
        ].join('\n'))
        .replace('#include <map_fragment>', [
          '#include <map_fragment>',
          'diffuseColor.a *= vDecalFade;'
        ].join('\n'))
        .replace('#include <roughnessmap_fragment>', [
          '#include <roughnessmap_fragment>',
          'roughnessFactor = clamp(roughnessFactor * vDecalRough, 0.045, 1.0);'
        ].join('\n'));
    };
    // Distinct cache key or three may hand us a program compiled without the
    // injected attributes (materials with identical parameters share programs).
    mat.customProgramCacheKey = function () { return 'blackout-decal'; };
    this.material = mat;

    this.mesh = new THREE.InstancedMesh(geo, mat, this.cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 2;
    this.mesh.count = this.cap;

    // every slot starts collapsed to zero scale = invisible
    _dm1.makeScale(0, 0, 0);
    var white = new THREE.Color(1, 1, 1);
    for (i = 0; i < this.cap; i++) {
      this.mesh.setMatrixAt(i, _dm1);
      this.mesh.setColorAt(i, white);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    this.slots = new Array(this.cap);
    for (i = 0; i < this.cap; i++) {
      this.slots[i] = { active: false, born: 0, ttl: 1e9, fade: 0, target: 1, fading: false, rate: 1 };
    }
    this.free = [];
    for (i = this.cap - 1; i >= 0; i--) this.free.push(i);
    this.order = [];
    this._matDirty = false;
    this._fadeDirty = false;
  }

  DecalField.prototype.add = function (point, normal, frame, sizeX, sizeY, roll,
                                       opacity, rough, tint, ttl, now, offset) {
    var slot;
    if (this.free.length) {
      slot = this.free.pop();
    } else {
      // hard overflow (a huge burst in one frame) - recycle the oldest
      slot = this.order.shift();
      if (slot === undefined) return -1;
    }
    var s = this.slots[slot];
    s.active = true; s.born = now; s.ttl = ttl;
    s.fade = 0; s.target = opacity; s.fading = false; s.rate = 8.0;
    this.order.push(slot);

    _dv1.copy(normal);
    if (_dv1.lengthSq() < 1e-8) _dv1.set(0, 1, 0);
    _dv1.normalize();
    _dq1.setFromUnitVectors(UNIT_Z, _dv1);
    _dq2.setFromAxisAngle(UNIT_Z, roll);
    _dq1.multiply(_dq2);
    _dv2.copy(point).addScaledVector(_dv1, offset === undefined ? 0.012 : offset);
    _dv3.set(sizeX, sizeY, 1);
    _dm1.compose(_dv2, _dq1, _dv3);
    this.mesh.setMatrixAt(slot, _dm1);
    if (tint) this.mesh.setColorAt(slot, tint);

    var tile = 1 / this.tiles;
    var col = frame % this.tiles;
    var row = (frame / this.tiles) | 0;
    var a = this.aUvRect.array;
    // inset half a texel so mip levels cannot pull in the neighbouring frame
    var inset = tile * 0.004;
    a[slot * 4] = col * tile + inset;
    a[slot * 4 + 1] = row * tile + inset;
    a[slot * 4 + 2] = tile - inset * 2;
    a[slot * 4 + 3] = tile - inset * 2;
    this.aDecal.array[slot * 2] = 0;
    this.aDecal.array[slot * 2 + 1] = rough;

    this._matDirty = true;
    this._fadeDirty = true;
    this.aUvRect.needsUpdate = true;
    return slot;
  };

  DecalField.prototype.update = function (dt, now) {
    var fadeArr = this.aDecal.array;
    var changed = false;
    // Start retiring the oldest decals before the ring actually wraps, so they
    // dissolve instead of popping out of existence.
    var overflow = this.order.length - Math.floor(this.cap * 0.84);
    for (var k = 0; k < overflow && k < this.order.length; k++) {
      var os = this.slots[this.order[k]];
      if (!os.fading) { os.fading = true; os.rate = 1.0; }
    }
    for (var i = 0; i < this.order.length; i++) {
      var slot = this.order[i];
      var s = this.slots[slot];
      if (!s.active) continue;
      if (!s.fading && now - s.born > s.ttl) { s.fading = true; s.rate = 0.8; }
      var want = s.fading ? 0 : s.target;
      var f = s.fade;
      if (f !== want) {
        f = M.damp(f, want, s.fading ? s.rate * 3.2 : 26.0, dt);
        if (Math.abs(f - want) < 0.004) f = want;
        s.fade = f;
        fadeArr[slot * 2] = f;
        changed = true;
      }
      if (s.fading && f <= 0.0001) {
        s.active = false;
        _dm1.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(slot, _dm1);
        this._matDirty = true;
        this.free.push(slot);
        this.order.splice(i, 1);
        i--;
      }
    }
    if (changed || this._fadeDirty) { this.aDecal.needsUpdate = true; this._fadeDirty = false; }
    if (this._matDirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
      this._matDirty = false;
    }
  };

  DecalField.prototype.clear = function () {
    _dm1.makeScale(0, 0, 0);
    for (var i = 0; i < this.cap; i++) {
      this.slots[i].active = false;
      this.slots[i].fade = 0;
      this.aDecal.array[i * 2] = 0;
      this.mesh.setMatrixAt(i, _dm1);
    }
    this.free.length = 0;
    for (i = this.cap - 1; i >= 0; i--) this.free.push(i);
    this.order.length = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.aDecal.needsUpdate = true;
  };

  DecalField.prototype.dispose = function () {
    this.mesh.geometry.dispose();
    this.material.dispose();
  };

  // ==========================================================================
  // RigidPool - instanced physical debris. Small enough counts that a CPU
  // integrator is cheaper than any GPU trick, and we get real bouncing.
  // ==========================================================================
  function RigidPool(cap, geometry, material) {
    this.cap = Math.max(4, cap | 0);
    this.mesh = new THREE.InstancedMesh(geometry, material, this.cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.items = new Array(this.cap);
    for (var i = 0; i < this.cap; i++) {
      this.items[i] = {
        pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        quat: new THREE.Quaternion(), spin: new THREE.Vector3(),
        scale: new THREE.Vector3(1, 1, 1), color: new THREE.Color(1, 1, 1),
        groundY: 0, life: 0, age: 0, rest: false, bounces: 0,
        radius: 0.02, restitution: 0.3, friction: 0.6, fadeAt: 1e9, active: false,
        gravityScale: 1
      };
    }
    this.active = [];
    this.free = [];
    for (i = this.cap - 1; i >= 0; i--) this.free.push(i);
  }

  RigidPool.prototype.acquire = function () {
    var i;
    if (this.free.length) i = this.free.pop();
    else { i = this.active.shift(); if (i === undefined) return null; }
    var it = this.items[i];
    it.active = true; it.age = 0; it.rest = false; it.bounces = 0;
    it.spin.set(0, 0, 0); it.vel.set(0, 0, 0);
    it.gravityScale = 1; it._hang = 0; it._hot = 0;
    it.quat.identity();
    this.active.push(i);
    it._slot = i;
    return it;
  };

  // Returns true when the item just came to rest (caller may play a sound).
  RigidPool.prototype.step = function (dt, it, onBounce) {
    it.age += dt;
    if (!it.rest) {
      if (it._hang > 0) {
        it._hang -= dt;
        if (it._hang <= 0) it.gravityScale = 1;
      }
      it.vel.y -= 9.81 * (it.gravityScale === undefined ? 1 : it.gravityScale) * dt;
      // light air drag - stops shells arcing like cannonballs
      var d = Math.exp(-1.6 * dt);
      it.vel.multiplyScalar(d);
      it.pos.addScaledVector(it.vel, dt);
      var sp = it.spin;
      if (sp.lengthSq() > 1e-8) {
        _v1.copy(sp);
        var ang = _v1.length() * dt;
        _v1.normalize();
        _q1.setFromAxisAngle(_v1, ang);
        it.quat.premultiply(_q1).normalize();
        sp.multiplyScalar(Math.exp(-0.9 * dt));
      }
      var floor = it.groundY + it.radius;
      if (it.pos.y <= floor) {
        it.pos.y = floor;
        var impact = -it.vel.y;
        if (impact > 0.35 && it.bounces < 5) {
          it.vel.y = impact * it.restitution;
          it.vel.x *= it.friction; it.vel.z *= it.friction;
          it.spin.multiplyScalar(0.55);
          it.spin.x += (it.vel.z) * 3.0;
          it.spin.z -= (it.vel.x) * 3.0;
          it.bounces++;
          if (onBounce) onBounce(it, impact);
        } else {
          it.vel.set(0, 0, 0);
          it.spin.set(0, 0, 0);
          it.rest = true;
        }
      }
    }
    return it.rest;
  };

  RigidPool.prototype.sync = function () {
    var n = 0;
    for (var k = 0; k < this.active.length; k++) {
      var it = this.items[this.active[k]];
      _m1.compose(it.pos, it.quat, it.scale);
      this.mesh.setMatrixAt(n, _m1);
      this.mesh.setColorAt(n, it.color);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  };

  RigidPool.prototype.release = function (indexInActive) {
    var slot = this.active[indexInActive];
    this.items[slot].active = false;
    this.active.splice(indexInActive, 1);
    this.free.push(slot);
  };

  RigidPool.prototype.clear = function () {
    while (this.active.length) this.release(this.active.length - 1);
    this.mesh.count = 0;
  };

  RigidPool.prototype.dispose = function () {
    this.mesh.geometry.dispose();
    if (this.mesh.material.dispose) this.mesh.material.dispose();
  };

  // --- geometry for debris chunks ------------------------------------------
  function makeChunkGeometry(rng) {
    var g = new THREE.IcosahedronGeometry(0.5, 0);
    var p = g.attributes.position;
    // knock the sphere into an angular fragment - round debris reads as gravel
    for (var i = 0; i < p.count; i++) {
      var s = 0.45 + rng.next() * 1.05;
      p.setXYZ(i, p.getX(i) * s, p.getY(i) * s * (0.5 + rng.next() * 0.9), p.getZ(i) * s);
    }
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }

  // --- geometry for a 5.56x45 case ------------------------------------------
  // A lathe over the real profile, because the silhouette signature of the
  // round - rim step, extractor-groove undercut, case head, bottleneck
  // shoulder, neck - is the ONLY thing that distinguishes spent brass from a
  // gold pencil stub at viewmodel distance.  Profile is (radius, y) in metres,
  // y = 0 at the case head, 0.0450 at the mouth.
  var SHELL_PROFILE = [
    [0.00000, 0.00000],   // head centre (primer)
    [0.00250, 0.00000],   // primer pocket edge
    [0.00480, 0.00010],   // rim outer, head face
    [0.00480, 0.00110],   // rim step
    [0.00390, 0.00170],   // extractor groove
    [0.00385, 0.00300],
    [0.00468, 0.00400],   // case head, full diameter
    [0.00458, 0.02500],   // body, slight taper
    [0.00432, 0.03150],   // start of shoulder
    [0.00302, 0.03620],   // shoulder
    [0.00296, 0.04430],   // neck
    [0.00252, 0.04500],   // mouth, outer chamfer
    [0.00218, 0.04455],   // mouth, inner lip - the case is hollow
    [0.00218, 0.03900]    // a little way down the bore
  ];
  function makeShellGeometry() {
    var pts = [];
    for (var i = 0; i < SHELL_PROFILE.length; i++) {
      pts.push(new THREE.Vector2(SHELL_PROFILE[i][0], SHELL_PROFILE[i][1]));
    }
    // LatheGeometry generates its own seam-correct normals; do not recompute.
    var g = new THREE.LatheGeometry(pts, 10, 0, M.TAU);
    // centre it on its middle so tumbling looks right
    g.translate(0, -0.0225, 0);
    g.computeBoundingSphere();
    return g;
  }

  // 32 px case map: soot gradient at the mouth, bright body, dark head ring
  // with a primer disc. Lathe UVs run v along the profile, u around.
  function buildShellTexture() {
    var S = 32;
    var data = new Uint8Array(S * S * 4);
    for (var y = 0; y < S; y++) {
      var v = (y + 0.5) / S;
      for (var x = 0; x < S; x++) {
        var u = (x + 0.5) / S;
        // v ~ 0 is the head end of the profile, v ~ 1 the mouth
        var head = 1.0 - ss(0.02, 0.12, v);
        var mouth = ss(0.72, 1.0, v);
        var lum = 1.0;
        lum *= M.lerp(1.0, 0.52, head);            // case head runs dark
        lum *= M.lerp(1.0, 0.40, mouth * mouth);   // soot round the case mouth
        // a faint drawn-brass streak so the body is not a mirror
        lum *= 0.92 + 0.08 * Math.sin(u * 40.0 + v * 3.0);
        // primer disc sits dead centre of the head cap
        var pr = head * (1.0 - ss(0.0, 0.35, Math.abs(v - 0.005) * 20.0));
        var r = lum, gg = lum * 0.93, b = lum * 0.70;
        if (pr > 0.4) { r = 0.42; gg = 0.40; b = 0.38; }
        var p = (y * S + x) * 4;
        data[p] = sat(r) * 255; data[p + 1] = sat(gg) * 255;
        data[p + 2] = sat(b) * 255; data[p + 3] = 255;
      }
    }
    var t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    return t;
  }

  // --- geometry for a wind-blown paper scrap -------------------------------
  function makeLitterGeometry() {
    var g = new THREE.PlaneGeometry(0.15, 0.11, 3, 3);
    var p = g.attributes.position;
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i);
      // a permanent fold so it never looks like a flat card
      p.setZ(i, Math.sin(x * 22.0) * 0.008 + Math.cos(y * 26.0) * 0.006);
    }
    g.computeVertexNormals();
    return g;
  }

  // ==========================================================================
  // LightPool
  // The lights live in the scene permanently at intensity 0. Adding/removing a
  // light changes the light count, which forces three to recompile EVERY
  // material in the scene - a multi-hundred-millisecond hitch, mid-firefight.
  // ==========================================================================
  function LightPool(parent, n, distance) {
    this.lights = [];
    for (var i = 0; i < n; i++) {
      var l = new THREE.PointLight(0xffffff, 0, distance, 2);
      l.castShadow = false;
      parent.add(l);
      this.lights.push({ light: l, t: 0, dur: 0, peak: 0, decay: 30, prio: 0, seq: 0 });
    }
    this._seq = 0;
    // Optional live camera position. A flash 60 m down the street contributes
    // nothing a player can see but still burns a slot that the shooter twelve
    // metres away needed, so distant events are dropped rather than pooled.
    this.cullFrom = null;
    this.cullDist = 38;
  }

  LightPool.prototype.flash = function (pos, color, peak, dur, decay, distance, prio) {
    if (this.cullFrom) {
      var cdx = pos.x - this.cullFrom.x, cdy = pos.y - this.cullFrom.y,
          cdz = pos.z - this.cullFrom.z;
      var cd2 = cdx * cdx + cdy * cdy + cdz * cdz;
      // a detonation (prio >= 5) is a set piece and is never culled
      if (prio < 5 && cd2 > this.cullDist * this.cullDist) return;
    }
    // pick a free slot, else the weakest currently-running one
    var best = null, bestScore = Infinity;
    for (var i = 0; i < this.lights.length; i++) {
      var e = this.lights[i];
      var score = e.t >= e.dur ? -1 : (e.prio * 1000 + (e.dur - e.t));
      if (score < bestScore) { bestScore = score; best = e; }
    }
    if (!best) return;
    if (bestScore >= 0 && best.prio > prio) return;   // do not steal from a bigger event
    best.t = 0; best.dur = dur; best.peak = peak; best.decay = decay; best.prio = prio;
    best.seq = ++this._seq;
    best.light.position.copy(pos);
    best.light.color.copy(color);
    best.light.distance = distance;
    best.light.intensity = peak;
  };

  LightPool.prototype.update = function (dt) {
    for (var i = 0; i < this.lights.length; i++) {
      var e = this.lights[i];
      if (e.t >= e.dur) { if (e.light.intensity !== 0) e.light.intensity = 0; continue; }
      e.t += dt;
      var u = M.saturate(e.t / Math.max(e.dur, 1e-4));
      // exponential burn-down with a little flicker, then a hard cut to zero
      var v = Math.exp(-e.decay * e.t) * (0.85 + 0.15 * Math.sin(e.t * 90.0 + e.seq));
      e.light.intensity = e.t >= e.dur ? 0 : e.peak * v * (1.0 - u * u * u);
    }
  };

  LightPool.prototype.clear = function () {
    for (var i = 0; i < this.lights.length; i++) {
      this.lights[i].t = 1; this.lights[i].dur = 0;
      this.lights[i].light.intensity = 0;
    }
  };

  // ==========================================================================
  // Emit descriptor - one shared object, reset per call. Zero allocation.
  // ==========================================================================
  var _E = {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    life: 1, fadeIn: 0.12, fadeOut: 0.55,
    size0: 0.1, size1: 0.25, rot: 0, rotSpd: 0,
    r: 1, g: 1, b: 1, intensity: 1, opacity: 1,
    frame: 0, ramp: 0, turb: 0, stretch: 0,
    drag: 0, gravity: 0, seed: 0, delay: 0, ground: 0,
    core: 0, soft: 0
  };
  function E() {
    _E.x = 0; _E.y = 0; _E.z = 0; _E.vx = 0; _E.vy = 0; _E.vz = 0;
    _E.life = 1; _E.fadeIn = 0.12; _E.fadeOut = 0.55;
    _E.size0 = 0.1; _E.size1 = 0.25; _E.rot = 0; _E.rotSpd = 0;
    _E.r = 1; _E.g = 1; _E.b = 1; _E.intensity = 1; _E.opacity = 1;
    _E.frame = 0; _E.ramp = 0; _E.turb = 0; _E.stretch = 0;
    _E.drag = 0; _E.gravity = 0; _E.seed = 0; _E.delay = 0; _E.ground = 0;
    _E.core = 0; _E.soft = 0;
    return _E;
  }

  // Material family lookup. Ballistics and level modules speak many dialects
  // ('rusted_metal', 'metal', 'corrugated_metal'); everything funnels here.
  var FAMILY = {
    concrete: 'concrete', concrete_wall: 'concrete', plaster: 'concrete',
    brick: 'concrete', stone: 'concrete', tile: 'concrete', asphalt: 'concrete',
    rubble: 'concrete', gravel: 'sand',
    metal: 'metal', rusted_metal: 'metal', painted_metal: 'metal',
    corrugated_metal: 'metal', steel: 'metal', car: 'metal', barrel: 'metal',
    wood: 'wood', wood_plank: 'wood', plank: 'wood', crate: 'wood',
    sand: 'sand', dirt: 'sand', ground: 'sand', earth: 'sand',
    glass: 'glass', window: 'glass',
    flesh: 'flesh', body: 'flesh', head: 'flesh', enemy: 'flesh', blood: 'flesh',
    foliage: 'foliage', leaves: 'foliage', tree: 'foliage',
    fabric: 'fabric', cloth: 'fabric', canvas: 'fabric', sandbag: 'fabric',
    rubber: 'rubber', tyre: 'rubber', tire: 'rubber',
    water: 'water'
  };
  function familyOf(kind) {
    if (!kind) return 'concrete';
    var k = String(kind).toLowerCase();
    if (FAMILY[k]) return FAMILY[k];
    // substring fallback so unexpected names still land somewhere sensible
    if (k.indexOf('metal') >= 0 || k.indexOf('steel') >= 0) return 'metal';
    if (k.indexOf('wood') >= 0) return 'wood';
    if (k.indexOf('glass') >= 0) return 'glass';
    if (k.indexOf('sand') >= 0 || k.indexOf('dirt') >= 0) return 'sand';
    if (k.indexOf('flesh') >= 0 || k.indexOf('body') >= 0) return 'flesh';
    return 'concrete';
  }

  // Per-family palette: dust tint, debris tint, decal tint, spark amount.
  var FAM = {
    concrete: { dust: [0.72, 0.69, 0.62], chip: [0.52, 0.50, 0.46], decal: [1.0, 1.0, 1.0], sparks: 10, hole: DC.HOLE_A },
    metal:    { dust: [0.55, 0.55, 0.58], chip: [0.30, 0.31, 0.33], decal: [0.85, 0.88, 0.95], sparks: 26, hole: DC.HOLE_METAL },
    wood:     { dust: [0.58, 0.44, 0.28], chip: [0.36, 0.25, 0.14], decal: [1.0, 0.95, 0.88], sparks: 0, hole: DC.HOLE_WOOD },
    sand:     { dust: [0.78, 0.68, 0.50], chip: [0.46, 0.38, 0.26], decal: [1.0, 0.96, 0.86], sparks: 0, hole: DC.HOLE_SAND },
    glass:    { dust: [0.80, 0.86, 0.90], chip: [0.68, 0.78, 0.82], decal: [1.0, 1.0, 1.0], sparks: 4, hole: DC.HOLE_GLASS },
    flesh:    { dust: [0.35, 0.05, 0.04], chip: [0.30, 0.04, 0.03], decal: [1.0, 1.0, 1.0], sparks: 0, hole: DC.BLOOD_A },
    foliage:  { dust: [0.42, 0.46, 0.28], chip: [0.32, 0.36, 0.20], decal: [0.9, 0.95, 0.8], sparks: 0, hole: DC.SCUFF },
    fabric:   { dust: [0.62, 0.56, 0.44], chip: [0.40, 0.36, 0.28], decal: [0.9, 0.88, 0.82], sparks: 0, hole: DC.SCUFF },
    rubber:   { dust: [0.24, 0.23, 0.22], chip: [0.14, 0.14, 0.14], decal: [0.6, 0.6, 0.6], sparks: 0, hole: DC.POCK },
    water:    { dust: [0.66, 0.74, 0.78], chip: [0.60, 0.70, 0.75], decal: [0.9, 0.95, 1.0], sparks: 0, hole: DC.SCUFF }
  };

  // Decal kind -> atlas frame + default look.
  var DECAL_KINDS = {
    bullet:        { frame: DC.HOLE_A, rough: 1.0, opacity: 1.0, ttl: 90 },
    bullet_b:      { frame: DC.HOLE_B, rough: 1.0, opacity: 1.0, ttl: 90 },
    bullet_metal:  { frame: DC.HOLE_METAL, rough: 0.9, opacity: 1.0, ttl: 90 },
    bullet_wood:   { frame: DC.HOLE_WOOD, rough: 1.0, opacity: 1.0, ttl: 90 },
    bullet_glass:  { frame: DC.HOLE_GLASS, rough: 0.6, opacity: 1.0, ttl: 90 },
    bullet_sand:   { frame: DC.HOLE_SAND, rough: 1.05, opacity: 0.95, ttl: 60 },
    scorch:        { frame: DC.SCORCH, rough: 1.0, opacity: 0.9, ttl: 120 },
    scorch_big:    { frame: DC.SCORCH_BIG, rough: 1.0, opacity: 1.0, ttl: 180 },
    blood:         { frame: DC.BLOOD_A, rough: 1.0, opacity: 1.0, ttl: 70 },
    blood_b:       { frame: DC.BLOOD_B, rough: 1.0, opacity: 1.0, ttl: 70 },
    blood_pool:    { frame: DC.BLOOD_POOL, rough: 1.0, opacity: 1.0, ttl: 120 },
    smear:         { frame: DC.SMEAR, rough: 1.0, opacity: 0.45, ttl: 5 },
    scuff:         { frame: DC.SCUFF, rough: 1.0, opacity: 0.7, ttl: 40 },
    spall:         { frame: DC.SPALL, rough: 1.0, opacity: 0.8, ttl: 70 },
    soot:          { frame: DC.SOOT, rough: 1.0, opacity: 0.85, ttl: 120 },
    pock:          { frame: DC.POCK, rough: 1.0, opacity: 0.9, ttl: 70 }
  };

  // ==========================================================================
  // GAME.VFX
  // ==========================================================================
  function VFX(ctx) {
    this.ctx = ctx || {};
    this.rng = (this.ctx.rng && this.ctx.rng.fork) ? this.ctx.rng.fork(0x5646) : new GAME.RNG(0x5646);
    this.noise = new GAME.Noise(0xB1A2);
    this.time = 0;
    this.enabled = true;
    this.ready = false;

    var q = this.ctx.quality || {};
    this.qp = typeof q.particles === 'number' ? M.clamp(q.particles, 0.25, 2.0) : 1.0;
    this.decalCap = Math.max(24, Math.min(256, (q.decals | 0) || 96));

    this.root = new THREE.Object3D();
    this.root.name = 'vfx';
    this.root.matrixAutoUpdate = false;
    this.viewRoot = new THREE.Object3D();
    this.viewRoot.name = 'vfx-view';

    this.wind = new THREE.Vector3(0.35, 0.04, -0.9);
    this.windSpeed = 1.1;

    // uniforms shared by every particle layer so a frame update touches one
    // object instead of N
    this.shared = {
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector3() },
      uAtlas: { value: new THREE.Vector3(4, 0.25, 0.012) },
      uPixelScale: { value: 700 },
      uSoft: { value: 0 },
      uDepth: { value: null },
      uParticleFog: { value: 0.45 },
      uSunColor: { value: new THREE.Color(1.5, 1.28, 1.0) },
      uSunDirView: { value: new THREE.Vector3(0, 1, 0) },
      uAmbient: { value: new THREE.Color(0.10, 0.13, 0.18) }
    };

    // The viewmodel scene has its own camera with its own (narrow) FOV, so the
    // pixel-scale and soft-particle uniforms cannot be shared with the world.
    // Time, wind and the atlas are the same objects, so one write updates both.
    this.sharedV = {
      uTime: this.shared.uTime,
      uWind: this.shared.uWind,
      uAtlas: this.shared.uAtlas,
      uPixelScale: { value: 700 },
      uSoft: { value: 0 },
      uDepth: { value: null },
      uParticleFog: { value: 0.0 },
      uSunColor: this.shared.uSunColor,
      uSunDirView: this.shared.uSunDirView,
      uAmbient: this.shared.uAmbient,
      // ONLY the view layer declares this. See PARTICLE_VERT.
      uAnchor: { value: new THREE.Vector3() }
    };

    this._lastFlashAt = -1e9;
    this._lastViewFlashAt = -1e9;
    this._flashAnchor = new THREE.Vector3();
    // rounds-in-the-last-second proxy, drives the accumulating propellant haze
    this._burstHeat = 0;
    // 0 in full sun, 1 at midnight. Fire, embers and practicals scale with it.
    this._night = 0;
    // per-emitter rapid-fire dampers, keyed by a 0.5 m spatial hash (0 = player)
    this._flashKeys = [];
    this._tracerBoost = 0;
    this._lastTracerAt = -1e9;
    this._lodDist = 0;
    this._interiorProbeAt = -1;
    this._interior = 0;
    this._interiorEase = 0;
    this._litterCursor = 0;
    this.layers = null;
    this.decals = null;
    this.debris = null;
    this.shells = null;
    this.litter = null;
    this.dust = null;
    this.tracers = null;
    this.lights = null;
    this.viewLights = null;
    this.depth = null;
    this._depthTex = null;
    this._depthProbeAt = -1;
    this._budget = 512;
    this._ambientProbeAt = -1;
    this.emitters = [];
    this._litterState = null;
    this._sunDirWorld = new THREE.Vector3(-0.32, 0.26, -0.91).normalize();
    this._sunLin = new THREE.Color(1.5, 1.28, 1.0);
  }

  // --------------------------------------------------------------------------
  VFX.prototype.build = async function (ctx) {
    ctx = ctx || this.ctx;
    this.ctx = ctx;
    try {
      var N = this.noise;

      // 1024 / 4 = 256 px tiles. Silhouette is the whole game for fire and
      // smoke and 128 px could not hold one; this is the same texel budget the
      // decal atlas has always used and it builds in the same time.
      var pAtlas = buildParticleAtlas(1024, 4, N);
      this.particleAtlas = pAtlas;
      if (!GAME.headless) await GAME.yieldFrame();

      var dAtlas = buildDecalAtlas(1024, 4, N);
      this.decalAtlas = dAtlas;
      if (!GAME.headless) await GAME.yieldFrame();

      // inset 8 texels of a 256 px tile: still a full texel of gutter at mip 3
      this.shared.uAtlas.value.set(4, 0.25, 8.0 / 256);

      var qp = this.qp;
      this.layers = {
        add: new ParticleLayer(Math.round(1500 * qp), 'add', pAtlas, this.shared),
        lit: new ParticleLayer(Math.round(900 * qp), 'lit', pAtlas, this.shared),
        // emissive-with-occlusion: fireball, muzzle flash core
        fire: new ParticleLayer(Math.round(420 * qp), 'fire', pAtlas, this.shared),
        // first-person scene twin. The muzzle flash HAS to live here: the
        // viewmodel is projected through viewCamera (fov ~55-80 depending on
        // weapon and ADS) while ctx.camera runs at the player FOV, so a
        // world-space flash lands at tan(fovView/2)/tan(fovWorld/2) of its
        // correct screen radius - visibly off the barrel - and is composited
        // BEHIND the gun instead of wrapping it.
        view: null
      };
      if (ctx.viewScene) {
        // Premultiplied for the view layer too, and for a specific reason: the
        // viewmodel target is composited with mix(world, view.rgb, view.a).
        // Under three's AdditiveBlending the target would end up holding
        // alpha = a*a, so a flash at a = 0.3 would come back as 9% of itself
        // AND darken the world by 9%. Premultiplied gives exactly
        // world*(1-a) + rgb, i.e. emissive-over-with-occlusion, which is what
        // a muzzle flash actually does to the barrel in front of it.
        this.layers.view = new ParticleLayer(Math.round(260 * qp), 'fire', pAtlas, this.sharedV);
        this.layers.view.material.uniforms.uNearFade.value = 0.02;
        this.layers.view.mesh.renderOrder = 20;
      }
      this.tracers = new TracerLayer(64, this.shared);
      // 2400, not 900. Only the motes inside a 0.85-to-0.6*box shell that also
      // fall inside the frustum are ever drawn, which for a 30 m outdoor box is
      // around 5% of them - 900 motes put roughly 45 specks on screen, i.e.
      // nothing. They are instanced quads with a vertex early-out, so the ones
      // that miss cost a vertex shader and no fragments at all.
      this.dust = new DustField(Math.round(2400 * qp), this.rng, this.shared);
      this.decals = new DecalField(this.decalCap, dAtlas, 4);

      var chunkGeo = makeChunkGeometry(this.rng.fork(7));
      var chunkMat = new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 0.82, metalness: 0.0
      });
      this.debris = new RigidPool(Math.round(240 * qp), chunkGeo, chunkMat);
      this.debris.mesh.castShadow = false;
      this.debris.mesh.receiveShadow = true;

      var shellGeo = makeShellGeometry();
      this.shellTex = buildShellTexture();
      // Not fully metallic on purpose: if sky.js never assigns
      // scene.environment, a metalness-1 material has nothing to reflect and
      // renders as a black stick. 0.78 keeps a little diffuse brass either way.
      // Roughness 0.44 (not 0.32) - spent brass is scuffed, not chrome.
      var shellMat = new THREE.MeshStandardMaterial({
        map: this.shellTex,
        color: 0xffffff, roughness: 0.44, metalness: 0.78, envMapIntensity: 1.0
      });
      this.shells = new RigidPool(56, shellGeo, shellMat);
      this.shells.mesh.castShadow = true;
      this.shells.mesh.receiveShadow = true;

      var litterGeo = makeLitterGeometry();
      this.litterTex = buildLitterTexture(96, N);
      var litterMat = new THREE.MeshStandardMaterial({
        map: this.litterTex, color: 0xffffff, roughness: 0.92, metalness: 0.0,
        side: THREE.DoubleSide, transparent: false, alphaTest: 0.5
      });
      this.litter = new RigidPool(22, litterGeo, litterMat);
      this.litter.mesh.castShadow = false;
      this.litter.mesh.receiveShadow = true;

      this.root.add(this.layers.lit.mesh, this.layers.fire.mesh, this.layers.add.mesh,
        this.tracers.mesh, this.dust.mesh, this.decals.mesh, this.debris.mesh,
        this.shells.mesh, this.litter.mesh);

      // Lights are parented to our root, NOT directly to the scene: main.js
      // checks scene.children for an isLight to decide whether it needs its
      // emergency sun, and we must not fool it into skipping that.
      // Five, not two. In the firefight scenario there are four militiamen plus
      // the player: with two slots at most two shooters can light the world and
      // the rest are pure billboards, and LightPool's priority steal means the
      // near-miss impact lights fight the flashes for the same pair. These are
      // shadowless point lights parked at intensity 0, so the whole cost is a
      // slightly larger NUM_POINT_LIGHTS in the compiled programs.
      this.lights = new LightPool(this.root, 5, 20);

      // A permanent, gently flickering 2100 K source at the base of the
      // hottest ambient emitter. Fire that lights nothing is not fire.
      // Range and radiance both scale with the emitter it parks on, so a 1.3 m
      // crater fire keys the street the way a burn barrel cannot.
      this.fireLight = new THREE.PointLight(0xffffff, 0, 14, 2);
      this.fireLight.castShadow = false;
      GAME.Color.kelvin(2100, _c1);
      this.fireLight.color.copy(_c1);
      this.root.add(this.fireLight);

      // ONE reserved shadow caster for set pieces. Every FX light being
      // shadowless is why a detonation reads as a global exposure change
      // rather than as a fire in the street: nothing in front of the fireball
      // is silhouetted and nothing behind it throws a shadow away from it.
      // A spot (not a point - point lights need cube maps and are not worth
      // it) aimed from the blast toward the camera buys the long raking
      // shadows that are the single strongest cue that the fire is a real
      // light. Kept at intensity 0 with shadow.autoUpdate off, so it costs
      // exactly nothing until something detonates.
      this.blastSpot = null;
      this._blastT = 0; this._blastDur = 0; this._blastPeak = 0;
      try {
        var bs = new THREE.SpotLight(0xffffff, 0, 46, 1.15, 0.6, 2);
        bs.castShadow = true;
        bs.shadow.mapSize.width = 1024;
        bs.shadow.mapSize.height = 1024;
        bs.shadow.camera.near = 0.6;
        bs.shadow.camera.far = 48;
        bs.shadow.bias = -0.0012;
        bs.shadow.normalBias = 0.06;
        bs.shadow.autoUpdate = false;
        bs.shadow.needsUpdate = false;
        bs.position.set(0, 4, -20);
        bs.target.position.set(0, 0, -19);
        this.root.add(bs);
        this.root.add(bs.target);
        this.blastSpot = bs;
      } catch (e) { this.blastSpot = null; }

      if (ctx.viewScene) {
        this.viewLights = new LightPool(this.viewRoot, 2, 3.0);
        if (this.layers.view) this.viewRoot.add(this.layers.view.mesh);
        ctx.viewScene.add(this.viewRoot);
      }

      if (ctx.scene) ctx.scene.add(this.root);

      var w = ctx.width || 1920, h = ctx.height || 1080;
      this.depth = new DepthLinearizer(w, h);
      this.shared.uDepth.value = this.depth.rt.texture;

      this._initLitter();
      this._initAmbientEmitters();
      this._seedBattleDamage();

      this.ready = true;
    } catch (e) {
      GAME.logError('vfx.build', e);
      this.enabled = false;
    }
  };

  // --------------------------------------------------------------------------
  VFX.prototype.resize = function (w, h) {
    if (this.depth) { try { this.depth.resize(w, h); } catch (e) { GAME.logError('vfx.resize', e); } }
  };

  // --------------------------------------------------------------------------
  // Locate a depth attachment on postfx. Names differ between implementations,
  // so probe by duck-typing and re-probe until something shows up.
  // --------------------------------------------------------------------------
  VFX.prototype._findDepthTexture = function (ctx) {
    var pf = ctx.postfx;
    if (!pf) return null;
    // The one that actually exists today. Probe it by name first so soft
    // particles never depend on property-enumeration order.
    if (pf.rtScene && pf.rtScene.depthTexture && pf.rtScene.depthTexture.isDepthTexture) {
      return pf.rtScene.depthTexture;
    }
    var names = ['depthTexture', 'sceneDepth', 'depthTex', 'depth'];
    var i, v;
    for (i = 0; i < names.length; i++) {
      v = pf[names[i]];
      if (v && v.isDepthTexture) return v;
      if (v && v.isWebGLRenderTarget && v.depthTexture) return v.depthTexture;
    }
    var keys;
    try { keys = Object.keys(pf); } catch (e) { return null; }
    for (i = 0; i < keys.length; i++) {
      v = pf[keys[i]];
      if (!v || typeof v !== 'object') continue;
      if (v.isDepthTexture) return v;
      if (v.isWebGLRenderTarget && v.depthTexture && v.depthTexture.isDepthTexture) return v.depthTexture;
    }
    return null;
  };

  // --------------------------------------------------------------------------
  VFX.prototype._refreshEnvironment = function (ctx) {
    var sun = this._sunLin.setRGB(1.0, 0.86, 0.68);
    var sunI = 4.8;
    var dir = this._sunDirWorld;

    if (ctx.lighting && ctx.lighting.sun && ctx.lighting.sun.isLight) {
      var s = ctx.lighting.sun;
      sun.copy(s.color);
      sunI = s.intensity;
      _v1.copy(s.position);
      if (s.target && s.target.position) _v1.sub(s.target.position);
      if (_v1.lengthSq() > 1e-6) dir.copy(_v1).normalize();
    }
    if (ctx.sky) {
      if (ctx.sky.sunColor && ctx.sky.sunColor.isColor) sun.copy(ctx.sky.sunColor);
      if (typeof ctx.sky.sunIntensity === 'number') sunI = ctx.sky.sunIntensity;
      if (ctx.sky.sunDirection && ctx.sky.sunDirection.isVector3 &&
          ctx.sky.sunDirection.lengthSq() > 1e-6) {
        dir.copy(ctx.sky.sunDirection).normalize();
      }
    }
    // How dark is the world right now? sky.js collapses to the moon below
    // 0.14 sun, so this reads ~0 at noon, ~0.3 at dusk and ~0.95 at night.
    // Fire, embers and practical range all key off it: the amount of visible
    // combustion that reads as "a smouldering wreck" at 4.8 lux of sun is
    // invisible at 0.08 mean frame luminance, and a night map whose only VFX
    // event is an unexplained warm patch on some barrels has a light source
    // with no lamp, which is the oldest amateur tell there is.
    this._night = M.clamp(1.0 - Math.max(sunI, 0) / 3.0, 0, 1);

    // Convert irradiance to the radiance a lambertian surface reflects, so
    // smoke sits at the same exposure as the plaster behind it.
    var k = Math.max(sunI, 0) / Math.PI;
    this.shared.uSunColor.value.setRGB(sun.r * k, sun.g * k, sun.b * k);
    this.shared.uSunDirView.value.copy(dir);
    if (ctx.camera) {
      this.shared.uSunDirView.value.transformDirection(ctx.camera.matrixWorldInverse);
    }

    // ambient: re-scan occasionally, lighting may be built after us
    if (ctx.frame === undefined || ctx.frame - this._ambientProbeAt > 45 || this._ambientProbeAt < 0) {
      this._ambientProbeAt = ctx.frame || 0;
      var amb = _c2.setRGB(0.30, 0.40, 0.58);
      var ai = 0.55;
      var found = false;
      if (ctx.scene && ctx.scene.children) {
        for (var i = 0; i < ctx.scene.children.length && !found; i++) {
          var o = ctx.scene.children[i];
          if (o.isHemisphereLight) { amb.copy(o.color); ai = o.intensity; found = true; }
          else if (o.isAmbientLight) { amb.copy(o.color); ai = o.intensity; found = true; }
          else if (o.children && o.children.length) {
            for (var j = 0; j < o.children.length; j++) {
              var c = o.children[j];
              if (c.isHemisphereLight || c.isAmbientLight) {
                amb.copy(c.color); ai = c.intensity; found = true; break;
              }
            }
          }
        }
      }
      var ka = Math.max(ai, 0) / Math.PI;
      this._ambTarget = this._ambTarget || new THREE.Color();
      this._ambTarget.setRGB(amb.r * ka + 0.012, amb.g * ka + 0.014, amb.b * ka + 0.020);
      this.shared.uAmbient.value.copy(this._ambTarget);
    }
  };

  // --------------------------------------------------------------------------
  VFX.prototype.update = function (dt, ctx) {
    if (!this.enabled || !this.ready) return;
    ctx = ctx || this.ctx;
    this.ctx = ctx;
    dt = Math.min(Math.max(dt || 0, 0), 1 / 15);
    // The shader clock must be the deterministic sim clock, not wall time, or
    // headless captures stop being reproducible.
    this.time = (typeof ctx.time === 'number') ? ctx.time : this.time + dt;
    this.shared.uTime.value = this.time;
    this._budget = Math.round(520 * this.qp);

    try { this._refreshEnvironment(ctx); } catch (e) { GAME.logError('vfx.env', e); }

    // gentle, slowly veering breeze down the street
    var t = this.time;
    var wa = 0.35 * Math.sin(t * 0.11) + 0.18 * Math.sin(t * 0.37 + 1.3);
    this.wind.set(Math.sin(-2.7 + wa) * 0.45, 0.05 + 0.03 * Math.sin(t * 0.53),
      Math.cos(-2.7 + wa) * -0.9);
    this.wind.normalize().multiplyScalar(this.windSpeed * (0.75 + 0.35 * Math.sin(t * 0.23)));
    this.shared.uWind.value.copy(this.wind);

    var cam = ctx.camera;
    var h = ctx.height || 1080;
    if (cam) {
      var fov = (cam.fov || 75) * M.DEG;
      this.shared.uPixelScale.value = 0.5 * h / Math.tan(fov * 0.5);
    }
    if (ctx.viewCamera) {
      var vfov = (ctx.viewCamera.fov || 55) * M.DEG;
      this.sharedV.uPixelScale.value = 0.5 * h / Math.tan(vfov * 0.5);
    }

    // Weld the viewmodel flash to the flash hider for the whole recoil stroke.
    // The cards' aOrigin is baked at ignition, but the gun kicks up and back
    // for the flash's entire 42-72 ms life, so without this the fire hangs
    // where the muzzle WAS and reads as a decal floating beside the weapon.
    // The weight eases out over the following 0.3 s so the longer-lived sparks
    // released into the same layer do not snap when the hold expires.
    if (this.sharedV.uAnchor) {
      var av = this.sharedV.uAnchor.value;
      var fage = this.time - this._lastViewFlashAt;
      var aw = fage < 0 ? 0 : M.clamp(1.0 - (fage - 0.10) / 0.30, 0, 1);
      if (aw > 0.001 && this.layers.view) {
        try {
          this._viewMuzzlePosition(_v7);
          av.subVectors(_v7, this._flashAnchor).multiplyScalar(aw);
        } catch (e) { av.set(0, 0, 0); }
      } else if (av.lengthSq() > 0) {
        av.set(0, 0, 0);
      }
    }
    this._burstHeat = Math.max(0, this._burstHeat - dt * 1.5);
    if (this.lights) this.lights.cullFrom = cam ? cam.position : null;

    try { this._updateDepth(ctx); } catch (e) { GAME.logError('vfx.depth', e); }
    try { this._updateEmitters(dt); } catch (e) { GAME.logError('vfx.emit', e); }
    try { this._updateRigid(dt, ctx); } catch (e) { GAME.logError('vfx.rigid', e); }
    try { this._updateLitter(dt, ctx); } catch (e) { GAME.logError('vfx.litter', e); }

    if (this.lights) this.lights.update(dt);
    if (this.viewLights) this.viewLights.update(dt);
    this._updateBlastSpot(dt);
    if (this.decals) this.decals.update(dt, this.time);
    try { this._updateDust(dt, ctx, cam); } catch (e) { GAME.logError('vfx.dust', e); }

    this.layers.add.flush(this.time);
    this.layers.lit.flush(this.time);
    this.layers.fire.flush(this.time);
    if (this.layers.view) this.layers.view.flush(this.time);
    this.tracers.flush(this.time);
  };

  // --------------------------------------------------------------------------
  // Ambient dust. Density, box and tint follow the space the camera is in -
  // a gutted interior gets a small warm dense field, the open street a wide
  // thin one - and the sun-visibility cells are refreshed a few per frame so
  // motes only blaze inside real light shafts.
  // --------------------------------------------------------------------------
  VFX.prototype._updateDust = function (dt, ctx, cam) {
    var d = this.dust;
    if (!d || !cam) return;
    d.update(cam.position, this._sunDirWorld, null);

    // interior test: is there a ceiling directly overhead?
    if (this._interiorProbeAt < 0 || (ctx.frame || 0) - this._interiorProbeAt > 12) {
      this._interiorProbeAt = ctx.frame || 0;
      var inside = this._interior;
      if (ctx.level && ctx.level.raycast) {
        try {
          var r = ctx.level.raycast(cam.position, UP, 7.0);
          inside = (r && r.hit) ? 1 : 0;
        } catch (e) { /* level may be half-built */ }
      }
      this._interior = inside;
    }
    this._interiorEase += (this._interior - this._interiorEase) * Math.min(1, dt * 3.0);
    var k = this._interiorEase;

    // interior: small, dense, warm, allowed to bloom inside a window shaft.
    // street: wide and thin. The interior box is 10x4x10, not 14x5x14, so the
    // same 900 motes are ~3x denser in the room the player is standing in.
    var nk = this._night;
    d.setBox(M.lerp(30, 10, k), M.lerp(11, 4, k), M.lerp(30, 10, k));
    d.setDensity(M.clamp(this.qp, 0.2, 1.6) * M.lerp(0.75, 1.05, k));
    // warm sun-lit dust by day, cool and much dimmer under moonlight - an
    // unchanged warm field in a 0.08-mean frame reads as falling snow
    d.setTint(M.lerp(M.lerp(0.95, 1.00, k), 0.62, nk),
      M.lerp(M.lerp(0.82, 0.85, k), 0.70, nk),
      M.lerp(M.lerp(0.62, 0.60, k), 0.92, nk));
    d.setCap(M.lerp(1.05, 1.15, k) * (1.0 - 0.62 * nk));
    // The floor is what a mote in a cell the SUN cannot reach is worth, and
    // outdoors that is not "nothing" - ART_DIRECTION's headline is thick air,
    // and a raking 14 deg sun means every cell in the canyon fails the sun
    // probe. 0.05 there switched the whole field off in the street, the alley
    // and the interior alike. The shaft CONTRAST now comes from the 2.20
    // multiplier over a real floor, not from a floor of nearly zero.
    d.setShaftFloor(M.lerp(3.00, 7.00, k));

    // Float32Array uniforms are compared element-wise by three, so mutating
    // d.shaft in place is enough - no reassignment needed.
    d.probe(cam.position, this._sunDirWorld, ctx.level, 6);
  };

  // The reserved shadow caster. Decays on the same envelope as the blast
  // flash and re-renders its cascade only while it is actually bright, so the
  // whole feature is free outside of a detonation.
  VFX.prototype._updateBlastSpot = function (dt) {
    var bs = this.blastSpot;
    if (!bs) return;
    if (this._blastDur <= 0) {
      if (bs.intensity !== 0) { bs.intensity = 0; bs.shadow.needsUpdate = false; }
      return;
    }
    this._blastT += dt;
    var u = M.saturate(this._blastT / this._blastDur);
    if (u >= 1) {
      this._blastDur = 0;
      bs.intensity = 0;
      bs.shadow.needsUpdate = false;
      return;
    }
    var v = Math.exp(-4.2 * this._blastT) * (0.82 + 0.18 * Math.sin(this._blastT * 41.0));
    bs.intensity = this._blastPeak * v * (1.0 - u * u * u);
    // refresh the map only over the first third of the burn, and only every
    // other frame - a 1024 cascade twice a frame is not worth the shadow
    bs.shadow.needsUpdate = (u < 0.34) && (((this._blastFrame = (this._blastFrame || 0) + 1) & 1) === 0);
  };

  VFX.prototype._updateDepth = function (ctx) {
    var shared = this.shared;
    if (!this.depth || !ctx.renderer) { shared.uSoft.value = 0; return; }
    // Re-probe EVERY frame until it connects, then never again: postfx builds
    // its targets after us and a 20-frame retry means soft particles are off
    // for the first third of a second of every capture.
    if (!this._depthTex) this._depthTex = this._findDepthTexture(ctx);
    var busy = this.layers.add.geometry.instanceCount > 0 ||
               this.layers.lit.geometry.instanceCount > 0 ||
               this.layers.fire.geometry.instanceCount > 0 ||
               this.tracers.geometry.instanceCount > 0 ||
               // dust motes are always up and now soft-fade too
               !!this.dust;
    if (!this._depthTex || !busy || !ctx.camera) { shared.uSoft.value = 0; return; }
    this.depth.run(ctx.renderer, this._depthTex, ctx.camera.near, ctx.camera.far);
    shared.uSoft.value = 1;
  };

  // --------------------------------------------------------------------------
  // Rigid bodies: shells + debris
  // --------------------------------------------------------------------------
  VFX.prototype._updateRigid = function (dt, ctx) {
    var self = this;
    var audio = ctx.audio;
    var i, it;

    function bounce(item, impact) {
      if (!audio || !audio.play || impact < 1.1) return;
      try {
        audio.play(item._snd || 'shell_bounce', {
          position: item.pos,
          volume: M.clamp(impact * 0.16, 0.05, 0.55),
          pitch: 0.82 + self.rng.next() * 0.5
        });
      } catch (e) { /* audio is optional */ }
    }

    var pool = this.shells;
    for (i = pool.active.length - 1; i >= 0; i--) {
      it = pool.items[pool.active[i]];
      pool.step(dt, it, bounce);
      // freshly ejected brass glows warm for half a second - it is the cheapest
      // possible way to make a 12 mm object catch the eye
      if (it._hot > 0) {
        it._hot -= dt;
        var hk = Math.max(it._hot, 0) / 0.5;
        it.color.setRGB(it._baseR * (1 + 0.65 * hk), it._baseG * (1 + 0.50 * hk),
          it._baseB * (1 + 0.25 * hk));
      }
      if (it.rest && !it._laid) {
        // a spent case at rest lies on its side
        it._laid = true;
        _q1.setFromAxisAngle(_v1.set(0, 0, 1), Math.PI * 0.5);
        _q2.setFromAxisAngle(UP, self.rng.range(0, M.TAU));
        it.quat.copy(_q2).multiply(_q1);
        it.pos.y = it.groundY + 0.0048;
      }
      var over = it.age - it.fadeAt;
      if (over > 0) {
        var s = Math.max(0, 1 - over / 0.9);
        it.scale.set(s, s, s);
        if (s <= 0.001) { pool.release(i); continue; }
      }
    }
    pool.sync();

    pool = this.debris;
    for (i = pool.active.length - 1; i >= 0; i--) {
      it = pool.items[pool.active[i]];
      pool.step(dt, it, null);
      var over2 = it.age - it.fadeAt;
      if (over2 > 0) {
        var s2 = Math.max(0, 1 - over2 / 0.7);
        it.scale.set(it._sx * s2, it._sy * s2, it._sz * s2);
        if (s2 <= 0.001) { pool.release(i); continue; }
      }
    }
    pool.sync();
  };

  // --------------------------------------------------------------------------
  // Wind-blown litter. Twenty cards is nothing to animate on the CPU and it
  // buys real lighting + shadows that a billboard could never have.
  // --------------------------------------------------------------------------
  VFX.prototype._initLitter = function () {
    var pool = this.litter, rng = this.rng;
    var ctx = this.ctx;
    var castY = 2.4;
    if (ctx.camera && ctx.camera.position) castY = ctx.camera.position.y + 0.8;
    for (var i = 0; i < pool.cap; i++) {
      var it = pool.acquire();
      if (!it) break;
      // Place against real geometry. Hard-coding groundY = 0 is what left
      // paper scraps hanging at ceiling height inside the elevated shop
      // interior; the recycle path only ever corrects it once a piece has
      // drifted 26 m, which never happens in a static capture.
      var gx = 0, gz = 0, gy = null;
      for (var tries = 0; tries < 5; tries++) {
        gx = rng.range(-20, 20); gz = rng.range(-30, 30);
        gy = this._groundY(gx, castY, gz, null);
        // reject a miss, and reject a hit far below the cast start (a hole,
        // or a roof edge we shot past)
        if (gy !== null && gy > castY - 6.0) break;
        gy = null;
      }
      if (gy === null) { gx = rng.range(-20, 20); gz = rng.range(-30, 30); gy = 0; }
      it.groundY = gy;
      it.pos.set(gx, gy + rng.range(0.02, 0.20), gz);
      it.scale.set(rng.range(0.7, 1.5), rng.range(0.7, 1.4), 1);
      it._phase = rng.range(0, M.TAU);
      it._spinA = rng.range(1.2, 4.5) * rng.sign();
      it._spinB = rng.range(0.8, 3.0) * rng.sign();
      it._hopT = rng.range(0, 2.5);
      it._drag = rng.range(0.55, 1.25);
      it.fadeAt = 1e9;
      // Multipliers on the baked newsprint texture, which is already
      // 0.52/0.50/0.45 - dry olive leaf, or sun-bleached paper.
      if (rng.bool(0.45)) it.color.setRGB(0.82, 0.90, 0.60);
      else it.color.setRGB(1.00, 0.98, 0.92);
      var g = rng.range(0.75, 1.15);
      it.color.multiplyScalar(g);
    }
    this._litterInit = true;
  };

  // --------------------------------------------------------------------------
  // Pre-existing battle damage.
  //
  // Decals persist, so the street can simply START having been shot at. Every
  // static capture then shows bullet scars on the barriers, the shopfronts and
  // the sandbags instead of pristine cover in the middle of a firefight, and
  // spent brass lying where men have been standing. This is a one-time cost at
  // build and it is worth more than any amount of runtime impact tuning.
  // --------------------------------------------------------------------------
  VFX.prototype._seedBattleDamage = function () {
    var ctx = this.ctx, rng = this.rng.fork(0x9E11);
    if (!ctx.level || !ctx.level.raycast || !this.decals) return;
    var placed = 0, tries = 0;
    var white = new THREE.Color(1, 1, 1);
    var tint = new THREE.Color();
    while (placed < 26 && tries < 220) {
      tries++;
      // stand somewhere down the street and shoot at the cover beside you
      var oz = rng.range(-4, -40);
      var ox = rng.range(-4.5, 4.5);
      var oy = rng.range(0.55, 1.95);
      var ang = rng.range(0, M.TAU);
      _v1.set(Math.cos(ang), rng.range(-0.32, 0.10), Math.sin(ang)).normalize();
      var hit = null;
      try { hit = ctx.level.raycast(_v2.set(ox, oy, oz), _v1, 14); }
      catch (e) { return; }
      if (!hit || !hit.hit || !hit.point || !hit.normal) continue;
      if (hit.distance !== undefined && hit.distance < 0.6) continue;
      var fam = familyOf(hit.material);
      var F = FAM[fam] || FAM.concrete;
      var size = 0.105 * rng.range(0.8, 1.35) * (fam === 'sand' ? 1.5 : 1.0);
      tint.setRGB(F.decal[0], F.decal[1], F.decal[2]);
      this.decals.add(hit.point, hit.normal,
        rng.bool(0.5) ? F.hole : DC.POCK, size, size,
        rng.range(0, M.TAU), rng.range(0.75, 1.0), 1.0, tint,
        DECAL_KINDS.bullet.ttl, 0, 0.012);
      placed++;
      // clusters, not confetti - rounds arrive in bursts
      if (rng.bool(0.55) && placed < 26) {
        _v3.copy(hit.normal);
        _v4.set(0, 1, 0);
        if (Math.abs(_v3.y) > 0.9) _v4.set(1, 0, 0);
        _v5.copy(_v4).cross(_v3).normalize();
        _v4.copy(_v3).cross(_v5).normalize();
        _v2.copy(hit.point)
          .addScaledVector(_v5, rng.gaussian(0, 0.22))
          .addScaledVector(_v4, rng.gaussian(0, 0.18));
        this.decals.add(_v2, _v3, DC.SPALL, size * rng.range(1.4, 2.4),
          size * rng.range(1.4, 2.4), rng.range(0, M.TAU), 0.55, 1.0, tint,
          DECAL_KINDS.spall.ttl, 0, 0.010);
        placed++;
      }
    }
    // two scorch marks on the road where something already burned
    for (var k = 0; k < 2; k++) {
      var sx = rng.range(-3.5, 3.5), sz = rng.range(-12, -34);
      var gy = this._groundY(sx, 3.0, sz, null);
      if (gy === null || gy < -0.8 || gy > 1.2) continue;
      _v2.set(sx, gy, sz); _v3.set(0, 1, 0);
      this.decals.add(_v2, _v3, DC.SCORCH_BIG, rng.range(2.2, 3.6),
        rng.range(2.2, 3.6), rng.range(0, M.TAU), 0.72, 1.0, white,
        DECAL_KINDS.scorch_big.ttl, 0, 0.02);
    }
    // and a handful of already-settled cases lying on their sides where the
    // shooting has been happening
    var shells = this.shells;
    if (!shells) return;
    var n = 8;
    for (var i = 0; i < n; i++) {
      var it = shells.acquire();
      if (!it) break;
      var bx = rng.range(-2.2, 2.2), bz = rng.range(-1.0, -6.0);
      var by = this._groundY(bx, 2.5, bz, null);
      if (by === null) by = 0;
      it.pos.set(bx, by + 0.0048, bz);
      it.vel.set(0, 0, 0); it.spin.set(0, 0, 0);
      _q1.setFromAxisAngle(_v1.set(0, 0, 1), Math.PI * 0.5);
      _q2.setFromAxisAngle(UP, rng.range(0, M.TAU));
      it.quat.copy(_q2).multiply(_q1);
      it.scale.set(1, 1, 1);
      it.radius = 0.0055;
      it.groundY = by;
      it.rest = true; it._laid = true; it._hot = 0; it._hang = 0;
      it.gravityScale = 1;
      it.fadeAt = 1e9;
      var v = rng.range(0.58, 0.95);
      it._baseR = 0.88 * v; it._baseG = 0.68 * v; it._baseB = 0.30 * v;
      it.color.setRGB(it._baseR, it._baseG, it._baseB);
    }
    shells.sync();
  };

  VFX.prototype._updateLitter = function (dt, ctx) {
    var pool = this.litter;
    if (!pool || !this._litterInit) return;
    var cam = ctx.camera ? ctx.camera.position : null;
    var w = this.wind;
    var n = pool.active.length;
    // Re-ground two pieces per frame on a rolling schedule so scraps stay glued
    // to whatever surface they are actually over as the player moves - not only
    // when they hit the 26 m recycle radius.
    var reIdx = -1;
    if (cam && n > 0) reIdx = (this._litterCursor = (this._litterCursor + 1) % n);
    for (var i = 0; i < n; i++) {
      var it = pool.items[pool.active[i]];
      var speed = this.windSpeed * it._drag;
      it.pos.x += w.x * dt * it._drag + Math.sin(this.time * 1.7 + it._phase) * 0.25 * dt;
      it.pos.z += w.z * dt * it._drag;
      it._hopT += dt * (0.9 + speed * 0.4);
      // skitter: mostly ON THE GROUND, occasionally nudged by a gust. Capped
      // hard at 0.30 m - anything more and a scrap reads as a card floating at
      // head height, which is exactly the artefact the critics flagged.
      var hop = Math.max(0, Math.sin(it._hopT * 2.1 + it._phase)) *
                Math.max(0, Math.sin(it._hopT * 0.31 + it._phase * 0.5));
      it.pos.y = it.groundY + 0.015 + hop * Math.min(0.30, 0.10 + 0.16 * speed);
      // A plane's normal is +Z; -90 deg about X lays it face-up on the ground.
      // Resting scraps lie flat and only tip up while they are being lofted.
      _q1.setFromAxisAngle(UP, this.time * it._spinA * 0.35 + it._phase);
      _q2.setFromAxisAngle(_v1.set(1, 0, 0),
        -Math.PI * 0.5 + Math.sin(this.time * it._spinB + it._phase) * (0.16 + hop * 1.5));
      it.quat.copy(_q1).multiply(_q2);
      if (cam) {
        // recycle upwind once it drifts too far, so the field follows the player
        var dx = it.pos.x - cam.x, dz = it.pos.z - cam.z;
        if (dx * dx + dz * dz > 26 * 26) {
          it.pos.x = cam.x - w.x * 12 + this.rng.range(-14, 14);
          it.pos.z = cam.z - w.z * 12 + this.rng.range(-14, 14);
          it.groundY = this._groundY(it.pos.x, cam.y + 1.0, it.pos.z, it.groundY);
          it._hopT = this.rng.range(0, 3);
        } else if (i === reIdx || i === (reIdx + 1) % n) {
          var gy = this._groundY(it.pos.x, it.pos.y + 1.6, it.pos.z, null);
          if (gy !== null && Math.abs(gy - it.groundY) < 4.0) it.groundY = gy;
        }
      }
    }
    pool.sync();
  };

  // --------------------------------------------------------------------------
  // Continuous smoke emitters (burning vehicles, smouldering rubble).
  // --------------------------------------------------------------------------
  VFX.prototype.addSmokeEmitter = function (position, opts) {
    if (!position) return null;
    opts = opts || {};
    var em = {
      pos: new THREE.Vector3().copy(position),
      rate: opts.rate === undefined ? 7 : opts.rate,
      accum: 0,
      radius: opts.radius === undefined ? 0.35 : opts.radius,
      rise: opts.rise === undefined ? 1.5 : opts.rise,
      size0: opts.size0 === undefined ? 0.5 : opts.size0,
      size1: opts.size1 === undefined ? 4.5 : opts.size1,
      life: opts.life === undefined ? 5.5 : opts.life,
      opacity: opts.opacity === undefined ? 0.20 : opts.opacity,
      tint: opts.tint || [0.16, 0.145, 0.13],
      embers: opts.embers === undefined ? 0.35 : opts.embers,
      // heat > 0 gives the column a visible combustion source at its base:
      // short-lived FIRE particles on the blackbody ramp. A smoke plume with
      // no fire under it is indistinguishable from the distance haze behind
      // it, which is exactly what the burnt-out sedan was rendering.
      heat: opts.heat === undefined ? 0 : opts.heat,
      fireAccum: 0,
      // Absolute sim time at which this emitter retires. Set by explosion() so
      // a crater burns for a legible dozen seconds and then stops, without any
      // per-frame timer or allocation.
      expireAt: opts.expireAt === undefined ? 0 : opts.expireAt,
      enabled: true
    };
    this.emitters.push(em);
    return em;
  };

  VFX.prototype._initAmbientEmitters = function () {
    var ctx = this.ctx;
    var placed = 0;
    var list = (ctx.props && ctx.props.smokeEmitters) ||
               (ctx.level && ctx.level.smokeEmitters) || null;
    if (list && list.length) {
      for (var i = 0; i < list.length && i < 6; i++) {
        var e = list[i];
        var p = e && e.position ? e.position : e;
        if (p && typeof p.x === 'number') { this.addSmokeEmitter(p, e && e.opts); placed++; }
      }
    }
    if (placed) return;
    // Fallback: the burnt-out sedan mid-street from ART_DIRECTION. Only place
    // it if the level really does have ground there, so a different layout
    // never gets a smoke column hanging inside a wall.
    var candidates = [[1.6, -18.0], [-2.4, -30.0]];
    for (var c = 0; c < candidates.length; c++) {
      var x = candidates[c][0], z = candidates[c][1];
      var gy = this._groundY(x, 3.0, z, null);
      if (gy === null) continue;
      if (gy < -0.6 || gy > 0.9) continue;
      this.addSmokeEmitter(_v1.set(x, gy + 0.55, z), {
        rate: c === 0 ? 7 : 3.6,
        radius: 0.55, rise: 1.35,
        size0: 0.55, size1: c === 0 ? 5.5 : 3.6,
        life: c === 0 ? 6.5 : 5.0,
        // Value contrast against the haze is the entire job. 0.19 is fog.
        opacity: c === 0 ? 0.42 : 0.26,
        tint: [0.16, 0.145, 0.13],
        embers: c === 0 ? 0.7 : 0.2,
        heat: c === 0 ? 1.0 : 0.35
      });
      placed++;
      if (placed >= 2) break;
    }
  };

  VFX.prototype._updateEmitters = function (dt) {
    var ctx = this.ctx;
    var cam = ctx.camera ? ctx.camera.position : null;
    var night = this._night;

    // park the permanent fire light on the hottest emitter and flicker it on a
    // two-rate noise curve, so the plume has a source you can see it lighting
    if (this.fireLight) {
      var hot = null, hotV = 0;
      for (var h = 0; h < this.emitters.length; h++) {
        var eh = this.emitters[h];
        if (eh.enabled && eh.heat > hotV) { hotV = eh.heat; hot = eh; }
      }
      if (hot) {
        this.fireLight.position.set(hot.pos.x, hot.pos.y + 0.25, hot.pos.z);
        var t2 = this.time;
        var fl = 0.72 + 0.28 * Math.sin(t2 * 7.3) * Math.sin(t2 * 2.9 + 1.1) +
                 0.14 * Math.sin(t2 * 17.7 + 0.4);
        // A 0.5 m burn barrel and a 1.3 m crater are not the same lamp. Range
        // and radiance both track the emitter radius, and both are lifted at
        // night, where a practical is meant to be the dominant light in frame
        // rather than an unexplained warm patch with no visible source.
        var frad = hot.radius || 0.4;
        var fscale = M.clamp(frad * 3.0, 0.8, 6.0);
        this.fireLight.distance = M.clamp(7.0 + frad * 9.0, 9, 28);
        this.fireLight.intensity = 3.6 * hotV * M.clamp(fl, 0.35, 1.35) *
                                   fscale * (1.0 + 1.8 * night);
      } else if (this.fireLight.intensity !== 0) {
        this.fireLight.intensity = 0;
      }
    }

    for (var i = 0; i < this.emitters.length; i++) {
      var em = this.emitters[i];
      if (!em.enabled) continue;
      if (em.expireAt && this.time > em.expireAt) { em.enabled = false; continue; }
      if (cam) {
        var d2 = em.pos.distanceToSquared(cam);
        if (d2 > 90 * 90) { em.accum = 0; continue; }
      }
      em.accum += dt * em.rate * this.qp;
      var n = Math.floor(em.accum);
      if (n <= 0) continue;
      em.accum -= n;
      if (n > 4) n = 4;
      for (var k = 0; k < n; k++) {
        var rng = this.rng;
        var p = E();
        var offX = rng.gaussian(0, em.radius * 0.5);
        var offZ = rng.gaussian(0, em.radius * 0.5);
        p.x = em.pos.x + offX;
        p.y = em.pos.y + rng.range(0, em.radius * 0.6);
        p.z = em.pos.z + offZ;
        p.vx = rng.gaussian(0, 0.22);
        p.vy = em.rise * rng.range(0.7, 1.3);
        p.vz = rng.gaussian(0, 0.22);
        // negative gravity == buoyancy; smoke has to rise, not fall
        p.gravity = -0.055;
        p.drag = 0.30;
        p.turb = 0.85;
        p.life = em.life * rng.range(0.8, 1.25);
        p.fadeIn = 0.14; p.fadeOut = 0.35;
        p.size0 = em.size0 * rng.range(0.75, 1.25);
        // Three explicit diameter tiers, not one. A column of uniform-diameter
        // puffs is a tube; a column that widens with height is a plume.
        var tier = rng.next();
        var tierK = tier < 0.34 ? 0.40 : (tier < 0.72 ? 0.76 : 1.34);
        p.size1 = em.size1 * tierK * rng.range(0.82, 1.20);
        p.rot = rng.range(0, M.TAU);
        p.rotSpd = rng.gaussian(0, 0.25);
        p.frame = PT.SMOKE_A + (rng.next() * 3 | 0);
        p.opacity = em.opacity * rng.range(0.7, 1.25);
        p.r = em.tint[0]; p.g = em.tint[1]; p.b = em.tint[2];
        // depth into the plume: the LIT branch's self-shadow term drives the
        // axis dark while the rim keeps the sun. It already exists and was
        // simply never fed for ambient smoke.
        p.core = 1.0 - M.clamp(
          Math.sqrt(offX * offX + offZ * offZ) / Math.max(em.radius * 0.6, 1e-3), 0, 1);
        p.seed = rng.next();
        this._add(this.layers.lit, p);
      }

      // combustion at the base: this is what turns a grey wash into a fire.
      //
      // The rate scales hard with darkness. 5.5/s at life 0.5-1.1 s keeps about
      // four 0.4 m cards alive at once, which at 18 m is a handful of 20 px
      // puffs at intensity 1.4 - fine against sunlit plaster, completely
      // invisible against a 0.083-mean night frame that has the emitter's own
      // warm rim light plainly visible on the barrels beside it.
      if (em.heat > 0) {
        em.fireAccum += dt * (5.5 + 15.0 * night) * em.heat * this.qp;
        var nf = Math.floor(em.fireAccum);
        em.fireAccum -= nf;
        if (nf > 5) nf = 5;
        for (var f = 0; f < nf; f++) {
          var rf = this.rng;
          var q2 = E();
          var fr = rf.range(0, em.radius * 0.75);
          var fa = rf.range(0, M.TAU);
          q2.x = em.pos.x + Math.cos(fa) * fr;
          q2.y = em.pos.y - em.radius * 0.35 + rf.range(0, 0.25);
          q2.z = em.pos.z + Math.sin(fa) * fr;
          q2.vx = rf.gaussian(0, 0.18);
          q2.vy = rf.range(1.1, 2.4);
          q2.vz = rf.gaussian(0, 0.18);
          q2.gravity = -0.30; q2.drag = 1.9; q2.turb = 0.55;
          q2.life = rf.range(0.5, 1.1);
          q2.fadeIn = 0.10; q2.fadeOut = 0.42;
          q2.size0 = 0.30 * rf.range(0.7, 1.3);
          q2.size1 = 0.85 * rf.range(0.7, 1.4);
          q2.rot = rf.range(0, M.TAU); q2.rotSpd = rf.gaussian(0, 1.0);
          q2.frame = PT.FIRE; q2.ramp = RAMP.FIRE;
          q2.intensity = 1.4 * (1.0 + 2.5 * night) * rf.range(0.8, 1.3);
          q2.opacity = rf.range(0.55, 0.85);
          q2.core = M.clamp(1.0 - fr / Math.max(em.radius * 0.75, 1e-3), 0, 1) *
                    rf.range(0.7, 1.0);
          q2.seed = rf.next();
          this._add(this.layers.fire, q2);
        }
      }

      // Embers are the single highest-value element in any night frame and the
      // old gate (0.7 * 1/60 * 6 = a 7% chance per frame, ~4/s) produced almost
      // none of them. 36x that rate at midnight is still only ~25 cards alive.
      if (em.embers > 0 && this.rng.bool(em.embers * dt * (6 + 34 * night))) {
        var q = E();
        q.x = em.pos.x + this.rng.gaussian(0, em.radius * 0.4);
        q.y = em.pos.y;
        q.z = em.pos.z + this.rng.gaussian(0, em.radius * 0.4);
        q.vx = this.rng.gaussian(0, 0.4);
        q.vy = this.rng.range(1.4, 3.2);
        q.vz = this.rng.gaussian(0, 0.4);
        q.gravity = -0.12; q.drag = 0.8; q.turb = 0.5;
        q.life = this.rng.range(1.2, 2.6);
        q.fadeIn = 0.08; q.fadeOut = 0.4;
        q.size0 = 0.020; q.size1 = 0.008;
        q.frame = PT.EMBER; q.ramp = RAMP.EMBER;
        q.intensity = 2.2; q.opacity = 1; q.stretch = 0.05;
        q.seed = this.rng.next();
        this._add(this.layers.add, q);
      }
    }
  };

  // --------------------------------------------------------------------------
  // helpers
  // --------------------------------------------------------------------------
  VFX.prototype._add = function (layer, p) {
    if (this._budget <= 0) return;
    this._budget--;
    layer.emit(p, this.time);
  };

  // Also stashes the camera distance in this._lodDist, so callers that need to
  // scale screen area with range do not have to compute it twice.
  VFX.prototype._lod = function (x, y, z) {
    var c = this.ctx.camera;
    if (!c) { this._lodDist = 0; return 1; }
    var dx = x - c.position.x, dy = y - c.position.y, dz = z - c.position.z;
    var d2 = dx * dx + dy * dy + dz * dz;
    this._lodDist = Math.sqrt(d2);
    if (d2 < 625) return 1;        // < 25 m
    if (d2 < 2500) return 0.6;     // < 50 m
    if (d2 < 8100) return 0.3;     // < 90 m
    return 0.12;
  };

  // Screen-align a viewmodel-derived world point.
  //
  // weapons.muzzleWorldPosition round-trips the muzzle through
  // viewCamera^-1 -> camera, a RIGID transform: it preserves the 3D
  // camera-relative offset but NOT the projection. viewCamera runs at the
  // weapon's FOV (55-80 deg, and it changes on ADS) while ctx.camera runs at
  // the player FOV, so an off-axis muzzle lands at
  // tan(fovView/2)/tan(fovWorld/2) of its correct screen radius - a visible
  // gap of unlit air between the barrel and the fire. Scaling the camera-space
  // x/y by the inverse ratio puts the point back underneath the barrel on
  // screen at the same depth, which is what a tracer origin and an ejection
  // port need. (The flash itself cannot be fixed this way - it also has to be
  // drawn OVER the gun - so that one lives in the view scene.)
  var _mAlign = new THREE.Matrix4();
  VFX.prototype._alignToView = function (world, out) {
    out.copy(world);
    var ctx = this.ctx;
    var cam = ctx.camera, vcam = ctx.viewCamera;
    if (!cam || !vcam) return out;
    var fw = Math.tan((cam.fov || 75) * M.DEG * 0.5);
    var fv = Math.tan((vcam.fov || 55) * M.DEG * 0.5);
    if (!(fv > 1e-4) || !(fw > 1e-4)) return out;
    try {
      cam.updateMatrixWorld();
      out.applyMatrix4(_mAlign.copy(cam.matrixWorld).invert());
      // ONLY for viewmodel-derived points. ballistics also calls tracer() with
      // segment starts deep in the world (after a penetration, say); scaling
      // the camera-space x/y of a point 30 m out would fling it metres sideways.
      if (-out.z < 1.6 && out.lengthSq() < 2.56) {
        var k = fw / fv;
        out.x *= k; out.y *= k;
      }
      out.applyMatrix4(cam.matrixWorld);
    } catch (e) { out.copy(world); }
    return out;
  };

  // Ground height under a point. `miss` is what to return when there is no
  // level to ask (null lets callers distinguish "no data" from "y = 0").
  VFX.prototype._groundY = function (x, fromY, z, miss) {
    var ctx = this.ctx;
    if (ctx.level && ctx.level.raycast) {
      try {
        _v5.set(x, fromY, z);
        var r = ctx.level.raycast(_v5, DOWN, 40);
        if (r && r.hit && r.point) return r.point.y;
      } catch (e) { /* level may be half-built */ }
    }
    return miss === undefined ? 0 : miss;
  };

  VFX.prototype._sound = function (name, pos, vol, pitch) {
    var a = this.ctx.audio;
    if (!a || !a.play) return;
    try { a.play(name, { position: pos, volume: vol, pitch: pitch }); }
    catch (e) { /* audio module is optional */ }
  };

  // Launch physical chunks. dir may be null for an omnidirectional burst.
  VFX.prototype._spawnDebris = function (x, y, z, count, dir, speed, spread, sMin, sMax, col, life) {
    var pool = this.debris;
    if (!pool) return;
    var rng = this.rng;
    var gy = this._groundY(x, y + 0.35, z);
    for (var i = 0; i < count; i++) {
      var it = pool.acquire();
      if (!it) return;
      it.pos.set(x, y, z);
      if (dir) rng.inCone(dir, spread, _v1);
      else rng.onSphere(_v1);
      if (_v1.y < 0 && !dir) _v1.y = -_v1.y * 0.4;
      var sp = speed * rng.range(0.45, 1.35);
      it.vel.copy(_v1).multiplyScalar(sp);
      it.vel.y += rng.range(0.4, 2.2);
      it.spin.set(rng.gaussian(0, 14), rng.gaussian(0, 14), rng.gaussian(0, 14));
      var s = rng.range(sMin, sMax);
      it._sx = s * rng.range(0.6, 1.4);
      it._sy = s * rng.range(0.5, 1.2);
      it._sz = s * rng.range(0.6, 1.4);
      it.scale.set(it._sx, it._sy, it._sz);
      it.radius = s * 0.4;
      it.groundY = gy;
      it.restitution = rng.range(0.18, 0.34);
      it.friction = 0.55;
      it.fadeAt = life * rng.range(0.8, 1.25);
      var vr = rng.range(0.78, 1.22);
      it.color.setRGB(col[0] * vr, col[1] * vr, col[2] * vr);
      it._laid = false;
    }
  };

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  // Is `pos` the player's own flash hider? weapons.js calls muzzleFlash with
  // exactly weapons.muzzleWorldPosition(), so identity is a 25 cm sphere test
  // and nothing else. Everything that fails it is somebody ELSE shooting.
  VFX.prototype._isPlayerMuzzle = function (pos) {
    try {
      var w = this.ctx.weapons;
      if (!w || typeof w.muzzleWorldPosition !== 'function') return false;
      w.muzzleWorldPosition(_v6);
      return _v6.distanceToSquared(pos) < 0.0625;
    } catch (e) { return false; }
  };

  // Per-emitter rapid-fire damper. One shared `_lastFlashAt` meant an enemy
  // firing silently halved the player's next flash and vice versa; the key is
  // a 0.5 m spatial hash of the emitter (0 = the player), so two shooters a
  // metre apart never damp each other and one shooter firing at 800 rpm still
  // does damp himself.
  VFX.prototype._flashStack = function (key) {
    var arr = this._flashKeys, i, e = null;
    for (i = 0; i < arr.length; i++) { if (arr[i].k === key) { e = arr[i]; break; } }
    if (!e) {
      if (arr.length < 12) { e = { k: key, t: -1e9 }; arr.push(e); }
      else {
        e = arr[0];
        for (i = 1; i < arr.length; i++) if (arr[i].t < e.t) e = arr[i];
        e.k = key; e.t = -1e9;
      }
    }
    var s = (this.time - e.t) < 0.040 ? 0.45 : 1.0;
    e.t = this.time;
    return s;
  };

  // Roll (radians) that puts a billboard's local +X along the SCREEN-SPACE
  // projection of `dir` emanating from `pos`. The flash cards are a forward
  // cone now, so they have to be aimed down the bore as it appears on screen,
  // not spun to a random angle. Derivative of the perspective divide:
  //   d/dt (P.x / -P.z)  ~  P.x*D.z - D.x*P.z
  // which stays well-conditioned even when the bore points at the camera (the
  // cone then fans radially outward from the screen centre, which is exactly
  // what a cone seen end-on does).
  VFX.prototype._boreRoll = function (pos, dir, cam) {
    if (!cam) return 0;
    try {
      cam.updateMatrixWorld();
      _v7.copy(pos).applyMatrix4(_mAlign.copy(cam.matrixWorld).invert());
      _v8.copy(dir).transformDirection(_mAlign);
      var sx = _v7.x * _v8.z - _v8.x * _v7.z;
      var sy = _v7.y * _v8.z - _v8.y * _v7.z;
      if (sx * sx + sy * sy < 1e-10) return 0;
      return Math.atan2(sy, sx);
    } catch (e) { return 0; }
  };

  // -- muzzle flash ----------------------------------------------------------
  // Layered: forward gas cone + hot core + smoke + forward sparks + heat + a
  // real light. Total burn is ~70 ms; the light is the part you actually feel
  // at night.
  //
  // Three things here are load-bearing and must not be "simplified" away:
  //
  //  1. Routing is by EMITTER IDENTITY, not by whether a view layer exists.
  //     The player's fire lives in ctx.viewScene at the VIEWMODEL muzzle -
  //     the world round trip is rigid, so it preserves the 3D offset but not
  //     the projection, the flash lands ~35 px off the flash hider, and it
  //     also has to composite OVER the gun. Everyone ELSE gets their flash in
  //     world space at the position they passed. Anchoring an enemy's flash to
  //     the player's flash hider is how a militiaman at 12 m ends up lit by an
  //     unaccompanied point light with no fire attached to it.
  //  2. The cards are a forward CONE and are rolled to the screen-space bore.
  //     Random roll averages any silhouette into a radially uniform starburst.
  //  3. The HDR budget is split so ONLY a pinhole clips. Cards at 2-3x an
  //     orange ramp tone-map to saturated orange; cards at 8-16x a
  //     (3.6,3.0,2.2) ramp are 30-50x white on every channel, which puts the
  //     entire silhouette inside the clipped region of the filmic curve and
  //     turns burning gas into a smooth white ball.
  VFX.prototype.muzzleFlash = function (pos, dir, weapon) {
    if (!this.ready || !this.enabled || !pos) return;
    var rng = this.rng;
    var w = weapon || {};
    var s = w.flashScale || w.muzzleFlashScale || 1.0;
    var suppressed = !!(w.suppressed || w.silenced);
    if (suppressed) s *= 0.42;

    var d = _v2.set(0, 0, -1);
    if (dir && dir.isVector3 && dir.lengthSq() > 1e-8) d.copy(dir).normalize();
    var px = pos.x, py = pos.y, pz = pos.z;
    var lod = this._lod(px, py, pz);
    var dist = this._lodDist;
    var p, i;

    var useView = !!this.layers.view && this._isPlayerMuzzle(pos);
    var key = useView ? 0 : (
      (Math.round(px * 2) * 73856093 ^ Math.round(py * 2) * 19349663 ^
       Math.round(pz * 2) * 83492791) | 1);
    var stack = this._flashStack(key);
    this._lastFlashAt = this.time;

    var fireLayer = useView ? this.layers.view : this.layers.fire;
    var sparkLayer = useView ? this.layers.view : this.layers.add;
    var fx = px, fy = py, fz = pz;
    var fd = _v4.copy(d);
    // A 20 cm flash at 12 m is 8 px and simply is not a muzzle flash. Grow the
    // world-space cards with range so an enemy's fire always holds ~20 px -
    // the same trick impact() already uses for its plume.
    var ws = 1.0;
    if (!useView) {
      ws = M.clamp(dist / 5.0, 1.0, 3.4);
    } else {
      this._viewMuzzlePosition(_v3);
      fx = _v3.x; fy = _v3.y; fz = _v3.z;
      this._viewMuzzleDir(fd);
      // Remember where the flash hider was at ignition. update() feeds the
      // delta against its CURRENT position into the view layer's uAnchor, so
      // the whole flash rides the recoil stroke welded to the barrel.
      this._flashAnchor.set(fx, fy, fz);
      this.sharedV.uAnchor.value.set(0, 0, 0);
      this._lastViewFlashAt = this.time;
      // Rounds-per-second proxy for the accumulating propellant haze, counted
      // for the PLAYER'S weapon only. Summed over five shooters it saturates in
      // a third of a second and every one of them starts laying down 1.4 m
      // cards, which greys out the whole firefight frame.
      this._burstHeat = Math.min(8, this._burstHeat + 1);
    }
    var roll = this._boreRoll(_v5.set(fx, fy, fz), fd,
      useView ? this.ctx.viewCamera : this.ctx.camera);

    // (a) forward gas cone. Four cone cards fanned around the bore roll plus
    // one symmetric crown card - one card reads as a shape, five read as
    // burning gas, and the crown is what keeps the crown of the flash from
    // being a hole.
    var petals = suppressed ? 2 : 5;
    for (i = 0; i < petals; i++) {
      var crown = (i === 2 && !suppressed);
      p = E();
      p.x = fx + fd.x * 0.02; p.y = fy + fd.y * 0.02; p.z = fz + fd.z * 0.02;
      p.vx = fd.x * 1.1; p.vy = fd.y * 1.1; p.vz = fd.z * 1.1;
      p.drag = 12;
      p.life = rng.range(0.042, 0.072);
      p.fadeIn = 0.10; p.fadeOut = 0.30;
      // The cone occupies the forward HALF of its card, so the flame reaches
      // ~0.47*size in front of the muzzle: 0.27 m of card is 13 cm of fire,
      // which is what a 14.5" carbine actually throws.
      p.size0 = (0.105 + i * 0.018) * s * ws * (crown ? 0.55 : 1.0);
      p.size1 = (0.170 + i * 0.026) * s * ws * (crown ? 0.60 : 1.0);
      // bore roll plus a little jitter - NOT rng.range(0, TAU)
      p.rot = crown ? rng.range(0, M.TAU) : (roll + rng.gaussian(0, 0.20));
      p.rotSpd = crown ? rng.gaussian(0, 4.0) : rng.gaussian(0, 1.2);
      p.frame = crown ? PT.CORE : ((i & 1) ? PT.PETAL_B : PT.PETAL_A);
      p.ramp = RAMP.MUZZLE;
      // Measured, the gas body came out of the tone curve at 0.64-0.68
      // luminance - DARKER than the sunlit plaster it is silhouetted against,
      // so in daylight it did not read as a light source at all. The energy
      // split was inverted: a huge dull envelope around a 6 px pinprick. The
      // gas is the element that can be both bright AND saturated (the MUZZLE
      // ramp head holds blue at 0.055 while red runs at 1.40), so the radiance
      // belongs here, not in the core.
      p.intensity = (4.0 + rng.range(0, 2.0)) * (suppressed ? 0.45 : 1.0) * stack *
                    (crown ? 1.25 : 1.0);
      p.opacity = 1;
      p.soft = 0.05 * ws;
      p.seed = rng.next();
      this._add(fireLayer, p);
    }

    // (b) hot core, blackbody ~3200 K. Small and hot: this is the only part
    // allowed to clip, and at 0.10*s it is roughly 40 px on screen.
    GAME.Color.kelvin(3200 + rng.range(-300, 250), _c1);
    p = E();
    p.x = fx; p.y = fy; p.z = fz;
    p.vx = fd.x * 0.7; p.vy = fd.y * 0.7; p.vz = fd.z * 0.7;
    p.drag = 14;
    p.life = 0.046;
    p.fadeIn = 0.08; p.fadeOut = 0.25;
    // The distance widener `ws` is applied to the CONE cards, which carry the
    // shape, but only half of it to the core and the glow. A 0.10 m core grown
    // to 0.34 m and left at intensity 12 is a 17 px clipped disc plus bloom at
    // 14 m - i.e. exactly the "muzzle flash is a white sphere" instant-fail,
    // which is what an enemy's fire looked like the moment it started being
    // routed into world space at all.
    var cs = useView ? ws : (1.0 + (ws - 1.0) * 0.45);
    // 3x wider at 60% radiance. The old 0.055/0.10 core clipped over a ~6 px
    // dot (26-34 px above 0.99 luminance, measured) - a pinprick highlight, not
    // the "small clipped pinhole inside saturated orange gas" the surrounding
    // comment is aiming at. At 0.095/0.24 the clipped kernel is ~20 px across
    // while the total energy barely moves, because area went up 6x and
    // radiance came down to 0.6.
    p.size0 = 0.085 * s * cs; p.size1 = 0.20 * s * cs;
    p.frame = PT.CORE;
    p.r = _c1.r; p.g = _c1.g; p.b = _c1.b;
    p.intensity = (suppressed ? 2.8 : 6.0) * s * stack * (useView ? 1.0 : 0.55);
    p.rot = rng.range(0, M.TAU);
    p.soft = 0.04 * ws;
    p.seed = rng.next();
    this._add(fireLayer, p);

    // small ambient glow so the barrel area reads hot for a frame or two.
    // 0.22*s, NOT 0.85*s: an 0.85 m structureless radial gradient 0.6 m from
    // the eye IS the white ball, whatever the cone underneath it is doing.
    p = E();
    p.x = fx; p.y = fy; p.z = fz;
    p.life = 0.085; p.fadeIn = 0.12; p.fadeOut = 0.2;
    p.size0 = 0.10 * s * cs; p.size1 = 0.22 * s * cs;
    p.frame = PT.GLOW;
    GAME.Color.kelvin(2400, _c1);
    p.r = _c1.r; p.g = _c1.g; p.b = _c1.b;
    p.intensity = 0.35 * s * stack * (useView ? 1.0 : 0.7);
    p.soft = 0.06 * ws;
    p.seed = rng.next();
    this._add(fireLayer, p);

    // (c) fast-expanding smoke puff pushed out of the muzzle. This one stays
    // in WORLD space: it is diffuse, so the projection mismatch is invisible,
    // and it must be fogged and lit with the rest of the scene.
    var puffs = suppressed ? 4 : 4;
    for (i = 0; i < puffs; i++) {
      // Pushed 0.15-0.45 m DOWN THE BORE rather than sitting on the flash
      // hider: four opaque cards 0.6 m from the eye is a grey veil over the
      // lens, the same four 0.9 m out is propellant smoke hanging in front of
      // the gun, which is what a carbine on auto actually looks like.
      var pd = 0.15 + i * 0.10;
      p = E();
      p.x = px + d.x * pd + rng.gaussian(0, 0.03);
      p.y = py + d.y * pd + rng.gaussian(0, 0.03);
      p.z = pz + d.z * pd + rng.gaussian(0, 0.03);
      p.vx = d.x * rng.range(1.2, 2.6) + rng.gaussian(0, 0.25);
      p.vy = d.y * rng.range(1.2, 2.6) + rng.range(0.15, 0.55);
      p.vz = d.z * rng.range(1.2, 2.6) + rng.gaussian(0, 0.25);
      p.drag = 3.4; p.gravity = -0.05; p.turb = 0.35;
      p.life = rng.range(0.55, 1.05) * (suppressed ? 1.5 : 1.0);
      p.fadeIn = 0.09; p.fadeOut = 0.28;
      p.size0 = 0.07 * s; p.size1 = rng.range(0.42, 0.68) * s;
      p.rot = rng.range(0, M.TAU); p.rotSpd = rng.gaussian(0, 1.1);
      p.frame = PT.SMOKE_A + (rng.next() * 3 | 0);
      p.opacity = (suppressed ? 0.30 : 0.26) * rng.range(0.7, 1.3);
      p.r = 0.66; p.g = 0.62; p.b = 0.56;
      p.seed = rng.next();
      this._add(this.layers.lit, p);
    }

    // (c2) accumulating burst haze. Twelve small puffs at 0.15 effective alpha
    // integrate to nothing; sustained automatic fire builds a legible grey veil
    // within a second, and it is the cheapest thing in the frame that says
    // "this gun has been firing". One extra card per shot, only once the
    // shooter is actually into a burst.
    if (this._burstHeat > 3 && !suppressed && useView) {
      p = E();
      p.x = px + d.x * 0.55 + rng.gaussian(0, 0.10);
      p.y = py + d.y * 0.55 + rng.gaussian(0, 0.08);
      p.z = pz + d.z * 0.55 + rng.gaussian(0, 0.10);
      p.vx = d.x * rng.range(0.5, 1.2) + rng.gaussian(0, 0.18);
      p.vy = 0.25 + rng.range(0, 0.18);
      p.vz = d.z * rng.range(0.5, 1.2) + rng.gaussian(0, 0.18);
      p.drag = 1.1; p.gravity = -0.04; p.turb = 0.45;
      p.life = rng.range(2.2, 3.5);
      p.fadeIn = 0.22; p.fadeOut = 0.35;
      p.size0 = 0.22 * s; p.size1 = rng.range(0.9, 1.4) * s;
      p.rot = rng.range(0, M.TAU); p.rotSpd = rng.gaussian(0, 0.5);
      p.frame = PT.SMOKE_A + (rng.next() * 3 | 0);
      p.opacity = 0.05 + 0.018 * this._burstHeat;
      p.r = 0.62; p.g = 0.59; p.b = 0.54;
      p.seed = rng.next();
      this._add(this.layers.lit, p);
    }

    // (d) forward-ejected sparks - unburnt powder, with drag and gravity
    var nSparks = Math.round((suppressed ? 4 : 13) * lod * this.qp);
    for (i = 0; i < nSparks; i++) {
      rng.inCone(fd, 0.42, _v1);
      p = E();
      p.x = fx + fd.x * 0.03; p.y = fy + fd.y * 0.03; p.z = fz + fd.z * 0.03;
      var sp = rng.range(4.5, 17.0) * (useView ? 0.45 : 1.0);
      p.vx = _v1.x * sp; p.vy = _v1.y * sp + rng.range(-0.5, 1.0); p.vz = _v1.z * sp;
      p.drag = rng.range(3.5, 6.5);
      p.gravity = 1.0;
      p.life = rng.range(0.10, 0.42);
      p.fadeIn = 0.05; p.fadeOut = 0.35;
      // The velocity stretch is `1 + stretch * |v|`, and the view case halves
      // the speed to keep sparks inside the viewmodel volume - so at 0.035 a
      // 2-7.6 m/s view spark stretched 1.07-1.27x on a 6-13 mm card and the
      // STREAK tile drew essentially square, i.e. as round white confetti.
      // Compensate the stretch for the speed scale and give the card enough
      // length to be legible at 0.6 m.
      p.size0 = (useView ? rng.range(0.010, 0.020) : rng.range(0.006, 0.013)) * ws;
      p.size1 = 0.003 * ws;
      p.frame = PT.STREAK;
      p.ramp = RAMP.EMBER;
      p.intensity = 4.5 * stack;
      p.stretch = useView ? 0.14 : 0.035;
      p.soft = 0.04;
      p.seed = rng.next();
      this._add(sparkLayer, p);
    }

    // (e) barrel heat shimmer - hot air rising off the gas block. We have no
    // scene-colour buffer to refract, so this is a near-invisible lit wisp
    // with high turbulence, which reads as heat haze at small scale.
    for (i = 0; i < 2; i++) {
      p = E();
      p.x = px - d.x * rng.range(0.05, 0.22);
      p.y = py + 0.02;
      p.z = pz - d.z * rng.range(0.05, 0.22);
      p.vy = rng.range(0.35, 0.75);
      p.vx = rng.gaussian(0, 0.08); p.vz = rng.gaussian(0, 0.08);
      p.gravity = -0.1; p.drag = 1.2; p.turb = 1.5;
      p.life = rng.range(0.3, 0.55);
      p.fadeIn = 0.25; p.fadeOut = 0.35;
      p.size0 = 0.05; p.size1 = 0.16;
      p.frame = PT.DUST;
      p.opacity = 0.055;
      p.r = 1.0; p.g = 0.96; p.b = 0.9;
      p.rot = rng.range(0, M.TAU); p.rotSpd = rng.gaussian(0, 2.0);
      p.seed = rng.next();
      this._add(this.layers.lit, p);
    }

    // (f) the light. Two or three frames, but it lights the world and the
    // viewmodel, which is the single most convincing part of a night shot.
    //
    // It is pushed a third of a metre DOWN THE BORE and given a short range.
    // A 190-intensity point light sitting inside the shooter's own hands is
    // 190/0.1^2 on his sleeves: it blows his whole torso to white while the
    // man a metre beside him is normally exposed, which is precisely the
    // artefact the firefight captures showed. Out at the flash hider with a
    // 6-12 m falloff it lights the ground and the shooter's arms instead.
    GAME.Color.kelvin(2950, _c1);
    if (this.lights) {
      _v3.copy(pos).addScaledVector(d, 0.35);
      this.lights.flash(_v3, _c1, (suppressed ? 20 : (useView ? 105 : 58)) * s,
        0.085, 34, useView ? 12 : 6, 1);
    }
    if (this.viewLights && this.ctx.viewCamera && useView) {
      this._viewMuzzlePosition(_v3);
      this.viewLights.flash(_v3, _c1, (suppressed ? 0.9 : 3.4) * s, 0.085, 34, 2.2, 1);
    }
  };

  // Where the muzzle sits in the viewmodel scene (ctx.viewScene coordinates).
  // Ask the weapon system first; fall back to a plausible offset in front of
  // the view camera. This is the anchor for the whole flash, so it is worth
  // digging through weapons' model to find the real flash-hider node.
  VFX.prototype._viewMuzzlePosition = function (out) {
    var ctx = this.ctx;
    var w = ctx.weapons;
    try {
      if (w) {
        if (typeof w.muzzleViewPosition === 'function') { w.muzzleViewPosition(out); return out; }
        if (w.viewMuzzle && w.viewMuzzle.getWorldPosition) { w.viewMuzzle.getWorldPosition(out); return out; }
        var m = w.model;
        if (m && m.muzzle && m.muzzle.matrixWorld) {
          if (w.rig && w.rig.updateMatrixWorld) w.rig.updateMatrixWorld(true);
          else m.muzzle.updateMatrixWorld(true);
          out.setFromMatrixPosition(m.muzzle.matrixWorld);
          return out;
        }
        if (w.muzzle && w.muzzle.getWorldPosition && w.muzzle.parent) { w.muzzle.getWorldPosition(out); return out; }
      }
    } catch (e) { /* fall through */ }
    out.set(0.055, -0.045, -0.62);
    if (ctx.viewCamera) {
      ctx.viewCamera.updateMatrixWorld();
      out.applyMatrix4(ctx.viewCamera.matrixWorld);
    }
    return out;
  };

  // Bore axis in viewmodel-scene space. The muzzle node's local -Z is the bore
  // on every weapon built by weapons.js; if it is missing, the view camera's
  // forward is close enough for a 5 cm emission offset.
  VFX.prototype._viewMuzzleDir = function (out) {
    var ctx = this.ctx;
    var w = ctx.weapons;
    try {
      var m = w && w.model;
      if (m && m.muzzle && m.muzzle.matrixWorld) {
        var e = m.muzzle.matrixWorld.elements;
        out.set(-e[8], -e[9], -e[10]);
        if (out.lengthSq() > 1e-8) { out.normalize(); return out; }
      }
    } catch (e) { /* fall through */ }
    out.set(0, 0, -1);
    if (ctx.viewCamera) {
      ctx.viewCamera.updateMatrixWorld();
      out.set(0, 0, -1).transformDirection(ctx.viewCamera.matrixWorld);
    }
    return out;
  };

  // -- tracer ----------------------------------------------------------------
  // Ballistics may call this to force a tracer on the first round of a burst.
  // Degrades silently if it never does.
  VFX.prototype.setTracerBoost = function (n) {
    this._tracerBoost = Math.max(this._tracerBoost, (typeof n === 'number' ? n : 1) | 0);
  };

  VFX.prototype.tracer = function (from, to, speed) {
    if (!this.ready || !this.enabled || !from || !to) return;
    var rng = this.rng;

    // Put the origin back under the barrel on screen (see _alignToView).
    var org = this._alignToView(from, _v3);
    _v1.copy(to).sub(org);
    var dist = _v1.length();
    if (dist < 0.35) return;
    _v1.multiplyScalar(1 / dist);

    // Decouple VISUAL speed from ballistic speed. A real 5.56 round crosses the
    // 30 m street in 34 ms - two frames - so at true velocity there is simply
    // never a tracer in any frame you capture. Every shipped shooter draws the
    // streak at 250-350 m/s regardless of the ballistics behind it.
    var sp = (typeof speed === 'number' && speed > 1) ? speed : 340;
    sp = M.clamp(sp * 0.35, 240, 340);

    // A round coming AT you is nearly end-on, so it occupies almost no screen
    // area exactly when it matters most. Incoming fire gets a wider, hotter
    // ribbon; that read is the whole difference between "four men standing in
    // a street" and "a two-way gunfight".
    var toward = 1.0;
    var cam = this.ctx.camera;
    if (cam) {
      _v4.set(0, 0, -1).transformDirection(cam.matrixWorld);
      if (_v1.dot(_v4) > 0.25) toward = 1.35;
    }

    // The ribbon is deliberately narrow in WORLD units and the shader clamps it
    // to 2.2-3.6 px at any range. `toward` must NOT touch the width: an
    // incoming round is exactly the one whose head passes the lens, so a 1.35x
    // world width there multiplied the worst case of the near-field blow-up.
    // Incoming fire buys its read with radiance instead.
    var width = 0.022 * rng.range(0.85, 1.2);
    var inten = 8.0 * rng.range(0.85, 1.15) * (toward > 1.0 ? 1.45 : 1.0);
    // 26 m of ribbon, not 16: at 30 m a 16 m tail still reads as a dot.
    this.tracers.emit(org, _v1, dist, sp, width, 1.0, 0.44, 0.12, inten, 26.0, this.time);
    // Lagging afterglow. The head of the streak is alive for only
    // (dist + tail)/speed = 0.16 s, so with tracerEvery:3 at 200 rpm the
    // expected on-screen occupancy is well under one tracer per frame and the
    // hero capture is a coin flip. A second entry at 30% speed / 22% intensity
    // keeps a fading line on screen for ~0.45 s, which is what shipped
    // shooters actually draw.
    this.tracers.emit(org, _v1, dist, sp * 0.30, width * 1.15,
      1.0, 0.34, 0.09, inten * 0.32, 26.0, this.time);
    this._lastTracerAt = this.time;
    if (this._tracerBoost > 0) this._tracerBoost--;

    // faint smoke hanging in the first few metres of the flight path
    var n = Math.round(3 * this.qp);
    for (var i = 0; i < n; i++) {
      var d = 0.5 + i * 1.1 + rng.range(0, 0.6);
      if (d > dist) break;
      var p = E();
      p.x = org.x + _v1.x * d + rng.gaussian(0, 0.03);
      p.y = org.y + _v1.y * d + rng.gaussian(0, 0.03);
      p.z = org.z + _v1.z * d + rng.gaussian(0, 0.03);
      p.vx = rng.gaussian(0, 0.08); p.vy = rng.range(0.05, 0.25); p.vz = rng.gaussian(0, 0.08);
      p.drag = 1.4; p.gravity = -0.03; p.turb = 0.5;
      p.life = rng.range(0.5, 1.1);
      p.fadeIn = 0.25; p.fadeOut = 0.2;
      p.size0 = 0.03; p.size1 = rng.range(0.16, 0.30);
      p.frame = PT.SMOKE_B;
      p.opacity = 0.055;
      p.r = 0.70; p.g = 0.68; p.b = 0.64;
      p.rot = rng.range(0, M.TAU);
      p.delay = d / sp;
      p.seed = rng.next();
      this._add(this.layers.lit, p);
    }
  };

  // -- impact ----------------------------------------------------------------
  VFX.prototype.impact = function (point, normal, materialKind) {
    if (!this.ready || !this.enabled || !point) return;
    var rng = this.rng;
    var n = _v3.set(0, 1, 0);
    if (normal && normal.isVector3 && normal.lengthSq() > 1e-8) n.copy(normal).normalize();
    var fam = familyOf(materialKind);
    if (fam === 'flesh') { this.bloodSpray(point, n); return; }

    var F = FAM[fam] || FAM.concrete;
    var px = point.x, py = point.y, pz = point.z;
    // Distance floor. Suppressive fire lands at 25-40 m, exactly where the
    // generic LOD curve cuts the plume to a single puff and switches solid
    // debris off entirely - so a firefight frame has four rounds landing
    // downrange and not one visible strike. Impacts get their own floor.
    var dist = 0;
    var lod = Math.max(0.45, this._lod(px, py, pz)) * this.qp;
    dist = this._lodDist;
    // and the plume has to hold screen AREA, so it grows with range
    var distScale = 1.0 + M.clamp(dist / 25, 0, 1.2);
    // A round striking cover within 6 m of the camera is the effect that puts
    // the player INSIDE the fight, so it gets its own boost: more, faster
    // ejecta, more sparks and a hot pop. Nothing else in the frame tells you
    // that rounds are landing near you.
    var near = 1.0 - M.clamp(dist / 6.0, 0, 1);
    var i, p, sp;

    // build a tangent basis so debris can spray along the surface
    _v4.set(0, 1, 0);
    if (Math.abs(n.y) > 0.9) _v4.set(1, 0, 0);
    var tanA = _v1.copy(_v4).cross(n).normalize();
    var tanB = _v2.copy(n).cross(tanA).normalize();

    // ---- dust / smoke plume along the surface normal -----------------------
    var puffs = Math.max(2, Math.round((fam === 'sand' ? 4 : 3) * lod)) +
                (near > 0 ? 3 : 0);
    for (i = 0; i < puffs; i++) {
      p = E();
      p.x = px + n.x * 0.04 + rng.gaussian(0, 0.05);
      p.y = py + n.y * 0.04 + rng.gaussian(0, 0.05);
      p.z = pz + n.z * 0.04 + rng.gaussian(0, 0.05);
      sp = rng.range(0.8, 2.6) * (fam === 'sand' ? 1.4 : 1.0) * (1.0 + near * 0.9);
      p.vx = n.x * sp + rng.gaussian(0, 0.4);
      p.vy = n.y * sp + rng.gaussian(0, 0.4) + 0.35;
      p.vz = n.z * sp + rng.gaussian(0, 0.4);
      p.drag = 3.0; p.gravity = fam === 'sand' ? 0.10 : -0.02; p.turb = 0.45;
      p.life = rng.range(0.7, 1.5) * (fam === 'sand' ? 1.3 : 1.0);
      p.fadeIn = 0.10; p.fadeOut = 0.30;
      p.size0 = rng.range(0.05, 0.12) * distScale * (1 + near * 1.8);
      p.size1 = rng.range(0.35, 0.85) * (fam === 'sand' ? 1.5 : 1.0) * distScale *
                (1 + near * 1.8);
      p.rot = rng.range(0, M.TAU); p.rotSpd = rng.gaussian(0, 1.4);
      p.frame = fam === 'sand' ? PT.DUST : (PT.SMOKE_A + (rng.next() * 3 | 0));
      p.opacity = (fam === 'metal' ? 0.28 : 0.60) * rng.range(0.7, 1.3);
      p.r = F.dust[0]; p.g = F.dust[1]; p.b = F.dust[2];
      p.seed = rng.next();
      this._add(this.layers.lit, p);
    }

    // ---- ejecta ring: material thrown out along the surface ----------------
    var ring = Math.round(7 * lod);
    for (i = 0; i < ring; i++) {
      var a = (i / Math.max(ring, 1)) * M.TAU + rng.range(-0.3, 0.3);
      _v5.copy(tanA).multiplyScalar(Math.cos(a)).addScaledVector(tanB, Math.sin(a));
      _v5.addScaledVector(n, rng.range(0.25, 0.8)).normalize();
      p = E();
      p.x = px + _v5.x * 0.05; p.y = py + _v5.y * 0.05; p.z = pz + _v5.z * 0.05;
      sp = rng.range(1.8, 5.0);
      p.vx = _v5.x * sp; p.vy = _v5.y * sp; p.vz = _v5.z * sp;
      p.drag = 4.2; p.gravity = 0.6; p.turb = 0.15;
      p.life = rng.range(0.35, 0.85);
      p.fadeIn = 0.08; p.fadeOut = 0.4;
      p.size0 = rng.range(0.02, 0.05) * distScale;
      p.size1 = rng.range(0.10, 0.22) * distScale;
      p.frame = fam === 'sand' ? PT.DUST : PT.SMOKE_C;
      p.opacity = 0.45 * rng.range(0.6, 1.3);
      p.r = F.dust[0] * 0.95; p.g = F.dust[1] * 0.95; p.b = F.dust[2] * 0.95;
      p.rot = rng.range(0, M.TAU);
      p.seed = rng.next();
      this._add(this.layers.lit, p);
    }

    // ---- sparks ------------------------------------------------------------
    var sparkN = Math.round(F.sparks * lod * (1 + near * 2));
    if (fam === 'metal') sparkN = Math.round(sparkN * rng.range(0.8, 1.4));
    for (i = 0; i < sparkN; i++) {
      // metal ricochets scatter wide; concrete throws a tighter cone
      rng.inCone(n, fam === 'metal' ? 1.15 : 0.75, _v5);
      p = E();
      p.x = px + n.x * 0.02; p.y = py + n.y * 0.02; p.z = pz + n.z * 0.02;
      sp = rng.range(3.0, fam === 'metal' ? 16.0 : 9.0);
      p.vx = _v5.x * sp; p.vy = _v5.y * sp + rng.range(0, 1.2); p.vz = _v5.z * sp;
      p.drag = rng.range(1.6, 3.4);
      p.gravity = 1.0;
      p.life = rng.range(0.18, fam === 'metal' ? 0.85 : 0.45);
      p.fadeIn = 0.04; p.fadeOut = 0.4;
      p.size0 = rng.range(0.008, 0.018); p.size1 = 0.003;
      p.frame = rng.bool(0.75) ? PT.STREAK : PT.DOT;
      p.ramp = RAMP.EMBER;
      p.intensity = fam === 'metal' ? 7.0 : 4.5;
      p.stretch = 0.03;
      p.seed = rng.next();
      this._add(this.layers.add, p);
    }
    // A one-frame hot pop at the point of contact. Emitted UNCONDITIONALLY:
    // concrete, sand, wood and plaster - the level's dominant materials - all
    // have sparks: 0 or near it in daylight, so gating this behind sparkN
    // meant the cheapest, most legible part of a strike never fired at all.
    p = E();
    p.x = px + n.x * 0.02; p.y = py + n.y * 0.02; p.z = pz + n.z * 0.02;
    p.life = 0.055; p.fadeIn = 0.1; p.fadeOut = 0.2;
    p.size0 = 0.06 * distScale; p.size1 = 0.15 * distScale;
    p.frame = PT.CORE;
    GAME.Color.kelvin(2700, _c1);
    p.r = _c1.r; p.g = _c1.g; p.b = _c1.b;
    p.intensity = fam === 'metal' ? 7.0 : 2.0;
    p.rot = rng.range(0, M.TAU);
    p.seed = rng.next();
    this._add(this.layers.add, p);

    // A near miss FLASHES. 0.09 s at intensity 6 plus a 50 ms world light on
    // priority 0, so an explosion is always free to steal the slot back.
    if (near > 0) {
      p = E();
      p.x = px + n.x * 0.03; p.y = py + n.y * 0.03; p.z = pz + n.z * 0.03;
      p.life = 0.09; p.fadeIn = 0.08; p.fadeOut = 0.25;
      p.size0 = 0.10; p.size1 = 0.26 * (1 + near);
      p.frame = PT.CORE;
      GAME.Color.kelvin(2600, _c1);
      p.r = _c1.r; p.g = _c1.g; p.b = _c1.b;
      p.intensity = 6.0 * (0.4 + near);
      p.rot = rng.range(0, M.TAU);
      p.seed = rng.next();
      this._add(this.layers.fire, p);
      if (this.lights && near > 0.15) {
        GAME.Color.kelvin(2600, _c2);
        _v5.copy(point).addScaledVector(n, 0.15);
        this.lights.flash(_v5, _c2, 12 * near, 0.05, 40, 3.0, 0);
      }
    }

    // ---- solid fragments ---------------------------------------------------
    if (lod > 0.12) {
      if (fam === 'concrete') {
        this._spawnDebris(px + n.x * 0.03, py + n.y * 0.03, pz + n.z * 0.03,
          Math.round(5 * lod), n, 3.4, 0.9, 0.012, 0.032, F.chip, 3.2);
      } else if (fam === 'wood') {
        // splinters: long thin slivers rather than cubes
        this._spawnDebris(px + n.x * 0.03, py + n.y * 0.03, pz + n.z * 0.03,
          Math.round(6 * lod), n, 3.0, 1.0, 0.010, 0.026, F.chip, 3.5);
      } else if (fam === 'glass') {
        this._spawnDebris(px + n.x * 0.03, py + n.y * 0.03, pz + n.z * 0.03,
          Math.round(8 * lod), n, 3.8, 1.2, 0.010, 0.030, F.chip, 4.0);
      } else if (fam === 'sand') {
        this._spawnDebris(px + n.x * 0.03, py + n.y * 0.03, pz + n.z * 0.03,
          Math.round(4 * lod), n, 2.4, 0.9, 0.014, 0.036, F.chip, 2.4);
      } else if (fam === 'metal') {
        this._spawnDebris(px + n.x * 0.03, py + n.y * 0.03, pz + n.z * 0.03,
          Math.round(2 * lod), n, 3.0, 1.1, 0.008, 0.018, F.chip, 2.6);
      }
    }

    // ---- glass keeps sparkling for a moment as shards tumble ---------------
    if (fam === 'glass') {
      var sparkle = Math.round(10 * lod);
      for (i = 0; i < sparkle; i++) {
        rng.inCone(n, 1.3, _v5);
        p = E();
        p.x = px; p.y = py; p.z = pz;
        sp = rng.range(1.0, 4.5);
        p.vx = _v5.x * sp; p.vy = _v5.y * sp; p.vz = _v5.z * sp;
        p.drag = 0.9; p.gravity = 1.0;
        p.life = rng.range(0.6, 1.5);
        p.fadeIn = 0.05; p.fadeOut = 0.25;
        p.size0 = rng.range(0.006, 0.013); p.size1 = rng.range(0.004, 0.010);
        p.frame = PT.DOT;
        p.r = 0.85; p.g = 0.94; p.b = 1.0;
        p.intensity = rng.range(1.5, 5.0);
        p.rotSpd = rng.gaussian(0, 20);
        p.seed = rng.next();
        this._add(this.layers.add, p);
      }
    }

    // ---- decals ------------------------------------------------------------
    var holeFrame = F.hole;
    if (fam === 'concrete' && rng.bool(0.5)) holeFrame = DC.HOLE_B;
    // Footprint, not calibre: the visible mark is the spall halo around the
    // hole, which for 5.56 in plaster runs 60-90 mm across.
    var holeSize = 0.115 * rng.range(0.82, 1.30);
    if (fam === 'sand') holeSize *= 1.5;
    if (fam === 'metal') holeSize *= 0.72;
    if (fam === 'glass') holeSize *= 1.7;
    _c1.setRGB(F.decal[0], F.decal[1], F.decal[2]);
    this.decals.add(point, n, holeFrame, holeSize, holeSize,
      rng.range(0, M.TAU), 1.0,
      fam === 'glass' ? 0.55 : 1.0, _c1,
      DECAL_KINDS.bullet.ttl, this.time, 0.012);

    // a soft directional dust smear so the hole is not a lone sticker
    if (rng.bool(0.85)) {
      var smearRoll = rng.range(0, M.TAU);
      _c2.setRGB(F.dust[0], F.dust[1], F.dust[2]);
      this.decals.add(point, n, DC.SMEAR,
        holeSize * rng.range(3.5, 5.5), holeSize * rng.range(1.6, 2.6),
        smearRoll, 0.30 * rng.range(0.6, 1.2), 1.0, _c2,
        DECAL_KINDS.smear.ttl, this.time, 0.010);
    }

    this._sound('impact_' + fam, point, 0.7, 0.9 + rng.range(-0.15, 0.2));
  };

  // -- blood -----------------------------------------------------------------
  VFX.prototype.bloodSpray = function (point, normal) {
    if (!this.ready || !this.enabled || !point) return;
    var rng = this.rng;
    var n = _v3.set(0, 1, 0);
    if (normal && normal.isVector3 && normal.lengthSq() > 1e-8) n.copy(normal).normalize();
    var px = point.x, py = point.y, pz = point.z;
    // Same distance floor as impact(): a hit at 40 m is the one the player most
    // needs to read, and it is exactly where the generic LOD curve cuts the
    // spray to nothing. Mist also has to hold screen area with range.
    var lod = Math.max(0.45, this._lod(px, py, pz)) * this.qp;
    var bScale = 1.0 + M.clamp(this._lodDist / 25, 0, 1.3);
    var i, p, sp;

    // fine mist - backlit by a low sun this is the money shot
    var mist = Math.max(3, Math.round(6 * lod));
    for (i = 0; i < mist; i++) {
      p = E();
      p.x = px + rng.gaussian(0, 0.05);
      p.y = py + rng.gaussian(0, 0.05);
      p.z = pz + rng.gaussian(0, 0.05);
      sp = rng.range(0.6, 2.4);
      p.vx = n.x * sp + rng.gaussian(0, 0.5);
      p.vy = n.y * sp + rng.gaussian(0, 0.5);
      p.vz = n.z * sp + rng.gaussian(0, 0.5);
      p.drag = 4.5; p.gravity = 0.35; p.turb = 0.2;
      p.life = rng.range(0.30, 0.65);
      p.fadeIn = 0.08; p.fadeOut = 0.30;
      p.size0 = rng.range(0.05, 0.11) * bScale;
      p.size1 = rng.range(0.25, 0.55) * bScale;
      p.rot = rng.range(0, M.TAU); p.rotSpd = rng.gaussian(0, 2.0);
      p.frame = PT.MIST;
      p.opacity = 0.70 * rng.range(0.7, 1.25);
      p.r = 1.0; p.g = 1.0; p.b = 1.0;
      p.seed = rng.next();
      this._add(this.layers.lit, p);
    }

    // droplets that arc and fall
    var drops = Math.round(18 * lod);
    for (i = 0; i < drops; i++) {
      rng.inCone(n, 0.85, _v5);
      p = E();
      p.x = px; p.y = py; p.z = pz;
      sp = rng.range(2.0, 8.0);
      p.vx = _v5.x * sp; p.vy = _v5.y * sp + rng.range(0, 1.5); p.vz = _v5.z * sp;
      p.drag = 0.9; p.gravity = 1.0;
      p.life = rng.range(0.45, 1.1);
      p.fadeIn = 0.05; p.fadeOut = 0.55;
      p.size0 = rng.range(0.010, 0.026); p.size1 = rng.range(0.008, 0.018);
      p.frame = PT.DROP;
      p.opacity = 1.0;
      p.stretch = 0.02;
      p.rot = rng.range(0, M.TAU);
      p.seed = rng.next();
      this._add(this.layers.lit, p);
    }

    // splat decals: cast a few rays down-cone and paint where they land
    if (this.decals) {
      _c1.setRGB(1, 1, 1);
      var casts = Math.round(3 * lod);
      for (i = 0; i < casts; i++) {
        rng.inCone(n, 1.0, _v5);
        var hit = null;
        if (this.ctx.level && this.ctx.level.raycast) {
          try { hit = this.ctx.level.raycast(point, _v5, 3.5); } catch (e) { hit = null; }
        }
        if (hit && hit.hit && hit.point && hit.normal) {
          this.decals.add(hit.point, hit.normal,
            rng.bool() ? DC.BLOOD_A : DC.BLOOD_B,
            rng.range(0.22, 0.60), rng.range(0.22, 0.60),
            rng.range(0, M.TAU), rng.range(0.7, 1.0), 1.0, _c1,
            DECAL_KINDS.blood.ttl, this.time, 0.014);
        }
      }
      // and a splash right where the round went in
      this.decals.add(point, n, DC.BLOOD_B, 0.24, 0.24,
        rng.range(0, M.TAU), 0.9, 1.0, _c1, DECAL_KINDS.blood.ttl, this.time, 0.010);
    }

    this._sound('impact_flesh', point, 0.8, 0.9 + rng.range(-0.12, 0.16));
  };

  // -- shell casings ---------------------------------------------------------
  VFX.prototype.ejectShell = function (pos, dir, weapon) {
    if (!this.ready || !this.enabled || !pos || !this.shells) return;
    var rng = this.rng;
    var w = weapon || {};
    var it = this.shells.acquire();
    if (!it) return;

    // Eject direction. The default is up-and-slightly-forward-right, not flat
    // right: a case thrown horizontally at eye height spends its entire flight
    // behind the receiver and the stock, which fill the right third of the
    // frame, and it is out of the frustum three frames later. Lifting it clear
    // of the top rail holds it against the background for 5-8 frames, which is
    // the whole point of drawing brass at all.
    var d = _v1.set(0.62, 0.72, 0.30);
    if (dir && dir.isVector3 && dir.lengthSq() > 1e-8) d.copy(dir);
    d.normalize();
    d.x += rng.gaussian(0, 0.16);
    d.y += rng.gaussian(0, 0.14) + 0.34;
    d.z += rng.gaussian(0, 0.16);
    d.normalize();

    // Screen-align the ejection port for the same reason the tracer origin is
    // aligned: a rigid viewCamera->camera round trip puts the casing visibly
    // clear of the port it is supposed to be leaving.
    this._alignToView(pos, _v3);
    it.pos.copy(_v3);
    var speed = (w.shellSpeed || 4.2) * rng.range(0.75, 1.3);
    it.vel.copy(d).multiplyScalar(speed);
    // inherit the shooter's motion so casings do not hang in mid-air on a sprint
    var pl = this.ctx.player;
    if (pl && pl.velocity && pl.velocity.isVector3) it.vel.addScaledVector(pl.velocity, 0.85);
    // hot brass leaves the port spinning hard - 18-25 rad/s reads as a tumble,
    // anything slower reads as a stick floating sideways
    it.spin.set(rng.gaussian(0, 22) + rng.sign() * 18, rng.gaussian(0, 14),
      rng.gaussian(0, 22) + rng.sign() * 18);
    _e1.set(rng.range(0, M.TAU), rng.range(0, M.TAU), rng.range(0, M.TAU));
    it.quat.setFromEuler(_e1);
    it.scale.set(1, 1, 1);
    it.radius = 0.0055;
    it.restitution = 0.34;
    it.friction = 0.62;
    it.groundY = this._groundY(it.pos.x, it.pos.y + 0.3, it.pos.z);
    it.fadeAt = 22 + rng.range(0, 6);
    it._laid = false;
    it._snd = 'shell_bounce';
    // Buoyant first 0.18 s. Unphysical, and it is exactly what every shipped
    // shooter does: brass at 0.45 g hangs long enough to be legible and still
    // lands in the same place, because the drag term dominates by then.
    it._hang = 0.18;
    it.gravityScale = 0.45;
    // brass varies: some cases are bright, some carbon-stained. The baked case
    // map already darkens the head and soots the mouth; this is the batch tint.
    var v = rng.range(0.72, 1.15);
    it._baseR = 0.88 * v; it._baseG = 0.68 * v; it._baseB = 0.30 * v;
    // hot rim on freshly ejected brass, decaying over half a second
    it._hot = 0.5;
    it.color.setRGB(it._baseR * 1.65, it._baseG * 1.50, it._baseB * 1.25);

    // Hot brass smokes. Two thin wisps out of the case mouth is one of the
    // cheapest, highest-value details in the whole viewmodel.
    var wisps = 2;
    for (var k = 0; k < wisps; k++) {
      var p = E();
      p.x = it.pos.x + rng.gaussian(0, 0.008);
      p.y = it.pos.y + rng.gaussian(0, 0.008);
      p.z = it.pos.z + rng.gaussian(0, 0.008);
      p.vx = d.x * 0.35 + rng.gaussian(0, 0.10);
      p.vy = 0.42 + rng.range(0, 0.25);
      p.vz = d.z * 0.35 + rng.gaussian(0, 0.10);
      p.drag = 2.0; p.gravity = -0.06; p.turb = 0.7;
      p.life = 0.35 * rng.range(0.8, 1.4);
      p.fadeIn = 0.18; p.fadeOut = 0.30;
      // 0.05 opacity on a 6 cm card is below the noise floor of the frame.
      p.size0 = 0.016; p.size1 = 0.10;
      p.frame = PT.SMOKE_C;
      p.opacity = 0.16;
      p.r = 0.74; p.g = 0.72; p.b = 0.68;
      p.rot = rng.range(0, M.TAU);
      p.delay = k * 0.045;
      p.seed = rng.next();
      this._add(this.layers.lit, p);
    }
  };

  // -- generic decal ---------------------------------------------------------
  VFX.prototype.decal = function (point, normal, kind, size) {
    if (!this.ready || !this.enabled || !point || !this.decals) return -1;
    var def = DECAL_KINDS[kind] || DECAL_KINDS[String(kind || '').toLowerCase()] || DECAL_KINDS.bullet;
    var s = (typeof size === 'number' && size > 0) ? size : 0.1;
    var n = normal && normal.isVector3 ? normal : UP;
    var rng = this.rng;
    _c1.setRGB(1, 1, 1);
    var sx = s, sy = s;
    if (def.frame === DC.SMEAR) { sx = s * 2.2; sy = s * 0.9; }
    if (def.frame === DC.SOOT) { sx = s * 0.8; sy = s * 1.6; }
    return this.decals.add(point, n, def.frame, sx, sy,
      rng.range(0, M.TAU), def.opacity, def.rough, _c1, def.ttl, this.time,
      s > 0.5 ? 0.02 : 0.012);
  };

  // -- explosion -------------------------------------------------------------
  // Staged with per-particle spawn delays instead of CPU timers: the vertex
  // shader already keys off absolute spawn time, so a particle written now
  // with delay=1.2 simply does not exist until then. One buffer write, whole
  // choreography.
  VFX.prototype.explosion = function (point, radius) {
    if (!this.ready || !this.enabled || !point) return;
    var rng = this.rng;
    var r = (typeof radius === 'number' && radius > 0) ? radius : 4.0;
    var px = point.x, py = point.y, pz = point.z;
    var lod = M.clamp(this._lod(px, py, pz) * this.qp * 1.4, 0.25, 2.0);
    var gy = this._groundY(px, py + 1.0, pz);
    var i, p, sp, a;

    // give the explosion its own particle allowance - it is the set piece
    this._budget = Math.max(this._budget, Math.round(420 * this.qp));

    // ---- 1. detonation core ------------------------------------------------
    // THREE staggered cores, not one. The old single core lived for 0.06 s -
    // it was dead 60 ms after the call and appeared in no capture ever taken,
    // which left the rolling fireball (peak radiance ~2.5, i.e. right on the
    // filmic shoulder) as the brightest thing in the frame. An explosion with
    // nothing past the tonemapper's asymptote is not an explosion; measured,
    // the set piece made the frame DARKER than the same street without it.
    // 40/18/8 over 0.10/0.22/0.40 s keeps something clipping for ~0.4 s.
    //
    // They are also SMALL and WARM. A 5600 K core is (1, 0.86, 0.75) linear:
    // at intensity 40 every channel is far past the shoulder, so a 5 m ball
    // of it tone-maps to flat white and drags the whole fireball's saturation
    // to 0.23 - measured. Small + warm gives a clipped pinhole surrounded by
    // the orange gas, which is what a fireball looks like.
    var CORES = [
      [0.10, 120, 0.34, 0.00, 3400],
      [0.22, 44, 0.60, 0.04, 2700],
      [0.40, 16, 0.95, 0.10, 2200]
    ];
    for (i = 0; i < CORES.length; i++) {
      var C = CORES[i];
      GAME.Color.kelvin(C[4], _c1);
      p = E();
      p.x = px; p.y = py + r * 0.06 * i; p.z = pz;
      p.life = C[0]; p.fadeIn = 0.06; p.fadeOut = 0.30;
      p.size0 = r * 0.10 * (1 + i * 0.5); p.size1 = r * C[2];
      p.frame = PT.CORE;
      p.r = _c1.r; p.g = _c1.g; p.b = _c1.b;
      p.intensity = C[1];
      p.delay = C[3];
      p.rot = rng.range(0, M.TAU);
      p.seed = rng.next();
      this._add(this.layers.fire, p);
    }

    // ---- 2. rolling fireball ------------------------------------------------
    // The burning gas goes on the PREMULTIPLIED layer (one / 1-srcAlpha): each
    // puff both emits light and occludes what is behind it. That occlusion is
    // where 100% of a real fireball's silhouette comes from. Pure additive fire
    // can only ever brighten, so overlapping puffs sum to a flat white disc
    // with no lobes and no soot.
    //
    // 34 billboards over three EXPLICIT scale tiers, not 16 at one random
    // size: big slow lobes carry the silhouette, mid puffs fill the body, and
    // small fast wisps break the rim. p.core is a real geometric quantity (1
    // on the vertical axis, 0 at the horizontal rim) plus a per-tier bias, so
    // the fragment shader's ramp lookup gives the axis incandescent orange and
    // the rim cooling soot. It used to be rng.range(0, 0.35) - i.e. noise.
    var TIERS = [
      [10, 0.90, 1.60, 0.00, 0.55, 1.30, 2.2, 7.0],
      [14, 0.42, 0.90, 0.26, 0.45, 1.05, 3.2, 9.0],
      [10, 0.18, 0.45, 0.55, 0.30, 0.70, 4.5, 11.5]
    ];
    for (var ti = 0; ti < TIERS.length; ti++) {
      var T = TIERS[ti];
      var balls = Math.max(3, Math.round(T[0] * lod));
      for (i = 0; i < balls; i++) {
        rng.onSphere(_v5);
        p = E();
        p.x = px + _v5.x * r * 0.38;
        p.y = py + _v5.y * r * 0.26 + r * 0.10;
        p.z = pz + _v5.z * r * 0.38;
        sp = rng.range(T[6], T[7]);
        p.vx = _v5.x * sp;
        p.vy = Math.abs(_v5.y) * sp * 0.7 + rng.range(0.5, 2.5);
        p.vz = _v5.z * sp;
        p.drag = 3.0; p.gravity = -0.30; p.turb = 0.6;
        p.life = rng.range(T[4], T[5]);
        p.fadeIn = 0.06; p.fadeOut = 0.55;
        p.size0 = r * T[1] * rng.range(0.72, 1.28);
        p.size1 = r * T[2] * rng.range(0.80, 1.25);
        p.rot = rng.range(0, M.TAU); p.rotSpd = rng.gaussian(0, 1.2);
        p.frame = PT.FIRE;
        p.ramp = RAMP.FIRE;
        // The gas, not the core, has to carry the brightness - it is the only
        // element that can be bright AND saturated, because the FIRE ramp head
        // holds blue at 0.22 while red runs at 2.2.
        p.intensity = rng.range(1.6, 2.8);
        p.opacity = rng.range(0.50, 0.78);
        p.delay = rng.range(0, 0.22) * (ti === 0 ? 1.0 : 0.6);
        p.core = M.clamp(T[3] +
          0.55 * (1.0 - M.clamp(Math.sqrt(_v5.x * _v5.x + _v5.z * _v5.z) / 0.70, 0, 1)),
          0, 1);
        p.seed = rng.next();
        this._add(this.layers.fire, p);
      }
    }

    // ---- 2b. residual burn -------------------------------------------------
    // The canonical capture lands 1.6 s after detonation, long after the gas
    // has cooled. Without a slow burn at the base there is nothing left in the
    // frame but grey smoke and the set piece reads as "some dust happened".
    var burn = Math.round(7 * lod);
    for (i = 0; i < burn; i++) {
      rng.onSphere(_v5);
      p = E();
      p.x = px + _v5.x * r * 0.30;
      p.y = gy + 0.25 + rng.range(0, r * 0.30);
      p.z = pz + _v5.z * r * 0.30;
      p.vx = _v5.x * rng.range(0.2, 1.1);
      p.vy = rng.range(0.7, 2.0);
      p.vz = _v5.z * rng.range(0.2, 1.1);
      p.drag = 1.6; p.gravity = -0.25; p.turb = 0.7;
      p.life = rng.range(1.3, 2.6);
      p.fadeIn = 0.10; p.fadeOut = 0.45;
      p.size0 = r * rng.range(0.12, 0.30);
      p.size1 = r * rng.range(0.35, 0.75);
      p.rot = rng.range(0, M.TAU); p.rotSpd = rng.gaussian(0, 0.9);
      p.frame = PT.FIRE;
      p.ramp = RAMP.FIRE;
      p.intensity = rng.range(0.9, 1.7);
      p.opacity = rng.range(0.34, 0.62);
      p.delay = rng.range(0.15, 0.75);
      p.core = rng.range(0.25, 0.62);
      p.seed = rng.next();
      this._add(this.layers.fire, p);
    }

    // The dark shell that rolls out of the fire a beat later - this is what
    // gives the blast volume and stops it reading as a flat glow.
    //
    // It lives on the FIRE layer, not on LIT, and that is a sort-order fix, not
    // an art choice. layers.lit has renderOrder 10 and layers.fire 11, both
    // depthWrite:false: every soot card drew FIRST and was then composited over
    // by every gas card regardless of which was actually nearer the camera, so
    // three overlapping premultiplied fire cards at a = 0.6 erased 94% of the
    // shell behind them and the fireball had no dark cap and no dark lobe
    // edges. On the FIRE ramp with core = 0 the card starts warm (it IS glowing
    // when it leaves the fireball), reaches the ramp's near-black tail
    // (0.048, 0.043, 0.040) inside a second, and premultiplied blending makes
    // it occlude correctly in the same stream as the gas.
    var shell = Math.round(12 * lod);
    for (i = 0; i < shell; i++) {
      rng.onSphere(_v5);
      p = E();
      p.x = px + _v5.x * r * 0.34;
      p.y = py + Math.abs(_v5.y) * r * 0.30 + r * 0.12;
      p.z = pz + _v5.z * r * 0.34;
      sp = rng.range(1.8, 6.0);
      p.vx = _v5.x * sp; p.vy = Math.abs(_v5.y) * sp * 0.8 + rng.range(0.6, 2.2); p.vz = _v5.z * sp;
      p.drag = 2.2; p.gravity = -0.22; p.turb = 0.8;
      p.life = rng.range(2.2, 4.0);
      p.fadeIn = 0.10; p.fadeOut = 0.48;
      p.size0 = r * rng.range(0.35, 0.60);
      p.size1 = r * rng.range(1.2, 2.1);
      p.rot = rng.range(0, M.TAU); p.rotSpd = rng.gaussian(0, 0.8);
      p.frame = PT.SMOKE_A + (rng.next() * 3 | 0);
      p.opacity = rng.range(0.50, 0.80);
      p.r = 1.0; p.g = 1.0; p.b = 1.0;
      p.ramp = RAMP.FIRE;
      // core = 0 drives tc = life * 1.55, i.e. straight down the ramp into the
      // soot tail. Low intensity so it never competes with the gas.
      p.core = 0;
      p.intensity = rng.range(0.42, 0.62);
      p.delay = rng.range(0.10, 0.30);
      p.seed = rng.next();
      this._add(this.layers.fire, p);
    }

    // ---- 3. dark smoke column, staggered so it builds over ~1.2 s ----------
    var col = Math.round(16 * lod);
    for (i = 0; i < col; i++) {
      var f = i / Math.max(col - 1, 1);
      var offX = rng.gaussian(0, r * 0.28), offZ = rng.gaussian(0, r * 0.28);
      p = E();
      p.x = px + offX;
      p.y = py + rng.range(0, r * 0.35);
      p.z = pz + offZ;
      // depth into the plume: 1 on the axis, 0 at the rim. The LIT branch uses
      // it to drive the core near-black while the rim keeps the sun, which is
      // the only reason a smoke column is legible as a volume at all.
      p.core = 1.0 - M.clamp(Math.sqrt(offX * offX + offZ * offZ) / (r * 0.45), 0, 1);
      p.vx = rng.gaussian(0, 0.7);
      p.vy = rng.range(1.4, 3.4) * (1.0 - f * 0.35);
      p.vz = rng.gaussian(0, 0.7);
      p.drag = 0.38; p.gravity = -0.11; p.turb = 1.0;
      p.life = rng.range(3.4, 6.2);
      p.fadeIn = 0.09; p.fadeOut = 0.42;
      p.size0 = r * rng.range(0.45, 0.75);
      p.size1 = r * rng.range(1.8, 3.0);
      p.rot = rng.range(0, M.TAU); p.rotSpd = rng.gaussian(0, 0.35);
      p.frame = PT.SMOKE_A + (rng.next() * 3 | 0);
      p.opacity = rng.range(0.38, 0.60);
      p.r = 0.088; p.g = 0.080; p.b = 0.072;
      // the column has to be standing by the canonical capture, not still
      // being born: 0.75 s of stagger, not 1.15 s
      p.delay = f * 0.75 + rng.range(0, 0.10);
      p.seed = rng.next();
      this._add(this.layers.lit, p);
    }

    // ---- 3b. the STANDING column -------------------------------------------
    // Real ordnance leaves a legible column for 15-30 s. The tier above runs
    // 3.4-6.2 s at size1 up to r*3 with drag 0.38, so it inflates into enormous
    // near-transparent cards and dissipates: 3.6 s after detonation the frame
    // was visually indistinguishable from the same street with nothing in it.
    // A SMALLER card that survives beats a huge one that fades - so these are
    // r*1.4, not r*3, they barely drag, and they live four times as long.
    var tall = Math.round(10 * lod);
    for (i = 0; i < tall; i++) {
      var tf = i / Math.max(tall - 1, 1);
      var tox = rng.gaussian(0, r * 0.22), toz = rng.gaussian(0, r * 0.22);
      p = E();
      p.x = px + tox;
      p.y = py + rng.range(0, r * 0.30);
      p.z = pz + toz;
      p.core = 1.0 - M.clamp(Math.sqrt(tox * tox + toz * toz) / (r * 0.40), 0, 1);
      p.vx = rng.gaussian(0, 0.28);
      p.vy = rng.range(0.35, 0.90);
      p.vz = rng.gaussian(0, 0.28);
      p.drag = 0.12; p.gravity = -0.04; p.turb = 0.55;
      p.life = rng.range(14, 24);
      p.fadeIn = 0.06; p.fadeOut = 0.62;
      p.size0 = r * rng.range(0.40, 0.62);
      p.size1 = r * rng.range(1.05, 1.45);
      p.rot = rng.range(0, M.TAU); p.rotSpd = rng.gaussian(0, 0.16);
      p.frame = PT.SMOKE_A + (rng.next() * 3 | 0);
      p.opacity = rng.range(0.16, 0.26);
      p.r = 0.100; p.g = 0.092; p.b = 0.085;
      p.delay = tf * 2.0 + rng.range(0, 0.25);
      p.seed = rng.next();
      this._add(this.layers.lit, p);
    }

    // settling dust that hangs around the crater long after the column has
    // drifted off - this is what makes the site read as "a bomb went off here"
    // when the player walks past it a quarter of a minute later
    var settle = Math.round(6 * lod);
    for (i = 0; i < settle; i++) {
      var sa2 = rng.range(0, M.TAU), sr2 = rng.range(0, r * 0.55);
      p = E();
      p.x = px + Math.cos(sa2) * sr2;
      p.y = gy + 0.40 + rng.range(0, r * 0.12);
      p.z = pz + Math.sin(sa2) * sr2;
      p.vx = rng.gaussian(0, 0.16);
      p.vy = rng.range(0.05, 0.20);
      p.vz = rng.gaussian(0, 0.16);
      p.drag = 0.20; p.gravity = 0.02; p.turb = 0.35;
      p.life = rng.range(10, 16);
      p.fadeIn = 0.08; p.fadeOut = 0.55;
      p.size0 = r * rng.range(0.30, 0.50);
      p.size1 = r * rng.range(0.85, 1.15);
      p.rot = rng.range(0, M.TAU); p.rotSpd = rng.gaussian(0, 0.12);
      p.frame = PT.DUST;
      p.opacity = rng.range(0.10, 0.18);
      p.r = 0.34; p.g = 0.30; p.b = 0.24;
      p.delay = 0.5 + rng.range(0, 1.2);
      p.seed = rng.next();
      this._add(this.layers.lit, p);
    }

    // ---- 4. ground dust ring -----------------------------------------------
    var ring = Math.round(24 * lod);
    for (i = 0; i < ring; i++) {
      a = (i / ring) * M.TAU + rng.range(-0.12, 0.12);
      var cx = Math.cos(a), cz = Math.sin(a);
      p = E();
      p.x = px + cx * r * 0.25;
      p.y = gy + 0.12 + rng.range(0, 0.25);
      p.z = pz + cz * r * 0.25;
      sp = rng.range(6.5, 12.5);
      p.vx = cx * sp; p.vy = rng.range(0.4, 1.6); p.vz = cz * sp;
      p.drag = 2.6; p.gravity = 0.05; p.turb = 0.55;
      p.life = rng.range(1.8, 3.6);
      p.fadeIn = 0.06; p.fadeOut = 0.45;
      p.size0 = r * rng.range(0.20, 0.34);
      p.size1 = r * rng.range(0.85, 1.45);
      p.rot = rng.range(0, M.TAU); p.rotSpd = rng.gaussian(0, 0.9);
      p.frame = PT.DUST;
      // The ring is the PALEST element in the whole effect and it is 24 cards
      // of it; at 0.62 opacity and r*1.9 it integrates into the flat white
      // wall that swallowed the fireball's silhouette.
      p.opacity = rng.range(0.24, 0.44);
      p.r = 0.62; p.g = 0.54; p.b = 0.40;
      p.seed = rng.next();
      this._add(this.layers.lit, p);
    }

    // ---- 5. shockwave ripple, flat on the ground --------------------------
    for (i = 0; i < 2; i++) {
      p = E();
      p.x = px; p.y = gy + 0.06 + i * 0.03; p.z = pz;
      p.life = 0.42 + i * 0.18;
      p.fadeIn = 0.04; p.fadeOut = 0.12;
      p.size0 = r * (0.35 + i * 0.4); p.size1 = r * (3.2 + i * 1.6);
      p.frame = PT.RING;
      p.ground = 1;
      p.rot = rng.range(0, M.TAU);
      p.r = 1.0; p.g = 0.92; p.b = 0.80;
      p.intensity = i === 0 ? 2.6 : 0.9;
      p.seed = rng.next();
      this._add(this.layers.add, p);
    }
    // a vertical expanding shell for the pressure front seen from the side
    p = E();
    p.x = px; p.y = py; p.z = pz;
    p.life = 0.26; p.fadeIn = 0.05; p.fadeOut = 0.1;
    p.size0 = r * 0.4; p.size1 = r * 2.8;
    p.frame = PT.RING;
    p.r = 1.0; p.g = 0.95; p.b = 0.88;
    p.intensity = 1.6;
    p.rot = rng.range(0, M.TAU);
    p.seed = rng.next();
    this._add(this.layers.add, p);

    // ---- 6. embers ---------------------------------------------------------
    var embers = Math.round(42 * lod);
    for (i = 0; i < embers; i++) {
      rng.onSphere(_v5);
      if (_v5.y < 0) _v5.y *= -0.45;
      p = E();
      p.x = px; p.y = py + r * 0.1; p.z = pz;
      sp = rng.range(6.0, 24.0);
      p.vx = _v5.x * sp; p.vy = _v5.y * sp + rng.range(1, 5); p.vz = _v5.z * sp;
      p.drag = rng.range(0.9, 2.0);
      p.gravity = 1.0;
      p.life = rng.range(0.7, 2.0);
      p.fadeIn = 0.03; p.fadeOut = 0.45;
      p.size0 = rng.range(0.014, 0.034); p.size1 = rng.range(0.004, 0.010);
      p.frame = rng.bool(0.7) ? PT.STREAK : PT.EMBER;
      p.ramp = RAMP.EMBER;
      p.intensity = rng.range(4.0, 9.0);
      p.stretch = 0.026;
      p.seed = rng.next();
      this._add(this.layers.add, p);
    }

    // ---- 7. launched debris -------------------------------------------------
    this._spawnDebris(px, py + 0.15, pz, Math.round(26 * lod), null, 11.0, 1.6,
      0.03, 0.11, [0.42, 0.39, 0.34], 5.0);

    // ---- 8. light + camera impulse + audio ---------------------------------
    // TWO envelopes, not one all-or-nothing whiteout.
    //
    // The old single flash was 2925 cd with decay 2 over a 49.5 m distance
    // window: irradiance at the 5-10 m facades came out at 30-120 against a
    // sun of 4.5, so at peak 16% of the frame crushed past 0.90 luminance with
    // no readable falloff and no silhouettes - and the shadow-casting blastSpot
    // that exists specifically to buy those silhouettes was swamped by the
    // unshadowed point light sitting on top of it. Short and local here; the
    // SHAPING now comes from the spot below, which is the light that can
    // actually throw a shadow.
    GAME.Color.kelvin(3400, _c1);
    if (this.lights) {
      _v4.set(px, py + r * 0.2, pz);
      this.lights.flash(_v4, _c1, 700 * M.clamp(r / 4, 0.5, 2.2), 0.20, 11.0,
        Math.max(12, r * 4.2), 5);
    }

    // A crater that keeps burning. The residual gas and the layers.fire cards
    // render bright orange for ~3 s while the ONLY light the blast ever emitted
    // was a 0.55 s flash - measured, the foreground of the hero capture at
    // t = 2.5 was lit identically to the frame with no explosion in it. This
    // emitter gives the burn a real source: the permanent fireLight parks on
    // the hottest emitter, and heat 1.15 beats the ambient wreck's 1.0.
    try {
      this.addSmokeEmitter(_v4.set(px, gy + 0.35, pz), {
        rate: 9, radius: r * 0.28, rise: 1.6,
        size0: r * 0.35, size1: r * 2.4, life: 9,
        opacity: 0.40, tint: [0.14, 0.125, 0.11],
        embers: 0.9, heat: 1.15,
        expireAt: this.time + 13.0
      });
      // keep the emitter list from growing without bound across a long session
      if (this.emitters.length > 10) {
        for (var ei = 0; ei < this.emitters.length; ei++) {
          if (!this.emitters[ei].enabled) { this.emitters.splice(ei, 1); break; }
        }
      }
    } catch (e) { /* emitters are optional */ }
    // and the one shadow caster we keep in reserve, aimed from the blast at
    // the camera so everything between them is silhouetted and everything
    // behind them throws a shadow straight away from the fire
    if (this.blastSpot) {
      try {
        var bs = this.blastSpot;
        bs.position.set(px, py + r * 0.22, pz);
        if (this.ctx.camera) {
          bs.target.position.copy(this.ctx.camera.position);
          bs.target.position.y -= 0.4;
        } else {
          bs.target.position.set(px, py - 1.0, pz);
        }
        bs.color.copy(_c1);
        bs.distance = Math.max(26, r * 10);
        bs.angle = 1.15;
        bs.shadow.camera.far = bs.distance + 4;
        bs.shadow.camera.updateProjectionMatrix();
        // The light that CASTS SHADOWS has to dominate the light that does not,
        // or the detonation reads as a global exposure change rather than as a
        // fire in the street. Peak up 2.6x and held 45% longer, against a point
        // light that is now a quarter of what it was.
        this._blastPeak = 1100 * M.clamp(r / 4, 0.5, 2.0);
        this._blastDur = 0.80;
        this._blastT = 0;
        bs.intensity = this._blastPeak;
        bs.shadow.needsUpdate = true;
      } catch (e) { /* shadow caster is optional */ }
    }
    if (this.ctx.postfx && this.ctx.postfx.addImpulse) {
      try { this.ctx.postfx.addImpulse('explosion', M.clamp(r / 4.5, 0.35, 1.6)); }
      catch (e) { /* postfx optional */ }
    }
    this._sound('explosion', point, 1.0, 0.9 + rng.range(-0.1, 0.15));

    // ---- 9. scorch + spall on the ground ------------------------------------
    if (this.decals) {
      _c1.setRGB(1, 1, 1);
      _v4.set(px, gy, pz);
      _v5.set(0, 1, 0);
      this.decals.add(_v4, _v5, DC.SCORCH_BIG, r * 1.7, r * 1.7,
        rng.range(0, M.TAU), 1.0, 1.0, _c1, DECAL_KINDS.scorch_big.ttl, this.time, 0.02);
      var marks = Math.round(6 * M.clamp(lod, 0.3, 1.2));
      for (i = 0; i < marks; i++) {
        a = rng.range(0, M.TAU);
        var dd = r * rng.range(0.5, 1.4);
        _v4.set(px + Math.cos(a) * dd, gy, pz + Math.sin(a) * dd);
        _v5.set(0, 1, 0);
        this.decals.add(_v4, _v5, rng.bool() ? DC.SCORCH : DC.POCK,
          r * rng.range(0.2, 0.5), r * rng.range(0.2, 0.5),
          rng.range(0, M.TAU), rng.range(0.4, 0.85), 1.0, _c1,
          DECAL_KINDS.scorch.ttl, this.time, 0.016);
      }
    }
  };

  // -- extra helpers other systems may find useful ---------------------------
  VFX.prototype.smokePuff = function (point, size, opacity, life) {
    if (!this.ready || !point) return;
    var rng = this.rng;
    var p = E();
    p.x = point.x; p.y = point.y; p.z = point.z;
    p.vy = 0.3; p.gravity = -0.05; p.drag = 0.8; p.turb = 0.7;
    p.life = life || 2.0;
    p.fadeIn = 0.15; p.fadeOut = 0.35;
    p.size0 = (size || 0.4) * 0.4; p.size1 = (size || 0.4) * 2.0;
    p.frame = PT.SMOKE_A + (rng.next() * 3 | 0);
    p.opacity = opacity === undefined ? 0.25 : opacity;
    p.r = 0.5; p.g = 0.48; p.b = 0.45;
    p.rot = rng.range(0, M.TAU);
    p.seed = rng.next();
    this._add(this.layers.lit, p);
  };

  VFX.prototype.sparkBurst = function (point, dir, count, speed) {
    if (!this.ready || !point) return;
    var rng = this.rng;
    var d = _v1.set(0, 1, 0);
    if (dir && dir.isVector3 && dir.lengthSq() > 1e-8) d.copy(dir).normalize();
    var n = Math.round((count || 12) * this.qp);
    for (var i = 0; i < n; i++) {
      rng.inCone(d, 0.9, _v2);
      var p = E();
      p.x = point.x; p.y = point.y; p.z = point.z;
      var sp = (speed || 8) * rng.range(0.4, 1.4);
      p.vx = _v2.x * sp; p.vy = _v2.y * sp; p.vz = _v2.z * sp;
      p.drag = 2.2; p.gravity = 1.0;
      p.life = rng.range(0.2, 0.8);
      p.fadeIn = 0.05; p.fadeOut = 0.4;
      p.size0 = rng.range(0.008, 0.018); p.size1 = 0.003;
      p.frame = PT.STREAK; p.ramp = RAMP.EMBER;
      p.intensity = 6; p.stretch = 0.03;
      p.seed = rng.next();
      this._add(this.layers.add, p);
    }
  };

  VFX.prototype.clear = function () {
    if (!this.ready) return;
    this.layers.add.clear();
    this.layers.lit.clear();
    this.layers.fire.clear();
    if (this.layers.view) this.layers.view.clear();
    this.tracers.clear();
    this.decals.clear();
    this.debris.clear();
    this.shells.clear();
    if (this.lights) this.lights.clear();
    if (this.viewLights) this.viewLights.clear();
  };

  VFX.prototype.dispose = function () {
    try {
      if (this.layers) {
        this.layers.add.dispose();
        this.layers.lit.dispose();
        if (this.layers.fire) this.layers.fire.dispose();
        if (this.layers.view) this.layers.view.dispose();
      }
      if (this.tracers) this.tracers.dispose();
      if (this.dust) this.dust.dispose();
      if (this.decals) this.decals.dispose();
      if (this.debris) this.debris.dispose();
      if (this.shells) this.shells.dispose();
      if (this.litter) this.litter.dispose();
      if (this.depth) this.depth.dispose();
      if (this.particleAtlas) this.particleAtlas.dispose();
      if (this.decalAtlas) {
        this.decalAtlas.map.dispose();
        this.decalAtlas.normalMap.dispose();
        this.decalAtlas.ormMap.dispose();
      }
      if (this.litterTex) this.litterTex.dispose();
      if (this.shellTex) this.shellTex.dispose();
      if (this.root.parent) this.root.parent.remove(this.root);
      if (this.viewRoot.parent) this.viewRoot.parent.remove(this.viewRoot);
    } catch (e) { GAME.logError('vfx.dispose', e); }
    this.ready = false;
  };

  GAME.VFX = VFX;

})(window.GAME, window.THREE);
