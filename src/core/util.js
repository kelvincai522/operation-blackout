// ============================================================================
// OPERATION BLACKOUT - core utilities
// FOUNDATION FILE. Owned by integration. Do not edit from a feature agent.
// Establishes window.GAME and the primitives every other system builds on.
// ============================================================================
(function (window, THREE) {
  'use strict';

  var GAME = window.GAME = window.GAME || {};

  GAME.version = '1.0.0';

  // --------------------------------------------------------------------------
  // Math
  // --------------------------------------------------------------------------
  var M = GAME.Math = {
    TAU: Math.PI * 2,
    DEG: Math.PI / 180,

    clamp: function (v, a, b) { return v < a ? a : (v > b ? b : v); },
    saturate: function (v) { return v < 0 ? 0 : (v > 1 ? 1 : v); },
    lerp: function (a, b, t) { return a + (b - a) * t; },
    mix: function (a, b, t) { return a + (b - a) * t; },
    invLerp: function (a, b, v) { return b === a ? 0 : (v - a) / (b - a); },
    remap: function (v, a, b, c, d) { return c + (d - c) * ((v - a) / (b - a || 1)); },
    smoothstep: function (e0, e1, x) {
      var t = M.saturate((x - e0) / (e1 - e0 || 1));
      return t * t * (3 - 2 * t);
    },
    smootherstep: function (e0, e1, x) {
      var t = M.saturate((x - e0) / (e1 - e0 || 1));
      return t * t * t * (t * (t * 6 - 15) + 10);
    },
    // Framerate-independent exponential approach. `rate` = how much of the gap
    // closes per second. Use this instead of naive lerp(a,b,0.1) in update().
    damp: function (a, b, rate, dt) {
      return b + (a - b) * Math.exp(-rate * dt);
    },
    dampAngle: function (a, b, rate, dt) {
      return b + M.wrapAngle(a - b) * Math.exp(-rate * dt);
    },
    wrapAngle: function (a) {
      a = (a + Math.PI) % M.TAU;
      if (a < 0) a += M.TAU;
      return a - Math.PI;
    },
    moveTowards: function (a, b, maxDelta) {
      var d = b - a;
      if (Math.abs(d) <= maxDelta) return b;
      return a + Math.sign(d) * maxDelta;
    },
    sign: function (v) { return v < 0 ? -1 : (v > 0 ? 1 : 0); },
    // Smooth interpolation with velocity memory - the classic game-feel spring.
    springDamp: function (cur, target, velRef, smoothTime, dt, maxSpeed) {
      smoothTime = Math.max(0.0001, smoothTime);
      maxSpeed = maxSpeed === undefined ? Infinity : maxSpeed;
      var omega = 2 / smoothTime;
      var x = omega * dt;
      var exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
      var change = cur - target;
      var maxChange = maxSpeed * smoothTime;
      change = M.clamp(change, -maxChange, maxChange);
      var temp = (velRef.v + omega * change) * dt;
      velRef.v = (velRef.v - omega * temp) * exp;
      var out = (cur - change) + (change + temp) * exp;
      if ((target - cur > 0) === (out > target)) {
        out = target;
        velRef.v = (out - target) / dt;
      }
      return out;
    }
  };

  // --------------------------------------------------------------------------
  // Deterministic RNG (mulberry32) - every system must use this, never
  // Math.random(), or captures stop being reproducible for the critic loop.
  // --------------------------------------------------------------------------
  function RNG(seed) {
    this.seed = (seed === undefined ? 1337 : seed) >>> 0;
    this._s = this.seed;
  }
  RNG.prototype.reset = function (seed) {
    this._s = (seed === undefined ? this.seed : seed) >>> 0;
    return this;
  };
  RNG.prototype.next = function () {
    this._s = (this._s + 0x6D2B79F5) >>> 0;
    var t = this._s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  RNG.prototype.range = function (a, b) { return a + (b - a) * this.next(); };
  RNG.prototype.int = function (a, b) { return Math.floor(this.range(a, b + 1)); };
  RNG.prototype.pick = function (arr) { return arr[Math.floor(this.next() * arr.length) % arr.length]; };
  RNG.prototype.bool = function (p) { return this.next() < (p === undefined ? 0.5 : p); };
  RNG.prototype.sign = function () { return this.next() < 0.5 ? -1 : 1; };
  // Box-Muller, for natural-looking scatter instead of uniform noise.
  RNG.prototype.gaussian = function (mean, sd) {
    var u = 1 - this.next(), v = this.next();
    return (mean || 0) + (sd === undefined ? 1 : sd) *
      Math.sqrt(-2 * Math.log(u)) * Math.cos(M.TAU * v);
  };
  RNG.prototype.onSphere = function (out) {
    var z = this.range(-1, 1), a = this.range(0, M.TAU);
    var r = Math.sqrt(1 - z * z);
    out.set(r * Math.cos(a), r * Math.sin(a), z);
    return out;
  };
  RNG.prototype.inCone = function (dir, angleRad, out) {
    var cosA = Math.cos(angleRad);
    var z = this.range(cosA, 1);
    var a = this.range(0, M.TAU);
    var r = Math.sqrt(Math.max(0, 1 - z * z));
    out.set(r * Math.cos(a), r * Math.sin(a), z);
    // rotate +Z onto dir
    var q = _q1.setFromUnitVectors(_v1.set(0, 0, 1), dir);
    return out.applyQuaternion(q);
  };
  RNG.prototype.fork = function (salt) {
    return new RNG((this._s ^ Math.imul(salt | 0, 0x9E3779B1)) >>> 0);
  };
  GAME.RNG = RNG;

  // --------------------------------------------------------------------------
  // Value/gradient noise - the backbone of every procedural texture and shape.
  // --------------------------------------------------------------------------
  function Noise(seed) {
    var rng = new RNG(seed);
    var p = new Uint8Array(512);
    var perm = new Uint8Array(256);
    var i;
    for (i = 0; i < 256; i++) perm[i] = i;
    for (i = 255; i > 0; i--) {
      var j = Math.floor(rng.next() * (i + 1));
      var t = perm[i]; perm[i] = perm[j]; perm[j] = t;
    }
    for (i = 0; i < 512; i++) p[i] = perm[i & 255];
    this.p = p;
  }
  function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  function grad2(h, x, y) {
    switch (h & 3) {
      case 0: return x + y;
      case 1: return -x + y;
      case 2: return x - y;
      default: return -x - y;
    }
  }
  function grad3(h, x, y, z) {
    var u = h < 8 ? x : y;
    var v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
    return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
  }
  Noise.prototype.perlin2 = function (x, y) {
    var p = this.p;
    var X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    x -= Math.floor(x); y -= Math.floor(y);
    var u = fade(x), v = fade(y);
    var A = p[X] + Y, B = p[X + 1] + Y;
    return M.lerp(
      M.lerp(grad2(p[A], x, y), grad2(p[B], x - 1, y), u),
      M.lerp(grad2(p[A + 1], x, y - 1), grad2(p[B + 1], x - 1, y - 1), u), v);
  };
  Noise.prototype.perlin3 = function (x, y, z) {
    var p = this.p;
    var X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    var u = fade(x), v = fade(y), w = fade(z);
    var A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z;
    var B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;
    return M.lerp(
      M.lerp(M.lerp(grad3(p[AA], x, y, z), grad3(p[BA], x - 1, y, z), u),
             M.lerp(grad3(p[AB], x, y - 1, z), grad3(p[BB], x - 1, y - 1, z), u), v),
      M.lerp(M.lerp(grad3(p[AA + 1], x, y, z - 1), grad3(p[BA + 1], x - 1, y, z - 1), u),
             M.lerp(grad3(p[AB + 1], x, y - 1, z - 1), grad3(p[BB + 1], x - 1, y - 1, z - 1), u), v), w);
  };
  // Fractal brownian motion. `octaves` layers of detail - this is what makes a
  // surface read as real rather than as a single smooth blob.
  Noise.prototype.fbm2 = function (x, y, octaves, lacunarity, gain) {
    octaves = octaves || 4; lacunarity = lacunarity || 2; gain = gain || 0.5;
    var sum = 0, amp = 1, freq = 1, norm = 0;
    for (var i = 0; i < octaves; i++) {
      sum += amp * this.perlin2(x * freq, y * freq);
      norm += amp; amp *= gain; freq *= lacunarity;
    }
    return sum / norm;
  };
  Noise.prototype.fbm3 = function (x, y, z, octaves, lacunarity, gain) {
    octaves = octaves || 4; lacunarity = lacunarity || 2; gain = gain || 0.5;
    var sum = 0, amp = 1, freq = 1, norm = 0;
    for (var i = 0; i < octaves; i++) {
      sum += amp * this.perlin3(x * freq, y * freq, z * freq);
      norm += amp; amp *= gain; freq *= lacunarity;
    }
    return sum / norm;
  };
  // Ridged noise - for cracks, erosion, mountain silhouettes.
  Noise.prototype.ridged2 = function (x, y, octaves) {
    octaves = octaves || 4;
    var sum = 0, amp = 0.5, freq = 1, norm = 0;
    for (var i = 0; i < octaves; i++) {
      var n = 1 - Math.abs(this.perlin2(x * freq, y * freq));
      sum += amp * n * n; norm += amp; amp *= 0.5; freq *= 2;
    }
    return sum / norm;
  };
  // Worley/cellular - pebbles, cracked mud, concrete aggregate, scratches.
  Noise.prototype.worley2 = function (x, y, jitter) {
    jitter = jitter === undefined ? 1 : jitter;
    var xi = Math.floor(x), yi = Math.floor(y);
    var xf = x - xi, yf = y - yi;
    var f1 = 8, f2 = 8;
    for (var oy = -1; oy <= 1; oy++) {
      for (var ox = -1; ox <= 1; ox++) {
        var h = hash2(xi + ox, yi + oy, this.p);
        var px = ox + 0.5 + (h.a - 0.5) * jitter - xf;
        var py = oy + 0.5 + (h.b - 0.5) * jitter - yf;
        var d = Math.sqrt(px * px + py * py);
        if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
      }
    }
    return { f1: f1, f2: f2, edge: f2 - f1 };
  };
  var _h = { a: 0, b: 0 };
  function hash2(x, y, p) {
    var n = p[(p[x & 255] + (y & 255)) & 255];
    var m = p[(p[(x + 37) & 255] + ((y + 17) & 255)) & 255];
    _h.a = n / 255; _h.b = m / 255;
    return _h;
  }
  GAME.Noise = Noise;
  GAME.noise = new Noise(20260801);

  // --------------------------------------------------------------------------
  // Event bus
  // --------------------------------------------------------------------------
  function EventBus() { this._h = Object.create(null); }
  EventBus.prototype.on = function (evt, fn, scope) {
    (this._h[evt] || (this._h[evt] = [])).push({ fn: fn, scope: scope });
    return this;
  };
  EventBus.prototype.off = function (evt, fn) {
    var l = this._h[evt];
    if (!l) return this;
    for (var i = l.length - 1; i >= 0; i--) if (l[i].fn === fn) l.splice(i, 1);
    return this;
  };
  EventBus.prototype.emit = function (evt, a, b, c) {
    var l = this._h[evt];
    if (!l) return;
    // iterate a copy so handlers may unsubscribe during dispatch
    for (var i = 0, arr = l.slice(); i < arr.length; i++) {
      try { arr[i].fn.call(arr[i].scope, a, b, c); }
      catch (e) { GAME.logError('event:' + evt, e); }
    }
  };
  GAME.EventBus = EventBus;

  // --------------------------------------------------------------------------
  // Object pool - allocation during gameplay causes GC hitches, which read as
  // stutter. Every transient (particle, decal, tracer) comes from a pool.
  // --------------------------------------------------------------------------
  function Pool(factory, reset, initial) {
    this._factory = factory;
    this._reset = reset || null;
    this._free = [];
    this.active = [];
    for (var i = 0; i < (initial || 0); i++) this._free.push(factory());
  }
  Pool.prototype.acquire = function () {
    var o = this._free.length ? this._free.pop() : this._factory();
    this.active.push(o);
    return o;
  };
  Pool.prototype.release = function (o) {
    var i = this.active.indexOf(o);
    if (i >= 0) this.active.splice(i, 1);
    if (this._reset) this._reset(o);
    this._free.push(o);
  };
  Pool.prototype.releaseAt = function (i) {
    var o = this.active[i];
    this.active[i] = this.active[this.active.length - 1];
    this.active.pop();
    if (this._reset) this._reset(o);
    this._free.push(o);
    return o;
  };
  Pool.prototype.releaseAll = function () {
    while (this.active.length) this.releaseAt(this.active.length - 1);
  };
  GAME.Pool = Pool;

  // --------------------------------------------------------------------------
  // Spatial hash broadphase
  // --------------------------------------------------------------------------
  function SpatialHash(cellSize) {
    this.cell = cellSize || 4;
    this.map = new Map();
  }
  SpatialHash.prototype._key = function (x, y, z) {
    return x * 73856093 ^ y * 19349663 ^ z * 83492791;
  };
  SpatialHash.prototype.insert = function (item, min, max) {
    var c = this.cell;
    var x0 = Math.floor(min.x / c), x1 = Math.floor(max.x / c);
    var y0 = Math.floor(min.y / c), y1 = Math.floor(max.y / c);
    var z0 = Math.floor(min.z / c), z1 = Math.floor(max.z / c);
    for (var x = x0; x <= x1; x++)
      for (var y = y0; y <= y1; y++)
        for (var z = z0; z <= z1; z++) {
          var k = this._key(x, y, z);
          var b = this.map.get(k);
          if (!b) this.map.set(k, [item]); else b.push(item);
        }
  };
  SpatialHash.prototype.query = function (min, max, out) {
    out = out || [];
    out.length = 0;
    var c = this.cell, seen = _hashSeen;
    seen.clear();
    var x0 = Math.floor(min.x / c), x1 = Math.floor(max.x / c);
    var y0 = Math.floor(min.y / c), y1 = Math.floor(max.y / c);
    var z0 = Math.floor(min.z / c), z1 = Math.floor(max.z / c);
    for (var x = x0; x <= x1; x++)
      for (var y = y0; y <= y1; y++)
        for (var z = z0; z <= z1; z++) {
          var b = this.map.get(this._key(x, y, z));
          if (!b) continue;
          for (var i = 0; i < b.length; i++) {
            if (!seen.has(b[i])) { seen.add(b[i]); out.push(b[i]); }
          }
        }
    return out;
  };
  SpatialHash.prototype.clear = function () { this.map.clear(); };
  var _hashSeen = new Set();
  GAME.SpatialHash = SpatialHash;

  // --------------------------------------------------------------------------
  // Collision primitives
  // --------------------------------------------------------------------------
  var _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
  var _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

  var Collision = GAME.Collision = {
    // Slab test against an oriented box. Returns distance or -1.
    raycastBox: function (ro, rd, box, out) {
      var q = box.quaternion;
      var lo = _v1.copy(ro).sub(box.center);
      var ld = _v2.copy(rd);
      if (q) {
        _q2.copy(q).invert();
        lo.applyQuaternion(_q2);
        ld.applyQuaternion(_q2);
      }
      var h = box.halfExtents;
      var tmin = -Infinity, tmax = Infinity, axis = 0, sign = 1;
      var o = [lo.x, lo.y, lo.z], d = [ld.x, ld.y, ld.z], e = [h.x, h.y, h.z];
      for (var i = 0; i < 3; i++) {
        if (Math.abs(d[i]) < 1e-8) {
          if (o[i] < -e[i] || o[i] > e[i]) return -1;
          continue;
        }
        var inv = 1 / d[i];
        var t1 = (-e[i] - o[i]) * inv;
        var t2 = (e[i] - o[i]) * inv;
        var s = -1;
        if (t1 > t2) { var tt = t1; t1 = t2; t2 = tt; s = 1; }
        if (t1 > tmin) { tmin = t1; axis = i; sign = s; }
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) return -1;
      }
      if (tmax < 0) return -1;
      var t = tmin >= 0 ? tmin : tmax;
      if (out) {
        out.point.copy(rd).multiplyScalar(t).add(ro);
        out.normal.set(0, 0, 0);
        out.normal.setComponent(axis, sign);
        if (q) out.normal.applyQuaternion(q);
        // ensure the normal faces the ray
        if (out.normal.dot(rd) > 0) out.normal.negate();
      }
      return t;
    },

    raycastSphere: function (ro, rd, center, radius, out) {
      var oc = _v1.copy(ro).sub(center);
      var b = oc.dot(rd);
      var c = oc.lengthSq() - radius * radius;
      var disc = b * b - c;
      if (disc < 0) return -1;
      var sd = Math.sqrt(disc);
      var t = -b - sd;
      if (t < 0) t = -b + sd;
      if (t < 0) return -1;
      if (out) {
        out.point.copy(rd).multiplyScalar(t).add(ro);
        out.normal.copy(out.point).sub(center).normalize();
      }
      return t;
    },

    // Axis-aligned capsule (player) vs oriented box, returns penetration MTV.
    // This is the workhorse for character collision response.
    capsuleBoxMTV: function (base, radius, height, box, out) {
      // work in the box's local space
      var q = box.quaternion;
      var p = _v1.copy(base).sub(box.center);
      if (q) { _q2.copy(q).invert(); p.applyQuaternion(_q2); }
      // capsule segment in local space (approximate: keep it vertical)
      var yBottom = p.y + radius;
      var yTop = p.y + height - radius;
      var h = box.halfExtents;
      // closest point on segment to box, then box-sphere resolve
      var cy = M.clamp(M.clamp(0, yBottom, yTop), -1e9, 1e9);
      cy = M.clamp(0, Math.min(yBottom, yTop), Math.max(yBottom, yTop));
      var sx = p.x, sz = p.z, sy = cy;
      var qx = M.clamp(sx, -h.x, h.x);
      var qy = M.clamp(sy, -h.y, h.y);
      var qz = M.clamp(sz, -h.z, h.z);
      var dx = sx - qx, dy = sy - qy, dz = sz - qz;
      var d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > radius * radius) return 0;
      var d = Math.sqrt(d2);
      var nx, ny, nz, depth;
      if (d > 1e-6) {
        nx = dx / d; ny = dy / d; nz = dz / d;
        depth = radius - d;
      } else {
        // centre inside the box - push out along the shallowest axis
        var px = h.x - Math.abs(sx), py = h.y - Math.abs(sy), pz = h.z - Math.abs(sz);
        if (px <= py && px <= pz) { nx = M.sign(sx) || 1; ny = 0; nz = 0; depth = px + radius; }
        else if (py <= pz) { nx = 0; ny = M.sign(sy) || 1; nz = 0; depth = py + radius; }
        else { nx = 0; ny = 0; nz = M.sign(sz) || 1; depth = pz + radius; }
      }
      out.set(nx, ny, nz);
      if (q) out.applyQuaternion(q);
      return depth;
    },

    boxOverlapsSphere: function (box, center, radius) {
      var p = _v1.copy(center).sub(box.center);
      if (box.quaternion) { _q2.copy(box.quaternion).invert(); p.applyQuaternion(_q2); }
      var h = box.halfExtents;
      var dx = Math.max(0, Math.abs(p.x) - h.x);
      var dy = Math.max(0, Math.abs(p.y) - h.y);
      var dz = Math.max(0, Math.abs(p.z) - h.z);
      return dx * dx + dy * dy + dz * dz <= radius * radius;
    },

    boxBounds: function (box, min, max) {
      var h = box.halfExtents;
      if (!box.quaternion) {
        min.copy(box.center).sub(h);
        max.copy(box.center).add(h);
        return;
      }
      // conservative AABB of the OBB
      var m = _m1.makeRotationFromQuaternion(box.quaternion).elements;
      var ex = Math.abs(m[0]) * h.x + Math.abs(m[4]) * h.y + Math.abs(m[8]) * h.z;
      var ey = Math.abs(m[1]) * h.x + Math.abs(m[5]) * h.y + Math.abs(m[9]) * h.z;
      var ez = Math.abs(m[2]) * h.x + Math.abs(m[6]) * h.y + Math.abs(m[10]) * h.z;
      min.set(box.center.x - ex, box.center.y - ey, box.center.z - ez);
      max.set(box.center.x + ex, box.center.y + ey, box.center.z + ez);
    }
  };
  var _m1 = new THREE.Matrix4();

  // --------------------------------------------------------------------------
  // Input
  // --------------------------------------------------------------------------
  function Input(el) {
    this.el = el || window;
    this.keys = Object.create(null);
    this.pressed = Object.create(null);
    this.released = Object.create(null);
    this.mouse = { dx: 0, dy: 0, left: false, right: false, wheel: 0 };
    this.mousePressed = { left: false, right: false };
    this.locked = false;
    this.enabled = true;
    this._bind();
  }
  Input.prototype._bind = function () {
    var self = this;
    window.addEventListener('keydown', function (e) {
      if (!self.enabled) return;
      var c = e.code;
      if (!self.keys[c]) self.pressed[c] = true;
      self.keys[c] = true;
      if (c === 'Tab' || c.indexOf('Arrow') === 0 || c === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', function (e) {
      self.keys[e.code] = false;
      self.released[e.code] = true;
    });
    window.addEventListener('mousemove', function (e) {
      if (!self.locked) return;
      self.mouse.dx += e.movementX || 0;
      self.mouse.dy += e.movementY || 0;
    });
    window.addEventListener('mousedown', function (e) {
      if (!self.enabled) return;
      if (e.button === 0) { self.mouse.left = true; self.mousePressed.left = true; }
      if (e.button === 2) { self.mouse.right = true; self.mousePressed.right = true; }
    });
    window.addEventListener('mouseup', function (e) {
      if (e.button === 0) self.mouse.left = false;
      if (e.button === 2) self.mouse.right = false;
    });
    window.addEventListener('wheel', function (e) { self.mouse.wheel += Math.sign(e.deltaY); }, { passive: true });
    window.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    document.addEventListener('pointerlockchange', function () {
      self.locked = document.pointerLockElement != null;
      GAME.bus && GAME.bus.emit('pointerlock', self.locked);
    });
  };
  Input.prototype.down = function (c) { return !!this.keys[c]; };
  Input.prototype.justPressed = function (c) { return !!this.pressed[c]; };
  Input.prototype.justReleased = function (c) { return !!this.released[c]; };
  Input.prototype.axis = function (neg, pos) {
    return (this.keys[pos] ? 1 : 0) - (this.keys[neg] ? 1 : 0);
  };
  // Call at the END of each frame.
  Input.prototype.endFrame = function () {
    this.mouse.dx = 0; this.mouse.dy = 0; this.mouse.wheel = 0;
    this.mousePressed.left = false; this.mousePressed.right = false;
    for (var k in this.pressed) this.pressed[k] = false;
    for (var r in this.released) this.released[r] = false;
  };
  Input.prototype.requestLock = function (canvas) {
    if (canvas && canvas.requestPointerLock) canvas.requestPointerLock();
  };
  GAME.Input = Input;

  // --------------------------------------------------------------------------
  // Geometry helpers
  // --------------------------------------------------------------------------
  var Geo = GAME.Geo = {
    // Merge a list of {geometry, matrix} into one BufferGeometry. Essential for
    // keeping draw calls down on static level dressing.
    mergeAll: function (entries) {
      var groups = [];
      var total = 0, hasUV = true, hasNormal = true;
      var i, e, g;
      for (i = 0; i < entries.length; i++) {
        g = entries[i].geometry;
        if (g.index) g = g.toNonIndexed ? g.toNonIndexed() : g;
        entries[i]._g = g;
        total += g.attributes.position.count;
        if (!g.attributes.uv) hasUV = false;
        if (!g.attributes.normal) hasNormal = false;
      }
      var pos = new Float32Array(total * 3);
      var nrm = hasNormal ? new Float32Array(total * 3) : null;
      var uv = hasUV ? new Float32Array(total * 2) : null;
      var off = 0;
      var nm = new THREE.Matrix3();
      for (i = 0; i < entries.length; i++) {
        e = entries[i]; g = e._g;
        var p = g.attributes.position;
        var n = g.attributes.normal;
        var t = g.attributes.uv;
        var mtx = e.matrix || _identity;
        nm.getNormalMatrix(mtx);
        for (var v = 0; v < p.count; v++) {
          _v1.fromBufferAttribute(p, v).applyMatrix4(mtx);
          pos[(off + v) * 3] = _v1.x; pos[(off + v) * 3 + 1] = _v1.y; pos[(off + v) * 3 + 2] = _v1.z;
          if (nrm && n) {
            _v2.fromBufferAttribute(n, v).applyMatrix3(nm).normalize();
            nrm[(off + v) * 3] = _v2.x; nrm[(off + v) * 3 + 1] = _v2.y; nrm[(off + v) * 3 + 2] = _v2.z;
          }
          if (uv && t) { uv[(off + v) * 2] = t.getX(v); uv[(off + v) * 2 + 1] = t.getY(v); }
        }
        off += p.count;
        if (g !== e.geometry) g.dispose();
        delete e._g;
      }
      var out = new THREE.BufferGeometry();
      out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      if (nrm) out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      if (uv) out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      out.computeBoundingSphere();
      out.computeBoundingBox();
      return out;
    },
    // Scale UVs to world size so tiling stays consistent across differently
    // sized surfaces. Without this, texture density visibly jumps between props.
    worldUV: function (geometry, scale) {
      var p = geometry.attributes.position, n = geometry.attributes.normal;
      var uv = new Float32Array(p.count * 2);
      for (var i = 0; i < p.count; i++) {
        var nx = Math.abs(n.getX(i)), ny = Math.abs(n.getY(i)), nz = Math.abs(n.getZ(i));
        var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        if (ny >= nx && ny >= nz) { uv[i * 2] = x * scale; uv[i * 2 + 1] = z * scale; }
        else if (nx >= nz) { uv[i * 2] = z * scale; uv[i * 2 + 1] = y * scale; }
        else { uv[i * 2] = x * scale; uv[i * 2 + 1] = y * scale; }
      }
      geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      return geometry;
    },
    // Duplicate uv -> uv1 (three.js reads AO from the second UV set).
    copyUV1: function (geometry) {
      if (geometry.attributes.uv && !geometry.attributes.uv1) {
        geometry.setAttribute('uv1', geometry.attributes.uv.clone());
      }
      return geometry;
    },
    // Slightly bevelled box. Perfectly sharp 90-degree edges never catch a
    // highlight, which is a major reason cheap 3D reads as "computer graphics".
    bevelBox: function (w, h, d, bevel, seg) {
      bevel = Math.min(bevel || 0.01, Math.min(w, h, d) * 0.45);
      var g = new THREE.BoxGeometry(w, h, d, seg || 1, seg || 1, seg || 1);
      // push vertices inward along their component axes to fake a chamfer
      var p = g.attributes.position;
      var hw = w / 2, hh = h / 2, hd = d / 2;
      for (var i = 0; i < p.count; i++) {
        var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        var ex = Math.abs(Math.abs(x) - hw) < 1e-5;
        var ey = Math.abs(Math.abs(y) - hh) < 1e-5;
        var ez = Math.abs(Math.abs(z) - hd) < 1e-5;
        var n = (ex ? 1 : 0) + (ey ? 1 : 0) + (ez ? 1 : 0);
        if (n >= 2) {
          if (ex) x -= Math.sign(x) * bevel;
          if (ey) y -= Math.sign(y) * bevel;
          if (ez) z -= Math.sign(z) * bevel;
          p.setXYZ(i, x, y, z);
        }
      }
      g.computeVertexNormals();
      return g;
    }
  };
  var _identity = new THREE.Matrix4();

  // --------------------------------------------------------------------------
  // Colour helpers - working in linear space matters for anything additive.
  // --------------------------------------------------------------------------
  GAME.Color = {
    // Physically-plausible blackbody colour, for muzzle flash / sparks / lamps.
    kelvin: function (k, out) {
      out = out || new THREE.Color();
      var t = k / 100, r, g, b;
      if (t <= 66) { r = 255; g = 99.47 * Math.log(t) - 161.12; }
      else { r = 329.7 * Math.pow(t - 60, -0.1332); g = 288.12 * Math.pow(t - 60, -0.0755); }
      if (t >= 66) b = 255;
      else if (t <= 19) b = 0;
      else b = 138.52 * Math.log(t - 10) - 305.04;
      out.setRGB(M.saturate(r / 255), M.saturate(g / 255), M.saturate(b / 255),
        THREE.SRGBColorSpace);
      return out;
    }
  };

  // --------------------------------------------------------------------------
  // Async helpers - lets heavy procedural generation yield so the loading
  // screen can actually paint instead of the tab locking up.
  // --------------------------------------------------------------------------
  // Yield so the loading screen can paint between heavy generation steps.
  // requestAnimationFrame is preferred (it paints), but it does NOT fire in a
  // hidden or backgrounded tab - so racing it against a timer is what stops
  // boot from hanging forever when the game is opened in a background tab.
  GAME.yieldFrame = function () {
    return new Promise(function (resolve) {
      if (GAME.headless) { resolve(); return; }
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      }
      var timer = setTimeout(finish, 60);
      requestAnimationFrame(finish);
    });
  };

  GAME.logError = function (where, e) {
    var msg = '[' + where + '] ' + (e && e.stack ? e.stack : e);
    (GAME.errors || (GAME.errors = [])).push(msg);
    if (window.console) console.error(msg);
  };

  // Fullscreen triangle - covers the viewport with 3 verts and no seam.
  // Used by every post-process pass.
  GAME.fullscreenGeometry = function () {
    if (GAME._fsg) return GAME._fsg;
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(
      new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);
    return (GAME._fsg = g);
  };

  GAME.bus = new EventBus();
  GAME.tmp = {
    v1: new THREE.Vector3(), v2: new THREE.Vector3(), v3: new THREE.Vector3(),
    v4: new THREE.Vector3(), q1: new THREE.Quaternion(), m1: new THREE.Matrix4(),
    c1: new THREE.Color(), e1: new THREE.Euler()
  };

})(window, window.THREE);
