// ============================================================================
// OPERATION BLACKOUT - procedural PBR texture library
//   GAME.TextureLibrary
//
// Everything the game looks like starts here. There are no image files, so
// every albedo / normal / roughness / AO / height map in the build is
// synthesised from noise fields at boot.
//
// DESIGN NOTES (why it is built this way)
//
//  * Torus-tileable by construction. All noise is *value noise on a wrapping
//    lattice*: a freq x freq grid of random values is upsampled to the full
//    resolution with quintic interpolation and modulo indexing. Because the
//    lattice wraps, so does every octave, so every layer, so the final map.
//    There is no "mirror the edges" fudge anywhere - seams cannot exist.
//
//  * The upsample is separable (interpolate along X for the `fy` lattice rows,
//    then blend rows along Y). That turns an O(N^2 * octaves * noise-cost)
//    generator into O(N^2 * octaves * 6 flops), which is what makes 20+
//    1024^2 PBR sets affordable at boot in plain JS.
//
//  * HEIGHT IS THE SOURCE OF TRUTH. Each recipe builds a real height field
//    first. The normal map is Sobel-differenced from it, ambient occlusion is
//    a multi-scale cavity approximation of it (blur(h) - h, NOT 1-h), grime
//    accumulates where it is low and wear appears where it is high. That single
//    rule is what makes the wear read as physically motivated instead of as
//    "some noise multiplied on top".
//
//  * Roughness is authored per-material with a story: polished where things get
//    rubbed, chalky where paint has weathered, near-mirror on wet/oil, high on
//    rust and dust. A flat roughness map is the fastest way to look like a
//    WebGL demo.
//
//  * Output packing. Albedo is one RGBA (sRGB). Normals are one RGB
//    (NoColorSpace). AO/roughness/metalness share ONE texture in the glTF "ORM"
//    layout (R=AO, G=roughness, B=metalness) because three.js reads exactly
//    those channels - so `roughnessMap === aoMap === metalnessMap` by design and
//    the GPU only pays for one upload. Displacement is a small separate map
//    (three reads displacement from .r, which ORM has already spent on AO).
//
//  * aoMap is sampled from the SECOND uv set by three.js. Consumers must call
//    GAME.Geo.copyUV1(geometry).
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  if (!GAME || !THREE) return;

  var M = GAME.Math;

  // --------------------------------------------------------------------------
  // Scalar helpers. Kept tiny and monomorphic so V8 inlines them inside the
  // per-pixel loops.
  // --------------------------------------------------------------------------
  function sat(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function fade5(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  // smoothstep that also accepts e0 > e1 (an inverted ramp), which saves a lot
  // of `1 - smoothstep(...)` noise in the recipes below.
  function sstep(e0, e1, x) {
    var d = e1 - e0;
    if (d === 0) return x < e0 ? 0 : 1;
    var t = (x - e0) / d;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    return t * t * (3 - 2 * t);
  }
  function frac(v) { return v - Math.floor(v); }
  function rgb(hex) {
    return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
  }
  function hashStr(s) {
    var h = 2166136261, i;
    for (i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  // Cheap deterministic 2D hash for per-cell (per-brick / per-plank) variation.
  function hash2i(x, y, salt) {
    var h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(salt | 0, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // --------------------------------------------------------------------------
  // Palette - locked to ART_DIRECTION.md so every material sits in the same
  // sun-baked Mediterranean colour world.
  // --------------------------------------------------------------------------
  var PAL = {
    concrete:   rgb(0x9a958c), concreteDk: rgb(0x62605b), cement:    rgb(0xb4ada1),
    aggregate:  rgb(0x7e7a72), aggLight:   rgb(0xada79a), aggDark:   rgb(0x53514c),
    plaster:    rgb(0xd9c3a0), plasterHi:  rgb(0xe8d7ba), plasterDk: rgb(0xa08a68),
    sand:       rgb(0xc9b08a), dust:       rgb(0xd6c4a4), sandDk:    rgb(0x9c8560),
    dirt:       rgb(0x6f5c44), dirtDk:     rgb(0x453727), dirtLt:    rgb(0x9a8360),
    // Rust. ART_DIRECTION's #8a4a2a is the *average* of a corroded panel, not a
    // flat fill: real oxide runs from near-black pitting through dark red-brown
    // scale to a pale orange bloom on the high points only. Authoring the whole
    // panel at the bright end is what gave the alley fire escape its candy
    // orange read, so the base sits below the spec value, the bloom above it,
    // and the mean lands where the art direction asks.
    rust:       rgb(0x6a3a22), rustDeep:   rgb(0x40200f), rustLt:    rgb(0xa85f30),
    rustPit:    rgb(0x1d1512), rustMid:    rgb(0x8a4a2a),
    // NOTE: for anything rendered with metalness ~1 the albedo channel is not a
    // diffuse colour, it is the specular F0 tint - and real metals are BRIGHT
    // there (steel F0 is around 0.56 linear). Authoring dark "metal grey" here
    // is the classic mistake that turns every metal surface into dark chrome.
    // Dirt, oxide and coatings darken it afterwards, and those drop metalness.
    steel:      rgb(0xa3a8ae), steelDk:    rgb(0x6d737b), gunmetal:  rgb(0x2a2c30),
    // ...with one exception. A ten-year-old fire escape is mill scale under
    // dirt, which is a DIELECTRIC skin, not exposed steel - and ART_DIRECTION
    // is explicit that metals here are dark and tinted. This is the substrate
    // tone for corroded structural steel; PAL.steel stays for the fresh cuts.
    steelDark:  rgb(0x3a3e42), steelWarm:  rgb(0x4a443e),
    alu:        rgb(0xb3b9c0), zinc:       rgb(0x9aa1a7),
    wood:       rgb(0x6b5540), woodLt:     rgb(0xa0855f), woodGrey:  rgb(0x8b857a),
    woodDk:     rgb(0x3f3225),
    asphalt:    rgb(0x4a4842), tar:        rgb(0x24231f), asphaltLt: rgb(0x6e6b62),
    brickA:     rgb(0x8c4f3a), brickB:     rgb(0xa9694a), brickC:    rgb(0x6d4433),
    brickD:     rgb(0x9c7f5f), brickE:     rgb(0x77473c), mortar:    rgb(0xa89c8a),
    foliage:    rgb(0x6b7248), foliageDry: rgb(0x93874f), foliageDk: rgb(0x424a2c),
    // Every green in the palette sat within 0.35-0.46 saturation, so a canopy
    // built from them measured as one constant chroma however it was shaded.
    // This is the chlorophyll end - the leaves still in the shade, still alive.
    foliageWet: rgb(0x49682c),
    grime:      rgb(0x3a342b), soot:       rgb(0x201e1c), moss:      rgb(0x4b5533),
    olive:      rgb(0x6e6a4e), canvasTan:  rgb(0x9c8c68), canvasRed: rgb(0x8f4535),
    canvasTeal: rgb(0x2f6b6a), canvasOchre: rgb(0xb08a3e),
    skin:       rgb(0xc59c81), skinDeep:   rgb(0x9d6b52), skinPale:  rgb(0xdcbc9f),
    glass:      rgb(0x2b3538), glassFilm:  rgb(0xb9c6c2), primer:    rgb(0x86503c),
    blood:      rgb(0x6e1410), rubber:     rgb(0x2b2b2e),
    polymer:    rgb(0x2e3034), polymerWorn: rgb(0x4d5057), efflor:   rgb(0xd2cdc2),
    // hessian sacking, quarried limestone, moulded plastic and militia webbing.
    jute:       rgb(0xa38f66), juteDk:     rgb(0x6d5d3c), juteLt:    rgb(0xc4b088),
    stone:      rgb(0x9d9689), stoneDk:    rgb(0x6b665c), stoneLt:   rgb(0xc2baa8),
    plastic:    rgb(0x5f656d), plasticDk:  rgb(0x363a40), plasticLt: rgb(0x939aa3),
    oliveDrab:  rgb(0x4f5537), oliveLt:    rgb(0x7c8158), tanCloth:  rgb(0x8d7a58),
    tanLt:      rgb(0xbfa87c),
    // ---- weathering CHROMA axes -------------------------------------------
    // Every map in this library used to be one hue with luminance modulation,
    // which is the fastest way a procedural texture betrays itself: under a
    // hazy warm key the whole scene collapses into a single beige. Real
    // surfaces vary in CHROMA as well as value, and they do it along a small
    // number of physical axes - so these are the axes, and every recipe pushes
    // its base colour along at least two of them.
    //   damp   water in the pore structure: darker, cooler, DEsaturated
    //   bloom  lime / salt / gypsum efflorescence: near-neutral white, kills chroma
    //   iron   iron oxide leaching out of the substrate or off a fixing: warm ochre
    //   bio    algae, lichen, moss in the sheltered damp: olive green
    dampGrey:   rgb(0x6b7076), ironStain:  rgb(0x9a6633), bioStain:  rgb(0x67704a),
    limeBloom:  rgb(0xe4e0d8),
    // Grey cement substrate exposed where the lime plaster skin has spalled.
    // Plaster with no second material in the map is just a tinted greyscale.
    concSub:    rgb(0x8a8680), concSubDk:  rgb(0x5d5a55), concSubLt: rgb(0xa9a49a)
  };

  // --------------------------------------------------------------------------
  // Cached lattice->pixel interpolation tables. Keyed by (size, freq); there are
  // only a few dozen distinct combinations across the whole library.
  // --------------------------------------------------------------------------
  var _wtabs = new Map();
  function wtab(size, freq) {
    var key = size * 8192 + freq;
    var t = _wtabs.get(key);
    if (t) return t;
    var i0 = new Int32Array(size), i1 = new Int32Array(size), w = new Float32Array(size);
    for (var x = 0; x < size; x++) {
      var p = x * freq / size;
      var a = Math.floor(p);
      var f = p - a;
      a = ((a % freq) + freq) % freq;
      i0[x] = a; i1[x] = (a + 1) % freq; w[x] = fade5(f);
    }
    t = { i0: i0, i1: i1, w: w };
    _wtabs.set(key, t);
    return t;
  }

  // Neighbour index tables for the Sobel pass (avoids a modulo per pixel).
  var _ntabs = new Map();
  function ntab(size) {
    var t = _ntabs.get(size);
    if (t) return t;
    var m = new Int32Array(size), p = new Int32Array(size);
    for (var i = 0; i < size; i++) { m[i] = (i - 1 + size) % size; p[i] = (i + 1) % size; }
    t = { m: m, p: p };
    _ntabs.set(size, t);
    return t;
  }

  // 8x8 ordered dither, +-0.5 LSB. Kills the banding that 8-bit quantisation
  // leaves in smooth albedo gradients and in low-slope normals.
  var BAYER = (function () {
    var b = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
             12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
             3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
             15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];
    var out = new Float32Array(64);
    for (var i = 0; i < 64; i++) out[i] = (b[i] / 64 - 0.5);
    return out;
  })();

  // --------------------------------------------------------------------------
  // Separable wrapping box blur with per-column running sums. Both passes are
  // row-major, which matters a lot: the naive column-major vertical pass is
  // roughly 5x slower on a 1024^2 Float32Array.
  // Safe to call with dst === src (the horizontal pass lands in `tmp`).
  // --------------------------------------------------------------------------
  function boxBlur(src, dst, size, r, tmp, colsum) {
    if (r < 1) { if (dst !== src) dst.set(src); return dst; }
    var half = (size >> 1) - 1;
    if (r > half) r = half;
    if (r < 1) { if (dst !== src) dst.set(src); return dst; }
    var win = 2 * r + 1, inv = 1 / win, x, y, k, o, sum;

    for (y = 0; y < size; y++) {
      o = y * size; sum = 0;
      for (k = -r; k <= r; k++) sum += src[o + ((k + size) % size)];
      for (x = 0; x < size; x++) {
        tmp[o + x] = sum * inv;
        sum += src[o + ((x + r + 1) % size)] - src[o + ((x - r + size) % size)];
      }
    }
    for (x = 0; x < size; x++) colsum[x] = 0;
    for (k = -r; k <= r; k++) {
      o = ((k + size) % size) * size;
      for (x = 0; x < size; x++) colsum[x] += tmp[o + x];
    }
    for (y = 0; y < size; y++) {
      var od = y * size;
      var oa = ((y + r + 1) % size) * size;
      var os = ((y - r + size) % size) * size;
      for (x = 0; x < size; x++) {
        dst[od + x] = colsum[x] * inv;
        colsum[x] += tmp[oa + x] - tmp[os + x];
      }
    }
    return dst;
  }

  // ==========================================================================
  // Gen - the per-material field toolbox. Owns a pooled set of Float32Array
  // scratch planes and every tileable noise primitive the recipes draw from.
  // ==========================================================================
  function Gen(lib, size, seed) {
    this.lib = lib;
    this.size = size;
    this.n = size * size;
    this.seedBase = seed >>> 0;
    this.rng = new GAME.RNG(this.seedBase ^ 0x5bf03635);
    this._held = [];
    this._col = new Float32Array(size);
    this._acc = new Float32Array(size);
  }

  Gen.prototype.buf = function (fill) {
    var pool = this.lib._pool(this.n);
    var a = pool.length ? pool.pop() : new Float32Array(this.n);
    a.fill(fill === undefined ? 0 : fill);
    this._held.push(a);
    return a;
  };
  Gen.prototype.release = function (a) {
    var i = this._held.indexOf(a);
    if (i >= 0) { this._held.splice(i, 1); this.lib._pool(this.n).push(a); }
  };
  Gen.prototype.dispose = function () {
    var pool = this.lib._pool(this.n);
    for (var i = 0; i < this._held.length; i++) pool.push(this._held[i]);
    this._held.length = 0;
  };

  // A wrapping freq-grid of uniform randoms. Deterministic in (seed, fx, fy,
  // salt) so a layer always regenerates identically regardless of call order.
  Gen.prototype.lattice = function (fx, fy, salt) {
    var s = this.seedBase ^ Math.imul(fx, 73856093) ^ Math.imul(fy, 19349663) ^ Math.imul(salt | 0, 83492791);
    var rng = new GAME.RNG(s >>> 0);
    var a = new Float32Array(fx * fy);
    for (var i = 0; i < a.length; i++) a[i] = rng.next();
    return a;
  };

  // out += amp * (valueNoise - bias). Anisotropic: fx != fy stretches the noise,
  // which is how every "directed streak" layer in this file is made.
  Gen.prototype.addNoise = function (out, fx, fy, amp, bias, salt) {
    fx = Math.max(1, fx | 0); fy = Math.max(1, fy | 0);
    var size = this.size;
    if (fx > size) fx = size;
    if (fy > size) fy = size;
    var lat = this.lattice(fx, fy, salt);
    var tx = wtab(size, fx), ty = wtab(size, fy);
    var row = this.lib._row(fy * size);
    var xi0 = tx.i0, xi1 = tx.i1, xw = tx.w;
    var j, x, y, a;

    for (j = 0; j < fy; j++) {
      var lo = j * fx, ro = j * size;
      for (x = 0; x < size; x++) {
        a = lat[lo + xi0[x]];
        row[ro + x] = a + (lat[lo + xi1[x]] - a) * xw[x];
      }
    }
    var yi0 = ty.i0, yi1 = ty.i1, yw = ty.w;
    for (y = 0; y < size; y++) {
      var r0 = yi0[y] * size, r1 = yi1[y] * size, wv = yw[y], o = y * size;
      for (x = 0; x < size; x++) {
        a = row[r0 + x];
        out[o + x] += amp * (a + (row[r1 + x] - a) * wv - bias);
      }
    }
    return out;
  };

  // Fractal sum. signed=false -> [0,amp] with mean amp/2; signed=true -> +-amp/2.
  Gen.prototype.fbm = function (out, freq, oct, gain, amp, salt, signed) {
    return this.fbmA(out, freq, freq, oct, gain, amp, salt, signed);
  };
  Gen.prototype.fbmA = function (out, fx, fy, oct, gain, amp, salt, signed) {
    // Octaves whose period drops below ~3 texels are worse than useless: they
    // survive as per-texel hash in the albedo and, once the height field is
    // Sobel-differenced, turn the normal map into rainbow confetti. Clamp each
    // axis and stop as soon as an octave adds no new detail.
    var maxF = Math.max(2, Math.floor(this.size / 3));
    var fxs = [], fys = [], amps = [], tot = 0;
    var a = 1, px = fx, py = fy, i, pcx = -1, pcy = -1;
    for (i = 0; i < oct; i++) {
      var cx = Math.min(Math.max(1, Math.round(px)), maxF);
      var cy = Math.min(Math.max(1, Math.round(py)), maxF);
      if (i > 0 && cx === pcx && cy === pcy) break;
      fxs.push(cx); fys.push(cy); amps.push(a); tot += a;
      pcx = cx; pcy = cy;
      a *= gain; px *= 2; py *= 2;
    }
    var bias = signed ? 0.5 : 0;
    for (i = 0; i < fxs.length; i++) {
      this.addNoise(out, fxs[i], fys[i], amp * amps[i] / tot, bias, (salt | 0) + i * 101);
    }
    return out;
  };

  // Ridged multifractal - thin bright creases. This is the crack generator.
  Gen.prototype.ridged = function (out, freq, oct, amp, salt, sharp) {
    var tmp = this.buf(0);
    var maxF = Math.max(2, Math.floor(this.size / 3));
    var tot = 0, a = 1, i, k, f = freq, n = this.n;
    var used = 0;
    for (i = 0; i < oct; i++) {
      if (Math.round(f * Math.pow(2, i)) > maxF && i > 0) break;
      tot += a; a *= 0.5; used++;
    }
    oct = Math.max(1, used);
    a = 1; f = freq;
    for (i = 0; i < oct; i++) {
      tmp.fill(0);
      this.addNoise(tmp, Math.min(maxF, Math.round(f)), Math.min(maxF, Math.round(f)), 2, 0.5, (salt | 0) + i * 37);
      var w = amp * a / tot;
      for (k = 0; k < n; k++) {
        var v = 1 - Math.abs(tmp[k]);
        v = v * v;
        if (sharp) v = v * v;
        out[k] += w * v;
      }
      a *= 0.5; f *= 2;
    }
    this.release(tmp);
    return out;
  };

  // Tileable Worley/cellular. Returns squared-free distances in *cell* units
  // plus the winning cell's random id, which is what lets gravel and brick give
  // every element its own tone.
  Gen.prototype.worley = function (cells, jitter, salt) {
    var size = this.size;
    // Same Nyquist argument as fbmA: cells smaller than ~5 texels are noise.
    var c = Math.min(Math.max(2, cells | 0), Math.max(4, Math.floor(size / 5)));
    var rng = new GAME.RNG((this.seedBase ^ Math.imul(c, 2654435761) ^ Math.imul(salt | 0, 40503)) >>> 0);
    var cc = c * c;
    var px = new Float32Array(cc), py = new Float32Array(cc), pid = new Float32Array(cc);
    var i, j;
    for (j = 0; j < c; j++) {
      for (i = 0; i < c; i++) {
        var k = j * c + i;
        px[k] = i + 0.5 + jitter * (rng.next() - 0.5);
        py[k] = j + 0.5 + jitter * (rng.next() - 0.5);
        pid[k] = rng.next();
      }
    }
    var f1 = this.buf(0), f2 = this.buf(0), id = this.buf(0);
    var scale = c / size;
    var x, y, ox, oy;
    for (y = 0; y < size; y++) {
      var fy = (y + 0.5) * scale;
      var cyi = Math.floor(fy);
      var o = y * size;
      for (x = 0; x < size; x++) {
        var fx = (x + 0.5) * scale;
        var cxi = Math.floor(fx);
        var d1 = 1e9, d2 = 1e9, bid = 0;
        for (oy = -1; oy <= 1; oy++) {
          var yy = cyi + oy, wy = 0;
          if (yy < 0) { yy += c; wy = -c; } else if (yy >= c) { yy -= c; wy = c; }
          var rowo = yy * c;
          var dy = 0;
          for (ox = -1; ox <= 1; ox++) {
            var xx = cxi + ox, wx = 0;
            if (xx < 0) { xx += c; wx = -c; } else if (xx >= c) { xx -= c; wx = c; }
            var kk = rowo + xx;
            var ddx = px[kk] + wx - fx;
            dy = py[kk] + wy - fy;
            var d = ddx * ddx + dy * dy;
            if (d < d1) { d2 = d1; d1 = d; bid = pid[kk]; }
            else if (d < d2) { d2 = d; }
          }
        }
        f1[o + x] = Math.sqrt(d1);
        f2[o + x] = Math.sqrt(d2);
        id[o + x] = bid;
      }
    }
    return { f1: f1, f2: f2, id: id };
  };

  // Runoff operator: propagate a mask downward (or up) with exponential decay.
  // This is what turns "rust blotch" into "rust weeping down the panel" and
  // "grime under a window ledge" into an actual streak. Wrapping is handled by
  // running the sweep twice so the accumulator enters the second pass primed.
  Gen.prototype.drip = function (src, dst, decay, down) {
    var size = this.size, x, y, pass;
    var acc = this._acc;
    for (x = 0; x < size; x++) acc[x] = 0;
    for (pass = 0; pass < 2; pass++) {
      for (y = 0; y < size; y++) {
        var yy = down ? y : (size - 1 - y);
        var o = yy * size;
        for (x = 0; x < size; x++) {
          var a = acc[x] * decay;
          var s = src[o + x];
          if (s > a) a = s;
          acc[x] = a;
          if (pass) dst[o + x] = a;
        }
      }
    }
    return dst;
  };

  // Integer-slope shear. Rational shears are torus-preserving, so scratches can
  // be generated axis-aligned (cheap) and then tilted without breaking tiling.
  Gen.prototype.shear = function (src, dst, slope) {
    var size = this.size, x, y;
    slope = slope | 0;
    for (y = 0; y < size; y++) {
      var o = y * size;
      var sh = (((slope * y) % size) + size) % size;
      for (x = 0; x < size; x++) dst[o + x] = src[o + ((x + sh) % size)];
    }
    return dst;
  };

  Gen.prototype.blur = function (src, dst, r) {
    return boxBlur(src, dst, this.size, r, this.lib._blurTmp(this.n), this._col);
  };

  // ==========================================================================
  // Surf - the material's channel set. Recipes fill these; _emit turns them
  // into textures.
  // ==========================================================================
  function Surf(g) {
    this.g = g;
    this.h = g.buf(0.5);   // height, 0..1
    this.cr = g.buf(0.5);  // albedo (sRGB-encoded 0..1)
    this.cg = g.buf(0.5);
    this.cb = g.buf(0.5);
    this.al = g.buf(1);    // alpha
    this.ro = g.buf(0.8);  // roughness
    this.me = g.buf(0);    // metalness
  }
  Surf.prototype.base = function (c) {
    this.cr.fill(c[0]); this.cg.fill(c[1]); this.cb.fill(c[2]);
  };
  function tint(S, i, c, t) {
    if (t <= 0) return;
    if (t > 1) t = 1;
    S.cr[i] += (c[0] - S.cr[i]) * t;
    S.cg[i] += (c[1] - S.cg[i]) * t;
    S.cb[i] += (c[2] - S.cb[i]) * t;
  }
  function shade(S, i, k) { S.cr[i] *= k; S.cg[i] *= k; S.cb[i] *= k; }
  // Pull a texel toward its own luminance. Saturation VARIANCE is what sells a
  // surface, and variance needs a low end as well as a high one - bleached,
  // salted and dust-filmed zones are genuinely closer to neutral than the
  // material they sit on, and tinting alone can never produce that.
  function desat(S, i, k) {
    if (k <= 0) return;
    if (k > 1) k = 1;
    var l = S.cr[i] * 0.30 + S.cg[i] * 0.59 + S.cb[i] * 0.11;
    S.cr[i] += (l - S.cr[i]) * k;
    S.cg[i] += (l - S.cg[i]) * k;
    S.cb[i] += (l - S.cb[i]) * k;
  }

  // --------------------------------------------------------------------------
  // Weathering chroma. Four independent low-frequency fields, one per physical
  // staining axis (see PAL). Every recipe builds one of these and runs
  // applyChroma over it, which is what takes saturation p95/mean from ~1.05
  // (a constant, i.e. a tinted greyscale) to the 1.6-2.5 a real surface shows.
  // Frequencies are deliberately 3-9: this is 20cm-2m mottling, the scale a
  // wall actually weathers at, and low enough that it survives every mip.
  // --------------------------------------------------------------------------
  function chromaFields(g, salt) {
    return {
      damp:  g.fbm(g.buf(0), 4, 3, 0.55, 1, salt + 401, false),
      bloom: g.fbm(g.buf(0), 7, 3, 0.55, 1, salt + 403, false),
      iron:  g.fbm(g.buf(0), 5, 3, 0.55, 1, salt + 407, false),
      bio:   g.fbm(g.buf(0), 9, 3, 0.55, 1, salt + 409, false),
      // Stains have EDGES and internal texture. A smooth low-frequency mask
      // paints camouflage blobs; breaking it up at 20-60 texels is the
      // difference between "iron staining" and "someone spilled a cloud".
      tx:    g.fbm(g.buf(0), 44, 3, 0.6, 1, salt + 411, false)
    };
  }
  // Tint toward a colour while holding most of the original LUMINANCE. Chroma
  // variance is the goal; extra value variance is not - broad luminance blobs
  // are precisely what survives a column average and reads back as tiling. So
  // the hue moves and the value very nearly does not.
  function tintL(S, i, c, t, keep) {
    if (t <= 0) return;
    var l0 = S.cr[i] * 0.30 + S.cg[i] * 0.59 + S.cb[i] * 0.11;
    tint(S, i, c, t);
    var l1 = S.cr[i] * 0.30 + S.cg[i] * 0.59 + S.cb[i] * 0.11;
    if (l1 > 1e-4) shade(S, i, 1 + (l0 / l1 - 1) * keep);
  }
  // low  : 0..1 "this texel is in a hollow / sheltered / water-tracked place".
  //        Damp and biology only live there; bloom and iron do not care.
  // amt  : overall strength dial per material.
  function applyChroma(S, i, C, amt, low, k) {
    if (amt <= 0) return;
    var kd = (k && k.damp !== undefined) ? k.damp : 1;
    var kb = (k && k.bloom !== undefined) ? k.bloom : 1;
    var ki = (k && k.iron !== undefined) ? k.iron : 1;
    var ko = (k && k.bio !== undefined) ? k.bio : 1;
    // The ramps are cut where an fbm actually LIVES. A threshold at 0.62 with a
    // gain of 3 needs the field to reach 0.95 for full strength, and a 3-octave
    // value-noise fbm has a standard deviation near 0.11 - it never gets there,
    // so the "chroma field" contributed a couple of percent and the map stayed
    // one hue. These reach full strength around +1.5 sigma, i.e. on the ~7% of
    // the tile that a real stain covers.
    var tx = 0.42 + 1.30 * C.tx[i];
    var d = sstep(0.51, 0.655, C.damp[i]) * (0.28 + 0.72 * low) * tx;
    var b = sstep(0.54, 0.685, C.bloom[i]) * tx;
    var s = sstep(0.60, 0.740, C.iron[i]) * tx;
    var o = sstep(0.60, 0.745, C.bio[i]) * low * tx;
    // keep = how much of the original luminance survives the hue shift. High,
    // deliberately: this layer exists to add CHROMA variance, and adding value
    // variance with it just puts the macro blobs back.
    if (d > 0 && kd > 0) { tintL(S, i, PAL.dampGrey, d * 0.32 * amt * kd, 0.86); desat(S, i, d * 0.22 * amt * kd); }
    if (b > 0 && kb > 0) { tintL(S, i, PAL.limeBloom, b * 0.32 * amt * kb, 0.78); desat(S, i, b * 0.46 * amt * kb); }
    if (s > 0 && ki > 0) { tintL(S, i, PAL.ironStain, s * 0.34 * amt * ki, 0.90); }
    if (o > 0 && ko > 0) { tintL(S, i, PAL.bioStain, o * 0.34 * amt * ko, 0.90); }
    // ---- and the LOW end -------------------------------------------------
    // The four axes above supply a saturated high end. Chroma VARIANCE needs a
    // low end too, and tinting can never produce one: pulling a texel toward
    // any coloured stain can only raise its chroma. A real surface has a large
    // low end - most of its area sits under a pale dust film, sun-bleached and
    // measurably closer to neutral than the material beneath it. This covers
    // ~40% of the tile at partial strength and is what actually opens
    // saturation p95/mean past 1.6; without it every recipe stays a constant-
    // chroma tinted greyscale no matter how many stains are painted on.
    var kw = (k && k.wash !== undefined) ? k.wash : 0.45;
    if (kw > 0) {
      var wf = sstep(0.53, 0.37, C.bloom[i] * 0.55 + C.iron[i] * 0.45) * (1 - low * 0.55);
      if (wf > 0) desat(S, i, wf * kw * amt);
    }
  }

  // --------------------------------------------------------------------------
  // Row / column mean flattening.
  //
  // The frame-level "visible tiling" measurement is the autocorrelation of the
  // rendered image's ROW-mean luminance profile. What a tiling texture
  // contributes to that number is exactly its own row-mean structure: any
  // horizontal band in the tile - a formwork joint, a runoff shelf, a
  // per-course tone - repeats verbatim at every tile boundary and shows up as
  // a countable ruled line down a three-storey wall. Local detail does not; it
  // averages away inside the row.
  //
  // So for the amorphous surfaces (plaster, concrete, stone, ground) we solve
  // out the rank-1 row/column mean deviation of the albedo. It is a purely
  // structural fix - within-row and within-column contrast, i.e. everything the
  // eye reads as material, is untouched - and it is the only lever a tiling
  // texture has against the metric. Materials whose banding IS the material
  // (brick courses, board joints, corrugation, weave) opt out or use a partial
  // amount.
  // --------------------------------------------------------------------------
  function deband(g, S, amt) {
    if (!(amt > 0)) return;
    if (amt > 1) amt = 1;
    var size = g.size, n = g.n, x, y, i;
    var rowL = new Float32Array(size), colL = new Float32Array(size);
    var gmean = 0;
    for (y = 0; y < size; y++) {
      var o = y * size, rs = 0;
      for (x = 0; x < size; x++) {
        i = o + x;
        var l = S.cr[i] * 0.30 + S.cg[i] * 0.59 + S.cb[i] * 0.11;
        rs += l; colL[x] += l;
      }
      rowL[y] = rs / size; gmean += rs;
    }
    gmean /= n;
    if (gmean < 1e-5) return;
    // colL still holds column SUMS; rowL already holds row MEANS.
    for (x = 0; x < size; x++) colL[x] = (colL[x] / size - gmean) / gmean;
    for (y = 0; y < size; y++) rowL[y] = (rowL[y] - gmean) / gmean;
    for (y = 0; y < size; y++) {
      var oy = y * size, rv = rowL[y];
      for (x = 0; x < size; x++) {
        var k = 1 - amt * (rv + colL[x]);
        // Clamped: a pathological profile must never invert or blow out a row.
        if (k < 0.72) k = 0.72; else if (k > 1.34) k = 1.34;
        shade(S, oy + x, k);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Shared damage stamps
  // --------------------------------------------------------------------------

  // Bullet scars / impact craters. Wraps across the seam, so a crater that runs
  // off the right edge reappears on the left and the tile stays continuous.
  // o.hard  : steep-sided, flat-floored crater with a broken arris instead of
  //           an airbrushed parabola. This is what makes a spall read as a
  //           spall; the soft profile just looks like a smudge.
  // o.rim   : height of the lifted lip immediately outside the break.
  // o.mask  : optional Float32Array; receives max-coverage so the recipe can
  //           paint a whole second MATERIAL into the hole (exposed substrate,
  //           aggregate) rather than merely darkening the one it has.
  function punchCraters(g, S, o) {
    var size = g.size, rng = g.rng;
    var count = o.count | 0;
    var hard = !!o.hard, rim = o.rim || 0, mask = o.mask || null;
    for (var c = 0; c < count; c++) {
      var cx = rng.next() * size, cy = rng.next() * size;
      var R = size * (o.rMin + rng.next() * (o.rMax - o.rMin));
      var depth = o.depth * (0.55 + rng.next() * 0.9);
      // A hard-edged break needs MORE lobes at LESS amplitude: a steep wall
      // plus a 3-lobe outline is a throwing star, not a chip of plaster.
      var lobes = hard ? (5 + (c % 5)) : (3 + (c % 4));
      var lobeA = hard ? 0.085 : 0.22;
      var phase = rng.next() * 6.283;
      var halo = o.halo === undefined ? 2.1 : o.halo;
      var x0 = Math.floor(cx - R * halo), x1 = Math.ceil(cx + R * halo);
      var y0 = Math.floor(cy - R * halo), y1 = Math.ceil(cy + R * halo);
      for (var yy = y0; yy <= y1; yy++) {
        var wy = ((yy % size) + size) % size;
        var dy = yy - cy;
        var ro = wy * size;
        for (var xx = x0; xx <= x1; xx++) {
          var dx = xx - cx;
          var d = Math.sqrt(dx * dx + dy * dy) / R;
          if (d > halo) continue;
          var wx = ((xx % size) + size) % size;
          var i = ro + wx;
          // irregular rim so it is not a perfect circle
          var aa = Math.atan2(dy, dx);
          var wob = (1 - lobeA) + lobeA * (Math.sin(aa * lobes + phase) * 0.7 +
                                           Math.sin(aa * (lobes * 2 + 1) + phase * 1.7) * 0.3);
          // spall halo: shallow chipped ring around the hole
          var hal = sstep(halo, wob, d) * sstep(wob * 0.92, wob * 1.25, d);
          if (hal > 0) {
            S.h[i] -= o.depth * 0.22 * hal;
            S.ro[i] = lerp(S.ro[i], o.rough, hal * 0.7);
            tint(S, i, o.col, hal * o.tint * 0.55);
          }
          if (rim > 0) {
            // lifted, still-attached lip of skin just outside the break
            var lp = sstep(wob * 1.16, wob * 1.00, d) * sstep(wob * 0.995, wob * 1.02, d);
            S.h[i] += rim * lp;
          }
          if (d >= wob) continue;
          var t = d / wob;
          var bowl, cut;
          if (hard) {
            // near-vertical wall over the outer 12% of the radius, then a
            // shallow rough floor with its own chatter
            cut = sstep(1.0, 0.88, t);
            bowl = cut * (0.70 + 0.30 * (1 - t * t));
          } else {
            bowl = 1 - t * t;
            cut = bowl;
            bowl = bowl * bowl;
          }
          S.h[i] -= depth * bowl * (0.9 + 0.2 * Math.sin(t * 22 + phase));
          if (mask) { var mv = cut; if (mv > mask[i]) mask[i] = mv; }
          tint(S, i, o.col, sat(cut * 1.5) * o.tint);
          if (o.soot) tint(S, i, PAL.soot, sat(cut * 1.1) * o.soot);
          S.ro[i] = lerp(S.ro[i], o.rough, sat(cut * 1.7));
        }
      }
    }
  }

  // Long thin scrapes / gouges - used on floors and metal where things drag.
  //
  // o.hbias : only bite where the height field is proud (0 = everywhere). A
  //           scratch that runs edge to edge across a whole tile at a constant
  //           angle reads as a rendering artefact, not as wear - nothing
  //           scratches a bulkhead in a 1.5 m straight line. Real scoring is
  //           short, and it lands on the parts that stick out and get rubbed.
  function punchScrapes(g, S, o) {
    var size = g.size, rng = g.rng;
    var hbias = o.hbias || 0, hRef = o.hRef === undefined ? 0.6 : o.hRef;
    for (var c = 0; c < (o.count | 0); c++) {
      var x = rng.next() * size, y = rng.next() * size;
      var ang = rng.next() * 6.283;
      var len = size * (o.lenMin + rng.next() * (o.lenMax - o.lenMin));
      var wdt = size * (o.width * (0.5 + rng.next()));
      var dx = Math.cos(ang), dy = Math.sin(ang);
      var steps = Math.ceil(len);
      var curve = (rng.next() - 0.5) * 0.004;
      for (var s = 0; s < steps; s++) {
        var taper = Math.sin(Math.PI * (s / steps));
        var w = wdt * (0.35 + 0.65 * taper);
        ang += curve;
        dx = Math.cos(ang); dy = Math.sin(ang);
        x += dx; y += dy;
        var r = Math.ceil(w);
        for (var oy = -r; oy <= r; oy++) {
          var wy = ((Math.round(y + oy) % size) + size) % size;
          var ro = wy * size;
          for (var ox = -r; ox <= r; ox++) {
            var dd = Math.sqrt(ox * ox + oy * oy) / (w + 0.001);
            if (dd > 1) continue;
            var wx = ((Math.round(x + ox) % size) + size) % size;
            var i = ro + wx;
            var k = (1 - dd) * (1 - dd) * taper;
            if (hbias > 0) k *= lerp(1, sat((S.h[i] - hRef) * 12), hbias);
            if (k <= 0) continue;
            S.h[i] -= o.depth * k;
            S.ro[i] = lerp(S.ro[i], o.rough, k * 0.85);
            if (o.col) tint(S, i, o.col, k * (o.tint || 0.5));
            if (o.metal !== undefined) S.me[i] = lerp(S.me[i], o.metal, k * 0.9);
          }
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // COLD HARBOR (level 2) palette - ART_DIRECTION_HARBOR.md.
  //
  // Kept in its own table rather than merged into PAL, because level 1 is
  // finished: nothing here can move a market tone by accident. The two levels
  // deliberately share only the WEATHERING tones (rust, grime, soot, salt) -
  // oxide is oxide in any climate - and disagree about everything else. The
  // market's concrete is a warm sun-baked #9a958c; a wet northern apron at two
  // in the morning is #4a4f55 at best and #16191c where the water stands.
  //
  // Albedo runs dark on purpose. This level gets its value from specular off
  // wet surfaces, so a "correct-looking" mid-grey albedo here would render as
  // a milky grey soup the moment the sodium lamps hit it.
  // --------------------------------------------------------------------------
  var HPAL = {
    // Container liveries. The art direction gives the mid-tone; a livery also
    // needs the chalked end it fades toward (UV and salt kill the pigment long
    // before the steel goes) and a deep end for the shaded webs and troughs.
    ctnRed:   rgb(0x7a2f28), ctnRedFade:   rgb(0x9c6259), ctnRedDk:   rgb(0x431a16),
    ctnBlue:  rgb(0x1f4a6b), ctnBlueFade:  rgb(0x5a7d94), ctnBlueDk:  rgb(0x122a3c),
    ctnGreen: rgb(0x2c5040), ctnGreenFade: rgb(0x647d6d), ctnGreenDk: rgb(0x172c22),
    ctnGrey:  rgb(0x6f7069), ctnGreyFade:  rgb(0x9b9c93), ctnGreyDk:  rgb(0x3c3d39),
    // Dock concrete, its cool aggregate, and the water film over it.
    dockGrey: rgb(0x4a4f55), dockDk: rgb(0x2c3034), dockLt:   rgb(0x757b81),
    aggCool:  rgb(0x7d8288), aggCoolDk: rgb(0x4a4e53), aggCoolLt: rgb(0xa3a8ad),
    wetDark:  rgb(0x16191c), wetSheen:  rgb(0x232a30),
    // Sea, foam, and the scum that collects in the lee of a quay wall.
    seaDeep:  rgb(0x080d12), seaMid: rgb(0x141d24), foam: rgb(0x9fadb2),
    scum:     rgb(0x4b4a3a),
    // Ship: painted topsides, bitumen boot topping, antifouling below the
    // waterline, and the barnacle/weed band that grows right at it.
    hullTop:  rgb(0x2b3238), hullTopLt: rgb(0x4d565d), hullBoot: rgb(0x1b1817),
    antifoul: rgb(0x5e2a20), barnacle:  rgb(0xa9a494), weed:     rgb(0x2f3a24),
    // Galvanising: bright spelter, and the chalky white oxide it becomes.
    galv:     rgb(0x8d949a), galvChalk: rgb(0xb6bcbd),
    // PVC tarpaulin, laid fibre rope, reefer casing, apron markings, oil.
    //
    // These four were all authored a stop or two too bright on the first pass
    // and photographed as a yellow wall, a white venetian blind, a golden
    // hawser and a cream fence. Nothing in a terminal at 02:00 in the rain is
    // that light: a soaked rope is a dark grey-brown, a reefer casing is
    // filthy off-white, and apron paint is thirty years of tyre rubber over a
    // dirty ochre. Mean linear albedo per map is now 0.05-0.16 across the set.
    pvc:      rgb(0x2f4a55), pvcLt:  rgb(0x6a838c), pvcDk:  rgb(0x172930),
    manila:   rgb(0x6b5c3e), manilaLt: rgb(0x968467), manilaDk: rgb(0x342c1c),
    reefer:   rgb(0x9aa09e), reeferDk: rgb(0x5e6362),
    lineYellow: rgb(0xa88b32), lineWorn: rgb(0x6e6340),
    // Weathered galvanising on a roof sheet is not the bright spelter of a new
    // one - it is a dark grey-green oxide under algae and water staining.
    galvOld:  rgb(0x5c625f),
    oil:      rgb(0x131211)
  };

  // Trapezoidal profile for rolled sheet, wrapping in p: flat crest, angled
  // web, flat trough. A sine wave is the wrong shape for a shipping container
  // or a box-profile roof - the flats are what read as flats, and the webs are
  // what catch a raking lamp as a hard line.
  function trap(p, crest, web) {
    p = p - Math.floor(p);
    return 1 - sstep(crest, crest + web, p) + sstep(1 - web, 1, p);
  }

  // Fixings: a wrapping grid of heads with a washer and a dished seat, jittered
  // off the lattice so the eye cannot count it. Every fixing on a wet steel
  // roof is a rust source, so it also weeps downward (o.weep = streak length as
  // a fraction of the tile). Runs AFTER the main loop - it edits S in place.
  function stampBolts(g, S, o) {
    var size = g.size;
    var cols = Math.max(1, o.cols | 0), rows = Math.max(1, o.rows | 0);
    var R = size * (o.r || 0.008);
    var span = Math.ceil(R * 2.8);
    var proud = o.proud === undefined ? 0.05 : o.proud;
    var rustK = o.rust === undefined ? 1 : o.rust;
    var j, k, yy, xx, s2, x2;
    for (j = 0; j < rows; j++) {
      for (k = 0; k < cols; k++) {
        var hx = hash2i(k, j, (o.salt | 0) + 11), hy = hash2i(j, k, (o.salt | 0) + 13);
        var rusty = hash2i(k + 5, j + 9, (o.salt | 0) + 17) * rustK;
        var px = o.px ? o.px(k, hx) : ((k + 0.5) * size / cols + (hx - 0.5) * size * (o.jitter || 0.03));
        var py = o.py ? o.py(j, hy) : ((j + 0.5) * size / rows + (hy - 0.5) * size * (o.jitter || 0.03));
        for (yy = -span; yy <= span; yy++) {
          var wy = ((Math.round(py + yy) % size) + size) % size;
          var rowo = wy * size;
          for (xx = -span; xx <= span; xx++) {
            var d = Math.sqrt(xx * xx + yy * yy) / R;
            if (d > 2.8) continue;
            var wx = ((Math.round(px + xx) % size) + size) % size;
            var ii = rowo + wx;
            var head = sstep(1.05, 0.82, d);
            var washer = sstep(1.95, 1.62, d) * sstep(0.98, 1.16, d);
            var seat = sstep(2.7, 2.05, d) * sstep(1.55, 1.90, d);
            S.h[ii] += head * proud + washer * 0.018 - seat * 0.012;
            tint(S, ii, PAL.steelDk, head * 0.55 + washer * 0.30);
            tint(S, ii, PAL.rust, (head * 0.50 + washer * 0.38 + seat * 0.50) * rusty);
            tint(S, ii, PAL.rustDeep, seat * rusty * 0.45);
            S.ro[ii] = sat(lerp(S.ro[ii], 0.34 + rusty * 0.58,
                                sat(head * 0.85 + washer * 0.40 + seat * 0.30)));
            S.me[ii] = sat(lerp(S.me[ii], 0.90 - rusty * 0.95, sat(head * 0.85 + washer * 0.40)));
          }
        }
        if (o.weep && rusty > 0.05) {
          var len = Math.max(2, Math.round(size * o.weep * (0.35 + rusty)));
          for (s2 = 1; s2 < len; s2++) {
            var t2 = s2 / len;
            var wy2 = ((Math.round(py) + s2) % size + size) % size;
            var wR = R * (0.5 + t2 * 0.55);
            var ro2 = wy2 * size;
            for (x2 = -Math.ceil(wR); x2 <= Math.ceil(wR); x2++) {
              var kk = (1 - Math.abs(x2) / wR) * (1 - t2) * rusty;
              if (kk <= 0) continue;
              var wx2 = ((Math.round(px) + x2) % size + size) % size;
              var i2 = ro2 + wx2;
              tint(S, i2, PAL.rust, kk * 0.50);
              tint(S, i2, PAL.rustDeep, kk * kk * 0.35);
              S.ro[i2] = sat(S.ro[i2] + kk * 0.18);
              S.me[i2] = sat(S.me[i2] * (1 - kk * 0.85));
            }
          }
        }
      }
    }
  }

  // Scattered leaves for the foliage atlas. Rasterised analytically (no canvas
  // path fills) so the height profile is available for the normal map.
  function stampLeaves(g, S, o) {
    var size = g.size, rng = g.rng;
    var cosA, sinA;
    for (var c = 0; c < (o.count | 0); c++) {
      var cx = rng.next() * size, cy = rng.next() * size;
      var ang = rng.next() * 6.283;
      var L = size * (o.lenMin + rng.next() * (o.lenMax - o.lenMin));
      var W = L * (0.30 + rng.next() * 0.22);
      var dry = rng.next();
      cosA = Math.cos(ang); sinA = Math.sin(ang);
      var R = Math.ceil(L * 0.62);
      var lift = 0.35 + rng.next() * 0.5;
      for (var yy = -R; yy <= R; yy++) {
        for (var xx = -R; xx <= R; xx++) {
          var lx = (xx * cosA + yy * sinA) / L + 0.5;
          if (lx < 0 || lx > 1) continue;
          var ly = (-xx * sinA + yy * cosA);
          // leaf silhouette: widest at 45% of its length, pointed tip
          var hw = W * 0.5 * Math.pow(Math.sin(Math.PI * Math.pow(lx, 0.85)), 0.62);
          if (hw <= 0.5) continue;
          var t = ly / hw;
          if (t < -1 || t > 1) continue;
          var px = ((Math.round(cx + xx) % size) + size) % size;
          var py = ((Math.round(cy + yy) % size) + size) % size;
          var i = py * size + px;
          var dome = Math.cos(t * 1.5707963) * Math.sin(Math.PI * lx);
          var vein = sstep(0.16, 0.0, Math.abs(t)) * 0.55 +
                     sstep(0.10, 0.0, Math.abs(Math.abs(t) - 0.42 - lx * 0.2)) * 0.18;
          var hh = 0.5 + dome * 0.22 * lift + vein * 0.10;
          if (hh <= S.h[i] && S.al[i] > 0.5) continue;   // keep the topmost leaf
          S.h[i] = hh;
          S.al[i] = 1;
          var base = dry > 0.62 ? PAL.foliageDry : PAL.foliage;
          S.cr[i] = base[0]; S.cg[i] = base[1]; S.cb[i] = base[2];
          // tips dry out first, centre stays greener, undersides paler
          tint(S, i, PAL.foliageDry, sat((lx - 0.55) * 1.9) * (0.35 + dry * 0.5));
          tint(S, i, PAL.foliageDk, sat(1 - dome * 1.6) * 0.45);
          tint(S, i, PAL.dust, sat(dome - 0.55) * 0.30);
          // Per-leaf chroma lottery. Some leaves are still green, some have
          // gone to straw and the dead ones are a near-neutral brown. A canopy
          // where every leaf sits at the same saturation is a decal sheet.
          if (dry > 0.72) { tint(S, i, PAL.dirt, 0.46); desat(S, i, 0.70); }
          else if (dry < 0.32) { tint(S, i, PAL.foliageWet, 0.70); }
          // dust film on the upper leaf surfaces kills their chroma outright
          desat(S, i, sat((dome - 0.24) * 1.7) * (0.24 + dry * 0.62));
          shade(S, i, 0.86 + 0.28 * dome);
          S.ro[i] = 0.62 + 0.24 * (1 - dome) + dry * 0.12;
          S.me[i] = 0;
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // WOVEN CLOTH - irregular thread layout
  //
  // Every cloth recipe here used to resolve its weave with `floor(u * threads)`,
  // which produces a mathematically perfect lattice: every yarn exactly the same
  // width, every interstice exactly the same size, in both axes, forever. Painted
  // into ALBEDO at a 1.78:1 contrast that is not cloth, it is graph paper - and
  // once the tile is smaller on screen than its own thread pitch it mips into a
  // hard uniform orthogonal grid (the FABRIC plate in the material chart, the
  // fizz on the sandbags). It hits 'perfectly uniform anything' twice over.
  //
  // The structural fix has two halves:
  //
  //  1. The weave comes out of albedo almost entirely (a +-5% shimmer, not a
  //     +-28% one) and lives in HEIGHT, AO and ROUGHNESS instead - which is
  //     where a real weave's read comes from: self-shadowing between the yarns
  //     and a sheen off the crowns. materials.js already declares a sheen lobe
  //     on these; this is what finally gives it something to do.
  //
  //  2. The thread grid stops being a grid. Yarn is spun with real tolerances:
  //     the pitch wanders, roughly one yarn in twenty-five is a slub two
  //     diameters thick and takes up far more dye, dye take-up varies yarn to
  //     yarn anyway, and every fifteenth warp has floated over its wefts or
  //     been pulled. So the layout is authored as an explicit table of wrapping
  //     yarn boundaries and a recipe LOOKS ITS THREAD UP instead of flooring a
  //     coordinate. Cost is one table lookup per axis per texel; the payoff is
  //     that the lattice cannot be uniform at any mip.
  // --------------------------------------------------------------------------
  function threadLayout(g, T, salt, opt) {
    T = Math.max(4, T | 0);
    opt = opt || {};
    var wMin = opt.wMin === undefined ? 0.70 : opt.wMin;
    var wMax = opt.wMax === undefined ? 1.40 : opt.wMax;
    var slubP = opt.slub === undefined ? 0.04 : opt.slub;
    var floatEvery = opt.floatEvery === undefined ? 15 : opt.floatEvery;
    var b = new Float32Array(T + 1);
    var w = new Float32Array(T);
    var iw = new Float32Array(T);     // 1 / width, for the in-yarn fraction
    var dye = new Float32Array(T);    // per-yarn dye take-up
    var crown = new Float32Array(T);  // crown profile: <1 flat/fat, >1 thin
    var flt = new Float32Array(T);    // floating / pulled yarn
    var i, tot = 0;
    for (i = 0; i < T; i++) {
      var h1 = hash2i(i, 0, salt);
      var h2 = hash2i(0, i, salt + 17);
      var h3 = hash2i(i, i + 7, salt + 31);
      var wd = wMin + h1 * (wMax - wMin);
      var slub = h2 < slubP;
      if (slub) wd *= 1.6 + h3 * 0.6;
      w[i] = wd; tot += wd;
      // A slub is a thick soft lump of loosely spun fibre: it drinks dye, so it
      // is markedly darker than the yarn either side of it. Both distributions
      // are centred on 1.0 so this layer adds VARIANCE without moving the mean
      // albedo of the map (level.js measures some of these).
      dye[i] = slub ? (0.78 + h3 * 0.10) : (0.93 + h1 * 0.14);
      crown[i] = slub ? (0.72 + h3 * 0.20) : (0.86 + h2 * 0.28);
      flt[i] = (h3 < 1 / floatEvery) ? 1 : 0;
    }
    var k = T / tot;                  // renormalise: the pitch is preserved
    for (i = 0; i < T; i++) { w[i] *= k; iw[i] = 1 / w[i]; b[i + 1] = b[i] + w[i]; }
    b[T] = T;
    var L = Math.max(64, g.size * 2);
    var lut = new Int32Array(L);
    var p = 0, sc = T / L;
    for (i = 0; i < L; i++) {
      var u = i * sc;
      while (p < T - 1 && u >= b[p + 1]) p++;
      lut[i] = p;
    }
    return { T: T, b: b, iw: iw, dye: dye, crown: crown, flt: flt,
             lut: lut, L: L, scale: L / T };
  }

  // Resolve a continuous thread coordinate to (yarn index, 0..1 across it).
  // Results land in module scratch rather than an object so the inner loops of
  // five recipes allocate nothing.
  var _thIdx = 0, _thF = 0;
  function threadAt(TL, u) {
    var T = TL.T;
    u -= Math.floor(u / T) * T;
    var k = (u * TL.scale) | 0;
    if (k < 0) k = 0; else if (k >= TL.L) k = TL.L - 1;
    var idx = TL.lut[k];
    if (idx < T - 1 && u >= TL.b[idx + 1]) idx++;
    var f = (u - TL.b[idx]) * TL.iw[idx];
    _thIdx = idx;
    _thF = f < 0 ? 0 : (f > 1 ? 1 : f);
  }

  // ==========================================================================
  // MATERIAL RECIPES
  // Each one: base tone + large-scale fbm -> structural layer -> wear/grime
  // driven by the height field -> fine detail -> a roughness story.
  // ==========================================================================

  // -- poured concrete floor slab -------------------------------------------
  function genConcrete(g, S) {
    var n = g.n, i;
    var macro = g.fbm(g.buf(0), 3, 4, 0.58, 1, 11, false);   // pour / trowel zones
    var med = g.fbm(g.buf(0), 13, 4, 0.5, 1, 23, false);
    var fine = g.fbm(g.buf(0), 90, 3, 0.5, 1, 31, false);
    var grit = g.fbm(g.buf(0), 280, 2, 0.5, 1, 37, false);
    var agg = g.worley(44, 0.95, 41);                        // exposed aggregate
    var pit = g.worley(150, 1.0, 53);                        // air pockets
    var crack = g.ridged(g.buf(0), 5, 5, 1, 61, true);
    var stain = g.fbm(g.buf(0), 5, 4, 0.6, 1, 71, false);
    var damp = g.fbm(g.buf(0), 4, 3, 0.5, 1, 83, false);
    var C = chromaFields(g, 200);

    S.base(PAL.concrete);
    for (i = 0; i < n; i++) {
      var mc = macro[i], md = med[i];
      var h = 0.60 + (mc - 0.5) * 0.26 + (md - 0.5) * 0.13 +
              (fine[i] - 0.5) * 0.05 + (grit[i] - 0.5) * 0.018;
      // the cement cream wears off in traffic zones and lets the stones show
      var expose = sstep(0.40, 0.70, mc * 0.62 + md * 0.38);
      var stone = sstep(0.52, 0.14, agg.f1[i]);
      h += stone * expose * 0.135;
      var hole = sstep(0.26, 0.05, pit.f1[i]) * sstep(0.30, 0.55, md);
      h -= hole * 0.24;
      var ck = sstep(0.84, 0.995, crack[i]);
      h -= ck * 0.20;
      S.h[i] = h;

      // --- albedo -------------------------------------------------------
      var id = agg.id[i];
      tint(S, i, id < 0.33 ? PAL.aggDark : (id < 0.7 ? PAL.aggregate : PAL.aggLight),
           stone * expose * 0.62);
      tint(S, i, PAL.cement, sat((mc - 0.5) * 1.5) * 0.30);
      shade(S, i, 0.86 + 0.28 * md);
      // grime settles in the low ground and in the cracks
      var low = sstep(0.62, 0.34, h);
      tint(S, i, PAL.grime, low * 0.42 + ck * 0.55 + hole * 0.5);
      // wind-blown sand on the raised, flat parts
      var dusty = sat((h - 0.60) * 2.6) * sstep(0.35, 0.72, stain[i]);
      tint(S, i, PAL.dust, dusty * 0.34);
      // broad discolouration blotches so a 4x4 tiling never reads as a grid
      tint(S, i, PAL.concreteDk, sstep(0.58, 0.86, stain[i]) * 0.22);
      tint(S, i, PAL.sandDk, sstep(0.46, 0.16, stain[i]) * 0.14);
      // damp patch: darker and much smoother
      var wet = sstep(0.66, 0.86, damp[i]) * sstep(0.58, 0.42, h);
      shade(S, i, 1 - wet * 0.42);
      // Iron weight is deliberately low here. Concrete is the palette's one
      // genuinely NEUTRAL grey (#9a958c) and the level needs it to stay that
      // way: if the warm-stain axis is run at full strength on the grey
      // materials too, every surface in the frame lands in the same beige
      // family and the hazy key light finishes the job. The variance comes
      // from the wash and the damp axis instead.
      applyChroma(S, i, C, 1.0, sat(low * 1.2 + wet * 1.4 + ck),
                  { iron: 0.45, bio: 0.7, wash: 0.62 });

      // --- roughness ----------------------------------------------------
      // Coherent 10-40cm zones, authored across the full range. Power-trowelled
      // and foot-polished slab is far smoother than the chalked, dust-filmed
      // parts; the freq-280 grit octave that used to supply the "variation"
      // here is 2 texels wide and dies in mip 1, so it is out entirely.
      var burnish = sat((mc - 0.46) * 2.6);
      var chalk = sat((0.48 - mc) * 2.6);
      var r = 0.72 + (md - 0.5) * 0.24;
      r -= burnish * 0.44 + stone * expose * 0.18;
      r += chalk * 0.34 + hole * 0.12 + low * 0.12 + dusty * 0.18;
      r = lerp(r, 0.04, wet);
      S.ro[i] = sat(r);
      S.me[i] = 0;
    }
    punchScrapes(g, S, { count: 14, lenMin: 0.05, lenMax: 0.3, width: 0.0022,
                         depth: 0.05, rough: 0.62, col: PAL.aggLight, tint: 0.35 });
    punchCraters(g, S, { count: 5, rMin: 0.008, rMax: 0.022, depth: 0.20,
                         rough: 0.95, col: PAL.cement, tint: 0.55, soot: 0.18 });
  }

  // -- board-formed concrete wall -------------------------------------------
  //
  // Two defects drove the previous version, and both were visible from ten
  // metres in alley.png:
  //
  //  * THE PORE FIELD was a spatially uniform Poisson dot pattern at 1-2 texels
  //    painted almost black into the ALBEDO - the worst possible choice of
  //    frequency and channel. Too fine to survive mipping, too hard-edged to
  //    average gracefully: at 2 m the wall was an evenly spaced dark polka-dot
  //    stipple, and by 8 m the dots had mipped to flat grey with nothing in
  //    between. Pores are now 5-10 texels, clustered by a low-frequency density
  //    field, and they act through HEIGHT/AO/ROUGHNESS with only a whisper of
  //    albedo - which is what a depression in a diffuse surface actually does.
  //
  //  * EACH FORMWORK BOARD CARRIED ONE CONSTANT TONE across its whole length,
  //    so a tiling wall rendered as a running-bond patchwork of dark
  //    rectangles, and the seven ruled joint lines per 2.2 m tile were the
  //    single strongest periodic signal in the frame. Board tone now varies
  //    ALONG the board, and the joint is a broken, shallow, low-contrast
  //    feature that fades out over parts of its length like a real one.
  function genConcreteWall(g, S) {
    var n = g.n, size = g.size, i, x, y;
    var macro = g.fbm(g.buf(0), 3, 4, 0.6, 1, 13, false);
    var med = g.fbm(g.buf(0), 16, 4, 0.5, 1, 29, false);
    // 4-64 texel band: aggregate ghosting under the surface and the cement-rich
    // laitance skin that varies over a few centimetres.
    var midA = g.fbm(g.buf(0), 30, 3, 0.6, 1, 131, false);
    var midB = g.fbm(g.buf(0), 68, 3, 0.6, 1, 133, false);
    var fine = g.fbm(g.buf(0), 150, 2, 0.55, 1, 43, false);
    var agg = g.worley(50, 0.95, 59);
    var ghost = g.worley(30, 0.95, 137);     // aggregate ghosting through the skin
    // Sand fraction in the laitance. This is ALBEDO-only speckle: it is the
    // 2-8 texel band the old hard pore dots were (badly) filling, and keeping
    // it out of the height field is what stops it aliasing into the normal.
    var sandI = g.worley(190, 1.0, 147);
    var grit = g.fbm(g.buf(0), 300, 2, 0.5, 1, 149, false);
    // Pores an octave down from where they were, so they are a 1 cm depression
    // rather than a 2 mm hard dot that aliases.
    var pit = g.worley(90, 1.0, 67);
    var poreD = g.fbm(g.buf(0), 5, 3, 0.55, 1, 139, false);   // pore density field
    var crack = g.ridged(g.buf(0), 6, 5, 1, 71, true);
    var blot = g.fbm(g.buf(0), 4, 4, 0.6, 1, 79, false);
    var streakN = g.buf(0); g.fbmA(streakN, 70, 5, 4, 0.5, 1, 89, false);
    // Board-length tone drift: high frequency ALONG the board, near-constant
    // across it. This is what replaces the per-board constant.
    var boardN = g.buf(0); g.fbmA(boardN, 9, 3, 3, 0.55, 1, 141, false);
    // Joint continuity: where a board butt is tight the line vanishes.
    var jointN = g.buf(0); g.fbmA(jointN, 14, 3, 3, 0.5, 1, 143, false);
    // Coherent 10-40cm sealed/chalked field. See genPlaster - this is the layer
    // that decides whether a facade has any specular story at all.
    var polish = g.fbm(g.buf(0), 9, 3, 0.55, 1, 97, false);
    var C = chromaFields(g, 700);
    var seedM = g.buf(0);
    var runoff = g.buf(0);
    for (i = 0; i < n; i++) seedM[i] = sstep(0.60, 0.80, blot[i]);
    g.drip(seedM, runoff, 0.988, true);

    var boards = 7;                        // horizontal formwork boards
    S.base(PAL.concrete);
    for (y = 0; y < size; y++) {
      var by = y * boards / size;
      var bi = Math.floor(by), bf = by - bi;
      var bid = hash2i(0, bi % boards, 5);
      var cup = Math.sin(Math.PI * bf) * 0.010;
      var o = y * size;
      for (x = 0; x < size; x++) {
        i = o + x;
        var mc = macro[i], md = med[i];
        // Broken joint: full strength on maybe half its length, gone elsewhere.
        var joint = sstep(0.042, 0.0, Math.min(bf, 1 - bf)) *
                    sstep(0.34, 0.66, jointN[i]);
        var h = 0.62 + (mc - 0.5) * 0.13 + (md - 0.5) * 0.075 +
                (midA[i] - 0.5) * 0.055 + (midB[i] - 0.5) * 0.032 +
                (fine[i] - 0.5) * 0.026;
        h += cup - joint * 0.030;
        // shutter-board grain in the 16-48 texel band, wandering per board
        h += Math.sin(by * 26.0 + bid * 40 + md * 5.0) * 0.016 * (1 - joint) *
             (0.45 + midA[i]);
        var spall = sstep(0.63, 0.80, blot[i] * 0.7 + md * 0.3);
        h -= spall * 0.075;
        h += spall * sstep(0.50, 0.12, agg.f1[i]) * 0.055;
        // ---- pores ------------------------------------------------------
        // Density clustered by a low-frequency field so there are dense and
        // sparse zones; real fair-faced concrete gathers its blowholes under
        // the aggregate and against the form face, never at a uniform rate.
        var dens = sstep(0.40, 0.66, poreD[i] * 0.7 + midA[i] * 0.3);
        var hole = sstep(0.44, 0.10, pit.f1[i]) * (0.18 + dens * 1.05);
        if (hole > 1) hole = 1;
        h -= hole * 0.055;
        // honeycomb: a few zones where the pour did not close at all
        var honey = sstep(0.80, 0.94, poreD[i]) * sstep(0.42, 0.16, agg.f1[i]);
        h -= honey * 0.075;
        var ck = sstep(0.86, 0.995, crack[i]);
        h -= ck * 0.13;
        S.h[i] = h;

        // ---- albedo -----------------------------------------------------
        // Board tone drifts ALONG the board (boardN is 9 cycles across x and
        // 3 across y) with only a hint of per-board offset on top.
        var bt = (boardN[i] - 0.5) * 0.16 + (bid - 0.5) * 0.022;
        shade(S, i, 1 + bt);
        tint(S, i, PAL.cement, sat(0.5 + bt * 3.0) * 0.14);
        // Broad pour-to-pour tone drift, dialled back: broad blobs are exactly
        // what a column average keeps, and therefore what reads as a repeat.
        tint(S, i, PAL.concreteDk, sat((mc - 0.46) * 1.7) * 0.20);
        tint(S, i, PAL.cement, sat((0.52 - mc) * 1.7) * 0.20);
        // 4-64 texel life in the albedo, not only in the relief
        shade(S, i, 0.84 + 0.32 * midA[i]);
        shade(S, i, 0.92 + 0.16 * midB[i]);
        // aggregate ghosting: stones just under the laitance read as pale
        // rounded shadows without ever breaking the surface
        tint(S, i, ghost.id[i] < 0.5 ? PAL.aggregate : PAL.aggLight,
             sstep(0.34, 0.10, ghost.f1[i]) * 0.20);
        var sp = sstep(0.36, 0.10, sandI.f1[i]);
        tint(S, i, sandI.id[i] < 0.42 ? PAL.aggDark : PAL.cement, sp * 0.46);
        tint(S, i, PAL.aggLight, sat((grit[i] - 0.60) * 3.2) * 0.26);
        tint(S, i, PAL.aggDark, sat((0.40 - grit[i]) * 3.2) * 0.26);
        shade(S, i, 0.93 + 0.14 * fine[i]);
        var id = agg.id[i];
        tint(S, i, id < 0.35 ? PAL.aggDark : (id < 0.72 ? PAL.aggregate : PAL.aggLight),
             (spall * sstep(0.50, 0.12, agg.f1[i]) + honey * 0.8) * 0.6);
        tint(S, i, PAL.concreteDk, spall * 0.20 + honey * 0.30);
        shade(S, i, 0.88 + 0.24 * md);
        // A honeycombed pour and a lost spall are HOLES, not tints. Their
        // shadow is where a fair-faced wall's low end lives; without it the
        // albedo spans 1.36x and the wall reads as painted card.
        shade(S, i, 1 - honey * 0.30 - spall * spall * 0.16);
        var low = sstep(0.62, 0.40, h);
        // Pores act through relief. A near-black disc in the albedo is what
        // made them alias; a pore is a depression that catches occlusion.
        tint(S, i, PAL.grime, low * 0.32 + joint * 0.18 + ck * 0.5 + hole * 0.12);
        tint(S, i, PAL.soot, ck * ck * 0.40 + hole * hole * 0.30);
        shade(S, i, 1 - ck * ck * 0.30 - hole * hole * 0.18 - joint * joint * 0.12);
        // dirt weeping down from the blotches
        var run = runoff[i] * sstep(0.34, 0.62, streakN[i]);
        tint(S, i, PAL.grime, run * 0.46);
        tint(S, i, PAL.dust, sat((h - 0.63) * 3.0) * 0.22);
        tint(S, i, PAL.efflor, sstep(0.70, 0.92, blot[i]) * sstep(0.55, 0.30, md) * 0.30);
        applyChroma(S, i, C, 1, sat(run * 1.5 + low * 0.8 + honey), { wash: 0.48 });

        // --- roughness --------------------------------------------------
        // Full-range, spatially coherent. The old map lived inside a 0.07
        // window at the top of the GGX curve, so an entire building facade had
        // one dead-matte sheen; what variance it did have came from a freq-320
        // octave that dies in mip 1. Only the coarse fields touch it now.
        var seal = sat((polish[i] - 0.50) * 2.8);       // damp / sealed / sound
        var chalk = sat((0.48 - polish[i]) * 2.8);      // weathered, chalked face
        var r = 0.52 + (md - 0.5) * 0.28;
        r -= seal * 0.46;
        r += chalk * 0.44 + spall * 0.30 + low * 0.12 + joint * 0.10;
        r += hole * 0.26 + honey * 0.24;                // pores are chalky inside
        r += run * 0.28;                                // dust film under runoff
        r -= sstep(0.5, 0.12, agg.f1[i]) * spall * 0.18;  // polished aggregate
        S.ro[i] = sat(r);
        S.me[i] = 0;
      }
    }
    // Form-tie holes. Scattered, not on a grid - a deliberate lattice inside a
    // 2.2 m tile is a feature the eye can count and it announces the repeat.
    (function () {
      var rng = g.rng;
      for (var t = 0; t < 4; t++) {
        var cx = rng.next() * size, cy = rng.next() * size;
        var R = size * (0.006 + rng.next() * 0.004);
        var rusty = 0.35 + rng.next() * 0.65;
        var span = Math.ceil(R * 3.4);
        for (var yy = -span; yy <= span; yy++) {
          var wy = ((Math.round(cy + yy) % size) + size) % size;
          var ro = wy * size;
          for (var xx = -span; xx <= span; xx++) {
            var d = Math.sqrt(xx * xx + yy * yy) / R;
            if (d > 3.4) continue;
            var wx = ((Math.round(cx + xx) % size) + size) % size;
            var ii = ro + wx;
            var core = sstep(1.15, 0.80, d);
            var plug = sstep(1.9, 1.3, d) * sstep(1.0, 1.2, d);
            S.h[ii] -= core * 0.10;
            S.h[ii] += plug * 0.012;
            tint(S, ii, PAL.grime, core * 0.55);
            tint(S, ii, PAL.cement, plug * 0.40);
            // rust weep below the tie, fading over a few centimetres
            if (yy > 0) tint(S, ii, PAL.rust, rusty * sstep(3.4, 0.9, d) *
                                              sat(yy / (R * 3.4)) * 0.45);
            S.ro[ii] = sat(S.ro[ii] + core * 0.20);
          }
        }
      }
    })();
    // The 3x2 tie-rod grid is gone: a deliberate hole pattern inside a 2.2m
    // tile is a feature the eye can count, so it announced the repeat every
    // 2.2m across every concrete wall in the level. Impact damage stays, but
    // only as a few chips small enough (~12mm at world scale) to read as
    // surface rather than as a stamp - anything bigger belongs in vfx.js's
    // decal pass, placed once, at world scale.
    punchCraters(g, S, { count: 3, rMin: 0.005, rMax: 0.011, depth: 0.16,
                         rough: 0.9, col: PAL.cement, tint: 0.4, soot: 0.12 });
  }

  // -- sun-baked lime plaster over concrete (the hero surface of the level) --
  //
  // REWRITTEN around two facts the previous recipe got wrong.
  //
  // 1. IT IS A TWO-MATERIAL SURFACE. Spalled plaster does not "get darker" - a
  //    plate of lime skin snaps off and you are looking at grey cement render
  //    and its aggregate, four hundred sRGB steps away from the cream around
  //    it. The old map contained exactly one material with a luminance ramp on
  //    it (P95/P05 = 1.25), which is why every facade read as airbrushed.
  //
  // 2. THE BAND THAT MATTERS WAS EMPTY. At 0.5 tiles/m one texel is 2 mm, so
  //    the 4-64 texel band IS the 8-128 mm band - trowel chatter, map-cracking,
  //    spall craters, aggregate pop, everything you actually see standing next
  //    to a wall. Octave-band RMS fell 2.5x per octave through it: the spectrum
  //    of a blur, not of a surface. It is now authored explicitly, at
  //    amplitude, by structures rather than by another octave of fbm.
  //
  // The crack network is built from a worley CELL-PLATE model (a plate either
  // survives or has popped off, and the break follows the crack that bounds
  // it) rather than from the cell-border distance field. That distinction
  // matters: a border term draws a continuous net - the "floating hexagonal
  // wireframe" the critics saw - whereas thresholding the cell ID makes most
  // plates survive and the missing ones cluster, which is what spalling is.
  function genPlaster(g, S) {
    var n = g.n, i;
    var macro = g.fbm(g.buf(0), 2, 4, 0.62, 1, 17, false);
    var trowel = g.buf(0); g.fbmA(trowel, 5, 13, 4, 0.55, 1, 23, false);
    // Trowel chatter: the float leaves a directional ridged corduroy at roughly
    // a 2 cm pitch. Directional (fx >> fy) and ridged, so it reads as tool
    // marks and not as another layer of clouds.
    var chatter = g.buf(0); g.fbmA(chatter, 60, 9, 3, 0.5, 1, 111, false);
    var med = g.fbm(g.buf(0), 15, 4, 0.5, 1, 29, false);
    // THE 4-64 TEXEL BAND, authored at full amplitude in two dedicated stacks.
    var midA = g.fbm(g.buf(0), 34, 3, 0.62, 1, 101, false);
    var midB = g.fbm(g.buf(0), 76, 3, 0.62, 1, 103, false);
    var fine = g.fbm(g.buf(0), 150, 2, 0.55, 1, 37, false);
    var grit = g.fbm(g.buf(0), 300, 2, 0.5, 1, 41, false);
    var spallN = g.fbm(g.buf(0), 4, 3, 0.52, 1, 47, false);
    // Plate networks: coarse (~10 cm) and fine (~4 cm) map-cracking.
    var plateA = g.worley(22, 0.9, 53);
    var plateB = g.worley(52, 0.95, 55);
    var agg = g.worley(96, 0.95, 59);          // aggregate in the render coat
    var sandI = g.worley(200, 1.0, 57);        // sharp sand in the lime itself
    var crack = g.ridged(g.buf(0), 7, 5, 1, 61, true);
    var hair = g.ridged(g.buf(0), 26, 3, 1, 67, true);
    var streakN = g.buf(0); g.fbmA(streakN, 80, 6, 4, 0.5, 1, 71, false);
    var polish = g.fbm(g.buf(0), 8, 3, 0.55, 1, 73, false);
    var blotch = g.fbm(g.buf(0), 3, 4, 0.6, 1, 79, false);
    // Where the wall is crazed at all. Cracking is patchy - a wall that is
    // uniformly crazed edge to edge is a Voronoi diagram, not a wall.
    var czone = g.fbm(g.buf(0), 5, 3, 0.55, 1, 83, false);
    var seg = g.fbm(g.buf(0), 40, 2, 0.5, 1, 87, false);   // breaks cracks into runs
    var C = chromaFields(g, 500);
    var seedM = g.buf(0), runoff = g.buf(0);
    for (i = 0; i < n; i++) seedM[i] = sstep(0.62, 0.82, spallN[i]);
    g.drip(seedM, runoff, 0.9905, true);
    var sub = g.buf(0);          // substrate exposure: 0 lime skin, 1 bare render

    S.base(PAL.plaster);
    for (i = 0; i < n; i++) {
      var mc = macro[i], md = med[i];
      // Crazing must be PATCHY. sat((czone - 0.42) * 2.6) never actually
      // reaches zero on a field whose mean is 0.5, so the whole wall ended up
      // carrying the same crocodile net edge to edge - which is a uniformity
      // tell in its own right, and at 2 m it reads as dried mud rather than as
      // plaster. Cut where the field lives instead: ~35% of the tile is sound
      // and uncrazed, ~20% is fully crazed, and the rest transitions.
      var cz = sstep(0.44, 0.62, czone[i]);
      var brk = sstep(0.30, 0.62, seg[i]);
      // ---- crack network -------------------------------------------------
      // Thin, broken, and only where the zone field says so.
      var ckA = sstep(0.12, 0.0, plateA.f2[i] - plateA.f1[i]) * cz * brk;
      var ckB = sstep(0.14, 0.0, plateB.f2[i] - plateB.f1[i]) * cz * cz * brk;
      var craze = sat(ckA * 0.9 + ckB * 0.7);
      // ---- plate loss: a bounded plate of skin has come off entirely -------
      // Coverage matters as much as contrast. A third of the wall showing bare
      // render is a demolition site; the read is a sound cream facade with
      // damage in it, so plate loss stays under ~10% of the tile.
      var lostA = sstep(0.855, 0.925, plateA.id[i]) * sat((cz - 0.30) * 2.2) *
                  sstep(0.46, 0.68, spallN[i] * 0.7 + md * 0.3);
      var lostB = sstep(0.885, 0.945, plateB.id[i]) * cz *
                  sstep(0.46, 0.68, spallN[i] * 0.5 + trowel[i] * 0.5);
      var lost = sat(lostA + lostB * 0.85);
      sub[i] = lost;

      var cht = 1 - Math.abs(chatter[i] * 2 - 1); cht *= cht;

      var h = 0.68 + (mc - 0.5) * 0.075 + (trowel[i] - 0.5) * 0.055 +
              (md - 0.5) * 0.040 + (midA[i] - 0.5) * 0.052 +
              (midB[i] - 0.5) * 0.034 + (fine[i] - 0.5) * 0.016 +
              (grit[i] - 0.5) * 0.007 + (cht - 0.45) * 0.026;
      // The plaster skin has real thickness; losing it is a step, not a fade.
      h -= lost * 0.055;
      var stone = sstep(0.16 + agg.id[i] * 0.24, 0.04, agg.f1[i]);
      h += lost * stone * 0.022;
      var ck = sstep(0.80, 0.99, crack[i]) * (1 - lost * 0.7);
      var hc = sstep(0.88, 0.995, hair[i]) * (1 - lost * 0.8);
      h -= ck * 0.060 + hc * 0.022 + craze * 0.040;
      S.h[i] = h;

      // --- albedo -------------------------------------------------------
      var hp = h + lost * 0.055;
      tint(S, i, PAL.plasterHi, sat((hp - 0.68) * 4.2) * 0.52);
      tint(S, i, PAL.plasterDk, sstep(0.68, 0.54, hp) * 0.40);
      // 4-64 texel tonal life IN THE ALBEDO, not just in the relief. A normal
      // map with high-frequency grain and an albedo without it is the worst
      // combination there is - it reads as vacuum-formed plastic.
      shade(S, i, 0.86 + 0.28 * midA[i]);
      shade(S, i, 0.93 + 0.14 * midB[i]);
      tint(S, i, PAL.plasterHi, sat((midB[i] - 0.62) * 3.0) * 0.22);
      tint(S, i, PAL.sandDk, sat((midA[i] - 0.64) * 3.0) * 0.18);
      // sharp sand in the lime - the speckle that fills the 2-8 texel band
      var si = sstep(0.34, 0.10, sandI.f1[i]);
      tint(S, i, sandI.id[i] < 0.45 ? PAL.aggDark : PAL.plasterHi, si * 0.30);
      tint(S, i, PAL.sandDk, sat((mc - 0.55) * 1.9) * 0.16);
      // building-scale weathering drift, kept modest: broad blobs are what
      // survive a column average and therefore what the tiling metric counts.
      tint(S, i, PAL.sandDk, sstep(0.56, 0.86, blotch[i]) * 0.18);
      tint(S, i, PAL.plasterHi, sstep(0.46, 0.16, blotch[i]) * 0.20);
      // ---- THE SECOND MATERIAL ------------------------------------------
      // Bare cement render: grey, essentially neutral, with its own aggregate.
      if (lost > 0.004) {
        tint(S, i, PAL.concSub, lost * 0.88);
        desat(S, i, lost * 0.55);
        var aid = agg.id[i];
        tint(S, i, aid < 0.42 ? PAL.aggDark : (aid < 0.72 ? PAL.aggregate : PAL.concSubLt),
             lost * stone * 0.80);
        // The render coat behind the skin is not one grey either: it varies
        // over a few centimetres and it is markedly darker in the recesses,
        // which is where most of this map's low end has to come from - the
        // plate loss IS the dark population, so if it is a single flat tone
        // the whole albedo lives inside a 1.5x window and reads airbrushed.
        shade(S, i, 1 - lost * (0.24 + 0.30 * (1 - midA[i])) * (1 - stone * 0.6));
        // shadowed break line all the way round the missing plate
        tint(S, i, PAL.grime, lost * sstep(0.30, 0.06, Math.min(plateA.f2[i] - plateA.f1[i],
                                                                plateB.f2[i] - plateB.f1[i])) * 0.55);
      }
      // Value range lives in the FINE features on purpose. The map needs a real
      // 3-4x span between its darkest and lightest texel or it reads as a
      // tinted greyscale - but putting that span into broad blobs is what a
      // column average keeps, so it goes into cracks, breaks and speckle
      // instead, where it survives as material and not as a repeat.
      tint(S, i, PAL.grime, craze * 0.78 + ck * 0.80 + hc * 0.30);
      tint(S, i, PAL.soot, craze * craze * 0.34 + ck * ck * 0.40);
      shade(S, i, 1 - (craze * craze * 0.24 + ck * ck * 0.38 + hc * hc * 0.14));
      // Lime bloom crusts on the crowns: a genuine near-white second material,
      // and the only thing in the recipe that reaches above the base tone.
      tint(S, i, PAL.limeBloom, sstep(0.62, 0.84, C.bloom[i]) *
                                sat((hp - 0.665) * 5.0) * 0.55);
      // dirt runoff streaks weeping down from the damaged patches
      var run = runoff[i] * sstep(0.34, 0.62, streakN[i]) * (1 - lost * 0.55);
      tint(S, i, PAL.grime, run * 0.46);
      tint(S, i, PAL.dirt, run * run * 0.34);
      tint(S, i, PAL.soot, run * run * run * 0.34);
      shade(S, i, 1 - run * run * 0.18);
      tint(S, i, PAL.plasterHi, sat((grit[i] - 0.60) * 3.2) * 0.22);
      tint(S, i, PAL.dust, sat((0.40 - grit[i]) * 3.2) * 0.14);
      // ---- chroma -------------------------------------------------------
      // Lime bloom desaturates toward neutral white, damp shade goes cool grey,
      // iron leaching off fixings goes ochre, sheltered damp goes olive. Four
      // independent axes: without them this is one hue with a luminance ramp.
      applyChroma(S, i, C, 1, sat(run * 1.4 + sstep(0.66, 0.52, hp) * 0.9 + craze), { wash: 0.52 });

      // --- roughness ----------------------------------------------------
      var seal = sat((polish[i] - 0.50) * 2.8);
      var chalk = sat((0.48 - polish[i]) * 2.8);
      var r = 0.52 + (md - 0.5) * 0.26 - sat((trowel[i] - 0.58) * 2.0) * 0.30;
      r -= seal * 0.48;
      r += chalk * 0.42 + lost * 0.34 + ck * 0.16 + craze * 0.20;
      r += run * 0.26;                     // dust film builds under the runoff
      S.ro[i] = sat(r);
      S.me[i] = 0;
    }

    // ---- spall craters, three size classes, hard rims --------------------
    // These are impact- and frost-driven pops, not bullet scars: shallow,
    // steep-walled, and they expose the same render coat the plate loss does.
    // Two size classes stay under ~4 cm at world scale so nothing here is a
    // stamp the eye can count down a 70 m street.
    punchCraters(g, S, { count: 15, rMin: 0.004, rMax: 0.009, depth: 0.070,
                         rough: 0.92, col: PAL.concSub, tint: 0.0, hard: true,
                         rim: 0.014, halo: 1.5, mask: sub });
    punchCraters(g, S, { count: 7, rMin: 0.010, rMax: 0.018, depth: 0.085,
                         rough: 0.94, col: PAL.concSub, tint: 0.0, hard: true,
                         rim: 0.018, halo: 1.6, mask: sub });
    punchCraters(g, S, { count: 2, rMin: 0.022, rMax: 0.036, depth: 0.10,
                         rough: 0.95, col: PAL.concSub, tint: 0.0, hard: true,
                         rim: 0.020, halo: 1.7, mask: sub });
    // Second pass: paint the exposed render into whatever the craters opened.
    // punchCraters only carries a single tint, and a hole in a plaster wall is
    // a different MATERIAL, so the colour has to be applied from the mask.
    for (i = 0; i < n; i++) {
      var m = sub[i];
      if (m <= 0.004) continue;
      var st2 = sstep(0.16 + agg.id[i] * 0.24, 0.04, agg.f1[i]);
      tint(S, i, PAL.concSub, m * 0.82);
      desat(S, i, m * 0.50);
      tint(S, i, agg.id[i] < 0.44 ? PAL.aggDark : PAL.aggregate, m * st2 * 0.70);
      tint(S, i, PAL.grime, m * m * 0.34);
      // A spall crater is a hole: it is shadowed, and it is the deepest value
      // in the map. Painting it as "the same wall, slightly greyer" is what
      // made the damage read as a smudge rather than as missing material.
      shade(S, i, 1 - m * m * 0.26);
    }
    punchScrapes(g, S, { count: 8, lenMin: 0.03, lenMax: 0.10, width: 0.0018,
                         depth: 0.05, rough: 0.9, col: PAL.concSub, tint: 0.4,
                         hbias: 0.7, hRef: 0.68 });
  }

  // -- fired clay brick in running bond -------------------------------------
  //
  // ROUND 3. The brick-to-brick colour lottery was already doing real work, but
  // the GEOMETRY was CAD: every course offset by exactly half a brick, every
  // brick exactly the same length, every bed and perp joint exactly the same
  // width, and no brick anywhere with a spalled face. A bricklayer's line is
  // straight; his bond is not, his bricks are +-5 mm out of the mould, and by
  // the time a wall is eighty years old some of its faces have blown off and
  // somebody has repointed a patch of it with the wrong sand.
  //
  // So each course now carries its own hashed bond offset around the half-bond
  // and its own table of brick boundaries (lengths vary +-12%, perp joints
  // +-30%), the bed joints wander with a low-frequency sag, ~6% of faces are
  // spalled back to raw body, and the repointing is two broad patches with a
  // different mortar tone AND a different joint width rather than a freq-9 rash.
  //
  // The 4-column / 12-course LATTICE is preserved exactly, because materials.js
  // quantises this material's stochastic tile offsets to [4, 12].
  function genBrick(g, S) {
    var n = g.n, size = g.size, i, x, y, k;
    var rows = 12, per = 4;                 // courses, bricks per course
    var face = g.fbm(g.buf(0), 60, 4, 0.5, 1, 13, false);
    var fine = g.fbm(g.buf(0), 200, 3, 0.5, 1, 19, false);
    var macro = g.fbm(g.buf(0), 3, 4, 0.6, 1, 23, false);
    var sandIncl = g.worley(170, 1.0, 29);
    var mortarN = g.fbm(g.buf(0), 130, 3, 0.5, 1, 31, false);
    var mortarAgg = g.worley(150, 1.0, 137);   // sand and shell in the mortar
    var mortarM2 = g.fbm(g.buf(0), 3, 3, 0.6, 1, 139, false);   // repointed patches
    var spallN = g.fbm(g.buf(0), 22, 3, 0.55, 1, 151, false);   // blown faces
    var sag = g.fbm(g.buf(0), 4, 3, 0.55, 1, 153, false);       // the bed line wanders
    var pit = g.worley(90, 1.0, 37);
    var blot = g.fbm(g.buf(0), 5, 4, 0.6, 1, 41, false);
    // Sand-struck face grain. A stock brick is thrown into a sanded mould, so
    // the face carries a fine directional drag texture - it is the reason a
    // real brick face is never one flat colour even over 20 cm.
    var struck = g.buf(0); g.fbmA(struck, 110, 26, 3, 0.55, 1, 141, false);
    var streakN = g.buf(0); g.fbmA(streakN, 90, 6, 4, 0.5, 1, 43, false);
    var C = chromaFields(g, 1100);
    var seedM = g.buf(0), runoff = g.buf(0);
    for (i = 0; i < n; i++) seedM[i] = sstep(0.62, 0.82, blot[i]);
    g.drip(seedM, runoff, 0.991, true);

    // Pulled a little toward the mortar tone: saturated brick red is a strong
    // colour and a whole facade of it fights the sun-baked palette.
    var cols = [PAL.brickA, PAL.brickB, PAL.brickC, PAL.brickD, PAL.brickE];
    for (var ci0 = 0; ci0 < cols.length; ci0++) {
      cols[ci0] = [lerp(cols[ci0][0], PAL.mortar[0], 0.16),
                   lerp(cols[ci0][1], PAL.mortar[1], 0.16),
                   lerp(cols[ci0][2], PAL.mortar[2], 0.16)];
    }
    // ---- per-course brick layout -----------------------------------------
    // Rebuilt when the course index changes - twelve times for the whole map,
    // so the cost is nothing and the payoff is that no two courses share a
    // bond offset, a brick length or a perp-joint width.
    var bC = new Int32Array(size), bF = new Float32Array(size);
    var bD = new Float32Array(size), bW = new Float32Array(size);
    var cB = new Float32Array(per + 1), cJ = new Float32Array(per + 1);
    var bLen = new Float32Array(per);
    var curRow = -1, mwyC = 0.085;
    function layCourse(row) {
      var q, xq;
      // A running bond, but laid by hand: the perp joints wander around the
      // half-brick instead of landing on it to the millimetre.
      var off = ((row & 1) ? 0.5 : 0.0) + (hash2i(0, row, 91) - 0.5) * 0.34;
      off -= Math.floor(off);
      var tot = 0;
      for (q = 0; q < per; q++) { bLen[q] = 0.88 + hash2i(q, row, 93) * 0.24; tot += bLen[q]; }
      var kk = per / tot;                    // the LATTICE pitch is preserved
      cB[0] = off;
      for (q = 0; q < per; q++) cB[q + 1] = cB[q] + bLen[q] * kk;
      for (q = 0; q <= per; q++) cJ[q] = 0.026 + hash2i(q % per, row, 95) * 0.022;
      mwyC = 0.078 + hash2i(0, row, 97) * 0.048;
      for (xq = 0; xq < size; xq++) {
        var t = xq * per / size;
        if (t < cB[0]) t += per;
        q = 0;
        while (q < per - 1 && t >= cB[q + 1]) q++;
        var a0 = t - cB[q], a1 = cB[q + 1] - t;
        bC[xq] = q;
        bF[xq] = a0 / Math.max(1e-5, cB[q + 1] - cB[q]);
        bD[xq] = a0 < a1 ? a0 : a1;
        bW[xq] = a0 < a1 ? cJ[q] : cJ[q + 1];
      }
    }

    for (y = 0; y < size; y++) {
      var yy = y * rows / size;
      var row = Math.floor(yy), fy = yy - row;
      row = ((row % rows) + rows) % rows;
      if (row !== curRow) { layCourse(row); curRow = row; }
      var o = y * size;
      for (x = 0; x < size; x++) {
        i = o + x;
        var col = bC[x], fx = bF[x];
        var bh = hash2i(col, row, 7);
        var bh2 = hash2i(col, row, 11);
        var bh3 = hash2i(col, row, 13);

        // Repointing: two broad patches of the wrong sand, struck to a
        // different width. Computed first because it widens the joint.
        var repoint = sstep(0.58, 0.74, mortarM2[i]);
        // The bed line is set off a string, but eighty years of settlement and
        // a bricklayer's eye put a slow wander in it.
        var fyS = fy + (sag[i] - 0.5) * 0.10;
        var mwx = bW[x] * (1 + repoint * 0.42);
        var mwy = mwyC * (1 + repoint * 0.34);
        // ...and the perp joints are plumb, but they are struck by hand, so the
        // edge of the mortar wanders a couple of millimetres along its length.
        var dx = bD[x] + (blot[i] - 0.5) * 0.12;
        var dy = Math.min(fyS, 1 - fyS);
        // Tighter ramps than before: a struck joint has a real arris, and a
        // seven-texel gradient into it is why the joints were not
        // self-shadowing under the normal map.
        var mortarM = 1 - sstep(mwx * 0.72, mwx * 1.18, dx) * sstep(mwy * 0.72, mwy * 1.18, dy);
        // per-brick tilt: bricks are not co-planar
        var tilt = (bh3 - 0.5) * 0.05 + (fx - 0.5) * (bh - 0.5) * 0.045 +
                   (fy - 0.5) * (bh2 - 0.5) * 0.035;

        var h = 0.70 + tilt + (face[i] - 0.5) * 0.05 + (fine[i] - 0.5) * 0.018 +
                (struck[i] - 0.5) * 0.016;
        // some bricks are recessed / eroded more than others
        var erode = sstep(0.72, 1.0, bh2);
        h -= erode * 0.035;
        var chip = sstep(0.30, 0.05, pit.f1[i]) * sstep(0.55, 0.85, bh3 * 0.5 + face[i] * 0.5);
        h -= chip * 0.09;
        // ---- spalled faces --------------------------------------------------
        // Frost and salt get behind the fired skin and blow it off in a flake a
        // few millimetres deep, exposing the soft pale body underneath. It is
        // the most characteristic damage a brick wall has and the map had none.
        var spall = sstep(0.935, 0.975, bh3) * sstep(0.52, 0.30, spallN[i]);
        h -= spall * 0.052;
        // ---- broken arrises ------------------------------------------------
        // A perfect sharp edge on every one of 48 bricks is the single loudest
        // "this is a procedural grid" tell in the map. The corners and edges of
        // a laid brick are knocked off in handling, and they weather back
        // first, so the arris is chewed at a per-brick rate.
        var eDist = Math.min(dx / Math.max(mwx, 1e-4), dy / Math.max(mwy, 1e-4));
        var arris = sstep(1.45, 0.55, eDist);
        var knock = arris * sstep(0.30, 0.72, face[i] * 0.55 + fine[i] * 0.45) *
                    (0.35 + bh2 * 0.9);
        // corner damage is worse than edge damage - two arrises meet there
        var corner = sstep(2.3, 0.8, (dx / Math.max(mwx, 1e-4)) + (dy / Math.max(mwy, 1e-4))) *
                     sstep(0.42, 0.78, bh3);
        h -= (knock * 0.045 + corner * 0.055) * (1 - mortarM);
        // mortar sits back from the brick face and has its own coarse texture.
        // It is NOT a flat grey slab: struck-and-tooled lime mortar is full of
        // sand and shell, it slumps, and half of it has been repointed at some
        // point in eighty years with a different sand.
        var mAgg = sstep(0.30, 0.06, mortarAgg.f1[i]);
        h = lerp(h, 0.525 + (mortarN[i] - 0.5) * 0.055 + (macro[i] - 0.5) * 0.03 +
                    mAgg * 0.030 - repoint * 0.018, mortarM);
        S.h[i] = h;

        // --- albedo -----------------------------------------------------
        var ci = Math.floor(bh * 5) % 5;
        var c = cols[ci];
        S.cr[i] = c[0]; S.cg[i] = c[1]; S.cb[i] = c[2];
        // ---- per-brick tonal GRADIENT --------------------------------------
        // A brick is fired in a stack, so one end sees more heat than the other
        // and the face carries a smooth tonal ramp across it. Every brick face
        // being one uniform colour is what turns a wall into a colour-swatch
        // chart; a ramp at a per-brick angle is what breaks it.
        var gA = (bh2 - 0.5) * 6.2831853;
        var ramp = (fx - 0.5) * Math.cos(gA) + (fy - 0.5) * Math.sin(gA);
        shade(S, i, 1 + ramp * (0.16 + bh3 * 0.22));
        tint(S, i, ramp > 0 ? PAL.brickB : PAL.brickC, Math.abs(ramp) * (0.10 + bh * 0.26));
        shade(S, i, 0.84 + 0.34 * face[i] + (bh3 - 0.5) * 0.12);
        // sand-struck face: the mould sand drags a fine directional grain that
        // reads at arm's length, plus lime and sand inclusions in the clay
        shade(S, i, 0.90 + 0.20 * struck[i]);
        tint(S, i, PAL.dust, sat((struck[i] - 0.62) * 3.2) * 0.26);
        tint(S, i, PAL.dust, sstep(0.14, 0.02, sandIncl.f1[i]) * 0.45);
        tint(S, i, PAL.brickC, sstep(0.35, 0.75, fine[i]) * 0.14);
        // fire-flashing: darker scorched faces on a subset of bricks
        tint(S, i, PAL.soot, sstep(0.80, 1.0, bh) * 0.30);
        // ---- knocked arrises expose the raw fired body ---------------------
        // Fresh break is paler and greyer than the weathered face, and the
        // corner damage is deeper still.
        tint(S, i, PAL.brickD, (knock * 0.55 + corner * 0.70) * (1 - mortarM));
        desat(S, i, (knock * 0.20 + corner * 0.30) * (1 - mortarM));
        // ---- a blown face is soft, pale, chalky raw body --------------------
        var spallF = spall * (1 - mortarM);
        if (spallF > 0) {
          tint(S, i, PAL.brickD, spallF * 0.72);
          tint(S, i, PAL.plasterDk, spallF * 0.30);
          desat(S, i, spallF * 0.40);
          shade(S, i, 1 + spallF * 0.06);
        }
        // ---- mortar: sanded, tooled, and half of it repointed ---------------
        tint(S, i, PAL.mortar, mortarM * 0.92);
        tint(S, i, PAL.sandDk, mortarM * repoint * 0.34);
        tint(S, i, mortarAgg.id[i] < 0.5 ? PAL.aggDark : PAL.plasterHi,
             mortarM * mAgg * 0.42);
        shade(S, i, 1 - mortarM * (0.12 - 0.24 * mortarN[i]));
        shade(S, i, 1 - mortarM * repoint * 0.10);
        // efflorescence: salt bloom creeping out of the mortar
        var eff = sstep(0.55, 0.85, blot[i]) * sat(mortarM * 1.3 + 0.25);
        tint(S, i, PAL.efflor, eff * 0.42);
        desat(S, i, eff * 0.30);
        // grime in every joint, then runoff below the weathered patches
        var low = sstep(0.66, 0.50, h);
        tint(S, i, PAL.grime, low * 0.34 + mortarM * 0.16 + chip * 0.30);
        var run = runoff[i] * sstep(0.34, 0.64, streakN[i]);
        tint(S, i, PAL.grime, run * 0.36);
        tint(S, i, PAL.dust, sat((h - 0.72) * 3.4) * 0.20);
        tint(S, i, PAL.moss, sat(mortarM * 1.2) * sstep(0.24, 0.05, blot[i]) * 0.28);
        applyChroma(S, i, C, 0.95, sat(run * 1.3 + low * 0.9 + mortarM * 0.6),
                    { iron: 0.55, wash: 0.42 });

        // --- roughness --------------------------------------------------
        // Fired brick keeps a semi-vitrified skin that is far smoother than the
        // eroded, salt-bloomed faces beside it, and the mortar is rougher than
        // either. Per-brick and per-face, so the variation is coherent instead
        // of a per-texel fizz that dies in mip 1.
        var skin = sat((bh2 - 0.28) * 1.8) * sat((face[i] - 0.34) * 1.8) * (1 - spallF);
        var r = 0.62 + (face[i] - 0.5) * 0.30;
        r -= skin * 0.46;
        r += erode * 0.30 + eff * 0.24 + chip * 0.20 + spallF * 0.34;
        // Repointed mortar was struck with a different tool and a coarser sand.
        r = lerp(r, 0.96 + (mortarN[i] - 0.5) * 0.08 - repoint * 0.14, mortarM);
        r -= sat((h - 0.72) * 3.0) * 0.10;
        S.ro[i] = sat(r);
        S.me[i] = 0;
      }
    }
    // Few and small on purpose - see genConcreteWall.
    punchCraters(g, S, { count: 3, rMin: 0.005, rMax: 0.011, depth: 0.18,
                         rough: 0.94, col: PAL.brickD, tint: 0.40, soot: 0.15 });
  }

  // -- weathered road asphalt ------------------------------------------------
  function genAsphalt(g, S) {
    var n = g.n, i;
    var chips = g.worley(120, 1.0, 11);      // the aggregate in the mix
    var chips2 = g.worley(52, 0.95, 13);     // larger stones
    var macro = g.fbm(g.buf(0), 3, 4, 0.6, 1, 17, false);
    var med = g.fbm(g.buf(0), 20, 4, 0.5, 1, 19, false);
    var fine = g.fbm(g.buf(0), 240, 3, 0.5, 1, 23, false);
    var crack = g.ridged(g.buf(0), 6, 5, 1, 29, true);
    var crack2 = g.ridged(g.buf(0), 18, 4, 1, 31, true);
    var oil = g.fbm(g.buf(0), 6, 4, 0.6, 1, 37, false);
    var patchN = g.fbm(g.buf(0), 4, 3, 0.55, 1, 41, false);
    var polish = g.buf(0); g.fbmA(polish, 3, 9, 3, 0.5, 1, 43, false);
    var C = chromaFields(g, 1300);

    S.base(PAL.asphalt);
    for (i = 0; i < n; i++) {
      var mc = macro[i], md = med[i];
      var h = 0.62 + (mc - 0.5) * 0.14 + (md - 0.5) * 0.09 + (fine[i] - 0.5) * 0.03;
      // Binder wears away and exposes the chips - strongest in the wheel paths.
      // Most stones stay BURIED: asphalt is a bitumen matrix with aggregate in
      // it, so if every chip stands proud the surface reads as loose gravel.
      var wear = sstep(0.35, 0.75, polish[i] * 0.6 + mc * 0.4);
      var c1 = sstep(0.30, 0.08, chips.f1[i]);
      var c2 = sstep(0.32, 0.10, chips2.f1[i]);
      h += (c1 * 0.030 + c2 * 0.040) * (0.20 + wear * 0.95);
      // tar repair patch: smoother, blacker, slightly proud
      var patch = sstep(0.66, 0.78, patchN[i]);
      h = lerp(h, 0.645 + (med[i] - 0.5) * 0.03, patch);
      var ck = sstep(0.80, 0.99, crack[i]) * (1 - patch * 0.8);
      var ck2 = sstep(0.90, 0.998, crack2[i]) * (1 - patch * 0.6);
      h -= ck * 0.13 + ck2 * 0.05;
      S.h[i] = h;

      // --- albedo -------------------------------------------------------
      // The exposed chips are the whole identity of asphalt - without a strong
      // light/dark stone speckle it reads as packed dirt.
      var id1 = chips.id[i], id2 = chips2.id[i];
      tint(S, i, id1 < 0.5 ? PAL.aggDark : PAL.aggLight, c1 * (0.18 + wear * 0.66));
      tint(S, i, id2 < 0.34 ? PAL.aggDark : (id2 < 0.70 ? PAL.aggregate : PAL.aggLight),
           c2 * (0.20 + wear * 0.72));
      tint(S, i, PAL.asphaltLt, wear * 0.34 + sat((mc - 0.6) * 2.0) * 0.16);
      tint(S, i, PAL.tar, patch * 0.75 + ck * 0.55 + ck2 * 0.3);
      // Dust and sand, but kept off the warm end: this is a grey road with a
      // pale film on it, not a brown one.
      tint(S, i, PAL.sandDk, sstep(0.62, 0.44, h) * 0.14);
      tint(S, i, PAL.dust, sat((fine[i] - 0.66) * 3.0) * 0.16 +
                           sat((polish[i] - 0.60) * 2.2) * 0.12);
      tint(S, i, PAL.aggregate, sat((mc - 0.5) * 1.8) * 0.22);
      // oil / diesel stain: dark, very smooth, faint warm sheen at the edge
      var oilM = sstep(0.70, 0.86, oil[i]) * sstep(0.66, 0.52, h);
      shade(S, i, 1 - oilM * 0.45);
      tint(S, i, PAL.rustDeep, sstep(0.66, 0.72, oil[i]) * sstep(0.80, 0.72, oil[i]) * 0.18);
      shade(S, i, 0.88 + 0.26 * md);
      // Road chroma: rain-wet patches go cool, iron off vehicles and the
      // sand blown across it go warm, and the sun-bleached crown of the camber
      // goes flat neutral. A road that is one grey is a road nobody drove on.
      applyChroma(S, i, C, 1.1, sat(sstep(0.62, 0.44, h) * 1.3 + oilM + ck),
                  { bio: 0.7, wash: 0.55 });

      // --- roughness ----------------------------------------------------
      // Coherent zones only. The freq-240 `fine` octave that used to supply the
      // "variation" here is 4 texels wide on a 1024 map - it dies in mip 1 and
      // never did anything but alias, which left the road one flat sheen.
      var r = 0.90 + (med[i] - 0.5) * 0.20;
      r -= sat((polish[i] - 0.42) * 2.2) * 0.46;              // tyre-burnished bands
      r -= (c1 * 0.10 + c2 * 0.14) * wear;
      r = lerp(r, 0.30 + (med[i] - 0.5) * 0.14, patch);       // fresh tar is glossier
      r = lerp(r, 0.06, oilM * 0.9);
      r += ck * 0.10 + sat((mc - 0.62) * 2.4) * 0.10;         // dry dusty shoulder
      S.ro[i] = sat(r);
      S.me[i] = 0;
    }
    punchScrapes(g, S, { count: 10, lenMin: 0.08, lenMax: 0.45, width: 0.0016,
                         depth: 0.035, rough: 0.55, col: PAL.aggLight, tint: 0.3 });
  }

  // -- corroded steel: bare pitted metal under flaking iron oxide ------------
  function genRustedMetal(g, S) {
    var n = g.n, i;
    var macro = g.fbm(g.buf(0), 3, 4, 0.62, 1, 11, false);
    var blot = g.fbm(g.buf(0), 7, 5, 0.55, 1, 17, false);
    var med = g.fbm(g.buf(0), 26, 4, 0.5, 1, 19, false);
    var fine = g.fbm(g.buf(0), 55, 3, 0.5, 1, 23, false);
    var flake = g.worley(40, 1.0, 29);
    var pit = g.worley(72, 1.0, 31);
    var streakN = g.buf(0); g.fbmA(streakN, 110, 7, 4, 0.5, 1, 37, false);
    // Low enough to stay LINEAR after the shear. A near-Nyquist scratch layer
    // degenerates into white salt-and-pepper instead of reading as scoring.
    var scratchRaw = g.buf(0); g.fbmA(scratchRaw, 90, 5, 3, 0.5, 1, 41, false);
    var scratch = g.buf(0); g.shear(scratchRaw, scratch, 2);
    // Scoring happens in ZONES - where a ladder swings against the stringer,
    // where hands and boots go. Unmasked, the sheared field draws hairlines
    // edge to edge across the whole tile at one constant angle, which reads as
    // a rendering artefact rather than as wear: nothing scratches a bulkhead in
    // a 1.5 m straight line at 40 degrees.
    var scZone = g.fbm(g.buf(0), 6, 3, 0.55, 1, 151, false);
    var C = chromaFields(g, 900);
    var seedM = g.buf(0), weep = g.buf(0);
    for (i = 0; i < n; i++) seedM[i] = sstep(0.60, 0.78, blot[i]);
    g.drip(seedM, weep, 0.9935, true);

    // ART_DIRECTION: "Metals are dark and tinted, never bright grey." A ten
    // summer old fire escape has no bare steel on it at all - it is mill scale
    // under dirt, which is dark and DIELECTRIC. Starting from F0-bright steel
    // and trying to darken it back is what produced the light blue-grey
    // substrate the rust sat on, and light-blue-plus-bright-orange is a toy.
    S.base(PAL.steelDark);
    for (i = 0; i < n; i++) {
      var b = blot[i], md = med[i];
      // Three rust stages: clean steel -> bloom -> deep flaking scale. The
      // ramps overlap generously; a narrow threshold gives leopard-spot rust
      // with no transitional bloom, which is the giveaway of a fake rust map.
      var rustM = sat(sstep(0.42, 0.74, b * 0.66 + md * 0.34) +
                      sstep(0.32, 0.76, weep[i]) * sstep(0.36, 0.70, streakN[i]) * 0.50);
      var deep = sstep(0.62, 0.90, b * 0.66 + md * 0.34);
      var fl = sstep(0.40, 0.08, flake.f1[i]);
      var pt = sstep(0.24, 0.03, pit.f1[i]);

      // Flake / scale crust. The cell-border term is what gives the oxide a
      // lifting, plated silhouette instead of a flat orange stain, and at ~3cm
      // world scale it still reads at five metres.
      var crustE = flake.f2[i] - flake.f1[i];
      var lift = sstep(0.30, 0.04, crustE) * rustM;

      var h = 0.56 + (macro[i] - 0.5) * 0.10 + (md - 0.5) * 0.045 + (fine[i] - 0.5) * 0.02;
      h += rustM * (0.030 + fl * 0.055 * (0.35 + deep));       // scale builds up
      h -= lift * (0.030 + deep * 0.055);                      // and plates lift off
      h -= pt * (0.014 + deep * 0.045);                        // then pits through
      h += (scratch[i] - 0.5) * 0.012;
      S.h[i] = h;

      // --- albedo -------------------------------------------------------
      // Iron oxide is a VALUE RANGE, not a colour. Near-black in the pits,
      // dark red-brown over the body of the scale, and a pale chalky bloom only
      // on the ~10% of the surface that stands highest. Authored as one bright
      // saturated orange it was the most saturated map in the library
      // (p95 0.66) and read as toy plastic.
      var hi = sat((h - 0.568) * 10.0);       // top of the local height field
      tint(S, i, PAL.steelWarm, sat(1 - md * 1.6) * 0.30);
      tint(S, i, PAL.grime, 0.11 + sstep(0.50, 0.66, macro[i]) * 0.30);
      tint(S, i, PAL.rust, rustM * 0.94);
      tint(S, i, PAL.rustMid, rustM * sat(fl * 1.3) * 0.55);
      // Bright bloom is a HIGHLIGHT on the crust, restricted to its crowns.
      // Restricted in COVERAGE, not in amplitude: the previous version held it
      // back on both, and the result was a map whose entire albedo lived
      // inside a 1.36x window - flat dark red-brown sheet, with none of the
      // near-black-to-pale-bloom span that is what actually reads as oxide.
      tint(S, i, PAL.rustLt, rustM * hi * (0.86 + lift * 0.45));
      tint(S, i, PAL.dust, rustM * hi * hi * (0.10 + lift * 0.40));  // chalky crown
      tint(S, i, PAL.rustDeep, deep * rustM * 0.55);
      // near-black pitting: this is what opens the value range at the bottom
      tint(S, i, PAL.rustPit, pt * (0.70 + rustM * 0.60) + deep * deep * rustM * 0.40);
      shade(S, i, 1 - pt * pt * 0.38 - sstep(0.30, 0.05, crustE) * deep * 0.24);
      // Scratches expose bare metal, which on a weathered stringer is a dull
      // grey - not a white line. Zoned, and biased to the proud areas.
      var sc = sat((scratch[i] - 0.74) * 3.6) * (1 - deep * 0.7) *
               sstep(0.44, 0.66, scZone[i]) * (0.25 + 0.75 * hi);
      tint(S, i, PAL.steelDk, sc * 0.46);
      tint(S, i, PAL.grime, sstep(0.56, 0.38, h) * 0.30);
      tint(S, i, PAL.dust, sat((h - 0.60) * 3.2) * 0.08);
      shade(S, i, 0.90 + 0.20 * fine[i]);
      // Chroma axes: damp iron goes near-black and cool, dry scale goes ochre,
      // and the shaded steel under a stair picks up algae.
      applyChroma(S, i, C, 0.85, sat(sstep(0.56, 0.40, h) * 1.2 + pt),
                  { bloom: 0.35, iron: 1.1, wash: 0.26 });

      // --- roughness / metalness ----------------------------------------
      // Rust is a DIELECTRIC. Authoring two thirds of a corroded panel as metal
      // gives it a specular-only response with no diffuse term, which is why it
      // used to read as flat dark-red plastic sheet. There is no intermediate
      // state here: intact steel is metal, oxide is not, and the contrast
      // between the two IS the read of a rusted surface.
      // The "clean" areas of a ten-year-old fire escape are not clean either -
      // they are mill scale under dirt, and both of those are dielectric. Only
      // the fresh scratches get back to true bare metal.
      S.me[i] = sat(0.62 - rustM * 1.15 - pt * 0.35 + sc * 0.5);
      // Matching split on roughness. The sound steel is weathered mill scale,
      // not a polished mirror - drop it much below this and the whole panel
      // becomes a sky-coloured reflector rather than a dark metal with rust
      // on it. The contrast against the crust is what does the work.
      var r = lerp(0.42, 0.99, rustM);
      r += fl * rustM * 0.05 + pt * 0.06;
      r -= sc * 0.20 + sat((fine[i] - 0.62) * 2.6) * (1 - rustM) * 0.10;
      S.ro[i] = sat(r);
    }
    // Short, height-biased, and exposing dull steel rather than white. lenMax
    // 0.35 of a tile is a 70 cm scratch at world scale that ran clean across a
    // stringer; 8% is a hand-width scuff, which is what wear actually looks
    // like.
    punchScrapes(g, S, { count: 24, lenMin: 0.015, lenMax: 0.08, width: 0.0012,
                         depth: 0.02, rough: 0.26, col: PAL.steelDk, tint: 0.40,
                         metal: 0.85, hbias: 0.85, hRef: 0.575 });
  }

  // -- chipped industrial paint over steel -----------------------------------
  function genPaintedMetal(g, S) {
    var n = g.n, i;
    var macro = g.fbm(g.buf(0), 3, 4, 0.6, 1, 11, false);
    var chipN = g.fbm(g.buf(0), 9, 5, 0.55, 1, 17, false);
    var chipC = g.worley(80, 1.0, 19);
    var med = g.fbm(g.buf(0), 30, 4, 0.5, 1, 23, false);
    var fine = g.fbm(g.buf(0), 200, 3, 0.5, 1, 29, false);
    var orange = g.fbm(g.buf(0), 340, 2, 0.5, 1, 31, false);   // paint orange-peel
    var scrRaw = g.buf(0); g.fbmA(scrRaw, 380, 5, 3, 0.5, 1, 37, false);
    var scr = g.buf(0); g.shear(scrRaw, scr, 1);
    var scrRaw2 = g.buf(0); g.fbmA(scrRaw2, 5, 260, 3, 0.5, 1, 41, false);
    var streakN = g.buf(0); g.fbmA(streakN, 100, 6, 4, 0.5, 1, 43, false);
    var C = chromaFields(g, 2300);
    var seedM = g.buf(0), weep = g.buf(0);
    for (i = 0; i < n; i++) seedM[i] = sstep(0.72, 0.88, chipN[i]);
    g.drip(seedM, weep, 0.991, true);

    // Pre-fade the enamel toward the dust tone. Fresh saturated industrial
    // paint is the wrong note for this level - everything here has had ten
    // summers. But the previous mix (0.30/0.30/0.42 toward PAL.dust) landed at
    // a 0.60-luminance near-white, which photographed on the material chart as
    // a WHITE PLASTIC ball indistinguishable from the plaster and tile beside
    // it. Industrial enamel on a shutter or a door is a mid-value ochre, and
    // it needs to sit clearly darker than the plaster it hangs on.
    var paint = [lerp(PAL.canvasOchre[0], PAL.dust[0], 0.20) * 0.78,
                 lerp(PAL.canvasOchre[1], PAL.dust[1], 0.22) * 0.78,
                 lerp(PAL.canvasOchre[2], PAL.dust[2], 0.34) * 0.78];
    S.base(paint);
    for (i = 0; i < n; i++) {
      var chip = sstep(0.62, 0.74, chipN[i] * 0.75 + med[i] * 0.25);
      chip = sat(chip + sstep(0.16, 0.02, chipC.f2[i] - chipC.f1[i]) * chip * 0.9);
      var deepChip = sstep(0.72, 0.86, chipN[i]);
      var sc = sat((scr[i] - 0.68) * 3.6);
      var sc2 = sat((scrRaw2[i] - 0.72) * 3.8);

      var h = 0.66 + (macro[i] - 0.5) * 0.10 + (med[i] - 0.5) * 0.03 +
              (orange[i] - 0.5) * 0.022 + (fine[i] - 0.5) * 0.012;
      h -= chip * 0.055 + deepChip * 0.035;                   // paint has thickness
      h -= (sc + sc2) * 0.012;
      S.h[i] = h;

      // --- albedo -------------------------------------------------------
      shade(S, i, 0.80 + 0.36 * macro[i]);                     // uneven fading
      tint(S, i, PAL.dust, sat((macro[i] - 0.55) * 2.2) * 0.28);  // chalked paint
      desat(S, i, sat((macro[i] - 0.48) * 2.8) * 0.55);         // UV pigment loss
      tint(S, i, PAL.primer, chip * 0.85);                     // red-oxide primer
      tint(S, i, PAL.steelDk, deepChip * 0.80);                // bare steel
      tint(S, i, PAL.rust, deepChip * sstep(0.4, 0.8, med[i]) * 0.65);
      tint(S, i, PAL.rustDeep, deepChip * deepChip * 0.45);
      // A chip in enamel is a STEP down to a different material with a shadow
      // in it, not a slightly duller version of the paint. Without that the
      // map spans 1.2x and the panel reads as painted card.
      shade(S, i, 1 - chip * 0.16 - deepChip * 0.24);
      tint(S, i, PAL.efflor, sat((orange[i] - 0.60) * 3.0) * (1 - chip) * 0.20);
      var run = weep[i] * sstep(0.32, 0.72, streakN[i]);
      tint(S, i, PAL.rust, run * 0.34);
      tint(S, i, PAL.alu, (sc + sc2 * 0.6) * (1 - chip) * 0.35);
      tint(S, i, PAL.grime, sstep(0.66, 0.55, h) * 0.26);
      // Enamel does not fade evenly. UV kills the pigment where the sun lands
      // and leaves it where the panel is shaded, so the same sheet carries a
      // near-neutral chalked zone and a zone still holding its dye.
      applyChroma(S, i, C, 1.0, sat(run * 1.5 + sstep(0.66, 0.56, h)),
                  { iron: 1.2, wash: 0.60 });

      // --- roughness / metalness ----------------------------------------
      // Enamel keeps a semi-gloss where it is protected, goes chalky where the
      // sun has hit it, and the exposed steel is a different beast entirely.
      var r = 0.44 + (orange[i] - 0.5) * 0.16 + sat((macro[i] - 0.5) * 2.0) * 0.30;
      r = lerp(r, 0.78, chip);
      r = lerp(r, 0.62, deepChip);
      r -= (sc + sc2) * 0.14;
      r += run * 0.10;
      S.ro[i] = sat(r);
      S.me[i] = sat(deepChip * 0.9 + (sc + sc2) * 0.35 - run * 0.4);
    }
  }

  // -- corrugated galvanised sheet (market awnings, shacks) ------------------
  function genCorrugated(g, S) {
    var n = g.n, size = g.size, i, x, y;
    var waves = 6;
    var dent = g.fbm(g.buf(0), 5, 4, 0.6, 1, 11, false);
    var med = g.fbm(g.buf(0), 24, 4, 0.5, 1, 17, false);
    var fine = g.fbm(g.buf(0), 200, 3, 0.5, 1, 19, false);
    var spangle = g.worley(26, 1.0, 23);                       // zinc crystal pattern
    var rustN = g.fbm(g.buf(0), 8, 5, 0.55, 1, 29, false);
    var pit = g.worley(200, 1.0, 31);
    var seedM = g.buf(0), weep = g.buf(0);
    for (i = 0; i < n; i++) seedM[i] = sstep(0.60, 0.78, rustN[i]);
    g.drip(seedM, weep, 0.994, true);

    S.base(PAL.zinc);
    for (y = 0; y < size; y++) {
      var o = y * size;
      for (x = 0; x < size; x++) {
        i = o + x;
        var ph = (x / size) * waves * 6.2831853;
        // the sheet is bent, so the corrugation drifts a little across the panel
        var corr = Math.sin(ph + (dent[i] - 0.5) * 0.9);
        var valley = sat(-corr);                                // 1 in the troughs
        var crest = sat(corr);
        // Gentle profile. Cranking the corrugation amplitude makes the sheet
        // read as a stack of pipes rather than as a panel.
        var h = 0.52 + corr * 0.20 + (dent[i] - 0.5) * 0.10 +
                (med[i] - 0.5) * 0.03 + (fine[i] - 0.5) * 0.012;

        // Water sits in the troughs, so that is where it rots through - but the
        // sheet is still mostly galvanised, so keep the coverage well under half
        // or the whole awning turns orange.
        var rustM = sat(sstep(0.58, 0.80, rustN[i]) * (0.35 + valley * 0.85) +
                        weep[i] * valley * 0.34);
        var rr = rustM * rustM;
        var pt = sstep(0.20, 0.02, pit.f1[i]) * rustM;
        h -= pt * 0.10;
        h += rustM * 0.02;
        S.h[i] = h;

        // --- albedo ----------------------------------------------------
        tint(S, i, PAL.alu, sstep(0.55, 0.15, spangle.f1[i]) * 0.30);
        shade(S, i, 0.80 + 0.34 * spangle.id[i] * 0.5 + 0.18 * crest);
        tint(S, i, PAL.steelDk, valley * 0.14);
        // Zinc does not stay bright. Ten summers turn the spelter into a
        // chalky, non-metallic oxide film - without it a galvanised awning
        // renders as polished chrome, which is what it was doing.
        var chalk = sat((dent[i] - 0.40) * 1.8);
        tint(S, i, PAL.efflor, chalk * 0.34);
        tint(S, i, PAL.dust, chalk * 0.22);
        tint(S, i, PAL.rust, rr * 0.80);
        tint(S, i, PAL.rustLt, rr * rustM * 0.40);
        tint(S, i, PAL.rustDeep, pt * 0.7 + rr * valley * 0.25);
        tint(S, i, PAL.grime, valley * 0.24 + sstep(0.5, 0.3, h) * 0.16);
        tint(S, i, PAL.dust, crest * sat((fine[i] - 0.6) * 3.0) * 0.26);

        // --- roughness / metalness -------------------------------------
        var r = 0.56 + (med[i] - 0.5) * 0.26 + valley * 0.14 + chalk * 0.36;
        r = lerp(r, 0.95, rustM);
        r += pt * 0.06;
        r -= sat((dent[i] - 0.66) * 2.6) * 0.34;                // rain-washed crests
        S.ro[i] = sat(r);
        S.me[i] = sat(0.88 - rr * 0.95 - pt * 0.4 - chalk * 0.42);
      }
    }
    // fastener rows: screws with washers along a couple of the crests
    (function () {
      var rowsY = 3, perRow = waves;
      for (var ry = 0; ry < rowsY; ry++) {
        var py = (ry + 0.5) * size / rowsY + (hash2i(ry, 0, 9) - 0.5) * size * 0.05;
        for (var k = 0; k < perRow; k++) {
          var px = (k + 0.25) * size / perRow;
          var R = size * 0.010;
          var rustyBolt = hash2i(k, ry, 21);
          for (var yy = -Math.ceil(R * 3); yy <= Math.ceil(R * 3); yy++) {
            var wy = ((Math.round(py + yy) % size) + size) % size;
            for (var xx = -Math.ceil(R * 3); xx <= Math.ceil(R * 3); xx++) {
              var d = Math.sqrt(xx * xx + yy * yy) / R;
              if (d > 3) continue;
              var wx = ((Math.round(px + xx) % size) + size) % size;
              var ii = wy * size + wx;
              var head = sstep(1.15, 0.85, d);
              var washer = sstep(2.0, 1.7, d) * sstep(1.0, 1.25, d);
              var slot = sstep(0.20, 0.05, Math.abs(yy) / R) * head;
              S.h[ii] += head * 0.05 + washer * 0.02 - slot * 0.05;
              tint(S, ii, PAL.steelDk, head * 0.5 + washer * 0.25);
              tint(S, ii, PAL.rust, (head + washer) * rustyBolt * 0.55);
              tint(S, ii, PAL.rustDeep, slot * 0.4);
              S.ro[ii] = sat(lerp(S.ro[ii], 0.38 + rustyBolt * 0.5, head * 0.8 + washer * 0.4));
              S.me[ii] = sat(lerp(S.me[ii], 1 - rustyBolt * 0.7, head * 0.8));
            }
          }
        }
      }
    })();
  }

  // -- weathered timber boards ----------------------------------------------
  function genWood(g, S) {
    var n = g.n, size = g.size, i, x, y;
    var planks = 5;
    // Warp field for the annual rings: it must vary ALONG the board (high fx,
    // low fy) so the ring lines wander lengthwise. Fine fibre runs the other
    // way round.
    // Warp field for the annual rings. It must vary slowly ALONG the board and
    // barely at all across it, so the ring lines make a few long cathedral
    // arches. A high-frequency warp here turns the grain into a zigzag rasp.
    var grainN = g.buf(0); g.fbmA(grainN, 5, 2, 2, 0.45, 1, 11, false);
    var grainW = g.buf(0); g.fbmA(grainW, 11, 4, 2, 0.5, 1, 47, false);
    var grainF = g.buf(0); g.fbmA(grainF, 6, 300, 3, 0.5, 1, 13, false);
    var med = g.fbm(g.buf(0), 26, 4, 0.5, 1, 17, false);
    var fine = g.fbm(g.buf(0), 190, 3, 0.5, 1, 19, false);
    var macro = g.fbm(g.buf(0), 4, 4, 0.6, 1, 23, false);
    var splint = g.buf(0); g.fbmA(splint, 8, 220, 3, 0.5, 1, 29, false);
    var wearN = g.fbm(g.buf(0), 5, 4, 0.6, 1, 31, false);
    var C = chromaFields(g, 2500);

    S.base(PAL.wood);
    for (y = 0; y < size; y++) {
      var yy = y * planks / size;
      var pi = Math.floor(yy), fy = yy - pi;
      pi = ((pi % planks) + planks) % planks;
      var ph = hash2i(0, pi, 3), ph2 = hash2i(0, pi, 5), ph3 = hash2i(0, pi, 7);
      var boards = 2 + Math.floor(ph2 * 2);        // butt joints along the plank
      var o = y * size;
      for (x = 0; x < size; x++) {
        i = o + x;
        var xx = x * boards / size + ph3;
        var bi = Math.floor(xx), fx = xx - bi;
        // Wrap the board index before hashing, or the last board on the right
        // edge draws a different tone than the first board on the left and the
        // tile gets a hard vertical seam.
        bi = ((bi % boards) + boards) % boards;
        var bh = hash2i(bi, pi, 11);

        var gapY = 1 - sstep(0.020, 0.055, Math.min(fy, 1 - fy));
        var gapX = 1 - sstep(0.006, 0.020, Math.min(fx, 1 - fx));
        var gap = sat(gapY + gapX);
        // Annual rings. Same principle as the sand ripples: the phase ramps
        // ACROSS the board's width and the noise only warps it, so the grain
        // runs lengthwise with cathedral arches. Taking the phase straight from
        // 2D noise instead produces liquid swirls that read as marble, not wood.
        var rings = 4 + Math.floor(ph * 4);
        var gv = fy * rings + (grainN[i] - 0.5) * 3.0 +
                 (grainW[i] - 0.5) * 0.25 + bh * 3.0;
        var ring = Math.abs(frac(gv) * 2 - 1);
        ring = Math.pow(ring, 0.55);
        var late = sstep(0.55, 0.92, ring);
        var micro = (grainF[i] - 0.5);

        var cup = Math.cos((fy - 0.5) * 3.14159) * 0.008 * (0.5 + ph);
        var h = 0.70 + cup + (bh - 0.5) * 0.045 + (macro[i] - 0.5) * 0.035;
        // Grain is overwhelmingly an ALBEDO feature. Driving it hard into the
        // height field makes the board read as corrugated card, not as timber -
        // the relief that matters is the board joints, the cupping and the
        // lifted fibres.
        h -= late * 0.011;                          // softwood erodes, latewood proud
        h += micro * 0.006;
        h -= gap * 0.20;
        // splintering / lifted fibres on the exposed edges
        var spl = sat((splint[i] - 0.70) * 3.4) * sstep(0.20, 0.45, Math.min(fy, 1 - fy));
        h += spl * 0.03;
        S.h[i] = h;

        // --- albedo ----------------------------------------------------
        var tone = 0.86 + bh * 0.34 + (macro[i] - 0.5) * 0.18;
        // Grain contrast is masked by a low-frequency field so some stretches of
        // board are almost plain. Uniform grain everywhere reads as laminate.
        var gMask = 0.35 + sat((macro[i] - 0.34) * 1.9) * 0.70;
        tint(S, i, PAL.woodLt, sat(1 - ring) * 0.26 * gMask);
        tint(S, i, PAL.woodDk, late * 0.24 * gMask);
        // Fine fibre streaks running the length of the board. These, not the
        // ring bands, are what actually reads as "wood" at arm's length.
        shade(S, i, 1 + micro * 0.40);
        shade(S, i, tone);
        // sun-silvered surface where it is proud and exposed
        var silver = sat((wearN[i] - 0.36) * 2.0) * sat((h - 0.70) * 3.5 + 0.45);
        tint(S, i, PAL.woodGrey, silver * 0.68);
        tint(S, i, PAL.dust, silver * sat((fine[i] - 0.6) * 3.0) * 0.20);
        // dirt in the joints and end grain
        tint(S, i, PAL.grime, gap * 0.75 + sstep(0.68, 0.55, h) * 0.24);
        tint(S, i, PAL.dirtDk, gapX * 0.35);
        tint(S, i, PAL.woodDk, spl * 0.25);
        // Sun-silvered timber loses its chroma almost completely; the sheltered
        // stretches keep the warm resin colour, and iron staining bleeds out of
        // every nail. Three separate chroma populations on one board.
        desat(S, i, silver * 0.34);
        applyChroma(S, i, C, 1.0, sat(gap * 1.4 + sstep(0.68, 0.56, h) * 1.2),
                    { iron: 1.3, bloom: 0.5, wash: 0.34 });

        // --- roughness --------------------------------------------------
        // Sun-silvered, fibre-lifted timber sits at the top of the curve; the
        // stretches where old oil or varnish survives, and any edge a hand has
        // burnished, sit nowhere near it. Coherent at board scale.
        var r = 0.70 + late * 0.16 + (macro[i] - 0.5) * 0.30;
        r += silver * 0.30 + spl * 0.16 + gap * 0.14;
        r -= sat((0.46 - macro[i]) * 2.6) * 0.44;           // surviving oil/varnish
        r -= sat((h - 0.72) * 3.0) * (1 - silver) * 0.22;   // handled edges burnish
        S.ro[i] = sat(r);
        S.me[i] = 0;
      }
    }
    // knots
    (function () {
      var rng = g.rng, count = 5;
      for (var c = 0; c < count; c++) {
        var cx = rng.next() * size, cy = rng.next() * size;
        var R = size * (0.018 + rng.next() * 0.022);
        var ell = 0.45 + rng.next() * 0.4;
        for (var yy = -Math.ceil(R * 3.2); yy <= Math.ceil(R * 3.2); yy++) {
          var wy = ((Math.round(cy + yy) % size) + size) % size;
          for (var xx = -Math.ceil(R * 3.2 / ell); xx <= Math.ceil(R * 3.2 / ell); xx++) {
            var ddx = xx * ell, ddy = yy;
            var d = Math.sqrt(ddx * ddx + ddy * ddy) / R;
            if (d > 3.2) continue;
            var wx = ((Math.round(cx + xx) % size) + size) % size;
            var ii = wy * size + wx;
            var core = sstep(1.15, 0.6, d);
            var rings = (Math.sin(d * 9.5) * 0.5 + 0.5) * sstep(3.2, 0.9, d);
            S.h[ii] -= core * 0.06;
            S.h[ii] += rings * 0.012;
            tint(S, ii, PAL.woodDk, core * 0.72 + rings * 0.22 * sstep(2.6, 1.0, d));
            tint(S, ii, PAL.soot, core * core * 0.35);
            S.ro[ii] = sat(S.ro[ii] - core * 0.20 + rings * 0.04);
          }
        }
      }
    })();
  }

  // -- drifted sand ----------------------------------------------------------
  function genSand(g, S) {
    var n = g.n, size = g.size, i, x, y;
    var dune = g.fbm(g.buf(0), 3, 3, 0.6, 1, 11, false);
    var warpRaw = g.buf(0); g.fbmA(warpRaw, 3, 10, 3, 0.5, 1, 13, true);
    var warp = g.buf(0); g.shear(warpRaw, warp, 1);
    var med = g.fbm(g.buf(0), 30, 4, 0.5, 1, 17, false);
    var grain = g.fbm(g.buf(0), 300, 2, 0.5, 1, 19, false);
    var grains = g.worley(230, 1.0, 23);
    var peb = g.worley(60, 1.0, 29);
    var damp = g.fbm(g.buf(0), 4, 3, 0.55, 1, 31, false);
    // Drift depth: where the sand has piled up against something and where it
    // has been scoured back to a thin skin over the ground. This is the field
    // that gives a large sand plane any material information at all - without
    // it the map is one cream tone plus per-texel noise, i.e. sandpaper.
    var drift = g.buf(0); g.fbmA(drift, 5, 3, 3, 0.55, 1, 37, false);
    // A second ripple train at a shallow angle. Real wind ripples interfere;
    // one perfectly parallel set reads as corduroy.
    var rip2Raw = g.buf(0); g.fbmA(rip2Raw, 7, 3, 2, 0.5, 1, 41, true);
    var rip2 = g.buf(0); g.shear(rip2Raw, rip2, 3);
    var coarse = g.worley(38, 1.0, 43);      // coarse-grain sorting patches
    var C = chromaFields(g, 1500);

    // Wind ripples are long PARALLEL crests. The phase therefore comes from a
    // linear coordinate ramp that the noise only WARPS - deriving the phase
    // from noise alone gives closed level sets, i.e. brain-coral vermiculation,
    // which is a very recognisable procedural-texture tell. RIPPLES must be an
    // integer so the ramp wraps across the tile seam.
    var RIPPLES = 24;
    S.base(PAL.sand);
    for (y = 0; y < size; y++) {
      var yo = y * size;
      var ramp = (y / size) * RIPPLES;
      for (x = 0; x < size; x++) {
      i = yo + x;
      var d = dune[i];
      var dr = drift[i];
      // Deep drifts are loose and heavily rippled; scoured, shallow sand over a
      // hard base barely ripples at all.
      var deepDr = sat((dr - 0.42) * 2.2);
      var thinDr = sat((0.46 - dr) * 2.4);
      var rp = Math.abs(frac(ramp + warp[i] * 6.5 + (med[i] - 0.5) * 0.75) * 2 - 1);
      rp = Math.pow(rp, 0.7);
      var rpB = Math.abs(frac(ramp * 0.42 + rip2[i] * 5.0) * 2 - 1);
      // The dune term deliberately carries little height: a very low frequency
      // slope eats the whole normalised gradient budget and the ripples - the
      // only thing that actually reads as sand - end up invisible.
      var amp = (0.35 + sat((d - 0.35) * 1.6) * 0.75) * (0.30 + deepDr * 1.15);
      var h = 0.55 + (d - 0.5) * 0.11 + (dr - 0.5) * 0.13 +
              (rp - 0.5) * 0.150 * amp + (rpB - 0.5) * 0.055 * amp +
              (med[i] - 0.5) * 0.070 + (grain[i] - 0.5) * 0.030;
      // Grain SORTING: the wind blows the fines off the scoured areas and
      // leaves the coarse stuff behind, so grain size tracks drift depth.
      var sortM = sstep(0.34, 0.06, coarse.f1[i]) * (0.25 + thinDr * 1.1);
      var pebM = sstep(0.20, 0.06, peb.f1[i]) * sstep(0.35, 0.62, med[i]) *
                 (0.35 + thinDr * 1.0);
      h += pebM * 0.075;
      h += sstep(0.30, 0.10, grains.f1[i]) * 0.022 * (0.4 + sortM);
      S.h[i] = h;

      // --- albedo -------------------------------------------------------
      // Ripple crests are dry, sun-bleached and pale; the lee slopes hold shade
      // and coarser, darker grains. This contrast is the whole read of sand at
      // any distance where individual grains are gone.
      // Crest/lee is a BRIGHTNESS contrast first and a hue shift second: dust
      // and sand sit 20 sRGB steps apart, so tinting between them alone moved
      // the albedo almost not at all and the ripples never reached the frame.
      shade(S, i, 1 + (rp - 0.5) * 0.42 * amp);
      tint(S, i, PAL.dust, sat((rp - 0.40) * 2.2) * 0.50 * amp);
      tint(S, i, PAL.sandDk, sstep(0.58, 0.36, h) * 0.42 + sat((0.44 - rp) * 2.2) * 0.34 * amp);
      // Deep drifts are darker (more shadowed voids between loose grains) and
      // the scoured skin is paler and dustier.
      tint(S, i, PAL.sandDk, deepDr * 0.16);
      tint(S, i, PAL.dust, thinDr * 0.30);
      tint(S, i, PAL.dirt, sortM * 0.30);
      // broad dune-scale tone drift so a large sand plane never reads uniform
      tint(S, i, PAL.dirtLt, sat((d - 0.58) * 2.4) * 0.20);
      tint(S, i, PAL.plasterDk, sat((0.42 - d) * 2.4) * 0.18);
      tint(S, i, peb.id[i] < 0.5 ? PAL.aggregate : PAL.aggLight, pebM * 0.65);
      shade(S, i, 0.90 + 0.20 * grain[i]);
      // compacted / damp sand in the deep hollows: darker and smoother
      var wet = sstep(0.50, 0.68, damp[i]) * (0.45 + 0.55 * sstep(0.62, 0.42, h));
      shade(S, i, 1 - wet * 0.34);
      tint(S, i, PAL.dirtDk, wet * 0.25);
      // Sand is the worst offender for "one hue with a luminance ramp": it is
      // already chromatic, so every tint only ever raises its saturation and
      // the map ends up at a CONSTANT chroma. The low end has to be authored -
      // sun-bleached, salt-crusted and dust-filmed drifts are genuinely close
      // to neutral - and the high end comes from damp and iron-stained sand.
      applyChroma(S, i, C, 1.15, sat(wet * 1.6 + deepDr * 0.7), { wash: 0.62 });
      desat(S, i, thinDr * 0.30);

      // --- roughness ----------------------------------------------------
      // Dry loose sand is about as rough as a surface gets; damp, compacted and
      // wind-packed sand is measurably not. The old map sat at a mathematically
      // constant 0.975-0.995, which is no material information at all.
      var r = 0.97 - pebM * 0.22 - sortM * 0.14;
      r -= sat((rp - 0.55) * 2.2) * 0.10;              // polished crest facets
      r = lerp(r, 0.06, wet * 0.9);                    // damp / compacted
      r -= thinDr * 0.22;                              // wind-packed scoured skin
      S.ro[i] = sat(r);
      S.me[i] = 0;
      }
    }
  }

  // -- loose gravel / rubble -------------------------------------------------
  function genGravel(g, S) {
    var n = g.n, i;
    var big = g.worley(22, 1.0, 11);
    var mid = g.worley(46, 1.0, 13);
    var small = g.worley(110, 1.0, 17);
    var macro = g.fbm(g.buf(0), 3, 4, 0.6, 1, 19, false);
    var med = g.fbm(g.buf(0), 40, 4, 0.5, 1, 23, false);
    var fine = g.fbm(g.buf(0), 220, 3, 0.5, 1, 29, false);
    var dustN = g.fbm(g.buf(0), 6, 4, 0.55, 1, 31, false);
    var C = chromaFields(g, 1900);

    S.base(PAL.aggregate);
    for (i = 0; i < n; i++) {
      // three stone sizes layered; the biggest wins where it exists
      var b = sstep(0.50, 0.05, big.f1[i]);
      var m = sstep(0.46, 0.05, mid.f1[i]);
      var s = sstep(0.44, 0.06, small.f1[i]);
      var bDome = Math.sqrt(sat(b)) * (0.7 + hash2i(Math.floor(big.id[i] * 997), 0, 3) * 0.6);
      var mDome = Math.sqrt(sat(m));
      var sDome = Math.sqrt(sat(s));

      var h = 0.30 + (macro[i] - 0.5) * 0.10 + (med[i] - 0.5) * 0.04;
      var top = 0, id = 0, tier = 0;
      if (bDome * 0.42 > mDome * 0.26 && bDome * 0.42 > sDome * 0.15) {
        top = bDome * 0.42; id = big.id[i]; tier = 2;
      } else if (mDome * 0.26 > sDome * 0.15) {
        top = mDome * 0.26; id = mid.id[i]; tier = 1;
      } else {
        top = sDome * 0.15; id = small.id[i]; tier = 0;
      }
      h += top;
      h += (fine[i] - 0.5) * 0.02;
      // chipped faces: the stones are crushed, not rounded river pebbles
      h += (med[i] - 0.5) * 0.05 * (top > 0.05 ? 1 : 0.3);
      S.h[i] = h;

      // --- albedo -------------------------------------------------------
      var c = id < 0.30 ? PAL.aggDark : (id < 0.62 ? PAL.aggregate :
              (id < 0.88 ? PAL.aggLight : PAL.brickC));
      S.cr[i] = c[0]; S.cg[i] = c[1]; S.cb[i] = c[2];
      // Pull every stone a little toward the common dust tone; fully saturated
      // per-cell colours make crushed stone look like confetti.
      tint(S, i, PAL.sandDk, 0.22);
      shade(S, i, 0.76 + 0.42 * sat(top * 2.6) + (fine[i] - 0.5) * 0.24);
      // fines and dust pack into the voids between stones
      var voidM = sstep(0.14, 0.0, top);
      tint(S, i, PAL.dirt, voidM * 0.62);
      tint(S, i, PAL.grime, voidM * 0.30);
      tint(S, i, PAL.dust, sat((dustN[i] - 0.5) * 2.2) * sat(top * 3.0) * 0.30);
      tint(S, i, PAL.sandDk, sat((macro[i] - 0.55) * 2.0) * 0.16);
      applyChroma(S, i, C, 0.85, sat(voidM * 1.4), { wash: 0.30 });

      // --- roughness ----------------------------------------------------
      // Wet-packed / rain-washed patches of a gravel bed are markedly smoother
      // than the dry, dust-coated ones, and a fresh crushed face is smoother
      // than a weathered one. Coherent at ~20cm.
      var r = 0.92 - sat(top * 3.0) * 0.20 * (tier === 2 ? 1 : 0.5);
      r -= sat((macro[i] - 0.48) * 2.4) * 0.44;
      r += voidM * 0.10 + sat((dustN[i] - 0.54) * 2.4) * 0.12;
      S.ro[i] = sat(r);
      S.me[i] = 0;
    }
  }

  // -- packed dirt with dried mud cracking -----------------------------------
  function genDirt(g, S) {
    var n = g.n, i;
    var macro = g.fbm(g.buf(0), 3, 4, 0.62, 1, 11, false);
    var med = g.fbm(g.buf(0), 22, 4, 0.5, 1, 13, false);
    var fine = g.fbm(g.buf(0), 190, 3, 0.5, 1, 17, false);
    var mud = g.worley(26, 0.85, 19);            // dried mud plates
    var peb = g.worley(120, 1.0, 23);
    var rutRaw = g.buf(0); g.fbmA(rutRaw, 2, 26, 3, 0.55, 1, 29, false);
    var dustN = g.fbm(g.buf(0), 5, 4, 0.6, 1, 31, false);
    var organic = g.fbm(g.buf(0), 60, 3, 0.5, 1, 37, false);
    var C = chromaFields(g, 1700);

    S.base(PAL.dirt);
    for (i = 0; i < n; i++) {
      var plate = mud.f2[i] - mud.f1[i];
      var crackM = sstep(0.22, 0.02, plate) * sstep(0.40, 0.62, macro[i]);
      var curl = sstep(0.05, 0.30, plate) * sstep(0.40, 0.62, macro[i]);
      var pebM = sstep(0.22, 0.05, peb.f1[i]);
      var rut = Math.abs(frac(rutRaw[i] * 2.0) * 2 - 1);

      var h = 0.58 + (macro[i] - 0.5) * 0.20 + (med[i] - 0.5) * 0.08 +
              (fine[i] - 0.5) * 0.025;
      h -= crackM * 0.16;              // the crack channel
      h += curl * 0.035;               // plate edges curl upward as they dry
      h += pebM * 0.05;
      h -= sat((rut - 0.7) * 2.5) * 0.05;
      S.h[i] = h;

      // --- albedo -------------------------------------------------------
      tint(S, i, PAL.dirtLt, sat((h - 0.58) * 3.0) * 0.42);
      tint(S, i, PAL.dirtDk, sstep(0.58, 0.40, h) * 0.55 + crackM * 0.65);
      tint(S, i, peb.id[i] < 0.5 ? PAL.aggregate : PAL.aggLight, pebM * 0.60);
      tint(S, i, PAL.dust, sat((dustN[i] - 0.48) * 2.2) * sat((h - 0.56) * 2.6) * 0.42);
      tint(S, i, PAL.sandDk, sat((macro[i] - 0.55) * 1.8) * 0.24);
      // dead organic matter: straw, dry root fibre
      tint(S, i, PAL.foliageDry, sat((organic[i] - 0.74) * 4.0) * 0.35);
      tint(S, i, PAL.moss, sstep(0.24, 0.08, macro[i]) * sstep(0.5, 0.3, h) * 0.20);
      shade(S, i, 0.88 + 0.26 * fine[i]);
      applyChroma(S, i, C, 1.05, sat(crackM * 1.2 + sstep(0.58, 0.40, h) * 1.1),
                  { wash: 0.55 });

      // --- roughness ----------------------------------------------------
      var r = 0.95 - pebM * 0.20;
      r -= sat((macro[i] - 0.44) * 2.4) * 0.48;   // compacted, foot-polished pans
      r -= sat((rut - 0.72) * 3.0) * 0.22;        // vehicle ruts get compacted smooth
      r += crackM * 0.06 + sat((dustN[i] - 0.5) * 2.2) * 0.10;
      S.ro[i] = sat(r);
      S.me[i] = 0;
    }
  }

  // -- glazed ceramic floor tile --------------------------------------------
  //
  // REWRITTEN. The old recipe was a 4x4 lattice of flat two-tone cells with a
  // uniform grout line, which is precisely why the material chart photographed
  // it as a debug checkerboard: each tile carried ONE constant colour, so the
  // only structure in the whole map was the lattice itself, and the albedo
  // spanned a P95/P05 of 1.21 - a flat colour with a gradient on it.
  //
  // Three structural changes, none of them a tuning pass:
  //
  //  * per-tile tonal GRADIENT instead of a per-tile constant. A pressed tile
  //    fires unevenly and its face carries a ramp; a floor of ramps at random
  //    angles cannot read as a colour-swatch chart.
  //  * fields that CROSS the lattice - a walked traffic path, a mop-swirl
  //    film, ground-in dirt - at freq 3-6. Once the shading does not respect
  //    the cell boundaries, the eye stops segmenting the floor into cells.
  //  * a real SECOND MATERIAL. Glaze worn through at the arris exposes pale
  //    unglazed biscuit, and a missing tile exposes grey screed. That is where
  //    the value range comes from; two greys and a grout line cannot produce
  //    one however they are graded.
  //
  // ROUND 3. It still failed 'perfectly straight, perfectly uniform anything':
  // every grout line was mathematically straight and identically wide, every
  // tile was exactly the same size, the four-by-four block was one texture
  // repeated with the same corner-shadow motif in each cell, and there was not
  // one chipped corner, cracked tile, lippage step or polished path. Four more
  // structural changes, all of them things a real floor has and a lattice
  // cannot:
  //
  //  * THE JOINT GRID IS NO LONGER A GRID. Each joint carries its own hashed
  //    position (+-1.5% of pitch, i.e. real lippage - adjacent tiles are not
  //    the same size), its own width (+-25%) and its own dirt loading, and the
  //    whole local frame is displaced by a low-frequency field so no joint is
  //    a laser line. The lattice PITCH is untouched, because materials.js
  //    quantises the stochastic offsets to it.
  //  * EACH TILE'S FACE IS SAMPLED THROUGH ITS OWN 90-degree ROTATION AND UV
  //    OFFSET, so no two adjacent tiles share a speckle, a mottle or a corner
  //    shadow. This is the fix for "one texture repeated in each cell"; it is
  //    free, because the source fields are already generated.
  //  * DAMAGE. ~11% of tile corners are chipped away to the biscuit with an
  //    irregular lobed break, a low-frequency ridged crack runs across one or
  //    two tiles rather than being gated inside one, and the odd tile is still
  //    missing entirely.
  //  * A TRAFFIC-POLISH PATH, wandering across the lattice, that takes 0.30 off
  //    roughness where feet have burnished the glaze - the strongest read a
  //    floor has under a raking key and the one thing that made the old plate
  //    look like it had never been walked on.
  function genTile(g, S) {
    var n = g.n, size = g.size, i, x, y, k;
    // materials.js quantises this material's stochastic tile offsets to [4,4]
    // so the grout stays a continuous grid. Do not change the count.
    var tiles = 4;
    var cell = Math.max(1, (size / tiles) | 0);
    var mottle = g.fbm(g.buf(0), 40, 4, 0.5, 1, 11, false);
    var macro = g.fbm(g.buf(0), 3, 4, 0.6, 1, 13, false);
    var fine = g.fbm(g.buf(0), 210, 3, 0.5, 1, 17, false);
    var groutN = g.fbm(g.buf(0), 55, 3, 0.5, 1, 19, false);
    var groutAgg = g.worley(170, 1.0, 101);      // sharp sand in the grout
    var crack = g.ridged(g.buf(0), 30, 3, 1, 23, true);
    var crackB = g.ridged(g.buf(0), 5, 4, 1, 133, true);    // one real crack
    var ckMask = g.fbm(g.buf(0), 3, 3, 0.6, 1, 137, false);
    var crazeN = g.ridged(g.buf(0), 80, 3, 1, 103, true);   // glaze crazing
    var chipC = g.worley(150, 1.0, 29);
    var dirtN = g.fbm(g.buf(0), 6, 4, 0.6, 1, 31, false);
    var lay = g.fbm(g.buf(0), 5, 3, 0.55, 1, 131, false);   // the tiler's hand
    // --- the fields that cross the lattice --------------------------------
    var traffic = g.fbm(g.buf(0), 4, 3, 0.55, 1, 105, false);
    var mopRaw = g.buf(0); g.fbmA(mopRaw, 22, 5, 3, 0.5, 1, 107, false);
    var mop = g.buf(0); g.shear(mopRaw, mop, 2);
    var polRaw = g.buf(0); g.fbmA(polRaw, 3, 11, 3, 0.5, 1, 139, false);
    var pol = g.buf(0); g.shear(polRaw, pol, 1);            // the walked path
    var speck = g.worley(110, 1.0, 109);         // body speckle under the glaze
    var C = chromaFields(g, 3300);

    // ---- per-joint and per-tile tables -----------------------------------
    var jpX = new Float32Array(tiles), jwX = new Float32Array(tiles), jdX = new Float32Array(tiles);
    var jpY = new Float32Array(tiles), jwY = new Float32Array(tiles), jdY = new Float32Array(tiles);
    for (k = 0; k < tiles; k++) {
      jpX[k] = (hash2i(k, 0, 401) - 0.5) * 0.030;
      jwX[k] = 0.026 * (0.75 + hash2i(k, 0, 403) * 0.50);
      jdX[k] = hash2i(k, 0, 407);
      jpY[k] = (hash2i(0, k, 411) - 0.5) * 0.030;
      jwY[k] = 0.026 * (0.75 + hash2i(0, k, 413) * 0.50);
      jdY[k] = hash2i(0, k, 417);
    }
    var nT = tiles * tiles;
    var tRot = new Int32Array(nT), tOX = new Int32Array(nT), tOY = new Int32Array(nT);
    for (k = 0; k < nT; k++) {
      var kx = k % tiles, ky = (k / tiles) | 0;
      tRot[k] = (hash2i(kx, ky, 421) * 4) | 0;
      tOX[k] = (hash2i(kx, ky, 423) * size) | 0;
      tOY[k] = (hash2i(kx, ky, 427) * size) | 0;
    }

    for (y = 0; y < size; y++) {
      var yy = y * tiles / size;
      var ty = Math.floor(yy), fy = yy - ty;
      ty = ((ty % tiles) + tiles) % tiles;
      var ly = y - ty * cell;
      if (ly < 0) ly = 0; else if (ly >= cell) ly = cell - 1;
      var o = y * size;
      for (x = 0; x < size; x++) {
        i = o + x;
        var xx = x * tiles / size;
        var tx = Math.floor(xx), fx = xx - tx;
        tx = ((tx % tiles) + tiles) % tiles;
        var th = hash2i(tx, ty, 3), th2 = hash2i(tx, ty, 5), th3 = hash2i(tx, ty, 7);
        var th4 = hash2i(tx, ty, 9);

        // ---- this tile's own view of the source fields --------------------
        var tk = ty * tiles + tx, rk = tRot[tk];
        // Clamped: `cell` is exact for every tier size in use, but a tier whose
        // size is not a multiple of `tiles` must degrade, never index off the
        // end of a Float32Array and poison the map with NaN.
        var lx = x - tx * cell, rx, ry;
        if (lx < 0) lx = 0; else if (lx >= cell) lx = cell - 1;
        if (rk === 0) { rx = lx; ry = ly; }
        else if (rk === 1) { rx = cell - 1 - ly; ry = lx; }
        else if (rk === 2) { rx = cell - 1 - lx; ry = cell - 1 - ly; }
        else { rx = ly; ry = cell - 1 - lx; }
        var si = (((ry + tOY[tk]) % size) * size) + ((rx + tOX[tk]) % size);

        // ---- the joint grid, which is not a grid --------------------------
        // A tiler works to a spacer and a string line, so the wander is small -
        // but it is not zero, and zero is what reads as CAD. An fbm's deviation
        // from 0.5 has a standard deviation near 0.11, so these gains give
        // about a texel of sd and four texels of peak on a 128-texel tile.
        var fxw = fx + (macro[i] - 0.5) * 0.090;
        var fyw = fy + (lay[i] - 0.5) * 0.090;
        var nx = (tx + 1) % tiles, ny = (ty + 1) % tiles;
        var dLv = fxw - jpX[tx], dRv = (1 + jpX[nx]) - fxw;
        var dTv = fyw - jpY[ty], dBv = (1 + jpY[ny]) - fyw;
        var lft = dLv < dRv, tpp = dTv < dBv;
        var dx = lft ? dLv : dRv, dy = tpp ? dTv : dBv;
        var gwx = lft ? jwX[tx] : jwX[nx];
        var gwy = tpp ? jwY[ty] : jwY[ny];
        var ex = dx / gwx, ey = dy / gwy;
        var groutM = 1 - sstep(0.7, 1.7, ex) * sstep(0.7, 1.7, ey);
        var edgeN = ex < ey ? ex : ey;
        var bevel = sstep(1.7, 3.2, edgeN);            // rounded glaze at the edge
        var jd = ex < ey ? (lft ? jdX[tx] : jdX[nx]) : (tpp ? jdY[ty] : jdY[ny]);

        // ---- chipped corners ---------------------------------------------
        // A laid floor loses corners first: they are the least supported part
        // of the tile and everything that gets dropped lands on one.
        var cchp = 0;
        if (dx < 0.20 && dy < 0.20) {
          var ch1 = hash2i(tx * 2 + (lft ? 0 : 1), ty * 2 + (tpp ? 0 : 1), 57);
          if (ch1 > 0.875) {
            var cr0 = 0.045 + (ch1 - 0.875) * 0.86;
            var cdd = Math.sqrt(dx * dx + dy * dy);
            if (cdd < cr0 * 1.7) {
              var ca = Math.atan2(dy + 1e-5, dx + 1e-5);
              var wob = 1 + 0.30 * Math.sin(ca * 5 + ch1 * 37) +
                            0.16 * Math.sin(ca * 9 - ch1 * 23);
              cchp = sstep(cr0 * wob, cr0 * wob * 0.5, cdd);
            }
          }
        }

        var broken = th3 > 0.90;                        // the odd tile is gone
        // Traffic path and mop film. Both are floor-scale, both cross cell
        // boundaries, and between them they carry more of this map's variance
        // than the per-tile lottery does - which is the point.
        var traf = sat((traffic[i] - 0.40) * 2.2);
        var mopM = sat((mop[i] - 0.56) * 2.6);
        var polish = sat((pol[i] - 0.52) * 4.0) * (0.45 + traf * 0.7);
        var cz = sstep(0.84, 0.995, crazeN[si]) * sstep(0.30, 0.70, th4);
        // Glaze rubs THROUGH at the arris first, and fastest on the walked
        // path. This is the second material: unglazed biscuit.
        var rub = (1 - bevel) * (1 - groutM) * (0.30 + traf * 1.30) *
                  sstep(0.30, 0.80, th2 * 0.45 + macro[i] * 0.55);

        // Shallow. Grout sits ~2mm below a 6mm tile; exaggerating that gap is
        // what makes procedural tile read as inflated pillows in a black grid.
        // The per-tile term is the LIPPAGE step: laid on an uneven screed, one
        // tile stands a millimetre proud of the next and catches the key.
        var h = 0.72 + (th - 0.5) * 0.026 + (th4 - 0.5) * 0.010 +
                (mottle[si] - 0.5) * 0.010 + (fine[si] - 0.5) * 0.004;
        h -= (1 - bevel) * 0.005 * (1 - groutM);
        h -= cz * 0.005 + rub * 0.004;
        // One crack that crosses tiles, plus the fine per-tile craze net.
        var ckB = sstep(0.90, 0.999, crackB[i]) * sstep(0.52, 0.72, ckMask[i]);
        var ck = sat(sstep(0.86, 0.995, crack[i]) * sstep(0.62, 0.80, th2) + ckB);
        h -= ck * 0.030;
        var chip = sstep(0.16, 0.02, chipC.f1[si]) * sstep(0.5, 0.9, th2) * (1 - bevel * 0.5);
        h -= chip * 0.040 + cchp * 0.046;
        if (broken) h = 0.686 + (mottle[si] - 0.5) * 0.014 + (fine[si] - 0.5) * 0.006;
        // Grout is sanded, tooled and patchily repaired - not a flat slab.
        var gAgg = sstep(0.30, 0.06, groutAgg.f1[i]);
        var gLoss = sstep(0.62, 0.82, dirtN[i] * 0.65 + jd * 0.35);  // raked out / lost
        h = lerp(h, 0.684 + (groutN[i] - 0.5) * 0.022 + gAgg * 0.012 - gLoss * 0.028,
                 groutM);
        S.h[i] = h;

        // --- albedo ----------------------------------------------------
        // One kiln lot: faded terracotta drifting toward ochre. The per-tile
        // spread is deliberately NARROW - the character comes from the ramp
        // and the wear, not from a colour lottery, because a lottery is
        // exactly what makes a floor read as a chessboard.
        // ...and it is a TERRACOTTA lot, not a cream one. On the material
        // chart this plate was landing in exactly the same pale-cream family
        // as plaster, concrete and sand, which is half of why the chart read
        // as a row of near-identical spheres.
        var lotA = PAL.brickD, lotB = PAL.plasterDk;
        var lot = 0.15 + th * 0.60;
        S.cr[i] = lerp(lotA[0], lotB[0], lot);
        S.cg[i] = lerp(lotA[1], lotB[1], lot);
        S.cb[i] = lerp(lotA[2], lotB[2], lot);
        tint(S, i, PAL.brickB, sstep(0.40, 0.72, th3) * 0.26);
        // per-tile firing gradient, at a per-tile angle
        var gA = (th2 - 0.5) * 6.2831853;
        var ramp = (fx - 0.5) * Math.cos(gA) + (fy - 0.5) * Math.sin(gA);
        shade(S, i, 1 + ramp * (0.10 + th4 * 0.18));
        tint(S, i, ramp > 0 ? PAL.brickD : PAL.stoneDk,
             Math.abs(ramp) * (0.12 + th3 * 0.22) * (1 - groutM));
        tint(S, i, PAL.olive, sstep(0.90, 1.0, th3) * 0.22);
        shade(S, i, 0.90 + 0.20 * mottle[si]);
        tint(S, i, PAL.plasterHi, sat((mottle[si] - 0.6) * 2.4) * 0.26);
        // body speckle showing through a thin glaze - sampled through this
        // tile's own rotation, so no two neighbours share a speckle pattern
        tint(S, i, speck.id[si] < 0.45 ? PAL.aggDark : PAL.plasterHi,
             sstep(0.28, 0.07, speck.f1[si]) * 0.24 * (1 - groutM));
        // crazing: a hairline net in the glaze that has filled with dirt
        tint(S, i, PAL.grime, cz * 0.60);
        // ---- chipped corner: straight through the glaze to raw biscuit ----
        if (cchp > 0) {
          tint(S, i, PAL.cement, cchp * 0.72);
          desat(S, i, cchp * 0.50);
          tint(S, i, PAL.grime, cchp * 0.26);
          shade(S, i, 1 - cchp * 0.08);
        }
        // ---- second material: glaze worn through to unglazed biscuit -----
        tint(S, i, PAL.cement, rub * 0.62);
        desat(S, i, rub * 0.45);
        shade(S, i, 1 - rub * 0.10);
        // ---- fields that cross the lattice -------------------------------
        tint(S, i, PAL.grime, traf * (0.16 + sat((dirtN[i] - 0.42) * 2.0) * 0.24) *
                              (1 - groutM));
        tint(S, i, PAL.dust, mopM * 0.22 * (1 - groutM));
        shade(S, i, 1 - mopM * 0.05);
        // The walked path is burnished, not dirty: slightly darker and much
        // glossier, which is what a polished traffic lane actually looks like.
        shade(S, i, 1 - polish * 0.07 * (1 - groutM));
        desat(S, i, polish * 0.12 * (1 - groutM));
        if (broken) {
          tint(S, i, PAL.cement, 0.88);                 // screed showing through
          tint(S, i, PAL.grime, 0.30);
          shade(S, i, 0.86);
        }
        tint(S, i, PAL.soot, ck * 0.55 + chip * 0.24);
        shade(S, i, 1 - ck * ck * 0.30);
        tint(S, i, PAL.cement, chip * 0.60);
        // ---- grout -------------------------------------------------------
        tint(S, i, PAL.mortar, groutM * 0.92);
        tint(S, i, groutAgg.id[i] < 0.5 ? PAL.aggDark : PAL.plasterHi,
             groutM * gAgg * 0.40);
        tint(S, i, PAL.sandDk, groutM * sat((groutN[i] - 0.56) * 2.4) * 0.30);
        // grout is a dirt magnet - but it is still grout, not a black line
        tint(S, i, PAL.grime, groutM * (0.20 + sat((dirtN[i] - 0.4) * 2.0) * 0.30 +
                                        gLoss * 0.34 + traf * 0.20));
        tint(S, i, PAL.dust, sat((dirtN[i] - 0.55) * 2.2) * (1 - groutM) * 0.20);
        tint(S, i, PAL.grime, (1 - bevel) * (1 - groutM) * 0.18);
        applyChroma(S, i, C, 1.0, sat(groutM * 1.2 + traf * 0.8 + cz),
                    { iron: 1.1, wash: 0.42 });

        // --- roughness --------------------------------------------------
        // Glaze is the smoothest thing in the level; grout is among the
        // roughest. That contrast is the whole point of this material - and
        // the walked path sits between the two, which is what makes the wear
        // read under a raking light rather than only in the albedo.
        var r = 0.18 + (mottle[si] - 0.5) * 0.10 + (1 - bevel) * 0.10;
        r += sat((dirtN[i] - 0.5) * 2.0) * 0.22;        // dust film kills the gloss
        r += ck * 0.35 + chip * 0.55 + cz * 0.16 + cchp * 0.62;
        r += rub * 0.46 + traf * 0.14;                  // scuffed glaze
        r -= mopM * 0.10;                               // wet-mopped sheen
        r -= polish * 0.34;                             // feet burnish the glaze
        if (broken) r = 0.85 + (fine[si] - 0.5) * 0.1;
        r = lerp(r, 0.94 + (groutN[i] - 0.5) * 0.08 + gLoss * 0.05 - jd * 0.06, groutM);
        S.ro[i] = sat(r);
        S.me[i] = 0;
      }
    }
  }

  // -- market canopy cloth: woven, striped, sun-bleached ---------------------
  function genFabric(g, S) {
    var n = g.n, size = g.size, i, x, y;
    var threads = size >= 1024 ? 96 : 48;
    var stripes = 5;
    var macro = g.fbm(g.buf(0), 4, 4, 0.6, 1, 11, false);
    var wobbleX = g.buf(0); g.fbmA(wobbleX, 40, 6, 3, 0.5, 1, 13, true);
    var wobbleY = g.buf(0); g.fbmA(wobbleY, 6, 40, 3, 0.5, 1, 17, true);
    var fade = g.fbm(g.buf(0), 6, 4, 0.6, 1, 19, false);
    var dirtN = g.fbm(g.buf(0), 5, 4, 0.6, 1, 23, false);
    var fray = g.fbm(g.buf(0), 100, 3, 0.5, 1, 29, false);
    var holes = g.worley(30, 1.0, 31);
    var C = chromaFields(g, 2700);
    // Warp and weft get INDEPENDENT irregularity: a woven cloth whose two axes
    // share a thread table still reads as a symmetric lattice.
    var TLx = threadLayout(g, threads, 5101, { wMin: 0.66, wMax: 1.44, slub: 0.045, floatEvery: 13 });
    var TLy = threadLayout(g, threads, 5107, { wMin: 0.72, wMax: 1.34, slub: 0.030, floatEvery: 21 });
    // Faded awning stripes. Kept few and wide - thin high-contrast stripes read
    // as a barcode rather than as cloth - and pre-mixed toward the dust tone so
    // nothing in the palette shouts.
    var stripeCols = [PAL.canvasRed, PAL.canvasTan, PAL.canvasTeal, PAL.canvasOchre,
                      PAL.canvasTan];
    for (var si = 0; si < stripeCols.length; si++) {
      var sc0 = stripeCols[si];
      stripeCols[si] = [lerp(sc0[0], PAL.dust[0], 0.50) * 0.84,
                        lerp(sc0[1], PAL.dust[1], 0.50) * 0.84,
                        lerp(sc0[2], PAL.dust[2], 0.50) * 0.84];
    }

    for (y = 0; y < size; y++) {
      var o = y * size;
      for (x = 0; x < size; x++) {
        i = o + x;
        // Irregular, wandering yarns - see threadLayout(). A perfect grid reads
        // as graph paper however prettily it is shaded.
        threadAt(TLx, (x / size) * threads + wobbleX[i] * 0.55);
        var ix = _thIdx, fxv = _thF;
        threadAt(TLy, (y / size) * threads + wobbleY[i] * 0.55);
        var iy = _thIdx, fyv = _thF;
        var warp = sat(Math.sin(Math.PI * fxv) / TLx.crown[ix]);
        var weft = sat(Math.sin(Math.PI * fyv) / TLy.crown[iy]);
        // A floated warp rides over its wefts for the whole of its run, so it
        // breaks the checkerboard parity along a whole line - the single
        // cheapest way to stop a plain weave reading as a chequer.
        var flo = TLx.flt[ix];
        var over = flo > 0 ? true : (((ix + iy) & 1) === 0);
        var top = over ? warp : weft, bot = over ? weft : warp;
        // Relief carries the weave now, not albedo.
        var h = 0.50 + top * 0.30 + bot * 0.085 + flo * warp * 0.055;
        h += (macro[i] - 0.5) * 0.12;                    // the cloth sags and folds
        var thin = sstep(0.20, 0.02, holes.f2[i] - holes.f1[i]) * sstep(0.5, 0.8, fade[i]);
        h -= thin * 0.10;
        S.h[i] = h;

        // --- albedo ----------------------------------------------------
        // Stripe boundaries land on a YARN boundary, because that is where a
        // woven stripe actually changes - and since the yarns are irregular the
        // stripe edges inherit that irregularity for free.
        var sIdx = Math.floor(frac(ix / threads + 0.13) * stripes) % stripes;
        var c = stripeCols[sIdx];
        S.cr[i] = c[0]; S.cg[i] = c[1]; S.cb[i] = c[2];
        // Weave in albedo: a whisper. The constant is solved so the map's MEAN
        // is unchanged from the old +-28% version (E[crown] ~ 0.637), which
        // matters because level.js measures some of these maps and rebases them.
        shade(S, i, 1.029 + 0.060 * top + 0.015 * bot);
        // ...and the real yarn-to-yarn colour variance is dye take-up, which
        // runs the LENGTH of a thread instead of forming a lattice.
        shade(S, i, 1 + ((over ? TLx.dye[ix] : TLy.dye[iy]) - 1) * 0.70);
        // sun bleaching, strongest on the exposed thread crowns
        var bleach = sat((fade[i] - 0.38) * 1.8);
        tint(S, i, PAL.dust, bleach * 0.44 * (0.5 + 0.7 * top));
        tint(S, i, PAL.grime, sstep(0.52, 0.34, h) * 0.30 +
                              sat((dirtN[i] - 0.55) * 2.2) * 0.28);
        tint(S, i, PAL.dirtDk, thin * 0.35);
        tint(S, i, PAL.sandDk, sat((fray[i] - 0.68) * 3.0) * 0.22);
        // Dyed cloth in this sun goes patchily neutral - the fold that faced
        // south for eight summers is two thirds of the way to grey while the
        // one under the shop sign still has its dye. That patchiness is the
        // only thing that separates a real awning from printed card.
        desat(S, i, bleach * 0.40);
        applyChroma(S, i, C, 0.9, sat(sstep(0.52, 0.36, h) * 1.3 + thin),
                    { iron: 0.9, wash: 0.30 });
        S.al[i] = 1 - sstep(0.06, 0.005, holes.f2[i] - holes.f1[i]) *
                      sstep(0.62, 0.86, fade[i]);

        // --- roughness --------------------------------------------------
        // Sun-rotted cloth is chalk-matte; the panels where the original
        // proofing/wax survives still have a real sheen. That contrast is the
        // difference between "awning" and "painted card".
        var r = 0.94;
        r -= sat((0.52 - fade[i]) * 2.6) * 0.62;
        // Thread crowns are burnished by everything that has ever brushed past
        // them; the interstices never are. This is where the weave read moved
        // to, together with the normal map, so it is worth ~0.18 not ~0.12.
        r -= top * 0.18;
        r += (1 - top) * 0.05 + flo * 0.06;
        r += thin * 0.10 + sat((dirtN[i] - 0.55) * 2.2) * 0.10;
        S.ro[i] = sat(r);
        S.me[i] = 0;
      }
    }
  }

  // -- heavy cotton duck: webbing, sandbags, slings --------------------------
  function genCanvas(g, S) {
    var n = g.n, size = g.size, i, x, y;
    var threads = size >= 1024 ? 72 : 36;
    var macro = g.fbm(g.buf(0), 4, 4, 0.6, 1, 11, false);
    var wobX = g.buf(0); g.fbmA(wobX, 30, 5, 3, 0.5, 1, 13, true);
    var wobY = g.buf(0); g.fbmA(wobY, 5, 30, 3, 0.5, 1, 17, true);
    var dirtN = g.fbm(g.buf(0), 6, 4, 0.6, 1, 19, false);
    var fuzz = g.fbm(g.buf(0), 260, 2, 0.5, 1, 23, false);
    var wearN = g.fbm(g.buf(0), 9, 4, 0.55, 1, 29, false);
    var C = chromaFields(g, 2900);
    var TLx = threadLayout(g, threads, 6203, { wMin: 0.74, wMax: 1.32, slub: 0.030, floatEvery: 17 });
    var TLy = threadLayout(g, threads, 6211, { wMin: 0.76, wMax: 1.28, slub: 0.022, floatEvery: 23 });

    for (y = 0; y < size; y++) {
      var o = y * size;
      for (x = 0; x < size; x++) {
        i = o + x;
        threadAt(TLx, (x / size) * threads + wobX[i] * 0.5);
        var ix = _thIdx, fxv = _thF;
        threadAt(TLy, (y / size) * threads + wobY[i] * 0.5);
        var iy = _thIdx, fyv = _thF;
        // twill: the float steps one thread per row, giving the diagonal rib
        var step = ((ix + iy * 2) % 4 + 4) % 4;
        var warp = sat(Math.sin(Math.PI * fxv) / TLx.crown[ix]);
        var weft = sat(Math.sin(Math.PI * fyv) / TLy.crown[iy]);
        var flo = TLx.flt[ix];
        var over = flo > 0 ? true : (step < 2);
        var top = over ? warp : weft, bot = over ? weft : warp;
        var h = 0.50 + top * 0.30 + bot * 0.075 + flo * warp * 0.05;
        h += (macro[i] - 0.5) * 0.13 + (fuzz[i] - 0.5) * 0.03;
        S.h[i] = h;

        // One dye lot with a soft drift between olive and tan. A hard threshold
        // here reads as camouflage blotching, which is not what this is.
        var mb = sstep(0.34, 0.68, macro[i]);
        S.cr[i] = lerp(PAL.canvasTan[0], PAL.olive[0], mb);
        S.cg[i] = lerp(PAL.canvasTan[1], PAL.olive[1], mb);
        S.cb[i] = lerp(PAL.canvasTan[2], PAL.olive[2], mb);
        // Same mean, a twentieth of the contrast - see genFabric.
        shade(S, i, 1.036 + 0.060 * top + 0.015 * bot);
        shade(S, i, 1 + ((over ? TLx.dye[ix] : TLy.dye[iy]) - 1) * 0.60);
        // sweat, dust and abrasion on the high thread crowns
        var wear = sat((wearN[i] - 0.5) * 2.0) * sat((h - 0.60) * 3.0);
        tint(S, i, PAL.dust, wear * 0.42);
        tint(S, i, PAL.grime, sstep(0.52, 0.34, h) * 0.34 +
                              sat((dirtN[i] - 0.52) * 2.2) * 0.32);
        tint(S, i, PAL.dirtDk, sat((dirtN[i] - 0.72) * 3.0) * 0.28);
        shade(S, i, 0.94 + 0.14 * fuzz[i]);
        desat(S, i, wear * 0.46);                 // abraded crowns go neutral
        applyChroma(S, i, C, 0.95, sat(sstep(0.52, 0.34, h) * 1.3),
                    { iron: 1.0, wash: 0.58 });

        // Handled duck goes glassy where a strap or a hand has flattened the
        // nap; untouched, dusty panels stay right at the top of the curve.
        var r = 0.94 - sat((wearN[i] - 0.40) * 2.4) * 0.50 - wear * 0.16;
        r -= sat((macro[i] - 0.56) * 2.4) * 0.26;
        r -= top * 0.17;
        r += (1 - top) * 0.05 + flo * 0.05;
        r += sat((dirtN[i] - 0.60) * 2.4) * 0.08;
        S.ro[i] = sat(r);
        S.me[i] = 0;
      }
    }
  }

  // -- rubber: tyres, mats, weather seals ------------------------------------
  function genRubber(g, S) {
    var n = g.n, i;
    var pebble = g.worley(90, 1.0, 11);
    var macro = g.fbm(g.buf(0), 4, 4, 0.6, 1, 13, false);
    var fine = g.fbm(g.buf(0), 240, 3, 0.5, 1, 17, false);
    var ozone = g.ridged(g.buf(0), 40, 3, 1, 19, true);       // perishing cracks
    var dustN = g.fbm(g.buf(0), 7, 4, 0.6, 1, 23, false);
    var mould = g.buf(0); g.fbmA(mould, 3, 90, 2, 0.5, 1, 29, false);

    S.base(PAL.rubber);
    for (i = 0; i < n; i++) {
      var peb = sstep(0.40, 0.10, pebble.f1[i]);
      var ck = sstep(0.88, 0.998, ozone[i]);
      var h = 0.62 + (macro[i] - 0.5) * 0.08 + peb * 0.05 + (fine[i] - 0.5) * 0.02;
      h += sat((mould[i] - 0.80) * 5.0) * 0.03;               // mould parting line
      h -= ck * 0.14;
      S.h[i] = h;

      shade(S, i, 0.82 + 0.34 * macro[i] + 0.18 * peb);
      tint(S, i, PAL.soot, ck * 0.6);
      // rubber blooms a grey antiozonant film and holds dust
      var film = sat((dustN[i] - 0.42) * 1.8) * sat((h - 0.60) * 3.0);
      tint(S, i, PAL.dust, film * 0.26);
      tint(S, i, PAL.grime, sstep(0.60, 0.48, h) * 0.30);
      // Perished rubber browns where the ozone has got at it and greys where
      // the antiozonant has bloomed out. Small effect, but a dead-neutral
      // black surface is the one thing that never happens outdoors.
      tint(S, i, PAL.rustDeep, sstep(0.50, 0.64, macro[i]) * (0.25 + ck) * 0.60);
      tint(S, i, PAL.dirtDk, sstep(0.52, 0.66, dustN[i]) * 0.34);
      tint(S, i, PAL.dampGrey, sstep(0.48, 0.34, dustN[i]) * 0.30);
      desat(S, i, film * 0.55 + sstep(0.48, 0.34, macro[i]) * 0.45);

      var r = 0.80 - peb * 0.14;
      r += film * 0.24 + ck * 0.14;
      r -= sat((macro[i] - 0.48) * 2.4) * 0.60;               // rubbed-shiny patches
      S.ro[i] = sat(r);
      S.me[i] = 0;
    }
  }

  // -- dirty window glass ----------------------------------------------------
  function genGlass(g, S) {
    var n = g.n, size = g.size, i;
    var wave = g.fbm(g.buf(0), 5, 3, 0.6, 1, 11, false);      // float-glass waviness
    var dustN = g.fbm(g.buf(0), 8, 4, 0.6, 1, 13, false);
    var smear = g.buf(0); g.fbmA(smear, 24, 5, 3, 0.5, 1, 17, false);
    var fine = g.fbm(g.buf(0), 260, 2, 0.5, 1, 19, false);
    var spat = g.worley(140, 1.0, 23);
    var crack = g.ridged(g.buf(0), 14, 4, 1, 29, true);

    S.base(PAL.glass);
    for (i = 0; i < n; i++) {
      var dust = sat((dustN[i] - 0.44) * 1.9);
      var sm = sat((smear[i] - 0.55) * 2.4);
      var spot = sstep(0.13, 0.03, spat.f1[i]);
      var ck = sstep(0.90, 0.999, crack[i]);
      var h = 0.72 + (wave[i] - 0.5) * 0.05 + dust * 0.012 + spot * 0.02;
      h -= ck * 0.12;
      S.h[i] = h;

      // Clean glass has almost no diffuse albedo - the base is dark and the pane
      // gets its brightness from what it reflects. Only the dirt on it is light.
      shade(S, i, 0.94 + 0.12 * wave[i]);
      tint(S, i, PAL.glassFilm, dust * 0.62 + sm * 0.26);
      tint(S, i, PAL.dust, dust * dust * 0.30);
      tint(S, i, PAL.grime, sat((dustN[i] - 0.72) * 3.0) * 0.30 + spot * 0.34);
      // Rain tracks are cool and clean; the baked-on dust film is warm ochre.
      tint(S, i, PAL.ironStain, sstep(0.48, 0.63, dustN[i]) * dust * 0.46);
      tint(S, i, PAL.dampGrey, sm * 0.34);
      desat(S, i, sstep(0.48, 0.64, wave[i]) * 0.55 + sm * 0.24);
      tint(S, i, PAL.plasterHi, ck * 0.62);                    // cracks scatter white
      // Alpha carries the grime so materials.js can make a transparent pane that
      // still shows the dirt on it.
      S.al[i] = sat(0.10 + dust * 0.42 + sm * 0.18 + spot * 0.5 + ck * 0.7);

      var r = 0.045 + dust * 0.42 + sm * 0.22 + spot * 0.35 + ck * 0.45 +
              (fine[i] - 0.5) * 0.03;
      S.ro[i] = sat(r);
      S.me[i] = 0;
    }
    punchCraters(g, S, { count: 2, rMin: 0.010, rMax: 0.020, depth: 0.25,
                         rough: 0.85, col: PAL.plasterHi, tint: 0.6, halo: 4.5 });
  }

  // -- dry mediterranean foliage (alpha-cut leaf cards) ----------------------
  function genFoliage(g, S) {
    var n = g.n, i;
    S.base(PAL.foliageDk);
    // Background height matches the leaf mid-plane. A big step here would make
    // the auto-normalised gradient statistic all silhouette and no surface, and
    // the alpha cutout removes the background anyway.
    S.h.fill(0.5);
    S.al.fill(0);
    S.ro.fill(0.85);
    stampLeaves(g, S, { count: 210, lenMin: 0.075, lenMax: 0.175 });
    stampLeaves(g, S, { count: 130, lenMin: 0.045, lenMax: 0.095 });

    var fine = g.fbm(g.buf(0), 150, 3, 0.5, 1, 41, false);
    var macro = g.fbm(g.buf(0), 4, 4, 0.6, 1, 43, false);
    var veinN = g.fbm(g.buf(0), 90, 3, 0.5, 1, 47, false);
    for (i = 0; i < n; i++) {
      if (S.al[i] < 0.5) { S.ro[i] = 0.9; S.me[i] = 0; continue; }
      // secondary venation + cell texture on the leaf surface
      S.h[i] += (veinN[i] - 0.5) * 0.020 + (fine[i] - 0.5) * 0.010;
      shade(S, i, 0.86 + 0.28 * macro[i] + (fine[i] - 0.5) * 0.16);
      tint(S, i, PAL.foliageDry, sat((macro[i] - 0.58) * 2.4) * 0.42);
      tint(S, i, PAL.dust, sat((macro[i] - 0.66) * 2.6) * 0.24);
      tint(S, i, PAL.foliageDk, sat((veinN[i] - 0.62) * 2.4) * 0.20);
      // cuticle wax gives a low-roughness sheen; dusty leaves lose it
      S.ro[i] = sat(S.ro[i] + (fine[i] - 0.5) * 0.12 +
                    sat((macro[i] - 0.6) * 2.0) * 0.12 - 0.06);
      S.me[i] = 0;
    }
  }

  // -- weapon receiver / rail: parkerised aluminium with edge wear -----------
  function genGunMetal(g, S) {
    var n = g.n, i;
    var macro = g.fbm(g.buf(0), 4, 4, 0.6, 1, 11, false);
    // Anodise / phosphate conversion-coat mottle. Deliberately LOW frequency:
    // at the viewmodel's texel density everything above ~freq 200 is gone by
    // mip 1, and this band is the only one that can give a near-black receiver
    // readable form at arm's length.
    var coat = g.fbm(g.buf(0), 22, 3, 0.55, 1, 13, false);
    var blast = g.fbm(g.buf(0), 150, 2, 0.5, 1, 43, false);    // bead-blast peen
    var cell = g.worley(74, 0.9, 47);                          // phosphate crystal
    // Broach / extrusion striations - long machining lines running the length
    // of the part. This is what makes the rail read as cut aluminium.
    var broachRaw = g.buf(0); g.fbmA(broachRaw, 4, 130, 3, 0.5, 1, 17, false);
    var broach = g.buf(0); g.shear(broachRaw, broach, 1);
    var toolRaw = g.buf(0); g.fbmA(toolRaw, 6, 200, 2, 0.5, 1, 19, false);
    var grainRaw = g.buf(0); g.fbmA(grainRaw, 420, 5, 3, 0.5, 1, 23, false);
    var grain = g.buf(0); g.shear(grainRaw, grain, 1);
    var wearN = g.fbm(g.buf(0), 9, 5, 0.55, 1, 61, false);
    var scrRaw = g.buf(0); g.fbmA(scrRaw, 360, 4, 3, 0.5, 1, 29, false);
    var scr = g.buf(0); g.shear(scrRaw, scr, 3);
    var carbon = g.fbm(g.buf(0), 7, 4, 0.6, 1, 31, false);
    var pit = g.worley(210, 1.0, 37);
    // Ridge field for the wear mask. A LOW-frequency blob field thresholded in
    // the middle is not an edge mask - it is a cloud, and mip-averaged it turns
    // the whole receiver into polished pale metal. Wear must be a thin
    // high-frequency crest riding the proud parts of the height field.
    var ridgeN = g.ridged(g.buf(0), 64, 3, 1, 53, true);

    S.base(PAL.gunmetal);
    for (i = 0; i < n; i++) {
      var bl = blast[i];
      var micro = sat((grain[i] - 0.5) * 1.2);
      var sc = sat((scr[i] - 0.66) * 4.0);
      var pt = sstep(0.20, 0.04, pit.f1[i]);

      var h = 0.62 + (macro[i] - 0.5) * 0.030 + (coat[i] - 0.5) * 0.052 +
              (bl - 0.5) * 0.028 + (broach[i] - 0.5) * 0.030 +
              sstep(0.55, 0.12, cell.f1[i]) * 0.018 +
              (toolRaw[i] - 0.5) * 0.014 + (grain[i] - 0.5) * 0.008;
      h -= pt * 0.022;
      h -= sc * 0.012;
      S.h[i] = h;

      // Edge wear: only where the surface is genuinely PROUD, sharpened by the
      // ridge field and clustered by a broad "where hands and slings go" mask.
      // Target coverage is under ~10% of the tile.
      var ridge = sat((ridgeN[i] - 0.55) * 3.4);
      var zone = sat((wearN[i] - 0.37) * 2.6);
      var wear = sat((h - 0.638) * 20.0) * (0.30 + 0.70 * ridge) * zone;
      // The rub-through CROWN: the few percent of the surface that has gone
      // right back to polished bare metal. This is the part that catches the
      // sky, and it is what lets a near-black receiver read its own parts.
      var crown = wear * wear * sat((h - 0.648) * 26.0);

      // --- albedo -------------------------------------------------------
      // Wider than it was. The receiver measured P95/P05 = 1.34 across the
      // whole map, which is why the viewmodel photographed as an unreadable
      // silhouette: nothing in the albedo separated the rail from the mag well
      // from the buffer tube. The MEAN stays where ART_DIRECTION puts it
      // (#2a2c30); it is the spread that opens up.
      shade(S, i, 0.86 + 0.28 * coat[i] + (macro[i] - 0.5) * 0.16 + (bl - 0.5) * 0.14);
      tint(S, i, PAL.polymerWorn, micro * 0.14);
      // Rub-through to bare aluminium. Still restrained in COVERAGE - under
      // ~10% of the tile - but no longer restrained in contrast, because a
      // wear mask that never reaches bare metal is just a lighter grey.
      tint(S, i, PAL.alu, wear * 0.42 + sc * 0.28);
      tint(S, i, PAL.steelDk, wear * 0.20);
      tint(S, i, PAL.steel, crown * 0.55);
      // carbon fouling and handling grime settle in the low spots
      tint(S, i, PAL.soot, sat((carbon[i] - 0.56) * 2.6) * (1 - wear) * 0.55);
      tint(S, i, PAL.grime, sstep(0.625, 0.585, h) * 0.28);
      shade(S, i, 1 - sstep(0.615, 0.578, h) * 0.18);
      tint(S, i, PAL.dust, sat((macro[i] - 0.70) * 3.4) * 0.12);
      // Not a neutral black. Phosphate over aluminium is faintly warm-grey and
      // the carbon on it is warmer still, while the bare rub-through is cool -
      // that split is the whole reason a real gun does not read as a cutout.
      tint(S, i, PAL.steelWarm, sat((carbon[i] - 0.44) * 2.2) * (1 - wear) * 0.30);
      tint(S, i, PAL.dampGrey, crown * 0.30);
      desat(S, i, sat((bl - 0.54) * 2.6) * 0.42 + wear * 0.20);

      // --- roughness / metalness ----------------------------------------
      // Art direction: gun metal ~0.35 with edge wear picking up the sky. The
      // raw value is authored across the whole 0..1 range so materials.js's
      // [0.20,0.58] window is actually used instead of one flat satin value.
      var burnish = sat((macro[i] - 0.46) * 3.0);          // handled / slung zones
      var fouling = sat((carbon[i] - 0.54) * 3.2);         // carbon + dust film
      var r = 0.44 + (bl - 0.5) * 0.32 + (coat[i] - 0.5) * 0.26;
      r -= burnish * 0.30 + micro * 0.08;
      r += fouling * 0.34;
      r = lerp(r, 0.04, wear);
      r -= sc * 0.30;
      r += pt * 0.14;
      S.ro[i] = sat(r);
      // Parkerising / Cerakote is a phosphate-and-polymer conversion coat: a
      // DIELECTRIC over the metal. Authoring the receiver as metalness ~1 is
      // why so many procedural guns mirror the sky and render as pale plastic
      // under a bright IBL. The base coat stays essentially non-metal and only
      // the rub-through creeps up - that contrast IS the wear read.
      // Metalness stays LOW on the coating. A parkerised receiver authored as
      // metal has its albedo reinterpreted as F0, and #2a2c30 is a terrible
      // F0 - the part turns into dark chrome that mirrors whatever the IBL
      // happens to be doing. Only the genuine rub-through creeps up, and even
      // the crown is held short of a mirror.
      S.me[i] = sat(0.04 + wear * 0.45 + crown * 0.20 + sc * 0.25);
    }
    punchScrapes(g, S, { count: 22, lenMin: 0.03, lenMax: 0.16, width: 0.0009,
                         depth: 0.010, rough: 0.14, col: PAL.alu, tint: 0.42, metal: 0.7 });
  }

  // -- weapon furniture: stippled glass-filled polymer ------------------------
  function genGunPolymer(g, S) {
    var n = g.n, size = g.size, i, x, y;
    var stip = g.worley(150, 0.7, 11);
    var macro = g.fbm(g.buf(0), 5, 4, 0.6, 1, 13, false);
    var fine = g.fbm(g.buf(0), 300, 2, 0.5, 1, 17, false);
    var wearN = g.fbm(g.buf(0), 8, 5, 0.55, 1, 19, false);
    var fibre = g.buf(0); g.fbmA(fibre, 260, 40, 3, 0.5, 1, 23, false);
    var mould = g.buf(0); g.fbmA(mould, 2, 120, 2, 0.5, 1, 29, false);

    S.base(PAL.polymer);
    for (y = 0; y < size; y++) {
      var o = y * size;
      for (x = 0; x < size; x++) {
        i = o + x;
        // moulded-in checkering, softened by the stipple cells
        var gx = Math.abs(frac(x / size * 26) * 2 - 1);
        var gy = Math.abs(frac(y / size * 26) * 2 - 1);
        var check = sstep(0.30, 0.95, Math.min(gx, gy));
        var st = sstep(0.55, 0.15, stip.f1[i]);
        var wear = sat((wearN[i] - 0.58) * 3.2);

        var h = 0.62 + check * 0.10 + st * 0.045 +
                (macro[i] - 0.5) * 0.035 + (fine[i] - 0.5) * 0.012;
        h += sat((mould[i] - 0.84) * 6.0) * 0.02;         // parting line
        h -= wear * check * 0.045;                        // the peaks get worn flat
        S.h[i] = h;

        shade(S, i, 0.82 + 0.34 * macro[i] + 0.22 * st);
        // glass fibre shows as pale flecks aligned with the flow front
        tint(S, i, PAL.polymerWorn, sat((fibre[i] - 0.70) * 3.4) * 0.34);
        tint(S, i, PAL.polymerWorn, wear * 0.50);
        tint(S, i, PAL.grime, sstep(0.62, 0.56, h) * 0.28);
        shade(S, i, 1 - sstep(0.60, 0.545, h) * 0.16);
        tint(S, i, PAL.dust, sat((macro[i] - 0.70) * 3.2) * 0.16);
        // Reinforced polymer weathers two ways at once: the resin at the
        // surface chalks out toward neutral while the ground-in dust and gun
        // oil in the checkering go warm. Without both, it is one flat hue.
        desat(S, i, sstep(0.46, 0.62, macro[i]) * 0.65 + wear * 0.30);
        tint(S, i, PAL.ironStain, sstep(0.50, 0.35, macro[i]) * (0.35 + st) * 0.40);
        tint(S, i, PAL.dampGrey, sstep(0.52, 0.67, wearN[i]) * 0.26);

        // Polymer is matte from the mould texture but goes shiny where a hand
        // has rubbed the checkering down.
        var r = 0.68 + (fine[i] - 0.5) * 0.14 - st * 0.06;
        r = lerp(r, 0.30, wear);
        r -= check * 0.04;
        S.ro[i] = sat(r);
        S.me[i] = 0;
      }
    }
  }

  // -- skin for hands and faces ---------------------------------------------
  //
  // REWRITTEN. The old map measured an albedo P95/P05 of 1.05 and octave-band
  // RMS of 0.55% through the entire 8-128 texel band: a flat colour with a
  // gentle gradient on it. That is not "subtle skin", it is no texture at all,
  // and it is a direct cause of the enemy reading as an untextured clay
  // mannequin and of the gloved hands failing to read on the viewmodel.
  //
  // A face is read at 1-3 cm - tan lines, capillary flush, beard shadow, sun
  // damage, dust ground into the pores. On a 512 map at the density a head
  // gets, that is the 20-90 texel band, which is exactly the band that was
  // empty. It is now authored explicitly, along with the two things that give
  // skin its chroma variance: flush (saturated red) and dust/pallor (neutral).
  // Relief stays tiny on purpose - the RECIPES bump for skin is 0.20, because
  // pushing this into the height field is what turns a face into orange stucco.
  function genSkin(g, S) {
    var n = g.n, i;
    var macro = g.fbm(g.buf(0), 4, 4, 0.6, 1, 11, false);
    var blotch = g.fbm(g.buf(0), 12, 4, 0.55, 1, 13, false);
    // THE BAND A FACE IS ACTUALLY READ AT.
    var midA = g.fbm(g.buf(0), 26, 3, 0.58, 1, 101, false);
    var midB = g.fbm(g.buf(0), 62, 3, 0.58, 1, 103, false);
    var flush = g.fbm(g.buf(0), 9, 3, 0.55, 1, 105, false);    // capillary bloom
    var freck = g.worley(64, 1.0, 107);                        // freckles, moles
    var grimeN = g.fbm(g.buf(0), 15, 4, 0.55, 1, 109, false);  // ground-in dirt
    var pores = g.worley(110, 1.0, 17);
    var pores2 = g.worley(56, 1.0, 19);
    var creaseRaw = g.ridged(g.buf(0), 30, 3, 1, 23, false);
    var crease2 = g.buf(0); g.shear(creaseRaw, crease2, 1);
    var fine = g.fbm(g.buf(0), 120, 2, 0.5, 1, 29, false);
    var stub = g.worley(240, 1.0, 31);
    var oily = g.fbm(g.buf(0), 7, 4, 0.6, 1, 37, false);

    S.base(PAL.skin);
    for (i = 0; i < n; i++) {
      var po = sstep(0.30, 0.05, pores.f1[i]);
      var po2 = sstep(0.34, 0.08, pores2.f1[i]);
      // the two crease directions cross to give the diamond skin micro-relief
      var cr = sat((creaseRaw[i] - 0.55) * 2.4) * 0.5 + sat((crease2[i] - 0.55) * 2.4) * 0.5;
      // Skin relief is tiny. At the texel density a face texture actually gets,
      // a pore is well under one texel across, so pushing pore depth into the
      // height field just produces orange stucco. Pores live in the albedo and
      // the roughness; only the creases carry real geometry.
      var h = 0.66 + (macro[i] - 0.5) * 0.05 + (blotch[i] - 0.5) * 0.025 +
              (fine[i] - 0.5) * 0.006;
      h += (macro[i] - 0.5) * 0.055 + (blotch[i] - 0.5) * 0.030;
      h -= po * 0.005 + po2 * 0.004 + cr * 0.026;
      var st = sstep(0.18, 0.04, stub.f1[i]) * sat((macro[i] - 0.45) * 2.0);
      h += st * 0.003;
      S.h[i] = h;

      // subsurface reddening in the creases and thin skin, pale on the crowns
      tint(S, i, PAL.skinDeep, cr * 0.30 + po * 0.10 + sstep(0.664, 0.628, h) * 0.20);
      tint(S, i, PAL.skinPale, sat((h - 0.664) * 4.0) * 0.24);
      // ---- the 20-90 texel band -----------------------------------------
      // Skin is low-contrast but it is NOT uniform: melanin is blotchy at the
      // centimetre scale and blood sits closer to the surface in some places
      // than others. Authored as tone plus hue, both, because a luminance-only
      // modulation of one colour is what reads as putty.
      shade(S, i, 0.90 + 0.20 * midA[i]);
      shade(S, i, 0.95 + 0.10 * midB[i]);
      // NOTE ON RAMPS. Every threshold in this recipe is cut where a 3-octave
      // value-noise fbm actually LIVES. That field has mean 0.5 and a standard
      // deviation near 0.14, so a ramp written sat((f - 0.58) * 2.6) does not
      // reach full strength until +2.6 sigma and therefore contributes
      // essentially nothing - which is how a map ends up measuring as a flat
      // colour despite having a dozen layers painted onto it. sstep(0.50,0.66)
      // is 0 to +1.1 sigma: full strength on the ~14% of the map a real stain
      // or blemish covers.
      tint(S, i, PAL.skinDeep, sstep(0.52, 0.67, midA[i]) * 0.34);
      tint(S, i, PAL.skinPale, sstep(0.48, 0.33, midB[i]) * 0.28);
      // capillary flush - cheeks, nose, knuckles, the back of the neck. This
      // is the map's high-chroma population and it has to be strong enough to
      // matter: measured saturation p95/mean was 1.03, i.e. a constant.
      var fl = sstep(0.49, 0.64, flush[i]);
      tint(S, i, PAL.blood, fl * 0.42 + sstep(0.55, 0.70, blotch[i]) * 0.28);
      // ...and the matching low end: the dry, wind-burned, dust-filmed panels
      // of a face are genuinely close to neutral. Flush without pallor is a
      // constant chroma with a red gradient on it.
      desat(S, i, sstep(0.50, 0.34, blotch[i]) * 0.34);
      // freckles / moles / sun damage: small, hard-edged, and much darker than
      // anything else on the map. This is where the low end of the value range
      // comes from - without it the whole albedo lives inside a 1.05x window.
      var fk = sstep(0.20, 0.04, freck.f1[i]) * sat((macro[i] - 0.30) * 2.2);
      tint(S, i, PAL.skinDeep, fk * (0.32 + freck.id[i] * 0.46));
      shade(S, i, 1 - fk * fk * 0.20);
      tint(S, i, PAL.skinDeep, sat((macro[i] - 0.54) * 2.0) * 0.30);    // sun tan
      tint(S, i, PAL.skinPale, sat((0.44 - macro[i]) * 2.2) * 0.24);    // covered skin
      // ---- and the chroma LOW end ---------------------------------------
      // Dust and grime ground into a face are near-neutral, so they pull the
      // saturation down over broad areas while the flush pushes it up. That
      // spread is the difference between skin and a solid fill.
      var gm = sstep(0.48, 0.64, grimeN[i]);
      tint(S, i, PAL.grime, gm * 0.26);
      desat(S, i, gm * 0.62);
      shade(S, i, 1 - gm * gm * 0.09);
      tint(S, i, PAL.dust, 0.10 + sstep(0.56, 0.70, macro[i]) * 0.20);
      desat(S, i, sstep(0.52, 0.68, oily[i]) * 0.46);   // dry, dust-filmed cheek
      tint(S, i, PAL.soot, st * 0.40);                                  // stubble
      desat(S, i, st * 0.44);
      shade(S, i, 1 - st * 0.12);

      // Oily forehead/nose zones are the shiniest part of a face; dry, dusty
      // skin is not. This variation is what stops CG skin looking like wax.
      var r = 0.74 + cr * 0.14 + po * 0.08 + st * 0.14;
      r -= sat((oily[i] - 0.44) * 2.4) * 0.62;      // T-zone sebum vs dry cheek
      r -= sat((macro[i] - 0.62) * 2.6) * 0.10;
      r += gm * 0.14;
      S.ro[i] = sat(r);
      S.me[i] = 0;
    }
  }

  // -- hessian sandbag: coarse jute sacking, sun-rotted, bleeding sand -------
  function genSandbag(g, S) {
    var n = g.n, size = g.size, i, x, y;
    var threads = size >= 512 ? 46 : 24;
    var lobe = g.fbm(g.buf(0), 3, 3, 0.62, 1, 11, false);        // the bag sags
    var wobX = g.buf(0); g.fbmA(wobX, 26, 4, 3, 0.5, 1, 13, true);
    var wobY = g.buf(0); g.fbmA(wobY, 4, 26, 3, 0.5, 1, 17, true);
    var slub = g.buf(0); g.fbmA(slub, 70, 7, 3, 0.5, 1, 19, false);  // yarn thickness
    var fuzz = g.fbm(g.buf(0), 150, 2, 0.5, 1, 23, false);
    var sun = g.fbm(g.buf(0), 5, 4, 0.6, 1, 29, false);          // UV rot / bleaching
    var dirtN = g.fbm(g.buf(0), 7, 4, 0.6, 1, 31, false);
    var thinC = g.worley(16, 1.0, 37);                           // stretched, burst areas
    var C = chromaFields(g, 3100);
    // Hessian is hand-spun jute: the loosest tolerances of any cloth in the
    // level, which is exactly why a machine-perfect lattice was so obvious on
    // the revetment.
    var TLx = threadLayout(g, threads, 7307, { wMin: 0.58, wMax: 1.52, slub: 0.075, floatEvery: 11 });
    var TLy = threadLayout(g, threads, 7321, { wMin: 0.62, wMax: 1.46, slub: 0.060, floatEvery: 14 });
    var seedM = g.buf(0), bleed = g.buf(0);
    for (i = 0; i < n; i++) seedM[i] = sstep(0.10, 0.02, thinC.f2[i] - thinC.f1[i]);
    g.drip(seedM, bleed, 0.982, true);                           // sand runs out and down

    for (y = 0; y < size; y++) {
      var o = y * size;
      for (x = 0; x < size; x++) {
        i = o + x;
        // Jute is spun thick and unevenly, so the yarn diameter wanders along
        // its own length - that irregularity is what separates hessian from
        // the flat machine weave of the canvas recipe.
        threadAt(TLx, (x / size) * threads + wobX[i] * 0.7);
        var ix = _thIdx, fxv = _thF;
        threadAt(TLy, (y / size) * threads + wobY[i] * 0.7);
        var iy = _thIdx, fyv = _thF;
        var thick = 0.62 + slub[i] * 0.5;
        var warp = Math.pow(sat(Math.sin(Math.PI * fxv) / (thick * TLx.crown[ix])), 0.8);
        var weft = Math.pow(sat(Math.sin(Math.PI * fyv) / (thick * TLy.crown[iy])), 0.8);
        var flo = TLx.flt[ix];
        var over = flo > 0 ? true : (((ix + iy) & 1) === 0);
        var top = over ? warp : weft, bot = over ? weft : warp;
        var gap = sat(1 - warp * 1.5) * sat(1 - weft * 1.5);     // holes in the weave

        var thin = sstep(0.16, 0.02, thinC.f2[i] - thinC.f1[i]);
        var h = 0.50 + top * 0.30 + bot * 0.075 + (lobe[i] - 0.5) * 0.22 +
                (fuzz[i] - 0.5) * 0.035 + flo * warp * 0.05;
        h -= gap * 0.14 + thin * 0.05;
        S.h[i] = h;

        // --- albedo ----------------------------------------------------
        var rot = sat((sun[i] - 0.42) * 1.9);
        S.cr[i] = lerp(PAL.jute[0], PAL.juteLt[0], rot);
        S.cg[i] = lerp(PAL.jute[1], PAL.juteLt[1], rot);
        S.cb[i] = lerp(PAL.jute[2], PAL.juteLt[2], rot);
        // Per-yarn shading, but as a +-7% shimmer rather than the 1.94:1 swing
        // that was mipping into a hard crosshatch on every bag in the frame.
        // Solved for the same mean (E[top] ~ 0.72 for this crown profile).
        shade(S, i, 1.040 + 0.110 * top + 0.031 * bot);
        shade(S, i, 1 + ((over ? TLx.dye[ix] : TLy.dye[iy]) - 1) * 0.75);
        // The interstices of an OPEN weave are a different matter: you are
        // looking past the yarn into the shadowed inside of the sack, so that
        // darkening is real occlusion and it stays.
        tint(S, i, PAL.juteDk, sat(1 - top * 2.4) * 0.42 + gap * 0.75);
        // fill sand pushing through the weave and streaking down the face
        var out = sat(bleed[i] * 1.1) * sat(0.35 + top);
        tint(S, i, PAL.sand, out * 0.55 + thin * 0.30);
        tint(S, i, PAL.dust, sat((fuzz[i] - 0.58) * 3.0) * 0.30 + rot * 0.22);
        tint(S, i, PAL.grime, sstep(0.52, 0.34, h) * 0.34 +
                              sat((dirtN[i] - 0.56) * 2.2) * 0.30);
        tint(S, i, PAL.dirtDk, sat((dirtN[i] - 0.74) * 3.2) * 0.26);
        // A revetment is not one bag of one colour: the bags that face the sun
        // rot pale and lose their chroma entirely, the ones in the shade go
        // green at the seams, and the ones that got rained on hold an iron
        // stain off whatever they are stacked against.
        desat(S, i, rot * 0.55);
        applyChroma(S, i, C, 1.05, sat(sstep(0.52, 0.34, h) * 1.3 + gap),
                    { wash: 0.56 });

        // --- roughness: coherent zones, no per-texel salt ---------------
        // Sun-rotted, fibrous hessian is about as rough as a surface gets;
        // sand-caked and rain-compacted areas pack down noticeably smoother.
        var caked = sat((dirtN[i] - 0.48) * 2.2);
        var r = 0.80 + rot * 0.20 - caked * 0.55 - out * 0.30;
        r -= top * 0.20;                                         // yarn crowns burnish
        r += (1 - top) * 0.06 + gap * 0.15;
        S.ro[i] = sat(r);
        S.me[i] = 0;
      }
    }
  }

  // -- shattered concrete rubble: chunks, exposed aggregate, rebar, dust -----
  function genRubble(g, S) {
    var n = g.n, i;
    var big = g.worley(13, 1.0, 11);        // slab fragments
    var mid = g.worley(31, 1.0, 13);
    var small = g.worley(74, 1.0, 17);
    var agg = g.worley(150, 1.0, 19);       // aggregate in the broken faces
    var macro = g.fbm(g.buf(0), 3, 4, 0.6, 1, 23, false);
    var med = g.fbm(g.buf(0), 26, 4, 0.5, 1, 29, false);
    var fine = g.fbm(g.buf(0), 170, 3, 0.5, 1, 31, false);
    var dustN = g.fbm(g.buf(0), 5, 4, 0.6, 1, 37, false);
    var barRaw = g.buf(0); g.fbmA(barRaw, 150, 5, 3, 0.5, 1, 41, false);
    var bar = g.buf(0); g.shear(barRaw, bar, 2);   // bent rebar lying across it

    S.base(PAL.concrete);
    for (i = 0; i < n; i++) {
      // Fragments are FACETED, not domed. A radial falloff on the cell distance
      // gives rounded river pebbles, which is the opposite of demolition
      // rubble: a broken slab is a flat fracture plane lying at its own angle,
      // meeting its neighbours at a sharp arris. So the plate comes from the
      // cell BORDER term (sharp at f2-f1 -> 0) and the height from the cell's
      // own random id, with only a hint of dome on top.
      var bE = sstep(0.015, 0.115, big.f2[i] - big.f1[i]);
      var mE = sstep(0.015, 0.105, mid.f2[i] - mid.f1[i]);
      var sE = sstep(0.020, 0.130, small.f2[i] - small.f1[i]);
      var b = bE * (0.30 + big.id[i] * 0.70) * sstep(0.62, 0.30, big.f1[i]);
      var m = mE * (0.30 + mid.id[i] * 0.70) * sstep(0.58, 0.26, mid.f1[i]);
      var s = sE * (0.35 + small.id[i] * 0.65);

      var h = 0.30 + (macro[i] - 0.5) * 0.12 + (med[i] - 0.5) * 0.05;
      var top = 0, id = 0;
      if (b * 0.40 >= m * 0.26 && b * 0.40 >= s * 0.13) { top = b * 0.40; id = big.id[i]; }
      else if (m * 0.26 >= s * 0.13) { top = m * 0.26; id = mid.id[i]; }
      else { top = s * 0.13; id = small.id[i]; }
      h += top + (fine[i] - 0.5) * 0.022;
      // rebar: thin bent bars standing proud of the pile
      var rb = sat((bar[i] - 0.80) * 5.5);
      h += rb * 0.05;
      S.h[i] = h;

      // --- albedo -------------------------------------------------------
      // Broken concrete is cement-pale on the fracture face and dirty grey on
      // the weathered original face; the odd fragment is brick or plaster.
      // Every fragment is then pulled hard toward the common dust tone - a
      // demolition pile is monochrome grey under a film of its own powder, and
      // fully saturated per-cell colours read as confetti.
      var c = id < 0.46 ? PAL.concrete : (id < 0.76 ? PAL.aggregate :
              (id < 0.90 ? PAL.plasterDk : PAL.brickC));
      S.cr[i] = c[0]; S.cg[i] = c[1]; S.cb[i] = c[2];
      tint(S, i, PAL.concreteDk, 0.40);
      shade(S, i, 0.84 + 0.18 * sat(top * 2.2) + (fine[i] - 0.5) * 0.16);
      // exposed aggregate stones in the fracture planes
      var st = sstep(0.22 + agg.id[i] * 0.12, 0.05, agg.f1[i]) * sat(top * 3.2);
      tint(S, i, agg.id[i] < 0.5 ? PAL.aggDark : PAL.aggregate, st * 0.40);
      // pulverised concrete dust packs the voids and films everything
      var voidM = sstep(0.20, 0.02, top);
      tint(S, i, PAL.grime, voidM * 0.46);
      tint(S, i, PAL.dirt, voidM * 0.34);
      tint(S, i, PAL.dust, sat((dustN[i] - 0.40) * 1.8) * sat(top * 2.4 + 0.30) * 0.46);
      tint(S, i, PAL.soot, sat((macro[i] - 0.68) * 3.2) * 0.26);
      tint(S, i, PAL.rust, rb * 0.85);
      tint(S, i, PAL.rustDeep, rb * rb * 0.40);

      // --- roughness ----------------------------------------------------
      // Coherent zones only: fresh fracture is chalk-matte, the weathered
      // original faces are smoother, and wet-packed dust in the voids smoother
      // again. Per-texel grit here would just alias into mip 1.
      var weather = sat((macro[i] - 0.44) * 2.2);
      var r = 0.92 - weather * 0.42 - st * 0.20;
      r += voidM * 0.06;
      r = lerp(r, 0.42, rb * 0.7);
      S.ro[i] = sat(r);
      S.me[i] = sat(rb * 0.30);
    }
  }

  // -- quarried limestone: kerbs, thresholds, block walls --------------------
  function genStone(g, S) {
    var n = g.n, i;
    var macro = g.fbm(g.buf(0), 3, 4, 0.62, 1, 11, false);
    // Pitched / bush-hammered face: parallel chisel banding, slightly wandering.
    var toolRaw = g.buf(0); g.fbmA(toolRaw, 4, 46, 3, 0.5, 1, 13, false);
    var tool = g.buf(0); g.shear(toolRaw, tool, 1);
    var med = g.fbm(g.buf(0), 17, 4, 0.5, 1, 17, false);
    var fine = g.fbm(g.buf(0), 140, 3, 0.5, 1, 19, false);
    var vug = g.worley(70, 1.0, 23);        // solution cavities
    var shell = g.worley(34, 0.95, 29);     // fossil / shell inclusions
    var crack = g.ridged(g.buf(0), 5, 5, 1, 31, true);
    var bed = g.buf(0); g.fbmA(bed, 3, 11, 3, 0.55, 1, 37, false);  // bedding planes
    var lich = g.fbm(g.buf(0), 9, 4, 0.55, 1, 41, false);
    var polish = g.fbm(g.buf(0), 7, 3, 0.55, 1, 43, false);
    var C = chromaFields(g, 2100);

    S.base(PAL.stone);
    for (i = 0; i < n; i++) {
      var ch = Math.abs(frac(tool[i] * 3.0) * 2 - 1);           // chisel ridges
      var vg = sstep(0.22, 0.03, vug.f1[i]);
      var sh = sstep(0.26 + shell.id[i] * 0.14, 0.06, shell.f1[i]);
      var ck = sstep(0.82, 0.995, crack[i]);
      var bd = sat((bed[i] - 0.58) * 2.6);

      var h = 0.62 + (macro[i] - 0.5) * 0.13 + (med[i] - 0.5) * 0.07 +
              (ch - 0.5) * 0.075 + (fine[i] - 0.5) * 0.025;
      h -= vg * 0.11 + ck * 0.09;
      h += sh * 0.030 - bd * 0.030;
      S.h[i] = h;

      // --- albedo -------------------------------------------------------
      tint(S, i, PAL.stoneLt, sat((h - 0.63) * 3.4) * 0.50);     // sun-bleached crowns
      tint(S, i, PAL.stoneDk, sstep(0.62, 0.46, h) * 0.46);
      tint(S, i, PAL.cement, sat((macro[i] - 0.56) * 2.0) * 0.26);
      tint(S, i, PAL.sandDk, sat((0.46 - macro[i]) * 2.2) * 0.24);
      tint(S, i, PAL.plasterHi, sh * 0.42);                      // pale shell fragments
      tint(S, i, PAL.grime, vg * 0.55 + ck * 0.48 + bd * 0.22);
      tint(S, i, PAL.dust, sat((fine[i] - 0.62) * 3.0) * 0.20);
      tint(S, i, PAL.moss, sat((lich[i] - 0.66) * 3.0) * sstep(0.62, 0.46, h) * 0.30);
      tint(S, i, PAL.efflor, sat((lich[i] - 0.20) * 1.4) * sat((h - 0.66) * 3.0) * 0.20);
      shade(S, i, 0.90 + 0.20 * med[i]);
      applyChroma(S, i, C, 1.15, sat(vg * 1.3 + ck * 1.2 + sstep(0.62, 0.46, h)),
                  { wash: 0.45 });

      // --- roughness ----------------------------------------------------
      // The whole point of a cut-stone surface is that the sawn/rubbed faces
      // are semi-matte and the weathered, chalked ones are not. Coherent
      // 10-40cm zones, authored across the full range so materials.js's
      // [0.55,0.94] window is actually used end to end.
      var rub = sat((polish[i] - 0.48) * 2.6);                   // sawn / footworn
      var chalk = sat((0.50 - polish[i]) * 2.6);
      var r = 0.55 + (med[i] - 0.5) * 0.24;
      r -= rub * 0.52;
      r += chalk * 0.44 + vg * 0.20 + bd * 0.12;
      S.ro[i] = sat(r);
      S.me[i] = 0;
    }
  }

  // -- moulded polypropylene: crates, jerrycans, shelter panels --------------
  function genPlastic(g, S) {
    var n = g.n, i;
    var macro = g.fbm(g.buf(0), 4, 4, 0.6, 1, 11, false);
    var mould = g.worley(130, 0.85, 13);                        // spark-eroded grain
    var flow = g.buf(0); g.fbmA(flow, 3, 110, 3, 0.5, 1, 17, false);  // flow lines
    var fine = g.fbm(g.buf(0), 220, 2, 0.5, 1, 19, false);
    var scrRaw = g.buf(0); g.fbmA(scrRaw, 300, 6, 3, 0.5, 1, 23, false);
    var scr = g.buf(0); g.shear(scrRaw, scr, 2);
    var chalkN = g.fbm(g.buf(0), 6, 4, 0.6, 1, 29, false);      // UV chalking
    var dirtN = g.fbm(g.buf(0), 9, 4, 0.6, 1, 31, false);
    var stress = g.ridged(g.buf(0), 22, 3, 1, 37, true);        // stress crazing

    S.base(PAL.plastic);
    for (i = 0; i < n; i++) {
      var gr = sstep(0.55, 0.15, mould.f1[i]);
      var sc = sat((scr[i] - 0.70) * 3.6);
      var cz = sstep(0.90, 0.998, stress[i]);
      var chalk = sat((chalkN[i] - 0.44) * 2.0);

      var h = 0.66 + (macro[i] - 0.5) * 0.045 + gr * 0.030 +
              (flow[i] - 0.5) * 0.020 + (fine[i] - 0.5) * 0.010;
      h -= sc * 0.012 + cz * 0.045;
      S.h[i] = h;

      // --- albedo -------------------------------------------------------
      shade(S, i, 0.86 + 0.28 * macro[i] + (flow[i] - 0.5) * 0.10);
      tint(S, i, PAL.plasticDk, sstep(0.62, 0.20, mould.f1[i]) * 0.22);
      // Sunlight bleaches polypropylene to a pale chalk and stress-whitens it
      // wherever it has been bent - that pale crazing is the read.
      tint(S, i, PAL.plasticLt, chalk * 0.48 + cz * 0.60 + sc * 0.34);
      tint(S, i, PAL.grime, sstep(0.66, 0.60, h) * 0.30 +
                            sat((dirtN[i] - 0.58) * 2.2) * 0.26);
      tint(S, i, PAL.dust, sat((dirtN[i] - 0.40) * 1.8) * 0.18);
      tint(S, i, PAL.soot, sat((macro[i] - 0.74) * 3.6) * 0.20);
      // UV chalking is a genuine loss of pigment, not just a lightening, and
      // the ground-in dirt in the mould grain is warm where the plastic is
      // cool. Two chroma populations on a moulded crate.
      desat(S, i, sat((chalkN[i] - 0.42) * 3.2) * 0.60 + cz * 0.35);
      tint(S, i, PAL.ironStain, sat((dirtN[i] - 0.58) * 2.8) * 0.30);
      tint(S, i, PAL.bioStain, sat((0.38 - dirtN[i]) * 2.8) * (0.3 + gr) * 0.26);

      // --- roughness ----------------------------------------------------
      // Semi-gloss where the mould skin is intact, dead matte where the sun
      // has chalked it. Full-range so the [0.18,0.60] window gets used.
      var r = 0.30 + (flow[i] - 0.5) * 0.18 + gr * 0.22;
      r += chalk * 0.62 + cz * 0.30;
      r -= sat((macro[i] - 0.58) * 2.4) * 0.26;                 // handled / rubbed
      r += sat((dirtN[i] - 0.62) * 2.4) * 0.20;
      S.ro[i] = sat(r);
      S.me[i] = 0;
    }
  }

  // -- militia uniform ripstop: plain weave + reinforcement grid -------------
  // Shared by cloth_olive and cloth_tan; the two differ in dye lot and thread
  // pitch so a chest rig over a shirt never reads as one continuous surface.
  function genRipstop(g, S, colA, colB, pitch, rip, salt) {
    var n = g.n, size = g.size, i, x, y;
    var threads = size >= 512 ? pitch : (pitch >> 1);
    var macro = g.fbm(g.buf(0), 4, 4, 0.6, 1, salt + 1, false);
    var wobX = g.buf(0); g.fbmA(wobX, 34, 5, 3, 0.5, 1, salt + 3, true);
    var wobY = g.buf(0); g.fbmA(wobY, 5, 34, 3, 0.5, 1, salt + 5, true);
    var fade = g.fbm(g.buf(0), 6, 4, 0.6, 1, salt + 7, false);
    var dirtN = g.fbm(g.buf(0), 8, 4, 0.6, 1, salt + 11, false);
    var fuzz = g.fbm(g.buf(0), 190, 2, 0.5, 1, salt + 13, false);
    var wearN = g.fbm(g.buf(0), 11, 4, 0.55, 1, salt + 17, false);
    var creaseRaw = g.buf(0); g.fbmA(creaseRaw, 40, 7, 3, 0.5, 1, salt + 19, false);
    var crease = g.buf(0); g.shear(creaseRaw, crease, 1);
    var C = chromaFields(g, salt + 23);
    // Machine-woven uniform cloth is the tightest weave in the level, so the
    // tolerances are the smallest - but they are not zero, and zero is what
    // turns a uniform into a sheet of graph paper.
    var TLx = threadLayout(g, threads, salt + 501, { wMin: 0.80, wMax: 1.22, slub: 0.020, floatEvery: 26 });
    var TLy = threadLayout(g, threads, salt + 509, { wMin: 0.82, wMax: 1.20, slub: 0.014, floatEvery: 31 });

    for (y = 0; y < size; y++) {
      var o = y * size;
      for (x = 0; x < size; x++) {
        i = o + x;
        threadAt(TLx, (x / size) * threads + wobX[i] * 0.45);
        var ix = _thIdx, fxv = _thF;
        threadAt(TLy, (y / size) * threads + wobY[i] * 0.45);
        var iy = _thIdx, fyv = _thF;
        var warp = sat(Math.sin(Math.PI * fxv) / TLx.crown[ix]);
        var weft = sat(Math.sin(Math.PI * fyv) / TLy.crown[iy]);
        var flo = TLx.flt[ix];
        var over = flo > 0 ? true : (((ix + iy) & 1) === 0);
        var top = over ? warp : weft, bot = over ? weft : warp;
        // Ripstop: every `rip`th yarn is doubled, giving the shallow raised
        // lattice. Kept as relief with almost no albedo delta - pushing colour
        // into it turns a uniform into a tablecloth.
        var gridX = (((ix % rip) + rip) % rip) === 0 ? 1 : 0;
        var gridY = (((iy % rip) + rip) % rip) === 0 ? 1 : 0;
        var grid = Math.max(gridX * warp, gridY * weft);

        var h = 0.50 + top * 0.24 + bot * 0.070 + grid * 0.10 + flo * warp * 0.04;
        h += (macro[i] - 0.5) * 0.18 + (fuzz[i] - 0.5) * 0.025;   // drape and folds
        h -= sat((crease[i] - 0.74) * 4.0) * 0.06;                // set-in creases
        S.h[i] = h;

        // --- albedo ----------------------------------------------------
        // One dye lot with a gentle drift. A wide swing between the two tones
        // reads as camouflage blotching, which is not what a plain utility
        // uniform is.
        var lot = 0.16 + sstep(0.30, 0.74, macro[i]) * 0.52;
        S.cr[i] = lerp(colA[0], colB[0], lot);
        S.cg[i] = lerp(colA[1], colB[1], lot);
        S.cb[i] = lerp(colA[2], colB[2], lot);
        // Same mean, a seventh of the contrast - see genFabric.
        shade(S, i, 1.050 + 0.055 * top + 0.015 * bot + grid * 0.03);
        shade(S, i, 1 + ((over ? TLx.dye[ix] : TLy.dye[iy]) - 1) * 0.55);
        // sun fade on the exposed crowns, sweat salt and ground-in dust
        var bleach = sat((fade[i] - 0.42) * 1.9);
        tint(S, i, PAL.dust, bleach * 0.36 * (0.45 + 0.75 * top));
        var wear = sat((wearN[i] - 0.52) * 2.4) * sat((h - 0.60) * 3.0);
        tint(S, i, PAL.dust, wear * 0.34);
        tint(S, i, PAL.grime, sstep(0.52, 0.34, h) * 0.32 +
                              sat((dirtN[i] - 0.56) * 2.2) * 0.30);
        tint(S, i, PAL.dirtDk, sat((dirtN[i] - 0.76) * 3.4) * 0.26);
        shade(S, i, 0.94 + 0.14 * fuzz[i]);
        // Field uniform: the shoulders and the tops of the thighs are bleached
        // most of the way to neutral, the panels under the rig still hold the
        // dye, and everything that touches the ground picks up an iron-red
        // ground stain. Chroma variance is most of what stops a militia in
        // olive drab reading as one flat clay mannequin.
        desat(S, i, bleach * 0.55 + wear * 0.30);
        applyChroma(S, i, C, 1.05, sat(sstep(0.52, 0.34, h) * 1.4),
                    { iron: 1.1, wash: 0.50 });

        // --- roughness --------------------------------------------------
        // Coherent: dusty, sun-rotted panels are near 1.0; the areas a chest
        // rig has polished flat sit well down the curve.
        var r = 0.92 + bleach * 0.10;
        r -= sat((wearN[i] - 0.38) * 2.2) * 0.50;   // rig- and pack-polished panels
        r -= wear * 0.25 + top * 0.16 + grid * 0.04;
        r += (1 - top) * 0.05;
        r += sat((dirtN[i] - 0.62) * 2.4) * 0.10;
        S.ro[i] = sat(r);
        S.me[i] = 0;
      }
    }
  }

  function genClothOlive(g, S) {
    genRipstop(g, S, PAL.oliveDrab, PAL.oliveLt, 68, 8, 100);
  }
  function genClothTan(g, S) {
    genRipstop(g, S, PAL.tanCloth, PAL.tanLt, 56, 7, 300);
  }

  // -- tiling micro-surface normal overlay ----------------------------------
  // Deliberately tiny in amplitude and high in frequency: materials.js blends
  // this on at ~20x the macro UV rate so surfaces keep breaking up specular
  // even when the camera is 20cm away.
  function genDetailNormal(g, S) {
    var n = g.n, i;
    // Frequencies stay well clear of Nyquist: this map is meant to survive the
    // low-pass in _emit and still read as micro-relief, not as noise.
    var a = g.fbm(g.buf(0), 12, 3, 0.55, 1, 11, false);
    var b = g.fbm(g.buf(0), 34, 2, 0.5, 1, 13, false);
    var c = g.worley(26, 1.0, 17);
    var scrRaw = g.buf(0); g.fbmA(scrRaw, 60, 4, 3, 0.5, 1, 19, false);
    var scr = g.buf(0); g.shear(scrRaw, scr, 2);
    var scrRaw2 = g.buf(0); g.fbmA(scrRaw2, 4, 56, 3, 0.5, 1, 23, false);

    for (i = 0; i < n; i++) {
      var h = 0.5 + (a[i] - 0.5) * 0.55 + (b[i] - 0.5) * 0.30;
      h += sstep(0.30, 0.05, c.f1[i]) * 0.10;
      h -= sat((scr[i] - 0.72) * 3.6) * 0.16;
      h -= sat((scrRaw2[i] - 0.74) * 3.6) * 0.10;
      S.h[i] = h;
      S.cr[i] = 0.5; S.cg[i] = 0.5; S.cb[i] = 0.5;
      S.ro[i] = 0.5; S.me[i] = 0;
    }
  }

  // ==========================================================================
  // ===================  LEVEL 2 - "COLD HARBOR" RECIPES  ====================
  //
  // A container terminal at 02:00 in driving rain. Everything below is
  // ADDITIVE - no level 1 recipe, palette entry or dial is touched - but the
  // authoring priorities are different enough to be worth stating:
  //
  //  * ALBEDO IS DARK. The frame's value comes from specular off wet surfaces
  //    lit by sodium masts, not from diffuse. A "sensible" mid-grey albedo
  //    reads as milk under those lamps.
  //
  //  * ROUGHNESS IS THE MATERIAL. Wet is the whole look, and wet is a
  //    roughness story: a puddle is 0.03, the damp slab round it is 0.25, the
  //    strip sheltered under a container is 0.7. Every map here has to span a
  //    real range SPATIALLY - a constant roughness map in this level is not a
  //    flat-looking surface, it is an invisible one.
  //
  //  * RUST WEEPS DOWN. Salt air plus rain plus mild steel: every chip, weld,
  //    fixing and cut edge bleeds oxide downward (Gen.drip with down = true;
  //    the row index increases downward, which is the convention level 1's
  //    runoff already established).
  //
  //  * GRIME LOW, WEAR HIGH. Same rule as level 1: the height field decides.
  //    Paint fails on the corrugation crests that scrape past the next box in
  //    the stack; black harbour dirt collects in the troughs it never reaches.
  // ==========================================================================

  // -- shipping-container flank: paint over primer over steel ----------------
  //
  // One recipe, four liveries.
  //
  // THIS MAP CARRIES NO CORRUGATION, AND THAT IS THE POINT. level_harbor.js
  // folds the real thing into the mesh - corrugationLoop(wallLen, 0.298, 0.038)
  // - a true trapezoidal profile with a real silhouette at the real 298 mm
  // pitch. This tile used to paint a SECOND trapezoid on top of it, 8 ribs per
  // tile, which lands at ~134 mm once SURF.container_*.uv (0.62) and the
  // material repeat (1.5) are applied. Two rib sets at a 2.2:1 frequency ratio
  // on one surface, one geometric and one in the normal map, with the texture's
  // phase re-randomised at every stochastic-tiling cell boundary: they beat,
  // and a stack of boxes photographs as a picket fence of lit bars and black
  // slots. Measured, on an A/B pair of the `containers` framing captured in the
  // same second with only this file differing - column-profile FFT over the red
  // flank, texture rib band (11-19 px) 1.660 -> 0.191, a 6x collapse, while the
  // geometric fold band (26-40 px) went 0.683 -> 1.105 because it is no longer
  // being swamped. p95/p05 luminance across that flank 3.27 -> 2.27, and across
  // the whole red stack on the quay framing 8.6:1 -> 2.2:1. A real corrugated
  // flank under a raking lamp is 2-4:1.
  // Relief at the rib pitch belongs to the mesh, and only to the mesh.
  //
  // What replaces it is what a container flank actually carries BETWEEN the
  // folds: weld ripple and oil-canning across the sheet, hammer dents, mill
  // scale, and a vertical wash grain from thirty years of rain running down it.
  // Every one of those bands is broadband, so nothing in this map has a
  // frequency for the mesh to beat against. Crest / valley / web survive only
  // as WEATHERING masks, read off that aperiodic relief instead of off a rib
  // lattice - chalk and scrapes on the high ground, black harbour grime in the
  // hollows, oxide weeping out of both.
  //
  // The layer stack is the physical one: mild steel, red-oxide primer, enamel
  // livery, and on maybe a fifth of the boxes a rolled-on repaint patch. Chips
  // cut down through it in that order, and oxide blooms out of every chip.
  function genContainerPanel(g, S, o) {
    var n = g.n, size = g.size, i, x, y;
    var salt = o.salt | 0;
    var macro   = g.fbm(g.buf(0), 3, 4, 0.62, 1, salt + 11, false);
    var dent    = g.fbm(g.buf(0), 6, 4, 0.58, 1, salt + 13, false);
    var med     = g.fbm(g.buf(0), 26, 4, 0.5, 1, salt + 17, false);
    var fine    = g.fbm(g.buf(0), 170, 3, 0.5, 1, salt + 19, false);
    // Oil-canning: the shallow panting of a thin sheet between its stiffeners,
    // and the single most characteristic mesoscale feature of container steel.
    // With the trapezoid gone this is the map's biggest COHERENT gradient, and
    // coherence is the point. Dumping the old map showed why: the corrugation
    // took essentially the whole gradient budget and left the rest of the tile
    // flat lavender, so at night the only thing on a container that caught a
    // raking sodium lamp was a rib. Delete the rib and put the budget into
    // broadband hash and the flank goes BLACK, because incoherent slopes
    // average away inside one pixel footprint and mip to a flat normal. So the
    // replacement has to be coherent over tens of texels the way a rib was -
    // it just must not be periodic.
    var ripple  = g.buf(0); g.fbmA(ripple, 13, 9, 3, 0.55, 1, salt + 51, false);
    // Creases and welts: a box that has been dropped, racked and re-stacked.
    // Ridged noise gives thin, steep, coherent lines - the same local slope a
    // corrugation web had, scattered instead of ruled.
    var crease  = g.ridged(g.buf(0), 4, 4, 1, salt + 59, true);
    // Vertical wash grain: anisotropic so the flank keeps the up-down grain a
    // corrugated box has, BROADBAND so it never lines up with the mesh ribs.
    var grain   = g.buf(0); g.fbmA(grain, 34, 5, 4, 0.55, 1, salt + 53, false);
    // Tone lottery. Was per-rib, which is exactly what drew the fence; now it
    // is per-patch, which is how a flank of one continuous sheet actually
    // weathers - in blotches, not in stripes.
    var patch   = g.fbm(g.buf(0), 9, 2, 0.55, 1, salt + 57, false);
    var chipN   = g.fbm(g.buf(0), 11, 5, 0.55, 1, salt + 23, false);
    var chipC   = g.worley(64, 1.0, salt + 29);     // chip outlines, not blobs
    var rustN   = g.fbm(g.buf(0), 8, 5, 0.55, 1, salt + 31, false);
    var pit     = g.worley(120, 1.0, salt + 37);
    var repaint = g.worley(5, 0.85, salt + 41);
    var streakN = g.buf(0); g.fbmA(streakN, 130, 8, 4, 0.5, 1, salt + 43, false);
    var scrRaw  = g.buf(0); g.fbmA(scrRaw, 260, 6, 3, 0.5, 1, salt + 47, false);
    var scr     = g.buf(0); g.shear(scrRaw, scr, 1);
    var C = chromaFields(g, salt + 300);
    var seedM = g.buf(0), weep = g.buf(0);
    for (i = 0; i < n; i++) seedM[i] = sstep(0.72, 0.88, chipN[i]);
    g.drip(seedM, weep, 0.9925, true);

    // The mesoscale relief, and the proudness mask derived from it. The
    // thresholds are SOLVED from the field's own mean and spread rather than
    // hard-coded, the same argument _emit makes for AO and bump: the band is a
    // sum of five noise fields, one of them a ridged multifractal with a DC of
    // its own, so its variance is not something to guess at - and a mask that
    // misses it lands as either a flat panel or a two-tone one.
    var relief = g.buf(0);
    for (i = 0; i < n; i++) {
      relief[i] = (ripple[i] - 0.5) * 0.105 + crease[i] * 0.060 +
                  (grain[i] - 0.5) * 0.045 + (dent[i] - 0.5) * 0.075 +
                  (med[i] - 0.5) * 0.024;
    }
    var rMean = 0, rVar = 0, rCnt = 0, rd;
    for (i = 0; i < n; i += 3) { rMean += relief[i]; rCnt++; }
    rMean /= (rCnt || 1);
    for (i = 0; i < n; i += 3) { rd = relief[i] - rMean; rVar += rd * rd; }
    var rSd = Math.sqrt(rVar / (rCnt || 1)) || 1e-4;
    // +-1.3 sigma rather than +-1: a tighter window drives the mask hard to 0
    // or 1 over most of the tile and the weathering that keys off it comes out
    // as two-tone camouflage instead of as a continuous wash. The livery has to
    // survive - ART_DIRECTION asks for faded red, blue and green, not brown.
    var rE0 = rMean - rSd * 1.30, rE1 = rMean + rSd * 1.30;

    S.base(o.col);
    for (y = 0; y < size; y++) {
      var rowo = y * size;
      for (x = 0; x < size; x++) {
        i = rowo + x;
        // ---- relief and the proudness masks -------------------------------
        // 1 on the high ground the rain washes and the next box in the stack
        // scrapes past, 0 in the hollows harbour dirt settles into.
        var crest = sstep(rE0, rE1, relief[i]);
        var valley = 1 - crest;
        var web = 4 * crest * valley;               // the transition band
        var rib = sat((patch[i] - 0.5) * 1.7 + 0.5);
        var expo = sat(0.32 + 0.88 * crest * (0.55 + 0.85 * rib));
        // rMean is subtracted so the band stays centred on 0.50 whatever DC the
        // ridged crease field happens to carry.
        var h = 0.50 + (relief[i] - rMean) + (fine[i] - 0.5) * 0.010;

        // ---- paint failure ------------------------------------------------
        // Wear where the height is high: enamel goes first on whatever stands
        // proud and takes the knocks, and survives longest in the hollows.
        var chip = sstep(0.60, 0.76, chipN[i] * 0.72 + med[i] * 0.28);
        chip = sat(chip + sstep(0.15, 0.02, chipC.f2[i] - chipC.f1[i]) * chip * 0.9);
        chip *= expo;
        var deep = sstep(0.74, 0.90, chipN[i]) * expo * 0.92;
        var run = weep[i] * sstep(0.30, 0.66, streakN[i]);
        // ...and oxide blooms out of every one of them, then runs down.
        // Oxide follows its own field first and the relief second. When it was
        // 0.28 + 0.75 * valley it tracked the proudness mask almost exactly,
        // and once that mask stopped being the rib lattice it started reading
        // as blotch camouflage.
        var rustM = sat(deep * 1.10 + chip * 0.32 +
                        sstep(0.60, 0.84, rustN[i]) * (0.36 + valley * 0.52) +
                        run * 0.80);
        var pt = sstep(0.22, 0.02, pit.f1[i]) * rustM;
        var sc = sat((scr[i] - 0.74) * 3.8) * expo;
        // A repaint patch: rolled on over the top at some point in the box's
        // life, so it is a shade off, glossier, and much less chalked.
        var rp = sstep(0.80, 0.90, repaint.id[i]) * sstep(0.55, 0.28, repaint.f1[i]);
        h += rustM * 0.016 - pt * 0.030 - chip * 0.006 - sc * 0.008 + rp * 0.006;
        S.h[i] = h;

        // ---- albedo -------------------------------------------------------
        shade(S, i, (0.82 + 0.34 * macro[i]) * (0.93 + 0.14 * rib));
        var chalk = sat((macro[i] - 0.42) * 2.0) * expo;
        tint(S, i, o.fade, chalk * 0.55 * (1 - rp * 0.8));
        desat(S, i, chalk * 0.30 * (1 - rp * 0.8));
        // High ground and hollow are the SAME PAINT - the tonal difference is
        // shading and dirt, not a second colour.
        tint(S, i, o.dark, valley * 0.095 + web * 0.045);
        tint(S, i, o.col, rp * 0.55);
        // paint -> primer -> bare steel: three genuinely different materials,
        // each a step in value, not a shade of the one above it.
        tint(S, i, PAL.primer, chip * 0.85);
        tint(S, i, PAL.steelDark, deep * 0.75);
        shade(S, i, 1 - chip * 0.14 - deep * 0.20);
        // Iron oxide as a VALUE RANGE: near-black pitting, dark scale over the
        // body, a pale bloom only on the crowns. `crest` is the normalised
        // proudness, so it is the honest "is this the high ground" term now
        // that the height field no longer swings 0.30 across a rib.
        var hi = sat(crest * 1.35 - pt * 0.5);
        tint(S, i, PAL.rust, rustM * 0.90);
        tint(S, i, PAL.rustMid, rustM * sat(hi * 1.2) * 0.45);
        tint(S, i, PAL.rustLt, rustM * hi * hi * 0.50);
        tint(S, i, PAL.rustDeep, rustM * rustM * valley * 0.45 + run * run * 0.35);
        tint(S, i, PAL.rustPit, pt * 0.75);
        shade(S, i, 1 - pt * pt * 0.35);
        // Salt bloom on the washed high ground, black harbour grime in the
        // hollows. Both used to key off raw h thresholds, which only worked
        // because the trapezoid was swinging h by 0.30; against the real relief
        // band they would return almost nothing, so they key off the normalised
        // proudness and keep the weathering range they were authored for.
        tint(S, i, PAL.efflor, sat((fine[i] - 0.62) * 3.0) * crest * 0.16);
        tint(S, i, PAL.grime, valley * 0.19 + valley * valley * 0.12);
        tint(S, i, PAL.soot, valley * valley * 0.11);
        tint(S, i, PAL.steelDk, sc * 0.40);
        applyChroma(S, i, C, 0.9, sat(run * 1.4 + valley * 0.8 + pt),
                    { iron: 1.15, bloom: 0.7, bio: 0.8, wash: 0.42 });

        // ---- roughness / metalness ----------------------------------------
        // Enamel keeps a semi-gloss where the rain washes it and the sun never
        // reaches; it chalks to matte everywhere else; oxide is matte outright.
        // That spread is what makes a stack of boxes read under a sodium lamp.
        var r = 0.46 + (med[i] - 0.5) * 0.20;
        r += chalk * 0.42;
        r -= rp * 0.18;
        r = lerp(r, 0.94, rustM);
        r = lerp(r, 0.58, deep * 0.7);
        r -= sc * 0.16;
        r += pt * 0.05 + valley * 0.05;
        S.ro[i] = sat(r);
        // Paint and oxide are dielectrics. Only the fresh scrapes and the
        // deepest chips reach live metal.
        S.me[i] = sat(deep * 0.55 + sc * 0.55 - rustM * 1.2);
      }
    }
    // Handling damage: a straddle carrier and forty years of being stacked.
    // Turned up hard, because a dent is a COHERENT bowl with a steep rim and
    // that is exactly the kind of feature the corrugation used to be the only
    // supplier of. Five per tile was a garnish; a working box is covered in
    // them.
    punchCraters(g, S, { count: 13, rMin: 0.018, rMax: 0.072, depth: 0.050,
                         rough: 0.72, col: PAL.grime, tint: 0.12, halo: 1.4 });
    punchScrapes(g, S, { count: 18, lenMin: 0.03, lenMax: 0.16, width: 0.0016,
                         depth: 0.012, rough: 0.42, col: PAL.steelDk, tint: 0.45,
                         metal: 0.70, hbias: 0.80, hRef: 0.60 });
  }

  function genContainerSteel(g, S) {
    genContainerPanel(g, S, { col: HPAL.ctnGrey, fade: HPAL.ctnGreyFade,
                              dark: HPAL.ctnGreyDk, salt: 100 });
  }
  function genContainerRed(g, S) {
    genContainerPanel(g, S, { col: HPAL.ctnRed, fade: HPAL.ctnRedFade,
                              dark: HPAL.ctnRedDk, salt: 400 });
  }
  function genContainerBlue(g, S) {
    genContainerPanel(g, S, { col: HPAL.ctnBlue, fade: HPAL.ctnBlueFade,
                              dark: HPAL.ctnBlueDk, salt: 700 });
  }
  function genContainerGreen(g, S) {
    genContainerPanel(g, S, { col: HPAL.ctnGreen, fade: HPAL.ctnGreenFade,
                              dark: HPAL.ctnGreenDk, salt: 1000 });
  }

  // -- freighter hull: welded plate, boot topping, waterline growth ----------
  //
  // The tile is authored for a hull mapped with repeat [n, 1]: X tiles freely
  // along the ship, Y runs once from the deck edge down to the waterline, so
  // the horizontal paint bands land where they belong. It still tiles in Y if
  // a consumer insists - ships genuinely do carry more than one horizontal
  // band - but the boot topping is meant to be a single line.
  function genShipHull(g, S) {
    var n = g.n, size = g.size, i, x, y;
    var platesY = 4, platesX = 3;
    var macro   = g.fbm(g.buf(0), 3, 4, 0.6, 1, 11, false);
    var med     = g.fbm(g.buf(0), 22, 4, 0.5, 1, 13, false);
    var fine    = g.fbm(g.buf(0), 150, 3, 0.5, 1, 17, false);
    var dishN   = g.fbm(g.buf(0), 7, 3, 0.55, 1, 19, false);
    var rustN   = g.fbm(g.buf(0), 6, 5, 0.55, 1, 23, false);
    var pit     = g.worley(110, 1.0, 29);
    var beadN   = g.buf(0); g.fbmA(beadN, 120, 5, 3, 0.5, 1, 31, false);
    var seamJ   = g.buf(0); g.fbmA(seamJ, 9, 3, 3, 0.5, 1, 37, false);
    var streakN = g.buf(0); g.fbmA(streakN, 120, 7, 4, 0.5, 1, 41, false);
    var barn    = g.worley(90, 1.0, 43);
    var weedN   = g.buf(0); g.fbmA(weedN, 40, 9, 3, 0.5, 1, 47, false);
    var chalkN  = g.fbm(g.buf(0), 8, 3, 0.55, 1, 53, false);
    var C = chromaFields(g, 1700);

    // Rust seeds on the blotches AND along every weld, which is where a hull
    // actually bleeds - the heat-affected zone loses its coating first.
    var seedM = g.buf(0), weep = g.buf(0);
    for (y = 0; y < size; y++) {
      var so = y * size;
      var spy = (y / size) * platesY;
      var spf = spy - Math.floor(spy);
      for (x = 0; x < size; x++) {
        i = so + x;
        var sh = sstep(0.028, 0.0, Math.min(spf, 1 - spf) + (seamJ[i] - 0.5) * 0.010);
        seedM[i] = Math.max(sstep(0.62, 0.82, rustN[i]),
                            sh * sstep(0.45, 0.80, rustN[i]) * 0.9);
      }
    }
    g.drip(seedM, weep, 0.9945, true);

    S.base(HPAL.hullTop);
    for (y = 0; y < size; y++) {
      var rowo = y * size;
      var vv = y / size;                              // 0 at the deck, 1 at the keel
      var py = vv * platesY;
      var ri = Math.floor(py), pf = py - ri;
      var stagger = hash2i(ri, 0, 3) * 0.7;
      // Paint bands. Topsides -> boot topping -> waterline -> antifouling.
      var boot = sstep(0.60, 0.645, vv) * sstep(0.775, 0.735, vv);
      var below = sstep(0.755, 0.80, vv);
      var wline = sstep(0.66, 0.74, vv) * sstep(0.95, 0.86, vv);
      for (x = 0; x < size; x++) {
        i = rowo + x;
        // ---- plate seams and weld beads -----------------------------------
        var seamH = sstep(0.028, 0.0, Math.min(pf, 1 - pf) + (seamJ[i] - 0.5) * 0.010);
        var px = (x / size) * platesX + stagger;
        var cf = px - Math.floor(px);
        var seamV = sstep(0.024, 0.0, Math.min(cf, 1 - cf) + (seamJ[i] - 0.5) * 0.008) *
                    (1 - seamH * 0.9);
        // A weld bead is a rippled sausage of proud metal, not a scribed line.
        var bead = (seamH + seamV) * (0.55 + 0.45 * beadN[i]);
        // Plates dish very slightly between the frames behind them - the
        // "hungry horse" panting that makes a big hull read as sheet steel.
        var dish = Math.sin(Math.PI * pf) * (0.35 + dishN[i] * 0.65);
        var h = 0.58 + (macro[i] - 0.5) * 0.07 + (med[i] - 0.5) * 0.030 +
                (fine[i] - 0.5) * 0.012 - dish * 0.030 + bead * 0.045;

        var rustM = sat(sstep(0.58, 0.84, rustN[i]) +
                        weep[i] * sstep(0.30, 0.68, streakN[i]) * 0.95 +
                        bead * sstep(0.40, 0.72, rustN[i]) * 0.8);
        var pt = sstep(0.20, 0.02, pit.f1[i]) * rustM;
        h += rustM * 0.020 - pt * 0.035;
        // Barnacles and weed, clustered at the waterline.
        // Barnacles grow in COLONIES, not as an even rash of white dots: the
        // id threshold picks which cells are settled and the weed field decides
        // where the settlement is dense enough to matter.
        var bn = sstep(0.26, 0.05, barn.f1[i]) * wline *
                 sstep(0.55, 0.80, barn.id[i]) * sstep(0.34, 0.58, weedN[i]);
        var wd = sat((weedN[i] - 0.52) * 2.4) * wline;
        h += bn * 0.075;
        S.h[i] = h;

        // ---- albedo -------------------------------------------------------
        shade(S, i, 0.84 + 0.30 * macro[i]);
        tint(S, i, HPAL.hullTopLt, sat((macro[i] - 0.56) * 2.2) * 0.26);
        // Chalked topside enamel: patchy, and it never fades evenly.
        var chalk = sat((chalkN[i] - 0.44) * 2.0);
        tint(S, i, PAL.efflor, chalk * 0.22);
        desat(S, i, chalk * 0.32);
        tint(S, i, HPAL.hullBoot, boot * 0.90);
        tint(S, i, HPAL.antifoul, below * 0.85);
        // the scum line itself: a greasy, algal tidemark
        tint(S, i, HPAL.scum, wline * (0.30 + wd * 0.55));
        tint(S, i, HPAL.weed, wd * 0.60);
        tint(S, i, HPAL.barnacle, bn * 0.55);
        desat(S, i, bn * 0.30);
        shade(S, i, 1 + bn * 0.06 - wd * 0.22);
        // welds are a different alloy and they never take paint properly
        tint(S, i, PAL.steelDk, bead * 0.30);
        // heavy rust runs
        var hi = sat((h - 0.585) * 7.0);
        tint(S, i, PAL.rust, rustM * 0.92);
        tint(S, i, PAL.rustMid, rustM * hi * 0.50);
        tint(S, i, PAL.rustLt, rustM * hi * hi * 0.45);
        tint(S, i, PAL.rustDeep, rustM * rustM * 0.50);
        tint(S, i, PAL.rustPit, pt * 0.80);
        shade(S, i, 1 - pt * pt * 0.36 - seamH * 0.10 - seamV * 0.08);
        tint(S, i, PAL.grime, sstep(0.57, 0.42, h) * 0.34);
        tint(S, i, PAL.soot, sstep(0.46, 0.34, h) * 0.20);
        applyChroma(S, i, C, 0.85, sat(weep[i] * 1.2 + wline + pt),
                    { iron: 1.2, bio: 1.2, wash: 0.34 });

        // ---- roughness / metalness ----------------------------------------
        var r = 0.50 + (med[i] - 0.5) * 0.18 + chalk * 0.30;
        r = lerp(r, 0.38, boot * 0.85);          // bitumen boot topping stays glossy
        r = lerp(r, 0.66, below * 0.8);          // antifouling is a flat, chalky coat
        r = lerp(r, 0.88, sat(bn + wd * 0.7));   // growth is matte and fibrous
        r = lerp(r, 0.95, rustM);
        r += bead * 0.10 + pt * 0.05;
        S.ro[i] = sat(r);
        S.me[i] = sat(0.30 - rustM * 1.2 - below * 0.35 - bn);
      }
    }
    // Impact scars along the belting where the tugs and the quay have been.
    punchCraters(g, S, { count: 4, rMin: 0.020, rMax: 0.050, depth: 0.05,
                         rough: 0.80, col: PAL.steelDk, tint: 0.30, halo: 1.5 });
    punchScrapes(g, S, { count: 12, lenMin: 0.06, lenMax: 0.26, width: 0.0022,
                         depth: 0.014, rough: 0.55, col: PAL.rust, tint: 0.45,
                         metal: 0.25, hbias: 0.5, hRef: 0.60 });
  }

  // -- dock apron slab, dry and wet ------------------------------------------
  //
  // One recipe, two materials. The dry side is the honest one: cool grey
  // concrete, exposed aggregate in the wheel paths, sealed expansion joints,
  // tyre scuffing, diesel and a crack network. The wet side runs the same slab
  // and then floods it - and flooding is not a tint, it is a SECOND SURFACE:
  // where the slab dips below the local water table the relief disappears
  // under a flat mirror and the roughness collapses to 0.03. The strips that
  // stay sheltered (under a container, inside a roller door) stay dry and
  // chalky, which is the only thing that stops the apron reading as one
  // enormous mirror.
  function dockSlab(g, S, o) {
    var n = g.n, size = g.size, i, x, y;
    var salt = o.salt | 0;
    var WET = o.wet || 0;
    var macro  = g.fbm(g.buf(0), 3, 4, 0.6, 1, salt + 11, false);
    var med    = g.fbm(g.buf(0), 15, 4, 0.5, 1, salt + 13, false);
    var fine   = g.fbm(g.buf(0), 95, 3, 0.5, 1, salt + 17, false);
    var grit   = g.fbm(g.buf(0), 260, 2, 0.5, 1, salt + 19, false);
    var agg    = g.worley(46, 0.95, salt + 23);
    var pit    = g.worley(140, 1.0, salt + 29);
    var crack  = g.ridged(g.buf(0), 5, 5, 1, salt + 31, true);
    var crack2 = g.ridged(g.buf(0), 17, 4, 1, salt + 37, true);
    var oilN   = g.fbm(g.buf(0), 6, 4, 0.6, 1, salt + 41, false);
    var wearN  = g.fbm(g.buf(0), 4, 3, 0.55, 1, salt + 43, false);
    var scuff  = g.buf(0); g.fbmA(scuff, 26, 4, 3, 0.5, 1, salt + 47, false);
    var jitJ   = g.buf(0); g.fbmA(jitJ, 5, 3, 2, 0.5, 1, salt + 53, false);
    var C = chromaFields(g, salt + 600);
    // Water fields, only paid for when there is water.
    var puddleA = null, puddleB = null, ripple = null, shelter = null;
    if (WET > 0) {
      puddleA = g.fbm(g.buf(0), 3, 3, 0.55, 1, salt + 61, false);
      puddleB = g.fbm(g.buf(0), 9, 3, 0.55, 1, salt + 67, false);
      ripple  = g.fbm(g.buf(0), 120, 3, 0.5, 1, salt + 71, false);
      shelter = g.fbm(g.buf(0), 5, 3, 0.55, 1, salt + 73, false);
    }
    var slabs = 2;

    S.base(HPAL.dockGrey);
    for (y = 0; y < size; y++) {
      var rowo = y * size;
      var jy = (y / size) * slabs;
      var jyf = jy - Math.floor(jy);
      for (x = 0; x < size; x++) {
        i = rowo + x;
        var jx = (x / size) * slabs;
        var jxf = jx - Math.floor(jx);
        var jointY = sstep(0.018, 0.0, Math.min(jyf, 1 - jyf) + (jitJ[i] - 0.5) * 0.012);
        var jointX = sstep(0.016, 0.0, Math.min(jxf, 1 - jxf) + (jitJ[i] - 0.5) * 0.010);
        var joint = sat(jointX + jointY);

        var mc = macro[i], md = med[i];
        var h = 0.62 + (mc - 0.5) * 0.10 + (md - 0.5) * 0.09 +
                (fine[i] - 0.5) * 0.045 + (grit[i] - 0.5) * 0.016;
        var traffic = sstep(0.35, 0.72, wearN[i] * 0.6 + mc * 0.4);
        var stone = sstep(0.48, 0.12, agg.f1[i]);
        h += stone * traffic * 0.10;                   // laitance worn off the tops
        var hole = sstep(0.24, 0.04, pit.f1[i]) * sstep(0.32, 0.58, md);
        h -= hole * 0.20;
        var ck = sat(sstep(0.83, 0.995, crack[i]) + sstep(0.90, 0.999, crack2[i]) * 0.6);
        h -= ck * 0.16 + joint * 0.085;
        S.h[i] = h;

        // ---- albedo -------------------------------------------------------
        var id = agg.id[i];
        tint(S, i, id < 0.34 ? HPAL.aggCoolDk : (id < 0.72 ? HPAL.aggCool : HPAL.aggCoolLt),
             stone * (0.24 + traffic * 0.55));
        shade(S, i, 0.86 + 0.28 * md);
        tint(S, i, HPAL.dockLt, sat((mc - 0.52) * 1.9) * 0.22);
        tint(S, i, HPAL.dockDk, sat((0.48 - mc) * 1.9) * 0.24);
        var low = sstep(0.62, 0.40, h);
        // Harbour dirt is not desert dust. PAL.grime alone is a warm brown and
        // it dragged the whole apron toward the market's beige; the damp-grey
        // axis is what keeps a northern dock cold.
        tint(S, i, PAL.grime, low * 0.30 + ck * 0.45 + hole * 0.38);
        tint(S, i, PAL.dampGrey, low * 0.22 + ck * 0.20);
        tint(S, i, PAL.soot, ck * ck * 0.35 + hole * hole * 0.30);
        shade(S, i, 1 - ck * ck * 0.28 - hole * hole * 0.22);
        tint(S, i, PAL.tar, joint * 0.85);              // bitumen sealant
        shade(S, i, 1 - joint * 0.32);
        // Tyre rubber, laid down in arcs where the straddle carriers turn.
        var tyre = sat((scuff[i] - 0.60) * 2.6) * traffic;
        tint(S, i, PAL.rubber, tyre * 0.50);
        desat(S, i, tyre * 0.28);
        // Diesel and hydraulic oil, pooling in the low ground.
        var oilM = sstep(0.68, 0.86, oilN[i]) * sstep(0.64, 0.46, h);
        shade(S, i, 1 - oilM * 0.50);
        tint(S, i, HPAL.oil, oilM * 0.55);
        applyChroma(S, i, C, 0.95, sat(low * 1.2 + ck + oilM),
                    { iron: 0.45, bio: 1.2, wash: 0.62 });

        // ---- roughness ----------------------------------------------------
        var r = 0.80 + (md - 0.5) * 0.22;
        r -= traffic * 0.30;                            // polished by tyres
        r -= tyre * 0.22 + stone * traffic * 0.16;
        r += ck * 0.10 + hole * 0.12 + low * 0.10;
        r = lerp(r, 0.24, joint * 0.7);
        r = lerp(r, 0.10, oilM * 0.85);
        S.ro[i] = sat(r);
        S.me[i] = 0;

        // ---- the water film -----------------------------------------------
        if (WET > 0) {
          var level = 0.608 + (puddleA[i] - 0.5) * 0.10 + (puddleB[i] - 0.5) * 0.045;
          var depth = level - h;
          // "Dry" is a rain shadow, not a desert. In a downpour the sheltered
          // strips under a container are merely LESS wet - the first pass gave
          // them bone-dry chalk blobs at roughness 1.0 that tiled across the
          // whole apron and read as bleached patches on a black mirror.
          var dry = sstep(0.70, 0.88, shelter[i]);
          var pud = sat(depth * 22) * WET * (1 - dry);
          var damp = sat((depth + 0.10) * 7) * WET * (1 - dry * 0.7);
          if (pud > 0.002) {
            // The puddle surface: flat, with a millimetre of standing ripple so
            // the normal is not a dead mirror. weather.js animates on top.
            S.h[i] = lerp(h, level + (ripple[i] - 0.5) * 0.006, pud);
          }
          var wf = sat(damp * 0.55 + pud);
          tint(S, i, HPAL.wetDark, wf * 0.80);
          shade(S, i, 1 - wf * 0.28);
          tint(S, i, HPAL.wetSheen, pud * 0.22);
          desat(S, i, wf * 0.22);
          var rw = lerp(S.ro[i], 0.30, damp * 0.85);
          rw = lerp(rw, 0.035, pud);                    // a genuine mirror
          // ...and the rain-shadowed strips keep some of their dry chalk, which
          // is what gives the apron a roughness RANGE instead of one wet sheen.
          rw = lerp(rw, sat(rw + 0.16), dry * 0.85);
          S.ro[i] = sat(rw);
        }
      }
    }
    punchScrapes(g, S, { count: 12, lenMin: 0.05, lenMax: 0.28, width: 0.0020,
                         depth: 0.035, rough: 0.60, col: HPAL.aggCoolLt, tint: 0.35 });
    punchCraters(g, S, { count: 4, rMin: 0.008, rMax: 0.020, depth: 0.18,
                         rough: 0.92, col: HPAL.aggCoolLt, tint: 0.45, soot: 0.14 });
  }

  function genDockConcrete(g, S) { dockSlab(g, S, { wet: 0, salt: 1100 }); }
  function genWetConcrete(g, S) { dockSlab(g, S, { wet: 1, salt: 1400 }); }

  // -- galvanised chain-link fence (alpha-tested diamond mesh) ---------------
  //
  // The mesh is built from two families of parallel lines in the rotated
  // coordinates a = (x+y)/size*D and b = (x-y)/size*D. Both change by an
  // INTEGER when x or y advances a full tile, so the diamond pattern is
  // torus-tileable by construction - the same argument the noise lattice uses.
  //
  // Wire gauge: 2.5 mm wire on a 50 mm mesh is 1.3 texels at any tile size we
  // can afford, which alpha-tests into a dotted line and mips into nothing.
  // This runs a deliberately generous ~7 texel wire (about double scale) with a
  // one-texel signed-distance edge, which is the standard compromise: the
  // pattern reads, and the alpha edge stays crisp enough not to sparkle.
  function genChainlink(g, S) {
    var n = g.n, size = g.size, i, x, y;
    var D = 6;                                    // diamonds across the tile
    var rw = size * 0.0072;                       // wire radius, texels
    var kA = size / (D * 1.4142136);              // texels per unit of a / b
    var galvN = g.fbm(g.buf(0), 7, 4, 0.55, 1, 11, false);
    var spangle = g.worley(30, 1.0, 13);
    var rustN = g.fbm(g.buf(0), 9, 4, 0.55, 1, 17, false);
    var fine = g.fbm(g.buf(0), 150, 3, 0.5, 1, 19, false);
    var seedM = g.buf(0), weep = g.buf(0);
    for (i = 0; i < n; i++) seedM[i] = sstep(0.68, 0.86, rustN[i]);
    g.drip(seedM, weep, 0.985, true);

    S.base(HPAL.galv);
    for (y = 0; y < size; y++) {
      var rowo = y * size;
      for (x = 0; x < size; x++) {
        i = rowo + x;
        var a = (x + y) / size * D;
        var b = (x - y) / size * D;
        var fa = a - Math.floor(a), fb = b - Math.floor(b);
        var da = Math.min(fa, 1 - fa) * kA;
        var db = Math.min(fb, 1 - fb) * kA;
        var al = sat(0.5 + (rw - (da < db ? da : db)));
        S.al[i] = al;
        if (al <= 0.004) {
          // Open aperture. Height stays mid-scale so the Sobel does not build a
          // cliff round every wire, and the colour behind is dark and rough in
          // case a consumer forgets the alpha test.
          S.h[i] = 0.42;
          S.cr[i] = 0.055; S.cg[i] = 0.060; S.cb[i] = 0.066;
          S.ro[i] = 0.90; S.me[i] = 0;
          continue;
        }
        var ta = da / rw, tb = db / rw;
        var pa = ta < 1 ? Math.sqrt(sat(1 - ta * ta)) : 0;
        var pb = tb < 1 ? Math.sqrt(sat(1 - tb * tb)) : 0;
        // Interlock: the two families alternate over and under per diamond,
        // which is what a woven mesh does and what makes the twists catch light.
        var aOver = (((Math.floor(a) + Math.floor(b)) & 1) === 0);
        var hA = ta < 1 ? 0.42 + pa * 0.20 : -1;
        var hB = tb < 1 ? 0.42 + pb * 0.20 : -1;
        if (ta < 1 && tb < 1) { if (aOver) hB -= 0.11; else hA -= 0.11; }
        var crown = pa > pb ? pa : pb;
        S.h[i] = (hA > hB ? hA : hB) + (fine[i] - 0.5) * 0.010;

        // ---- albedo -------------------------------------------------------
        // Per-WIRE tone. Wire is drawn and galvanised in batches and a repaired
        // fence has whole strands that do not match; without this the mesh is
        // one tone and reads as a printed pattern. Indexed off round(a), not
        // floor(a) - flooring splits each wire down its own centreline.
        var wid = (da < db) ? hash2i(((Math.round(a) % D) + D) % D, 0, 5)
                            : hash2i(0, ((Math.round(b) % D) + D) % D, 7);
        shade(S, i, (0.80 + 0.34 * crown) * (0.88 + 0.24 * wid));
        tint(S, i, PAL.alu, sstep(0.55, 0.15, spangle.f1[i]) * 0.28 * (0.4 + wid));
        var chalk = sat((galvN[i] - 0.42) * 1.9);
        tint(S, i, HPAL.galvChalk, chalk * 0.38);
        desat(S, i, chalk * 0.24);
        // Rust starts at the TWISTS - the zinc cracks where the wire was bent -
        // and at the cut ends, then runs down the wires below.
        var twist = sat(pa * pb * 3.0);
        var rustM = sat(sstep(0.58, 0.82, rustN[i]) * (0.30 + twist * 1.10) +
                        twist * sstep(0.48, 0.80, galvN[i]) * 0.55 +
                        weep[i] * sstep(0.40, 0.75, fine[i]) * 0.45);
        tint(S, i, PAL.rust, rustM * 0.85);
        tint(S, i, PAL.rustDeep, rustM * rustM * 0.45);
        tint(S, i, PAL.rustLt, rustM * crown * 0.32);
        tint(S, i, PAL.grime, (1 - crown) * 0.30);
        S.ro[i] = sat(lerp(0.52 + chalk * 0.30 - crown * 0.16, 0.95, rustM) +
                      (fine[i] - 0.5) * 0.08);
        S.me[i] = sat(0.88 - rustM * 1.15 - chalk * 0.35);
      }
    }
  }

  // -- heavy PVC tarpaulin ---------------------------------------------------
  // A coated fabric, not a cloth: the polyester scrim is BURIED in a PVC skin,
  // so the weave shows as a shallow emboss and a sheen break rather than as
  // yarn crowns. The read comes from the sag folds, the hard creases where it
  // has been folded wet, and the dirt that collects in both.
  function genTarpaulin(g, S) {
    var n = g.n, size = g.size, i, x, y;
    var threads = size >= 1024 ? 96 : 48;
    var macro  = g.fbm(g.buf(0), 3, 4, 0.6, 1, 11, false);
    var wobX   = g.buf(0); g.fbmA(wobX, 28, 5, 3, 0.5, 1, 13, true);
    var wobY   = g.buf(0); g.fbmA(wobY, 5, 28, 3, 0.5, 1, 17, true);
    var sag    = g.buf(0); g.fbmA(sag, 3, 9, 3, 0.55, 1, 19, false);
    var crease = g.ridged(g.buf(0), 7, 4, 1, 23, true);
    var creaseB = g.buf(0); g.fbmA(creaseB, 5, 26, 3, 0.5, 1, 29, false);
    var dirtN  = g.fbm(g.buf(0), 6, 4, 0.6, 1, 31, false);
    var mildew = g.worley(26, 0.9, 37);
    var fine   = g.fbm(g.buf(0), 190, 3, 0.5, 1, 41, false);
    var C = chromaFields(g, 3100);
    var TLx = threadLayout(g, threads, 7103, { wMin: 0.78, wMax: 1.26, slub: 0.020, floatEvery: 19 });
    var TLy = threadLayout(g, threads, 7109, { wMin: 0.80, wMax: 1.22, slub: 0.015, floatEvery: 27 });
    var seedM = g.buf(0), run = g.buf(0);
    for (i = 0; i < n; i++) seedM[i] = sstep(0.60, 0.80, dirtN[i]);
    g.drip(seedM, run, 0.990, true);

    S.base(HPAL.pvc);
    for (y = 0; y < size; y++) {
      var rowo = y * size;
      for (x = 0; x < size; x++) {
        i = rowo + x;
        threadAt(TLx, (x / size) * threads + wobX[i] * 0.4);
        var ix = _thIdx, fxv = _thF;
        threadAt(TLy, (y / size) * threads + wobY[i] * 0.4);
        var iy = _thIdx, fyv = _thF;
        var warp = sat(Math.sin(Math.PI * fxv) / TLx.crown[ix]);
        var weft = sat(Math.sin(Math.PI * fyv) / TLy.crown[iy]);
        var over = TLx.flt[ix] > 0 ? true : (((ix + iy) & 1) === 0);
        var top = over ? warp : weft, bot = over ? weft : warp;
        // The scrim is BURIED. Authored at cloth amplitude the weave becomes the
        // largest gradient in the map, _emit normalises to it, and a tarpaulin
        // renders as a wicker basket. It is an emboss under a plastic skin: a
        // third of the relief, and the folds are what the eye reads.
        var wv = top * 0.013 + bot * 0.005;
        var ridge = sat((sag[i] - 0.58) * 2.8);
        var fold = sat((crease[i] - 0.70) * 3.4) * sstep(0.35, 0.70, creaseB[i]);
        // A stippled coating skin at a scale BETWEEN the weave and the folds.
        // Without something in that band the only high-frequency structure in
        // the map is the lattice, and _emit's gradient normalisation hands the
        // whole normal map to it however small the amplitude.
        var skin = (mildew.f1[i] - 0.35) * 0.055 + (fine[i] - 0.5) * 0.016;
        var h = 0.55 + wv + skin + (sag[i] - 0.5) * 0.23 - fold * 0.125;
        S.h[i] = h;

        // ---- albedo -------------------------------------------------------
        shade(S, i, 0.84 + 0.30 * macro[i]);
        // PVC whitens where it is stressed: fold crowns and sag ridges go
        // chalky and pale, which is the single most recognisable thing about
        // an old tarpaulin.
        tint(S, i, HPAL.pvcLt, (fold * 0.55 + ridge * 0.30) * 0.80);
        desat(S, i, fold * 0.35);
        tint(S, i, HPAL.pvcDk, sstep(0.52, 0.34, h) * 0.55);
        // dirt washes down and collects in the hollows
        var rn = run[i] * sstep(0.34, 0.66, fine[i]);
        tint(S, i, PAL.grime, sstep(0.52, 0.36, h) * 0.35 + rn * 0.40);
        tint(S, i, PAL.dirtDk, rn * rn * 0.30);
        // mildew: black-green spotting in the damp folds
        var mil = sstep(0.34, 0.08, mildew.f1[i]) * sstep(0.55, 0.30, h) *
                  sstep(0.35, 0.65, dirtN[i]);
        tint(S, i, PAL.moss, mil * 0.55);
        tint(S, i, PAL.soot, mil * mil * 0.40);
        tint(S, i, PAL.efflor, sat((fine[i] - 0.66) * 3.0) * ridge * 0.14);
        applyChroma(S, i, C, 0.85, sat(rn * 1.3 + sstep(0.54, 0.38, h)),
                    { iron: 0.8, bio: 1.2, wash: 0.34 });

        // ---- roughness ----------------------------------------------------
        // Coated PVC is genuinely semi-gloss - which is why a tarp reads as
        // plastic and not as canvas - but it chalks hard on the creases and
        // holds a matte dirt film in the hollows.
        var r = 0.40 + (macro[i] - 0.5) * 0.14;
        r += fold * 0.34 + mil * 0.25 + rn * 0.20;
        r += sstep(0.52, 0.36, h) * 0.16;
        r -= ridge * 0.12 + top * 0.05;
        S.ro[i] = sat(r);
        S.me[i] = 0;
      }
    }
    // Grommets: brass eyelets punched through a reinforcement patch, weeping.
    (function () {
      var rng = g.rng;
      for (var k = 0; k < 4; k++) {
        var cx = rng.next() * size, cy = rng.next() * size;
        var R = size * (0.012 + rng.next() * 0.006);
        var rusty = 0.3 + rng.next() * 0.7;
        var span = Math.ceil(R * 3.2);
        for (var yy = -span; yy <= span; yy++) {
          var wy = ((Math.round(cy + yy) % size) + size) % size;
          var rowo2 = wy * size;
          for (var xx = -span; xx <= span; xx++) {
            var d = Math.sqrt(xx * xx + yy * yy) / R;
            if (d > 3.2) continue;
            var wx = ((Math.round(cx + xx) % size) + size) % size;
            var ii = rowo2 + wx;
            var patch = sstep(3.0, 2.2, d);                       // reinforcement
            var ring = sstep(1.75, 1.45, d) * sstep(0.85, 1.05, d);
            var hole = sstep(0.95, 0.70, d);
            S.h[ii] += patch * 0.020 + ring * 0.050 - hole * 0.18;
            tint(S, ii, HPAL.pvcDk, patch * 0.35);
            tint(S, ii, PAL.steelDk, ring * 0.75);
            tint(S, ii, PAL.rust, ring * rusty * 0.55 + hole * rusty * 0.30);
            tint(S, ii, PAL.soot, hole * 0.75);
            S.ro[ii] = sat(lerp(S.ro[ii], 0.30 + rusty * 0.55, ring * 0.85));
            S.me[ii] = sat(lerp(S.me[ii], 0.85 - rusty * 0.8, ring * 0.85));
            // rust weeping down out of the eyelet
            if (yy > 0) {
              var st = sstep(3.2, 1.0, d) * sat(yy / (R * 3.2)) * rusty;
              tint(S, ii, PAL.rust, st * 0.40);
              S.ro[ii] = sat(S.ro[ii] + st * 0.12);
            }
          }
        }
      }
    })();
  }

  // -- laid three-strand mooring rope ---------------------------------------
  //
  // The tile wraps the circumference in X and runs one full lay length in Y, so
  // the strand helix is exact: s = 3u + 3v puts three strands round the rope
  // and turns them through one complete revolution per tile, i.e. a 45 degree
  // lay angle. Both coefficients are integers, so it tiles.
  function genRope(g, S) {
    var n = g.n, size = g.size, i, x, y;
    var strands = 3, lay = 3;
    var yarnA = 15, yarnB = -6;                     // yarns twist the other way
    var macro = g.fbm(g.buf(0), 4, 4, 0.6, 1, 11, false);
    var fuzzN = g.fbm(g.buf(0), 200, 3, 0.5, 1, 13, false);
    var tarN  = g.fbm(g.buf(0), 5, 4, 0.6, 1, 17, false);
    var wearN = g.fbm(g.buf(0), 7, 3, 0.55, 1, 19, false);
    var dirtN = g.fbm(g.buf(0), 9, 4, 0.55, 1, 23, false);
    var hairN = g.buf(0); g.fbmA(hairN, 26, 200, 3, 0.5, 1, 29, false);
    var C = chromaFields(g, 3300);

    S.base(HPAL.manila);
    for (y = 0; y < size; y++) {
      var rowo = y * size;
      var v = y / size;
      for (x = 0; x < size; x++) {
        i = rowo + x;
        var u = x / size;
        var s = u * strands + v * lay;
        var sf = s - Math.floor(s);
        var crownV = Math.sin(Math.PI * sf);
        var strand = Math.pow(sat(crownV), 0.62);
        var yv = u * yarnA + v * yarnB;
        var yf = yv - Math.floor(yv);
        var yarn = Math.sin(Math.PI * yf); yarn *= yarn;
        // Broken fibre standing off the surface: the reason a used rope has a
        // halo and a new one does not.
        var hair = sat((hairN[i] - 0.70) * 3.6) * sat(strand * 1.4);
        var h = 0.40 + strand * 0.30 + yarn * strand * 0.055 +
                hair * 0.030 + (macro[i] - 0.5) * 0.045 + (fuzzN[i] - 0.5) * 0.018;
        S.h[i] = h;

        // ---- albedo -------------------------------------------------------
        // A soaked mooring line is a dark grey-brown, not a golden hawser: it
        // has been under a straddle carrier, in the harbour and in the rain.
        shade(S, i, 0.70 + 0.38 * strand);
        tint(S, i, HPAL.manilaDk, sat(1 - strand * 1.7) * 0.70);   // the lay grooves
        tint(S, i, HPAL.manilaLt, sat((yarn - 0.55) * 2.2) * strand * 0.28);
        // Sun and salt bleach the crowns; the grooves stay dark and greasy.
        var bleach = sat((wearN[i] - 0.44) * 2.0) * sat((strand - 0.45) * 2.2);
        tint(S, i, PAL.dust, bleach * 0.34);
        desat(S, i, bleach * 0.45);
        tint(S, i, HPAL.manilaLt, hair * 0.45);
        tint(S, i, PAL.grime, sat(1 - strand * 1.3) * 0.50 +
                              sat((dirtN[i] - 0.50) * 2.4) * 0.42);
        tint(S, i, PAL.dampGrey, sat((dirtN[i] - 0.44) * 2.0) * 0.26);
        // Tar and diesel off the bollard, soaked into the fibre.
        var tar = sstep(0.50, 0.76, tarN[i]) * (0.40 + (1 - strand) * 0.8);
        tint(S, i, PAL.tar, tar * 0.72);
        tint(S, i, PAL.soot, tar * tar * 0.40);
        shade(S, i, 0.92 + 0.16 * fuzzN[i]);
        applyChroma(S, i, C, 0.9, sat((1 - strand) * 1.2 + tar),
                    { iron: 0.9, bio: 1.1, wash: 0.45 });

        // ---- roughness ----------------------------------------------------
        // Fibre is at the top of the curve; the crowns that have run over a
        // bollard a thousand times are GLAZED, and the tarred parts are waxy.
        var r = 0.94 - bleach * 0.06;
        r -= sat((wearN[i] - 0.55) * 2.4) * strand * 0.34;         // glazed
        r -= tar * 0.22;
        r += hair * 0.05 + sat(1 - strand * 1.5) * 0.04;
        S.ro[i] = sat(r);
        S.me[i] = 0;
      }
    }
    // A few cut/abraded spots where the rope has been chafed on the fairlead.
    punchScrapes(g, S, { count: 10, lenMin: 0.02, lenMax: 0.09, width: 0.0025,
                         depth: 0.030, rough: 0.85, col: HPAL.manilaLt, tint: 0.45,
                         hbias: 0.9, hRef: 0.62 });
  }

  // -- quay fender: heavy black rubber ---------------------------------------
  // Scuffed to grey where the hulls land, embedded grit from being dragged, and
  // a smear of whatever colour the last three ships were painted.
  function genRubberFender(g, S) {
    var n = g.n, size = g.size, i;
    var macro  = g.fbm(g.buf(0), 4, 4, 0.6, 1, 11, false);
    var mould  = g.buf(0); g.fbmA(mould, 3, 80, 2, 0.5, 1, 13, false);
    var grit   = g.worley(70, 1.0, 17);
    var scuffR = g.buf(0); g.fbmA(scuffR, 60, 7, 3, 0.5, 1, 19, false);
    var scuff  = g.buf(0); g.shear(scuffR, scuff, 1);
    var ozone  = g.ridged(g.buf(0), 34, 3, 1, 23, true);
    var paintN = g.fbm(g.buf(0), 7, 4, 0.6, 1, 29, false);
    var bandN  = g.buf(0); g.fbmA(bandN, 3, 8, 3, 0.5, 1, 31, false);
    var saltN  = g.fbm(g.buf(0), 11, 3, 0.55, 1, 37, false);
    var fine   = g.fbm(g.buf(0), 220, 2, 0.5, 1, 41, false);
    var paintCols = [HPAL.ctnRed, HPAL.ctnBlue, HPAL.hullTopLt];

    S.base(PAL.rubber);
    for (i = 0; i < n; i++) {
      var gr = sstep(0.34, 0.08, grit.f1[i]);              // embedded stones
      var ck = sstep(0.88, 0.998, ozone[i]);               // perishing
      var ml = sat((mould[i] - 0.74) * 4.0);               // mould flow lines
      var contact = sat((bandN[i] - 0.42) * 2.2);          // where hulls land
      var sc = sat((scuff[i] - 0.58) * 2.6) * (0.35 + contact);
      // Fine noise stays small here: authored at the same amplitude as the
      // moulded structure it turned the normal map into per-texel confetti and
      // buried the gouges, which are the only story this surface has.
      var h = 0.60 + (macro[i] - 0.5) * 0.075 + gr * 0.048 + ml * 0.020 +
              (fine[i] - 0.5) * 0.008 - ck * 0.13 - sc * 0.012;
      S.h[i] = h;

      shade(S, i, 0.84 + 0.30 * macro[i] + 0.16 * gr);
      // Abraded rubber goes chalky grey, and it does it exactly where the steel
      // has been rubbing - which is the only thing that keeps a black material
      // from rendering as a hole in the frame.
      tint(S, i, PAL.dampGrey, sc * 0.58 + contact * 0.20);
      desat(S, i, sc * 0.35);
      tint(S, i, PAL.soot, ck * 0.62 + sstep(0.58, 0.44, h) * 0.30);
      tint(S, i, HPAL.aggCoolDk, gr * 0.45);
      tint(S, i, HPAL.aggCoolLt, gr * sstep(0.55, 0.85, grit.id[i]) * 0.30);
      // Paint transfer: a hull scraped past and left some of itself behind.
      var pc = paintCols[(sstep(0, 1, paintN[i]) * 2.999) | 0];
      var pm = sstep(0.66, 0.82, paintN[i]) * sc * 1.4;
      tint(S, i, pc, sat(pm) * 0.70);
      tint(S, i, PAL.efflor, sat((saltN[i] - 0.58) * 2.4) * sat((h - 0.60) * 3.0) * 0.20);
      tint(S, i, PAL.grime, sstep(0.60, 0.46, h) * 0.32);
      tint(S, i, PAL.rustDeep, sstep(0.52, 0.68, macro[i]) * ck * 0.45);

      // Roughness: matte perished rubber, a burnished contact band, chalk in
      // the ozone cracks.
      var r = 0.88 - gr * 0.06;
      r -= contact * 0.34 + sc * 0.16;
      r += ck * 0.10 + sat((saltN[i] - 0.58) * 2.4) * 0.08;
      r -= sat(pm) * 0.18;                                  // transferred enamel
      S.ro[i] = sat(r);
      S.me[i] = 0;
    }
    // Gouges from chains, wire and the corner castings of passing barges.
    punchScrapes(g, S, { count: 16, lenMin: 0.04, lenMax: 0.22, width: 0.0030,
                         depth: 0.060, rough: 0.72, col: PAL.dampGrey, tint: 0.40,
                         hbias: 0.6, hRef: 0.60 });
    punchCraters(g, S, { count: 6, rMin: 0.010, rMax: 0.028, depth: 0.10,
                         rough: 0.80, col: PAL.soot, tint: 0.35, halo: 1.5 });
  }

  // -- serrated steel grating (alpha-tested) ---------------------------------
  // Load-bearing bars on a 30 mm pitch running in Y, twisted cross rods on a
  // 100 mm pitch running in X, serration notches along the bar tops. Integer
  // pitches in both axes so the pattern wraps and never beats against the
  // texel grid.
  function genSteelGrate(g, S) {
    var n = g.n, size = g.size, i, x, y;
    var bars = 10, rods = 3, serr = 26;
    var pitchB = size / bars, pitchR = size / rods;
    // A true-scale 5 mm bar on a 30 mm pitch is 17% coverage, and at that gauge
    // the plan view is 80% hole: alpha-tested and mipped it disintegrates into
    // a dotted screen. Real grating is also never seen flat-on - you see the
    // SIDE of the bar - so the top face is authored wide, which is the standard
    // way to get a grating to read from a texture.
    var halfBar = 0.27 * 0.5 * pitchB;
    var halfRod = 0.12 * 0.5 * pitchR;
    var galvN = g.fbm(g.buf(0), 6, 4, 0.55, 1, 11, false);
    var rustN = g.fbm(g.buf(0), 8, 4, 0.55, 1, 13, false);
    var wearN = g.buf(0); g.fbmA(wearN, 3, 7, 3, 0.55, 1, 17, false);
    var fine  = g.fbm(g.buf(0), 170, 3, 0.5, 1, 19, false);
    var grime = g.fbm(g.buf(0), 9, 4, 0.6, 1, 23, false);

    S.base(HPAL.galv);
    for (y = 0; y < size; y++) {
      var rowo = y * size;
      var sp = (y / size) * serr;
      var sf = sp - Math.floor(sp);
      // The serration: a shallow nick milled into the top edge of every bar.
      // It is a grip feature a couple of millimetres deep - authored hard it
      // reads as if the bar were chopped into dashes.
      var notch = sstep(0.62, 0.72, sf) * sstep(1.0, 0.92, sf);
      var rp = (y / size) * rods;
      var rf = rp - Math.floor(rp);
      var dRod = Math.abs(rf - 0.5) * pitchR;
      var alRod = sat(0.5 + (halfRod - dRod));
      for (x = 0; x < size; x++) {
        i = rowo + x;
        var bp = (x / size) * bars;
        var bf = bp - Math.floor(bp);
        var dBar = Math.abs(bf - 0.5) * pitchB;
        var alBar = sat(0.5 + (halfBar * (1 - notch * 0.10) - dBar));
        var al = alBar > alRod ? alBar : alRod;
        S.al[i] = al;
        if (al <= 0.004) {
          S.h[i] = 0.30;
          S.cr[i] = 0.045; S.cg[i] = 0.050; S.cb[i] = 0.055;
          S.ro[i] = 0.90; S.me[i] = 0;
          continue;
        }
        // Height: bar tops are the walking plane, rods sit just below them.
        var wBar = sat((halfBar - dBar) * 0.5 + 0.5);
        var wRod = sat((halfRod - dRod) * 0.5 + 0.5);
        var barTop = 0.74 - notch * 0.040;
        var rodTop = 0.62;
        var h = 0.30;
        if (wRod > 0) h = lerp(h, rodTop, wRod);
        if (wBar > 0) h = Math.max(h, lerp(0.30, barTop, wBar));
        // Boots wear the bar tops smooth in a band across the grating.
        var wear = sat((wearN[i] - 0.44) * 2.2) * wBar;
        h += (fine[i] - 0.5) * 0.010 - wear * 0.006;
        S.h[i] = h;

        // ---- albedo -------------------------------------------------------
        var chalk = sat((galvN[i] - 0.44) * 1.9);
        tint(S, i, HPAL.galvChalk, chalk * 0.40);
        desat(S, i, chalk * 0.24);
        tint(S, i, PAL.steel, wear * 0.50);                 // polished to bare steel
        shade(S, i, 0.84 + 0.26 * wBar + 0.10 * wRod);
        // Rust lives on the cut ends, along the rod welds and in the notches -
        // everywhere the galvanising was broken.
        var rustM = sat(sstep(0.56, 0.82, rustN[i]) * (0.35 + notch * 0.35 + wRod * 0.6) +
                        notch * sstep(0.55, 0.82, galvN[i]) * 0.35);
        rustM *= (1 - wear * 0.75);
        tint(S, i, PAL.rust, rustM * 0.85);
        tint(S, i, PAL.rustDeep, rustM * rustM * 0.50);
        tint(S, i, PAL.rustLt, rustM * sat((h - 0.66) * 8.0) * 0.35);
        // Black grime and oil in the notches and against the rods.
        tint(S, i, PAL.grime, (notch * 0.20 + (1 - wBar) * 0.25 +
                               sat((grime[i] - 0.55) * 2.4) * 0.30));
        tint(S, i, PAL.soot, notch * notch * 0.18);
        shade(S, i, 1 - notch * 0.07);

        // ---- roughness / metalness ----------------------------------------
        var r = 0.52 + chalk * 0.30;
        r -= wear * 0.30;                                   // walked smooth
        r = lerp(r, 0.93, rustM);
        r += notch * 0.06 + sat((grime[i] - 0.55) * 2.4) * 0.10;
        S.ro[i] = sat(r);
        S.me[i] = sat(0.90 - rustM * 1.20 - chalk * 0.30);
      }
    }
  }

  // -- box-profile galvanised roof sheet -------------------------------------
  // Rust bleeding from every fixing, black water staining down the pans, and
  // algae in the valleys that never dry out.
  //
  // Same correction as genContainerPanel, and for a worse reason. This tile is
  // hung on cladPanel() walls that already fold real trapezoidal ribs at a
  // 240 mm pitch, and the texture's own 5 ribs per tile land at 242 mm once
  // SURF.corrugated_roof.uv (0.55) and repeat (1.5) are applied. A 1.01:1
  // frequency ratio is the worst possible case: the two rib sets drift through
  // a full cycle of phase every ~24 m, so a warehouse wall carried alternating
  // bands of double-deep and cancelled ribs, re-scrambled at every stochastic
  // cell boundary. The mesh owns the profile; this map owns the weathering, the
  // spangle, the fixings and the mesoscale ripple of a sheet that has been on a
  // roof for twenty winters.
  function genCorrugatedRoof(g, S) {
    var n = g.n, size = g.size, i, x, y;
    var waves = 5;                                   // fixing columns only now
    var dent  = g.fbm(g.buf(0), 5, 4, 0.6, 1, 11, false);
    var med   = g.fbm(g.buf(0), 22, 4, 0.5, 1, 13, false);
    var fine  = g.fbm(g.buf(0), 180, 3, 0.5, 1, 17, false);
    var spangle = g.worley(24, 1.0, 19);
    var rustN = g.fbm(g.buf(0), 8, 5, 0.55, 1, 23, false);
    var pit   = g.worley(150, 1.0, 29);
    var algaeN = g.buf(0); g.fbmA(algaeN, 7, 40, 3, 0.5, 1, 31, false);
    var streakN = g.buf(0); g.fbmA(streakN, 140, 8, 4, 0.5, 1, 37, false);
    var chalkN = g.fbm(g.buf(0), 6, 3, 0.55, 1, 41, false);
    // Sheet ripple, buckle creases and the vertical wash grain that replace the
    // trapezoid. Coherent over tens of texels, so they still catch a raking
    // lamp the way a rib did - see genContainerPanel for why that matters.
    var ripple = g.buf(0); g.fbmA(ripple, 11, 8, 3, 0.55, 1, 43, false);
    var crease = g.ridged(g.buf(0), 4, 4, 1, 51, true);
    var grain  = g.buf(0); g.fbmA(grain, 30, 5, 4, 0.55, 1, 47, false);
    var C = chromaFields(g, 2100);
    var seedM = g.buf(0), weep = g.buf(0);
    for (i = 0; i < n; i++) seedM[i] = sstep(0.62, 0.80, rustN[i]);
    g.drip(seedM, weep, 0.9955, true);

    // Mesoscale relief plus the proudness mask solved off its own statistics -
    // see genContainerPanel for the argument.
    var relief = g.buf(0);
    for (i = 0; i < n; i++) {
      relief[i] = (ripple[i] - 0.5) * 0.100 + crease[i] * 0.055 +
                  (grain[i] - 0.5) * 0.042 + (dent[i] - 0.5) * 0.080 +
                  (med[i] - 0.5) * 0.020;
    }
    var rMean = 0, rVar = 0, rCnt = 0, rd;
    for (i = 0; i < n; i += 3) { rMean += relief[i]; rCnt++; }
    rMean /= (rCnt || 1);
    for (i = 0; i < n; i += 3) { rd = relief[i] - rMean; rVar += rd * rd; }
    var rSd = Math.sqrt(rVar / (rCnt || 1)) || 1e-4;
    var rE0 = rMean - rSd * 1.30, rE1 = rMean + rSd * 1.30;

    // Not the bright spelter of a new sheet: a warehouse roof in salt air is a
    // dark grey-green oxide with algae in the pans. Authored bright, this map
    // photographed as a cream-coloured fence - the lightest thing in the level.
    S.base(HPAL.galvOld);
    for (y = 0; y < size; y++) {
      var rowo = y * size;
      for (x = 0; x < size; x++) {
        i = rowo + x;
        var crest = sstep(rE0, rE1, relief[i]);
        var valley = 1 - crest;
        var web = 4 * crest * valley;
        var h = 0.50 + (relief[i] - rMean) + (fine[i] - 0.5) * 0.008;
        // Water runs down the pans, so the pans are where it rots through.
        var run = weep[i] * sstep(0.30, 0.66, streakN[i]) * (0.35 + valley * 0.9);
        var rustM = sat(sstep(0.60, 0.82, rustN[i]) * (0.25 + valley * 0.95) + run * 0.85);
        var pt = sstep(0.20, 0.02, pit.f1[i]) * rustM;
        h += rustM * 0.018 - pt * 0.045;
        S.h[i] = h;

        // ---- albedo -------------------------------------------------------
        tint(S, i, PAL.alu, sstep(0.55, 0.15, spangle.f1[i]) * 0.16);
        shade(S, i, 0.80 + 0.26 * spangle.id[i] * 0.5 + 0.16 * crest);
        // Ten winters of spelter turning into a chalky oxide film - patchy, and
        // only on the crowns the rain actually washes.
        var chalk = sat((chalkN[i] - 0.46) * 1.9) * (0.35 + crest * 0.9);
        tint(S, i, HPAL.galvChalk, chalk * 0.30);
        desat(S, i, chalk * 0.26);
        tint(S, i, PAL.rust, rustM * 0.88);
        tint(S, i, PAL.rustMid, rustM * sat(crest * 1.10 - pt * 0.5) * 0.45);
        tint(S, i, PAL.rustDeep, rustM * rustM * valley * 0.50);
        tint(S, i, PAL.rustPit, pt * 0.75);
        shade(S, i, 1 - pt * pt * 0.35);
        // Black water staining and the green that grows in a wet valley.
        var alg = sat((algaeN[i] - 0.52) * 2.4) * (0.25 + valley * 1.0);
        tint(S, i, PAL.moss, alg * 0.50);
        tint(S, i, HPAL.weed, alg * alg * 0.45);
        tint(S, i, PAL.grime, valley * 0.26 + run * 0.42 + web * 0.10);
        tint(S, i, PAL.dampGrey, valley * 0.14);
        tint(S, i, PAL.soot, run * run * 0.34 + valley * valley * 0.16);
        applyChroma(S, i, C, 0.9, sat(run * 1.4 + valley + alg),
                    { iron: 0.85, bio: 1.3, wash: 0.50 });

        // ---- roughness / metalness ----------------------------------------
        var r = 0.55 + (med[i] - 0.5) * 0.22 + chalk * 0.36 + valley * 0.10;
        r = lerp(r, 0.95, rustM);
        r += alg * 0.16 + pt * 0.05;
        r -= sat((dent[i] - 0.64) * 2.6) * crest * 0.34;    // rain-washed crowns
        S.ro[i] = sat(r);
        S.me[i] = sat(0.86 - rustM * 1.10 - chalk * 0.40 - alg * 0.5);
      }
    }
    // Fixings, and every one of them bleeds down the sheet. The map can no
    // longer say WHICH rib a fixing sits on - the ribs are in the mesh and the
    // phase is not knowable here - so the column lattice is jittered hard
    // enough that it reads as scattered fixings rather than as a fourth
    // periodic signal on a wall that already has two.
    stampBolts(g, S, {
      cols: waves, rows: 3, r: 0.009, salt: 77, jitter: 0.09, proud: 0.045,
      weep: 0.10,
      px: function (k, hx) { return (k + 0.07 + (hx - 0.5) * 0.5) * size / waves; }
    });
  }

  // -- chequer / diamond deck plate ------------------------------------------
  // The lug pattern is rasterised as capsules on a jittered cell grid with the
  // orientation alternating per cell, which is what a rolled floor plate looks
  // like. Everything else is driven off the lug mask: grime between the lugs,
  // rust round their roots, and a walking line where they are worn flat and the
  // plate is polished back to bare steel.
  function genDeckPlate(g, S) {
    var n = g.n, size = g.size, i, x, y;
    var cells = 7;
    var lug = g.buf(0);
    (function () {
      var cs = size / cells, ci, cj, li;
      for (cj = 0; cj < cells; cj++) {
        for (ci = 0; ci < cells; ci++) {
          var ang = ((ci + cj) & 1 ? 0.7853982 : -0.7853982) +
                    (hash2i(ci, cj, 3) - 0.5) * 0.12;
          var dx = Math.cos(ang), dy = Math.sin(ang);
          var cx = (ci + 0.5) * cs + (hash2i(ci, cj, 5) - 0.5) * cs * 0.10;
          var cy = (cj + 0.5) * cs + (hash2i(ci, cj, 7) - 0.5) * cs * 0.10;
          var L = cs * 0.30, W = cs * 0.090;
          for (li = 0; li < 2; li++) {
            // two parallel lugs per cell, offset across their own axis
            var off = (li === 0 ? -1 : 1) * cs * 0.17;
            var ox = cx - dy * off, oy = cy + dx * off;
            var span = Math.ceil(L + W * 1.4 + 2);
            for (var yy = -span; yy <= span; yy++) {
              for (var xx = -span; xx <= span; xx++) {
                var t = xx * dx + yy * dy;
                var tc = t > L ? L : (t < -L ? -L : t);
                var ax = xx - tc * dx, ay = yy - tc * dy;
                var d = Math.sqrt(ax * ax + ay * ay) / W;
                if (d > 1.15) continue;
                var wx = ((Math.round(ox + xx) % size) + size) % size;
                var wy = ((Math.round(oy + yy) % size) + size) % size;
                var ii = wy * size + wx;
                // rolled lug: a rounded ridge that tapers away at both ends
                var taper = sstep(1.0, 0.70, Math.abs(t) / (L + W));
                var prof = Math.sqrt(sat(1 - d * d)) * taper;
                if (prof > lug[ii]) lug[ii] = prof;
              }
            }
          }
        }
      }
    })();

    var macro = g.fbm(g.buf(0), 4, 4, 0.6, 1, 11, false);
    var mill  = g.buf(0); g.fbmA(mill, 200, 6, 3, 0.5, 1, 13, false);   // rolling grain
    var med   = g.fbm(g.buf(0), 30, 4, 0.5, 1, 17, false);
    var rustN = g.fbm(g.buf(0), 9, 5, 0.55, 1, 19, false);
    var wearN = g.buf(0); g.fbmA(wearN, 3, 8, 3, 0.55, 1, 23, false);
    var grimeN = g.fbm(g.buf(0), 7, 4, 0.6, 1, 29, false);
    var pit   = g.worley(130, 1.0, 31);
    var C = chromaFields(g, 2500);

    S.base(PAL.steelDark);
    for (i = 0; i < n; i++) {
      var wear = sat((wearN[i] - 0.42) * 2.2);            // the walking line
      var lg = lug[i] * (1 - wear * 0.55);
      var h = 0.42 + lg * 0.26 + (macro[i] - 0.5) * 0.05 +
              (med[i] - 0.5) * 0.022 + (mill[i] - 0.5) * 0.016;
      var rustM = sat(sstep(0.58, 0.82, rustN[i]) * (0.30 + (1 - lg) * 0.85)) * (1 - wear * 0.8);
      var pt = sstep(0.20, 0.02, pit.f1[i]) * rustM;
      h += rustM * 0.015 - pt * 0.035;
      S.h[i] = h;

      // ---- albedo ---------------------------------------------------------
      shade(S, i, 0.82 + 0.30 * macro[i] + 0.22 * lg);
      // Bare steel where boots have polished it; mill scale everywhere else.
      tint(S, i, PAL.steel, wear * 0.55 + sat(lg - 0.7) * wear * 0.30);
      tint(S, i, PAL.steelWarm, sat(1 - med[i] * 1.6) * 0.24);
      tint(S, i, PAL.rust, rustM * 0.88);
      tint(S, i, PAL.rustDeep, rustM * rustM * 0.48);
      tint(S, i, PAL.rustLt, rustM * sat((h - 0.50) * 6.0) * 0.32);
      tint(S, i, PAL.rustPit, pt * 0.70);
      shade(S, i, 1 - pt * pt * 0.32);
      // Grime, oil and swarf collect between the lugs - which is exactly where
      // the height field is low.
      var lowM = sstep(0.50, 0.40, h);
      tint(S, i, PAL.grime, lowM * 0.42 + sat((grimeN[i] - 0.52) * 2.2) * 0.34);
      tint(S, i, HPAL.oil, sat((grimeN[i] - 0.72) * 3.0) * lowM * 0.55);
      applyChroma(S, i, C, 0.8, sat(lowM * 1.3 + pt), { iron: 1.1, wash: 0.30 });

      // ---- roughness / metalness -------------------------------------------
      var r = 0.60 + (med[i] - 0.5) * 0.20;
      r -= wear * 0.34 + sat(lg - 0.55) * 0.22;           // lug crowns burnish
      r = lerp(r, 0.93, rustM);
      r += lowM * 0.14 + sat((grimeN[i] - 0.52) * 2.2) * 0.12;
      S.ro[i] = sat(r);
      S.me[i] = sat(0.85 - rustM * 1.15 - sat((grimeN[i] - 0.62) * 2.6) * 0.35);
    }
    punchScrapes(g, S, { count: 14, lenMin: 0.04, lenMax: 0.20, width: 0.0018,
                         depth: 0.018, rough: 0.30, col: PAL.steel, tint: 0.45,
                         metal: 0.90, hbias: 0.85, hRef: 0.55 });
  }

  // -- harbour water at night ------------------------------------------------
  // Dark, animatable surface data: the height field is a sum of swell, chop and
  // capillary trains at three anisotropic scales plus the dimples of the rain
  // hitting it, so materials.js can scroll two samples of the normal map
  // against each other and get a live surface for free. Albedo is almost black
  // by design - every scrap of value this reads at comes from reflection.
  function genSeaWater(g, S) {
    var n = g.n, i;
    var swell  = g.buf(0); g.fbmA(swell, 3, 5, 3, 0.55, 1, 11, false);
    var chop   = g.buf(0); g.fbmA(chop, 11, 24, 3, 0.5, 1, 13, false);
    var cap    = g.buf(0); g.fbmA(cap, 46, 92, 3, 0.5, 1, 17, false);
    var crestN = g.ridged(g.buf(0), 14, 4, 1, 19, false);
    var streak = g.buf(0); g.fbmA(streak, 6, 60, 3, 0.5, 1, 23, false);
    var foamC  = g.worley(48, 1.0, 29);
    var scumN  = g.fbm(g.buf(0), 5, 4, 0.6, 1, 31, false);
    var rainC  = g.worley(150, 1.0, 37);

    S.base(HPAL.seaDeep);
    for (i = 0; i < n; i++) {
      var sw = swell[i], ch = chop[i];
      var rain = sstep(0.11, 0.02, rainC.f1[i]);          // it is pouring
      var sharp = sat((crestN[i] - 0.72) * 3.2);
      // Swell and chop carry the read; the capillary band and the rain dimples
      // are a garnish. Authored equal they crumple the whole surface into tin
      // foil and the wave structure disappears.
      var h = 0.50 + (sw - 0.5) * 0.38 + (ch - 0.5) * 0.185 +
              (cap[i] - 0.5) * 0.032 + sharp * 0.04 - rain * 0.020;
      S.h[i] = h;

      // Crests catch a little scattered light from below; troughs are the
      // deepest value in the library and stay there.
      tint(S, i, HPAL.seaMid, sat((h - 0.52) * 4.0) * 0.55);
      shade(S, i, 0.85 + 0.30 * ch);
      // Wind-driven foam: streaks aligned with the wind, plus breaking crests.
      // Foam does not sit in round clouds - it is drawn out into Langmuir
      // streaks along the wind, so the cellular term is gated hard by the
      // (very anisotropic) streak field rather than merely multiplied by it.
      var wind = sat((streak[i] - 0.52) * 3.2);
      var fm = sat(sharp * 1.5 * wind + sstep(0.20, 0.04, foamC.f1[i]) * wind * wind * 1.2);
      tint(S, i, HPAL.foam, fm * 0.70);
      // Oily scum and harbour debris film, in the lee.
      var scum = sstep(0.62, 0.82, scumN[i]) * (1 - fm);
      tint(S, i, HPAL.scum, scum * 0.34);
      desat(S, i, scum * 0.25);
      tint(S, i, HPAL.foam, rain * 0.12);                 // the splash ring itself

      // Water is a near-mirror; foam is not, and scum is somewhere between.
      // That spread is what stops the harbour reading as a sheet of glass.
      var r = 0.045 + (ch - 0.5) * 0.03 + rain * 0.05;
      r = lerp(r, 0.72, fm);
      r = lerp(r, 0.32, scum * 0.7);
      S.ro[i] = sat(r);
      S.me[i] = 0;
    }
  }

  // -- worn apron lane marking ----------------------------------------------
  // Thermoplastic paint over the same cool concrete as the apron: the paint has
  // real thickness, retroreflective glass beads in it, and it is worn through
  // to the substrate exactly where the height field is HIGH and the traffic
  // zone says the tyres go.
  function genPaintedLine(g, S) {
    var n = g.n, i;
    var macro = g.fbm(g.buf(0), 3, 4, 0.6, 1, 11, false);
    var med   = g.fbm(g.buf(0), 18, 4, 0.5, 1, 13, false);
    var fine  = g.fbm(g.buf(0), 110, 3, 0.5, 1, 17, false);
    var agg   = g.worley(46, 0.95, 19);
    var crack = g.ridged(g.buf(0), 6, 4, 1, 23, true);
    var wearN = g.fbm(g.buf(0), 4, 4, 0.6, 1, 29, false);
    var beads = g.worley(190, 1.0, 31);
    // Both wear fields are elongated ALONG the tile's U, because that is the
    // way a lane marking is laid and the way traffic runs over it. Authored the
    // other way round they scrape the paint off in vertical bars, which reads
    // as a curtain rather than as a worn line.
    var spray = g.buf(0); g.fbmA(spray, 7, 150, 3, 0.5, 1, 37, false);
    var tyreR = g.buf(0); g.fbmA(tyreR, 5, 34, 3, 0.5, 1, 41, false);
    var dirtN = g.fbm(g.buf(0), 7, 4, 0.6, 1, 43, false);
    var C = chromaFields(g, 2900);

    S.base(HPAL.dockGrey);
    for (i = 0; i < n; i++) {
      // ---- substrate --------------------------------------------------------
      var stone = sstep(0.48, 0.12, agg.f1[i]);
      var hs = 0.60 + (macro[i] - 0.5) * 0.09 + (med[i] - 0.5) * 0.07 +
               (fine[i] - 0.5) * 0.035 + stone * 0.05;
      var ck = sstep(0.84, 0.995, crack[i]);
      hs -= ck * 0.14;
      // ---- paint coverage ---------------------------------------------------
      // Wear where the height is high; the tyres and the aggregate crowns take
      // the paint off together, and the cracks cut straight through it.
      var traffic = sat((wearN[i] - 0.34) * 2.0);
      var wear = sat(traffic * (0.35 + sat((hs - 0.605) * 9.0) * 1.5) +
                     sat((tyreR[i] - 0.56) * 3.0) * traffic * 1.1 + ck * 0.9);
      // The spray edge is ragged - the previous form could never fall below its
      // own threshold, so the paint covered the whole tile and the marking read
      // as a yellow wall instead of as a worn line on concrete.
      var paint = sat(1 - wear) * sstep(0.26, 0.52, spray[i]);
      var bead = sstep(0.30, 0.08, beads.f1[i]) * paint;
      // Thermoplastic is laid down THICK and it FILLS what it covers: the
      // aggregate relief disappears under it. That flattening is half of why a
      // marking reads as paint rather than as a stain.
      var h = lerp(hs, 0.615 + (med[i] - 0.5) * 0.02, paint * 0.70) +
              paint * 0.020 + bead * 0.006;
      S.h[i] = h;

      // ---- albedo -----------------------------------------------------------
      var id = agg.id[i];
      tint(S, i, id < 0.34 ? HPAL.aggCoolDk : (id < 0.72 ? HPAL.aggCool : HPAL.aggCoolLt),
           stone * 0.45);
      shade(S, i, 0.86 + 0.28 * med[i]);
      tint(S, i, PAL.grime, sstep(0.60, 0.44, hs) * 0.40 + ck * 0.55);
      // the paint itself: traffic yellow, chalked and filthy
      tint(S, i, HPAL.lineYellow, paint * 0.92);
      tint(S, i, HPAL.lineWorn, paint * sat((macro[i] - 0.40) * 2.2) * 0.70);
      desat(S, i, paint * sat((macro[i] - 0.40) * 2.2) * 0.45);
      // glass beads: pinpoints of near-white with a wet-looking specular
      tint(S, i, PAL.efflor, bead * 0.40);
      // rubber laid over the top of everything
      var tyre = sat((tyreR[i] - 0.52) * 2.6) * traffic;
      tint(S, i, PAL.rubber, tyre * 0.60);
      tint(S, i, PAL.grime, sat((dirtN[i] - 0.44) * 2.2) * 0.42 * (0.4 + paint * 0.7));
      tint(S, i, PAL.dampGrey, sat((dirtN[i] - 0.38) * 1.9) * 0.24);
      shade(S, i, 1 - paint * 0.10 - tyre * 0.14);
      shade(S, i, 1 - ck * ck * 0.28);
      applyChroma(S, i, C, 0.85, sat(sstep(0.60, 0.44, hs) * 1.2 + ck),
                  { iron: 0.8, bio: 1.0, wash: 0.45 });

      // ---- roughness --------------------------------------------------------
      var r = 0.84 + (med[i] - 0.5) * 0.18;                 // bare concrete
      r = lerp(r, 0.52, paint * 0.9);                       // thermoplastic sheen
      r += paint * sat((macro[i] - 0.45) * 2.2) * 0.26;     // ...chalked back off
      r = lerp(r, 0.22, bead * 0.8);                        // glass
      r -= tyre * 0.18 + traffic * 0.12;
      r += ck * 0.10;
      S.ro[i] = sat(r);
      S.me[i] = 0;
    }
    punchScrapes(g, S, { count: 10, lenMin: 0.06, lenMax: 0.30, width: 0.0022,
                         depth: 0.020, rough: 0.80, col: HPAL.aggCoolLt, tint: 0.45,
                         hbias: 0.7, hRef: 0.62 });
  }

  // -- reefer container refrigeration panel ---------------------------------
  // A louvred grille in a painted casing, running in the rain: the blades are
  // beaded with condensation that runs down them, the gaps behind are near
  // black, and the frame fixings rust. The condensation is the point - it is
  // the one surface in the level that is wet because it is COLD.
  function genReeferPanel(g, S) {
    var n = g.n, size = g.size, i, x, y;
    var blades = 9, stiff = 3;
    var macro = g.fbm(g.buf(0), 4, 4, 0.6, 1, 11, false);
    var med   = g.fbm(g.buf(0), 26, 4, 0.5, 1, 13, false);
    var fine  = g.fbm(g.buf(0), 190, 3, 0.5, 1, 17, false);
    var cond  = g.worley(170, 1.0, 19);                 // condensation beading
    var condZ = g.fbm(g.buf(0), 6, 3, 0.55, 1, 23, false);
    var dirtN = g.fbm(g.buf(0), 7, 4, 0.6, 1, 29, false);
    var chipN = g.fbm(g.buf(0), 12, 5, 0.55, 1, 31, false);
    var streakN = g.buf(0); g.fbmA(streakN, 150, 9, 4, 0.5, 1, 37, false);
    var C = chromaFields(g, 3700);
    var seedM = g.buf(0), runs = g.buf(0);
    for (i = 0; i < n; i++) seedM[i] = sstep(0.66, 0.84, condZ[i] * 0.6 + dirtN[i] * 0.4);
    g.drip(seedM, runs, 0.9955, true);

    S.base(HPAL.reefer);
    for (y = 0; y < size; y++) {
      var rowo = y * size;
      var lv = (y / size) * blades;
      var bf = lv - Math.floor(lv);
      // The shadow slot is a real opening into the machinery, not a scribed
      // line: a louvre you can see 3 texels of is a venetian blind.
      var gap = sstep(0.24, 0.11, bf);
      var face = 1 - gap;
      var tilt = sat(1 - (bf - 0.24) / 0.76);           // 1 at the blade's top lip
      for (x = 0; x < size; x++) {
        i = rowo + x;
        var sv = (x / size) * stiff;
        var sfv = sv - Math.floor(sv);
        var rib = sstep(0.045, 0.0, Math.min(sfv, 1 - sfv));
        var h = 0.30 + face * (0.28 + tilt * 0.10) + rib * 0.035 +
                (med[i] - 0.5) * 0.020 + (fine[i] - 0.5) * 0.010;
        // Condensation beads on the cold blade faces and runs down them.
        var cz = sat((condZ[i] - 0.36) * 2.0);
        var bead = sstep(0.30, 0.06, cond.f1[i]) * face * cz;
        var runm = runs[i] * sstep(0.30, 0.62, streakN[i]) * face;
        h += bead * 0.012;
        S.h[i] = h;

        // ---- albedo -------------------------------------------------------
        shade(S, i, 0.84 + 0.28 * macro[i]);
        tint(S, i, HPAL.reeferDk, gap * 0.70 + (1 - tilt) * face * 0.28);
        shade(S, i, 1 - gap * 0.86);                    // the slot IS a hole
        tint(S, i, PAL.soot, gap * gap * 0.70);
        // chipped casing paint over bare aluminium
        var chip = sstep(0.72, 0.86, chipN[i]) * face;
        tint(S, i, PAL.alu, chip * 0.60);
        // A reefer that has crossed two oceans is not a white good. Dirt runs
        // off every blade lip and collects along the bottom of every slot.
        tint(S, i, PAL.grime, sstep(0.56, 0.38, h) * 0.45 +
                              sat((dirtN[i] - 0.48) * 2.2) * 0.42);
        tint(S, i, PAL.dampGrey, sat((dirtN[i] - 0.40) * 1.8) * 0.30);
        // Water is DARKER than the paint under it and it hangs in vertical runs.
        shade(S, i, 1 - (bead * 0.16 + runm * 0.22));
        tint(S, i, HPAL.wetSheen, bead * 0.30 + runm * 0.24);
        // frost bloom at the cold bridge along the slot lips
        tint(S, i, PAL.efflor, sstep(0.26, 0.36, bf) * sstep(0.52, 0.40, bf) * cz * 0.45);
        tint(S, i, PAL.rust, sat((dirtN[i] - 0.74) * 3.0) * gap * 0.30);
        applyChroma(S, i, C, 0.7, sat(runm * 1.3 + gap), { iron: 0.9, bio: 0.9, wash: 0.5 });

        // ---- roughness ----------------------------------------------------
        // The whole story: chalked enamel at 0.72, wet beading at 0.08, and a
        // frosted lip at 0.9, on the same panel.
        var r = 0.46 + (macro[i] - 0.5) * 0.22 + sat((dirtN[i] - 0.56) * 2.2) * 0.22;
        r += gap * 0.24 + chip * 0.10;
        r = lerp(r, 0.09, sat(bead * 1.1));
        r = lerp(r, 0.16, runm * 0.85);
        r += sstep(0.26, 0.36, bf) * sstep(0.52, 0.40, bf) * cz * 0.30;
        S.ro[i] = sat(r);
        S.me[i] = sat(chip * 0.55 - bead * 0.4);
      }
    }
    // Casing fixings round the grille frame.
    stampBolts(g, S, { cols: 3, rows: 3, r: 0.007, salt: 91, jitter: 0.05,
                       proud: 0.030, rust: 0.7, weep: 0.06 });
  }

  // --------------------------------------------------------------------------
  // Recipe table. `tier` resolves against the quality preset. `bump` is a
  // relative dial: _emit normalises the Sobel gradient against the field's own
  // statistics first, so bump 1.0 means "average relief" on every material and
  // these numbers express intent rather than compensating for amplitude.
  // --------------------------------------------------------------------------
  var RECIPES = {
    concrete:         { tier: 'std',  bump: 0.95, gen: genConcrete, deband: 0.85 },
    concrete_wall:    { tier: 'hero', bump: 0.95, gen: genConcreteWall, deband: 0.90 },
    plaster:          { tier: 'hero', bump: 0.85, gen: genPlaster, deband: 0.90 },
    brick:            { tier: 'hero', bump: 1.30, gen: genBrick },
    asphalt:          { tier: 'hero', bump: 0.90, gen: genAsphalt, deband: 0.85 },
    rusted_metal:     { tier: 'std',  bump: 1.20, gen: genRustedMetal, deband: 0.70 },
    painted_metal:    { tier: 'std',  bump: 0.70, gen: genPaintedMetal, deband: 0.70 },
    corrugated_metal: { tier: 'std',  bump: 0.72, gen: genCorrugated },
    wood_plank:       { tier: 'std',  bump: 1.20, gen: genWood },
    sand:             { tier: 'std',  bump: 0.80, gen: genSand, deband: 0.85 },
    gravel:           { tier: 'std',  bump: 1.40, gen: genGravel, deband: 0.80 },
    dirt_ground:      { tier: 'std',  bump: 1.10, gen: genDirt, deband: 0.80 },
    tile:             { tier: 'std',  bump: 0.80, gen: genTile },
    // The weave read moved out of albedo and into relief + sheen, so the cloth
    // recipes need the relief dial to actually carry it.
    fabric:           { tier: 'std',  bump: 1.15, gen: genFabric },
    cloth_canvas:     { tier: 'std',  bump: 1.15, gen: genCanvas },
    rubber:           { tier: 'small', bump: 0.70, gen: genRubber },
    glass:            { tier: 'small', bump: 0.22, gen: genGlass },
    foliage:          { tier: 'std',  bump: 1.10, gen: genFoliage },
    gun_metal:        { tier: 'hero', bump: 1.10, gen: genGunMetal },
    gun_polymer:      { tier: 'std',  bump: 0.85, gen: genGunPolymer },
    skin:             { tier: 'std',  bump: 0.20, gen: genSkin },
    sandbag:          { tier: 'std',  bump: 1.15, gen: genSandbag },
    rubble:           { tier: 'std',  bump: 1.40, gen: genRubble, deband: 0.80 },
    stone:            { tier: 'std',  bump: 1.10, gen: genStone, deband: 0.85 },
    plastic:          { tier: 'std',  bump: 0.60, gen: genPlastic },
    cloth_olive:      { tier: 'std',  bump: 1.12, gen: genClothOlive },
    cloth_tan:        { tier: 'std',  bump: 1.12, gen: genClothTan },
    detail_normal:    { tier: 'small', bump: 0.75, gen: genDetailNormal, normalOnly: true },

    // ---- LEVEL 2: COLD HARBOR ----------------------------------------------
    // Two hero tiles only. The container flank and the wet apron are what the
    // camera spends the level looking at; everything else is a 512 that is
    // either far away, small on screen, or tiled hard enough that a 1024 would
    // be spent on nothing. This set already doubles the texture boot cost of
    // the level it ships with, so it pays for detail where detail is seen.
    // bump is a MEAN SLOPE target, not an amplitude: _emit normalises the Sobel
    // against the field's own statistics, so the budget gets spent on whatever
    // is in the map. While these four carried a trapezoid it went almost
    // entirely into eight ruled ribs and left the rest of the tile flat. The
    // budget is unchanged; what it buys is now oil-canning, creases and dents.
    container_steel:  { tier: 'hero', bump: 1.00, gen: genContainerSteel },
    container_red:    { tier: 'std',  bump: 1.00, gen: genContainerRed },
    container_blue:   { tier: 'std',  bump: 1.00, gen: genContainerBlue },
    container_green:  { tier: 'std',  bump: 1.00, gen: genContainerGreen },
    ship_hull:        { tier: 'std',  bump: 1.05, gen: genShipHull },
    wet_concrete:     { tier: 'hero', bump: 0.80, gen: genWetConcrete, deband: 0.35 },
    dock_concrete:    { tier: 'std',  bump: 0.95, gen: genDockConcrete, deband: 0.80 },
    // alphaTest is a HINT for materials.js: these two are cut-out sheets and
    // render as solid black squares without it.
    chainlink:        { tier: 'std',  bump: 0.85, gen: genChainlink, alpha: 0.42 },
    steel_grate:      { tier: 'std',  bump: 0.80, gen: genSteelGrate, alpha: 0.42 },
    tarpaulin:        { tier: 'std',  bump: 1.05, gen: genTarpaulin },
    rope:             { tier: 'std',  bump: 1.25, gen: genRope },
    rubber_fender:    { tier: 'std',  bump: 0.90, gen: genRubberFender },
    corrugated_roof:  { tier: 'std',  bump: 0.80, gen: genCorrugatedRoof },
    deck_plate:       { tier: 'std',  bump: 1.10, gen: genDeckPlate },
    sea_water:        { tier: 'std',  bump: 0.85, gen: genSeaWater },
    painted_line:     { tier: 'std',  bump: 0.75, gen: genPaintedLine },
    reefer_panel:     { tier: 'std',  bump: 0.95, gen: genReeferPanel }
  };

  // Names other modules ask for that are spelled differently here. Resolved in
  // get() BEFORE the cache lookup, so both spellings share one generated set
  // instead of paying for the same texture twice.
  var ALIASES = {
    dirt: 'dirt_ground',
    canvas_awning: 'cloth_canvas',
    canvas: 'cloth_canvas',
    hessian: 'sandbag',
    burlap: 'sandbag',
    debris: 'rubble',
    limestone: 'stone',
    polymer: 'gun_polymer'
  };

  // The COLD HARBOR set, in camera-priority order. Prebuilt only when the
  // harbor level is actually loaded: it is most of a second library, the market
  // has no use for a single one of these, and paying its boot cost there would
  // be a pure regression of a finished level. get() still generates any of them
  // on demand, so a stray request degrades to a hitch rather than to a fallback.
  var HARBOR_ORDER = ['wet_concrete', 'container_steel', 'container_red',
    'container_blue', 'container_green', 'dock_concrete', 'ship_hull',
    'corrugated_roof', 'deck_plate', 'steel_grate', 'chainlink', 'tarpaulin',
    'rope', 'rubber_fender', 'reefer_panel', 'painted_line', 'sea_water'];

  // Build order: the surfaces the camera sees most come first so a build that
  // is interrupted still has the important stuff.
  var ORDER = ['plaster', 'concrete_wall', 'asphalt', 'concrete', 'brick',
    'sand', 'dirt_ground', 'gravel', 'rubble', 'stone', 'rusted_metal',
    'corrugated_metal', 'painted_metal', 'wood_plank', 'fabric', 'cloth_canvas',
    'sandbag', 'cloth_olive', 'cloth_tan', 'tile', 'plastic',
    'gun_metal', 'gun_polymer', 'rubber', 'glass', 'foliage', 'skin',
    'detail_normal'];

  // ==========================================================================
  // TextureLibrary
  // ==========================================================================
  function TextureLibrary(ctx) {
    this.ctx = ctx || null;
    this.cache = Object.create(null);
    // `names` is the CAPABILITY list (materials.js probes it before falling
    // back to a texAlt), so it advertises everything the library can make.
    // `order` is what gets PREBUILT during the loading bar, and that is
    // level-dependent - see HARBOR_ORDER.
    this.names = ORDER.concat(HARBOR_ORDER);
    this.levelId = 'market';
    try { if (ctx && ctx.levelId) this.levelId = String(ctx.levelId); } catch (e) { /* default */ }
    this.order = this.levelId === 'harbor' ? HARBOR_ORDER.concat(ORDER) : ORDER.slice();
    this.seed = 20260801;
    try { if (ctx && ctx.seed) this.seed = ctx.seed >>> 0; } catch (e) { /* default */ }

    var level = 'high';
    try { if (ctx && ctx.quality && ctx.quality.level) level = ctx.quality.level; } catch (e) { /* default */ }
    // 1024 for the surfaces that dominate the frame, 512 for the rest. This is
    // the single biggest lever on boot time, so it tracks the quality preset.
    if (level === 'low') this.tiers = { hero: 512, std: 256, small: 128 };
    else if (level === 'medium') this.tiers = { hero: 512, std: 512, small: 256 };
    else this.tiers = { hero: 1024, std: 512, small: 256 };

    this.anisotropy = 4;
    try {
      var a = ctx.renderer.capabilities.getMaxAnisotropy();
      if (a > 0) this.anisotropy = Math.min(16, a);
    } catch (e) { /* no renderer yet - 4 is a safe default */ }

    this._pools = Object.create(null);
    this._rows = Object.create(null);
    this._blur = Object.create(null);
    this.stats = { generated: 0, ms: 0, texels: 0 };
  }

  // ---- internal scratch ----------------------------------------------------
  TextureLibrary.prototype._pool = function (n) {
    return this._pools[n] || (this._pools[n] = []);
  };
  TextureLibrary.prototype._row = function (len) {
    var r = this._rows[len];
    if (!r) r = this._rows[len] = new Float32Array(len);
    return r;
  };
  TextureLibrary.prototype._blurTmp = function (n) {
    var r = this._blur[n];
    if (!r) r = this._blur[n] = new Float32Array(n);
    return r;
  };

  // ---- lifecycle -----------------------------------------------------------
  TextureLibrary.prototype.build = async function () {
    var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    var order = this.order && this.order.length ? this.order : ORDER;
    for (var i = 0; i < order.length; i++) {
      try { this.get(order[i]); }
      catch (e) { GAME.logError('textures.build:' + order[i], e); }
      // Yield so the loading bar can actually paint between materials.
      await GAME.yieldFrame();
    }
    try {
      this.noiseTexture(64, 'blue');
      this.noiseTexture(256, 'perlin');
    } catch (e) { GAME.logError('textures.noise', e); }

    // Release ~100MB of Float32 scratch now that generation is done.
    this._pools = Object.create(null);
    this._rows = Object.create(null);
    this._blur = Object.create(null);
    var t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    this.stats.ms = Math.round(t1 - t0);
    return this;
  };

  TextureLibrary.prototype.update = function () { /* textures are static */ };

  TextureLibrary.prototype.dispose = function () {
    for (var k in this.cache) {
      var e = this.cache[k];
      if (!e) continue;
      if (e.isTexture) { e.dispose(); continue; }
      for (var m in e) { if (e[m] && e[m].isTexture) e[m].dispose(); }
    }
    this.cache = Object.create(null);
  };

  // ---- public API ----------------------------------------------------------
  /**
   * get(name, opts) -> {map, normalMap, roughnessMap, aoMap, displacementMap,
   *                     metalnessMap, ormMap, size, name}
   *
   * roughnessMap / aoMap / metalnessMap are intentionally the SAME texture
   * (glTF ORM packing: R=AO, G=roughness, B=metalness) - three.js reads exactly
   * those channels, so one upload serves all three. aoMap needs a second UV
   * set: call GAME.Geo.copyUV1(geometry).
   *
   * opts: {repeat:[u,v] | repeat:Number, scale:Number, seed:Number}
   *   repeat  authoritative tiling; returns clones that share the GPU upload.
   *   scale   shorthand tiling, applied only when `repeat` was not supplied -
   *           materials.js passes both and treats `repeat` as the truth, so
   *           multiplying them would just cost an extra clone downstream.
   *   seed    accepted and ignored. Per-call reseeding would mean regenerating
   *           a full PBR set (~100ms) per variant; break up repetition with
   *           triplanar/stochastic sampling in materials.js instead.
   */
  TextureLibrary.prototype.get = function (name, opts) {
    if (!name) name = 'concrete';
    if (ALIASES[name]) name = ALIASES[name];
    var base = this.cache[name];
    if (!base) {
      try {
        base = this._generate(name);
      } catch (e) {
        GAME.logError('textures.get:' + name, e);
        base = this._fallbackSet(name);
      }
      this.cache[name] = base;
    }
    if (!opts) return base;

    var ru = 1, rv = 1, hasRepeat = false;
    if (opts.repeat !== undefined && opts.repeat !== null) {
      if (typeof opts.repeat === 'number') { ru = rv = opts.repeat; hasRepeat = true; }
      else if (opts.repeat.length) {
        ru = opts.repeat[0] || 1;
        rv = opts.repeat.length > 1 ? (opts.repeat[1] || 1) : ru;
        hasRepeat = true;
      }
    }
    if (!hasRepeat && opts.scale) { ru = rv = opts.scale; }
    if (ru === 1 && rv === 1) return base;

    var key = name + '|' + ru.toFixed(4) + ',' + rv.toFixed(4);
    var v = this.cache[key];
    if (v) return v;
    v = { size: base.size, name: name, repeat: [ru, rv] };
    // Carry the cut-out hint onto the tiled variant. Without it a fence asked
    // for at repeat 8 loses its alphaTest and renders as a solid black sheet.
    if (base.alphaTest !== undefined) v.alphaTest = base.alphaTest;
    // Dedupe by identity: roughnessMap / aoMap / metalnessMap / ormMap are all
    // the same packed texture, and cloning it four times would give three.js
    // four uv transforms and four texture records for one image.
    var seen = new Map();
    for (var k in base) {
      var t = base[k];
      if (!t || !t.isTexture) continue;
      var c = seen.get(t);
      if (!c) {
        // Clones share `.source`, so three.js re-uses the same GPU upload and we
        // only pay for the extra uv transform.
        c = t.clone();
        c.repeat.set(ru, rv);
        seen.set(t, c);
      }
      v[k] = c;
    }
    this.cache[key] = v;
    return v;
  };

  /**
   * has(name) -> Boolean. True when the library has a real recipe for `name`
   * (aliases resolved), i.e. get(name) will return a purpose-built set rather
   * than the concrete fallback. materials.js probes this before falling back to
   * a def's texAlt, which is how a def can reach ahead of the texture library
   * without silently rendering as grey concrete.
   */
  TextureLibrary.prototype.has = function (name) {
    if (!name) return false;
    if (ALIASES[name]) name = ALIASES[name];
    return !!RECIPES[name];
  };

  /**
   * noiseTexture(size, type) -> THREE.DataTexture
   *   'blue'   4 uncorrelated blue-noise channels, NearestFilter, no mips.
   *            Use for dithering, SSAO kernel rotation and TAA jitter.
   *   'white'  uniform white noise, NearestFilter.
   *   'perlin' R=fbm lo, G=fbm hi, B=worley, A=ridged. Linear + mips; handy as
   *            a macro-variation map to break up texture repetition.
   */
  TextureLibrary.prototype.noiseTexture = function (size, type) {
    size = size || 64;
    type = type || 'blue';
    var key = '@noise|' + type + '|' + size;
    var t = this.cache[key];
    if (t) return t;
    try {
      t = this._makeNoise(size, type);
    } catch (e) {
      GAME.logError('textures.noiseTexture', e);
      t = this._flatTex(4, 128, 128, 128, 255, false, true);
    }
    this.cache[key] = t;
    return t;
  };

  // ---- generation ----------------------------------------------------------
  TextureLibrary.prototype._generate = function (name) {
    var rec = RECIPES[name];
    if (!rec) {
      // Unknown name: alias to something sensible rather than throwing, so a
      // typo in another module degrades to a plausible surface. It is reported
      // loudly, though - eight names silently resolving to the same concrete
      // set is how a third of the library ends up wearing one grey map.
      GAME.logError('textures.missingRecipe:' + name, 'no recipe; falling back to concrete');
      rec = RECIPES.concrete;
      name = 'concrete';
      if (this.cache.concrete) return this.cache.concrete;
    }
    var size = this.tiers[rec.tier] || 512;
    var g = new Gen(this, size, (this.seed ^ hashStr(name)) >>> 0);
    var S = new Surf(g);
    try {
      rec.gen(g, S);
      // Structural anti-tiling pass; see deband(). Opt-in per recipe because a
      // material whose horizontal banding IS the material (brick courses,
      // corrugation ribs, a woven cloth) must keep it.
      if (rec.deband) deband(g, S, rec.deband);
      var out = this._emit(g, S, name, rec);
      g.dispose();
      this.stats.generated++;
      this.stats.texels += size * size;
      return out;
    } catch (e) {
      g.dispose();
      throw e;
    }
  };

  // Height -> normal (Sobel) + AO (multi-scale cavity) -> packed textures.
  TextureLibrary.prototype._emit = function (g, S, name, rec) {
    var size = g.size, n = g.n, i, x, y;
    var h = S.h;

    // Clamp height into 0..1 - recipes subtract freely and a runaway value
    // would blow out the normal map.
    for (i = 0; i < n; i++) { var v = h[i]; h[i] = v < 0 ? 0 : (v > 1 ? 1 : v); }

    // ---- ambient occlusion: blur(h) - h at two scales -----------------------
    // A real cavity map. Inverting height would darken every raised surface,
    // which is exactly the wrong answer for e.g. gravel.
    //
    // The gain is derived from the field's own statistics rather than hard-coded:
    // recipes author height in whatever amplitude reads well for them, so a
    // fixed gain gives 0.02 of occlusion on one material and clips on the next.
    // Normalising against the mean positive cavity depth makes every material
    // land in the same useful range.
    var ao = g.buf(1);
    var b1 = g.buf(0), b2 = g.buf(0);
    var rFine = Math.max(1, size >> 8);
    var rBroad = Math.max(2, size >> 5);
    g.blur(h, b1, rFine); g.blur(b1, b1, rFine);
    g.blur(h, b2, rBroad); g.blur(b2, b2, rBroad);
    var s1 = 0, k1 = 0, s2 = 0, k2 = 0, c1, c2;
    for (i = 0; i < n; i += 3) {
      c1 = b1[i] - h[i]; if (c1 > 0) { s1 += c1; k1++; }
      c2 = b2[i] - h[i]; if (c2 > 0) { s2 += c2; k2++; }
    }
    var m1 = k1 ? s1 / k1 : 0, m2 = k2 ? s2 / k2 : 0;
    var gain1 = m1 > 1e-7 ? 1 / (m1 * 3.0) : 0;
    var gain2 = m2 > 1e-7 ? 1 / (m2 * 2.6) : 0;
    for (i = 0; i < n; i++) {
      c1 = (b1[i] - h[i]) * gain1;
      c2 = (b2[i] - h[i]) * gain2;
      var a = 1 - sat(c1) * 0.50 - sat(c2) * 0.38;
      // ART_DIRECTION: no pure black. Occlusion floors out well above zero and
      // the lighting rig fills the rest.
      ao[i] = a < 0.34 ? 0.34 : a;
    }
    g.release(b1); g.release(b2);

    // ---- pack --------------------------------------------------------------
    var nt = ntab(size);
    var xm = nt.m, xp = nt.p;

    // Differentiate a lightly low-passed copy, never the raw field. A 3-tap box
    // has a transfer null at exactly one cycle per 3 texels, which is where the
    // last surviving noise octave lives; without it the Sobel turns that octave
    // into per-texel confetti that both swamps the macro structure and sparkles
    // under a moving light. `h` itself stays sharp for AO and displacement.
    var hs = g.buf(0);
    g.blur(h, hs, 1);

    // Same normalisation argument as the AO. Measure the mean Sobel magnitude on
    // a subsample and scale so `bump` is a purely artistic dial: bump 1.0 gives
    // a mean surface slope of TARGET, consistently, on every recipe.
    var TARGET = 0.42;
    var gsum = 0, gcnt = 0;
    for (y = 0; y < size; y += 2) {
      var qm = xm[y] * size, q0 = y * size, qp = xp[y] * size;
      for (x = 0; x < size; x += 2) {
        var al = xm[x], ar = xp[x];
        var ax = (hs[qm + ar] + 2 * hs[q0 + ar] + hs[qp + ar]) -
                 (hs[qm + al] + 2 * hs[q0 + al] + hs[qp + al]);
        var ay = (hs[qp + al] + 2 * hs[qp + x] + hs[qp + ar]) -
                 (hs[qm + al] + 2 * hs[qm + x] + hs[qm + ar]);
        gsum += Math.sqrt(ax * ax + ay * ay); gcnt++;
      }
    }
    var gmean = gcnt ? gsum / gcnt : 0;
    var strength = gmean > 1e-6 ? (rec.bump * TARGET / gmean) : 1;

    var albC = new Uint8ClampedArray(n * 4);
    var nrmC = new Uint8ClampedArray(n * 4);
    var ormC = new Uint8ClampedArray(n * 4);

    for (y = 0; y < size; y++) {
      var ym = xm[y] * size, y0 = y * size, yp = xp[y] * size;
      var brow = (y & 7) * 8;
      for (x = 0; x < size; x++) {
        i = y0 + x;
        var xl = xm[x], xr = xp[x];
        // Sobel on the wrapped, low-passed height field
        var gx = (hs[ym + xr] + 2 * hs[y0 + xr] + hs[yp + xr]) -
                 (hs[ym + xl] + 2 * hs[y0 + xl] + hs[yp + xl]);
        var gy = (hs[yp + xl] + 2 * hs[yp + x] + hs[yp + xr]) -
                 (hs[ym + xl] + 2 * hs[ym + x] + hs[ym + xr]);
        // Tangent space, OpenGL convention (+Y green, +Z out of the surface).
        // DataTexture keeps flipY = false, so v increases with the row index
        // and dH/dv is simply +gy.
        var nx = -gx * strength;
        var ny = -gy * strength;
        var inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
        nx *= inv; ny *= inv;
        var nz = inv;

        var d = BAYER[brow + (x & 7)] * (1 / 255);
        var o4 = i * 4;
        nrmC[o4] = (nx * 0.5 + 0.5 + d) * 255;
        nrmC[o4 + 1] = (ny * 0.5 + 0.5 + d) * 255;
        nrmC[o4 + 2] = (nz * 0.5 + 0.5) * 255;
        nrmC[o4 + 3] = 255;

        albC[o4] = (S.cr[i] + d) * 255;
        albC[o4 + 1] = (S.cg[i] + d) * 255;
        albC[o4 + 2] = (S.cb[i] + d) * 255;
        albC[o4 + 3] = S.al[i] * 255;

        ormC[o4] = ao[i] * 255;
        ormC[o4 + 1] = (S.ro[i] + d) * 255;
        ormC[o4 + 2] = S.me[i] * 255;
        ormC[o4 + 3] = 255;
      }
    }
    g.release(ao); g.release(hs);

    // ---- displacement (quarter res: parallax does not need the detail) ------
    var ds = Math.max(16, size >> 2);
    var dispC = new Uint8ClampedArray(ds * ds * 4);
    var step = size / ds;
    for (y = 0; y < ds; y++) {
      for (x = 0; x < ds; x++) {
        var acc = 0, cnt = 0;
        var sy0 = (y * step) | 0, sx0 = (x * step) | 0;
        for (var sy = 0; sy < step; sy++) {
          var so = ((sy0 + sy) % size) * size;
          for (var sx = 0; sx < step; sx++) { acc += h[so + ((sx0 + sx) % size)]; cnt++; }
        }
        var hv = (acc / (cnt || 1)) * 255;
        var od = (y * ds + x) * 4;
        dispC[od] = hv; dispC[od + 1] = hv; dispC[od + 2] = hv; dispC[od + 3] = 255;
      }
    }

    var normalMap = this._tex(nrmC, size, size, false);
    var orm = this._tex(ormC, size, size, false);
    var disp = this._tex(dispC, ds, ds, false);
    var set = {
      map: null,
      normalMap: normalMap,
      roughnessMap: orm,
      aoMap: orm,
      metalnessMap: orm,
      ormMap: orm,
      displacementMap: disp,
      size: size,
      name: name
    };
    // Cut-out sheets (chain-link, grating) publish the alpha threshold they
    // were authored against. Purely advisory - consumers that ignore it behave
    // exactly as before.
    if (rec.alpha) set.alphaTest = rec.alpha;
    if (!rec.normalOnly) {
      set.map = this._tex(albC, size, size, true);
    } else {
      // A detail-normal overlay must not drag an albedo or an ORM along with it.
      orm.dispose(); disp.dispose();
      set.roughnessMap = null; set.aoMap = null; set.metalnessMap = null;
      set.ormMap = null; set.displacementMap = null;
    }
    return set;
  };

  // ---- texture construction ------------------------------------------------
  TextureLibrary.prototype._tex = function (clamped, w, h, srgb, o) {
    // Uint8ClampedArray gives free saturation during packing; WebGL accepts it
    // for UNSIGNED_BYTE, but hand three.js a plain Uint8Array view of the same
    // buffer so nothing downstream has to care.
    var data = new Uint8Array(clamped.buffer, clamped.byteOffset, clamped.length);
    var t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    var nearest = !!(o && o.nearest);
    var mips = !(o && o.mips === false);
    t.generateMipmaps = mips;
    t.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
    t.minFilter = mips ? THREE.LinearMipmapLinearFilter
                       : (nearest ? THREE.NearestFilter : THREE.LinearFilter);
    t.anisotropy = (o && o.aniso !== undefined) ? o.aniso : (mips ? this.anisotropy : 1);
    t.premultiplyAlpha = false;
    t.unpackAlignment = 4;
    t.needsUpdate = true;
    return t;
  };

  TextureLibrary.prototype._flatTex = function (size, r, gg, b, a, srgb, nearest) {
    var n = size * size;
    var d = new Uint8ClampedArray(n * 4);
    for (var i = 0; i < n; i++) {
      d[i * 4] = r; d[i * 4 + 1] = gg; d[i * 4 + 2] = b; d[i * 4 + 3] = a;
    }
    return this._tex(d, size, size, srgb, { mips: false, nearest: !!nearest });
  };

  // A neutral, obviously-not-broken set so a failed recipe cannot cascade.
  TextureLibrary.prototype._fallbackSet = function (name) {
    var orm = this._flatTex(4, 255, 220, 0, 255, false);
    return {
      map: this._flatTex(4, 150, 144, 134, 255, true),
      normalMap: this._flatTex(4, 128, 128, 255, 255, false),
      roughnessMap: orm, aoMap: orm, metalnessMap: orm, ormMap: orm,
      displacementMap: this._flatTex(4, 128, 128, 128, 255, false),
      size: 4, name: name, fallback: true
    };
  };

  // ---- noise textures ------------------------------------------------------
  TextureLibrary.prototype._makeNoise = function (size, type) {
    var n = size * size, i;
    var data = new Uint8ClampedArray(n * 4);

    if (type === 'white') {
      var rng = new GAME.RNG((this.seed ^ 0x9e3779b9 ^ size) >>> 0);
      for (i = 0; i < n * 4; i++) data[i] = rng.next() * 255;
      for (i = 0; i < n; i++) data[i * 4 + 3] = 255;
      return this._tex(data, size, size, false, { mips: false, nearest: true });
    }

    if (type === 'perlin') {
      var g = new Gen(this, size, (this.seed ^ 0x51ed270b) >>> 0);
      var a = g.fbm(g.buf(0), 4, 6, 0.5, 1, 3, false);
      var b = g.fbm(g.buf(0), 16, 4, 0.5, 1, 7, false);
      var w = g.worley(12, 1.0, 11);
      var r = g.ridged(g.buf(0), 8, 4, 1, 13, false);
      for (i = 0; i < n; i++) {
        data[i * 4] = a[i] * 255;
        data[i * 4 + 1] = b[i] * 255;
        data[i * 4 + 2] = sat(w.f1[i] * 1.6) * 255;
        data[i * 4 + 3] = r[i] * 255;
      }
      g.dispose();
      return this._tex(data, size, size, false, { mips: true });
    }

    // ---- blue noise --------------------------------------------------------
    // Four uncorrelated channels. Built by iterated high-pass + rank
    // uniformisation: subtract a low-pass of the field, then re-sort the values
    // onto a uniform ramp. A handful of iterations pushes almost all the energy
    // into the high frequencies, which is what "blue" means, without needing a
    // full void-and-cluster implementation.
    var tmp = new Float32Array(n), lp = new Float32Array(n), col = new Float32Array(size);
    for (var ch = 0; ch < 4; ch++) {
      var v = blueNoisePlane(size, new GAME.RNG((this.seed ^ (0x2545f491 + ch * 7919) ^ size) >>> 0), tmp, lp, col);
      for (i = 0; i < n; i++) data[i * 4 + ch] = v[i] * 255;
    }
    return this._tex(data, size, size, false, { mips: false, nearest: true });
  };

  function blueNoisePlane(size, rng, tmp, lp, col) {
    var n = size * size, i, it;
    var v = new Float32Array(n);
    for (i = 0; i < n; i++) v[i] = rng.next();
    var idx = new Int32Array(n);
    for (it = 0; it < 6; it++) {
      boxBlur(v, lp, size, 1, tmp, col);
      boxBlur(lp, lp, size, 1, tmp, col);
      for (i = 0; i < n; i++) v[i] -= lp[i];
      for (i = 0; i < n; i++) idx[i] = i;
      var arr = Array.prototype.slice.call(idx);
      arr.sort(function (a, b) { return v[a] - v[b]; });
      for (i = 0; i < n; i++) v[arr[i]] = (i + 0.5) / n;
    }
    return v;
  }

  GAME.TextureLibrary = TextureLibrary;

})(window.GAME, window.THREE);
