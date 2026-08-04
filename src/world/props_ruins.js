// ============================================================================
// OPERATION BLACKOUT - src/world/props_ruins.js  ->  GAME.PropsRuins
//
// SET DRESSING FOR "BAYON RUINS".
//
// level_ruins.js builds the ARCHITECTURE - causeway, gate, gallery ring,
// terrace, towers, trees, mist, water. It photographs as a very good model of
// a temple. This file is what makes it a PLACE somebody has been praying at,
// stealing from and digging up.
//
// ---------------------------------------------------------------------------
// THE FOUR STORIES, and the anchor each one hangs off
// ---------------------------------------------------------------------------
//  1. IT IS STILL A TEMPLE. A saffron-wrapped Buddha on a plinth at the east
//     colonnade with candles, incense and a marigold garland (anchors.gallery
//     + anchors.pools.court_ne, so it reflects); an offering post at the head
//     of the causeway; cloth tied round the sanctuary towers. This is also the
//     level's ONLY saturated colour - everything else is grey-gold, moss and
//     rose sky - so one bolt of saffron carries the whole frame.
//  2. THE JUNGLE IS TAKING IT BACK. Fern, grass, creeper, elephant-ear,
//     hanging vine, sapling, lotus. NOT scattered: growth follows water, shade
//     and joints. Fern at wall feet and pillar bases where run-off collects;
//     grass in flagstone joints and NEVER on the worn path level_ruins already
//     published down the axis; creeper on the shaded faces; saplings rooted in
//     wall caps and collapse rubble; lily and lotus on anchors.pools. Inside
//     the sealed south gallery the only place anything grows at all is
//     directly under the two roof holes published in level.lightShafts,
//     because that is the only place light and rain get in.
//  3. SOMEBODY IS LOOTING IT. anchors.camp gets a bedroll, rice sacks, a cook
//     pot over the level's brazier, a hammock, and crates of carved fragments
//     packed in straw and roped shut.
//  4. SOMEBODY IS TRYING TO SAVE IT. An anastylosis yard beside the collapsed
//     east library - rows of numbered blocks on timber sleepers, a bamboo
//     shear-leg gantry with a block slung in a strop, tarped stacks - and
//     anchors.dig gets its string grid, sieve, spoil heap, finds trays and a
//     plank walkway.
//
// ---------------------------------------------------------------------------
// RULES THIS FILE HOLDS ITSELF TO
// ---------------------------------------------------------------------------
// * EVERYTHING PLACES AGAINST level.anchors, never against a camera pose. The
//   anchors are published by LevelRuins' CONSTRUCTOR, so they exist before
//   either build() runs and a pose can move without moving a fern.
// * NOTHING FLOATS AND NOTHING SITS LEVEL ON A SLOPE. _place() measures the
//   ground gradient across the prop's OWN footprint radius and tilts onto it.
//   The courtyard dishes toward its standing water by ~30 cm over 10 m; a jar
//   dropped level there floats its downhill rim by 4 cm, which is exactly the
//   tell that reads as "asset dropped in an editor".
// * NO INSTANCED BATCH CAN OVERFLOW. Placements are COLLECTED first and each
//   InstancedMesh is allocated at exactly the collected length in _commit().
//   A cap that silently drops everything past N is invisible until you count,
//   so this file removes the cap rather than guessing one.
// * WEAR IS THE MATERIAL CONTRACT, not a tint. Every stone prop is painted
//   into materials.js's wear channels - R grime, G wetness, B edge wear - by
//   the same rules level_ruins.js paints its masonry with, so a fallen block
//   and the wall it fell off weather identically.
// * < 80 DRAW CALLS for all props: repeats are InstancedMesh, one-offs merge
//   into one static batch per material.
// * EVERY ctx ACCESS IS GUARDED. ctx.level, ctx.materials, ctx.weather and
//   ctx.lighting may each be missing; this file degrades, it never throws out
//   of build() or update().
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  if (!GAME || !THREE) return;

  var M = GAME.Math;
  var Geo = GAME.Geo;

  var UP = new THREE.Vector3(0, 1, 0);
  var WHITE = new THREE.Color(1, 1, 1);

  // --------------------------------------------------------------------------
  // Scratch. Placement runs a few thousand times at build; a Matrix4 per call
  // is a measurable slice of the boot budget.
  // --------------------------------------------------------------------------
  var _m4 = new THREE.Matrix4();
  var _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
  var _eu = new THREE.Euler();
  var _vp = new THREE.Vector3(), _vs = new THREE.Vector3(), _vn = new THREE.Vector3();
  var _bmin = new THREE.Vector3(), _bmax = new THREE.Vector3();
  var _pv = new THREE.Vector3(), _pinv = new THREE.Matrix4();
  var _tc = new THREE.Color();
  var _query = [];

  // --------------------------------------------------------------------------
  // Transform helpers
  // --------------------------------------------------------------------------
  function T(px, py, pz, rx, ry, rz, sx, sy, sz) {
    _eu.set(rx || 0, ry || 0, rz || 0, 'YXZ');
    _qa.setFromEuler(_eu);
    _vp.set(px || 0, py || 0, pz || 0);
    if (sx === undefined) _vs.set(1, 1, 1);
    else if (sy === undefined) _vs.set(sx, sx, sx);
    else _vs.set(sx, sy, sz === undefined ? sy : sz);
    return _m4.compose(_vp, _qa, _vs);
  }
  function Tn(px, py, pz, rx, ry, rz, sx, sy, sz) {
    return T(px, py, pz, rx, ry, rz, sx, sy, sz).clone();
  }

  // --------------------------------------------------------------------------
  // Geometry atoms, cached by dimension. The yard alone lays 34 dressed blocks
  // and the growth pass places thousands of cards; re-tessellating the same
  // box 34 times is pure boot cost.
  // --------------------------------------------------------------------------
  var _boxCache = new Map(), _cylCache = new Map(), _sphCache = new Map();

  function box(w, h, d, bevel) {
    w = Math.max(0.004, w); h = Math.max(0.004, h); d = Math.max(0.004, d);
    if (bevel === undefined) bevel = Math.min(0.014, Math.min(w, Math.min(h, d)) * 0.22);
    var k = w.toFixed(3) + ',' + h.toFixed(3) + ',' + d.toFixed(3) + ',' + bevel.toFixed(3);
    var g = _boxCache.get(k);
    if (!g) { g = Geo.bevelBox(w, h, d, bevel); _boxCache.set(k, g); }
    return g;
  }
  function cyl(rt, rb, h, radial, open) {
    radial = radial || 8;
    var k = rt.toFixed(4) + ',' + rb.toFixed(4) + ',' + h.toFixed(3) + ',' + radial + (open ? 'o' : 'c');
    var g = _cylCache.get(k);
    if (!g) { g = new THREE.CylinderGeometry(rt, rb, h, radial, 1, !!open); _cylCache.set(k, g); }
    return g;
  }
  function sph(r, w, h) {
    w = w || 8; h = h || 6;
    var k = r.toFixed(4) + ',' + w + ',' + h;
    var g = _sphCache.get(k);
    if (!g) { g = new THREE.SphereGeometry(r, w, h); _sphCache.set(k, g); }
    return g;
  }
  // Surface of revolution from a [[r,y],...] profile: jars, bowls, lotus
  // bases, finials, cook pots, lamp founts.
  function lathe(profile, radial) {
    var pts = [];
    for (var i = 0; i < profile.length; i++) {
      pts.push(new THREE.Vector2(Math.max(0.0008, profile[i][0]), profile[i][1]));
    }
    return new THREE.LatheGeometry(pts, radial || 10);
  }

  // A quad whose pivot is at the BOTTOM centre, carrying an explicit atlas
  // rect. Bottom pivot is what lets a plant be scaled and tilted without
  // sinking into or lifting off the ground.
  function card(w, h, uv, bend, down) {
    var hw = w * 0.5;
    var b = bend || 0;
    var ty = down ? -h : h;
    var pos = new Float32Array([
      -hw, 0, 0, hw, 0, 0, hw, ty, -b,
      -hw, 0, 0, hw, ty, -b, -hw, ty, -b]);
    var nor = new Float32Array(18);
    for (var i = 0; i < 6; i++) nor[i * 3 + 2] = 1;
    var u0 = uv ? uv[0] : 0, v0 = uv ? uv[1] : 0, u1 = uv ? uv[2] : 1, v1 = uv ? uv[3] : 1;
    var uva = new Float32Array([u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1]);
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uva, 2));
    return g;
  }

  // Horizontal card, normal +Y, centred. Lily pads and litter lie DOWN.
  function flatCard(w, d, uv) {
    var hw = w * 0.5, hd = d * 0.5;
    var pos = new Float32Array([
      -hw, 0, -hd, hw, 0, -hd, hw, 0, hd,
      -hw, 0, -hd, hw, 0, hd, -hw, 0, hd]);
    var nor = new Float32Array(18);
    for (var i = 0; i < 6; i++) nor[i * 3 + 1] = 1;
    var u0 = uv ? uv[0] : 0, v0 = uv ? uv[1] : 0, u1 = uv ? uv[2] : 1, v1 = uv ? uv[3] : 1;
    var uva = new Float32Array([u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1]);
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uva, 2));
    return g;
  }

  // Displace every vertex by fbm. A stone spalled off a 900-year-old cornice
  // is not a bevelled box, and the whole difference is silhouette.
  function roughen(geo, noise, amount, freq) {
    var p = geo.attributes.position;
    if (!p) return geo;
    freq = freq || 3;
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      var a = noise.fbm3(x * freq, y * freq, z * freq, 3, 2.1, 0.55);
      var b = noise.fbm3(x * freq + 19.3, y * freq - 7.1, z * freq + 3.7, 3, 2.1, 0.55);
      var c = noise.fbm3(x * freq - 5.5, y * freq + 13.9, z * freq - 11.2, 3, 2.1, 0.55);
      p.setXYZ(i, x + a * amount, y + b * amount, z + c * amount);
    }
    p.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
  }

  function vertCount(g) { return g.index ? g.index.count : g.attributes.position.count; }

  // ==========================================================================
  // SURFACES
  //
  // Solved against level_ruins.js's own SURF table rather than invented: a
  // fallen block must be the same rock as the wall it fell off, and the only
  // way to guarantee that is to ask materials.js for the same recipe with the
  // same albedoTarget. `alb` is an albedoTarget (the library solves a
  // per-channel gain so the surface MEAN lands there and the map's own
  // variation survives); `uv` is world metres -> uv for the planar recipes.
  // ==========================================================================
  var SURF = {
    stone:    { base: 'stone', alb: 0x8f8067, hue: 0.55, uv: 0.42, cast: 1, recv: 1 },
    stone_d:  { base: 'stone', alb: 0x6a6050, hue: 0.55, uv: 0.42, cast: 1, recv: 1 },
    // The deepest cuts of a carving - eye sockets, the line of the lips, the
    // channel under a brow. Almost nothing here is lit by the 1.05 twilight
    // key; it is lit by SKY, and flat ambient does not carve. These are dark
    // by ALBEDO so a face keeps its expression in any light.
    carve:    { base: 'stone', alb: 0x393227, hue: 0.55, uv: 0.42, cast: 1, recv: 1 },
    // Matched to level_ruins.js's SURF.mossy, and for the same reason: this
    // level's illuminant is ~3:1 red-to-green, so an honest moss albedo
    // (linear G/R 1.21) renders brown. 0x3c7a2c measures 4.31 and survives.
    mossy:    { base: 'stone', alb: 0x2a5417, hue: 0.98, uv: 0.42, cast: 1, recv: 1 },
    laterite: { base: 'rubble', alb: 0x7d5f49, hue: 0.75, uv: 0.36, cast: 1, recv: 1 },
    earth:    { base: 'dirt', alb: 0x6a5f47, hue: 0.55, uv: 0.30, cast: 0, recv: 1, mult: 1 },
    timber:   { base: 'wood_plank', alb: 0x5b4835, uv: 0.85, cast: 1, recv: 1 },
    // Unsawn wood - firewood, a splitting log, a tent pole cut on site. Greyer
    // and rougher than the dressed timber so a billet never reads as a plank.
    bark:     { base: 'wood_plank', alb: 0x6e6553, hue: 0.70, uv: 0.62, cast: 1, recv: 1 },
    // Split bamboo is pale straw-green and it is the only warm-BRIGHT
    // structural material in the level, which is why the gantry reads at all
    // against thirty metres of grey stone behind it.
    bamboo:   { base: 'wood_plank', alb: 0x9c9257, hue: 0.55, uv: 1.10, cast: 1, recv: 1 },
    canvas:   { base: 'canvas_awning', alb: 0x6f6553, hue: 0.45, uv: 0.70, cast: 1, recv: 1 },
    // THE ONE SATURATED MARK IN THE LEVEL. Monastic saffron against wet grey
    // sandstone at first light is the image this place is famous for, and in a
    // frame graded to a narrow rose-gold it is the only hue present that is
    // not stone, moss or sky.
    // 0xa2601a, NOT the 0xc9791f round two shipped. That target was chosen to
    // beat the fact that every saffron surface here faces south or east and is
    // therefore lit by skylight alone - and it overshot catastrophically: on
    // the Buddha in hero2 at 3 m the shoulder roll measured p50 0.648 / p95
    // 0.763 against a frame 99th percentile of 0.601 and a statue torso of
    // 0.319. It was not a bolt of cloth, it was the single brightest object in
    // the picture, a hard-edged near-white parallelogram with a one-pixel
    // shadow terminator, and it read as a rendering artefact. Dropping the
    // target 1.7 stops in red puts the cloth INSIDE the print - still the only
    // saturated hue in a grey-gold level, no longer competing with the sky.
    saffron:  { base: 'fabric', alb: 0xa2601a, hue: 0.95, uv: 0.80, cast: 1, recv: 1 },
    cloth:    { base: 'fabric', alb: 0x6d6a5c, hue: 0.30, uv: 0.80, cast: 1, recv: 1 },
    sack:     { base: 'fabric', alb: 0x8a7a56, hue: 0.35, uv: 0.75, cast: 1, recv: 1 },
    rope:     { base: 'rope', alb: 0x6f6350, uv: 1.60, cast: 1, recv: 1 },
    metal:    { base: 'rusted_metal', alb: null, metal: 0.52, rough: 0.86, uv: 0.90, cast: 1, recv: 1 },
    brass:    { base: 'painted_metal', alb: 0x6b5227, metal: 0.55, rough: 0.50, uv: 0.90, cast: 1, recv: 1 }
  };

  var FALLBACK = {
    stone:    [0x8f8067, 0.88, 0.0],
    stone_d:  [0x6a6050, 0.90, 0.0],
    carve:    [0x393227, 0.94, 0.0],
    mossy:    [0x2a5417, 0.93, 0.0],
    laterite: [0x7d5f49, 0.94, 0.0],
    earth:    [0x6a5f47, 0.96, 0.0],
    timber:   [0x5b4835, 0.90, 0.0],
    bark:     [0x6e6553, 0.94, 0.0],
    bamboo:   [0x9c9257, 0.80, 0.0],
    canvas:   [0x6f6553, 0.94, 0.0],
    saffron:  [0xa2601a, 0.88, 0.0],
    cloth:    [0x6d6a5c, 0.92, 0.0],
    sack:     [0x8a7a56, 0.94, 0.0],
    rope:     [0x6f6350, 0.94, 0.0],
    metal:    [0x6a5044, 0.86, 0.52],
    brass:    [0x6b5227, 0.50, 0.55]
  };

  // ==========================================================================
  // TEXTURE KIT
  //
  // Two atlases, both authored here because neither exists in textures.js and
  // it is not this file's library to extend: the UNDERSTORY atlas (every
  // growing thing that is not the level's own canopy card) and the MARKS
  // atlas (soot, bird lime, damp rings, and the chalked inventory numbers on
  // the anastylosis blocks, in an invented script).
  // ==========================================================================
  function ctx2d(w, h) {
    if (typeof document === 'undefined') return null;
    var c = document.createElement('canvas');
    c.width = w; c.height = h || w;
    return c.getContext('2d');
  }

  function makeTex(canvas, srgb, aniso, repeat) {
    if (!canvas) return null;
    var t = new THREE.CanvasTexture(canvas);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    t.anisotropy = aniso || 1;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  }

  var AN = 4;                                   // understory atlas is 4 x 4
  function cellUV(i, pad) {
    pad = pad === undefined ? 0.004 : pad;
    var c = i % AN, r = (i / AN) | 0, s = 1 / AN;
    return [c * s + pad, 1 - (r + 1) * s + pad, (c + 1) * s - pad, 1 - r * s - pad];
  }

  // ---- leaf primitives ------------------------------------------------------
  function leafShape(g, x, y, len, wid, ang, fill, vein) {
    g.save();
    g.translate(x, y); g.rotate(ang);
    g.fillStyle = fill;
    g.beginPath();
    // a real leaf is not an ellipse - it has a shoulder and a drawn-out tip
    g.moveTo(0, 0);
    g.bezierCurveTo(wid, len * 0.18, wid * 0.82, len * 0.72, 0, len);
    g.bezierCurveTo(-wid * 0.82, len * 0.72, -wid, len * 0.18, 0, 0);
    g.closePath();
    g.fill();
    if (vein) {
      g.strokeStyle = vein;
      g.lineWidth = Math.max(0.7, wid * 0.12);
      g.beginPath(); g.moveTo(0, 0); g.lineTo(0, len * 0.94); g.stroke();
    }
    g.restore();
  }

  function frond(g, rng, x, y, len, ang, wid, dark, light) {
    g.save(); g.translate(x, y); g.rotate(ang);
    var bend = rng.range(-0.5, 0.5);
    g.strokeStyle = dark; g.lineWidth = Math.max(1.1, wid * 0.16);
    g.beginPath(); g.moveTo(0, 0);
    g.quadraticCurveTo(bend * len * 0.25, len * 0.55, bend * len * 0.75, len);
    g.stroke();
    var n = 12;
    for (var i = 1; i <= n; i++) {
      var t = i / n;
      var px = bend * len * 0.75 * t * t;
      var py = len * t;
      var pl = wid * (1 - t * 0.70) * rng.range(0.85, 1.15);
      for (var s = -1; s <= 1; s += 2) {
        leafShape(g, px, py, pl, pl * 0.30, s * (1.05 - t * 0.42) + bend * 0.4,
          rng.bool(0.5) ? dark : light, null);
      }
    }
    g.restore();
  }

  function blade(g, x, y, len, lean, wid, fill) {
    g.save(); g.translate(x, y);
    g.fillStyle = fill;
    g.beginPath();
    g.moveTo(-wid * 0.5, 0);
    g.quadraticCurveTo(lean * len * 0.35, len * 0.6, lean * len + wid * 0.10, len);
    g.quadraticCurveTo(lean * len * 0.35 + wid * 0.55, len * 0.6, wid * 0.5, 0);
    g.closePath(); g.fill();
    g.restore();
  }

  // Every UPRIGHT cell is drawn with its base at the BOTTOM edge of its cell
  // and its free end at the top, because card() puts the pivot at the bottom
  // and the wind shader flexes by height. A plant drawn centred in its cell
  // hovers, and a hovering fern is worse than no fern.
  function buildUnderstory(rng) {
    var S = 1024, C = S / AN;
    var g = ctx2d(S, S);
    if (!g) return null;
    g.clearRect(0, 0, S, S);
    var i, j, o;
    function O(k) { return [(k % AN) * C, ((k / AN) | 0) * C]; }

    // ---- 0: fern clump, broad ----------------------------------------------
    o = O(0);
    for (i = 0; i < 11; i++) {
      frond(g, rng, o[0] + C * 0.5 + rng.range(-C * 0.07, C * 0.07), o[1] + C * 0.97,
        -C * rng.range(0.52, 0.90), rng.range(-1.05, 1.05), C * 0.060,
        'rgb(31,84,26)', 'rgb(50,125,35)');
    }
    // ---- 1: fern clump, narrower, with one dead frond ----------------------
    o = O(1);
    for (i = 0; i < 7; i++) {
      frond(g, rng, o[0] + C * 0.5 + rng.range(-C * 0.05, C * 0.05), o[1] + C * 0.97,
        -C * rng.range(0.44, 0.72), rng.range(-0.72, 0.72), C * 0.050,
        'rgb(35,95,29)', 'rgb(63,148,43)');
    }
    frond(g, rng, o[0] + C * 0.62, o[1] + C * 0.97, -C * 0.50, 0.9, C * 0.046,
      'rgb(92,72,36)', 'rgb(122,98,50)');

    // ---- 2: grass tuft, tall ------------------------------------------------
    o = O(2);
    for (i = 0; i < 54; i++) {
      blade(g, o[0] + C * 0.5 + rng.gaussian(0, C * 0.10), o[1] + C * 0.98,
        -C * rng.range(0.30, 0.86), rng.range(-0.55, 0.55), C * rng.range(0.012, 0.026),
        rng.bool(0.30) ? 'rgb(112,116,58)' : (rng.bool(0.5) ? 'rgb(45,110,30)' : 'rgb(58,131,35)'));
    }
    // ---- 3: grass tuft, low, with seed heads --------------------------------
    o = O(3);
    for (i = 0; i < 40; i++) {
      blade(g, o[0] + C * 0.5 + rng.gaussian(0, C * 0.13), o[1] + C * 0.98,
        -C * rng.range(0.16, 0.46), rng.range(-0.8, 0.8), C * rng.range(0.010, 0.022),
        rng.bool(0.45) ? 'rgb(126,124,66)' : 'rgb(53,120,34)');
    }
    for (i = 0; i < 7; i++) {
      var sx = o[0] + C * 0.5 + rng.gaussian(0, C * 0.14);
      var sy = o[1] + C * rng.range(0.18, 0.46);
      g.strokeStyle = 'rgb(146,138,86)'; g.lineWidth = C * 0.010;
      g.beginPath(); g.moveTo(sx, o[1] + C * 0.98); g.lineTo(sx + rng.range(-6, 6), sy); g.stroke();
      g.fillStyle = 'rgb(158,148,92)';
      g.beginPath(); g.ellipse(sx, sy, C * 0.011, C * 0.052, rng.range(-0.2, 0.2), 0, 6.283); g.fill();
    }

    // ---- 4: elephant-ear / wild banana --------------------------------------
    o = O(4);
    for (i = 0; i < 5; i++) {
      var ll = C * rng.range(0.50, 0.86);
      g.save();
      g.translate(o[0] + C * 0.5 + rng.range(-C * 0.05, C * 0.05), o[1] + C * 0.97);
      g.rotate(rng.range(-1.15, 1.15) + Math.PI);
      g.strokeStyle = 'rgb(53,118,35)'; g.lineWidth = C * 0.020;
      g.beginPath(); g.moveTo(0, 0); g.lineTo(0, ll * 0.42); g.stroke();
      var w = ll * rng.range(0.36, 0.50);
      g.fillStyle = i % 2 ? 'rgb(35,97,27)' : 'rgb(48,120,32)';
      g.beginPath();
      g.moveTo(0, ll * 0.40);
      g.bezierCurveTo(w, ll * 0.52, w * 0.92, ll * 0.94, 0, ll);
      g.bezierCurveTo(-w * 0.92, ll * 0.94, -w, ll * 0.52, 0, ll * 0.40);
      g.closePath(); g.fill();
      g.strokeStyle = 'rgba(86,182,59,0.8)'; g.lineWidth = C * 0.007;
      g.beginPath(); g.moveTo(0, ll * 0.40); g.lineTo(0, ll * 0.98); g.stroke();
      for (j = 1; j <= 6; j++) {
        var vt = 0.40 + (j / 7) * 0.56;
        g.lineWidth = C * 0.004;
        g.beginPath(); g.moveTo(0, ll * vt);
        g.lineTo(w * 0.72 * Math.sin(j), ll * (vt + 0.10)); g.stroke();
        g.beginPath(); g.moveTo(0, ll * vt);
        g.lineTo(-w * 0.72 * Math.sin(j + 1), ll * (vt + 0.10)); g.stroke();
      }
      g.restore();
    }

    // ---- 5: hanging vine (drawn top-to-bottom; card() flips it) -------------
    o = O(5);
    for (i = 0; i < 6; i++) {
      var vx = o[0] + C * (0.14 + i * 0.145) + rng.range(-8, 8);
      var wob = rng.range(-1, 1);
      g.strokeStyle = 'rgb(64,58,36)'; g.lineWidth = C * rng.range(0.008, 0.016);
      g.beginPath(); g.moveTo(vx, o[1] + C * 0.02);
      var cy2 = o[1] + C * 0.02;
      for (j = 0; j < 10; j++) {
        cy2 += C * 0.098;
        g.lineTo(vx + Math.sin(j * 0.9 + i) * C * 0.030 * wob, cy2);
      }
      g.stroke();
      for (j = 0; j < 12; j++) {
        var t2 = rng.range(0.06, 0.98);
        leafShape(g, vx + Math.sin(t2 * 9 + i) * C * 0.030 * wob, o[1] + C * t2,
          C * rng.range(0.048, 0.086), C * rng.range(0.016, 0.028),
          rng.range(-2.4, -0.7), rng.bool(0.5) ? 'rgb(38,100,29)' : 'rgb(57,133,37)',
          'rgba(82,177,53,0.7)');
      }
    }

    // ---- 6: creeper mat, fills the cell (wall faces) ------------------------
    o = O(6);
    for (i = 0; i < 26; i++) {
      var rx = o[0] + rng.range(0, C), ry = o[1] + C * rng.range(0.86, 1.0);
      var ra = rng.range(-2.4, -0.7);
      g.strokeStyle = 'rgb(58,54,34)'; g.lineWidth = C * 0.008;
      g.beginPath(); g.moveTo(rx, ry);
      for (j = 0; j < 9; j++) {
        ra += rng.range(-0.30, 0.30);
        rx += Math.cos(ra) * C * 0.085; ry += Math.sin(ra) * C * 0.085;
        g.lineTo(rx, ry);
        if (rng.bool(0.75)) {
          leafShape(g, rx, ry, C * rng.range(0.036, 0.070), C * rng.range(0.014, 0.026),
            rng.range(0, 6.28), rng.bool(0.4) ? 'rgb(33,90,26)' : 'rgb(53,128,34)', null);
        }
      }
      g.stroke();
    }

    // ---- 7: lily pads --------------------------------------------------------
    o = O(7);
    for (i = 0; i < 13; i++) {
      var pr = C * rng.range(0.055, 0.135);
      g.save();
      g.translate(o[0] + rng.range(C * 0.14, C * 0.86), o[1] + rng.range(C * 0.14, C * 0.86));
      g.rotate(rng.range(0, 6.28));
      g.fillStyle = rng.bool(0.30) ? 'rgb(60,123,37)'
        : (rng.bool(0.5) ? 'rgb(35,95,30)' : 'rgb(44,110,32)');
      g.beginPath();
      // the notch is the whole silhouette read of a lily pad
      g.arc(0, 0, pr, 0.32, Math.PI * 2 - 0.32);
      g.lineTo(0, 0); g.closePath(); g.fill();
      g.strokeStyle = 'rgba(83,174,56,0.55)'; g.lineWidth = pr * 0.055;
      for (j = 0; j < 7; j++) {
        var av = 0.4 + j * 0.78;
        g.beginPath(); g.moveTo(0, 0);
        g.lineTo(Math.cos(av) * pr * 0.94, Math.sin(av) * pr * 0.94); g.stroke();
      }
      g.restore();
    }

    // ---- 8: lotus flowers over pads -----------------------------------------
    o = O(8);
    for (i = 0; i < 5; i++) {
      var lx2 = o[0] + rng.range(C * 0.20, C * 0.80);
      var ly2 = o[1] + rng.range(C * 0.22, C * 0.82);
      g.fillStyle = 'rgb(39,102,32)';
      g.beginPath(); g.arc(lx2 + C * 0.085, ly2 + C * 0.06, C * 0.085, 0.3, 6.0); g.fill();
      for (j = 0; j < 9; j++) {
        g.save(); g.translate(lx2, ly2); g.rotate(j / 9 * 6.283);
        g.fillStyle = j % 2 ? 'rgb(228,198,196)' : 'rgb(208,158,164)';
        g.beginPath();
        g.moveTo(0, 0);
        g.bezierCurveTo(C * 0.026, -C * 0.040, C * 0.020, -C * 0.088, 0, -C * 0.100);
        g.bezierCurveTo(-C * 0.020, -C * 0.088, -C * 0.026, -C * 0.040, 0, 0);
        g.fill(); g.restore();
      }
      g.fillStyle = 'rgb(220,198,120)';
      g.beginPath(); g.arc(lx2, ly2, C * 0.020, 0, 6.283); g.fill();
    }

    // ---- 9: reed / sedge tuft ------------------------------------------------
    o = O(9);
    for (i = 0; i < 26; i++) {
      blade(g, o[0] + C * 0.5 + rng.gaussian(0, C * 0.085), o[1] + C * 0.99,
        -C * rng.range(0.42, 0.95), rng.range(-0.30, 0.30), C * rng.range(0.014, 0.024),
        rng.bool(0.35) ? 'rgb(118,112,60)' : 'rgb(42,105,32)');
    }

    // ---- 10: dry leaf litter (ground card) -----------------------------------
    // Deliberately PALE. The first pass authored these at the true albedo of
    // wet leaf mould and they alpha-tested into a scatter of black blotches on
    // a pale flagstone floor - at this exposure a 0.06 albedo card on a 0.24
    // albedo floor is a hole, not a leaf. Dry fallen leaf in the dry season is
    // straw, and it has to sit inside the floor's own value range.
    // The density also falls off radially. A card drawn to a uniform density
    // has a VISIBLE RECTANGLE for an outline once it is lying on a lit
    // flagstone floor, and eighty of them tile the corridor with squares.
    o = O(10);
    for (i = 0; i < 150; i++) {
      var ldx = rng.gaussian(0, C * 0.24), ldz = rng.gaussian(0, C * 0.24);
      if (Math.abs(ldx) > C * 0.47 || Math.abs(ldz) > C * 0.47) continue;
      leafShape(g, o[0] + C * 0.5 + ldx, o[1] + C * 0.5 + ldz,
        C * rng.range(0.026, 0.070), C * rng.range(0.011, 0.026), rng.range(0, 6.28),
        rng.bool(0.42) ? 'rgb(166,136,80)'
          : (rng.bool(0.5) ? 'rgb(134,112,66)' : 'rgb(190,164,108)'),
        'rgba(204,182,128,0.5)');
    }

    // ---- 11: sapling rooted in masonry ---------------------------------------
    o = O(11);
    g.strokeStyle = 'rgb(86,74,50)'; g.lineWidth = C * 0.024;
    g.beginPath(); g.moveTo(o[0] + C * 0.5, o[1] + C * 0.99);
    g.quadraticCurveTo(o[0] + C * 0.56, o[1] + C * 0.55, o[0] + C * 0.44, o[1] + C * 0.24);
    g.stroke();
    for (i = 0; i < 4; i++) {
      var bx2 = o[0] + C * (0.50 - i * 0.02), by2 = o[1] + C * (0.86 - i * 0.18);
      g.lineWidth = C * 0.012;
      g.beginPath(); g.moveTo(bx2, by2);
      g.lineTo(bx2 + (i % 2 ? 1 : -1) * C * 0.20, by2 - C * 0.14); g.stroke();
    }
    for (i = 0; i < 46; i++) {
      var tt = rng.range(0.10, 0.92);
      leafShape(g, o[0] + C * (0.48 + rng.gaussian(0, 0.13)), o[1] + C * (1.0 - tt * 0.86),
        C * rng.range(0.050, 0.092), C * rng.range(0.018, 0.032), rng.range(0, 6.28),
        rng.bool(0.4) ? 'rgb(39,102,29)' : 'rgb(60,141,37)', 'rgba(86,187,56,0.6)');
    }

    // ---- 12: moss cushion / low ground cover ---------------------------------
    o = O(12);
    for (i = 0; i < 90; i++) {
      g.fillStyle = rng.bool(0.4) ? 'rgb(39,102,30)' : 'rgb(53,123,35)';
      g.beginPath();
      g.arc(o[0] + C * 0.5 + rng.gaussian(0, C * 0.20), o[1] + C * 0.72 + rng.gaussian(0, C * 0.16),
        C * rng.range(0.020, 0.060), 0, 6.283);
      g.fill();
    }
    for (i = 0; i < 34; i++) {
      blade(g, o[0] + C * 0.5 + rng.gaussian(0, C * 0.18), o[1] + C * 0.95,
        -C * rng.range(0.10, 0.26), rng.range(-0.7, 0.7), C * 0.012, 'rgb(65,138,40)');
    }

    // ---- 13: hanging aerial roots --------------------------------------------
    // The first pass drew these as thin dark strokes and they alpha-tested
    // into a row of black spikes hanging in the gallery vault that read as a
    // rendering fault, not as a plant. Aerial root off a strangler fig is a
    // PALE GREY-TAN rope, thick, tapering, and a curtain of them together is
    // nearly opaque - so: heavy lines, a light colour that sits inside the
    // stone's own value range, and enough of them to close up into a mass.
    o = O(13);
    g.lineCap = 'round';
    for (i = 0; i < 34; i++) {
      var ax2 = o[0] + rng.range(C * 0.03, C * 0.97);
      var base = 118 + (rng.next() * 44 | 0);
      var taper = rng.range(0.020, 0.052);
      var yy = o[1];
      var px3 = ax2;
      for (j = 0; j < 9; j++) {
        var t4 = j / 9;
        g.strokeStyle = 'rgba(' + (base | 0) + ',' + ((base * 0.90) | 0) + ',' +
          ((base * 0.70) | 0) + ',' + (0.95 - t4 * 0.30).toFixed(2) + ')';
        g.lineWidth = Math.max(1.6, C * taper * (1 - t4 * 0.62));
        var ny2 = yy + C * rng.range(0.10, 0.14);
        var nx2 = px3 + rng.range(-C * 0.016, C * 0.016);
        g.beginPath(); g.moveTo(px3, yy); g.lineTo(nx2, Math.min(ny2, o[1] + C)); g.stroke();
        px3 = nx2; yy = ny2;
        if (yy > o[1] + C) break;
      }
      // a few of them have taken hold and put out leaf
      if (rng.bool(0.30)) {
        for (j = 0; j < 5; j++) {
          leafShape(g, px3 + rng.range(-C * 0.03, C * 0.03), yy - C * rng.range(0, 0.20),
            C * rng.range(0.034, 0.062), C * rng.range(0.014, 0.024), rng.range(0, 6.28),
            rng.bool(0.5) ? 'rgb(46,113,34)' : 'rgb(65,146,42)', null);
        }
      }
    }

    // ---- 14: flowering creeper -----------------------------------------------
    o = O(14);
    for (i = 0; i < 18; i++) {
      var fx = o[0] + rng.range(0, C), fy = o[1] + C * rng.range(0.75, 1.0);
      var fa = rng.range(-2.5, -0.6);
      g.strokeStyle = 'rgb(62,60,38)'; g.lineWidth = C * 0.007;
      g.beginPath(); g.moveTo(fx, fy);
      for (j = 0; j < 8; j++) {
        fa += rng.range(-0.3, 0.3);
        fx += Math.cos(fa) * C * 0.088; fy += Math.sin(fa) * C * 0.088;
        g.lineTo(fx, fy);
        if (rng.bool(0.7)) {
          leafShape(g, fx, fy, C * rng.range(0.030, 0.056), C * rng.range(0.012, 0.022),
            rng.range(0, 6.28), 'rgb(38,100,29)', null);
        }
        if (rng.bool(0.10)) {
          for (var pj = 0; pj < 5; pj++) {
            var pa2 = pj / 5 * 6.283;
            g.fillStyle = 'rgb(206,198,170)';
            g.beginPath();
            g.ellipse(fx + Math.cos(pa2) * C * 0.0085, fy + Math.sin(pa2) * C * 0.0085,
              C * 0.008, C * 0.0045, pa2, 0, 6.283);
            g.fill();
          }
          g.fillStyle = 'rgb(198,172,104)';
          g.beginPath(); g.arc(fx, fy, C * 0.004, 0, 6.283); g.fill();
        }
      }
      g.stroke();
    }

    // ---- 15: straw / packing material ----------------------------------------
    o = O(15);
    for (i = 0; i < 220; i++) {
      var stx = o[0] + rng.range(0, C), sty = o[1] + rng.range(0, C);
      var sa = rng.range(0, 3.14), sl = C * rng.range(0.05, 0.16);
      g.strokeStyle = rng.bool(0.5) ? 'rgb(158,138,86)' : 'rgb(122,104,62)';
      g.lineWidth = C * rng.range(0.004, 0.009);
      g.beginPath(); g.moveTo(stx, sty);
      g.lineTo(stx + Math.cos(sa) * sl, sty + Math.sin(sa) * sl); g.stroke();
    }
    return g.canvas;
  }

  // ---- marks atlas: 3 x 3 ---------------------------------------------------
  // 0 soot ring        1 chalked inventory number   2 bird lime
  // 3 damp ring        4 WATER-STAIN DRIP           5 MINERAL / SILT RUN
  // 6 ALGAE WEEP       7 -                          8 -
  //
  // Cells 4-6 are new and they are the single most characteristic weathering
  // on Khmer sandstone: the dark vertical streak that runs down from every
  // projecting cornice, lintel and string course where nine hundred monsoons
  // have shed off the moulding above and washed the same line of wall. The
  // level authored a stain mark in its own atlas and never placed one below a
  // projection - photographed, the centre prasat carries four separate
  // projecting mouldings and there was not one streak under any of them.
  var MN = 3;
  function markUV(i, pad) {
    pad = pad === undefined ? 0.004 : pad;
    var c = i % MN, r = (i / MN) | 0, s = 1 / MN;
    return [c * s + pad, 1 - (r + 1) * s + pad, (c + 1) * s - pad, 1 - r * s - pad];
  }

  // A single run of water off a drip edge: widest and darkest at the top where
  // it leaves the moulding, forking and fading as it spreads down the face.
  function drip(g, rng, x, y0, len, w, top, mid, tail, fork) {
    var grd = g.createLinearGradient(0, y0, 0, y0 + len);
    grd.addColorStop(0, top);
    grd.addColorStop(0.30, mid);
    grd.addColorStop(0.72, tail);
    grd.addColorStop(1, tail.replace(/[\d.]+\)$/, '0)'));
    g.fillStyle = grd;
    // the run wanders: eight quads down the face rather than one rectangle,
    // each one offset and narrowed, so the streak has an edge that is not a
    // ruled line
    var cx = x, cw = w;
    for (var s = 0; s < 8; s++) {
      var t = s / 8;
      g.fillRect(cx - cw * 0.5, y0 + len * t, cw, len / 8 + 1);
      cx += rng.range(-w * 0.30, w * 0.30);
      cw *= rng.range(0.86, 1.06);
    }
    if (fork && len > 40) {
      var fx = x + rng.range(-w * 1.4, w * 1.4);
      var fy = y0 + len * rng.range(0.18, 0.45);
      var fl = (y0 + len) - fy;
      var fw2 = w * rng.range(0.35, 0.62);
      var g2 = g.createLinearGradient(0, fy, 0, fy + fl);
      g2.addColorStop(0, mid);
      g2.addColorStop(1, tail.replace(/[\d.]+\)$/, '0)'));
      g.fillStyle = g2;
      for (var s2 = 0; s2 < 6; s2++) {
        g.fillRect(fx - fw2 * 0.5, fy + fl * (s2 / 6), fw2, fl / 6 + 1);
        fx += rng.range(-fw2 * 0.4, fw2 * 0.4);
        fw2 *= rng.range(0.88, 1.04);
      }
    }
  }

  function buildMarks(rng) {
    var S = 768, C = S / MN;
    var g = ctx2d(S, S);
    if (!g) return null;
    g.clearRect(0, 0, S, S);
    var i, j;

    // ---- 0: soot and ash under a fire --------------------------------------
    var grd = g.createRadialGradient(C * 0.5, C * 0.5, C * 0.04, C * 0.5, C * 0.5, C * 0.48);
    grd.addColorStop(0, 'rgba(24,20,18,0.86)');
    grd.addColorStop(0.45, 'rgba(38,32,28,0.52)');
    grd.addColorStop(1, 'rgba(56,48,42,0)');
    g.fillStyle = grd; g.fillRect(0, 0, C, C);
    for (i = 0; i < 60; i++) {
      g.globalAlpha = rng.range(0.10, 0.42);
      g.fillStyle = rng.bool(0.4) ? 'rgb(178,172,164)' : 'rgb(30,26,22)';
      g.beginPath();
      g.arc(C * 0.5 + rng.gaussian(0, C * 0.16), C * 0.5 + rng.gaussian(0, C * 0.16),
        C * rng.range(0.008, 0.040), 0, 6.283);
      g.fill();
    }
    g.globalAlpha = 1;

    // ---- 1: chalked inventory number, invented script ----------------------
    // Stone-by-stone numbering IS anastylosis - the whole method is "take it
    // apart, number every block, put it back" - so these glyphs are the one
    // prop that explains the yard without a caption.
    g.save(); g.translate(C, 0);
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (i = 0; i < 3; i++) {
      var by = C * (0.22 + i * 0.30);
      var bx = C * rng.range(0.10, 0.24);
      g.strokeStyle = 'rgba(228,224,210,' + rng.range(0.55, 0.92).toFixed(2) + ')';
      g.lineWidth = C * rng.range(0.018, 0.030);
      var n = 3 + (i % 3);
      for (j = 0; j < n; j++) {
        var cx = bx + j * C * 0.15;
        var kind = (rng.next() * 6) | 0;
        g.beginPath();
        if (kind === 0) { g.moveTo(cx, by); g.lineTo(cx, by + C * 0.13); g.lineTo(cx + C * 0.08, by + C * 0.13); }
        else if (kind === 1) { g.arc(cx + C * 0.05, by + C * 0.07, C * 0.058, -0.6, 3.4); }
        else if (kind === 2) { g.moveTo(cx, by); g.lineTo(cx + C * 0.09, by + C * 0.13); g.moveTo(cx + C * 0.09, by); g.lineTo(cx, by + C * 0.13); }
        else if (kind === 3) { g.moveTo(cx, by + C * 0.13); g.lineTo(cx + C * 0.045, by); g.lineTo(cx + C * 0.09, by + C * 0.13); g.moveTo(cx + C * 0.02, by + C * 0.08); g.lineTo(cx + C * 0.07, by + C * 0.08); }
        else if (kind === 4) { g.moveTo(cx, by); g.lineTo(cx + C * 0.08, by); g.moveTo(cx + C * 0.04, by); g.lineTo(cx + C * 0.04, by + C * 0.13); }
        else { g.moveTo(cx, by); g.lineTo(cx, by + C * 0.13); g.moveTo(cx, by + C * 0.065); g.lineTo(cx + C * 0.08, by + C * 0.02); }
        g.stroke();
      }
    }
    g.restore();

    // ---- 2: bird lime -------------------------------------------------------
    g.save(); g.translate(2 * C, 0);
    for (i = 0; i < 26; i++) {
      var lx = rng.range(C * 0.06, C * 0.92), ly = rng.range(0, C * 0.32);
      var ll = rng.range(C * 0.10, C * 0.52);
      var grd2 = g.createLinearGradient(0, ly, 0, ly + ll);
      grd2.addColorStop(0, 'rgba(228,224,212,' + rng.range(0.42, 0.82).toFixed(2) + ')');
      grd2.addColorStop(0.7, 'rgba(206,200,186,0.28)');
      grd2.addColorStop(1, 'rgba(196,190,176,0)');
      g.fillStyle = grd2;
      g.fillRect(lx, ly, C * rng.range(0.014, 0.045), ll);
      g.fillStyle = 'rgba(234,230,218,0.72)';
      g.beginPath(); g.arc(lx + C * 0.012, ly + C * 0.01, C * rng.range(0.012, 0.030), 0, 6.283); g.fill();
    }
    g.restore();

    // ---- 3: damp ring under a jar ------------------------------------------
    g.save(); g.translate(0, C);
    var grd3 = g.createRadialGradient(C * 0.5, C * 0.5, C * 0.16, C * 0.5, C * 0.5, C * 0.46);
    grd3.addColorStop(0, 'rgba(30,32,28,0.0)');
    grd3.addColorStop(0.42, 'rgba(32,34,30,0.46)');
    grd3.addColorStop(0.82, 'rgba(38,40,34,0.30)');
    grd3.addColorStop(1, 'rgba(44,46,40,0)');
    g.fillStyle = grd3; g.fillRect(0, 0, C, C);
    for (i = 0; i < 24; i++) {
      g.globalAlpha = rng.range(0.06, 0.24);
      g.fillStyle = 'rgb(30,67,30)';
      g.beginPath();
      g.arc(C * 0.5 + rng.gaussian(0, C * 0.19), C * 0.5 + rng.gaussian(0, C * 0.19),
        C * rng.range(0.02, 0.07), 0, 6.283);
      g.fill();
    }
    g.globalAlpha = 1; g.restore();

    // ---- 4: WATER-STAIN DRIP -----------------------------------------------
    // Dark, cool and organic-loaded: run-off off a cornice carries a decade of
    // wind-blown dust and it grows a black biofilm where it stays damp longest.
    // Six or seven runs of unequal length, because rain does not leave a
    // fringe - it finds the LOW POINTS of the drip edge and comes off those.
    g.save(); g.translate(C, C);
    g.globalAlpha = 1;
    for (i = 0; i < 7; i++) {
      var dx4 = C * (0.10 + i * 0.132) + rng.range(-C * 0.035, C * 0.035);
      var dl4 = C * rng.range(0.44, 0.98);
      var dw4 = C * rng.range(0.030, 0.088);
      var dv4 = rng.range(0.44, 0.86);
      drip(g, rng, dx4, C * rng.range(0.0, 0.06), dl4, dw4,
        'rgba(26,25,21,' + dv4.toFixed(3) + ')',
        'rgba(38,38,32,' + (dv4 * 0.74).toFixed(3) + ')',
        'rgba(54,54,46,' + (dv4 * 0.30).toFixed(3) + ')', rng.bool(0.55));
    }
    // the dark bead along the drip edge itself, which is where the run starts
    var grd4 = g.createLinearGradient(0, 0, 0, C * 0.13);
    grd4.addColorStop(0, 'rgba(22,22,19,0.72)');
    grd4.addColorStop(1, 'rgba(40,40,34,0)');
    g.fillStyle = grd4;
    g.fillRect(0, 0, C, C * 0.13);
    // black algae speckle inside the wettest runs
    for (i = 0; i < 90; i++) {
      g.globalAlpha = rng.range(0.10, 0.34);
      g.fillStyle = rng.bool(0.6) ? 'rgb(18,34,20)' : 'rgb(24,24,20)';
      g.beginPath();
      g.arc(rng.range(0, C), rng.range(0, C * 0.86), C * rng.range(0.004, 0.017), 0, 6.283);
      g.fill();
    }
    g.globalAlpha = 1; g.restore();

    // ---- 5: MINERAL / SILT RUN ----------------------------------------------
    // The other half of the same story and the one that stops every streak in
    // the level being a dark one: lime leached out of the bedding mortar
    // deposits a PALE run under a projection that sheds fast, and the silt
    // washed off a cornice top dries to a warm tan fan. On a shadow elevation
    // a pale streak is the only weathering that is visible at all.
    g.save(); g.translate(2 * C, C);
    for (i = 0; i < 6; i++) {
      var sx5 = C * (0.12 + i * 0.155) + rng.range(-C * 0.04, C * 0.04);
      var sl5 = C * rng.range(0.36, 0.90);
      var sw5 = C * rng.range(0.038, 0.105);
      var sv5 = rng.range(0.24, 0.52);
      drip(g, rng, sx5, C * rng.range(0.0, 0.08), sl5, sw5,
        'rgba(196,186,164,' + sv5.toFixed(3) + ')',
        'rgba(174,163,140,' + (sv5 * 0.66).toFixed(3) + ')',
        'rgba(152,142,122,' + (sv5 * 0.26).toFixed(3) + ')', rng.bool(0.4));
    }
    for (i = 0; i < 60; i++) {
      g.globalAlpha = rng.range(0.06, 0.22);
      g.fillStyle = rng.bool(0.5) ? 'rgb(150,134,100)' : 'rgb(112,100,76)';
      g.beginPath();
      g.arc(rng.range(0, C), rng.range(0, C), C * rng.range(0.008, 0.030), 0, 6.283);
      g.fill();
    }
    g.globalAlpha = 1; g.restore();

    // ---- 6: ALGAE WEEP ------------------------------------------------------
    // Where a moulding holds water rather than shedding it - a broken cornice,
    // a blocked drip - the run is green-black and it stays wet. This is the
    // one streak that carries chroma, and in a level measuring 74% of its
    // chroma inside a single red bin that is worth having.
    g.save(); g.translate(0, 2 * C);
    for (i = 0; i < 5; i++) {
      var ax6 = C * (0.14 + i * 0.185) + rng.range(-C * 0.05, C * 0.05);
      var al6 = C * rng.range(0.30, 0.82);
      var aw6 = C * rng.range(0.050, 0.130);
      var av6 = rng.range(0.38, 0.80);
      drip(g, rng, ax6, C * rng.range(0.0, 0.05), al6, aw6,
        'rgba(22,52,24,' + av6.toFixed(3) + ')',
        'rgba(34,74,32,' + (av6 * 0.72).toFixed(3) + ')',
        'rgba(44,86,40,' + (av6 * 0.28).toFixed(3) + ')', rng.bool(0.5));
    }
    for (i = 0; i < 120; i++) {
      g.globalAlpha = rng.range(0.14, 0.48);
      g.fillStyle = rng.bool(0.5) ? 'rgb(26,66,26)' : 'rgb(46,102,38)';
      g.beginPath();
      g.arc(rng.range(0, C), rng.range(0, C * 0.9), C * rng.range(0.005, 0.022), 0, 6.283);
      g.fill();
    }
    g.globalAlpha = 1; g.restore();

    // ---- FEATHER THE SIDES OF EVERY STREAK CELL -----------------------------
    // A decal is a quad, and a streak whose alpha is still high at the quad's
    // left or right edge shows the quad. The TOP edge is left hard on purpose:
    // that edge is registered against the drip line of a real moulding and it
    // is supposed to start abruptly there.
    (function () {
      var fp = C * 0.10;
      for (var fk = 4; fk <= 6; fk++) {
        var oc = (fk % MN) * C, orow = ((fk / MN) | 0) * C;
        g.save();
        g.globalCompositeOperation = 'destination-out';
        g.globalAlpha = 1;
        var sides = [
          [oc, orow, fp, C, oc, 0, oc + fp, 0],
          [oc + C - fp, orow, fp, C, oc + C, 0, oc + C - fp, 0],
          [oc, orow + C - fp, C, fp, 0, orow + C, 0, orow + C - fp]
        ];
        for (var sq = 0; sq < sides.length; sq++) {
          var sv = sides[sq];
          var gr = g.createLinearGradient(sv[4], sv[5], sv[6], sv[7]);
          gr.addColorStop(0, 'rgba(0,0,0,1)');
          gr.addColorStop(0.6, 'rgba(0,0,0,0.4)');
          gr.addColorStop(1, 'rgba(0,0,0,0)');
          g.fillStyle = gr;
          g.fillRect(sv[0], sv[1], sv[2], sv[3]);
        }
        g.restore();
      }
    })();
    g.globalAlpha = 1;
    return g.canvas;
  }

  // A soft vertical plume for the incense and the brazier.
  function buildSmoke() {
    var S = 128;
    var g = ctx2d(S, S);
    if (!g) return null;
    var img = g.createImageData(S, S);
    var d = img.data;
    var N = GAME.noise;
    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        var u = x / S - 0.5, v = 1 - y / S;
        var wid = 0.05 + v * 0.36;
        var lat = M.smoothstep(wid, wid * 0.12, Math.abs(u));
        var fade = M.smoothstep(1.0, 0.40, v) * M.smoothstep(0.0, 0.08, v);
        var n = (N ? N.fbm2(x * 0.07 + 4.0, y * 0.05 - 9.0, 3) : 0) * 0.5 + 0.5;
        var a = M.saturate(lat * fade * (0.40 + n * 0.80)) * 0.55;
        var i = (y * S + x) * 4;
        d[i] = 236; d[i + 1] = 230; d[i + 2] = 218; d[i + 3] = a * 255;
      }
    }
    g.putImageData(img, 0, 0);
    return g.canvas;
  }

  // ==========================================================================
  // WIND
  //
  // ctx.weather on this level is the 'clear' preset, and 'clear' is ABSENT -
  // no geometry, no wind vector, nothing. So the breeze is authored here: a
  // dawn land breeze at about 1.4 m/s, which is what the hour actually has.
  // If a weather system ever does appear, update() adopts its bearing instead.
  //
  // The displacement is applied in OBJECT space, before instanceMatrix. Every
  // instance carries its own yaw, so each plant bends on its own bearing
  // rather than the whole understory leaning as one - which at 1.4 m/s is not
  // wrong (that IS what light air through undergrowth looks like) and is the
  // only version that does not need a per-instance inverse rotation in the
  // vertex shader.
  // ==========================================================================
  var WIND_PARS = [
    'uniform float rTime;',
    'uniform vec4 rWind;',
    'uniform vec2 rWindDir;',
    'attribute float aFlex;'
  ].join('\n');

  var WIND_BODY = [
    '#ifdef USE_INSTANCING',
    '  vec3 rOrg = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;',
    '#else',
    '  vec3 rOrg = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;',
    '#endif',
    '  float rPh = rOrg.x * rWind.w + rOrg.z * rWind.w * 0.73;',
    '  float rS = sin( rTime * rWind.y + rPh ) * 0.68',
    '           + sin( rTime * rWind.y * 2.17 + rPh * 1.9 ) * 0.22',
    '           + sin( rTime * rWind.y * 0.41 + rPh * 0.4 ) * 0.32;',
    '  float rA = rWind.x * aFlex * aFlex;',
    '  transformed.x += rWindDir.x * rS * rA;',
    '  transformed.z += rWindDir.y * rS * rA;',
    '  transformed.y -= abs( rS ) * rA * rWind.z;'
  ].join('\n');

  function applyWind(mat, uTime, uWind, uWindDir) {
    var prev = mat.onBeforeCompile;
    mat.onBeforeCompile = function (shader, renderer) {
      if (prev) {
        try { prev.call(this, shader, renderer); }
        catch (e) { GAME.logError('propsR.windChain', e); }
      }
      shader.uniforms.rTime = uTime;
      shader.uniforms.rWind = uWind;
      shader.uniforms.rWindDir = uWindDir;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + WIND_PARS)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + WIND_BODY);
    };
    // three.js prefers customProgramCacheKey over onBeforeCompile.toString(),
    // so without this every wind material compiles its own program.
    mat.customProgramCacheKey = function () { return 'ruinsWind'; };
    return mat;
  }

  // Flex weight: 0 where the plant is anchored, 1 at the free end. Squared in
  // the shader, so it stays linear here.
  function setFlex(geo, mode, span) {
    var p = geo.attributes.position;
    if (!p) return geo;
    span = span || 1;
    var a = new Float32Array(p.count);
    for (var i = 0; i < p.count; i++) {
      var y = p.getY(i);
      a[i] = mode === 'down' ? M.saturate(-y / span) : M.saturate(y / span);
    }
    geo.setAttribute('aFlex', new THREE.BufferAttribute(a, 1));
    return geo;
  }

  // ==========================================================================
  // GAME.PropsRuins
  // ==========================================================================
  function PropsRuins(ctx) {
    this.ctx = ctx || {};
    this.root = new THREE.Object3D();
    this.root.name = 'props_ruins';
    this.root.matrixAutoUpdate = false;
    this.colliders = [];
    this.practicalLights = [];
    this.smokeEmitters = [];

    var seed = ((((this.ctx && this.ctx.seed) || 20260801) ^ 0x2A17B3D1) >>> 0);
    this.rng = new GAME.RNG(seed);
    this.noise = new GAME.Noise((seed ^ 0x9E3779B9) >>> 0);

    this.time = 0;
    this.uTime = { value: 0 };
    // amplitude (m), frequency (rad/s), droop, spatial phase. A DAWN breeze:
    // 4 cm of travel at a fern tip, not a gale. The quietest level in the
    // roster cannot have its undergrowth thrashing.
    this.uWind = { value: new THREE.Vector4(0.045, 1.05, 0.30, 0.42) };
    this.uWindDir = { value: new THREE.Vector2(-0.62, 0.78) };

    this.tex = {};
    this.mats = {};
    this.S = Object.create(null);       // static merged: key -> [{geometry,matrix,wear}]
    this.I = Object.create(null);       // instanced: kind -> {geo,mat,list,cast,recv}
    this.flames = [];
    this.smokes = [];
    this.stats = { instances: 0, batches: 0, statics: 0, draws: 0, tris: 0, colliders: 0 };

    this._stack = [new THREE.Matrix4()];
    this.wear = null;

    this.A = null;
    this._hash = null;
    this._occ = new Map();
    this._sun = new THREE.Vector3(-0.524, 0.169, -0.852).normalize();
    this._ok = false;

    try { if (this.ctx.scene) this.ctx.scene.add(this.root); }
    catch (e) { GAME.logError('propsR.ctor', e); }
  }

  PropsRuins.prototype._phase = function (name, fn) {
    try { fn.call(this); } catch (e) { GAME.logError('propsR.' + name, e); }
    return GAME.yieldFrame();
  };

  PropsRuins.prototype.build = async function (ctx) {
    if (ctx) this.ctx = ctx;
    try { if (this.ctx.scene && !this.root.parent) this.ctx.scene.add(this.root); }
    catch (e) { GAME.logError('propsR.attach', e); }

    await this._phase('textures', this._initTextures);
    await this._phase('materials', this._initMaterials);
    await this._phase('level', this._readLevel);
    await this._phase('kit', this._buildKit);

    // Order matters. The big one-offs claim their ground first and the growth
    // pass fills in around them, which is both how a site actually silts up
    // and the only reason a fern does not end up inside the gantry.
    await this._phase('statuary', this._dressStatuary);
    await this._phase('shrine', this._dressShrine);
    await this._phase('gallery', this._dressGallery);
    await this._phase('yard', this._dressYard);
    await this._phase('dig', this._dressDig);
    await this._phase('camp', this._dressCamp);
    await this._phase('courtyard', this._dressCourtyard);
    await this._phase('causeway', this._dressCauseway);
    await this._phase('water', this._dressWater);
    await this._phase('growth', this._dressGrowth);
    await this._phase('stains', this._dressStains);
    await this._phase('debris', this._dressDebris);
    await this._phase('commit', this._commit);
    return this;
  };

  // ==========================================================================
  // Textures and materials
  // ==========================================================================
  PropsRuins.prototype._aniso = function () {
    try {
      var c = this.ctx.renderer && this.ctx.renderer.capabilities;
      if (c && c.getMaxAnisotropy) return Math.max(1, Math.min(8, c.getMaxAnisotropy() || 1));
    } catch (e) { /* headless */ }
    return 4;
  };

  PropsRuins.prototype._initTextures = function () {
    var an = this._aniso();
    var rf = this.rng.fork ? this.rng.fork(0x7E88) : this.rng;
    this.tex.plant = makeTex(buildUnderstory(rf), true, an, false);
    this.tex.marks = makeTex(buildMarks(rf.fork ? rf.fork(0x115) : rf), true, an, false);
    this.tex.smoke = makeTex(buildSmoke(), true, an, false);
  };

  PropsRuins.prototype._material = function (key) {
    if (this.mats[key]) return this.mats[key];
    var surf = SURF[key] || SURF.stone;
    var m = null;
    try {
      var lib = this.ctx.materials;
      var has = false;
      try { has = !!(lib && typeof lib.has === 'function' && lib.has(surf.base)); }
      catch (e) { has = false; }
      if (lib && typeof lib.get === 'function' && has) {
        var opts = { vertexColors: true, wearMode: surf.mult ? 'multiply' : 'wear' };
        if (surf.alb != null) opts.albedoTarget = surf.alb;
        if (surf.hue != null) opts.hue = surf.hue;
        if (surf.metal != null) opts.metalness = surf.metal;
        if (surf.rough != null) opts.roughness = surf.rough;
        m = lib.get(surf.base, opts);
        // Never mutate a cached library material: level_ruins.js asks for the
        // same recipes, and a shared instance is exactly what turns a one-line
        // change here into somebody else's regression.
        if (m && m.clone) m = m.clone();
      }
    } catch (e2) { GAME.logError('propsR.mat:' + key, e2); m = null; }
    if (!m || !m.isMaterial) {
      var fb = FALLBACK[key] || FALLBACK.stone;
      m = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHex(fb[0], THREE.SRGBColorSpace),
        roughness: fb[1], metalness: fb[2], vertexColors: true
      });
    }
    m.name = 'ruinsprop_' + key;
    this.mats[key] = m;
    return m;
  };

  PropsRuins.prototype._initMaterials = function () {
    // ---- understory: OUR material, so per-instance colour is a HUE jitter ---
    // A library material in wear mode reads instanceColor as the wear mask, so
    // a green instance tint there would read as "extremely grimy" rather than
    // as a different plant. Plain multiply is what a leaf wants.
    var plant = new THREE.MeshStandardMaterial({
      map: this.tex.plant || null, color: 0xffffff,
      roughness: 0.80, metalness: 0.0,
      alphaTest: 0.34, side: THREE.DoubleSide,
      vertexColors: true, envMapIntensity: 0.95
    });
    if (!this.tex.plant) plant.color = new THREE.Color().setHex(0x53703a, THREE.SRGBColorSpace);
    plant.name = 'ruinsprop_plant';
    applyWind(plant, this.uTime, this.uWind, this.uWindDir);
    this.mats.plant = plant;

    // A second, STILL copy for anything that must not move: lily pads on a
    // mirror-flat pool, and dry litter lying on stone. Litter that sways is
    // litter that is not lying on the ground.
    var still = new THREE.MeshStandardMaterial({
      map: this.tex.plant || null, color: 0xffffff,
      roughness: 0.86, metalness: 0.0,
      alphaTest: 0.34, side: THREE.DoubleSide,
      vertexColors: true, envMapIntensity: 0.95
    });
    if (!this.tex.plant) still.color = new THREE.Color().setHex(0x53703a, THREE.SRGBColorSpace);
    still.name = 'ruinsprop_plant_still';
    this.mats.still = still;

    // ---- marks -------------------------------------------------------------
    this.mats.marks = new THREE.MeshStandardMaterial({
      map: this.tex.marks || null, color: 0xffffff,
      roughness: 0.94, metalness: 0.0,
      transparent: true, depthWrite: false, alphaTest: 0.03,
      side: THREE.DoubleSide, vertexColors: true,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
    });
    this.mats.marks.name = 'ruinsprop_marks';

    // ---- flame -------------------------------------------------------------
    // Dark albedo, hot emissive. postfx's veiling bloom is what turns this
    // into a source; a bright albedo would only be a pale blob.
    this.mats.flame = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(0x241206, THREE.SRGBColorSpace),
      emissive: new THREE.Color().setHex(0xFFA54A, THREE.SRGBColorSpace),
      roughness: 0.40, metalness: 0.0, side: THREE.DoubleSide
    });
    this.mats.flame.name = 'ruinsprop_flame';

    // WHITE AT 0.30 WAS FAR TOO MUCH. This is an unlit basic material, so its
    // colour goes straight to the print: over a frame whose 99th percentile is
    // 0.59, a white plume at 0.30 x 0.55 texture alpha rendered as a pale
    // BLUE-WHITE COLUMN four metres tall standing in mid-air over the looters'
    // camp - the most conspicuous thing in the hero1 framing and completely
    // unreadable as smoke. A bed of embers under a tarp at dawn makes a thin
    // grey thread, so the colour is now a dim warm grey and the opacity a
    // third of what it was.
    this.mats.smoke = new THREE.MeshBasicMaterial({
      map: this.tex.smoke || null, color: 0x6b665c,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      opacity: 0.11, fog: true, toneMapped: true
    });
    this.mats.smoke.name = 'ruinsprop_smoke';
  };

  // ==========================================================================
  // READING THE LEVEL
  //
  // Everything downstream resolves against level.anchors, which LevelRuins
  // publishes from its CONSTRUCTOR - so it is already there when this runs and
  // no prop ever has to look at a camera pose. If the anchors are missing the
  // level failed to survey itself, and the honest response is to place nothing
  // rather than to guess metres.
  // ==========================================================================
  PropsRuins.prototype._readLevel = function () {
    var lv = this.ctx && this.ctx.level;
    this.A = (lv && lv.anchors) || null;
    this._ok = !!(this.A && this.A.gallery && this.A.terrace && this.A.site);
    if (!this._ok) {
      GAME.logError('propsR.anchors',
        'level published no anchors; props place nothing rather than guess coordinates');
      return;
    }
    if (this.A.site.sunDir) this._sun.copy(this.A.site.sunDir).normalize();

    // ---- ground ------------------------------------------------------------
    // Probed ONCE. A try/catch around a function called forty thousand times
    // during placement is real boot cost, and a sampleGround that throws on
    // the first call will throw on all of them.
    var fn = null;
    if (lv && typeof lv.sampleGround === 'function') {
      try {
        var probe = lv.sampleGround(0, 0);
        if (typeof probe === 'number' && isFinite(probe)) {
          fn = function (x, z) { return lv.sampleGround(x, z); };
        }
      } catch (e) { GAME.logError('propsR.sampleGround', e); }
    }
    if (!fn) {
      var gy = this.A.site.groundY;
      if (typeof gy === 'function') { try { gy(0, 0); fn = gy; } catch (e2) { fn = null; } }
    }
    this._groundFn = fn || function () { return 0; };

    // ---- broadphase over the level's NON-FLOOR colliders --------------------
    // The floor slabs cover the whole site; treating them as obstacles would
    // reject every placement in the level.
    try {
      var cols = (lv && lv.colliders) || [];
      this._hash = new GAME.SpatialHash(4.0);
      var mn = new THREE.Vector3(), mx = new THREE.Vector3();
      for (var i = 0; i < cols.length; i++) {
        var c = cols[i];
        if (!c || c.floor || !c.halfExtents) continue;
        GAME.Collision.boxBounds(c, mn, mx);
        this._hash.insert(c, mn, mx);
      }
    } catch (e3) { GAME.logError('propsR.hash', e3); this._hash = null; }

    // ---- the apertures the level actually cut -------------------------------
    // level.lightShafts is the published contract for "here is a hole in the
    // roof". Growth, drifted litter and hanging root inside the gallery are
    // placed under these and NOWHERE else, because a fern in a sealed stone
    // corridor with no light and no rain is a fern nobody believes.
    this.shafts = [];
    try {
      var sh = (lv && lv.lightShafts) || [];
      for (var s = 0; s < sh.length; s++) {
        if (sh[s] && sh[s].origin) {
          this.shafts.push({
            x: sh[s].origin.x, y: sh[s].origin.y, z: sh[s].origin.z,
            w: sh[s].width || 2.0, kind: sh[s].kind || ''
          });
        }
      }
    } catch (e4) { GAME.logError('propsR.shafts', e4); }
  };

  PropsRuins.prototype._ground = function (x, z) {
    var y = this._groundFn(x, z);
    return (typeof y === 'number' && isFinite(y)) ? y : 0;
  };

  // Settle onto the surface: measure the gradient across the prop's OWN
  // footprint and rotate local up onto that normal.
  //
  // The clamp is load-bearing. sampleGround resolves BUILT PLATFORMS
  // analytically, so it steps 22 cm across a flagstone lip rather than ramping
  // - and an unclamped gradient sampled across such a lip would stand a water
  // jar on its rim at 60 degrees. Anything steeper than ~20 degrees is a step,
  // not a slope, and a prop settles onto the slope it can see.
  PropsRuins.prototype._settle = function (x, z, r, yaw) {
    r = Math.max(0.12, r || 0.4);
    var gx = (this._ground(x + r, z) - this._ground(x - r, z)) / (2 * r);
    var gz = (this._ground(x, z + r) - this._ground(x, z - r)) / (2 * r);
    gx = M.clamp(gx, -0.36, 0.36);
    gz = M.clamp(gz, -0.36, 0.36);
    _vn.set(-gx, 1, -gz).normalize();
    _qa.setFromAxisAngle(UP, yaw || 0);
    _qb.setFromUnitVectors(UP, _vn);
    return _qb.multiply(_qa);           // yaw first, then align to the ground
  };

  // Peak-to-peak ground height over a footprint. Used to reject sites that
  // straddle a step: a crate half on a flagstone platform and half off it
  // cannot be settled, only hidden.
  PropsRuins.prototype._step = function (x, z, r) {
    var lo = 1e9, hi = -1e9, i;
    var pts = [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r * 0.7, r * 0.7], [-r * 0.7, -r * 0.7]];
    for (i = 0; i < pts.length; i++) {
      var y = this._ground(x + pts[i][0], z + pts[i][1]);
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
    return hi - lo;
  };

  // Does level geometry already occupy this column?
  PropsRuins.prototype._blocked = function (x, z, r, hi) {
    if (!this._hash) return false;
    hi = hi === undefined ? 1.4 : hi;
    var gy = this._ground(x, z);
    _bmin.set(x - r, gy - 0.30, z - r);
    _bmax.set(x + r, gy + hi, z + r);
    var list;
    try { list = this._hash.query(_bmin, _bmax, _query); }
    catch (e) { return false; }
    for (var i = 0; i < list.length; i++) {
      var c = list[i], he = c.halfExtents, ce = c.center;
      if (Math.abs(ce.x - x) > he.x + r) continue;
      if (Math.abs(ce.z - z) > he.z + r) continue;
      if (ce.y + he.y < gy + 0.12) continue;       // buried under the floor
      if (ce.y - he.y > gy + hi) continue;         // a lintel overhead
      return true;
    }
    return false;
  };

  // Our own coarse occupancy, so two crates never land on each other.
  PropsRuins.prototype._claim = function (x, z, r) {
    var i0 = Math.floor(x - r), i1 = Math.floor(x + r);
    var j0 = Math.floor(z - r), j1 = Math.floor(z + r);
    var i, j;
    for (i = i0; i <= i1; i++) {
      for (j = j0; j <= j1; j++) if (this._occ.has(i * 4096 + j)) return false;
    }
    for (i = i0; i <= i1; i++) {
      for (j = j0; j <= j1; j++) this._occ.set(i * 4096 + j, 1);
    }
    return true;
  };

  // Is (x,z) on the worn walking line level_ruins published down the axis?
  // Grass does not grow where feet go, and this is the single cheapest way to
  // make growth read as "used place" instead of "scatter".
  var WORN_PATH = [
    [0.4, 54], [0.2, 46], [-0.3, 38], [0.1, 30], [0, 24], [0.2, 18],
    [-0.4, 12], [0.3, 6], [0, 2], [-0.2, -2], [0.1, -4], [0, -8], [0, -12]
  ];
  PropsRuins.prototype._pathDist = function (x, z) {
    var best = 1e9;
    for (var i = 0; i + 1 < WORN_PATH.length; i++) {
      var ax = WORN_PATH[i][0], az = WORN_PATH[i][1];
      var bx = WORN_PATH[i + 1][0], bz = WORN_PATH[i + 1][1];
      var dx = bx - ax, dz = bz - az;
      var l2 = dx * dx + dz * dz || 1;
      var t = M.clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
      var px = ax + dx * t - x, pz = az + dz * t - z;
      var d = Math.sqrt(px * px + pz * pz);
      if (d < best) best = d;
    }
    // plus the branch worn off the main line out to the camp
    if (this.A && this.A.camp) {
      var c = this.A.camp.centre;
      var ax2 = 0, az2 = -1.0, bx2 = c.x, bz2 = c.z;
      var dx2 = bx2 - ax2, dz2 = bz2 - az2;
      var l22 = dx2 * dx2 + dz2 * dz2 || 1;
      var t2 = M.clamp(((x - ax2) * dx2 + (z - az2) * dz2) / l22, 0, 1);
      var qx2 = ax2 + dx2 * t2 - x, qz2 = az2 + dz2 * t2 - z;
      best = Math.min(best, Math.sqrt(qx2 * qx2 + qz2 * qz2) + 1.2);
    }
    return best;
  };

  // How wet is this spot? Distance to the nearest published pool, which is
  // where fern, reed, moss and algae actually concentrate.
  PropsRuins.prototype._waterDist = function (x, z) {
    var pools = (this.A && this.A.pools) || [];
    var best = 1e9;
    for (var i = 0; i < pools.length; i++) {
      var p = pools[i];
      var dx = Math.max(p.x0 - x, 0, x - p.x1);
      var dz = Math.max(p.z0 - z, 0, z - p.z1);
      var d = Math.sqrt(dx * dx + dz * dz);
      if (d < best) best = d;
    }
    return best;
  };

  // ==========================================================================
  // Static-geometry builder. Same transform-stack shape level_ruins.js uses -
  // deliberately, so a reader moving between the two files is not learning a
  // second idiom for the same job.
  // ==========================================================================
  PropsRuins.prototype.top = function () { return this._stack[this._stack.length - 1]; };
  PropsRuins.prototype.pushM = function (m) {
    this._stack.push(new THREE.Matrix4().multiplyMatrices(this.top(), m));
    return this;
  };
  PropsRuins.prototype.pushT = function (x, y, z, rx, ry, rz, s) {
    return this.pushM(T(x, y, z, rx, ry, rz, s));
  };
  PropsRuins.prototype.pop = function () {
    if (this._stack.length > 1) this._stack.pop();
    return this;
  };
  PropsRuins.prototype.reset = function () {
    this._stack.length = 1;
    this._stack[0].identity();
    this.wear = null;
    return this;
  };
  PropsRuins.prototype.add = function (key, geo, local) {
    var arr = this.S[key] || (this.S[key] = []);
    var m = new THREE.Matrix4();
    if (local) m.multiplyMatrices(this.top(), local); else m.copy(this.top());
    var e = { geometry: geo, matrix: m, wear: this.wear };
    arr.push(e);
    return e;
  };
  PropsRuins.prototype.b = function (key, w, h, d, x, y, z, rx, ry, rz) {
    return this.add(key, box(w, h, d), T(x, y, z, rx, ry, rz));
  };
  PropsRuins.prototype.c = function (key, rt, rb, h, x, y, z, rx, ry, rz, radial) {
    return this.add(key, cyl(rt, rb, h, radial), T(x, y, z, rx, ry, rz));
  };
  PropsRuins.prototype.sp = function (key, r, x, y, z, sx, sy, sz, w, h) {
    return this.add(key, sph(r, w, h), T(x, y, z, 0, 0, 0, sx, sy, sz));
  };
  // A member between two points in the CURRENT frame - a bamboo pole, a rope,
  // a root, a tent line. "From here to there" is how these are described.
  PropsRuins.prototype.rod = function (key, ax, ay, az, bx, by, bz, r, radial) {
    var dx = bx - ax, dy = by - ay, dz = bz - az;
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-4) return null;
    _vn.set(dx / len, dy / len, dz / len);
    _qa.setFromUnitVectors(UP, _vn);
    _vp.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
    _vs.set(1, 1, 1);
    _m4.compose(_vp, _qa, _vs);
    return this.add(key, cyl(r, r, len, radial || 6), _m4);
  };
  // A slack line - rope, washing line, a strop under load. A straight rope is
  // a rope nobody has ever tied.
  PropsRuins.prototype.sag = function (key, ax, ay, az, bx, by, bz, sag, r, n) {
    n = n || 5;
    var px = ax, py = ay, pz = az, i;
    for (i = 1; i <= n; i++) {
      var t = i / n;
      var qx = M.lerp(ax, bx, t), qz = M.lerp(az, bz, t);
      var qy = M.lerp(ay, by, t) - sag * 4 * t * (1 - t);
      this.rod(key, px, py, pz, qx, qy, qz, r, 5);
      px = qx; py = qy; pz = qz;
    }
  };
  // A ground decal from the marks atlas, laid on the surface it stains.
  PropsRuins.prototype.mark = function (cell, x, z, w, d, yaw, tint) {
    var y = this._ground(x, z) + 0.020;
    var q = this._settle(x, z, w * 0.5, yaw || 0);
    _vp.set(x, y, z); _vs.set(1, 1, 1);
    _m4.compose(_vp, q, _vs);
    var save = this.wear;
    this.wear = tint || { grime: 1, wet: 1, edge: 1 };
    this.add('marks', flatCard(w, d, markUV(cell)), _m4);
    this.wear = save;
  };
  // A wall decal, faced along +Z of the given yaw.
  PropsRuins.prototype.markWall = function (cell, x, y, z, w, h, yaw, tint) {
    var save = this.wear;
    this.wear = tint || { grime: 1, wet: 1, edge: 1 };
    this.add('marks', card(w, h, markUV(cell)), T(x, y - h * 0.5, z, 0, yaw || 0, 0));
    this.wear = save;
  };

  PropsRuins.prototype.collider = function (x, y, z, hx, hy, hz, material, yaw) {
    var q = new THREE.Quaternion();
    if (yaw) q.setFromAxisAngle(UP, yaw);
    this.colliders.push({
      type: 'box',
      center: new THREE.Vector3(x, y, z),
      halfExtents: new THREE.Vector3(Math.abs(hx), Math.abs(hy), Math.abs(hz)),
      quaternion: q,
      material: material || 'stone'
    });
  };

  // ==========================================================================
  // Instanced batches. Placements are COLLECTED; the InstancedMesh is sized to
  // the collection in _commit(), so there is no cap to overflow.
  // ==========================================================================
  // EVERY instanced geometry MUST carry a `color` attribute.
  //
  // This is not a nicety. Both material families used here declare
  // vertexColors:true - the library's wear model needs it and our own foliage
  // multiply needs it - which sets USE_COLOR in the shader. three.js then
  // reads `attribute vec3 color`, and a geometry that does not supply one
  // leaves the generic attribute at its WebGL default of (0,0,0): vColor
  // becomes zero and the instance renders PURE BLACK. It is not an error,
  // nothing logs, the draw call count is right, and the first capture round
  // photographed two thousand ferns, every stone chip and all the leaf litter
  // as black confetti scattered over a lit courtyard.
  //
  // `wear` writes a real per-vertex mask on the way past - grime pooling at
  // the foot of the piece, pale chipped substrate on the arrises - so a stone
  // batch gets the same treatment the merged masonry gets in _paint.
  PropsRuins.prototype._ensureColor = function (geo, mode) {
    if (!geo || !geo.attributes || !geo.attributes.position) return geo;
    if (geo.attributes.color) return geo;
    var p = geo.attributes.position;
    var n = geo.attributes.normal;
    var c = new Float32Array(p.count * 3);
    if (mode !== 'wear') {
      for (var i = 0; i < c.length; i++) c[i] = 1;
      geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
      return geo;
    }
    geo.computeBoundingBox();
    var b = geo.boundingBox;
    var hx = Math.max(1e-3, (b.max.x - b.min.x) * 0.5);
    var hy = Math.max(1e-3, (b.max.y - b.min.y) * 0.5);
    var hz = Math.max(1e-3, (b.max.z - b.min.z) * 0.5);
    var cx = (b.max.x + b.min.x) * 0.5, cy = (b.max.y + b.min.y) * 0.5;
    var cz = (b.max.z + b.min.z) * 0.5;
    var noise = this.noise;
    for (var v = 0; v < p.count; v++) {
      var x = p.getX(v), y = p.getY(v), z = p.getZ(v);
      var ny = n ? n.getY(v) : 1;
      var low = 1 - M.saturate((y - b.min.y) / Math.max(0.05, b.max.y - b.min.y));
      var nv = noise.fbm3(x * 6.0, y * 6.0, z * 6.0, 3, 2.1, 0.55);
      // R grime: heaviest at the foot and on the undersides where it never
      // gets rained off
      var grime = 0.90 - low * 0.20 - M.saturate(-ny) * 0.10 + nv * 0.10;
      // G wetness: a loose stone lying on a courtyard is DRY on top and damp
      // underneath, and the wetness channel drops roughness, so up-faces stay
      // near 1 or the whole batch turns to wet plastic
      var wet = 0.99 - M.saturate(-ny * 0.5 + 0.5) * 0.16;
      // B edge wear: the arrises, which is where a fragment has been knocked
      var ex = Math.abs(x - cx) / hx, ey = Math.abs(y - cy) / hy, ez = Math.abs(z - cz) / hz;
      var nEdge = (ex > 0.80 ? 1 : 0) + (ey > 0.80 ? 1 : 0) + (ez > 0.80 ? 1 : 0);
      var edge = nEdge >= 2 ? 0.58 + nv * 0.20 : 0.90 + nv * 0.08;
      c[v * 3] = M.clamp(grime, 0.15, 1.2);
      c[v * 3 + 1] = M.clamp(wet, 0.15, 1.2);
      c[v * 3 + 2] = M.clamp(edge, 0.15, 1.2);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return geo;
  };

  PropsRuins.prototype.batch = function (kind, geo, mat, opts) {
    opts = opts || {};
    this._ensureColor(geo, opts.wear ? 'wear' : 'white');
    this.I[kind] = {
      geo: geo, mat: mat, list: [],
      cast: opts.cast !== false, recv: opts.recv !== false,
      order: opts.order || 0
    };
    return this.I[kind];
  };
  PropsRuins.prototype.put = function (kind, matrix, color) {
    var b = this.I[kind];
    if (!b) return false;
    b.list.push({ m: matrix.clone(), c: color ? color.clone() : null });
    return true;
  };
  // Settle an instance onto the ground at (x,z).
  PropsRuins.prototype.plant = function (kind, x, z, yaw, sx, sy, sz, foot, sink, color) {
    var q = this._settle(x, z, foot === undefined ? 0.35 : foot, yaw);
    _vp.set(x, this._ground(x, z) - (sink || 0), z);
    _vs.set(sx, sy === undefined ? sx : sy, sz === undefined ? (sy === undefined ? sx : sy) : sz);
    _m4.compose(_vp, q, _vs);
    return this.put(kind, _m4, color);
  };
  // Place an instance at an explicit height (a ledge, a wall cap, a pool
  // surface) with an explicit tilt.
  PropsRuins.prototype.putAt = function (kind, x, y, z, yaw, pitch, roll, sx, sy, sz, color) {
    return this.put(kind, T(x, y, z, pitch, yaw, roll, sx, sy, sz), color);
  };

  // Foliage instance colour. NOT a wear mask - this batch runs our own plain
  // multiply material - so it is free to carry real hue: dry yellow-green at
  // one end, deep shade green at the other, which is the only reason four
  // hundred copies of one fern card do not read as four hundred copies.
  PropsRuins.prototype.leafTint = function (rng, dry, out) {
    out = out || _tc;
    var v = rng.range(0.66, 1.14);
    var d = dry === undefined ? rng.next() : dry;
    out.setRGB(
      M.clamp(v * M.lerp(0.86, 1.20, d), 0.25, 1.5),
      M.clamp(v * M.lerp(1.00, 1.06, d), 0.25, 1.5),
      M.clamp(v * M.lerp(0.92, 0.62, d), 0.20, 1.5));
    return out;
  };
  // Stone instance colour IS a wear mask: R grime, G wetness, B edge wear,
  // white = pristine. Jitter only - the vertex mask underneath does the shape.
  PropsRuins.prototype.wearTint = function (rng, out) {
    out = out || _tc;
    out.setRGB(1 - rng.range(0, 0.22), 1 - rng.range(0, 0.09), 1 - rng.range(0, 0.24));
    return out;
  };

  // ==========================================================================
  // THE KIT
  //
  // One geometry per instanced batch. Variety inside a batch comes from three
  // places at once - per-instance yaw, per-instance non-uniform scale, and a
  // per-instance colour that is a real hue on foliage and a wear mask on stone
  // - because any one of them alone still reads as a stamped copy.
  // ==========================================================================
  PropsRuins.prototype._clump = function (rng, cell, n, w, h, opts) {
    opts = opts || {};
    var parts = [], i;
    var cells = Array.isArray(cell) ? cell : [cell];
    for (i = 0; i < n; i++) {
      var yaw = (i / n) * Math.PI * 2 + rng.range(-0.38, 0.38);
      var lean = (opts.lean === undefined ? 0.20 : opts.lean) * rng.range(0.35, 1.5);
      var cw = w * rng.range(0.76, 1.20), ch = h * rng.range(0.74, 1.22);
      var g = card(cw, ch, cellUV(cells[i % cells.length]),
        ch * (opts.bend === undefined ? 0.14 : opts.bend), !!opts.down);
      parts.push({
        geometry: g,
        matrix: Tn(rng.range(-w * 0.14, w * 0.14), opts.y0 || 0, rng.range(-w * 0.14, w * 0.14),
          opts.down ? rng.range(-0.10, 0.10) : lean, yaw, rng.range(-0.14, 0.14))
      });
    }
    var geo;
    try { geo = Geo.mergeAll(parts); }
    catch (e) { GAME.logError('propsR.clump', e); geo = parts[0].geometry; }
    for (i = 0; i < parts.length; i++) {
      if (parts[i].geometry !== geo) parts[i].geometry.dispose();
    }
    setFlex(geo, opts.down ? 'down' : 'up', h * 1.05);
    geo.computeBoundingSphere();
    return geo;
  };

  PropsRuins.prototype._flatKit = function (w, d, cellIdx) {
    var g = flatCard(w, d, cellUV(cellIdx));
    setFlex(g, 'up', 1);
    g.computeBoundingSphere();
    return g;
  };

  // A spalled fragment. A chip off a 900-year-old cornice is not a bevelled
  // box, and the entire difference is in the silhouette.
  PropsRuins.prototype._chip = function (rng, s, flat) {
    var g = box(s, s * (flat ? 0.34 : 0.66), s * rng.range(0.72, 1.05), s * 0.10).clone();
    roughen(g, this.noise, s * rng.range(0.10, 0.20), 1.7 / Math.max(0.08, s));
    g.computeBoundingSphere();
    return g;
  };

  PropsRuins.prototype._buildKit = function () {
    if (!this._ok) return;
    var rng = this.rng.fork ? this.rng.fork(0x4B17) : this.rng;
    var P = this.mats.plant, S = this.mats.still;

    // ---- understory --------------------------------------------------------
    this.batch('fernA', this._clump(rng, 0, 5, 0.95, 0.86, { lean: 0.26 }), P, { cast: true });
    this.batch('fernB', this._clump(rng, 1, 4, 0.72, 0.62, { lean: 0.30 }), P, { cast: false });
    this.batch('grassA', this._clump(rng, 2, 4, 0.62, 0.54, { lean: 0.16 }), P, { cast: false });
    this.batch('grassB', this._clump(rng, 3, 3, 0.48, 0.32, { lean: 0.22 }), P, { cast: false });
    this.batch('bigleaf', this._clump(rng, 4, 3, 1.75, 1.60, { lean: 0.34 }), P, { cast: true });
    this.batch('reed', this._clump(rng, 9, 4, 0.78, 1.10, { lean: 0.10 }), P, { cast: false });
    this.batch('sapling', this._clump(rng, 11, 3, 1.20, 1.60, { lean: 0.18 }), P, { cast: true });
    this.batch('flower', this._clump(rng, 14, 3, 1.30, 1.40, { lean: 0.24 }), P, { cast: false });
    this.batch('moss', this._clump(rng, 12, 2, 0.80, 0.26, { lean: 0.10 }), P, { cast: false });
    // hanging: the pivot is at the TOP and the card runs downward, so flex is
    // 1 at the free lower end
    this.batch('vine', this._clump(rng, 5, 2, 1.15, 2.70, { down: true, bend: 0.05 }), P, { cast: false });
    this.batch('aroot', this._clump(rng, 13, 2, 1.40, 2.30, { down: true, bend: 0.03 }), P, { cast: false });
    // a single flat card pressed against a wall face
    var cre = card(2.10, 2.50, cellUV(6), 0.05);
    setFlex(cre, 'up', 2.6);
    cre.computeBoundingSphere();
    this.batch('creeper', cre, P, { cast: false });

    // ---- lying flat, and therefore STILL ------------------------------------
    this.batch('lily', this._flatKit(1.80, 1.80, 7), S, { cast: false });
    this.batch('lotus', this._flatKit(1.35, 1.35, 8), S, { cast: false });
    this.batch('litter', this._flatKit(1.70, 1.70, 10), S, { cast: false });
    this.batch('straw', this._flatKit(1.05, 1.05, 15), S, { cast: false });

    // ---- stone ---------------------------------------------------------------
    this.batch('chip', this._chip(rng, 0.34), this._material('stone'), { cast: true, wear: 1 });
    this.batch('chipM', this._chip(rng, 0.42), this._material('mossy'), { cast: true, wear: 1 });
    this.batch('grit', this._chip(rng, 0.16, true), this._material('stone_d'), { cast: false, wear: 1 });
    this.batch('brick', this._chip(rng, 0.52), this._material('laterite'), { cast: true, wear: 1 });

    // A colonnette drum: the round shaft-section that falls out of a doorway
    // jamb when the lintel over it goes. Fluted, because a plain cylinder
    // reads as pipe.
    var drum = [];
    drum.push({ geometry: cyl(0.19, 0.20, 0.46, 12), matrix: Tn(0, 0, 0) });
    for (var f = 0; f < 8; f++) {
      var fa = f / 8 * Math.PI * 2;
      drum.push({
        geometry: box(0.055, 0.44, 0.055),
        matrix: Tn(Math.cos(fa) * 0.195, 0, Math.sin(fa) * 0.195, 0, -fa, 0)
      });
    }
    drum.push({ geometry: cyl(0.235, 0.225, 0.07, 12), matrix: Tn(0, 0.245, 0) });
    var dg;
    try { dg = Geo.mergeAll(drum); } catch (e) { dg = cyl(0.20, 0.20, 0.46, 10); }
    dg.computeBoundingSphere();
    this.batch('drum', dg, this._material('stone'), { cast: true, wear: 1 });

    // A DRESSED block off the collapsed library, squared up and numbered for
    // re-setting. Squared is the point: next to the level's spalled rubble, a
    // block with arrises still on it reads as "somebody worked on this".
    var yb = box(0.86, 0.42, 0.60, 0.022).clone();
    roughen(yb, this.noise, 0.014, 2.6);
    yb.computeBoundingSphere();
    this.batch('yblock', yb, this._material('stone'), { cast: true, wear: 1 });

    // Water jar - the storage jar that stands at every gallery corner in the
    // dry season. Terracotta, so it goes on the laterite recipe.
    var jar = lathe([[0.00, 0], [0.16, 0.0], [0.26, 0.10], [0.31, 0.26],
      [0.28, 0.44], [0.20, 0.56], [0.17, 0.62], [0.20, 0.66], [0.185, 0.70]], 12);
    jar.computeBoundingSphere();
    this.batch('jar', jar, this._material('laterite'), { cast: true, wear: 1 });

    // Galvanised bucket, dented.
    var bkt = [];
    bkt.push({ geometry: cyl(0.155, 0.115, 0.27, 10, true), matrix: Tn(0, 0.135, 0) });
    bkt.push({ geometry: cyl(0.116, 0.116, 0.015, 10), matrix: Tn(0, 0.008, 0) });
    bkt.push({ geometry: cyl(0.163, 0.163, 0.022, 10, true), matrix: Tn(0, 0.268, 0) });
    for (var hb = 0; hb < 5; hb++) {
      var ha = -0.35 + hb * 0.42;
      bkt.push({
        geometry: cyl(0.008, 0.008, 0.11, 4),
        matrix: Tn(Math.sin(ha) * 0.15, 0.30 + Math.cos(ha) * 0.055, 0, 0, 0, ha + 1.57)
      });
    }
    var bg;
    try { bg = Geo.mergeAll(bkt); } catch (e2) { bg = cyl(0.15, 0.12, 0.27, 8); }
    bg.computeBoundingSphere();
    this.batch('bucket', bg, this._material('metal'), { cast: true, wear: 1 });

    // A finds crate: slatted, so the gaps are part of the silhouette.
    var cr = [];
    cr.push({ geometry: box(0.66, 0.030, 0.46), matrix: Tn(0, 0.015, 0) });
    for (var cs = 0; cs < 4; cs++) {
      var cy2 = 0.06 + cs * 0.098;
      cr.push({ geometry: box(0.66, 0.070, 0.026), matrix: Tn(0, cy2, 0.222) });
      cr.push({ geometry: box(0.66, 0.070, 0.026), matrix: Tn(0, cy2, -0.222) });
      cr.push({ geometry: box(0.026, 0.070, 0.42), matrix: Tn(0.32, cy2, 0) });
      cr.push({ geometry: box(0.026, 0.070, 0.42), matrix: Tn(-0.32, cy2, 0) });
    }
    for (var cc = -1; cc <= 1; cc += 2) {
      cr.push({ geometry: box(0.040, 0.44, 0.040), matrix: Tn(cc * 0.315, 0.22, 0.215) });
      cr.push({ geometry: box(0.040, 0.44, 0.040), matrix: Tn(cc * 0.315, 0.22, -0.215) });
    }
    var cg;
    try { cg = Geo.mergeAll(cr); } catch (e3) { cg = box(0.66, 0.44, 0.46); }
    cg.computeBoundingSphere();
    this.batch('crate', cg, this._material('timber'), { cast: true, wear: 1 });

    // Survey stake: a squared peg with a painted band, driven at an angle.
    var stk = [];
    stk.push({ geometry: box(0.034, 0.62, 0.034), matrix: Tn(0, 0.31, 0) });
    stk.push({ geometry: box(0.042, 0.070, 0.042), matrix: Tn(0, 0.56, 0) });
    var sg;
    try { sg = Geo.mergeAll(stk); } catch (e4) { sg = box(0.034, 0.62, 0.034); }
    sg.computeBoundingSphere();
    this.batch('stake', sg, this._material('timber'), { cast: true, wear: 1 });
  };

  // ==========================================================================
  // STATUARY
  //
  // The hero pieces are MERGED, not instanced, and therefore all different.
  // Eight lions from one InstancedMesh is eight identical lions; at 700
  // triangles each the whole set costs less than a single fern batch, and the
  // one thing a temple cannot survive is symmetry it has not earned.
  // ==========================================================================

  // A singha - the squatting guardian lion at the foot of every Khmer stair.
  // `dmg` 0 intact .. 1 headless with its head in the dirt beside it.
  PropsRuins.prototype._lion = function (rng, x, z, yaw, sc, dmg) {
    var gy = this._ground(x, z);
    var q = this._settle(x, z, 0.8, yaw);
    _vp.set(x, gy, z); _vs.set(sc, sc, sc);
    this.reset();
    this.pushM(_m4.compose(_vp, q, _vs).clone());
    var i;
    this.wear = { grime: 0.66 + rng.range(-0.08, 0.10), wet: 0.94, edge: 0.62 };

    // plinth and moulding
    this.b('stone', 1.16, 0.36, 1.58, 0, 0.18, 0);
    this.b('stone', 1.30, 0.11, 1.72, 0, 0.415, 0);
    this.b('stone_d', 1.02, 0.10, 1.44, 0, 0.50, 0);
    // haunches
    for (i = -1; i <= 1; i += 2) {
      this.sp('stone', 0.33, i * 0.235, 0.80, 0.30, 0.98, 1.02, 1.30);
    }
    // body and chest
    this.b('stone', 0.60, 0.54, 0.92, 0, 0.90, 0.06);
    this.b('stone', 0.68, 0.66, 0.42, 0, 1.14, -0.30);
    // forelegs, paws, claws
    for (i = -1; i <= 1; i += 2) {
      this.c('stone', 0.105, 0.125, 0.76, i * 0.215, 0.66, -0.50, 0.07, 0, 0, 7);
      this.b('stone', 0.25, 0.14, 0.36, i * 0.215, 0.60 - 0.31, -0.60);
      for (var cl = -1; cl <= 1; cl++) {
        this.b('carve', 0.045, 0.05, 0.09, i * 0.215 + cl * 0.07, 0.27, -0.76);
      }
    }
    // tail up over the back
    this.rod('stone', 0.0, 1.06, 0.44, 0.16, 1.42, 0.56, 0.045, 5);
    this.rod('stone', 0.16, 1.42, 0.56, -0.02, 1.58, 0.40, 0.038, 5);

    if (dmg > 0.55) {
      // sheared neck, and the head lying where it fell
      this.wear = { grime: 0.58, wet: 0.90, edge: 0.48 };
      var stump = box(0.34, 0.16, 0.30, 0.02).clone();
      roughen(stump, this.noise, 0.035, 6);
      this.add('stone', stump, T(0, 1.44, -0.36, 0.1, 0.3, 0.06));
      this.pop(); this.reset();
      var hx = x + Math.sin(yaw + 1.9) * 1.35 * sc;
      var hz = z + Math.cos(yaw + 1.9) * 1.35 * sc;
      var hq = this._settle(hx, hz, 0.35, yaw + 2.4);
      _vp.set(hx, this._ground(hx, hz) + 0.16 * sc, hz); _vs.set(sc, sc, sc);
      this.pushM(_m4.compose(_vp, hq, _vs).clone());
      this.wear = { grime: 0.52, wet: 0.80, edge: 0.50 };
      this._lionHead(rng, 0, 0, 0, 0.55);
      this.pop(); this.reset();
      this.collider(hx, this._ground(hx, hz) + 0.22 * sc, hz, 0.28 * sc, 0.24 * sc, 0.28 * sc, 'stone');
    } else {
      this._lionHead(rng, 0, 1.62, -0.42, 1.0);
    }
    this.wear = null;
    this.pop(); this.reset();
    this.collider(x, gy + 1.0 * sc, z, 0.62 * sc, 1.0 * sc, 0.82 * sc, 'stone', yaw);
    this._claim(x, z, 1.1 * sc);
  };

  PropsRuins.prototype._lionHead = function (rng, ox, oy, oz, s) {
    var i;
    // the mane is the read: a ring of carved curls, not a smooth ball
    for (i = 0; i < 11; i++) {
      var a = i / 11 * Math.PI * 2;
      this.b('stone', 0.15 * s, 0.17 * s, 0.13 * s,
        ox + Math.cos(a) * 0.30 * s, oy + Math.sin(a) * 0.30 * s, oz + 0.10 * s,
        0, 0, a);
    }
    this.b('stone', 0.44 * s, 0.42 * s, 0.40 * s, ox, oy, oz);
    this.b('stone', 0.28 * s, 0.22 * s, 0.20 * s, ox, oy - 0.09 * s, oz - 0.24 * s);
    // brow, eyes, snarl - all in the dark carve surface so they survive being
    // lit by nothing but sky
    this.b('carve', 0.42 * s, 0.075 * s, 0.10 * s, ox, oy + 0.11 * s, oz - 0.19 * s);
    for (i = -1; i <= 1; i += 2) {
      this.b('carve', 0.10 * s, 0.085 * s, 0.07 * s, ox + i * 0.125 * s, oy + 0.03 * s, oz - 0.21 * s);
      this.b('stone', 0.115 * s, 0.15 * s, 0.09 * s, ox + i * 0.215 * s, oy + 0.20 * s, oz - 0.05 * s,
        0, 0, i * 0.25);
    }
    this.b('carve', 0.21 * s, 0.065 * s, 0.10 * s, ox, oy - 0.155 * s, oz - 0.30 * s);
    for (i = -1; i <= 1; i += 2) {
      this.b('stone', 0.035 * s, 0.055 * s, 0.035 * s, ox + i * 0.065 * s, oy - 0.14 * s, oz - 0.335 * s);
    }
    void rng;
  };

  // A dvarapala - the standing gate guardian, mace grounded, ~2.5 m on its
  // plinth. Two of them frame the gopura passage in hero3 and hero4.
  PropsRuins.prototype._dvarapala = function (rng, x, y, z, yaw, sc, headless) {
    this.reset();
    this.pushT(x, y, z, 0, yaw, 0, sc);
    var i;
    this.wear = { grime: 0.64 + rng.range(-0.06, 0.10), wet: 0.92, edge: 0.60 };
    // plinth
    this.b('stone', 1.06, 0.34, 0.94, 0, 0.17, 0);
    this.b('stone', 1.18, 0.10, 1.06, 0, 0.39, 0);
    // legs
    for (i = -1; i <= 1; i += 2) {
      this.c('stone', 0.125, 0.155, 0.80, i * 0.18, 0.84, 0, 0, 0, i * 0.02, 8);
      this.b('stone', 0.20, 0.11, 0.32, i * 0.18, 0.50, -0.06);
    }
    // sampot with a pleated apron - the silhouette that says "not a statue of
    // a man in trousers"
    this.c('stone', 0.30, 0.345, 0.62, 0, 1.52, 0, 0, 0, 0, 10);
    this.b('stone', 0.30, 0.52, 0.10, 0, 1.44, -0.30);
    for (i = -2; i <= 2; i++) {
      this.b('carve', 0.028, 0.48, 0.030, i * 0.058, 1.44, -0.355);
    }
    this.c('stone', 0.315, 0.315, 0.075, 0, 1.86, 0, 0, 0, 0, 10);
    // torso and shoulders
    this.c('stone', 0.255, 0.30, 0.60, 0, 2.20, 0, 0, 0, 0, 10);
    this.b('stone', 0.62, 0.20, 0.26, 0, 2.46, 0);
    for (i = -1; i <= 1; i += 2) this.sp('stone', 0.145, i * 0.30, 2.44, 0, 1, 1, 1);
    // necklace and armlets, deep-cut
    this.c('carve', 0.24, 0.24, 0.045, 0, 2.50, 0.02, 0, 0, 0, 10);
    for (i = -1; i <= 1; i += 2) this.c('carve', 0.10, 0.10, 0.04, i * 0.31, 2.26, 0, 0, 0, 0, 8);
    // right arm grounded on a mace, left hand on the hip
    this.rod('stone', 0.30, 2.40, 0.0, 0.36, 1.78, -0.10, 0.075, 6);
    this.rod('stone', 0.36, 1.78, -0.10, 0.34, 1.42, -0.16, 0.065, 6);
    this.c('stone', 0.055, 0.075, 1.30, 0.34, 0.98, -0.20, 0.05, 0, 0, 8);
    this.c('stone', 0.115, 0.085, 0.24, 0.34, 1.72, -0.16, 0.05, 0, 0, 8);
    this.sp('stone', 0.085, 0.34, 1.86, -0.16, 1, 1, 1);
    this.rod('stone', -0.30, 2.40, 0.0, -0.40, 1.94, 0.02, 0.072, 6);
    this.rod('stone', -0.40, 1.94, 0.02, -0.30, 1.74, -0.12, 0.062, 6);

    if (headless) {
      this.wear = { grime: 0.54, wet: 0.88, edge: 0.44 };
      var st = box(0.22, 0.12, 0.20, 0.015).clone();
      roughen(st, this.noise, 0.030, 8);
      this.add('stone', st, T(0, 2.60, 0, 0.12, 0.4, 0.08));
    } else {
      this.c('stone', 0.085, 0.095, 0.11, 0, 2.60, 0, 0, 0, 0, 8);
      this.sp('stone', 0.165, 0, 2.78, -0.01, 0.94, 1.08, 0.98);
      // face
      this.b('carve', 0.26, 0.055, 0.06, 0, 2.85, -0.14);
      for (i = -1; i <= 1; i += 2) {
        this.b('carve', 0.062, 0.042, 0.05, i * 0.070, 2.80, -0.145);
        this.b('stone', 0.045, 0.13, 0.055, i * 0.165, 2.76, -0.02);   // long ears
      }
      this.b('stone', 0.055, 0.085, 0.06, 0, 2.765, -0.155);
      this.b('carve', 0.10, 0.030, 0.05, 0, 2.695, -0.155);
      // conical crown
      this.c('stone', 0.055, 0.175, 0.30, 0, 3.02, -0.01, 0, 0, 0, 8);
      this.c('carve', 0.185, 0.185, 0.035, 0, 2.90, -0.01, 0, 0, 0, 8);
      this.sp('stone', 0.045, 0, 3.19, -0.01, 1, 1.3, 1);
    }
    this.wear = null;
    this.pop(); this.reset();
    this.collider(x, y + 1.3 * sc, z, 0.55 * sc, 1.3 * sc, 0.52 * sc, 'stone', yaw);
    this._claim(x, z, 0.9 * sc);
  };

  // A seated Buddha, wrapped in saffron. THE image of this place, and the
  // level's only saturated colour.
  PropsRuins.prototype._buddha = function (rng, x, y, z, yaw, sc) {
    this.reset();
    this.pushT(x, y, z, 0, yaw, 0, sc);
    var i;
    this.wear = { grime: 0.62, wet: 0.90, edge: 0.58 };
    // plinth, moulded
    this.b('stone', 1.72, 0.44, 1.26, 0, 0.22, 0);
    this.b('stone', 1.86, 0.12, 1.40, 0, 0.50, 0);
    this.b('stone_d', 1.60, 0.26, 1.14, 0, 0.69, 0);
    this.b('stone', 1.80, 0.10, 1.32, 0, 0.87, 0);
    // lotus throne
    this.add('stone', lathe([[0.60, 0], [0.70, 0.05], [0.66, 0.14], [0.52, 0.22]], 14),
      T(0, 0.92, 0));
    for (i = 0; i < 14; i++) {
      var pa = i / 14 * Math.PI * 2;
      this.b('stone', 0.17, 0.10, 0.12,
        Math.cos(pa) * 0.60, 1.00, Math.sin(pa) * 0.60, 0.42, -pa, 0);
    }
    // crossed legs, feet, hands in the lap
    this.b('stone', 1.02, 0.30, 0.66, 0, 1.29, 0.02);
    for (i = -1; i <= 1; i += 2) {
      this.c('stone', 0.115, 0.135, 0.62, i * 0.22, 1.30, -0.12, 0, 1.57 * i, 1.35, 8);
      this.b('stone', 0.20, 0.09, 0.13, -i * 0.10, 1.44, -0.16, 0.2, 0, 0);
    }
    this.b('stone', 0.40, 0.10, 0.24, 0, 1.49, -0.10);
    this.b('carve', 0.30, 0.035, 0.16, 0, 1.55, -0.12);
    // torso
    this.c('stone', 0.28, 0.345, 0.58, 0, 1.72, -0.02, 0, 0, 0, 12);
    this.b('stone', 0.60, 0.19, 0.26, 0, 1.98, -0.02);
    for (i = -1; i <= 1; i += 2) {
      this.sp('stone', 0.145, i * 0.285, 1.96, -0.02, 1, 1, 1);
      this.rod('stone', i * 0.285, 1.94, -0.02, i * 0.245, 1.58, -0.14, 0.078, 7);
    }
    // head
    this.c('stone', 0.085, 0.10, 0.12, 0, 2.11, -0.02, 0, 0, 0, 8);
    this.sp('stone', 0.185, 0, 2.31, -0.025, 0.94, 1.10, 0.98);
    // the hair curls are the silhouette; without them a Buddha is a snowman
    for (i = 0; i < 12; i++) {
      var ha = i / 12 * Math.PI * 2;
      this.sp('stone', 0.043, Math.cos(ha) * 0.155, 2.30 + Math.sin(ha) * 0.04,
        -0.025 + Math.sin(ha) * 0.155, 1, 1, 1, 5, 4);
    }
    this.sp('stone', 0.10, 0, 2.48, -0.025, 1, 1.1, 1);
    this.sp('stone', 0.05, 0, 2.585, -0.025, 1, 1.4, 1);
    // features - dark by albedo, so they hold at 20 m in flat sky light
    this.b('carve', 0.255, 0.045, 0.05, 0, 2.375, -0.185);
    for (i = -1; i <= 1; i += 2) {
      this.b('carve', 0.060, 0.030, 0.04, i * 0.070, 2.330, -0.190);
      this.b('stone', 0.042, 0.155, 0.055, i * 0.180, 2.290, -0.045);
    }
    this.b('stone', 0.050, 0.085, 0.055, 0, 2.305, -0.195);
    this.b('carve', 0.090, 0.026, 0.045, 0, 2.235, -0.195);

    // ---- the saffron -------------------------------------------------------
    // Built as a garment, not as a coat of paint. The first pass laid one box
    // across the shoulder and one along the plinth and both read as flat
    // orange planks stuck to the stone: cloth is only legible when it FOLDS,
    // so the sash is a chain of short segments stepping down the torso and the
    // robe is a run of vertical folds of unequal width.
    this.wear = { grime: 0.86, wet: 0.96, edge: 0.94 };
    // The sash runs OVER the left shoulder and diagonally DOWN THE CHEST to
    // the right hip. Both numbers that matter here were wrong first time and
    // both were wrong for the same reason - the cloth was authored where the
    // maths was convenient rather than against the body it is worn on. The
    // shoulder pad sat at y 2.05, which is chin height, so it read as a plank
    // held under the statue's jaw; and the plinth fall sat at z 0.365, which
    // is INSIDE the 1.26 m deep plinth, so all that showed was a sliver of
    // orange squeezed out of a stone joint.
    var sn = 7;
    for (i = 0; i < sn; i++) {
      var st = i / (sn - 1);
      // torso is a cone from r 0.345 at the waist to r 0.28 at the shoulders,
      // so the band has to move OUT as it goes down or it sinks into the chest
      var sr = -0.30 - st * 0.045;
      this.b('saffron', 0.165, 0.155, 0.085,
        M.lerp(-0.235, 0.175, st), M.lerp(1.955, 1.415, st), sr + st * 0.055,
        0, 0, 0.66);
    }
    // THE ROLL OVER THE SHOULDER.
    //
    // Round two made this ONE 24 cm box with the default 1.4 cm bevel, sitting
    // square-on to the light. At 3 m that is a flat parallelogram whose whole
    // face takes the key at the same angle, so it had a single value across it
    // and a terminator one pixel wide - the tell that read as a rendering
    // fault rather than as cloth. Cloth is legible because it FOLDS: four
    // overlapping segments, each rotated a little differently about all three
    // axes, present four different angles to the key, so the roll carries a
    // gradient down its length and its terminator is spread over a centimetre
    // of geometry instead of over one pixel. The whole roll is also rotated so
    // it takes the light at a grazing angle rather than square-on.
    var rollN = 4;
    for (i = 0; i < rollN; i++) {
      var rt2 = i / (rollN - 1);
      this.b('saffron', 0.145, 0.115 - rt2 * 0.018, 0.150,
        M.lerp(-0.320, -0.205, rt2), M.lerp(2.000, 1.930, rt2),
        M.lerp(-0.095, 0.055, rt2),
        M.lerp(-0.34, 0.14, rt2), M.lerp(0.55, 0.18, rt2),
        0.46 - rt2 * 0.30);
    }
    // and the end of it hanging free off the back of the shoulder, which is
    // what gives the roll a silhouette instead of an outline
    this.b('saffron', 0.125, 0.115, 0.090, -0.330, 1.865, -0.060, 0.12, 0.30, -0.22);
    this.b('saffron', 0.105, 0.145, 0.070, -0.338, 1.745, -0.020, 0.20, 0.22, -0.30);
    this.b('saffron', 0.085, 0.100, 0.055, -0.330, 1.630, 0.020, 0.28, 0.10, -0.36);
    // the robe swagged over the lap
    this.b('saffron', 1.02, 0.15, 0.62, 0, 1.215, 0.03);
    this.b('saffron', 0.90, 0.12, 0.19, 0, 1.295, 0.285, 0.22, 0, 0);
    // an offering cloth laid over the plinth top and hanging down its front.
    // z 0.605 is the only band that works: it clears the recessed course at
    // 0.57 and tucks under the oversailing one at 0.66.
    // The top run is broken into three panels with their own lie, so the
    // horizontal face - which is the one that takes most of the skylight and
    // was the second brightest flat plane on the statue - is not one plate at
    // one value.
    for (i = -1; i <= 1; i++) {
      this.b('saffron', 0.42, 0.028, 0.33, i * 0.415, 0.947 + Math.abs(i) * 0.004,
        0.478 + i * 0.006, i * 0.035, i * 0.05, i * 0.028);
    }
    var fw = [0.21, 0.14, 0.25, 0.12, 0.20, 0.16, 0.22];
    var fx0 = -0.66;
    for (i = 0; i < fw.length; i++) {
      var fd = 0.20 + (i % 3) * 0.09;
      // each fold leans a little differently in Z as well as Y - a fold that
      // only varies in width still presents one flat plane to the key
      this.b('saffron', fw[i], fd, 0.045,
        fx0 + fw[i] * 0.5, 0.935 - fd * 0.5, 0.605 + (i % 2) * 0.016,
        0.03, (i - 3) * 0.055, (i - 3) * 0.030);
      // the hem, ragged and lifting off the stone
      this.b('saffron', fw[i] * 0.92, 0.065, 0.042,
        fx0 + fw[i] * 0.5, 0.935 - fd - 0.02, 0.615 + (i % 2) * 0.016,
        0.15, (i - 3) * 0.070, (i - 3) * 0.045);
      fx0 += fw[i] + 0.006;
    }
    this.wear = null;
    this.pop(); this.reset();
    this.collider(x, y + 1.1 * sc, z, 0.9 * sc, 1.1 * sc, 0.7 * sc, 'stone', yaw);
    this._claim(x, z, 1.4 * sc);
    void rng;
  };

  // A devata relief panel, prised off a wall and stood against something. The
  // figure is built as thin raised layers rather than modelled in the round,
  // which is what a relief IS and is also why it costs 40 triangles.
  PropsRuins.prototype._reliefPanel = function (rng, x, z, yaw, w, h, lean) {
    var gy = this._ground(x, z);
    var q = this._settle(x, z, w * 0.5, yaw);
    _vp.set(x, gy, z); _vs.set(1, 1, 1);
    this.reset();
    this.pushM(_m4.compose(_vp, q, _vs).clone());
    this.pushT(0, 0, 0, lean, 0, 0);
    this.wear = { grime: 0.60 + rng.range(-0.08, 0.10), wet: 0.90, edge: 0.56 };
    this.b('stone', w, h, 0.20, 0, h * 0.5, 0);
    // framing pilasters
    for (var s = -1; s <= 1; s += 2) {
      this.b('stone', 0.085, h * 0.92, 0.26, s * (w * 0.5 - 0.06), h * 0.48, 0.02);
    }
    this.b('carve', w * 0.86, 0.055, 0.24, 0, h * 0.94, 0.01);
    // the figure
    var cy = h * 0.46;
    this.b('stone', w * 0.30, h * 0.30, 0.10, 0, cy - h * 0.16, -0.13);   // hips / sampot
    this.b('stone', w * 0.24, h * 0.24, 0.10, 0, cy + h * 0.10, -0.13);   // torso
    this.sp('stone', w * 0.10, 0, cy + h * 0.28, -0.14, 1, 1.1, 0.8);      // head
    this.b('carve', w * 0.16, 0.030, 0.06, 0, cy + h * 0.305, -0.185);     // brow
    this.c('stone', w * 0.045, w * 0.10, h * 0.14, 0, cy + h * 0.40, -0.14, 0, 0, 0, 7); // crown
    for (var a = -1; a <= 1; a += 2) {
      this.rod('stone', a * w * 0.12, cy + h * 0.20, -0.14,
        a * w * 0.26, cy + h * 0.02, -0.14, w * 0.035, 5);
      this.rod('stone', a * w * 0.11, cy - h * 0.28, -0.13,
        a * w * 0.09, cy - h * 0.46, -0.12, w * 0.045, 5);
    }
    this.b('carve', w * 0.26, 0.030, 0.05, 0, cy + h * 0.20, -0.185);      // necklace
    this.wear = null;
    this.pop(); this.pop(); this.reset();
    this.collider(x, gy + h * 0.5, z, w * 0.5, h * 0.5, 0.24, 'stone', yaw);
    this._claim(x, z, Math.max(w, 0.8) * 0.6);
  };

  // The seven-headed naga hood off the head of a balustrade. level_ruins
  // builds the ones still standing; this is the one that came down.
  PropsRuins.prototype._nagaHood = function (rng, x, z, yaw, sc, fallen) {
    var gy = this._ground(x, z);
    var q = this._settle(x, z, 0.7, yaw);
    _vp.set(x, gy, z); _vs.set(sc, sc, sc);
    this.reset();
    this.pushM(_m4.compose(_vp, q, _vs).clone());
    if (fallen) this.pushT(0, 0.30, 0, 1.42, 0, 0.22);
    else this.pushT(0, 0, 0);
    this.wear = { grime: 0.62 + rng.range(-0.08, 0.08), wet: 0.86, edge: 0.54 };
    this.b('stone', 0.80, 0.34, 0.90, 0, 0.17, 0.10);
    this.c('stone', 0.20, 0.30, 0.80, 0, 0.60, 0.06, 0, 0, 0, 10);
    for (var f = -3; f <= 3; f++) {
      var fa = f * 0.29;
      var lean = Math.abs(f) * 0.075;
      this.b('stone', 0.19, 0.86, 0.13,
        Math.sin(fa) * 0.52, 1.28 - lean * 0.5, -Math.abs(f) * 0.045,
        -0.12, 0, fa * 0.92);
      this.b('stone', 0.22, 0.20, 0.24,
        Math.sin(fa) * 0.72, 1.70 - lean, -Math.abs(f) * 0.06,
        -0.28, 0, fa * 0.92);
      this.b('carve', 0.16, 0.05, 0.08,
        Math.sin(fa) * 0.76, 1.68 - lean, -Math.abs(f) * 0.06 - 0.10,
        -0.28, 0, fa * 0.92);
      // the crest scallops between the hoods
      if (f < 3) {
        this.b('stone', 0.07, 0.22, 0.07,
          Math.sin(fa + 0.145) * 0.62, 1.50 - lean, -Math.abs(f) * 0.05,
          -0.2, 0, (fa + 0.145) * 0.92);
      }
    }
    this.wear = null;
    this.pop(); this.pop(); this.reset();
    this.collider(x, gy + (fallen ? 0.35 : 0.9) * sc, z,
      0.8 * sc, (fallen ? 0.35 : 0.9) * sc, 0.7 * sc, 'stone', yaw);
    this._claim(x, z, 1.0 * sc);
  };

  PropsRuins.prototype._dressStatuary = function () {
    if (!this._ok) return;
    var A = this.A;
    var rng = this.rng.fork ? this.rng.fork(0x5747) : this.rng;

    // ---- the gate guardians -------------------------------------------------
    // Flanking the gopura passage on its SOUTH face, which is what the player
    // walks into off the causeway and what closes the vista in hero3.
    var G = A.gopura;
    if (G && G.passage) {
      var pz = G.passage.z0 - 0.55;
      this._dvarapala(rng, -2.75, G.floorY, pz, 0, 0.92, false);
      this._dvarapala(rng, 2.75, G.floorY, pz, 0, 0.92, true);      // this one lost its head
    }

    // ---- lions at the head of the causeway ---------------------------------
    var C = A.causeway;
    if (C) {
      var hz = C.z1 - 2.6;
      this._lion(rng, C.nagaL - 1.35, hz, -0.28, 0.96, 0);
      this._lion(rng, C.nagaR + 1.35, hz, 0.24, 0.96, 0.8);         // toppled head
    }

    // ---- lions at the top of the great stair -------------------------------
    var TR = A.terrace;
    if (TR && TR.stair && TR.tiers && TR.tiers.length) {
      var head = TR.stair.head;
      this._lion(rng, head.x - (TR.stair.half + 1.15), head.z + 0.9, Math.PI + 0.10, 0.80, 0);
      this._lion(rng, head.x + (TR.stair.half + 1.15), head.z + 0.9, Math.PI - 0.12, 0.80, 0);
    }

    // ---- THE BUDDHA --------------------------------------------------------
    // On the courtyard side of the east colonnade, at the lip of the standing
    // water in the north-east pool so it doubles in the reflection, facing out
    // across the courtyard. Everything about the position is the pool: it is
    // the brightest surface in the level and this is the only object placed to
    // be seen twice.
    var pool = null, i;
    for (i = 0; i < (A.pools || []).length; i++) {
      if (A.pools[i].name === 'court_ne') pool = A.pools[i];
    }
    // Just inside the east colonnade with the standing water on its left and
    // its face turned WEST-NORTH-WEST - which is the sun's own bearing at
    // this hour, so the one carved face in the level that has to read is also
    // the only one taking the key directly instead of skylight.
    var bx = pool ? pool.x1 + 2.9 : 24.4;
    var bz = pool ? (pool.z0 + pool.z1) * 0.5 - 0.5 : -17.6;
    this._buddhaPos = { x: bx, z: bz };
    this._buddha(rng, bx, this._ground(bx, bz), bz, 0.95, 1.15);

    // ---- reliefs prised off the walls and stood up --------------------------
    var GA = A.gallery;
    if (GA && GA.corridorMid) {
      // one inside the south gallery, leaning on the outer wall - the interior
      // framing's mid-ground subject
      this._reliefPanel(rng, -11.4, GA.corridorMid.s + 1.10, Math.PI, 1.05, 1.95, -0.13);
      // one stacked with the yard's finds, one lying face-up in the courtyard
      this._reliefPanel(rng, 14.6, 9.4, -0.62, 0.95, 1.70, -0.16);
    }
    this.reset();
    this.wear = { grime: 0.56, wet: 0.82, edge: 0.52 };
    var lying = box(1.15, 0.19, 2.05, 0.02).clone();
    roughen(lying, this.noise, 0.020, 2.2);
    var lx = -5.9, lz = -1.4;
    var lq = this._settle(lx, lz, 0.9, 0.42);
    _vp.set(lx, this._ground(lx, lz) + 0.10, lz); _vs.set(1, 1, 1);
    this.add('stone', lying, _m4.compose(_vp, lq, _vs).clone());
    // a raised figure on it so it reads as a fallen relief, not a slab
    this.pushM(_m4.clone());
    this.b('stone', 0.30, 0.10, 0.60, 0, 0.13, -0.10);
    this.sp('stone', 0.115, 0, 0.16, -0.60, 1, 0.8, 1.1);
    this.b('carve', 0.19, 0.05, 0.035, 0, 0.20, -0.66);
    this.pop();
    this.wear = null;
    this.reset();
    this.collider(lx, this._ground(lx, lz) + 0.12, lz, 0.6, 0.14, 1.05, 'stone', 0.42);

    // ---- the naga hood that came off the causeway ---------------------------
    if (C) {
      this._nagaHood(rng, 2.20, C.z0 + 10.5, -1.15, 0.86, true);
      this._nagaHood(rng, 2.45, C.z0 + 3.2, -0.18, 0.80, false);
    }

    // ---- a linga and its yoni on the second terrace -------------------------
    if (TR && TR.tiers && TR.tiers[1]) {
      var t1 = TR.tiers[1];
      var yx = t1.x0 + 2.6, yz = t1.z1 - 2.4;
      this.reset(); this.pushT(yx, t1.y, yz, 0, 0.42, 0);
      this.wear = { grime: 0.60, wet: 0.86, edge: 0.62 };
      this.b('stone', 1.05, 0.26, 0.86, 0, 0.13, 0);
      this.b('stone', 0.92, 0.14, 0.74, 0, 0.33, 0);
      this.b('stone', 0.30, 0.13, 0.52, 0.44, 0.34, 0);       // the spout
      this.add('stone', lathe([[0.20, 0], [0.21, 0.22], [0.185, 0.34],
        [0.175, 0.46], [0.12, 0.56], [0, 0.58]], 10), T(0, 0.40, 0));
      this.wear = null;
      this.pop(); this.reset();
      this.collider(yx, t1.y + 0.5, yz, 0.55, 0.5, 0.45, 'stone');
      this._claim(yx, yz, 0.8);
    }
  };

  // ==========================================================================
  // A FLAME.
  //
  // Nothing here adds a LIGHT. level_ruins.js already publishes six practicals
  // - shrine lamps, three gallery lanterns, the camp brazier, the gopura
  // votive and the dig worklight - and it balanced the lit:unlit ratio of the
  // whole level against exactly those. What props add is more VISIBLE SOURCE
  // at the same coordinates: candle stubs and wicks that bloom, sitting in
  // fixtures that are themselves in frame. The inverse of "a light with no
  // visible source is not a light" is cheap and safe; a seventh point light
  // dropped into a solved rig is neither.
  // ==========================================================================
  PropsRuins.prototype._flame = function (x, y, z, s) {
    this.add('flame', lathe([[0.030 * s, 0], [0.042 * s, 0.05 * s],
      [0.022 * s, 0.12 * s], [0, 0.18 * s]], 6), T(x, y, z));
  };

  PropsRuins.prototype._candle = function (x, y, z, h, s) {
    // Recorded on props.practicalLights. lighting.js consumes the LEVEL's list
    // and never looks at this one - which is deliberate, because the level
    // balanced its own lit:unlit ratio and a prop file has no business adding
    // a seventh point light to a solved rig. What this publishes is the
    // inventory of visible sources props contributed, so anything auditing
    // "does every glow in this frame have an object under it" can check.
    this.practicalLights.push({
      name: 'prop_candle', kind: 'fire', pos: [x, y + h + 0.02, z],
      kelvin: 1900, intensity: 0, distance: 3.5, emissiveOnly: true
    });
    this.wear = { grime: 0.86, wet: 1, edge: 0.92 };
    this.c('cloth', 0.026 * s, 0.030 * s, h, x, y + h * 0.5, z, 0, 0, 0, 6);
    // wax that has run down the side and pooled - a candle with a clean shaft
    // has never been lit
    this.c('cloth', 0.040 * s, 0.046 * s, 0.020, x, y + 0.010, z, 0, 0, 0, 7);
    this.wear = null;
    this._flame(x, y + h + 0.012, z, s * 0.9);
  };

  // ==========================================================================
  // THE SHRINE  (anchors.shrine, on the top terrace beside the central prasat)
  //
  // level_ruins built the altar, five brass lamp bowls and the incense. This
  // adds what somebody LEFT there this morning, and the cloth tied round the
  // towers - which is the only saffron visible from the courtyard and
  // therefore the thing that makes hero1 a photograph of a living place
  // rather than of a monument.
  // ==========================================================================
  PropsRuins.prototype._dressShrine = function () {
    if (!this._ok || !this.A.shrine) return;
    var A = this.A, rng = this.rng.fork ? this.rng.fork(0x5348) : this.rng;
    var sh = A.shrine.centre, alt = A.shrine.altar;
    var ay = alt.y, i;

    this.reset();
    // ---- offerings on the altar slab ---------------------------------------
    // marigold garland, looped over the pedestal and trailing off the front
    this.wear = { grime: 0.90, wet: 1, edge: 0.96 };
    for (i = 0; i < 22; i++) {
      var ga = i / 22 * Math.PI * 2;
      this.sp('saffron', 0.032, sh.x + Math.cos(ga) * 0.26,
        ay + 0.06 + Math.sin(ga * 3) * 0.012, sh.z - 0.05 + Math.sin(ga) * 0.26, 1, 1, 1, 5, 4);
    }
    for (i = 0; i < 7; i++) {
      this.sp('saffron', 0.030, sh.x + 0.24 + i * 0.008,
        ay + 0.02 - i * 0.055, sh.z + 0.24 + i * 0.020, 1, 1, 1, 5, 4);
    }
    // banana-leaf offering plates with fruit
    for (i = -1; i <= 1; i++) {
      var px = sh.x + i * 0.46, pz = sh.z + 0.16;
      this.b('cloth', 0.24, 0.014, 0.20, px, ay + 0.012, pz, 0, rng.range(-0.4, 0.4), 0);
      this.sp('saffron', 0.045, px - 0.05, ay + 0.052, pz, 1, 0.85, 1, 6, 5);
      this.sp('cloth', 0.038, px + 0.05, ay + 0.046, pz + 0.03, 1, 1.2, 1, 6, 5);
    }
    this.wear = null;

    // candle stubs, and the wax and soot they have left
    this._candle(sh.x - 0.36, ay + 0.02, sh.z + 0.40, 0.11, 1.0);
    this._candle(sh.x - 0.10, ay + 0.02, sh.z + 0.43, 0.07, 1.0);
    this._candle(sh.x + 0.30, ay + 0.02, sh.z + 0.40, 0.13, 1.0);
    this.mark(0, sh.x, sh.z + 0.9, 1.5, 1.2, 0.3, { grime: 1, wet: 0.9, edge: 1 });

    // a bundle of joss sticks stood in a jar of sand
    this.wear = { grime: 0.70, wet: 1, edge: 0.78 };
    this.add('laterite', lathe([[0.00, 0], [0.075, 0], [0.090, 0.06],
      [0.078, 0.14], [0.085, 0.16]], 9), T(sh.x + 0.62, ay, sh.z + 0.06));
    this.wear = null;
    for (i = 0; i < 9; i++) {
      var ia = i / 9 * Math.PI * 2;
      this.rod('cloth', sh.x + 0.62, ay + 0.12, sh.z + 0.06,
        sh.x + 0.62 + Math.cos(ia) * 0.055, ay + 0.40 + rng.range(-0.05, 0.05),
        sh.z + 0.06 + Math.sin(ia) * 0.055, 0.0045, 4);
    }
    this.smokeEmitters.push({
      position: new THREE.Vector3(sh.x + 0.62, ay + 0.42, sh.z + 0.06),
      opts: { rate: 0.5, size: 0.20, rise: 0.22 }
    });

    // ---- the cloth on the terrace -------------------------------------------
    // Six saffron banners hung over the south lip of the three tiers.
    //
    // The first pass tied bands round the TOWERS instead, which was wrong for
    // a reason worth writing down: a prasat is a stepped, battered pyramid and
    // this file cannot query its taper, so a band drawn at the tower's nominal
    // half-width sat inside the moulding and only its four corners showed - a
    // few orange pixels on a 17 m tower. The terrace tiers are published
    // exactly (anchors.terrace.tiers), their facings stand at z = tier.z1, and
    // they are the surface that fills the middle of the courtyard framing. So
    // the cloth goes where the geometry is KNOWN and where the frame is empty.
    var TR = A.terrace;
    if (TR && TR.tiers) {
      for (i = 0; i < TR.tiers.length; i++) {
        var ti = TR.tiers[i];
        var stairHalf = (TR.stair ? TR.stair.half : 2.6) + 1.4;
        for (var sgn = -1; sgn <= 1; sgn += 2) {
          var bx = sgn * (stairHalf + 1.6 + i * 0.5 + rng.range(-0.3, 0.3));
          if (Math.abs(bx) > (ti.x1 - 0.8)) continue;
          var bz = ti.z1 + 0.05;
          var top = ti.y - 0.04;
          var drop = 1.15 + rng.range(0, 0.55);
          this.wear = { grime: 0.86, wet: 0.96, edge: 0.94 };
          // the roll of cloth lying over the lip, then the banner down the face
          this.b('saffron', 0.82, 0.16, 0.56, bx, top + 0.07, bz - 0.20);
          this.b('saffron', 0.74, drop, 0.05, bx, top - drop * 0.5, bz, 0.03, 0, rng.range(-0.05, 0.05));
          // the ragged, weighted hem
          this.b('saffron', 0.66, 0.18, 0.055, bx + rng.range(-0.06, 0.06),
            top - drop - 0.06, bz + 0.01, 0.10, 0, rng.range(-0.12, 0.12));
          // and a second, narrower streamer beside it
          this.b('saffron', 0.19, drop * 0.72, 0.04, bx + sgn * 0.44,
            top - drop * 0.36, bz + 0.01, 0.02, 0, rng.range(-0.16, 0.16));
          this.wear = null;
        }
      }
    }

    // The fallen corner tower is a plain frustum whose dimensions ARE
    // published, so that one can carry a real wrapped band.
    var towers = A.towers || [];
    for (i = 0; i < towers.length; i++) {
      var tw = towers[i];
      if (!tw.fallen) continue;
      var hw = tw.halfW * 0.98;
      var by = tw.baseY + (tw.apexY - tw.baseY) * 0.5;
      this.wear = { grime: 0.84, wet: 0.96, edge: 0.92 };
      this.b('saffron', hw * 2, 0.36, 0.05, tw.centre.x, by, tw.centre.z + hw);
      this.b('saffron', hw * 2, 0.36, 0.05, tw.centre.x, by, tw.centre.z - hw);
      this.b('saffron', 0.05, 0.36, hw * 2, tw.centre.x + hw, by, tw.centre.z);
      this.b('saffron', 0.05, 0.36, hw * 2, tw.centre.x - hw, by, tw.centre.z);
      this.sp('saffron', 0.13, tw.centre.x + hw * 0.4, by, tw.centre.z + hw + 0.04, 1, 0.9, 1.1);
      this.b('saffron', 0.16, 0.86, 0.045, tw.centre.x + hw * 0.4 - 0.11,
        by - 0.50, tw.centre.z + hw + 0.05, 0.05, 0, 0.10);
      this.wear = null;
    }
    this.reset();
  };

  // ==========================================================================
  // THE GALLERY INTERIOR
  //
  // The weakest frame in the level before dressing: forty metres of perfectly
  // clean corbelled corridor. Four things fix it, and every one of them is
  // motivated by something the level already built:
  //   * the roof came down in two bays, so the SLABS are on the floor under
  //     the holes and the rubble fans out from there,
  //   * those holes are the only places light and rain get in, so they are the
  //     only places anything GROWS,
  //   * the outer wall sheds, so spall banks along its foot the whole length,
  //   * and people walk the middle, so the litter is at the pillar bases and
  //     the wall foot and NOT down the centre line.
  // ==========================================================================
  PropsRuins.prototype._dressGallery = function () {
    if (!this._ok || !this.A.gallery) return;
    var A = this.A, G = A.gallery;
    var rng = this.rng.fork ? this.rng.fork(0x6741) : this.rng;
    var fy = G.floorY === undefined ? 0.28 : G.floorY;
    var roof = G.roofY === undefined ? 4.90 : G.roofY;
    var mid = G.corridorMid || { s: 3.51, n: -39.51, w: -27.51, e: 27.51 };
    var i, k, a;

    // ---- spall banked along the outer wall foot, all four runs -------------
    var runs = [
      { axis: 'x', a0: G.x0 + 3.0, a1: G.x1 - 3.0, wall: G.z1 - G.wallT, mid: mid.s, out: -1 },
      { axis: 'x', a0: G.x0 + 3.0, a1: G.x1 - 3.0, wall: G.z0 + G.wallT, mid: mid.n, out: 1 },
      { axis: 'z', a0: G.z0 + 3.0, a1: G.z1 - 3.0, wall: G.x0 + G.wallT, mid: mid.w, out: 1 },
      { axis: 'z', a0: G.z0 + 3.0, a1: G.z1 - 3.0, wall: G.x1 - G.wallT, mid: mid.e, out: -1 }
    ];
    for (k = 0; k < runs.length; k++) {
      var r = runs[k];
      var n = Math.round((r.a1 - r.a0) / 0.55);
      for (i = 0; i < n; i++) {
        a = r.a0 + (i + 0.5) * (r.a1 - r.a0) / n;
        // Density from noise along the wall, not uniform: a wall does not shed
        // at a constant rate, it sheds where its coursing has failed.
        var dens = M.saturate(this.noise.fbm2(a * 0.22 + k * 13.0, r.wall * 0.1, 3) * 1.5 + 0.42);
        if (!rng.bool(dens * 0.72)) continue;
        // debris lies AGAINST the obstacle and thins away from it
        var off = r.out * (0.18 + Math.abs(rng.gaussian(0, 0.34)));
        var x = r.axis === 'x' ? a + rng.range(-0.25, 0.25) : r.wall + off;
        var z = r.axis === 'x' ? r.wall + off : a + rng.range(-0.25, 0.25);
        var s = rng.range(0.30, 0.95) * (1.25 - Math.abs(off));
        this.putAt(rng.bool(0.24) ? 'chipM' : 'grit', x, fy + rng.range(-0.01, 0.03), z,
          rng.range(0, 6.283), rng.range(-0.30, 0.30), rng.range(-0.30, 0.30),
          s, s * rng.range(0.6, 1.0), s * rng.range(0.8, 1.2), this.wearTint(rng));
      }
      // and the drift of dry leaf that blows in and stops at the same wall
      for (i = 0; i < 26; i++) {
        a = rng.range(r.a0, r.a1);
        var lo = r.out * rng.range(0.12, 0.85);
        this.putAt('litter',
          r.axis === 'x' ? a : r.wall + lo, fy + 0.016, r.axis === 'x' ? r.wall + lo : a,
          rng.range(0, 6.283), 0, 0,
          rng.range(0.55, 1.15), 1, rng.range(0.55, 1.15), this.leafTint(rng, 0.95));
      }
    }

    // ---- leaf and grit collected at every pillar base ----------------------
    var pil = G.pillars || [];
    for (i = 0; i < pil.length; i++) {
      var p = pil[i];
      var pn = p.broken ? 5 : 3;
      for (k = 0; k < pn; k++) {
        var pa = rng.range(0, 6.283), pr2 = rng.range(0.28, 0.72);
        this.putAt('litter', p.x + Math.cos(pa) * pr2, fy + 0.014, p.z + Math.sin(pa) * pr2,
          rng.range(0, 6.283), 0, 0, rng.range(0.45, 0.85), 1, rng.range(0.45, 0.85),
          this.leafTint(rng, 0.9));
      }
      if (p.broken || rng.bool(0.18)) {
        this.putAt('grit', p.x + rng.range(-0.55, 0.55), fy + 0.01, p.z + rng.range(-0.55, 0.55),
          rng.range(0, 6.283), rng.range(-0.2, 0.2), rng.range(-0.2, 0.2),
          rng.range(0.5, 1.2), rng.range(0.4, 0.9), rng.range(0.6, 1.2), this.wearTint(rng));
      }
    }

    // ---- what came through the roof ----------------------------------------
    // Under each published shaft: the corbel slabs that fell, a fan of rubble,
    // hanging root through the hole, and the one patch of green in the whole
    // colonnade.
    var sh = this.shafts || [];
    for (k = 0; k < sh.length; k++) {
      var S = sh[k];
      if (S.kind && S.kind.indexOf('gopura') === 0) continue;      // that one is a light well over paving
      var cx = S.x, cz = S.z;
      if (this._blocked(cx, cz, 0.4, 1.0)) continue;
      var gy = this._ground(cx, cz);

      // three corbel slabs, one leaning on the wall, one flat, one on edge
      this.reset();
      this.wear = { grime: 0.58, wet: 0.86, edge: 0.50 };
      var sl = box(1.55, 0.34, 0.92, 0.03).clone();
      roughen(sl, this.noise, 0.030, 1.6);
      var q1 = this._settle(cx - 0.4, cz + 0.3, 0.8, rng.range(0, 3.14));
      _vp.set(cx - 0.4, gy + 0.17, cz + 0.3); _vs.set(1, 1, 1);
      this.add('stone', sl, _m4.compose(_vp, q1, _vs).clone());
      var sl2 = box(1.30, 0.30, 0.80, 0.03).clone();
      roughen(sl2, this.noise, 0.028, 1.8);
      this.add('stone', sl2, T(cx + 0.85, gy + 0.62, cz - 0.25, 0.30, rng.range(0, 3), 0.92));
      var sl3 = box(1.05, 0.26, 0.72, 0.03).clone();
      roughen(sl3, this.noise, 0.026, 2.0);
      this.add('mossy', sl3, T(cx + 0.15, gy + 0.14, cz - 0.85, 0.06, rng.range(0, 3), 0.10));
      this.wear = null;
      this.reset();
      this.collider(cx - 0.4, gy + 0.20, cz + 0.3, 0.8, 0.22, 0.5, 'stone');
      this.collider(cx + 0.85, gy + 0.55, cz - 0.25, 0.5, 0.55, 0.5, 'stone');

      // the fan of rubble, thinning outward from the impact
      for (i = 0; i < 34; i++) {
        var ra = rng.range(0, 6.283);
        var rr = Math.abs(rng.gaussian(0, 1.35)) + 0.35;
        var rx2 = cx + Math.cos(ra) * rr, rz2 = cz + Math.sin(ra) * rr * 0.75;
        var s2 = rng.range(0.35, 1.05) * M.smoothstep(3.6, 0.5, rr);
        if (s2 < 0.12) continue;
        this.putAt(rng.bool(0.3) ? 'chip' : 'grit', rx2, this._ground(rx2, rz2) + 0.02, rz2,
          rng.range(0, 6.283), rng.range(-0.35, 0.35), rng.range(-0.35, 0.35),
          s2, s2 * rng.range(0.6, 1.0), s2 * rng.range(0.8, 1.2), this.wearTint(rng));
      }

      // Hanging root through the hole - the reason you look UP here. Kept
      // SHORT on purpose: the corridor soffit is 4.6 m and a player's eye is
      // at 1.9, so anything reaching below about 3 m stops being a curtain
      // seen against the light and becomes an obstacle hanging in your face.
      // A ROOT HANGING IN FRONT OF AN OPEN HOLE IS BACK-LIT, so it is a dark
      // silhouette, not a pale one. leafTint(0.75) is the DRY end of the leaf
      // ramp and multiplies up to (1.27, 1.19, 0.83) over an atlas cell that is
      // already a pale grey-tan rope: measured, this cluster came back brighter
      // than the lit masonry of the temple and read as a curtain of torn paper
      // hanging in the middle of the interior framing. Below the stone it reads
      // as what it is.
      for (i = 0; i < 5; i++) {
        _tc.setRGB(rng.range(0.34, 0.54), rng.range(0.32, 0.50), rng.range(0.28, 0.42));
        this.putAt('aroot', cx + rng.range(-0.9, 0.9), roof - 0.05, cz + rng.range(-0.8, 0.8),
          rng.range(0, 6.283), 0, 0, rng.range(0.55, 0.95), rng.range(0.34, 0.60), 1, _tc);
      }
      // and the green under it
      for (i = 0; i < 7; i++) {
        var fa2 = rng.range(0, 6.283), fr = Math.abs(rng.gaussian(0, 1.1)) + 0.4;
        var fx = cx + Math.cos(fa2) * fr, fz = cz + Math.sin(fa2) * fr;
        if (this._blocked(fx, fz, 0.10, 0.8)) continue;
        this.plant(rng.bool(0.55) ? 'fernB' : 'grassB', fx, fz, rng.range(0, 6.283),
          rng.range(0.55, 1.0), rng.range(0.5, 0.95), rng.range(0.55, 1.0),
          0.3, 0.03, this.leafTint(rng, 0.25));
      }
      // wet ring and algae where the rain lands
      this.mark(3, cx, cz, 3.4, 2.8, rng.range(0, 3), { grime: 1, wet: 0.5, edge: 1 });
    }

    // ---- the south corridor, which is the published interior framing --------
    var cs = mid.s;
    // A ladder left against a pillar by whoever hung the lanterns.
    this.reset();
    this.wear = { grime: 0.66, wet: 0.94, edge: 0.72 };
    var lx = -6.6, lz = cs + 1.30, lh = 3.35;
    this.rod('timber', lx - 0.22, fy, lz + 0.55, lx - 0.22, fy + lh, lz - 0.18, 0.038, 5);
    this.rod('timber', lx + 0.22, fy, lz + 0.55, lx + 0.22, fy + lh, lz - 0.18, 0.038, 5);
    for (i = 0; i < 9; i++) {
      var t3 = (i + 0.5) / 9;
      this.rod('timber', lx - 0.22, fy + lh * t3, lz + 0.55 - 0.73 * t3,
        lx + 0.22, fy + lh * t3, lz + 0.55 - 0.73 * t3, 0.022, 4);
    }
    this.wear = null;
    this.reset();
    this.collider(lx, fy + lh * 0.5, lz + 0.2, 0.28, lh * 0.5, 0.45, 'wood');

    // A stone ledge of candle stubs under the leaning relief - the corridor's
    // own light, at the far end of a forty-metre tunnel.
    this.reset();
    this.wear = { grime: 0.64, wet: 0.92, edge: 0.68 };
    this.b('stone', 0.86, 0.16, 0.42, -10.2, fy + 0.30, cs + 1.05);
    this.b('stone', 0.30, 0.30, 0.30, -10.2, fy + 0.15, cs + 1.05);
    this.wear = null;
    this._candle(-10.46, fy + 0.38, cs + 1.02, 0.13, 1.0);
    this._candle(-10.20, fy + 0.38, cs + 1.08, 0.09, 1.0);
    this._candle(-9.92, fy + 0.38, cs + 1.00, 0.16, 1.0);
    this.mark(0, -10.2, cs + 1.05, 1.1, 0.9, 0, { grime: 1, wet: 1, edge: 1 });
    this.reset();

    // Broken colonnette drums, stacked where somebody moved them out of the way.
    var stack = [[-3.2, cs + 0.10], [-2.75, cs + 0.26], [-3.05, cs - 0.20], [-2.9, cs + 0.05]];
    for (i = 0; i < stack.length; i++) {
      var syy = fy + 0.24 + (i === 3 ? 0.47 : 0);
      this.putAt('drum', stack[i][0], syy, stack[i][1],
        rng.range(0, 6.283), i === 3 ? 0.06 : rng.range(-0.03, 0.03), rng.range(-0.03, 0.03),
        1, 1, 1, this.wearTint(rng));
    }
    this.collider(-3.0, fy + 0.5, cs + 0.05, 0.55, 0.5, 0.5, 'stone');
    for (i = 0; i < 4; i++) {
      this.putAt('drum', rng.range(6.0, 15.0), fy + 0.10, cs + rng.range(-1.1, 1.1),
        rng.range(0, 6.283), 1.55, rng.range(0, 3), 1, 1, 1, this.wearTint(rng));
    }

    // Water jars at the corridor corners, where the roof used to drain.
    var jars = [[-27.1, cs - 0.9], [-26.6, cs + 0.6], [27.0, cs - 0.6], [26.4, mid.n + 0.8]];
    for (i = 0; i < jars.length; i++) {
      var jx = jars[i][0], jz = jars[i][1];
      if (this._blocked(jx, jz, 0.3, 0.9) || this._step(jx, jz, 0.34) > 0.10) continue;
      this.plant('jar', jx, jz, rng.range(0, 6.283), rng.range(0.85, 1.15), 1, 1, 0.35,
        0.02, this.wearTint(rng));
      this.mark(3, jx, jz, 1.1, 1.1, rng.range(0, 3), { grime: 1, wet: 0.55, edge: 1 });
      this.collider(jx, fy + 0.35, jz, 0.32, 0.35, 0.32, 'stone');
    }

    // Bird lime down the vault and the pillars: bats and swifts live in a
    // corbelled roof, and nothing says "nobody has swept this in 40 years"
    // faster than the white streaks under the roosts.
    for (i = 0; i < 26; i++) {
      var bx2 = rng.range(G.x0 + 5, G.x1 - 5);
      var bz2 = cs + rng.range(-1.4, 1.4);
      this.mark(2, bx2, bz2, rng.range(0.8, 1.8), rng.range(0.8, 1.8), rng.range(0, 3),
        { grime: 1, wet: 1, edge: 1 });
    }
    for (i = 0; i < 14; i++) {
      var pi = pil[(rng.next() * pil.length) | 0];
      if (!pi) break;
      this.markWall(2, pi.x, fy + rng.range(1.8, 3.4), pi.z + 0.24,
        rng.range(0.35, 0.6), rng.range(0.8, 1.6), 0, { grime: 1, wet: 1, edge: 1 });
    }
  };

  // ==========================================================================
  // THE ANASTYLOSIS YARD  (outer court, beside the collapsed east library)
  //
  // Anastylosis is the method: take the ruin apart, NUMBER every block, lay it
  // out in order on sleepers, and put it back. It is the single most
  // recognisable thing on a working temple site and it is what turns the outer
  // courtyard from an empty apron into a place with a job.
  //
  // Placed against anchors.libraries (the ruined one) rather than at a
  // hand-picked coordinate, so if the library moves the yard follows it.
  // ==========================================================================
  PropsRuins.prototype._dressYard = function () {
    if (!this._ok) return;
    var A = this.A;
    var rng = this.rng.fork ? this.rng.fork(0x59A1) : this.rng;
    var lib = null, i, j;
    for (i = 0; i < (A.libraries || []).length; i++) {
      if ((A.libraries[i].ruin || 0) > 0.4) lib = A.libraries[i];
    }
    if (!lib) return;
    var cx = lib.centre.x - 5.4;                 // west of the collapsed library
    var cz = lib.centre.z - 3.2;                 // and south of it, clear of its rubble
    var gy = this._ground(cx, cz);

    // ---- rows of numbered blocks on timber sleepers -------------------------
    var rows = 3, per = 7;
    for (j = 0; j < rows; j++) {
      var rz = cz - 1.05 + j * 1.15;
      // the sleeper the row sits on
      this.reset();
      this.wear = { grime: 0.60, wet: 0.88, edge: 0.70 };
      var sx0 = cx - per * 0.52, sx1 = cx + per * 0.52;
      this.rod('timber', sx0, gy + 0.055, rz, sx1, gy + 0.055, rz, 0.055, 5);
      this.wear = null;
      this.reset();
      for (i = 0; i < per; i++) {
        var bxp = sx0 + 0.52 + i * 1.04 + rng.range(-0.05, 0.05);
        // the last row is unfinished - two gaps where blocks are still to come
        if (j === rows - 1 && (i === 2 || i === 5)) continue;
        if (this._step(bxp, rz, 0.50) > 0.12) continue;
        var yaw = rng.range(-0.05, 0.05);
        this.plant('yblock', bxp, rz, yaw, rng.range(0.94, 1.08), rng.range(0.9, 1.06),
          rng.range(0.94, 1.08), 0.5, -0.11, this.wearTint(rng));
        // the chalked number on the top face, which is the whole point
        this.mark(1, bxp, rz + rng.range(-0.08, 0.08), 0.60, 0.42,
          rng.range(-0.25, 0.25), { grime: 1, wet: 1, edge: 1 });
        this._claim(bxp, rz, 0.5);
      }
      this.collider(cx, gy + 0.22, rz, per * 0.55, 0.24, 0.32, 'stone');
    }

    // ---- the bamboo shear-leg gantry, with a block slung in a strop ---------
    // Two legs lashed at the head, a back-stay, a rope through a timber
    // sheave. It is how a two-tonne block gets lifted with no crane, and it is
    // the only thing in the outer court taller than a man.
    var gx = cx - 1.2, gz = cz + 3.6;
    var ggy = this._ground(gx, gz);
    var apex = ggy + 4.35;
    this.reset();
    this.wear = { grime: 0.56, wet: 0.90, edge: 0.86 };
    this.rod('bamboo', gx - 1.55, ggy, gz + 0.55, gx - 0.10, apex, gz - 0.18, 0.075, 7);
    this.rod('bamboo', gx + 1.55, ggy, gz + 0.55, gx + 0.10, apex, gz - 0.18, 0.075, 7);
    this.rod('bamboo', gx, ggy + 1.35, gz + 0.62, gx, ggy + 1.35, gz + 0.62, 0.05, 5);
    // cross-brace and back-stay
    this.rod('bamboo', gx - 1.05, ggy + 1.60, gz + 0.30, gx + 1.05, ggy + 1.60, gz + 0.30, 0.048, 6);
    this.rod('bamboo', gx, apex - 0.22, gz - 0.16, gx + 0.35, ggy, gz - 3.10, 0.062, 6);
    this.wear = null;
    // lashings at the head and the brace
    this.wear = { grime: 0.72, wet: 0.94, edge: 0.90 };
    for (i = 0; i < 5; i++) {
      this.c('rope', 0.115, 0.115, 0.035, gx, apex - 0.10 - i * 0.055, gz - 0.17, 1.30, 0, 0, 8);
    }
    for (i = 0; i < 3; i++) {
      this.c('rope', 0.085, 0.085, 0.030, gx - 1.05, ggy + 1.60, gz + 0.30, 0, 0, 1.57, 8);
      this.c('rope', 0.085, 0.085, 0.030, gx + 1.05, ggy + 1.60, gz + 0.30, 0, 0, 1.57, 8);
    }
    this.wear = null;
    // the sheave block and the fall
    this.wear = { grime: 0.60, wet: 0.90, edge: 0.66 };
    this.b('timber', 0.16, 0.30, 0.10, gx, apex - 0.42, gz - 0.16);
    this.c('metal', 0.085, 0.085, 0.05, gx, apex - 0.46, gz - 0.16, 0, 0, 1.57, 8);
    this.wear = null;
    this.wear = { grime: 0.74, wet: 0.94, edge: 0.92 };
    // the hauling part, run off to a stake in the ground
    this.sag('rope', gx, apex - 0.48, gz - 0.16, gx + 0.30, ggy + 0.12, gz - 2.55, 0.22, 0.021, 6);
    // and the standing part holding the block
    var slungY = ggy + 1.32;
    this.rod('rope', gx - 0.30, apex - 0.48, gz - 0.16, gx - 0.30, slungY + 0.24, gz - 0.16, 0.021, 5);
    this.rod('rope', gx + 0.30, apex - 0.48, gz - 0.16, gx + 0.30, slungY + 0.24, gz - 0.16, 0.021, 5);
    this.rod('rope', gx - 0.30, slungY + 0.24, gz - 0.16, gx + 0.30, slungY + 0.24, gz - 0.16, 0.019, 5);
    this.rod('rope', gx - 0.48, slungY, gz - 0.16, gx + 0.48, slungY, gz - 0.16, 0.024, 5);
    this.wear = null;
    this.putAt('yblock', gx, slungY + 0.22, gz - 0.16, 0.04, 0, 0, 1.05, 1.0, 1.05, this.wearTint(rng));
    this.mark(1, gx, gz - 0.16, 0.6, 0.42, 0.1);
    this.reset();
    this.collider(gx - 1.0, ggy + 1.4, gz + 0.3, 0.9, 1.4, 0.5, 'wood');
    this.collider(gx + 1.0, ggy + 1.4, gz + 0.3, 0.9, 1.4, 0.5, 'wood');
    this._claim(gx, gz, 2.2);

    // ---- tarped stack of the finer carved pieces ---------------------------
    var tx = cx - 4.6, tz = cz + 1.4;
    var tgy = this._ground(tx, tz);
    for (i = 0; i < 5; i++) {
      this.putAt('yblock', tx + rng.range(-0.5, 0.5), tgy + 0.11 + (i > 2 ? 0.40 : 0),
        tz + rng.range(-0.4, 0.4), rng.range(-0.2, 0.2), 0, 0,
        rng.range(0.9, 1.1), 1, rng.range(0.9, 1.1), this.wearTint(rng));
    }
    this.reset();
    this.wear = { grime: 0.66, wet: 0.90, edge: 0.88 };
    // A tarp is not a flat plate: three panels with a real sag between the
    // high corners and the low ones, and the corners weighted with stone.
    for (i = 0; i < 3; i++) {
      var f = (i + 0.5) / 3;
      this.b('canvas', 2.35, 0.028, 0.85,
        tx, tgy + M.lerp(1.05, 0.72, f) - 0.10 * Math.sin(f * Math.PI),
        tz - 1.0 + f * 2.0, -0.17, 0.06, rng.range(-0.03, 0.03));
    }
    this.wear = null;
    this.reset();
    for (i = -1; i <= 1; i += 2) {
      for (j = -1; j <= 1; j += 2) {
        this.putAt('chip', tx + i * 1.10, tgy + M.lerp(0.98, 0.66, (j + 1) * 0.5) - 0.02,
          tz + j * 0.92, rng.range(0, 6.283), rng.range(-0.2, 0.2), rng.range(-0.2, 0.2),
          rng.range(0.7, 1.0), 0.7, rng.range(0.7, 1.0), this.wearTint(rng));
      }
    }
    this.collider(tx, tgy + 0.55, tz, 1.2, 0.55, 1.0, 'stone');
    this._claim(tx, tz, 1.6);

    // ---- the loose kit: crates, buckets, a plank pile, a rope coil ----------
    var kit = [
      ['crate', cx + 4.3, cz - 2.3, 0.35], ['crate', cx + 4.9, cz - 1.7, -0.75],
      ['crate', cx + 4.55, cz - 2.05, 1.20], ['bucket', cx + 3.4, cz - 2.6, 0.4],
      ['bucket', cx + 3.75, cz - 2.35, 2.1], ['bucket', gx + 1.9, gz - 1.4, 0.9]
    ];
    for (i = 0; i < kit.length; i++) {
      var kx = kit[i][1], kz = kit[i][2];
      if (this._blocked(kx, kz, 0.35, 0.8) || this._step(kx, kz, 0.40) > 0.12) continue;
      var stacked = (i === 2) ? 0.44 : 0;
      this.plant(kit[i][0], kx, kz, kit[i][3], rng.range(0.94, 1.06), 1, 1, 0.4,
        -stacked, this.wearTint(rng));
      this._claim(kx, kz, 0.45);
    }
    // sawn timber, stacked and stickered
    this.reset();
    this.wear = { grime: 0.58, wet: 0.90, edge: 0.74 };
    var wx = cx + 6.1, wz = cz + 1.9, wgy = this._ground(wx, wz);
    for (j = 0; j < 4; j++) {
      for (i = 0; i < 3; i++) {
        this.b('timber', 2.55, 0.085, 0.20,
          wx + rng.range(-0.05, 0.05), wgy + 0.09 + j * 0.115, wz - 0.24 + i * 0.24,
          0, rng.range(-0.02, 0.02), 0);
      }
    }
    this.wear = null;
    this.reset();
    this.collider(wx, wgy + 0.28, wz, 1.3, 0.28, 0.4, 'wood');
    this._claim(wx, wz, 1.5);
    // a coil of rope thrown down beside it
    this.reset();
    this.wear = { grime: 0.70, wet: 0.94, edge: 0.90 };
    for (i = 0; i < 4; i++) {
      var cr2 = 0.34 - i * 0.055;
      for (j = 0; j < 12; j++) {
        var a1 = j / 12 * 6.283, a2 = (j + 1) / 12 * 6.283;
        this.rod('rope',
          wx + 1.7 + Math.cos(a1) * cr2, wgy + 0.03 + i * 0.045, wz - 0.9 + Math.sin(a1) * cr2,
          wx + 1.7 + Math.cos(a2) * cr2, wgy + 0.03 + i * 0.045, wz - 0.9 + Math.sin(a2) * cr2,
          0.022, 4);
      }
    }
    this.wear = null;
    this.reset();
  };

  // ==========================================================================
  // THE TRENCH  (anchors.dig)
  //
  // level_ruins built the boards, the spoil and the worklight tripod. This is
  // the archaeology: a string grid on stakes over the cut, a sieve, finds
  // trays, and the spoil actually heaped on the DOWNHILL side where a
  // barrowful gets tipped.
  // ==========================================================================
  PropsRuins.prototype._dressDig = function () {
    if (!this._ok || !this.A.dig) return;
    var D = this.A.dig, tr = D.trench;
    if (!tr) return;
    var rng = this.rng.fork ? this.rng.fork(0x4416) : this.rng;
    var i, j;

    // ---- the string grid ----------------------------------------------------
    var nx = 3, nz = 3;
    var stakes = [];
    for (i = 0; i <= nx; i++) {
      for (j = 0; j <= nz; j++) {
        var sx = M.lerp(tr.x0 - 0.5, tr.x1 + 0.5, i / nx);
        var sz = M.lerp(tr.z0 - 0.5, tr.z1 + 0.5, j / nz);
        if (i > 0 && i < nx && j > 0 && j < nz) continue;     // only the perimeter
        var sy = this._ground(sx, sz);
        this.plant('stake', sx, sz, rng.range(0, 6.283), 1, rng.range(0.85, 1.1), 1,
          0.2, 0.06, this.wearTint(rng));
        stakes.push([sx, sy + 0.50, sz]);
      }
    }
    this.reset();
    this.wear = { grime: 0.80, wet: 0.98, edge: 0.96 };
    // string round the perimeter and two cross lines - slack, because string is
    for (i = 0; i + 1 < stakes.length; i++) {
      var a = stakes[i], b = stakes[i + 1];
      var d = Math.abs(a[0] - b[0]) + Math.abs(a[2] - b[2]);
      if (d > 4.0) continue;
      this.sag('rope', a[0], a[1], a[2], b[0], b[1], b[2], 0.05, 0.008, 3);
    }
    this.sag('rope', tr.x0 - 0.5, this._ground(tr.x0, tr.z0) + 0.50, tr.z0 - 0.5,
      tr.x1 + 0.5, this._ground(tr.x1, tr.z1) + 0.50, tr.z1 + 0.5, 0.09, 0.008, 5);
    this.wear = null;
    this.reset();

    // ---- the sieve on its legs ---------------------------------------------
    var vx = tr.x0 - 2.0, vz = tr.z1 + 1.1;
    var vy = this._ground(vx, vz);
    this.reset();
    this.wear = { grime: 0.58, wet: 0.90, edge: 0.70 };
    for (i = 0; i < 4; i++) {
      var la = i * 1.5708 + 0.785;
      this.rod('timber', vx + Math.cos(la) * 0.42, vy, vz + Math.sin(la) * 0.42,
        vx + Math.cos(la) * 0.16, vy + 0.86, vz + Math.sin(la) * 0.16, 0.032, 5);
    }
    this.b('timber', 0.80, 0.075, 0.62, vx, vy + 0.90, vz, 0.06, 0.2, 0);
    this.b('timber', 0.86, 0.055, 0.10, vx, vy + 0.94, vz + 0.30, 0.06, 0.2, 0);
    this.b('timber', 0.86, 0.055, 0.10, vx, vy + 0.94, vz - 0.30, 0.06, 0.2, 0);
    this.wear = null;
    // the screened spoil under it, a neat cone
    this.reset();
    for (i = 0; i < 22; i++) {
      var pa = rng.range(0, 6.283), pr = Math.abs(rng.gaussian(0, 0.32));
      this.putAt('grit', vx + Math.cos(pa) * pr, vy + 0.02 + Math.max(0, 0.18 - pr * 0.4),
        vz + Math.sin(pa) * pr, rng.range(0, 6.283), rng.range(-0.3, 0.3), rng.range(-0.3, 0.3),
        rng.range(0.5, 0.9), 0.6, rng.range(0.6, 1.0), this.wearTint(rng));
    }
    this.collider(vx, vy + 0.5, vz, 0.45, 0.5, 0.4, 'wood');
    this._claim(vx, vz, 0.7);

    // ---- finds trays and buckets on the lip --------------------------------
    var lip = [[tr.x1 + 0.9, tr.z0 + 1.2, 0.3], [tr.x1 + 1.4, tr.z0 + 2.0, -0.6],
      [tr.x0 - 1.3, tr.z0 + 0.6, 1.1]];
    for (i = 0; i < lip.length; i++) {
      this.plant('crate', lip[i][0], lip[i][1], lip[i][2], 0.9, 0.62, 0.9, 0.4, 0,
        this.wearTint(rng));
      this._claim(lip[i][0], lip[i][1], 0.5);
      // straw padding spilling out of the trays
      this.putAt('straw', lip[i][0], this._ground(lip[i][0], lip[i][1]) + 0.30,
        lip[i][1], rng.range(0, 6.283), 0, 0, 0.72, 1, 0.55, this.leafTint(rng, 1.0));
    }
    for (i = 0; i < 3; i++) {
      var bx = tr.x0 + rng.range(0.4, 1.4), bz = tr.z1 + rng.range(0.4, 1.6);
      this.plant('bucket', bx, bz, rng.range(0, 6.283), 1, 1, 1, 0.2, 0, this.wearTint(rng));
    }

    // ---- the spoil heap, tipped clear of the cut ---------------------------
    var hx = tr.x1 + 2.6, hz = (tr.z0 + tr.z1) * 0.5 + 1.2;
    var hy = this._ground(hx, hz);
    this.reset();
    this.wear = { grime: 0.94, wet: 1, edge: 1 };
    for (i = 0; i < 5; i++) {
      var mr = 1.7 - i * 0.26;
      this.sp('earth', mr, hx + rng.range(-0.15, 0.15), hy - 0.35 + i * 0.16,
        hz + rng.range(-0.15, 0.15), 1, 0.32, 0.85, 9, 5);
    }
    this.wear = null;
    this.reset();
    for (i = 0; i < 30; i++) {
      var sa = rng.range(0, 6.283), sr = Math.abs(rng.gaussian(0, 0.9)) + 0.2;
      var ex = hx + Math.cos(sa) * sr, ez = hz + Math.sin(sa) * sr * 0.8;
      this.putAt(rng.bool(0.25) ? 'brick' : 'grit', ex,
        hy + Math.max(0.02, 0.42 - sr * 0.24), ez,
        rng.range(0, 6.283), rng.range(-0.4, 0.4), rng.range(-0.4, 0.4),
        rng.range(0.4, 0.9), rng.range(0.4, 0.8), rng.range(0.5, 1.0), this.wearTint(rng));
    }
    this._claim(hx, hz, 1.9);
    // a shovel stood in the heap
    this.reset();
    this.wear = { grime: 0.62, wet: 0.94, edge: 0.72 };
    this.rod('timber', hx - 0.5, hy + 0.10, hz - 0.5, hx - 0.86, hy + 1.32, hz - 0.72, 0.026, 6);
    this.b('metal', 0.20, 0.30, 0.03, hx - 0.44, hy + 0.10, hz - 0.46, 0.30, 0.5, 0.16);
    this.b('timber', 0.10, 0.16, 0.02, hx - 0.88, hy + 1.40, hz - 0.74, 0.30, 0.5, 0.16);
    this.wear = null;
    this.reset();

    // ---- the plank walkway out of the cut, and the mud it has tracked ------
    this.reset();
    this.wear = { grime: 0.52, wet: 0.86, edge: 0.80 };
    var wz0 = tr.z1, wz1 = tr.z1 + 2.8;
    for (i = 0; i < 2; i++) {
      var px2 = (tr.x0 + tr.x1) * 0.5 - 0.28 + i * 0.56;
      this.b('timber', 0.26, 0.045, wz1 - wz0,
        px2, this._ground(px2, (wz0 + wz1) * 0.5) + 0.05, (wz0 + wz1) * 0.5,
        0.02, rng.range(-0.02, 0.02), 0);
    }
    this.wear = null;
    this.reset();
  };

  // ==========================================================================
  // THE LOOTERS' CAMP  (anchors.camp)
  //
  // level_ruins built the brazier, the tarp and its poles. What is missing is
  // the PEOPLE: where they sleep, what they eat off, and what they are here
  // for - which is the crate of carved fragments packed in straw with a
  // tarpaulin over it, sitting four metres from a shrine somebody still lights
  // candles at. The whole level's story is in that distance.
  // ==========================================================================
  PropsRuins.prototype._dressCamp = function () {
    if (!this._ok || !this.A.camp) return;
    var C = this.A.camp;
    var rng = this.rng.fork ? this.rng.fork(0x3A99) : this.rng;
    var cx = C.centre.x, cz = C.centre.z, gy = C.centre.y;
    var tx = cx + 1.9, tz = cz - 0.9;               // the level's tarp centre
    var i;

    // ---- a cook pot on a trivet over the embers ----------------------------
    this.reset();
    this.wear = { grime: 0.44, wet: 0.94, edge: 0.60 };
    for (i = 0; i < 3; i++) {
      var ta = i * 2.094 + 0.9;
      this.rod('metal', cx + Math.cos(ta) * 0.34, gy + 0.05, cz + Math.sin(ta) * 0.34,
        cx + Math.cos(ta) * 0.14, gy + 0.82, cz + Math.sin(ta) * 0.14, 0.016, 5);
    }
    this.add('metal', lathe([[0.00, 0], [0.14, 0.005], [0.20, 0.06],
      [0.215, 0.17], [0.19, 0.25], [0.205, 0.27]], 12), T(cx, gy + 0.80, cz));
    this.rod('metal', cx - 0.20, gy + 1.03, cz, cx + 0.20, gy + 1.03, cz, 0.010, 5);
    this.wear = null;
    this.reset();
    this.mark(0, cx, cz, 2.6, 2.4, 0.4, { grime: 1, wet: 0.9, edge: 1 });
    this.smokeEmitters.push({
      position: new THREE.Vector3(cx, gy + 1.15, cz),
      opts: { rate: 0.7, size: 0.24, rise: 0.30 }
    });

    // ---- the bedroll and a folded blanket under the tarp -------------------
    this.reset();
    this.wear = { grime: 0.52, wet: 0.92, edge: 0.94 };
    this.pushT(tx - 0.35, gy, tz - 0.15, 0, -0.42, 0);
    this.c('cloth', 0.17, 0.17, 1.85, 0, 0.17, 0, 0, 0, 1.5708, 8);
    this.b('cloth', 0.44, 0.10, 1.75, 0.05, 0.10, 0);
    this.b('sack', 0.34, 0.16, 0.28, 0, 0.24, -0.78);          // a rolled bag for a pillow
    this.pop();
    this.b('cloth', 0.52, 0.14, 0.42, tx + 0.75, gy + 0.07, tz + 0.62, 0, 0.3, 0);
    this.wear = null;
    this.reset();

    // ---- rice sacks, slumped, leaning on each other ------------------------
    var sacks = [[tx - 1.15, tz + 0.85, 0.5], [tx - 0.78, tz + 1.05, -0.3], [tx - 1.05, tz + 1.35, 1.2]];
    for (i = 0; i < sacks.length; i++) {
      this.reset();
      this.wear = { grime: 0.60, wet: 0.92, edge: 0.94 };
      var sxx = sacks[i][0], szz = sacks[i][1];
      var q = this._settle(sxx, szz, 0.35, sacks[i][2]);
      _vp.set(sxx, this._ground(sxx, szz), szz); _vs.set(1, 1, 1);
      this.pushM(_m4.compose(_vp, q, _vs).clone());
      this.pushT(0, 0, 0, rng.range(0.15, 0.4), 0, rng.range(-0.2, 0.2));
      this.sp('sack', 0.30, 0, 0.24, 0, 1.0, 0.82, 1.45, 8, 6);
      this.sp('sack', 0.24, 0, 0.44, -0.12, 0.95, 0.70, 1.05, 8, 6);
      this.b('sack', 0.22, 0.10, 0.09, 0, 0.56, -0.28, 0.5, 0, 0);   // the tied neck
      this.pop(); this.pop();
      this.wear = null;
      this.reset();
      this._claim(sxx, szz, 0.4);
    }

    // ---- the hammock, slung between two of the level's tarp poles ----------
    this.reset();
    this.wear = { grime: 0.58, wet: 0.94, edge: 0.94 };
    var ay = gy + 1.62;
    this.sag('rope', tx - 1.42, ay + 0.24, tz - 1.40, tx - 1.10, ay - 0.10, tz - 0.60, 0.08, 0.014, 3);
    this.sag('rope', tx + 1.42, ay + 0.16, tz + 1.40, tx + 1.10, ay - 0.14, tz + 0.60, 0.08, 0.014, 3);
    for (i = 0; i < 5; i++) {
      var f = (i + 0.5) / 5;
      var hy2 = ay - 0.12 - 0.42 * 4 * f * (1 - f);
      this.b('cloth', 0.60, 0.030, 0.28,
        M.lerp(tx - 1.10, tx + 1.10, f), hy2, M.lerp(tz - 0.60, tz + 0.60, f),
        0, 0.49, (f - 0.5) * 0.55);
    }
    this.wear = null;
    this.reset();

    // ---- what they are here for --------------------------------------------
    // A crate of carved fragments, packed in straw, roped shut, with two
    // pieces still loose on top - and one of them is a face.
    var lx = cx - 1.55, lz = cz + 1.30;
    var lgy = this._ground(lx, lz);
    this.plant('crate', lx, lz, 0.36, 1.32, 1.15, 1.25, 0.5, 0, this.wearTint(rng));
    this._claim(lx, lz, 0.7);
    this.putAt('straw', lx, lgy + 0.51, lz, 0.4, 0, 0, 1.05, 1, 0.75, this.leafTint(rng, 1.0));
    this.reset();
    this.wear = { grime: 0.56, wet: 0.90, edge: 0.60 };
    this.pushT(lx, lgy + 0.54, lz, 0, 0.36, 0);
    this.b('stone', 0.40, 0.15, 0.30, -0.10, 0.075, 0.06, 0.06, 0.4, 0.03);
    // a head, face up, in the straw
    this.sp('stone', 0.135, 0.16, 0.10, -0.05, 0.96, 1.05, 0.98);
    this.b('carve', 0.20, 0.035, 0.045, 0.16, 0.19, -0.14);
    this.b('carve', 0.075, 0.025, 0.035, 0.115, 0.155, -0.15);
    this.b('carve', 0.075, 0.025, 0.035, 0.205, 0.155, -0.15);
    this.pop();
    this.wear = null;
    this.wear = { grime: 0.70, wet: 0.94, edge: 0.92 };
    for (i = -1; i <= 1; i += 2) {
      this.rod('rope', lx - 0.44, lgy + 0.30 + i * 0.10, lz + 0.30,
        lx + 0.44, lgy + 0.30 + i * 0.10, lz + 0.30, 0.014, 4);
      this.rod('rope', lx - 0.44, lgy + 0.30 + i * 0.10, lz - 0.30,
        lx + 0.44, lgy + 0.30 + i * 0.10, lz - 0.30, 0.014, 4);
      this.rod('rope', lx + i * 0.40, lgy + 0.02, lz - 0.30,
        lx + i * 0.40, lgy + 0.58, lz + 0.30, 0.014, 4);
    }
    this.wear = null;
    this.reset();

    // ---- the small human litter -------------------------------------------
    this.reset();
    this.wear = { grime: 0.48, wet: 0.92, edge: 0.66 };
    // a jerrycan
    this.b('metal', 0.34, 0.44, 0.18, cx + 1.05, gy + 0.22, cz + 1.35, 0, 0.7, 0);
    this.b('metal', 0.10, 0.06, 0.12, cx + 1.05, gy + 0.46, cz + 1.35, 0, 0.7, 0);
    // three enamel bowls, stacked, and a kettle
    for (i = 0; i < 3; i++) {
      this.add('metal', lathe([[0.00, 0], [0.09, 0.005], [0.115, 0.045], [0.105, 0.055]], 9),
        T(cx - 0.72, gy + 0.02 + i * 0.05, cz - 0.68));
    }
    this.add('metal', lathe([[0.00, 0], [0.10, 0.0], [0.125, 0.07], [0.10, 0.14],
      [0.055, 0.155], [0.062, 0.175]], 10), T(cx - 0.34, gy + 0.02, cz - 0.92));
    this.wear = null;
    // bottles
    this.wear = { grime: 0.66, wet: 0.92, edge: 0.80 };
    for (i = 0; i < 3; i++) {
      this.add('cloth', lathe([[0.00, 0], [0.038, 0], [0.042, 0.14],
        [0.020, 0.19], [0.018, 0.24]], 8),
        T(cx + 0.55 + i * 0.13, gy + 0.02, cz - 1.05 + i * 0.09, 0, rng.range(0, 3), 0));
    }
    this.wear = null;
    this.reset();

    // a machete driven into a log they have been splitting for the fire
    this.reset();
    this.wear = { grime: 0.60, wet: 0.94, edge: 0.74 };
    var mx = cx - 0.30, mz = cz + 2.05;
    var mgy = this._ground(mx, mz);
    this.rod('bark', mx - 0.55, mgy + 0.16, mz - 0.10, mx + 0.55, mgy + 0.16, mz + 0.06, 0.17, 7);
    this.b('metal', 0.045, 0.42, 0.10, mx + 0.05, mgy + 0.44, mz, -0.28, 0.3, 0.22);
    this.b('timber', 0.05, 0.16, 0.055, mx + 0.16, mgy + 0.70, mz + 0.06, -0.28, 0.3, 0.22);
    this.wear = null;
    this.reset();
    this.collider(mx, mgy + 0.18, mz, 0.6, 0.18, 0.22, 'wood');
    // the split billets, thrown toward the fire
    for (i = 0; i < 7; i++) {
      var bxx = M.lerp(mx, cx, rng.range(0.2, 0.9)) + rng.range(-0.35, 0.35);
      var bzz = M.lerp(mz, cz, rng.range(0.2, 0.9)) + rng.range(-0.35, 0.35);
      this.reset();
      this.wear = { grime: 0.58, wet: 0.94, edge: 0.78 };
      this.rod('bark', bxx - 0.18, this._ground(bxx, bzz) + 0.055, bzz,
        bxx + 0.18, this._ground(bxx, bzz) + 0.055, bzz + rng.range(-0.2, 0.2), 0.055, 5);
      this.wear = null;
      this.reset();
    }
  };

  // ==========================================================================
  // THE INNER COURTYARD
  //
  // hero1 stands here, so this pass exists to give that framing a foreground
  // and a middle ground at three separate depths. Jars at the terrace corners,
  // a toppled colonnette row where the gallery's inner face has failed, and
  // the small stuff that always ends up at the foot of a stair.
  // ==========================================================================
  PropsRuins.prototype._dressCourtyard = function () {
    if (!this._ok) return;
    var A = this.A, TR = A.terrace;
    var rng = this.rng.fork ? this.rng.fork(0x2C17) : this.rng;
    var i, k;

    // ---- jars at the foot of the terrace, on the sheltered side ------------
    if (TR && TR.tiers && TR.tiers[0]) {
      var t0 = TR.tiers[0];
      var jarSites = [
        [t0.x0 - 0.95, t0.z1 - 2.4], [t0.x0 - 1.35, t0.z1 - 3.3],
        [t0.x1 + 1.05, t0.z1 - 1.9], [t0.x1 + 1.20, t0.z1 - 3.0],
        [t0.x1 + 1.55, t0.z1 - 2.4]
      ];
      for (i = 0; i < jarSites.length; i++) {
        var jx = jarSites[i][0], jz = jarSites[i][1];
        if (this._blocked(jx, jz, 0.30, 0.9)) continue;
        // a jar half on a flagstone platform and half off it cannot be
        // settled, only hidden - reject the site rather than fake it
        if (this._step(jx, jz, 0.34) > 0.10) continue;
        if (!this._claim(jx, jz, 0.42)) continue;
        this.plant('jar', jx, jz, rng.range(0, 6.283), rng.range(0.88, 1.18), 1, 1,
          0.34, 0.02, this.wearTint(rng));
        this.mark(3, jx, jz, 1.15, 1.15, rng.range(0, 3), { grime: 1, wet: 0.5, edge: 1 });
        this.collider(jx, this._ground(jx, jz) + 0.35, jz, 0.32, 0.35, 0.32, 'stone');
        // and the green that grows in the damp ring round a jar that leaks
        for (k = 0; k < 3; k++) {
          var ga = rng.range(0, 6.283);
          this.plant('grassB', jx + Math.cos(ga) * rng.range(0.42, 0.72), jz + Math.sin(ga) * rng.range(0.42, 0.72),
            rng.range(0, 6.283), rng.range(0.6, 1.0), rng.range(0.6, 1.1), rng.range(0.6, 1.0),
            0.25, 0.02, this.leafTint(rng, 0.30));
        }
      }
    }

    // ---- a toppled colonnade: five drums lying where they rolled -----------
    // Against the inner pillar line west of the axis, i.e. down-slope from the
    // gallery, which is the direction a column falls when its footing washes
    // out. They lie roughly in line and roughly parallel - roughly, because a
    // fallen column does not land in a row.
    var dl = [[-13.6, -6.8], [-13.2, -5.6], [-12.9, -4.3], [-13.4, -3.1], [-12.6, -1.9]];
    for (i = 0; i < dl.length; i++) {
      var dx = dl[i][0] + rng.range(-0.30, 0.30), dz = dl[i][1] + rng.range(-0.25, 0.25);
      if (this._blocked(dx, dz, 0.3, 0.8)) continue;
      var dgy = this._ground(dx, dz);
      this.putAt('drum', dx, dgy + 0.20, dz, rng.range(1.35, 1.80), 1.5708,
        rng.range(-0.10, 0.10), rng.range(0.94, 1.10), 1, rng.range(0.94, 1.10),
        this.wearTint(rng));
      this.collider(dx, dgy + 0.20, dz, 0.28, 0.20, 0.28, 'stone');
      this._claim(dx, dz, 0.45);
    }
    // the capital that came off the top of it, face down
    this.reset();
    this.wear = { grime: 0.56, wet: 0.86, edge: 0.52 };
    var capx = -12.2, capz = -0.6;
    var capq = this._settle(capx, capz, 0.5, 0.75);
    _vp.set(capx, this._ground(capx, capz) + 0.17, capz); _vs.set(1, 1, 1);
    this.pushM(_m4.compose(_vp, capq, _vs).clone());
    this.b('stone', 0.86, 0.34, 0.86, 0, 0, 0, 0.10, 0, 0.14);
    this.b('stone', 0.62, 0.24, 0.62, 0, 0.26, 0, 0.10, 0, 0.14);
    for (k = -1; k <= 1; k += 2) {
      this.b('carve', 0.10, 0.20, 0.86, k * 0.40, 0.02, 0, 0.10, 0, 0.14);
    }
    this.wear = null;
    this.pop(); this.reset();
    this.collider(capx, this._ground(capx, capz) + 0.20, capz, 0.5, 0.24, 0.5, 'stone');

    // ---- the terrace cornices ----------------------------------------------
    // A moulded cornice is a shelf. It catches wind-blown dirt, it holds the
    // water that runs off the tier above, and within a decade it carries a
    // continuous fringe of fern and grass. Three tiers of that fringe, stacked
    // one above another, is the single strongest "this has been abandoned for
    // centuries" cue the sanctuary has - and all three are dead centre in the
    // courtyard framing, where the level otherwise presents 14 m of unbroken
    // facing stone.
    if (TR && TR.tiers) {
      for (k = 0; k < TR.tiers.length; k++) {
        var ti = TR.tiers[k];
        var edges = [
          { ax: 'x', a0: ti.x0, a1: ti.x1, b: ti.z1 - 0.30, out: 1 },
          { ax: 'x', a0: ti.x0, a1: ti.x1, b: ti.z0 + 0.30, out: -1 },
          { ax: 'z', a0: ti.z0, a1: ti.z1, b: ti.x0 + 0.30, out: -1 },
          { ax: 'z', a0: ti.z0, a1: ti.z1, b: ti.x1 - 0.30, out: 1 }
        ];
        for (var ei = 0; ei < edges.length; ei++) {
          var E = edges[ei];
          var en = Math.round(Math.abs(E.a1 - E.a0) / 0.70);
          for (i = 0; i < en; i++) {
            var ea = E.a0 + (i + 0.5) * (E.a1 - E.a0) / en + rng.range(-0.28, 0.28);
            // the stair cuts the south face of every tier - keep the treads clear
            if (E.ax === 'x' && E.out > 0 && Math.abs(ea) < (TR.stair ? TR.stair.half + 0.9 : 3.5)) continue;
            var ed = M.saturate(this.noise.fbm2(ea * 0.21 + k * 9.1 + ei * 4.4, ti.y * 0.7, 3) * 1.7 + 0.30);
            if (!rng.bool(ed * 0.80)) continue;
            // ON THE LIP, leaning OUT, not back from it. The courtyard eye is
            // at 1.66 m and tier one's paving is at 1.90, so a plant set back
            // 30 cm onto the terrace top is entirely behind the parapet line
            // and cannot be seen from anywhere a player stands. What reads is
            // the growth that overhangs - which is also what actually happens,
            // because a cornice plant grows toward the light.
            var lipOut = E.out * rng.range(0.24, 0.40);
            var ex2 = E.ax === 'x' ? ea : E.b + lipOut;
            var ez2 = E.ax === 'x' ? E.b + lipOut : ea;
            var es = rng.range(0.65, 1.30);
            var ekind = rng.next();
            var lean = 0.30 + rng.range(0, 0.28);
            this.putAt(ekind < 0.40 ? 'fernA' : (ekind < 0.66 ? 'grassA' :
              (ekind < 0.84 ? 'fernB' : 'flower')),
              ex2, ti.y - 0.06, ez2,
              E.ax === 'x' ? (E.out > 0 ? 0 : Math.PI) : (E.out > 0 ? 1.5708 : -1.5708),
              lean, rng.range(-0.16, 0.16),
              es, es * rng.range(0.85, 1.35), es, this.leafTint(rng, rng.range(0.05, 0.55)));
            // and the vine that hangs off the cornice it grew on
            if (rng.bool(0.60)) {
              this.putAt('vine',
                E.ax === 'x' ? ea + rng.range(-0.3, 0.3) : E.b + E.out * 0.36,
                ti.y - 0.16,
                E.ax === 'x' ? E.b + E.out * 0.36 : ea + rng.range(-0.3, 0.3),
                rng.range(0, 6.283), 0, 0,
                rng.range(0.55, 1.05), rng.range(0.32, 0.68), 1,
                this.leafTint(rng, rng.range(0, 0.4)));
            }
          }
        }
      }
    }

    // ---- the joint at the foot of each stair cheek --------------------------
    // Where a vertical face meets a horizontal one and nobody's feet ever go.
    if (TR && TR.stair && TR.stair.segs) {
      var segs = TR.stair.segs;
      for (k = 0; k < segs.length; k++) {
        var sg2 = segs[k];
        for (var sgn = -1; sgn <= 1; sgn += 2) {
          var scx = sgn * (TR.stair.half + 0.70);
          var nseg = Math.max(2, Math.round(Math.abs(sg2.z1 - sg2.z0) / 0.8));
          for (i = 0; i < nseg; i++) {
            var u2 = (i + 0.5) / nseg;
            var szz = M.lerp(sg2.z0, sg2.z1, u2);
            var syy = M.lerp(sg2.y0, sg2.y1, u2);
            if (!rng.bool(0.55)) continue;
            var sxx = scx + sgn * rng.range(0.0, 0.45);
            var ss2 = rng.range(0.40, 0.90);
            this.putAt(rng.bool(0.5) ? 'fernB' : (rng.bool(0.5) ? 'grassB' : 'moss'),
              sxx, syy - 0.62 + rng.range(-0.05, 0.05), szz + rng.range(-0.25, 0.25),
              rng.range(0, 6.283), rng.range(-0.14, 0.14), rng.range(-0.14, 0.14),
              ss2, ss2 * rng.range(0.8, 1.25), ss2, this.leafTint(rng, rng.range(0.05, 0.5)));
          }
        }
      }
    }

    // ---- THE GREAT STAIR ITSELF ---------------------------------------------
    // Forty treads of clean sandstone running up the middle of the signature
    // framing. Feet keep the centre metre of a stair swept; everything grows
    // in the joints at the OUTER thirds and along the cheeks, and the chips
    // knocked off the nosings collect in the internal corner of each tread.
    if (TR && TR.stair && TR.stair.segs) {
      var sgs = TR.stair.segs, half = TR.stair.half;
      for (k = 0; k < sgs.length; k++) {
        var fl = sgs[k];
        var nsteps = Math.max(3, Math.round(Math.abs(fl.z1 - fl.z0) / 0.42));
        for (i = 0; i < nsteps; i++) {
          var u3 = (i + 0.5) / nsteps;
          var tz2 = M.lerp(fl.z0, fl.z1, u3);
          var ty2 = M.lerp(fl.y0, fl.y1, u3);
          for (var sd = -1; sd <= 1; sd += 2) {
            var lat2 = sd * rng.range(half * 0.58, half * 0.97);
            var jd2 = M.saturate(this.noise.fbm2(tz2 * 0.9 + k * 3.3, lat2 * 0.9, 3) * 1.7 + 0.28);
            if (rng.bool(jd2 * 0.60)) {
              var ts = rng.range(0.32, 0.72);
              this.putAt(rng.bool(0.45) ? 'moss' : (rng.bool(0.5) ? 'grassB' : 'fernB'),
                lat2, ty2 + 0.02, tz2 + rng.range(-0.12, 0.12), rng.range(0, 6.283),
                rng.range(-0.14, 0.14), rng.range(-0.14, 0.14),
                ts, ts * rng.range(0.8, 1.3), ts, this.leafTint(rng, rng.range(0.1, 0.65)));
            }
            if (rng.bool(0.22)) {
              this.putAt('grit', lat2 + rng.range(-0.3, 0.3), ty2 + 0.02,
                tz2 + rng.range(-0.14, 0.14), rng.range(0, 6.283),
                rng.range(-0.3, 0.3), rng.range(-0.3, 0.3),
                rng.range(0.35, 0.8), rng.range(0.3, 0.7), rng.range(0.5, 1.0),
                this.wearTint(rng));
            }
          }
          // moss along the top of both cheek walls
          for (var cs2 = -1; cs2 <= 1; cs2 += 2) {
            if (!rng.bool(0.36)) continue;
            var ms = rng.range(0.35, 0.75);
            this.putAt(rng.bool(0.6) ? 'moss' : 'grassB',
              cs2 * (half + 0.34) + rng.range(-0.14, 0.14), ty2 + 0.74, tz2,
              rng.range(0, 6.283), rng.range(-0.12, 0.12), rng.range(-0.12, 0.12),
              ms, ms * rng.range(0.8, 1.2), ms, this.leafTint(rng, rng.range(0.15, 0.7)));
          }
        }
      }
    }

    // ---- the small stuff at the foot of the great stair ---------------------
    // Where people stop, put things down and knock chips off the treads.
    if (TR && TR.stair && TR.stair.foot) {
      var f = TR.stair.foot;
      for (i = 0; i < 26; i++) {
        var fa = rng.range(0, 6.283);
        var fr = 1.6 + Math.abs(rng.gaussian(0, 1.5));
        var fx = f.x + Math.cos(fa) * fr, fz = f.z + Math.sin(fa) * fr * 0.7 + 1.4;
        if (this._blocked(fx, fz, 0.15, 0.5)) continue;
        var s = rng.range(0.35, 0.95) * M.smoothstep(5.0, 1.2, fr);
        if (s < 0.16) continue;
        this.putAt(rng.bool(0.25) ? 'chip' : 'grit', fx, this._ground(fx, fz) + 0.02, fz,
          rng.range(0, 6.283), rng.range(-0.35, 0.35), rng.range(-0.35, 0.35),
          s, s * rng.range(0.55, 0.95), s * rng.range(0.8, 1.2), this.wearTint(rng));
      }
      // Two masses of stone knocked off the stair cheeks, out where the
      // courtyard opens up. A block that came off a cheek at 5 m of height
      // lands a metre or two out and then gets pushed aside by everyone who
      // uses the stair, which is why these sit clear of the flight rather than
      // on it - and why the growth has had time to close over them.
      var lumps = [[-6.40, -3.55], [6.15, -4.25], [-9.10, -1.10]];
      for (i = 0; i < lumps.length; i++) {
        var mx2 = lumps[i][0], mz2 = lumps[i][1];
        if (this._blocked(mx2, mz2, 0.5, 0.9)) continue;
        for (k = 0; k < 5; k++) {
          var ox2 = mx2 + rng.gaussian(0, 0.52), oz2 = mz2 + rng.gaussian(0, 0.46);
          var ls = rng.range(0.85, 1.65) * (k === 0 ? 1.6 : 1.0);
          this.putAt(rng.bool(0.45) ? 'chipM' : 'chip', ox2, this._ground(ox2, oz2) + 0.05, oz2,
            rng.range(0, 6.283), rng.range(-0.30, 0.30), rng.range(-0.30, 0.30),
            ls, ls * rng.range(0.55, 0.95), ls * rng.range(0.8, 1.2), this.wearTint(rng));
        }
        this.collider(mx2, this._ground(mx2, mz2) + 0.25, mz2, 0.7, 0.25, 0.6, 'stone');
        for (k = 0; k < 6; k++) {
          var fa3 = rng.range(0, 6.283), fr3 = rng.range(0.55, 1.35);
          this.plant(rng.bool(0.5) ? 'fernA' : 'grassA',
            mx2 + Math.cos(fa3) * fr3, mz2 + Math.sin(fa3) * fr3, rng.range(0, 6.283),
            rng.range(0.7, 1.2), rng.range(0.7, 1.3), rng.range(0.7, 1.2), 0.3, 0.03,
            this.leafTint(rng, rng.range(0, 0.45)));
        }
      }

      // an offering somebody left on the bottom step: a bowl and three sticks
      this.reset();
      this.wear = { grime: 0.68, wet: 0.92, edge: 0.78 };
      this.add('laterite', lathe([[0.00, 0], [0.10, 0.005], [0.135, 0.055], [0.125, 0.075]], 9),
        T(f.x + 1.35, this._ground(f.x + 1.35, f.z + 0.6), f.z + 0.6));
      this.wear = null;
      for (i = 0; i < 3; i++) {
        this.rod('cloth', f.x + 1.35, this._ground(f.x + 1.35, f.z + 0.6) + 0.05, f.z + 0.6,
          f.x + 1.35 + rng.range(-0.06, 0.06), this._ground(f.x + 1.35, f.z + 0.6) + 0.30,
          f.z + 0.6 + rng.range(-0.06, 0.06), 0.005, 4);
      }
      this.reset();
    }
  };

  // ==========================================================================
  // THE CAUSEWAY
  //
  // hero3's framing. The deck itself is level_ruins'; what it needs is
  // evidence of arrival - an offering post where the road meets the temple,
  // moss and grass in the deck joints AWAY from the trodden centre line, and
  // the moat margin choked with reed and floating weed so the two lower
  // corners of the frame are not empty water.
  // ==========================================================================
  PropsRuins.prototype._dressCauseway = function () {
    if (!this._ok || !this.A.causeway) return;
    var C = this.A.causeway;
    var rng = this.rng.fork ? this.rng.fork(0x6C41) : this.rng;
    var i, s;

    // ---- the offering post at the head of the road -------------------------
    // ON the deck, inboard of the balustrade. nagaL is the balustrade centre
    // line and the deck ends 34 cm outboard of it, so anything placed further
    // out than that is standing on the moat revetment - which is where the
    // first pass put it.
    // At the TEMPLE end of the road. The first pass put it at z1, the far end
    // where the causeway starts - which is off the back of every framing that
    // looks at the gate, and, more to the point, an offering post is set
    // where you arrive at the sanctuary, not where you leave the jungle.
    var ox = -(C.half - 1.05), oz = C.z0 + 3.4;
    var ogy = this._ground(ox, oz);
    this.reset();
    this.wear = { grime: 0.58, wet: 0.88, edge: 0.60 };
    this.b('stone', 0.62, 0.24, 0.62, ox, ogy + 0.12, oz);
    this.c('stone', 0.135, 0.165, 1.30, ox, ogy + 0.86, oz, 0, 0.3, 0.03, 8);
    this.b('stone', 0.44, 0.10, 0.44, ox, ogy + 1.56, oz, 0, 0.3, 0.03);
    this.b('stone', 0.36, 0.34, 0.36, ox, ogy + 1.78, oz, 0, 0.3, 0.03);
    // a small face on each of its four sides - the level's motif, in miniature
    for (i = 0; i < 4; i++) {
      var fa = i * 1.5708 + 0.3;
      this.b('carve', 0.20, 0.035, 0.04, ox + Math.sin(fa) * 0.185, ogy + 1.86,
        oz + Math.cos(fa) * 0.185, 0, fa, 0);
      this.b('carve', 0.14, 0.028, 0.035, ox + Math.sin(fa) * 0.185, ogy + 1.72,
        oz + Math.cos(fa) * 0.185, 0, fa, 0);
    }
    this.b('stone', 0.24, 0.14, 0.24, ox, ogy + 1.99, oz, 0, 0.3, 0.03);
    this.wear = null;
    // saffron tied round it, and a bowl of ash at its foot
    this.wear = { grime: 0.84, wet: 0.96, edge: 0.94 };
    this.b('saffron', 0.30, 0.20, 0.30, ox, ogy + 1.20, oz, 0, 0.3, 0.03);
    this.b('saffron', 0.10, 0.46, 0.04, ox + 0.10, ogy + 0.94, oz + 0.14, 0.05, 0.3, 0.10);
    this.wear = null;
    this.wear = { grime: 0.66, wet: 0.90, edge: 0.76 };
    this.add('laterite', lathe([[0.00, 0], [0.11, 0.005], [0.145, 0.06], [0.135, 0.08]], 9),
      T(ox + 0.22, ogy + 0.25, oz + 0.28));
    this.wear = null;
    this._candle(ox + 0.22, ogy + 0.29, oz + 0.28, 0.10, 1.0);
    this._candle(ox - 0.16, ogy + 0.25, oz + 0.30, 0.07, 1.0);
    this.mark(0, ox, oz + 0.4, 1.3, 1.1, 0.2);
    this.reset();
    this.collider(ox, ogy + 1.0, oz, 0.32, 1.0, 0.32, 'stone');
    this._claim(ox, oz, 0.8);

    // ---- what blows onto the deck and stops at the balustrade ---------------
    // The deck is 32 m of dark wet stone in the arrival framing and the one
    // thing that reads on it at this exposure is DRY LEAF, which is paler than
    // the stone rather than darker. It banks against the balustrade plinths,
    // because that is what a kerb does to anything the wind is pushing.
    for (i = 0; i < 90; i++) {
      var dz2 = rng.range(C.z0 + 1.0, C.z1 - 1.5);
      var sgn2 = rng.bool(0.5) ? -1 : 1;
      var dlat = sgn2 * rng.range(C.half * 0.34, C.half - 0.14);
      var bank = M.smoothstep(C.half * 0.3, C.half, Math.abs(dlat));
      if (!rng.bool(0.35 + bank * 0.55)) continue;
      this.putAt('litter', dlat, this._ground(dlat, dz2) + 0.018, dz2,
        rng.range(0, 6.283), 0, 0,
        rng.range(0.6, 1.35), 1, rng.range(0.6, 1.35), this.leafTint(rng, rng.range(0.7, 1.0)));
    }
    // two water jars set down where the road meets the gate ramp
    for (i = -1; i <= 1; i += 2) {
      var jx2 = i * (C.half - 0.95), jz2 = C.z0 + 1.5;
      if (this._blocked(jx2, jz2, 0.3, 0.9) || this._step(jx2, jz2, 0.34) > 0.10) continue;
      this.plant('jar', jx2, jz2, rng.range(0, 6.283), rng.range(0.9, 1.1), 1, 1, 0.32,
        0.02, this.wearTint(rng));
      this.mark(3, jx2, jz2, 1.05, 1.05, rng.range(0, 3), { grime: 1, wet: 0.55, edge: 1 });
      this.collider(jx2, this._ground(jx2, jz2) + 0.32, jz2, 0.3, 0.32, 0.3, 'stone');
    }

    // ---- moss and grass in the deck joints, off the walking line -----------
    // The centre 2.2 m of a 7.2 m deck is swept clean by feet. Everything
    // grows in the outer thirds and against the balustrade plinths, which is
    // exactly the pattern that makes a road read as a used road.
    for (i = 0; i < 620; i++) {
      var z = rng.range(C.z0 + 0.5, C.z1 - 1.0);
      var lat = rng.range(-C.half + 0.2, C.half - 0.2);
      var edge = M.smoothstep(1.1, C.half - 0.15, Math.abs(lat));
      if (!rng.bool(edge * 0.85)) continue;
      var x = lat;
      if (this._blocked(x, z, 0.10, 0.5)) continue;
      var kind = rng.bool(0.55) ? 'moss' : (rng.bool(0.6) ? 'grassB' : 'grassA');
      this.plant(kind, x, z, rng.range(0, 6.283),
        rng.range(0.62, 1.25) * (0.6 + 0.6 * edge), rng.range(0.6, 1.25), rng.range(0.62, 1.25),
        0.22, 0.03, this.leafTint(rng, rng.range(0.2, 0.7)));
    }
    // the balustrade plinths shed, so grit banks along their inner face
    for (s = -1; s <= 1; s += 2) {
      var bx = s * (C.half + 0.02);
      for (i = 0; i < 46; i++) {
        var gz2 = rng.range(C.z0 + 1.0, C.z1 - 1.0);
        if (!rng.bool(0.55)) continue;
        var gx2 = bx - s * rng.range(0.10, 0.60);
        this.putAt('grit', gx2, this._ground(gx2, gz2) + 0.015, gz2,
          rng.range(0, 6.283), rng.range(-0.3, 0.3), rng.range(-0.3, 0.3),
          rng.range(0.35, 0.85), rng.range(0.3, 0.7), rng.range(0.5, 1.0), this.wearTint(rng));
      }
    }
  };

  // ==========================================================================
  // THE WATER  (anchors.pools)
  //
  // Standing water is the brightest surface in this level - a still sheet at
  // grazing incidence returns the burning dawn horizon almost intact - so it
  // is also the surface a prop can do the most damage to. The rule here is:
  // NOTHING covers the middle of a pool. Lily and lotus mass at the MARGINS
  // and in the corners, reed grows on the bank, and the open centre is left to
  // do its job of carrying light into the bottom of every frame.
  // ==========================================================================
  PropsRuins.prototype._dressWater = function () {
    if (!this._ok) return;
    var pools = this.A.pools || [];
    var rng = this.rng.fork ? this.rng.fork(0x77A2) : this.rng;
    var i, k;

    for (i = 0; i < pools.length; i++) {
      var p = pools[i];
      var w = p.x1 - p.x0, d = p.z1 - p.z0;
      var area = w * d;
      var moat = p.name && p.name.indexOf('moat') === 0;
      // the moat is 32 m long and mostly seen at a distance; the courtyard
      // pools are seen from two metres, so they get the detail
      // A `shallow` sheet is a rain film lying on flagstones, not a pond: a
      // lily needs 20 cm of standing water and a root in mud, so it gets pads
      // and lotus at zero and keeps only the bank growth.
      var want = p.shallow ? 0 : Math.round(area * (moat ? 0.055 : 0.115));
      for (k = 0; k < want; k++) {
        // bias hard toward the edge: sample a point, then push it outward
        var ex = rng.next(), ez = rng.next();
        var bx = M.lerp(p.x0, p.x1, ex), bz = M.lerp(p.z0, p.z1, ez);
        var edgeD = Math.min(Math.min(bx - p.x0, p.x1 - bx), Math.min(bz - p.z0, p.z1 - bz));
        var keep = M.smoothstep(Math.min(w, d) * 0.42, 0.15, edgeD);
        if (!rng.bool(keep * 0.92)) continue;
        var s = rng.range(0.55, 1.35) * (moat ? 1.25 : 1.0);
        this.putAt('lily', bx, p.waterY + 0.012, bz, rng.range(0, 6.283), 0, 0,
          s, 1, s * rng.range(0.85, 1.15), this.leafTint(rng, rng.range(0, 0.45)));
        // a lotus every so often, and only where the pads are thick
        if (rng.bool(0.16)) {
          this.putAt('lotus', bx + rng.range(-0.3, 0.3), p.waterY + 0.028, bz + rng.range(-0.3, 0.3),
            rng.range(0, 6.283), 0, 0, rng.range(0.7, 1.1), 1, rng.range(0.7, 1.1),
            this.leafTint(rng, 0.15));
        }
      }

      // ---- reed on the bank, thickest in the corners ------------------------
      var per = 2 * (w + d);
      var nr = Math.round(per * (moat ? 0.55 : 0.85));
      for (k = 0; k < nr; k++) {
        var t = k / nr * 4;
        var side = t | 0, u = t - side;
        var rx, rz;
        if (side === 0) { rx = M.lerp(p.x0, p.x1, u); rz = p.z0; }
        else if (side === 1) { rx = p.x1; rz = M.lerp(p.z0, p.z1, u); }
        else if (side === 2) { rx = M.lerp(p.x1, p.x0, u); rz = p.z1; }
        else { rx = p.x0; rz = M.lerp(p.z1, p.z0, u); }
        // corners collect: the closer to a corner, the denser the stand
        var corner = M.smoothstep(0.5, 0.05, Math.min(u, 1 - u));
        if (!rng.bool(0.34 + corner * 0.5)) continue;
        var off = rng.range(-0.55, 0.75);
        rx += (side === 1 ? off : (side === 3 ? -off : 0)) + rng.range(-0.35, 0.35);
        rz += (side === 2 ? off : (side === 0 ? -off : 0)) + rng.range(-0.35, 0.35);
        if (this._blocked(rx, rz, 0.10, 0.6)) continue;
        var gy = this._ground(rx, rz);
        // a reed stands in shallow water or on a wet bank, never on dry stone
        if (gy > p.waterY + 0.55 || gy < p.waterY - 0.65) continue;
        this.plant('reed', rx, rz, rng.range(0, 6.283),
          rng.range(0.7, 1.25), rng.range(0.65, 1.35), rng.range(0.7, 1.25),
          0.25, 0.06, this.leafTint(rng, rng.range(0.15, 0.75)));
      }
    }
  };

  // ==========================================================================
  // GROWTH
  //
  // The single biggest opportunity to fail this level is to scatter foliage
  // uniformly. Plants are not distributed at random; they are distributed by
  // WATER, SHADE, SHELTER and CRACKS, and every placement below is driven by
  // one of those four:
  //
  //   wall feet         run-off concentrates there and nothing walks there
  //   pillar bases      same, plus the shelter of the colonnade
  //   inner corners     two walls of shelter, so the densest growth anywhere
  //   flagstone joints  the only crack a seed can reach soil through
  //   wall caps         a cap holds a centimetre of soil, so it grows saplings
  //   pool margins      obvious, and the only place reed and elephant-ear go
  //   the worn path     NOTHING, ever - that is what makes it read as a path
  // ==========================================================================
  PropsRuins.prototype._wallLines = function () {
    var A = this.A, out = [];
    var G = A.gallery, E = A.enclosure, TR = A.terrace;
    if (G) {
      var t = G.wallT === undefined ? 0.9 : G.wallT;
      // the gallery's outer face, all four runs, outside the ring
      out.push({ ax: 'x', a0: G.x0, a1: G.x1, b: G.z1, out: 1, y: 0.28, h: 4.8, cap: G.capY });
      out.push({ ax: 'x', a0: G.x0, a1: G.x1, b: G.z0, out: -1, y: 0.28, h: 4.8, cap: G.capY });
      out.push({ ax: 'z', a0: G.z0, a1: G.z1, b: G.x0, out: -1, y: 0.28, h: 4.8, cap: G.capY });
      out.push({ ax: 'z', a0: G.z0, a1: G.z1, b: G.x1, out: 1, y: 0.28, h: 4.8, cap: G.capY });
      // and the inner face onto the courtyard, where the pillars stand
      out.push({ ax: 'x', a0: G.x0 + 4, a1: G.x1 - 4, b: G.z1 - t - 3.4, out: -1, y: 0.28, h: 0, inner: 1 });
      out.push({ ax: 'x', a0: G.x0 + 4, a1: G.x1 - 4, b: G.z0 + t + 3.4, out: 1, y: 0.28, h: 0, inner: 1 });
    }
    if (E) {
      out.push({ ax: 'x', a0: E.x0, a1: E.x1, b: E.z1, out: 1, y: 0.16, h: 2.5, cap: E.capY });
      out.push({ ax: 'z', a0: E.z0, a1: E.z1, b: E.x0, out: -1, y: 0.16, h: 2.5, cap: E.capY });
      out.push({ ax: 'z', a0: E.z0, a1: E.z1, b: E.x1, out: 1, y: 0.16, h: 2.5, cap: E.capY });
    }
    if (TR && TR.tiers) {
      for (var i = 0; i < TR.tiers.length; i++) {
        var ti = TR.tiers[i];
        out.push({ ax: 'x', a0: ti.x0, a1: ti.x1, b: ti.z1, out: 1, y: ti.y - 1.8, h: 1.7, tier: 1 });
        out.push({ ax: 'x', a0: ti.x0, a1: ti.x1, b: ti.z0, out: -1, y: ti.y - 1.8, h: 1.7, tier: 1 });
        out.push({ ax: 'z', a0: ti.z0, a1: ti.z1, b: ti.x0, out: -1, y: ti.y - 1.8, h: 1.7, tier: 1 });
        out.push({ ax: 'z', a0: ti.z0, a1: ti.z1, b: ti.x1, out: 1, y: ti.y - 1.8, h: 1.7, tier: 1 });
      }
    }
    return out;
  };

  // Is this point on the bare crown of the overview knoll? The mound is a
  // collapsed boundary shrine under a metre of soil: the rain runs off it, the
  // soil is thin, and nothing with mass grows there. Every pass that is not
  // the knoll's own pass has to know that, because the establishing standpoint
  // stands on it.
  PropsRuins.prototype._onCrest = function (x, z) {
    var K = this.A && this.A.knoll;
    if (!K || !K.centre) return false;
    var dx = x - K.centre.x, dz = z - K.centre.z;
    var r = (K.radius || 17) * 0.62;
    return (dx * dx + dz * dz) < r * r;
  };

  PropsRuins.prototype._dressGrowth = function () {
    if (!this._ok) return;
    var rng = this.rng.fork ? this.rng.fork(0x6C0E) : this.rng;
    var A = this.A;
    var lines = this._wallLines();
    var i, k, L, a, x, z;

    // ---- 1. the foot of every wall -----------------------------------------
    for (k = 0; k < lines.length; k++) {
      L = lines[k];
      var span = L.a1 - L.a0;
      var n = Math.round(Math.abs(span) / 0.46);
      for (i = 0; i < n; i++) {
        a = L.a0 + (i + 0.5) * span / n + rng.range(-0.25, 0.25);
        // A wall does not grow moss evenly. The pattern comes from a noise
        // field along the run, so there are bare stretches and thick stands.
        var dens = M.saturate(this.noise.fbm2(a * 0.17 + k * 7.3, L.b * 0.11, 3) * 1.6 + 0.34);
        var off = L.out * (0.14 + Math.abs(rng.gaussian(0, 0.55)));
        x = L.ax === 'x' ? a : L.b + off;
        z = L.ax === 'x' ? L.b + off : a;
        // shade: the sun is 31.6 degrees west of -Z, so a face turned away
        // from that bearing stays damp all morning and grows more
        var facing = (L.ax === 'x' ? (L.out * this._sun.z) : (L.out * this._sun.x));
        var shade = M.saturate(0.5 - facing * 0.5);
        var wet = M.smoothstep(11.0, 1.0, this._waterDist(x, z));
        var p = dens * (0.34 + shade * 0.42 + wet * 0.34);
        if (this._pathDist(x, z) < 2.0) p *= 0.10;
        if (!rng.bool(p * 0.80)) continue;
        if (this._blocked(x, z, 0.10, 0.7)) continue;
        var near = 1 - M.saturate(Math.abs(off) / 1.4);
        var kind;
        var r2 = rng.next();
        if (r2 < 0.30 + shade * 0.22) kind = 'fernA';
        else if (r2 < 0.55) kind = 'fernB';
        else if (r2 < 0.74) kind = 'grassA';
        else if (r2 < 0.94) kind = 'moss';
        else kind = 'flower';
        var s = rng.range(0.55, 1.20) * (0.65 + 0.55 * near);
        this.plant(kind, x, z, rng.range(0, 6.283), s, s * rng.range(0.8, 1.25), s,
          0.3, 0.03, this.leafTint(rng, M.saturate(rng.range(-0.2, 0.9) - shade * 0.4)));
      }
    }

    // ---- 2. the inner corners, which are the wettest, most sheltered spots --
    var G = A.gallery;
    if (G) {
      var corners = [
        [G.x0 + 1.2, G.z1 - 1.2], [G.x1 - 1.2, G.z1 - 1.2],
        [G.x0 + 1.2, G.z0 + 1.2], [G.x1 - 1.2, G.z0 + 1.2],
        [G.x0 - 1.0, G.z1 + 1.0], [G.x1 + 1.0, G.z1 + 1.0],
        [G.x0 - 1.0, G.z0 - 1.0], [G.x1 + 1.0, G.z0 - 1.0]
      ];
      for (k = 0; k < corners.length; k++) {
        for (i = 0; i < 16; i++) {
          var ca = rng.range(0, 6.283), cr = Math.abs(rng.gaussian(0, 1.5));
          x = corners[k][0] + Math.cos(ca) * cr;
          z = corners[k][1] + Math.sin(ca) * cr;
          if (this._blocked(x, z, 0.12, 0.8)) continue;
          var cs = rng.range(0.7, 1.4) * M.smoothstep(4.0, 0.4, cr);
          if (cs < 0.22) continue;
          this.plant(rng.bool(0.5) ? 'fernA' : (rng.bool(0.5) ? 'bigleaf' : 'fernB'),
            x, z, rng.range(0, 6.283), cs, cs * rng.range(0.85, 1.2), cs, 0.4, 0.04,
            this.leafTint(rng, rng.range(0, 0.35)));
        }
      }
    }

    // ---- 3. grass in the flagstone joints, and never on the path -----------
    var CY = A.courtyard;
    if (CY) {
      for (i = 0; i < 5200; i++) {
        x = rng.range(CY.x0 + 0.5, CY.x1 - 0.5);
        z = rng.range(CY.z0 + 0.5, CY.z1 - 0.5);
        var pd = this._pathDist(x, z);
        // the joint density field: grass gets into the courtyard from its
        // edges and from the wet corners, not out of the middle of the paving
        var jd = M.saturate(this.noise.fbm2(x * 0.085 - 4.0, z * 0.085 + 9.0, 3) * 1.5 + 0.58);
        var wetf = M.smoothstep(9.0, 0.8, this._waterDist(x, z));
        var edge = M.smoothstep(2.0, 11.0, Math.min(
          Math.min(x - CY.x0, CY.x1 - x), Math.min(z - CY.z0, CY.z1 - z)));
        var pr = jd * (0.46 + wetf * 0.62) * (1 - edge * 0.40) * M.smoothstep(1.4, 5.5, pd);
        if (!rng.bool(pr)) continue;
        if (this._blocked(x, z, 0.10, 0.5)) continue;
        var gk = rng.bool(0.42) ? 'grassB' : (rng.bool(0.55) ? 'grassA' : 'moss');
        this.plant(gk, x, z, rng.range(0, 6.283),
          rng.range(0.55, 1.20), rng.range(0.5, 1.25), rng.range(0.55, 1.20),
          0.22, 0.03, this.leafTint(rng, rng.range(0.1, 0.85)));
      }
    }

    // ---- 4. saplings and creeper ON the masonry -----------------------------
    // A wall cap holds a centimetre of soil and a bird drops a seed in it.
    // This is the thing that makes a ruin read as a ruin rather than as a
    // building - vegetation ABOVE head height, growing out of the structure.
    for (k = 0; k < lines.length; k++) {
      L = lines[k];
      if (!L.cap) continue;
      var cn = Math.round(Math.abs(L.a1 - L.a0) / 2.4);
      for (i = 0; i < cn; i++) {
        a = L.a0 + (i + 0.5) * (L.a1 - L.a0) / cn + rng.range(-0.8, 0.8);
        var cd = M.saturate(this.noise.fbm2(a * 0.13 + k * 11.0, 3.0, 2) * 1.7 + 0.20);
        if (!rng.bool(cd * 0.42)) continue;
        x = L.ax === 'x' ? a : L.b + L.out * rng.range(-0.25, 0.25);
        z = L.ax === 'x' ? L.b + L.out * rng.range(-0.25, 0.25) : a;
        var ss = rng.range(0.45, 1.05);
        this.putAt(rng.bool(0.62) ? 'sapling' : 'grassA', x, L.cap - 0.05, z,
          rng.range(0, 6.283), rng.range(-0.12, 0.12), rng.range(-0.12, 0.12),
          ss, ss * rng.range(0.8, 1.3), ss, this.leafTint(rng, rng.range(0.1, 0.6)));
        // and the vine that hangs back down off the cap it grew on
        if (rng.bool(0.42)) {
          this.putAt('vine', x + L.out * 0.20, L.cap - 0.30, z + (L.ax === 'x' ? L.out * 0.20 : 0),
            rng.range(0, 6.283), 0, 0,
            rng.range(0.55, 1.05), rng.range(0.45, 1.0), 1, this.leafTint(rng, rng.range(0, 0.4)));
        }
      }
      // creeper up the shaded faces
      if (L.h < 1.0) continue;
      var vn = Math.round(Math.abs(L.a1 - L.a0) / 2.2);
      for (i = 0; i < vn; i++) {
        a = L.a0 + (i + 0.5) * (L.a1 - L.a0) / vn + rng.range(-0.7, 0.7);
        var vfacing = (L.ax === 'x' ? (L.out * this._sun.z) : (L.out * this._sun.x));
        var vshade = M.saturate(0.5 - vfacing * 0.55);
        var vd = M.saturate(this.noise.fbm2(a * 0.10 - k * 5.1, 17.0, 3) * 1.8 + 0.15);
        // The terrace facings get more of it than the gallery does: they are
        // 14 m of unbroken batter in the middle of the courtyard framing, and
        // they are the wettest masonry on the site because three tiers of
        // paving above them drain over their faces.
        var boost = L.tier ? 1.85 : 1.0;
        if (!rng.bool(vd * (0.18 + vshade * 0.55) * boost)) continue;
        x = L.ax === 'x' ? a : L.b + L.out * 0.07;
        z = L.ax === 'x' ? L.b + L.out * 0.07 : a;
        var yaw = L.ax === 'x' ? (L.out > 0 ? 0 : Math.PI) : (L.out > 0 ? 1.5708 : -1.5708);
        var vs2 = rng.range(0.6, 1.25);
        this.putAt('creeper', x, L.y + rng.range(-0.1, 0.35), z, yaw, 0, rng.range(-0.10, 0.10),
          vs2, vs2 * rng.range(0.7, 1.35), 1, this.leafTint(rng, rng.range(0, 0.5)));
      }
    }

    // ---- 5. under the trees the level planted ------------------------------
    // Elephant-ear and big understory go where the canopy already is: the
    // litter, the shade and the drip line are all already right there.
    var trees = A.trees || [];
    for (k = 0; k < trees.length; k++) {
      var tr = trees[k];
      var rad = Math.max(3.0, tr.height * 0.34);
      for (i = 0; i < 30; i++) {
        var ta = rng.range(0, 6.283);
        var trr = rad * (0.25 + 0.85 * Math.sqrt(rng.next()));
        x = tr.centre.x + Math.cos(ta) * trr;
        z = tr.centre.z + Math.sin(ta) * trr;
        if (this._blocked(x, z, 0.12, 0.9)) continue;
        if (this._pathDist(x, z) < 2.2) continue;
        if (this._onCrest(x, z)) continue;
        var big = rng.bool(0.40);
        var bs = rng.range(0.6, 1.35);
        this.plant(big ? 'bigleaf' : (rng.bool(0.5) ? 'fernA' : 'flower'),
          x, z, rng.range(0, 6.283), bs, bs * rng.range(0.8, 1.25), bs, 0.4, 0.04,
          this.leafTint(rng, rng.range(0, 0.4)));
      }
      // ---- aerial root off the crown ----------------------------------------
      // AN AERIAL ROOT ENDS IN SOIL. THAT IS THE WHOLE POINT OF ONE.
      //
      // The first pass hung a 2.3 m card from 0.42-0.66 of the tree's height at
      // a random 0.7-1.4 x 0.8-1.8 scale and up to (radius*2.4 + 1.2) m out from
      // the trunk. Measured on hero3 - the arrival framing - that put a cluster
      // of pale straps in the top-left with a hard straight top edge, no
      // attachment to any branch, and a FREE LOWER END stopping three metres
      // above the causeway with nothing under it. It came back at L 0.435
      // against the gate tower's 0.297, i.e. the brightest large mass in the
      // frame was a floating sheet of paper; the same asset hung in the middle
      // of the interior framing under the collapsed roof bay.
      //
      // Two structural mistakes, and neither is a tuning problem:
      //
      //  (1) THE LENGTH WAS NOT THE DROP. A strangler fig sends its roots down
      //      to the ground and they thicken there; a rope that stops in mid-air
      //      has no reading available to it except "torn cloth". The card's
      //      pivot is at its TOP (see the `down:true` kit entry), so the y scale
      //      IS the reach - solve it against the measured ground under the hang
      //      point instead of drawing it from a range, and skip the site
      //      entirely when the drop is too tall for one card to explain.
      //  (2) THE VALUE WAS ABOVE THE STONE. leafTint(0.8) is a DRY tint - up to
      //      (1.29, 1.20, 0.80) - multiplying an atlas cell that is already a
      //      pale grey-tan rope. Against a temple whose lit masonry measures
      //      0.30 that lands the roots brighter than the building. They are wet
      //      bark hanging in shade: the tint now sits them under it.
      for (i = 0; i < 10; i++) {
        var aa = rng.range(0, 6.283);
        // in under the crown, not out past its edge - a root hangs from a limb
        var ar = rng.range(0.35, Math.max(0.9, tr.radius * 1.45));
        var rx = tr.centre.x + Math.cos(aa) * ar;
        var rz = tr.centre.z + Math.sin(aa) * ar;
        var hangY = tr.centre.y + tr.height * rng.range(0.30, 0.52);
        var drop = hangY - this._ground(rx, rz);
        // too short to read, or too tall for one card to reach without the
        // rope drawing stretching into ribbon
        if (drop < 1.6 || drop > 8.5) continue;
        // it reaches the soil, give or take the last handspan
        var reach = drop + rng.range(-0.15, 0.10);
        var arw = rng.range(0.55, 1.05);
        _tc.setRGB(rng.range(0.40, 0.62), rng.range(0.38, 0.58), rng.range(0.32, 0.48));
        this.putAt('aroot', rx, hangY, rz, rng.range(0, 6.283), 0, 0,
          arw, reach / 2.30, arw, _tc);
      }
    }

    // ---- 6. the collapse rubble is the best seedbed on the site ------------
    var rub = A.rubble || [];
    for (k = 0; k < rub.length; k++) {
      var R = rub[k];
      for (i = 0; i < 22; i++) {
        var ra2 = rng.range(0, 6.283), rr2 = R.radius * Math.sqrt(rng.next());
        x = R.centre.x + Math.cos(ra2) * rr2;
        z = R.centre.z + Math.sin(ra2) * rr2;
        if (this._blocked(x, z, 0.12, 0.8)) continue;
        var rs = rng.range(0.5, 1.15);
        this.plant(rng.bool(0.35) ? 'sapling' : (rng.bool(0.5) ? 'fernB' : 'grassA'),
          x, z, rng.range(0, 6.283), rs, rs * rng.range(0.8, 1.3), rs, 0.3, 0.04,
          this.leafTint(rng, rng.range(0.1, 0.6)));
      }
    }

    // ---- 7. the knoll --------------------------------------------------------
    // A hill crest is the DRIEST, most exposed ground on a site: the rain runs
    // off it, the wind scours it and the soil is thin. Everything big lives on
    // the flanks and in the gullies. That is also, not coincidentally, what
    // stops a three-metre elephant-ear leaf standing on the summit - which is
    // exactly where the first pass put one, filling a third of the
    // establishing frame with a black silhouette. The rule is the physics, not
    // the framing: mass grows with distance DOWN from the crest.
    var K = A.knoll;
    if (K) {
      for (i = 0; i < 240; i++) {
        var ka = rng.range(0, 6.283), kt = rng.next();
        var kr = K.radius * (0.30 + 0.95 * Math.sqrt(kt));
        x = K.centre.x + Math.cos(ka) * kr;
        z = K.centre.z + Math.sin(ka) * kr;
        if (this._blocked(x, z, 0.15, 1.2)) continue;
        // 0 on the crest, 1 out on the flank
        var flank = M.smoothstep(K.radius * 0.30, K.radius * 0.80, kr);
        if (!rng.bool(0.25 + flank * 0.70)) continue;
        var ks = rng.range(0.55, 0.85) + flank * rng.range(0.15, 0.75);
        // THE SPECIES SELECTOR WAS INVERTED. `rng.next() * (0.35 + flank*0.85)`
        // produces its SMALLEST values on the crest, where flank is 0 - and the
        // smallest bucket is 'bigleaf'. So the rule that the comment above
        // spells out ("mass grows with distance DOWN from the crest, nothing
        // big stands on a scoured summit") was doing precisely the opposite,
        // and the establishing shot's foreground was a bank of three-metre
        // elephant-ear leaves and white flowers two metres from the lens.
        // Selecting ON flank rather than on a value scaled BY it: the crest
        // gets grass and low fern, the flank and the gullies get the mass.
        var kr2 = rng.next();
        var kind2;
        if (kr2 < 0.34 * flank * flank) kind2 = 'bigleaf';
        else if (kr2 < 0.30 + 0.30 * flank) kind2 = 'fernA';
        else if (kr2 < 0.62 + 0.12 * flank) kind2 = 'grassA';
        else if (kr2 < 0.84) kind2 = 'fernB';
        else kind2 = flank > 0.55 ? 'sapling' : 'grassB';
        this.plant(kind2,
          x, z, rng.range(0, 6.283), ks, ks * rng.range(0.8, 1.25), ks, 0.45, 0.05,
          this.leafTint(rng, rng.range(0, 0.45)));
      }
    }

    // ---- 8. the jungle margin all round the precinct -----------------------
    var site = A.site;
    if (site) {
      for (i = 0; i < 900; i++) {
        x = rng.range(site.x0 + 3, site.x1 - 3);
        z = rng.range(site.z0 + 3, site.z1 - 3);
        // only outside the precinct and off the causeway
        var inPrecinct = (Math.abs(x) < 33 && z > -46 && z < 27);
        var onRoad = (Math.abs(x) < 27 && z > 22 && z < 60);
        if (inPrecinct || onRoad) continue;
        // THE KNOLL HAS ITS OWN PASS AND ITS OWN RULE. This one does not know
        // about the mound, and 40% of what it plants is a three-metre
        // elephant-ear leaf - so it was seeding the establishing shot's own
        // standpoint, and what the published overview carried in its
        // bottom-right corner was a bank of clip-art foliage a metre and a
        // half from the lens. A scoured hill crest grows grass.
        if (this._onCrest(x, z)) continue;
        if (this._blocked(x, z, 0.15, 1.2)) continue;
        var dj = M.saturate(this.noise.fbm2(x * 0.055 + 2.0, z * 0.055 - 6.0, 3) * 1.5 + 0.5);
        if (!rng.bool(dj * 0.55)) continue;
        var js = rng.range(0.8, 1.9);
        var jk = rng.next();
        this.plant(jk < 0.40 ? 'bigleaf' : (jk < 0.70 ? 'fernA' : (jk < 0.88 ? 'sapling' : 'flower')),
          x, z, rng.range(0, 6.283), js, js * rng.range(0.8, 1.3), js, 0.5, 0.05,
          this.leafTint(rng, rng.range(0, 0.4)));
      }
    }
  };

  // ==========================================================================
  // WATER STAINING - the drip pass
  //
  // The finding, and it is the first of the four weathering behaviours the
  // brief names: "no masonry anywhere in the seven frames carries water
  // staining". Confirmed at 3x zoom on the centre prasat, which carries four
  // separate projecting horizontal mouldings with not one streak below any of
  // them; and on the 580 px enclosure wall that fills half the outer court.
  //
  // The finding proposed extending the wall-foot distribution loop. That loop
  // is the wrong place and it would have been guesswork: it walks the ANCHOR
  // BOXES, which know a wall's plan rectangle and nothing about where its
  // cornices are - and the towers taper, so a fixed half-width hangs the mark
  // in mid-air beside the silhouette (which is exactly how the first attempt
  // at gate-tower marks failed in level_ruins.js's own pass). So level_ruins.js
  // now RECORDS every projecting horizontal as it builds it - wall cornice
  // stations with their exact settlement, and prasat cornice rings with the
  // half-width of the storey underneath - and publishes the list as
  // anchors.cornices. This pass hangs the runs off it.
  //
  // Density follows SHADE, off the same term the growth pass uses: the sun
  // bears 31.6 degrees west of north, so a face turned away from that bearing
  // never dries and carries the heaviest, blackest staining, while a face that
  // takes the morning sun gets a paler mineral run instead. Nothing here is
  // scattered - every mark starts on a real drip edge and runs down.
  // ==========================================================================
  PropsRuins.prototype._shadeOf = function (nx, nz) {
    var l = Math.sqrt(nx * nx + nz * nz) || 1;
    var lit = (nx / l) * this._sun.x + (nz / l) * this._sun.z;
    return M.saturate(0.5 - lit * 0.52);
  };

  // One run of staining on a vertical face. `dy` is the drip edge, `len` how
  // far it runs, `yaw` the face's outward bearing.
  PropsRuins.prototype._streak = function (rng, x, dy, z, yaw, len, wide, shade) {
    // 4 dark water stain, 5 pale mineral/silt, 6 green algae weep. A shaded
    // face that never dries goes dark and eventually green; a face that sheds
    // fast leaves lime behind instead. Below about 0.35 of shade the dark run
    // simply is not what happens.
    var r = rng.next();
    var cell = (r < 0.58 + shade * 0.24) ? 4
      : (r < 0.86 + shade * 0.08 ? 5 : 6);
    // Value carried by the mark: the 'marks' bucket is not on the wear path
    // (see _paintFlat), so this is a plain multiplier on the texture. Pulled
    // down from 0.72, because the pale mineral runs were reading on the lit
    // elevations and the dark ones were not - and it is the dark drip that the
    // brief names first.
    var v = 0.58 + shade * 0.30 + rng.range(-0.09, 0.09);
    this.markWall(cell, x, dy - len * 0.5, z, wide, len, yaw,
      { grime: M.clamp(v, 0.35, 1.25), wet: 1, edge: 1 });
  };

  PropsRuins.prototype._dressStains = function () {
    if (!this._ok) return;
    var A = this.A;
    var rng = this.rng.fork ? this.rng.fork(0x5747) : this.rng;
    var i, k;

    // ---- 1. every cornice the level recorded as it built it -----------------
    var corn = A.cornices || [];
    for (i = 0; i < corn.length; i++) {
      var C0 = corn[i];
      if (C0.run) {
        // a wall-cornice station: two faces, at b +/- t/2
        var horiz = (C0.axis === 'x');
        var b0 = horiz ? C0.z : C0.x;
        for (var sgn = -1; sgn <= 1; sgn += 2) {
          var nx = horiz ? 0 : sgn, nz = horiz ? sgn : 0;
          var shade = this._shadeOf(nx, nz);
          // Two or three runs a station, at 0.62-0.96 of probability. The
          // first pass ran one at 0.36 and put about two streaks on a seven
          // metre wall, which photographed as no streaks at all. Real runoff
          // off a cornice finds every low point along the drip edge; the
          // moulding is continuous and the staining under it is nearly so.
          var nRun = 2 + (rng.bool(0.34 + shade * 0.44) ? 1 : 0);
          for (k = 0; k < nRun; k++) {
            if (!rng.bool(0.62 + shade * 0.34)) continue;
            // jittered along the moulding: run-off leaves a drip edge at its
            // LOW POINTS, not on a fringe, so the stations must not line up
            var al = rng.range(-C0.half * 0.86, C0.half * 0.86);
            var fx = horiz ? C0.x + al : b0 + sgn * (C0.t * 0.5 + 0.045);
            var fz = horiz ? b0 + sgn * (C0.t * 0.5 + 0.045) : C0.z + al;
            var yaw = horiz ? (sgn > 0 ? 0 : Math.PI) : (sgn > 0 ? 1.5708 : -1.5708);
            this._streak(rng, fx, C0.y - 0.05, fz, yaw,
              rng.range(1.5, 3.0), rng.range(0.95, 2.05), shade);
          }
        }
      } else if (C0.ring && !C0.face) {
        // a prasat cornice ring. The FACE storeys are skipped: a Bayon head
        // fills 87% of its storey's width and stands a metre proud of it, so a
        // streak laid at the storey's own half-width would be buried in the
        // carving or hanging in front of it.
        for (k = 0; k < 4; k++) {
          var ya = k * 1.5708;
          var sn = Math.sin(ya), cs = Math.cos(ya);
          var sh2 = this._shadeOf(sn, cs);
          var nq = 2 + (rng.bool(0.55 + sh2 * 0.40) ? 1 : 0);
          for (var q = 0; q < nq; q++) {
            if (!rng.bool(0.66 + sh2 * 0.30)) continue;
            var off = rng.range(-C0.hw * 0.62, C0.hw * 0.62);
            var rlen = Math.min(C0.drop * 0.88, rng.range(1.4, 2.8));
            if (rlen < 0.5) continue;
            this._streak(rng,
              C0.x + sn * (C0.hw + 0.05) + cs * off, C0.y - 0.04,
              C0.z + cs * (C0.hw + 0.05) - sn * off, ya,
              rlen, rng.range(0.85, 1.75), sh2);
          }
        }
      }
    }

    // ---- 2. the gallery eaves ------------------------------------------------
    // The gallery's outer wall carries no cornice - the corbelled vault sits
    // straight on it - so the drip edge is the vault's own overhang at roofY,
    // and it sheds along sixty metres of the longest wall in the level.
    var G = A.gallery;
    if (G && G.roofY) {
      var eaves = [
        { ax: 'x', a0: G.x0, a1: G.x1, b: G.z1, out: 1 },
        { ax: 'x', a0: G.x0, a1: G.x1, b: G.z0, out: -1 },
        { ax: 'z', a0: G.z0, a1: G.z1, b: G.x0, out: -1 },
        { ax: 'z', a0: G.z0, a1: G.z1, b: G.x1, out: 1 }
      ];
      for (i = 0; i < eaves.length; i++) {
        var E = eaves[i];
        var hz = (E.ax === 'x');
        var esh = this._shadeOf(hz ? 0 : E.out, hz ? E.out : 0);
        var en = Math.round(Math.abs(E.a1 - E.a0) / 2.3);
        for (k = 0; k < en; k++) {
          var ea = E.a0 + (k + 0.5) * (E.a1 - E.a0) / en + rng.range(-0.8, 0.8);
          // the west run is down over the breach - nothing to stain there
          if (E.ax === 'z' && E.out < 0 && ea > -22.5 && ea < -10.5) continue;
          var dens = M.saturate(this.noise.fbm2(ea * 0.14 + i * 6.1, E.b * 0.09, 3) * 1.5 + 0.36);
          if (!rng.bool(dens * (0.55 + esh * 0.45))) continue;
          var ex = hz ? ea : E.b + E.out * 0.055;
          var ez = hz ? E.b + E.out * 0.055 : ea;
          this._streak(rng, ex, G.roofY - 0.12, ez,
            hz ? (E.out > 0 ? 0 : Math.PI) : (E.out > 0 ? 1.5708 : -1.5708),
            rng.range(1.8, 3.4), rng.range(1.0, 2.2), esh);
        }
      }
    }

    // ---- 3. the library eaves ------------------------------------------------
    var libs = A.libraries || [];
    for (i = 0; i < libs.length; i++) {
      var L2 = libs[i];
      if (!L2.centre) continue;
      var lc = Math.cos(L2.yaw || 0), ls = Math.sin(L2.yaw || 0);
      for (k = 0; k < 10; k++) {
        var lq = (k % 4) * 1.5708 + (L2.yaw || 0);
        var lhw = ((k % 2) === 0 ? L2.w : L2.d) * 0.5 + 0.34;
        var lsn = Math.sin(lq), lcs = Math.cos(lq);
        var lsh = this._shadeOf(lsn, lcs);
        if (!rng.bool(0.34 + lsh * 0.46)) continue;
        var loff = rng.range(-lhw * 0.72, lhw * 0.72);
        this._streak(rng,
          L2.centre.x + lsn * lhw + lcs * loff, (L2.eave || 3.4) - 0.15,
          L2.centre.z + lcs * lhw - lsn * loff, lq,
          rng.range(1.3, 2.4), rng.range(0.8, 1.6), lsh);
      }
      void lc; void ls;
    }
  };

  // ==========================================================================
  // DEBRIS AND MARKS
  //
  // Where stone that has fallen off a building actually ends up: banked at the
  // foot of what it fell from, fanned out from the collapses, and drifted into
  // the corners. Plus the leaf drift, which follows the same rule for the same
  // reason - both of them are moved by gravity and stopped by obstacles.
  // ==========================================================================
  PropsRuins.prototype._dressDebris = function () {
    if (!this._ok) return;
    var A = this.A;
    var rng = this.rng.fork ? this.rng.fork(0x0DEB) : this.rng;
    var i, k, x, z;

    // ---- spall banked against every outer wall face ------------------------
    var lines = this._wallLines();
    for (k = 0; k < lines.length; k++) {
      var L = lines[k];
      if (L.inner) continue;
      var span = L.a1 - L.a0;
      var n = Math.round(Math.abs(span) / 0.85);
      for (i = 0; i < n; i++) {
        var a = L.a0 + (i + 0.5) * span / n + rng.range(-0.35, 0.35);
        var dens = M.saturate(this.noise.fbm2(a * 0.19 - k * 3.7, L.b * 0.13, 3) * 1.5 + 0.30);
        if (!rng.bool(dens * 0.55)) continue;
        // the bank profile: thick at the wall, thinning to nothing by ~1.5 m
        var off = L.out * (0.10 + Math.abs(rng.gaussian(0, 0.48)));
        x = L.ax === 'x' ? a : L.b + off;
        z = L.ax === 'x' ? L.b + off : a;
        if (this._pathDist(x, z) < 1.6) continue;
        var s = rng.range(0.35, 1.05) * (1.25 - Math.min(1.1, Math.abs(off)));
        if (s < 0.14) continue;
        this.putAt(rng.bool(0.20) ? 'chip' : 'grit', x, this._ground(x, z) + 0.02, z,
          rng.range(0, 6.283), rng.range(-0.35, 0.35), rng.range(-0.35, 0.35),
          s, s * rng.range(0.5, 0.95), s * rng.range(0.8, 1.25), this.wearTint(rng));
      }
    }

    // ---- laterite fragments round the existing rubble heaps ---------------
    var rub = A.rubble || [];
    for (k = 0; k < rub.length; k++) {
      var R = rub[k];
      for (i = 0; i < 40; i++) {
        var ra = rng.range(0, 6.283);
        var rr = R.radius * (0.55 + 0.85 * Math.sqrt(rng.next()));
        x = R.centre.x + Math.cos(ra) * rr;
        z = R.centre.z + Math.sin(ra) * rr;
        if (this._blocked(x, z, 0.14, 0.6)) continue;
        var rs = rng.range(0.35, 1.0) * M.smoothstep(R.radius * 1.7, R.radius * 0.3, rr);
        if (rs < 0.14) continue;
        this.putAt(rng.bool(0.42) ? 'brick' : (rng.bool(0.5) ? 'chip' : 'chipM'),
          x, this._ground(x, z) + 0.03, z,
          rng.range(0, 6.283), rng.range(-0.45, 0.45), rng.range(-0.45, 0.45),
          rs, rs * rng.range(0.5, 1.0), rs * rng.range(0.7, 1.2), this.wearTint(rng));
      }
      // DRY LEAF IN THE LEE OF THE HEAP.
      //
      // Every hero standpoint in this level has a block pile 3-5 m in front of
      // it, and the level's ground mist used to be the only warm thing in those
      // foregrounds - a near-field card wash which has now been removed for
      // slicing the blocks. Measured, taking it out cost the signature frame
      // half its grade split (highlight tint +0.030 R to +0.014 R), because a
      // warm veil over the foreground was doing the work of warm THINGS in it.
      // Dead leaf is the honest version: it is the one material on this site
      // that is both warm and PALER than the stone at this exposure, so it
      // reads on a shadowed floor where nothing else does, and gravity puts it
      // exactly here - banked against the up-wind face of the nearest obstacle.
      var lwd = this.uWindDir.value;
      for (i = 0; i < 26; i++) {
        var la = rng.range(0, 6.283);
        // biased into the lee: the heap stops what the wind is carrying
        var lw = -(Math.cos(la) * lwd.x + Math.sin(la) * lwd.y) * 0.5 + 0.5;
        if (!rng.bool(0.30 + lw * 0.60)) continue;
        var lr = R.radius * (0.70 + 0.70 * Math.sqrt(rng.next()));
        x = R.centre.x + Math.cos(la) * lr;
        z = R.centre.z + Math.sin(la) * lr;
        if (this._pathDist(x, z) < 1.3) continue;
        if (this._waterDist(x, z) < 0.8) continue;
        this.putAt('litter', x, this._ground(x, z) + 0.019, z, rng.range(0, 6.283), 0, 0,
          rng.range(0.7, 1.6), 1, rng.range(0.7, 1.6),
          this.leafTint(rng, rng.range(0.78, 1.0)));
      }
    }

    // ---- leaf drift: it collects where the wind stops ---------------------
    // Against the up-wind face of anything solid, in the tier re-entrants, and
    // under the trees. Never in the open middle of the courtyard, which is
    // where it would have blown out of.
    var wd = this.uWindDir.value;
    for (k = 0; k < lines.length; k++) {
      var L2 = lines[k];
      var facing = (L2.ax === 'x' ? (L2.out * wd.y) : (L2.out * wd.x));
      // 1 on the face the wind is blowing INTO
      var catchAmt = M.saturate(-facing * 0.5 + 0.5);
      if (catchAmt < 0.25) continue;
      var n2 = Math.round(Math.abs(L2.a1 - L2.a0) / 1.9);
      for (i = 0; i < n2; i++) {
        var a2 = L2.a0 + (i + 0.5) * (L2.a1 - L2.a0) / n2 + rng.range(-0.6, 0.6);
        if (!rng.bool(catchAmt * 0.72)) continue;
        var o2 = L2.out * rng.range(0.12, 1.05);
        x = L2.ax === 'x' ? a2 : L2.b + o2;
        z = L2.ax === 'x' ? L2.b + o2 : a2;
        if (this._pathDist(x, z) < 1.6) continue;
        this.putAt('litter', x, this._ground(x, z) + 0.018, z, rng.range(0, 6.283), 0, 0,
          rng.range(0.7, 1.5), 1, rng.range(0.7, 1.5), this.leafTint(rng, rng.range(0.75, 1.0)));
      }
    }
    var trees = A.trees || [];
    for (k = 0; k < trees.length; k++) {
      var tr = trees[k];
      for (i = 0; i < 22; i++) {
        var ta = rng.range(0, 6.283), trr = tr.height * 0.32 * Math.sqrt(rng.next());
        x = tr.centre.x + Math.cos(ta) * trr;
        z = tr.centre.z + Math.sin(ta) * trr;
        this.putAt('litter', x, this._ground(x, z) + 0.018, z, rng.range(0, 6.283), 0, 0,
          rng.range(0.8, 1.7), 1, rng.range(0.8, 1.7), this.leafTint(rng, rng.range(0.7, 1.0)));
      }
    }

    // ---- THE OUTER COURT'S OWN LEAF DRIFT ----------------------------------
    // This floor cannot be lit. The gallery's 5 m south wall stands between it
    // and a 9.6-degree sun, and its shadow is three times deeper than the court
    // is - so however good the stone is, the near half of the hero2 framing is
    // a surface whose only illuminant is the violet zenith, and it measures
    // there (L 0.16 against a gate at 0.31). The one material on the site that
    // is warm AND PALER than shadowed sandstone is dead leaf, which is why the
    // causeway deck already leans on it; the outer court had none away from the
    // spoil heaps.
    //
    // It is not scattered. Leaf on a swept court lies in the clumps where the
    // last shower of it landed and it is absent from the trodden centre line -
    // so the mask is a noise field thresholded at the station, the density
    // ramps with how far above that threshold the station is, and everything
    // within 2.4 m of the published worn path is rejected outright.
    var EN = A.enclosure, GP = A.gopura;
    if (EN && GP) {
      var cz1 = GP.centre.z - 4.2;                 // stop short of the gate ramp
      // 700 stations at a 0.40 threshold, not 340 at 0.46: the first pass moved
      // 7,387 pixels of a 921,600-pixel frame and did not shift a single metric,
      // which for a floor that is a third of the picture means it was not there.
      for (i = 0; i < 700; i++) {
        x = rng.range(EN.x0 + 1.6, EN.x1 - 1.6);
        z = rng.range(EN.z0 + 0.4, cz1);
        if (this._pathDist(x, z) < 2.4) continue;
        var dens2 = this.noise.fbm2(x * 0.28 + 61.0, z * 0.28 - 17.0, 3) * 0.5 + 0.5;
        if (dens2 < 0.40) continue;
        if (!rng.bool((dens2 - 0.40) * 2.9)) continue;
        if (this._blocked(x, z, 0.12, 0.7)) continue;
        var ls = rng.range(0.70, 1.55) * (0.6 + 0.7 * dens2);
        this.putAt(rng.bool(0.78) ? 'litter' : 'straw',
          x, this._ground(x, z) + 0.017, z, rng.range(0, 6.283), 0, 0,
          ls, 1, ls * rng.range(0.8, 1.25),
          this.leafTint(rng, rng.range(0.72, 1.0)));
      }
    }

    // ---- bird lime under the tower cornices --------------------------------
    var towers = A.towers || [];
    for (k = 0; k < towers.length; k++) {
      var tw = towers[k];
      if (tw.fallen) continue;
      for (i = 0; i < 6; i++) {
        var fa = (i % 4) * 1.5708;
        this.markWall(2,
          tw.centre.x + Math.sin(fa) * (tw.halfW + 0.05) + Math.cos(fa) * rng.range(-tw.halfW * 0.6, tw.halfW * 0.6),
          tw.baseY + (tw.apexY - tw.baseY) * rng.range(0.30, 0.62),
          tw.centre.z + Math.cos(fa) * (tw.halfW + 0.05) - Math.sin(fa) * rng.range(-tw.halfW * 0.6, tw.halfW * 0.6),
          rng.range(0.7, 1.5), rng.range(1.4, 2.8), fa, { grime: 1, wet: 1, edge: 1 });
      }
    }
  };

  // ==========================================================================
  // COMMIT
  //
  // One InstancedMesh per kit item, sized to exactly what was collected, and
  // one merged mesh per material for everything one-off. Nothing here can
  // overflow a cap because nothing here has one.
  // ==========================================================================
  PropsRuins.prototype._commit = function () {
    var keys, k, i;

    // ---- instanced ---------------------------------------------------------
    keys = Object.keys(this.I);
    for (k = 0; k < keys.length; k++) {
      var B = this.I[keys[k]];
      if (!B || !B.list.length) {
        if (B && B.geo && B.geo.dispose) B.geo.dispose();
        continue;
      }
      var mesh = new THREE.InstancedMesh(B.geo, B.mat, B.list.length);
      mesh.name = 'ruinsprop_' + keys[k];
      mesh.castShadow = B.cast;
      mesh.receiveShadow = B.recv;
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      for (i = 0; i < B.list.length; i++) {
        mesh.setMatrixAt(i, B.list[i].m);
        // Always write a colour. instanceColor is allocated lazily and an
        // unwritten entry can render black depending on three's fill policy.
        mesh.setColorAt(i, B.list[i].c || WHITE);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      try { mesh.computeBoundingSphere(); } catch (e) { /* older three */ }
      this.root.add(mesh);
      this.stats.instances += B.list.length;
      this.stats.batches++;
      this.stats.draws++;
      try {
        this.stats.tris += (vertCount(B.geo) / 3) * B.list.length;
      } catch (e2) { /* advisory */ }
      B.list.length = 0;
    }

    // ---- merged statics ----------------------------------------------------
    keys = Object.keys(this.S);
    for (k = 0; k < keys.length; k++) {
      var key = keys[k];
      var ents = this.S[key];
      if (!ents || !ents.length) continue;
      var geo;
      try { geo = Geo.mergeAll(ents); }
      catch (e3) { GAME.logError('propsR.merge:' + key, e3); continue; }
      var surf = SURF[key];
      var own = (key === 'marks' || key === 'flame');
      if (surf && !own) {
        // World-space UVs so texel density matches the level's masonry: two
        // stone surfaces at different scales in the same frame is the tell
        // that says "these came from different files".
        try { Geo.worldUV(geo, surf.uv || 0.42); } catch (e4) { /* keep what we have */ }
      }
      Geo.copyUV1(geo);
      if (!own) {
        try { this._paint(key, ents, geo); }
        catch (e5) { GAME.logError('propsR.paint:' + key, e5); }
      } else if (key === 'marks') {
        try { this._paintFlat(ents, geo); }
        catch (e6) { GAME.logError('propsR.paintFlat', e6); }
      }
      geo.computeBoundingSphere();
      var mat = own ? (key === 'marks' ? this.mats.marks : this.mats.flame)
        : this._material(key);
      var m2 = new THREE.Mesh(geo, mat);
      m2.name = 'ruinsprop_static_' + key;
      m2.castShadow = own ? false : !!(surf && surf.cast);
      m2.receiveShadow = own ? (key === 'marks') : !!(surf && surf.recv);
      m2.matrixAutoUpdate = false;
      m2.updateMatrix();
      if (key === 'marks') m2.renderOrder = 3;
      if (key === 'flame') { m2.renderOrder = 5; this.flames.push(m2); }
      this.root.add(m2);
      this.stats.statics++;
      this.stats.draws++;
      try { this.stats.tris += vertCount(geo) / 3; } catch (e7) { /* advisory */ }
      this.S[key] = null;
    }

    // ---- smoke plumes ------------------------------------------------------
    // Two, both at a fire the level already published, and both tiny. This is
    // the only motion in the level above knee height, and at dawn a thread of
    // incense smoke drifting through a shaft of low sun is the whole argument
    // for the hour.
    if (this.smokeEmitters.length && this.tex.smoke) {
      var parts = [];
      for (i = 0; i < this.smokeEmitters.length; i++) {
        var e = this.smokeEmitters[i];
        var p = e.position;
        var sz = (e.opts && e.opts.size) || 0.3;
        for (var q = 0; q < 2; q++) {
          parts.push({
            geometry: card(sz * 3.2, sz * 9.0, null, 0),
            matrix: Tn(p.x, p.y, p.z, 0, q * 1.5708 + 0.4, 0)
          });
        }
      }
      try {
        var sg = Geo.mergeAll(parts);
        for (i = 0; i < parts.length; i++) parts[i].geometry.dispose();
        sg.computeBoundingSphere();
        var sm = new THREE.Mesh(sg, this.mats.smoke);
        sm.name = 'ruinsprop_smoke';
        sm.renderOrder = 4;
        sm.frustumCulled = false;
        sm.castShadow = false; sm.receiveShadow = false;
        this.root.add(sm);
        this.smokes.push(sm);
        this.stats.draws++;
      } catch (e8) { GAME.logError('propsR.smoke', e8); }
    }

    this.stats.colliders = this.colliders.length;

    this.root.updateMatrixWorld(true);

    // The atoms are shared and cached by dimension, so they can only be freed
    // once every consumer has merged.
    _boxCache.forEach(function (g) { g.dispose(); }); _boxCache.clear();
    _cylCache.forEach(function (g) { g.dispose(); }); _cylCache.clear();
    _sphCache.forEach(function (g) { g.dispose(); }); _sphCache.clear();
  };

  // ==========================================================================
  // THE WEAR PAINT
  //
  // materials.js reads the geometry `color` attribute as a WEAR MASK, white =
  // pristine:  R grime,  G wetness,  B edge wear.
  //
  // The rules below are level_ruins.js's rules, deliberately, because the
  // whole point is that a block lying at the foot of a wall weathers the same
  // way the wall does. In particular the WETNESS GATE is copied exactly: the
  // G channel drops roughness and raises specular, and applying it to
  // horizontal faces near the ground turns every flagstone in the level into a
  // mirror that returns the dawn sky - which is how the level's own first
  // capture round photographed a courtyard as a sheet of pale blue ice. Water
  // films run down VERTICAL faces. A swept horizontal stone in the dry season
  // is dry.
  // ==========================================================================
  PropsRuins.prototype._paint = function (key, ents, geo) {
    var pos = geo.attributes.position, nrm = geo.attributes.normal;
    if (!pos || !nrm) return;
    var pa = pos.array, na = nrm.array;
    var col = new Float32Array(pos.count * 3);
    var noise = this.noise;
    var surf = SURF[key] || SURF.stone;
    var doEdges = !surf.mult;
    var vi = 0, e, i, j;

    for (e = 0; e < ents.length; e++) {
      var ent = ents[e];
      var cnt = vertCount(ent.geometry);
      var w = ent.wear;
      var g0 = w ? w.grime : 0.86, w0 = w ? w.wet : 0.96, e0 = w ? w.edge : 0.88;
      var hx = 1, hy = 1, hz = 1;
      if (doEdges) {
        var bb = ent.geometry.__rpbb;
        if (!bb) {
          ent.geometry.computeBoundingBox();
          var b = ent.geometry.boundingBox;
          bb = ent.geometry.__rpbb = [
            Math.max(1e-3, (b.max.x - b.min.x) * 0.5),
            Math.max(1e-3, (b.max.y - b.min.y) * 0.5),
            Math.max(1e-3, (b.max.z - b.min.z) * 0.5)];
        }
        hx = bb[0]; hy = bb[1]; hz = bb[2];
        _pinv.copy(ent.matrix).invert();
      }
      for (i = 0; i < cnt; i++) {
        j = (vi + i) * 3;
        var x = pa[j], y = pa[j + 1], z = pa[j + 2];
        var ny = na[j + 1];
        var r = g0, g = w0, b2 = e0;

        // ---- grime: water runs DOWN, and stops where the surface does -------
        var hgt = y - this._ground(x, z);
        var streak = noise.fbm2(x * 1.3 + 9.0, y * 0.26 - 3.0, 3) * 0.5 + 0.5;
        var down = M.saturate(-ny * 0.5 + 0.5);
        r *= 1 - streak * 0.15 * (1 - Math.abs(ny)) - down * 0.13;
        r *= 1 - M.smoothstep(1.4, 0.0, hgt) * 0.17;      // the dirty foot
        r *= 1 + noise.fbm2(x * 0.29, z * 0.29 + 7, 2) * 0.10;

        // ---- wet: the damp band, GATED ON THE NORMAL (see the header) -------
        g *= 1 - M.smoothstep(0.70, -0.10, hgt) * 0.28 * (1 - M.saturate(ny) * 0.92);

        // ---- edge wear: chipped arrises show pale fresh substrate -----------
        if (doEdges) {
          _pv.set(x, y, z).applyMatrix4(_pinv);
          var ex = Math.abs(_pv.x) / hx, ey = Math.abs(_pv.y) / hy, ez = Math.abs(_pv.z) / hz;
          var nEdge = (ex > 0.88 ? 1 : 0) + (ey > 0.88 ? 1 : 0) + (ez > 0.88 ? 1 : 0);
          if (nEdge >= 2) {
            var chip = M.saturate(noise.fbm2(x * 2.2 + 13, z * 2.2 - 4, 2) * 1.6 + 0.35);
            b2 *= 1 - chip * 0.40;
          }
        }
        col[j] = M.clamp(r, 0.05, 1.6);
        col[j + 1] = M.clamp(g, 0.05, 1.6);
        col[j + 2] = M.clamp(b2, 0.05, 1.6);
      }
      vi += cnt;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  };

  // The marks bucket has no wear shader behind it - it is a plain alpha decal
  // over whatever it lies on - so its vertex colour is a straight multiplier
  // and stays neutral. A grime channel here would tint bird lime magenta.
  PropsRuins.prototype._paintFlat = function (ents, geo) {
    var pos = geo.attributes.position;
    if (!pos) return;
    var col = new Float32Array(pos.count * 3);
    var vi = 0, e, i;
    for (e = 0; e < ents.length; e++) {
      var cnt = vertCount(ents[e].geometry);
      var w = ents[e].wear;
      var v = w ? (w.grime === undefined ? 1 : w.grime) : 1;
      for (i = 0; i < cnt; i++) {
        var j = (vi + i) * 3;
        col[j] = v; col[j + 1] = v; col[j + 2] = v;
      }
      vi += cnt;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  };

  // ==========================================================================
  // FRAME
  //
  // Three things move, and they are what stop this being a photograph of a
  // model: the understory breathes, every candle flickers on its own beat, and
  // the incense drifts. All of it is small on purpose - this is the quietest
  // level in the roster and its power is stillness with something alive in it.
  // ==========================================================================
  PropsRuins.prototype.update = function (dt, ctx) {
    try {
      dt = (typeof dt === 'number' && isFinite(dt)) ? dt : 0;
      this.time += dt;
      this.uTime.value = this.time;

      // Adopt a real weather system the moment one exists; otherwise the dawn
      // land breeze authored in the constructor stands.
      var w = (ctx && ctx.weather) || this.ctx.weather;
      if (w && w.windDir && typeof w.windSpeed === 'number' && w.windSpeed > 0.05) {
        var d = w.windDir;
        var l = Math.sqrt(d.x * d.x + d.y * d.y) || 1;
        this.uWindDir.value.set(d.x / l, d.y / l);
        this.uWind.value.x = M.clamp(0.020 + w.windSpeed * 0.011, 0.02, 0.30);
        this.uWind.value.y = M.clamp(0.85 + w.windSpeed * 0.10, 0.85, 4.0);
      }

      // Flame. Three incommensurable rates so the flicker never repeats on a
      // beat the eye can hear, and a floor under it so a candle never gaps out.
      if (this.mats.flame) {
        var t = this.time;
        var f = 0.86 + 0.10 * Math.sin(t * 2.7 + 0.4) + 0.06 * Math.sin(t * 6.1 + 1.7) +
          0.05 * Math.sin(t * 11.3 + 0.9);
        this.mats.flame.emissiveIntensity = 4.2 * Math.max(0.45, f);
      }
      // Smoke drifts on the same bearing the foliage bends, and scrolls its
      // own texture so the column has internal motion rather than sliding as
      // a rigid card.
      if (this.mats.smoke && this.mats.smoke.map) {
        var mp = this.mats.smoke.map;
        mp.offset.y = -this.time * 0.055;
        mp.offset.x = Math.sin(this.time * 0.19) * 0.03;
        // 0.11, not 0.26. The constructor was lowered to 0.11 with a note
        // explaining that a white plume at 0.30 read as a four-metre pale
        // column standing in mid-air over the looters' camp in hero1 - and
        // then this line put it straight back to 0.26 on the first frame of
        // every capture, so the fix never reached a photograph.
        this.mats.smoke.opacity = 0.105 + 0.025 * Math.sin(this.time * 0.6);
      }
    } catch (e) { GAME.logError('propsR.update', e); }
  };

  PropsRuins.prototype.resize = function () { /* nothing view-dependent */ };

  PropsRuins.prototype.dispose = function () {
    try {
      this.root.traverse(function (o) {
        if (o.geometry && o.geometry.dispose) o.geometry.dispose();
      });
      if (this.root.parent) this.root.parent.remove(this.root);
    } catch (e) { GAME.logError('propsR.dispose', e); }
  };

  GAME.PropsRuins = PropsRuins;
})(window.GAME, window.THREE);
