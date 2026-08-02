// ============================================================================
// OPERATION BLACKOUT - ballistics
// Owns: what actually happens when a round leaves the muzzle.
//
//   * hitscan rounds with real distance-based damage falloff
//   * simulated projectiles (velocity, gravity, quadratic drag) advanced in
//     fixed sub-steps with a swept raycast per step, so an 880 m/s round can
//     never tunnel through a 2 mm sheet of corrugated metal
//   * per-part enemy hitboxes with damage multipliers (head 3.0, torso 1.0,
//     limbs 0.75)
//   * material-driven wall penetration - the signature CoD "wallbang"
//   * grazing-angle ricochet off hard surfaces
//   * radial explosive damage with line-of-sight occlusion
//
// Everything in the hot path comes out of a pool or a ring buffer: emptying a
// 30-round magazine into a crowd must not produce a single GC allocation.
//
// Robustness rule for this file: every cross-module call is optional. vfx,
// audio, hud, ai, level and props may all be missing or broken; ballistics
// still has to resolve the shot and must never throw.
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  var M = GAME.Math;
  var Collision = GAME.Collision;

  // --------------------------------------------------------------------------
  // SCRATCH VECTORS
  //
  // These are module-scope so the hot path allocates nothing, which means
  // aliasing is a real hazard: _trace() recurses into _traceColliders() and
  // _hitboxesFor(), and a probe issues a nested _trace() while its caller still
  // holds a live result. Each block below is owned by exactly one function, so
  // no callee can ever stomp a caller's vector.
  // --------------------------------------------------------------------------
  var _UP = new THREE.Vector3(0, 1, 0);
  var _FWD = new THREE.Vector3(0, 0, 1);

  // owned by _traceColliders
  var _tc1 = new THREE.Vector3(), _tc2 = new THREE.Vector3();
  var _tcMin = new THREE.Vector3(), _tcMax = new THREE.Vector3();
  // owned by _traceEnemies / _ensureHash
  var _te1 = new THREE.Vector3();
  var _hsMin = new THREE.Vector3(), _hsMax = new THREE.Vector3();
  // owned by the hitbox builders
  var _hb1 = new THREE.Vector3(), _hb2 = new THREE.Vector3();
  var _hbQ = new THREE.Quaternion();
  // owned by _probeThickness / _fleshExit
  var _pb1 = new THREE.Vector3(), _pb2 = new THREE.Vector3();
  // owned by _losFactor
  var _lo1 = new THREE.Vector3();
  // owned by _suppress
  var _su1 = new THREE.Vector3();
  // owned by _whizz
  var _wz1 = new THREE.Vector3(), _wz2 = new THREE.Vector3(), _wz3 = new THREE.Vector3();
  // owned by _sfx
  var _sfxPos = new THREE.Vector3();
  // owned by _resolveHit / _resolveFlesh / _applyDamage
  var _rs1 = new THREE.Vector3(), _rs2 = new THREE.Vector3();
  var _rs3 = new THREE.Vector3(), _rs4 = new THREE.Vector3();
  var _dmgDir = new THREE.Vector3();
  // owned by _stepProjectile / _bounce
  var _pj1 = new THREE.Vector3(), _pj2 = new THREE.Vector3(), _pj3 = new THREE.Vector3();
  var _pjQ = new THREE.Quaternion();
  // owned by fireShot / _hitscan
  var _fs1 = new THREE.Vector3(), _fs2 = new THREE.Vector3(), _fsEnd = new THREE.Vector3();
  // owned by explode
  var _ex1 = new THREE.Vector3(), _ex2 = new THREE.Vector3();
  var _ex3 = new THREE.Vector3(), _ex4 = new THREE.Vector3();
  // owned by the public raycast() helper
  var _rc1 = new THREE.Vector3();
  // raycast out-params handed to GAME.Collision
  var _boxHit = { point: new THREE.Vector3(), normal: new THREE.Vector3() };
  var _probeHit = { point: new THREE.Vector3(), normal: new THREE.Vector3() };

  // --------------------------------------------------------------------------
  // MATERIAL TABLE
  //
  // `pen` is the penetration cost of one metre of the material, in the same
  // arbitrary "penetration power" units as weapon.penetration. A 5.56 carbine
  // carries ~120 power, so:
  //     0.09 m plaster  ->  0.09 * 90   =   8  -> straight through, barely slowed
  //     0.10 m brick    ->  0.10 * 820  =  82  -> through, badly slowed
  //     0.10 m concrete ->  0.10 * 1400 = 140  -> stopped dead
  //     0.30 m sandbag  ->  0.30 * 1500 = 450  -> stopped dead
  // which is roughly how these materials behave against rifle ball ammunition.
  //
  // `ric`      base ricochet probability at a fully grazing incidence
  // `hard`     0..1, drives spark/dust flavour and ricochet sharpness
  // `nominal`  assumed thickness when the exit probe cannot measure one
  // `fallback` true if a failed exit probe should assume `nominal`. Thin sheet
  //            geometry is usually modelled as a single-sided plane, which a
  //            reverse probe cannot see - without this, sheet metal and
  //            plasterboard would end up bulletproof.
  // `soft`     damage retention through the material
  // --------------------------------------------------------------------------
  function matdef(kind, pen, ric, hard, nominal, fallback, soft, flesh) {
    return {
      kind: kind, pen: pen, ric: ric, hard: hard,
      nominal: nominal, fallback: fallback, soft: soft, flesh: !!flesh
    };
  }

  var MAT = {
    //                        kind            pen   ric   hard  nominal fb     soft  flesh
    concrete:         matdef('concrete',      1400, 0.34, 0.92, 0.25,  false, 0.86),
    concrete_wall:    matdef('concrete',      1250, 0.32, 0.90, 0.20,  false, 0.86),
    brick:            matdef('brick',          820, 0.28, 0.82, 0.20,  false, 0.88),
    plaster:          matdef('plaster',         90, 0.05, 0.35, 0.09,  true,  0.97),
    drywall:          matdef('plaster',         60, 0.03, 0.25, 0.10,  true,  0.98),
    tile:             matdef('tile',           520, 0.40, 0.88, 0.020, true,  0.90),
    asphalt:          matdef('asphalt',       1150, 0.26, 0.72, 0.30,  false, 0.86),
    gravel:           matdef('gravel',        1300, 0.12, 0.55, 0.30,  false, 0.84),
    sand:             matdef('sand',          1500, 0.02, 0.30, 0.40,  false, 0.80),
    dirt:             matdef('dirt',           950, 0.05, 0.35, 0.50,  false, 0.84),
    wood_plank:       matdef('wood',           165, 0.11, 0.45, 0.045, true,  0.94),
    wood:             matdef('wood',           165, 0.11, 0.45, 0.045, true,  0.94),
    rusted_metal:     matdef('metal',         1050, 0.42, 0.86, 0.004, true,  0.93),
    painted_metal:    matdef('metal',         1350, 0.52, 0.94, 0.004, true,  0.93),
    corrugated_metal: matdef('metal',          900, 0.50, 0.90, 0.0015, true, 0.95),
    steel:            matdef('metal',         2600, 0.62, 0.98, 0.010, false, 0.88),
    metal:            matdef('metal',         1350, 0.50, 0.92, 0.004, true,  0.93),
    glass:            matdef('glass',          130, 0.04, 0.70, 0.006, true,  0.98),
    fabric:           matdef('fabric',          26, 0.00, 0.10, 0.004, true,  0.99),
    foliage:          matdef('foliage',           9, 0.00, 0.08, 0.020, true, 0.99),
    rubber:           matdef('rubber',         250, 0.07, 0.30, 0.020, true,  0.95),
    water:            matdef('water',          320, 0.55, 0.20, 0.60,  false, 0.70),
    flesh:            matdef('flesh',          230, 0.00, 0.15, 0.26,  true,  0.90, true),
    default:          matdef('concrete',      1100, 0.24, 0.75, 0.22,  false, 0.88)
  };

  // Names other modules may legitimately hand us that are not keys above.
  var MAT_ALIAS = {
    wall: 'concrete_wall', floor: 'concrete', ground: 'asphalt', road: 'asphalt',
    stone: 'concrete', rock: 'concrete', stucco: 'plaster', crate: 'wood_plank',
    plank: 'wood_plank', sheet_metal: 'corrugated_metal', corrugated: 'corrugated_metal',
    metal_painted: 'painted_metal', rust: 'rusted_metal', iron: 'steel',
    cloth: 'fabric', canvas: 'fabric', awning: 'fabric', tarp: 'fabric',
    leaf: 'foliage', plant: 'foliage', bush: 'foliage', palm: 'foliage',
    tyre: 'rubber', tire: 'rubber', body: 'flesh', enemy: 'flesh', player: 'flesh',
    window: 'glass', mud: 'dirt', puddle: 'water', sandbag: 'sand'
  };

  function materialDef(name) {
    if (!name) return MAT.default;
    var k = ('' + name).toLowerCase();
    var d = MAT[k];
    if (d) return d;
    var a = MAT_ALIAS[k];
    if (a && MAT[a]) return MAT[a];
    // Last resort: substring sniff, so 'wall_concrete_02' still resolves.
    for (var key in MAT) {
      if (key !== 'default' && k.indexOf(key) >= 0) return MAT[key];
    }
    for (var ak in MAT_ALIAS) {
      if (k.indexOf(ak) >= 0) return MAT[MAT_ALIAS[ak]] || MAT.default;
    }
    return MAT.default;
  }

  // --------------------------------------------------------------------------
  // HITBOX TEMPLATE
  //
  // Offsets in metres from the feet of a 1.80 m militiaman, +Z forward in the
  // enemy's local frame. Used verbatim when ai.js does not publish
  // enemy.hitboxes, and used to fill in multipliers when it does.
  //
  // `thick` is the flesh depth along that part, so a round punching through an
  // arm loses far less energy than one that goes through the chest.
  // --------------------------------------------------------------------------
  var HUMAN = [
    { part: 'head',        o: [0, 1.632, 0.012], h: [0.098, 0.116, 0.108], mult: 3.00, thick: 0.17 },
    { part: 'neck',        o: [0, 1.482, 0.000], h: [0.062, 0.056, 0.062], mult: 2.00, thick: 0.12 },
    { part: 'upper_torso', o: [0, 1.292, 0.000], h: [0.206, 0.166, 0.118], mult: 1.10, thick: 0.24 },
    { part: 'lower_torso', o: [0, 1.032, 0.000], h: [0.176, 0.136, 0.108], mult: 1.00, thick: 0.22 },
    { part: 'pelvis',      o: [0, 0.856, 0.000], h: [0.166, 0.100, 0.106], mult: 1.00, thick: 0.21 },
    { part: 'upper_arm_l', o: [ 0.266, 1.282, 0.000], h: [0.058, 0.162, 0.062], mult: 0.80, thick: 0.11 },
    { part: 'upper_arm_r', o: [-0.266, 1.282, 0.000], h: [0.058, 0.162, 0.062], mult: 0.80, thick: 0.11 },
    { part: 'forearm_l',   o: [ 0.292, 0.972, 0.030], h: [0.050, 0.156, 0.055], mult: 0.75, thick: 0.09 },
    { part: 'forearm_r',   o: [-0.292, 0.972, 0.030], h: [0.050, 0.156, 0.055], mult: 0.75, thick: 0.09 },
    { part: 'thigh_l',     o: [ 0.106, 0.602, 0.000], h: [0.082, 0.226, 0.088], mult: 0.80, thick: 0.15 },
    { part: 'thigh_r',     o: [-0.106, 0.602, 0.000], h: [0.082, 0.226, 0.088], mult: 0.80, thick: 0.15 },
    { part: 'shin_l',      o: [ 0.108, 0.198, 0.000], h: [0.062, 0.200, 0.072], mult: 0.70, thick: 0.11 },
    { part: 'shin_r',      o: [-0.108, 0.198, 0.000], h: [0.062, 0.200, 0.072], mult: 0.70, thick: 0.11 },
    { part: 'foot_l',      o: [ 0.110, 0.046, 0.052], h: [0.060, 0.046, 0.116], mult: 0.60, thick: 0.08 },
    { part: 'foot_r',      o: [-0.110, 0.046, 0.052], h: [0.060, 0.046, 0.116], mult: 0.60, thick: 0.08 }
  ];

  // Brief-mandated multipliers: head 3.0, torso 1.0, limbs 0.75. The neck and
  // upper-chest values in between are the usual CoD refinement.
  var PART_MULT = {
    head: 3.0, skull: 3.0, face: 3.0, helmet: 2.4,
    neck: 2.0, throat: 2.0,
    chest: 1.10, upper_torso: 1.10, uppertorso: 1.10, spine: 1.10,
    torso: 1.00, lower_torso: 1.00, lowertorso: 1.00, stomach: 1.00,
    abdomen: 1.00, pelvis: 1.00, hips: 1.00, body: 1.00,
    upper_arm: 0.80, upperarm: 0.80, shoulder: 0.85, forearm: 0.75,
    elbow: 0.75, hand: 0.60, arm: 0.75,
    thigh: 0.80, knee: 0.75, shin: 0.70, calf: 0.70, foot: 0.60, leg: 0.75
  };

  var PART_THICK = {
    head: 0.17, neck: 0.12, chest: 0.24, upper_torso: 0.24, torso: 0.23,
    lower_torso: 0.22, stomach: 0.22, pelvis: 0.21, upper_arm: 0.11,
    forearm: 0.09, hand: 0.05, arm: 0.10, thigh: 0.15, shin: 0.11,
    foot: 0.08, leg: 0.14
  };

  // Strip side prefixes/suffixes so 'L_UpperArm', 'arm_r' and 'right_forearm'
  // all resolve to the same multiplier.
  function normalisePart(name) {
    if (!name) return 'torso';
    var s = ('' + name).toLowerCase().replace(/[\s.-]+/g, '_');
    s = s.replace(/^mixamorig_?/, '');
    s = s.replace(/^(l|r|left|right)_/, '').replace(/_(l|r|left|right)$/, '');
    s = s.replace(/_?\d+$/, '');
    return s || 'torso';
  }

  function lookupPart(table, name, fallback) {
    var s = normalisePart(name);
    if (table[s] !== undefined) return table[s];
    for (var k in table) if (s.indexOf(k) >= 0) return table[k];
    return fallback;
  }
  function partMultiplier(name) { return lookupPart(PART_MULT, name, 1.0); }
  function partThickness(name) { return lookupPart(PART_THICK, name, 0.20); }

  // --------------------------------------------------------------------------
  // WEAPON BALLISTIC PRESETS
  //
  // weapons.js owns the weapon definitions; we only fill in what it did not
  // specify. Velocities and drag are real-ish: 5.56x45 leaves a 14.5" barrel at
  // ~880 m/s and is down to ~700 m/s by 300 m, which is where the drag constant
  // comes from (v = v0*exp(-k*x), k = ln(880/700)/300 = 7.6e-4 per metre).
  // --------------------------------------------------------------------------
  var BASE_SPEC = {
    kind: 'bullet',
    damage: 32,             // damage inside rangeNear
    damageFar: 20,          // damage at and beyond rangeFar
    rangeNear: 28,
    rangeFar: 62,
    penetration: 120,
    maxPenetrations: 2,
    muzzleVelocity: 880,
    drag: 7.6e-4,
    gravity: 9.81,
    projectile: false,
    pellets: 1,
    pelletSpread: 0,
    maxRange: 260,
    tracerEvery: 3,
    ricochetScale: 1.0,
    explosive: 0,
    blastRadius: 0,
    fuse: 0,
    restitution: 0.32,
    owner: 'player',
    multipliers: null
  };

  var PRESETS = {
    rifle: {}, carbine: {}, ar: {}, assault: {},
    smg:     { damage: 26, damageFar: 15, rangeNear: 14, rangeFar: 34, penetration: 70,
               muzzleVelocity: 400, drag: 1.3e-3, maxRange: 180, maxPenetrations: 1 },
    pistol:  { damage: 28, damageFar: 16, rangeNear: 12, rangeFar: 30, penetration: 48,
               muzzleVelocity: 360, drag: 1.5e-3, maxRange: 140, maxPenetrations: 1,
               tracerEvery: 0 },
    shotgun: { damage: 15, damageFar: 5, rangeNear: 7, rangeFar: 19, penetration: 26,
               muzzleVelocity: 380, drag: 4.0e-3, maxRange: 90, pellets: 8,
               pelletSpread: 0.038, maxPenetrations: 1, tracerEvery: 0 },
    sniper:  { damage: 95, damageFar: 70, rangeNear: 70, rangeFar: 160, penetration: 320,
               muzzleVelocity: 830, drag: 4.6e-4, maxRange: 420, projectile: true,
               maxPenetrations: 3, tracerEvery: 1 },
    dmr:     { damage: 55, damageFar: 38, rangeNear: 48, rangeFar: 110, penetration: 200,
               muzzleVelocity: 800, drag: 5.6e-4, maxRange: 340, maxPenetrations: 2 },
    lmg:     { damage: 34, damageFar: 24, rangeNear: 34, rangeFar: 80, penetration: 165,
               muzzleVelocity: 900, drag: 7.0e-4, maxRange: 300, tracerEvery: 2 },
    // Grenade drag is the real thing for a ~400 g fist-sized body:
    // Cd*A*rho/(2m) = 0.5*0.0035*1.2/(2*0.4) ~ 0.006 per metre.
    grenade: { kind: 'grenade', projectile: true, muzzleVelocity: 17, drag: 0.006,
               damage: 0, damageFar: 0, explosive: 145, blastRadius: 6.5, fuse: 2.6,
               restitution: 0.34, tracerEvery: 0, maxRange: 90 },
    rocket:  { kind: 'rocket', projectile: true, muzzleVelocity: 74, drag: 2.0e-4,
               gravity: 2.4, damage: 0, damageFar: 0, explosive: 210, blastRadius: 8.0,
               tracerEvery: 1, maxRange: 300 }
  };

  // Guess a preset when the weapon does not state its class outright.
  function presetFor(weapon) {
    if (!weapon) return null;
    var explicit = weapon.class || weapon.category || weapon.ballisticClass;
    if (explicit && PRESETS[('' + explicit).toLowerCase()]) {
      return PRESETS[('' + explicit).toLowerCase()];
    }
    var n = ('' + (weapon.name || weapon.id || '')).toLowerCase();
    if (!n) return null;
    if (/frag|grenade|nade/.test(n)) return PRESETS.grenade;
    if (/rpg|rocket|launcher|law|at4/.test(n)) return PRESETS.rocket;
    if (/sniper|awp|barrett|kar98|intervention|l96/.test(n)) return PRESETS.sniper;
    if (/dmr|marksman|sr25|scar-h|mk14|ebr/.test(n)) return PRESETS.dmr;
    if (/shotgun|spas|benelli|870|saiga|striker/.test(n)) return PRESETS.shotgun;
    if (/lmg|m249|rpk|pkm|saw|mg4|mg42/.test(n)) return PRESETS.lmg;
    if (/smg|mp5|mp7|vector|uzi|p90|scorpion|mac10/.test(n)) return PRESETS.smg;
    if (/pistol|glock|deagle|1911|beretta|revolver|usp/.test(n)) return PRESETS.pistol;
    return null;
  }

  // --------------------------------------------------------------------------
  // Trace result. One instance per nesting depth: the impact resolver holds a
  // live result while a thickness probe issues another trace underneath it.
  // --------------------------------------------------------------------------
  function TraceHit() {
    this.hit = false;
    this.point = new THREE.Vector3();
    this.normal = new THREE.Vector3(0, 1, 0);
    this.distance = 0;
    this.material = 'concrete';
    this.enemy = null;
    this.part = null;
    this.box = null;
    this.mult = 1;
    this.thick = 0.2;
    this.collider = null;
    this.isPlayer = false;
  }
  TraceHit.prototype.clear = function (maxDist) {
    this.hit = false;
    this.distance = maxDist;
    this.enemy = null; this.part = null; this.box = null;
    this.collider = null; this.isPlayer = false;
    this.mult = 1; this.thick = 0.2;
    this.material = 'concrete';
    return this;
  };

  // --------------------------------------------------------------------------
  // Public hit record, returned from fireShot(). Drawn from a ring buffer, so
  // records stay valid for the next ~192 hits - far longer than any consumer
  // needs - at zero allocation cost. Do not retain them past the frame.
  // --------------------------------------------------------------------------
  function HitRecord() {
    this.point = new THREE.Vector3();
    this.normal = new THREE.Vector3();
    this.direction = new THREE.Vector3();
    this.distance = 0;
    this.target = null;
    this.part = null;
    this.material = 'concrete';
    this.materialName = 'concrete';
    this.damage = 0;
    this.penetrated = false;
    this.ricochet = false;
    this.killed = false;
    this.kind = 'world';        // 'world' | 'enemy' | 'player'
  }
  HitRecord.prototype.reset = function () {
    this.distance = 0; this.target = null; this.part = null;
    this.material = 'concrete'; this.materialName = 'concrete';
    this.damage = 0; this.penetrated = false; this.ricochet = false;
    this.killed = false; this.kind = 'world';
    return this;
  };

  // --------------------------------------------------------------------------
  // Shot state, carried through a penetration/ricochet chain. One instance for
  // hitscan (resolved synchronously) plus one per live projectile.
  // --------------------------------------------------------------------------
  function ShotState() {
    this.point = new THREE.Vector3();
    this.dir = new THREE.Vector3(0, 0, -1);
    this.segStart = new THREE.Vector3();
    this.spec = BASE_SPEC;
    this.weapon = null;
    this.results = null;
    this.owner = 'player';
    this.shooter = null;
    this.energy = 1;
    this.penLeft = 120;
    this.pens = 0;
    this.distance = 0;
    this.tracer = false;
    this.flags = 0;
  }

  function Projectile() {
    this.active = false;
    this.pos = new THREE.Vector3();
    this.prev = new THREE.Vector3();
    this.frameStart = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.spin = new THREE.Vector3();
    this.st = new ShotState();
    this.life = 0;
    this.maxLife = 8;
    this.fuse = 0;
    this.armed = false;
    this.resting = false;
    this.bounces = 0;
    this.mesh = null;
  }

  var SKIP_ENEMIES = 1, SKIP_PLAYER = 2, SKIP_WORLD = 4, SKIP_PROPS = 8;
  var RES_STOP = 0, RES_CONTINUE = 1;

  function isAlive(e) {
    if (!e) return false;
    if (e.dead === true || e.isDead === true) return false;
    if (e.alive === false) return false;
    if (e.state === 'dead' || e.state === 'death') return false;
    if (typeof e.health === 'number' && e.health <= 0) return false;
    return true;
  }

  function vec3Of(o) {
    if (!o) return null;
    if (o.isVector3) return o;
    if (typeof o.x === 'number' && typeof o.y === 'number' && typeof o.z === 'number') return o;
    return null;
  }

  function clampNum(v, lo, hi, fallback) {
    if (typeof v !== 'number' || !isFinite(v)) return fallback;
    return v < lo ? lo : (v > hi ? hi : v);
  }

  // r = d - 2(d.n)n
  function reflect(d, n, out) {
    out.copy(d).addScaledVector(n, -2 * d.dot(n));
    return out.normalize();
  }

  // ==========================================================================
  //  BALLISTICS
  // ==========================================================================
  class Ballistics {
    constructor(ctx) {
      this.ctx = ctx || {};

      // Fork our own RNG stream. If ballistics drew from the shared ctx.rng,
      // every other system's procedural output would shift the moment the
      // player pulled the trigger, and captures would stop being reproducible.
      this.rng = (this.ctx.rng && this.ctx.rng.fork)
        ? this.ctx.rng.fork(0xBA11) : new GAME.RNG(0xBA115713);

      this.enabled = true;
      this.substep = 1 / 240;        // fixed integration step for projectiles
      this.maxSubsteps = 12;
      this._acc = 0;
      this._frameId = 0;

      // ---- pools -----------------------------------------------------------
      this._projectiles = new GAME.Pool(
        function () { return new Projectile(); },
        function (p) {
          p.active = false; p.resting = false; p.armed = false;
          p.bounces = 0; p.life = 0; p.fuse = 0;
          p.st.results = null; p.st.weapon = null; p.st.shooter = null;
          if (p.mesh) p.mesh.visible = false;
        }, 24);

      this._recRing = [];
      for (var i = 0; i < 192; i++) this._recRing.push(new HitRecord());
      this._recCur = 0;

      // Result arrays come from a ring too, so fireShot() allocates nothing.
      this._arrRing = [];
      for (i = 0; i < 8; i++) this._arrRing.push([]);
      this._arrCur = 0;

      // 0 hitscan, 1 thickness probe, 2 line-of-sight, 3 projectile, 4 public
      this._th = [];
      for (i = 0; i < 5; i++) this._th.push(new TraceHit());

      this._st = new ShotState();
      this._specCache = (typeof WeakMap === 'function') ? new WeakMap() : null;
      this._defaultSpec = this._makeSpec(null);

      // ---- broadphase ------------------------------------------------------
      this._hashes = Object.create(null);
      this._qbuf = [];
      this._hbCache = (typeof WeakMap === 'function') ? new WeakMap() : null;
      this._playerHitboxes = [];

      // ---- exit-probe output ----------------------------------------------
      this._exitPoint = new THREE.Vector3();
      this._exitNormal = new THREE.Vector3();

      // ---- per-frame budgets ----------------------------------------------
      this._sfxBudget = 8;
      this._whizzBudget = 3;
      this._traceBudget = 512;

      // ---- graceful degradation flags -------------------------------------
      this._levelRayOk = true;
      this._levelRayFails = 0;
      this._propsRayOk = true;
      this._propsRayFails = 0;

      this._shotCounter = 0;
      this._grenadeGeo = null; this._grenadeMat = null;
      this._rocketGeo = null; this._rocketMat = null;

      this.stats = {
        shots: 0, pellets: 0, hits: 0, headshots: 0, kills: 0,
        penetrations: 0, ricochets: 0, explosions: 0, traces: 0
      };

      // Other systems (AI cover reasoning, debug overlay) can read the tables
      // instead of duplicating the numbers.
      this.materialTable = MAT;
    }

    // ------------------------------------------------------------------------
    async build(ctx) {
      if (ctx) this.ctx = ctx;
      // Warm the projectile pool so the first grenade of a firefight does not
      // allocate mid-frame.
      var warm = [];
      for (var i = 0; i < 24; i++) warm.push(this._projectiles.acquire());
      for (i = warm.length - 1; i >= 0; i--) this._projectiles.release(warm[i]);
      warm.length = 0;
      if (GAME.yieldFrame) await GAME.yieldFrame();
      return this;
    }

    // ========================================================================
    //  PUBLIC API
    // ========================================================================

    /**
     * Fire one shot. Returns an array of hit records for this trigger pull -
     * one per pellet per surface crossed. For projectile weapons the array is
     * empty; those hits arrive later, through the same record path, when the
     * round actually lands.
     *
     * The array and its records live in ring buffers: read them now, do not
     * store them.
     */
    fireShot(origin, direction, weapon) {
      var out = this._arr();
      if (!this.enabled) return out;
      var o = vec3Of(origin), d = vec3Of(direction);
      if (!o || !d) return out;

      try {
        var spec = this.specFor(weapon);
        this.stats.shots++;
        var owner = spec.owner || (weapon && weapon.owner) || 'player';

        _fs1.copy(d);
        if (_fs1.lengthSq() < 1e-12) _fs1.set(0, 0, -1);
        _fs1.normalize();

        var pellets = Math.max(1, spec.pellets | 0);
        for (var i = 0; i < pellets; i++) {
          this.stats.pellets++;
          _fs2.copy(_fs1);
          if (pellets > 1 && spec.pelletSpread > 0) {
            // sqrt() of a uniform draw gives an area-uniform disc, so the
            // pattern is dense in the middle and thins toward the rim - the
            // shape a real choke throws.
            var sp = spec.pelletSpread * Math.sqrt(this.rng.next());
            this.rng.inCone(_fs1, sp, _fs2);
            _fs2.normalize();
          }
          var tracer = this._tracerTick(spec, i);
          if (spec.projectile) {
            this.spawnProjectile(o, _fs2, weapon, { spec: spec, tracer: tracer, owner: owner });
          } else {
            this._hitscan(o, _fs2, spec, weapon, out, owner, tracer);
          }
        }
      } catch (e) {
        GAME.logError('ballistics.fireShot', e);
      }
      return out;
    }

    /**
     * Spawn a simulated projectile (slow rounds, grenades, rockets).
     * opts: {spec, tracer, owner, speed, shooter, fuse}
     */
    spawnProjectile(origin, direction, weapon, opts) {
      opts = opts || {};
      var o = vec3Of(origin), d = vec3Of(direction);
      if (!o || !d) return null;
      if (this._projectiles.active.length >= 64) return null;
      var spec = opts.spec || this.specFor(weapon);

      var p = this._projectiles.acquire();
      p.active = true;
      p.resting = false;
      p.bounces = 0;
      p.life = 0;
      p.maxLife = spec.kind === 'grenade' ? 12 : 8;
      p.fuse = opts.fuse !== undefined ? opts.fuse : spec.fuse;
      p.armed = p.fuse > 0;
      p.pos.copy(o);
      p.prev.copy(o);
      p.frameStart.copy(o);

      var speed = opts.speed || spec.muzzleVelocity;
      p.vel.copy(d).normalize().multiplyScalar(speed);
      p.spin.set(this.rng.range(-9, 9), this.rng.range(-9, 9), this.rng.range(-9, 9));

      var st = p.st;
      st.point.copy(o);
      st.segStart.copy(o);
      st.dir.copy(d).normalize();
      st.spec = spec;
      st.weapon = weapon || null;
      st.results = null;
      st.owner = opts.owner || spec.owner || 'player';
      st.shooter = opts.shooter || null;
      st.energy = 1;
      st.penLeft = spec.penetration;
      st.pens = 0;
      st.distance = 0;
      st.tracer = !!opts.tracer;
      // The shooter never traces against itself.
      st.flags = st.owner === 'player' ? SKIP_PLAYER : 0;

      if (spec.kind === 'grenade' || spec.kind === 'rocket') this._attachMesh(p, spec);
      return p;
    }

    /**
     * Radial explosive damage with line-of-sight occlusion and falloff.
     * opts: {source, owner, weapon, silent, friendlyFire}
     * Returns the number of entities damaged.
     */
    explode(point, radius, damage, opts) {
      opts = opts || {};
      var ctx = this.ctx;
      var p = vec3Of(point);
      if (!p) return 0;
      radius = radius || 6;
      damage = damage === undefined ? 140 : damage;
      var applied = 0;
      this.stats.explosions++;

      if (!opts.silent) {
        if (ctx.vfx && ctx.vfx.explosion) {
          try { ctx.vfx.explosion(p, radius); } catch (e) { GAME.logError('vfx.explosion', e); }
        }
        this._sfx('explosion', p, 1.0, 1.0, true);
        if (ctx.postfx && ctx.postfx.addImpulse && ctx.camera) {
          var s = M.saturate(1 - ctx.camera.position.distanceTo(p) / (radius * 3.2));
          if (s > 0.01) {
            try { ctx.postfx.addImpulse('explosion', s); }
            catch (e2) { GAME.logError('postfx.addImpulse', e2); }
          }
        }
      }

      // ---- enemies ---------------------------------------------------------
      var enemies = (ctx.ai && ctx.ai.enemies) || null;
      if (enemies && enemies.length) {
        for (var i = 0; i < enemies.length; i++) {
          var e = enemies[i];
          if (!isAlive(e) || e === opts.source) continue;
          if (!this._enemyCenter(e, _ex1)) continue;
          var dist = _ex1.distanceTo(p);
          if (dist > radius) continue;
          // A slightly convex falloff gives a tight kill radius and a fringe
          // that only wounds - much better read than a linear ramp.
          var f = Math.pow(M.saturate(1 - dist / radius), 1.45);
          _ex2.copy(_ex1).sub(p);
          if (_ex2.lengthSq() < 1e-8) _ex2.copy(_UP);
          _ex2.normalize();
          var los = this._losFactor(p, _ex1);
          var dmg = damage * f * los;
          if (dmg < 1) continue;
          this._applyDamage(e, dmg, 'torso', _ex2, opts.weapon || null,
            opts.owner || 'player', true);
          applied++;
        }
      }

      // ---- player ----------------------------------------------------------
      var pl = ctx.player;
      if (pl && pl.takeDamage && (opts.owner !== 'player' || opts.friendlyFire !== false)) {
        this._playerCenter(_ex3);
        var pd = _ex3.distanceTo(p);
        if (pd <= radius) {
          var pf = Math.pow(M.saturate(1 - pd / radius), 1.45);
          _ex4.copy(_ex3).sub(p);
          if (_ex4.lengthSq() < 1e-8) _ex4.copy(_UP);
          _ex4.normalize();
          var plos = this._losFactor(p, _ex3);
          var pdmg = damage * pf * plos * (opts.owner === 'player' ? 0.55 : 1.0);
          if (pdmg >= 1) {
            try { pl.takeDamage(pdmg, _ex4); }
            catch (e3) { GAME.logError('player.takeDamage', e3); }
            if (ctx.hud && ctx.hud.damageIndicator) {
              try { ctx.hud.damageIndicator(_ex4); }
              catch (e4) { GAME.logError('hud.damageIndicator', e4); }
            }
            applied++;
          }
        }
      }

      // ---- scorch the ground under the blast --------------------------------
      if (ctx.vfx && ctx.vfx.decal) {
        _ex2.set(0, -1, 0);
        this._trace(p, _ex2, radius * 0.7, SKIP_ENEMIES | SKIP_PLAYER, this._th[2]);
        if (this._th[2].hit) {
          try { ctx.vfx.decal(this._th[2].point, this._th[2].normal, 'scorch', radius * 0.55); }
          catch (e5) { GAME.logError('vfx.decal', e5); }
        }
      }

      this._suppress(p, radius * 1.6);
      if (ctx.bus) ctx.bus.emit('explosion', p, radius);
      return applied;
    }

    /**
     * General purpose world trace for other systems (AI line of sight, player
     * probes). Returns the shared TraceHit at slot 4 - copy out what you need
     * before calling again.
     */
    raycast(origin, dir, maxDist, flags) {
      var th = this._th[4];
      var o = vec3Of(origin), d = vec3Of(dir);
      maxDist = maxDist || 100;
      th.clear(maxDist);
      if (!o || !d) return th;
      _rc1.copy(d);
      if (_rc1.lengthSq() < 1e-12) return th;
      _rc1.normalize();
      this._trace(o, _rc1, maxDist, flags || 0, th);
      return th;
    }

    /** Resolve a weapon into a full ballistic spec (cached per weapon object). */
    specFor(weapon) {
      if (!weapon) return this._defaultSpec;
      if (this._specCache) {
        var c = this._specCache.get(weapon);
        // Re-derive if weapons.js mutated the weapon in place (attachments).
        if (c && c._name === weapon.name && c._dmg === weapon.damage) return c;
      }
      var spec = this._makeSpec(weapon);
      if (this._specCache) {
        try { this._specCache.set(weapon, spec); } catch (e) { /* non-object key */ }
      }
      return spec;
    }

    /** Damage this weapon would do to an unarmoured torso at `dist` metres. */
    damageAtRange(weapon, dist) {
      return this._damageAtRange(this.specFor(weapon), dist);
    }

    // ========================================================================
    //  FRAME UPDATE
    // ========================================================================
    update(dt, ctx) {
      if (ctx) this.ctx = ctx;
      if (!(dt > 0)) dt = 0;
      this._frameId++;
      this._sfxBudget = 8;
      this._whizzBudget = 3;
      this._traceBudget = 512;

      var list = this._projectiles.active;
      if (!list.length) { this._acc = 0; return; }

      var i, p;
      for (i = 0; i < list.length; i++) list[i].frameStart.copy(list[i].pos);

      // Fixed sub-steps keep the drag/gravity integration stable regardless of
      // frame time, and keep captures deterministic. Each sub-step ends with a
      // swept raycast, so even a 3.7 m sub-step cannot tunnel.
      this._acc += dt;
      var h = this.substep;
      var steps = 0;
      while (this._acc >= h && steps < this.maxSubsteps) {
        this._acc -= h;
        steps++;
        for (i = list.length - 1; i >= 0; i--) {
          p = list[i];
          if (!p.active) { this._projectiles.releaseAt(i); continue; }
          try { this._stepProjectile(p, h); }
          catch (e) { GAME.logError('ballistics.projectile', e); p.active = false; }
        }
      }
      // Never let the accumulator run away after a hitch.
      if (this._acc > h * this.maxSubsteps) this._acc = 0;

      // Presentation is per frame, not per sub-step: one tracer streak and at
      // most one whizz-by cue per projectile per frame.
      for (i = list.length - 1; i >= 0; i--) {
        p = list[i];
        if (p.active) {
          if (p.st.tracer && p.st.spec.kind === 'bullet') {
            this._tracer(p.frameStart, p.pos, p.st.spec);
          }
          this._whizz(p.frameStart, p.pos, p.st);
          this._orientMesh(p, dt);
          p.life += dt;
          if (p.armed) {
            p.fuse -= dt;
            if (p.fuse <= 0) this._detonate(p);
          }
          if (p.active && p.life > p.maxLife) this._kill(p);
        }
        if (!p.active) this._projectiles.releaseAt(i);
      }
    }

    resize() { /* nothing viewport-dependent lives here */ }

    dispose() {
      this._projectiles.releaseAll();
      if (this._grenadeGeo) this._grenadeGeo.dispose();
      if (this._rocketGeo) this._rocketGeo.dispose();
      if (this._grenadeMat) this._grenadeMat.dispose();
      if (this._rocketMat) this._rocketMat.dispose();
      this._grenadeGeo = this._rocketGeo = null;
      this._grenadeMat = this._rocketMat = null;
    }

    // ========================================================================
    //  SPEC CONSTRUCTION
    // ========================================================================
    _makeSpec(weapon) {
      var s = {}, k;
      for (k in BASE_SPEC) s[k] = BASE_SPEC[k];
      var preset = presetFor(weapon);
      if (preset) for (k in preset) s[k] = preset[k];

      if (weapon) {
        // Explicit fields from weapons.js always win over the preset.
        var b = weapon.ballistics || weapon;
        var explicitFar = false;
        if (typeof b.damageFar === 'number') { s.damageFar = b.damageFar; explicitFar = true; }
        else if (typeof b.minDamage === 'number') { s.damageFar = b.minDamage; explicitFar = true; }
        if (typeof b.damage === 'number') {
          s.damage = b.damage;
          // A weapon that states a damage but no falloff floor gets a sensible
          // one, otherwise a 95-damage sniper would inherit a 20-damage tail.
          if (!explicitFar) s.damageFar = b.damage * 0.62;
        }
        if (typeof b.rangeNear === 'number') s.rangeNear = b.rangeNear;
        if (typeof b.rangeFar === 'number') s.rangeFar = b.rangeFar;
        if (typeof b.range === 'number' && typeof b.rangeFar !== 'number') {
          s.rangeNear = b.range * 0.45; s.rangeFar = b.range;
        }
        if (typeof b.penetration === 'number') s.penetration = b.penetration;
        if (typeof b.maxPenetrations === 'number') s.maxPenetrations = b.maxPenetrations;
        if (typeof b.muzzleVelocity === 'number') s.muzzleVelocity = b.muzzleVelocity;
        else if (typeof b.velocity === 'number') s.muzzleVelocity = b.velocity;
        if (typeof b.drag === 'number') s.drag = b.drag;
        if (typeof b.gravity === 'number') s.gravity = b.gravity;
        if (typeof b.maxRange === 'number') s.maxRange = b.maxRange;
        if (typeof b.pellets === 'number') s.pellets = b.pellets;
        if (typeof b.pelletSpread === 'number') s.pelletSpread = b.pelletSpread;
        if (typeof b.tracerEvery === 'number') s.tracerEvery = b.tracerEvery;
        if (typeof b.explosive === 'number') s.explosive = b.explosive;
        if (typeof b.blastRadius === 'number') s.blastRadius = b.blastRadius;
        if (typeof b.fuse === 'number') s.fuse = b.fuse;
        if (typeof b.restitution === 'number') s.restitution = b.restitution;
        if (b.projectile !== undefined) s.projectile = !!b.projectile;
        if (b.hitscan !== undefined) s.projectile = !b.hitscan;
        if (b.kind) s.kind = b.kind;
        if (b.owner) s.owner = b.owner;
        if (weapon.owner) s.owner = weapon.owner;
        if (b.multipliers) s.multipliers = b.multipliers;
        // Anything explosive must be simulated - a hitscan grenade is nonsense.
        if (s.explosive > 0) s.projectile = true;
      }

      // Sanity clamps. A bad number from another module must not poison the
      // trace loop with NaN or spin a while() forever.
      s.damage = clampNum(s.damage, 0, 1000, BASE_SPEC.damage);
      s.damageFar = clampNum(s.damageFar, 0, s.damage, s.damage * 0.62);
      s.rangeNear = clampNum(s.rangeNear, 0.5, 500, BASE_SPEC.rangeNear);
      s.rangeFar = clampNum(s.rangeFar, s.rangeNear + 0.5, 800, s.rangeNear * 2.2);
      s.penetration = clampNum(s.penetration, 0, 2000, BASE_SPEC.penetration);
      s.maxPenetrations = Math.round(clampNum(s.maxPenetrations, 0, 4, 2));
      s.muzzleVelocity = clampNum(s.muzzleVelocity, 4, 2000, BASE_SPEC.muzzleVelocity);
      s.drag = clampNum(s.drag, 0, 0.5, BASE_SPEC.drag);
      s.gravity = clampNum(s.gravity, 0, 40, BASE_SPEC.gravity);
      s.maxRange = clampNum(s.maxRange, 5, 900, BASE_SPEC.maxRange);
      s.pellets = Math.round(clampNum(s.pellets, 1, 24, 1));
      s.pelletSpread = clampNum(s.pelletSpread, 0, 0.4, 0);
      s.tracerEvery = Math.round(clampNum(s.tracerEvery, 0, 32, 3));
      s.blastRadius = clampNum(s.blastRadius, 0, 60, 0);
      s.explosive = clampNum(s.explosive, 0, 2000, 0);
      s.restitution = clampNum(s.restitution, 0, 0.9, 0.32);

      s._name = weapon ? weapon.name : null;
      s._dmg = weapon ? weapon.damage : null;
      return s;
    }

    // ========================================================================
    //  HITSCAN
    // ========================================================================
    _hitscan(origin, dir, spec, weapon, results, owner, tracer) {
      var st = this._st;
      st.point.copy(origin);
      st.segStart.copy(origin);
      st.dir.copy(dir);
      st.spec = spec;
      st.weapon = weapon || null;
      st.results = results;
      st.owner = owner;
      st.shooter = null;
      st.energy = 1;
      st.penLeft = spec.penetration;
      st.pens = 0;
      st.distance = 0;
      st.tracer = tracer;
      st.flags = owner === 'player' ? SKIP_PLAYER : 0;

      var th = this._th[0];
      // maxPenetrations surfaces, the terminal impact, plus slack for ricochet.
      // This hard cap is what keeps the loop bounded no matter what geometry
      // the level hands us.
      var maxLinks = spec.maxPenetrations + 3;

      for (var link = 0; link < maxLinks; link++) {
        var remain = spec.maxRange - st.distance;
        if (remain <= 0.05) break;

        this._trace(st.point, st.dir, remain, st.flags, th);

        if (!th.hit) {
          // Nothing out there. Still draw the tracer downrange so the round
          // reads as a streak heading into the haze.
          _fsEnd.copy(st.point).addScaledVector(st.dir, Math.min(remain, 140));
          this._segmentFX(st, _fsEnd);
          break;
        }

        this._segmentFX(st, th.point);
        if (this._resolveHit(th, st) === RES_STOP) break;
        st.segStart.copy(st.point);
      }
    }

    // ========================================================================
    //  IMPACT RESOLUTION - shared by hitscan and projectiles
    // ========================================================================
    _resolveHit(th, st) {
      var spec = st.spec;
      st.distance += th.distance;

      if (th.enemy) return this._resolveFlesh(th, st, th.enemy, false);
      if (th.isPlayer) return this._resolveFlesh(th, st, null, true);

      // ---------------------------------------------------------------- world
      var def = materialDef(th.material);
      var cosI = Math.abs(st.dir.dot(th.normal));
      if (cosI > 1) cosI = 1;

      var rec = this._rec();
      rec.point.copy(th.point);
      rec.normal.copy(th.normal);
      rec.direction.copy(st.dir);
      rec.distance = st.distance;
      rec.target = null;
      rec.part = null;
      rec.material = def.kind;
      rec.materialName = th.material;
      rec.damage = 0;
      rec.kind = 'world';
      if (st.results) st.results.push(rec);

      // ------------------------------------------------------------- RICOCHET
      // Only at genuinely shallow incidence (cosI near 0 means the round is
      // skimming almost parallel to the surface), only off hard materials, and
      // only while the round still carries energy.
      if (cosI < 0.34 && def.ric > 0 && st.energy > 0.22 &&
          st.pens < spec.maxPenetrations + 1) {
        var chance = def.ric * M.smoothstep(0.34, 0.03, cosI) *
                     spec.ricochetScale * M.saturate(st.energy);
        if (this.rng.next() < chance) {
          this.stats.ricochets++;
          rec.ricochet = true;

          this._impactFX(th.point, th.normal, def, 'ricochet');
          this._sfx('ricochet', th.point, 0.85, this.rng.range(0.82, 1.28));

          // Reflect, then scatter - a deflected round is never a mirror bounce.
          reflect(st.dir, th.normal, _rs1);
          this.rng.inCone(_rs1, this.rng.range(0.02, 0.16), _rs2);
          st.dir.copy(_rs2).normalize();
          if (st.dir.dot(th.normal) < 0.02) {
            // The scatter pushed it back into the surface; lift it clear.
            st.dir.addScaledVector(th.normal, 0.12).normalize();
          }
          st.energy *= this.rng.range(0.38, 0.62);
          st.penLeft *= 0.6;           // a tumbling round no longer wallbangs
          st.pens++;
          st.point.copy(th.point).addScaledVector(th.normal, 0.012);
          st.tracer = true;            // always worth showing, tracer or not
          this._suppress(th.point, 3.0);
          return RES_CONTINUE;
        }
      }

      // ---------------------------------------------------------- PENETRATION
      if (st.pens < spec.maxPenetrations && st.penLeft > 0 && spec.penetration > 0) {
        // Probe only as deep as this round could conceivably punch: if there is
        // no exit inside that distance the material is simply too thick, and we
        // have saved ourselves a long useless trace.
        var maxProbe = M.clamp(st.penLeft / def.pen * 1.7, 0.02, 1.4);
        var thickness = this._probeThickness(th, st.dir, maxProbe, def);
        if (thickness > 0) {
          // A grazing entry means a longer path through the same wall.
          var cost = def.pen * thickness * M.clamp(1 / Math.max(0.25, cosI), 1, 2.6);

          if (cost <= st.penLeft) {
            this.stats.penetrations++;
            rec.penetrated = true;
            st.penLeft -= cost;
            st.pens++;

            var frac = M.saturate(cost / Math.max(1, spec.penetration));
            st.energy *= M.clamp(M.lerp(0.92, 0.30, frac) * def.soft, 0.10, 0.95);

            // Entry mark plus far-side exit spall. The exit hole is the visible
            // tell that the round went through rather than stopping.
            this._impactFX(th.point, th.normal, def, 'enter');
            this._impactFX(this._exitPoint, this._exitNormal, def, 'exit');
            this._sfx('penetrate_' + def.kind, th.point, 0.5, this.rng.range(0.9, 1.15));

            // Deflection jitter scales with how much of the budget the wall
            // ate: through plasterboard the round barely wobbles, through 8 cm
            // of brick it comes out tumbling and inaccurate.
            this.rng.inCone(st.dir, M.lerp(0.0015, 0.055, frac), _rs1);
            st.dir.copy(_rs1).normalize();

            st.point.copy(this._exitPoint).addScaledVector(st.dir, 0.006);
            st.segStart.copy(st.point);
            this._suppress(this._exitPoint, 2.5);
            return RES_CONTINUE;
          }
        }
      }

      // ----------------------------------------------------------------- STOP
      this._impactFX(th.point, th.normal, def, 'stop');
      this._sfx('impact_' + def.kind, th.point, 0.75, this.rng.range(0.88, 1.14));
      this._suppress(th.point, 3.2);
      st.point.copy(th.point);
      return RES_STOP;
    }

    // ------------------------------------------------------------------------
    _resolveFlesh(th, st, enemy, isPlayerTarget) {
      var ctx = this.ctx;
      var spec = st.spec;
      var def = MAT.flesh;

      var mult = th.mult || 1;
      if (spec.multipliers) {
        var override = spec.multipliers[normalisePart(th.part)];
        if (typeof override === 'number') mult = override;
      }
      var dmg = this._damageAtRange(spec, st.distance) * mult * st.energy;

      var rec = this._rec();
      rec.point.copy(th.point);
      rec.normal.copy(th.normal);
      rec.direction.copy(st.dir);
      rec.distance = st.distance;
      rec.target = enemy;
      rec.part = th.part || 'torso';
      rec.material = 'flesh';
      rec.materialName = 'flesh';
      rec.damage = dmg;
      rec.penetrated = st.pens > 0;
      rec.kind = isPlayerTarget ? 'player' : 'enemy';
      if (st.results) st.results.push(rec);

      this._impactFX(th.point, th.normal, def, 'stop');
      if (ctx.vfx && ctx.vfx.bloodSpray) {
        try { ctx.vfx.bloodSpray(th.point, th.normal); }
        catch (e) { GAME.logError('vfx.bloodSpray', e); }
      }
      this._sfx('impact_flesh', th.point, 0.9, this.rng.range(0.9, 1.1));

      if (isPlayerTarget) {
        var pl = ctx.player;
        if (pl && pl.takeDamage) {
          _rs3.copy(st.dir);
          try { pl.takeDamage(dmg, _rs3); }
          catch (e2) { GAME.logError('player.takeDamage', e2); }
          if (ctx.hud && ctx.hud.damageIndicator) {
            _rs4.copy(st.dir).negate();   // point back toward the shooter
            try { ctx.hud.damageIndicator(_rs4); }
            catch (e3) { GAME.logError('hud.damageIndicator', e3); }
          }
        }
      } else {
        this.stats.hits++;
        if (normalisePart(th.part) === 'head') this.stats.headshots++;
        rec.killed = this._applyDamage(enemy, dmg, rec.part, st.dir,
          st.weapon, st.owner, false);
      }

      // -------------------------------------------------- through-and-through
      // Rifle rounds routinely exit a torso. The exit is computed from the
      // actual hitbox, so the next trace starts outside it and the same part
      // can never be counted twice.
      var thickness = this._fleshExit(th, st.dir);
      var cost = def.pen * thickness;
      if (st.pens < spec.maxPenetrations && cost <= st.penLeft && st.energy > 0.18) {
        this.stats.penetrations++;
        st.penLeft -= cost;
        st.pens++;
        var frac = M.saturate(cost / Math.max(1, spec.penetration));
        st.energy *= M.clamp(M.lerp(0.85, 0.32, frac), 0.12, 0.85);
        rec.penetrated = true;

        _rs3.copy(this._exitPoint);
        _rs4.copy(st.dir);              // the exit wound sprays along the path
        this._impactFX(_rs3, _rs4, def, 'exit');
        if (ctx.vfx && ctx.vfx.bloodSpray) {
          try { ctx.vfx.bloodSpray(_rs3, _rs4); }
          catch (e4) { GAME.logError('vfx.bloodSpray', e4); }
        }
        this.rng.inCone(st.dir, M.lerp(0.004, 0.045, frac), _rs1);
        st.dir.copy(_rs1).normalize();
        st.point.copy(_rs3).addScaledVector(st.dir, 0.006);
        st.segStart.copy(st.point);
        st.distance += thickness;
        return RES_CONTINUE;
      }

      st.point.copy(th.point);
      return RES_STOP;
    }

    // ------------------------------------------------------------------------
    // Apply damage to an enemy and report it. Returns true if this hit killed.
    _applyDamage(enemy, dmg, part, dir, weapon, owner, fromExplosion) {
      var ctx = this.ctx;
      if (!enemy) return false;
      var wasAlive = isAlive(enemy);
      if (!wasAlive) return false;

      _dmgDir.copy(dir);
      try {
        if (typeof enemy.takeDamage === 'function') enemy.takeDamage(dmg, part, _dmgDir);
        else if (typeof enemy.health === 'number') enemy.health -= dmg;
      } catch (e) {
        GAME.logError('enemy.takeDamage', e);
      }

      var killed = !isAlive(enemy);
      if (killed) this.stats.kills++;

      // Only the player gets feedback, and only for their own rounds.
      if (owner === 'player') {
        var hud = ctx.hud;
        if (hud && hud.showHitmarker) {
          var kindStr = killed ? 'kill'
            : ((normalisePart(part) === 'head' && !fromExplosion) ? 'headshot' : 'hit');
          try { hud.showHitmarker(kindStr); }
          catch (e2) { GAME.logError('hud.showHitmarker', e2); }
        }
        if (killed && hud && hud.addKillfeed) {
          try {
            hud.addKillfeed('You', enemy.name || enemy.label || 'Militia',
              (weapon && weapon.name) || (fromExplosion ? 'Frag' : 'Rifle'));
          } catch (e3) { GAME.logError('hud.addKillfeed', e3); }
        }
      }

      if (ctx.bus) ctx.bus.emit(killed ? 'enemy:killed' : 'enemy:hit', enemy, dmg, part);
      return killed;
    }

    // ========================================================================
    //  THICKNESS PROBES
    // ========================================================================

    /**
     * Measure how thick the surface we just hit is, and where the round would
     * emerge. Writes _exitPoint / _exitNormal. Returns thickness in metres, or
     * -1 if the material is effectively impenetrable.
     *
     * Two strategies:
     *  1. Exact - if the trace knew which collider it hit, step just inside and
     *     re-cast. GAME.Collision's slab test returns the far intersection when
     *     the ray starts inside the box.
     *  2. General - fire a REVERSE ray from a point beyond the wall back toward
     *     the entry. The far face is an ordinary front-facing hit for that ray,
     *     so this works against any raycast implementation, including one that
     *     culls back faces and could never see the far side directly.
     */
    _probeThickness(th, dir, maxProbe, def) {
      // ---- 1. exact, when we own the collider ------------------------------
      var col = th.collider;
      if (col) {
        _pb1.copy(th.point).addScaledVector(dir, 0.0015);
        var t = -1;
        if (col.type === 'sphere' && col.center) {
          t = Collision.raycastSphere(_pb1, dir, col.center, col.radius || 0.5, _probeHit);
        } else if (col.halfExtents) {
          t = Collision.raycastBox(_pb1, dir, col, _probeHit);
        }
        if (t > 0 && t < maxProbe) {
          this._exitPoint.copy(_probeHit.point);
          this._exitNormal.copy(_probeHit.normal);
          if (this._exitNormal.dot(dir) < 0) this._exitNormal.negate();
          return t + 0.0015;
        }
        if (t > 0) return -1;    // an exit exists, but deeper than we can punch
      }

      // ---- 2. reverse probe -------------------------------------------------
      _pb1.copy(th.point).addScaledVector(dir, maxProbe);
      _pb2.copy(dir).negate();
      var probe = this._th[1];
      this._trace(_pb1, _pb2, maxProbe * 0.999, SKIP_ENEMIES | SKIP_PLAYER, probe);

      if (probe.hit) {
        var thickness = maxProbe - probe.distance;
        if (thickness > 0.0008) {
          this._exitPoint.copy(probe.point);
          this._exitNormal.copy(probe.normal);
          if (this._exitNormal.dot(dir) < 0) this._exitNormal.negate();
          return thickness;
        }
        // The reverse ray landed on the same plane we entered through: the
        // surface has no modelled thickness at all. Treat it as a sheet.
        return this._nominalExit(th, dir, def);
      }

      // No exit inside the probe. For sheet-like materials that almost always
      // means a single-sided plane, not a solid metre of the stuff.
      if (def.fallback) return this._nominalExit(th, dir, def);
      return -1;
    }

    _nominalExit(th, dir, def) {
      var thickness = def.nominal;
      this._exitPoint.copy(th.point).addScaledVector(dir, thickness);
      this._exitNormal.copy(dir);
      return thickness;
    }

    /** Exact exit point out of a body hitbox. Always succeeds. */
    _fleshExit(th, dir) {
      var thickness = th.thick || 0.2;
      if (th.box) {
        _pb1.copy(th.point).addScaledVector(dir, 0.002);
        var t = Collision.raycastBox(_pb1, dir, th.box, _probeHit);
        if (t > 0 && t < 1.5) {
          this._exitPoint.copy(_probeHit.point);
          return t + 0.002;
        }
      }
      this._exitPoint.copy(th.point).addScaledVector(dir, thickness);
      return thickness;
    }

    // ========================================================================
    //  TRACING
    //  Priority order is fixed: enemies, then the player, then level, then
    //  props. Each stage only narrows `best`, so the nearest surface always
    //  wins regardless of which system owns it.
    // ========================================================================
    _trace(origin, dir, maxDist, flags, out) {
      out.clear(maxDist);
      if (this._traceBudget-- <= 0) return out;
      this.stats.traces++;
      var best = maxDist;
      if (!(flags & SKIP_ENEMIES)) best = this._traceEnemies(origin, dir, best, out);
      if (!(flags & SKIP_PLAYER)) best = this._tracePlayer(origin, dir, best, out);
      if (!(flags & SKIP_WORLD)) best = this._traceLevel(origin, dir, best, out);
      if (!(flags & SKIP_PROPS)) this._traceProps(origin, dir, best, out);
      return out;
    }

    _traceEnemies(origin, dir, best, out) {
      var ctx = this.ctx;
      var enemies = (ctx.ai && ctx.ai.enemies) || null;
      if (!enemies || !enemies.length) return best;

      for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (!isAlive(e)) continue;

        // Broadphase: one sphere test rejects almost every enemy for almost
        // every shot, keeping the 15 box tests below off the hot path.
        if (!this._enemyCenter(e, _te1)) continue;
        var r = ((typeof e.height === 'number' && e.height > 0.5) ? e.height : 1.8) * 0.66;
        var bt = Collision.raycastSphere(origin, dir, _te1, r, null);
        if (bt < 0 || bt > best) continue;

        var boxes = this._hitboxesFor(e);
        for (var b = 0; b < boxes.length; b++) {
          var hb = boxes[b];
          var t = Collision.raycastBox(origin, dir, hb, _boxHit);
          if (t < 0 || t >= best) continue;
          best = t;
          out.hit = true;
          out.distance = t;
          out.point.copy(_boxHit.point);
          out.normal.copy(_boxHit.normal);
          out.material = 'flesh';
          out.enemy = e;
          out.part = hb.part;
          out.box = hb;
          out.mult = hb.mult;
          out.thick = hb.thick;
          out.collider = null;
          out.isPlayer = false;
        }
      }
      return best;
    }

    _tracePlayer(origin, dir, best, out) {
      var pl = this.ctx.player;
      if (!pl || !pl.position) return best;
      if (typeof pl.health === 'number' && pl.health <= 0) return best;

      var boxes = this._playerBoxes();
      for (var b = 0; b < boxes.length; b++) {
        var hb = boxes[b];
        var t = Collision.raycastBox(origin, dir, hb, _boxHit);
        if (t < 0 || t >= best) continue;
        best = t;
        out.hit = true;
        out.distance = t;
        out.point.copy(_boxHit.point);
        out.normal.copy(_boxHit.normal);
        out.material = 'flesh';
        out.enemy = null;
        out.part = hb.part;
        out.box = hb;
        out.mult = hb.mult;
        out.thick = hb.thick;
        out.collider = null;
        out.isPlayer = true;
      }
      return best;
    }

    _traceLevel(origin, dir, best, out) {
      var lvl = this.ctx.level;
      if (!lvl) return best;

      if (this._levelRayOk && typeof lvl.raycast === 'function') {
        try {
          best = this._absorbRaycast(lvl.raycast(origin, dir, best), origin, dir,
            best, out, 'concrete');
          return best;
        } catch (e) {
          this._levelRayFails++;
          if (this._levelRayFails >= 3) {
            this._levelRayOk = false;
            GAME.logError('ballistics: level.raycast disabled after repeated throws', e);
          }
        }
      }
      if (lvl.colliders && lvl.colliders.length) {
        best = this._traceColliders(lvl.colliders, 'level', origin, dir, best, out);
      }
      return best;
    }

    _traceProps(origin, dir, best, out) {
      var pr = this.ctx.props;
      if (!pr) return best;

      if (this._propsRayOk && typeof pr.raycast === 'function') {
        try {
          best = this._absorbRaycast(pr.raycast(origin, dir, best), origin, dir,
            best, out, 'wood_plank');
          return best;
        } catch (e) {
          this._propsRayFails++;
          if (this._propsRayFails >= 3) {
            this._propsRayOk = false;
            GAME.logError('ballistics: props.raycast disabled after repeated throws', e);
          }
        }
      }
      var list = pr.colliders || pr.bulletColliders;
      if (list && list.length) {
        best = this._traceColliders(list, 'props', origin, dir, best, out);
      }
      return best;
    }

    /** Fold a foreign {hit, point, normal, material, distance} into our result. */
    _absorbRaycast(r, origin, dir, best, out, defMaterial) {
      if (!r || !r.point) return best;
      if (r.hit !== undefined && !r.hit) return best;
      var dist = (typeof r.distance === 'number' && r.distance >= 0)
        ? r.distance : origin.distanceTo(r.point);
      if (!(dist >= 0) || dist >= best) return best;

      out.hit = true;
      out.distance = dist;
      out.point.copy(r.point);
      if (r.normal && r.normal.x !== undefined) out.normal.copy(r.normal);
      else out.normal.copy(dir).negate();
      if (out.normal.lengthSq() < 1e-8) out.normal.copy(dir).negate();
      out.normal.normalize();
      // Surface normals must oppose the incoming ray or the incidence maths
      // (ricochet, slant cost) silently inverts.
      if (out.normal.dot(dir) > 0) out.normal.negate();
      out.material = r.material || defMaterial;
      out.enemy = null; out.part = null; out.box = null;
      out.isPlayer = false; out.mult = 1;
      out.collider = r.collider || null;
      return dist;
    }

    /**
     * Ray against a collider array, broadphased through a SpatialHash. The ray
     * is walked in chunks so a 260 m trace does not query the whole map: as
     * soon as a chunk yields a hit inside itself, nothing further along can be
     * closer and we stop.
     */
    _traceColliders(list, key, origin, dir, best, out) {
      var hash = this._ensureHash(list, key);
      var chunk = 14;
      var t0 = 0;
      var buf = this._qbuf;

      while (t0 < best) {
        var t1 = Math.min(t0 + chunk, best);
        _tc1.copy(origin).addScaledVector(dir, t0);
        _tc2.copy(origin).addScaledVector(dir, t1);
        _tcMin.set(Math.min(_tc1.x, _tc2.x), Math.min(_tc1.y, _tc2.y), Math.min(_tc1.z, _tc2.z));
        _tcMax.set(Math.max(_tc1.x, _tc2.x), Math.max(_tc1.y, _tc2.y), Math.max(_tc1.z, _tc2.z));
        _tcMin.addScalar(-0.05); _tcMax.addScalar(0.05);

        hash.query(_tcMin, _tcMax, buf);
        var found = false;
        for (var i = 0; i < buf.length; i++) {
          var c = buf[i];
          if (!c || c.noBullets || c.trigger || c.isTrigger) continue;
          var t = -1;
          if (c.type === 'sphere') {
            t = Collision.raycastSphere(origin, dir, c.center, c.radius || 0.5, _boxHit);
          } else if (c.halfExtents) {
            t = Collision.raycastBox(origin, dir, c, _boxHit);
          }
          if (t < 0 || t >= best) continue;
          best = t;
          if (t <= t1) found = true;
          out.hit = true;
          out.distance = t;
          out.point.copy(_boxHit.point);
          out.normal.copy(_boxHit.normal);
          if (out.normal.dot(dir) > 0) out.normal.negate();
          out.material = c.material || 'concrete';
          out.enemy = null; out.part = null; out.box = null;
          out.isPlayer = false; out.mult = 1;
          out.collider = c;
        }
        if (found) break;
        t0 = t1;
      }
      return best;
    }

    _ensureHash(list, key) {
      var entry = this._hashes[key];
      // Rebuild when the owning system swaps or grows its collider array.
      if (!entry || entry.src !== list || entry.count !== list.length) {
        var sh = new GAME.SpatialHash(6);
        for (var i = 0; i < list.length; i++) {
          var c = list[i];
          if (!c || !c.center) continue;
          if (c.type === 'sphere') {
            var r = c.radius || 0.5;
            _hsMin.set(c.center.x - r, c.center.y - r, c.center.z - r);
            _hsMax.set(c.center.x + r, c.center.y + r, c.center.z + r);
          } else if (c.halfExtents) {
            Collision.boxBounds(c, _hsMin, _hsMax);
          } else {
            continue;
          }
          sh.insert(c, _hsMin, _hsMax);
        }
        entry = this._hashes[key] = { hash: sh, src: list, count: list.length };
      }
      return entry.hash;
    }

    // ========================================================================
    //  HITBOXES
    // ========================================================================

    /**
     * World-space per-part hitboxes for an enemy. Prefers whatever ai.js
     * publishes (enemy.hitboxes or enemy.getHitboxes()); otherwise synthesises
     * a full skeleton-shaped set from the enemy's transform, so headshots still
     * work against an AI module that never got around to exposing them.
     * Cached for one frame - enemies move, but not within a frame.
     */
    _hitboxesFor(e) {
      var frame = this._frameId;
      var entry = this._hbCache ? this._hbCache.get(e) : null;
      if (entry && entry.frame === frame) return entry.boxes;
      if (!entry) {
        entry = { frame: -1, boxes: [] };
        if (this._hbCache) { try { this._hbCache.set(e, entry); } catch (err) { /* ignore */ } }
      }

      var src = null;
      try {
        if (typeof e.getHitboxes === 'function') src = e.getHitboxes();
        else if (e.hitboxes) src = e.hitboxes;
      } catch (err) {
        GAME.logError('enemy.getHitboxes', err);
        src = null;
      }

      if (src) {
        this._buildCustomBoxes(e, src, entry.boxes);
        if (entry.boxes.length) { entry.frame = frame; return entry.boxes; }
      }
      this._buildTemplateBoxes(e, entry.boxes);
      entry.frame = frame;
      return entry.boxes;
    }

    _slot(out, i) {
      var s = out[i];
      if (!s) {
        s = out[i] = {
          center: new THREE.Vector3(), halfExtents: new THREE.Vector3(),
          quaternion: new THREE.Quaternion(), part: 'torso', mult: 1, thick: 0.2
        };
      }
      return s;
    }

    // Accepts an array or a keyed map; entries may be plain boxes, local-space
    // offsets, or actual Object3Ds. Anything unusable is skipped rather than
    // throwing, and if nothing survives we fall back to the template.
    _buildCustomBoxes(e, src, out) {
      var n = 0;
      var arr = Array.isArray(src) ? src : null;
      var keys = arr ? null : Object.keys(src);
      var count = arr ? arr.length : keys.length;
      if (!count) { out.length = 0; return out; }

      this._enemyFeet(e, _hb1);
      _hbQ.setFromAxisAngle(_UP, this._enemyYaw(e));

      for (var i = 0; i < count; i++) {
        var hb = arr ? arr[i] : src[keys[i]];
        if (!hb) continue;
        var name = hb.part || hb.name || (keys ? keys[i] : null) ||
                   (hb.userData && hb.userData.part) || 'torso';
        var slot = this._slot(out, n);

        // ---- centre + orientation -------------------------------------
        var ok = false;
        if (hb.isObject3D) {
          if (hb.updateWorldMatrix) hb.updateWorldMatrix(true, false);
          hb.getWorldPosition(slot.center);
          hb.getWorldQuaternion(slot.quaternion);
          ok = true;
        } else {
          var c = vec3Of(hb.center) || vec3Of(hb.position) || vec3Of(hb.worldCenter);
          if (c) {
            slot.center.copy(c);
            if (hb.local || hb.isLocal) slot.center.applyQuaternion(_hbQ).add(_hb1);
            if (hb.quaternion && hb.quaternion.isQuaternion) slot.quaternion.copy(hb.quaternion);
            else slot.quaternion.copy(_hbQ);
            ok = true;
          } else {
            var off = vec3Of(hb.offset) || vec3Of(hb.localCenter);
            if (off) {
              slot.center.copy(off).applyQuaternion(_hbQ).add(_hb1);
              slot.quaternion.copy(_hbQ);
              ok = true;
            }
          }
        }
        if (!ok) continue;

        // ---- extents ---------------------------------------------------
        var he = vec3Of(hb.halfExtents) || vec3Of(hb.half);
        if (he) {
          slot.halfExtents.copy(he);
        } else {
          var sz = vec3Of(hb.size) || vec3Of(hb.extents);
          if (sz) {
            slot.halfExtents.copy(sz).multiplyScalar(0.5);
          } else if (typeof hb.radius === 'number') {
            var hh = (typeof hb.height === 'number') ? hb.height * 0.5 : hb.radius;
            slot.halfExtents.set(hb.radius, hh, hb.radius);
          } else if (hb.isObject3D && hb.geometry) {
            if (!hb.geometry.boundingBox) hb.geometry.computeBoundingBox();
            var bb = hb.geometry.boundingBox;
            slot.halfExtents.set((bb.max.x - bb.min.x) * 0.5,
              (bb.max.y - bb.min.y) * 0.5, (bb.max.z - bb.min.z) * 0.5);
            hb.getWorldScale(_hb2);
            slot.halfExtents.multiply(_hb2);
          } else {
            slot.halfExtents.set(0.14, 0.14, 0.14);
          }
        }
        if (slot.halfExtents.x < 0.01) slot.halfExtents.x = 0.01;
        if (slot.halfExtents.y < 0.01) slot.halfExtents.y = 0.01;
        if (slot.halfExtents.z < 0.01) slot.halfExtents.z = 0.01;

        slot.part = normalisePart(name);
        var m = (hb.mult !== undefined) ? hb.mult
          : ((hb.multiplier !== undefined) ? hb.multiplier : hb.damageMultiplier);
        slot.mult = (typeof m === 'number') ? m : partMultiplier(slot.part);
        slot.thick = (typeof hb.thickness === 'number') ? hb.thickness
          : Math.min(partThickness(slot.part), slot.halfExtents.length() * 1.3);
        n++;
      }
      out.length = n;
      return out;
    }

    _buildTemplateBoxes(e, out) {
      this._enemyFeet(e, _hb1);
      _hbQ.setFromAxisAngle(_UP, this._enemyYaw(e));

      var height = (typeof e.height === 'number' && e.height > 0.5) ? e.height : 1.8;
      var scale = height / 1.8;
      // Crouching squashes the whole rig. Without this you can shoot over a
      // crouched enemy's head and still "hit" him, or miss him entirely.
      var stance = e.state || e.stance;
      if (stance === 'prone') scale *= 0.45;
      else if (e.crouched === true || stance === 'crouch' || stance === 'crouched') scale *= 0.74;

      for (var i = 0; i < HUMAN.length; i++) {
        var t = HUMAN[i];
        var slot = this._slot(out, i);
        slot.center.set(t.o[0] * scale, t.o[1] * scale, t.o[2] * scale)
          .applyQuaternion(_hbQ).add(_hb1);
        slot.halfExtents.set(t.h[0] * scale, t.h[1] * scale, t.h[2] * scale);
        slot.quaternion.copy(_hbQ);
        slot.part = t.part;
        slot.mult = t.mult;
        slot.thick = t.thick * scale;
      }
      out.length = HUMAN.length;
      return out;
    }

    // Torso slab + separate head box, so the AI can headshot the player exactly
    // the way the player headshots the AI.
    _playerBoxes() {
      var pl = this.ctx.player;
      var out = this._playerHitboxes;
      if (!pl || !pl.position) { out.length = 0; return out; }
      var h = pl.height || (pl.eyeHeight ? pl.eyeHeight + 0.14 : 1.8);
      if (pl.crouched || pl.state === 'crouch' || pl.state === 'slide') h = Math.min(h, 1.28);

      this._slot(out, 0); this._slot(out, 1);
      out.length = 2;
      var p = pl.position;

      out[0].center.set(p.x, p.y + (h - 0.22) * 0.5, p.z);
      out[0].halfExtents.set(0.26, Math.max(0.2, (h - 0.22) * 0.5), 0.26);
      out[0].quaternion.identity();
      out[0].part = 'torso'; out[0].mult = 1.0; out[0].thick = 0.30;

      out[1].center.set(p.x, p.y + h - 0.12, p.z);
      out[1].halfExtents.set(0.115, 0.12, 0.115);
      out[1].quaternion.identity();
      out[1].part = 'head'; out[1].mult = 2.4; out[1].thick = 0.18;
      return out;
    }

    _enemyFeet(e, out) {
      var p = vec3Of(e.position) ||
              (e.root && vec3Of(e.root.position)) ||
              (e.mesh && vec3Of(e.mesh.position)) ||
              (e.object3D && vec3Of(e.object3D.position));
      if (!p) { out.set(0, 0, 0); return out; }
      out.copy(p);
      // Some rigs anchor at the hips rather than the feet.
      if (e.originAtCenter || e.pivotCentered) {
        out.y -= ((typeof e.height === 'number' && e.height > 0.5) ? e.height : 1.8) * 0.5;
      }
      return out;
    }

    _enemyCenter(e, out) {
      this._enemyFeet(e, out);
      var h = (typeof e.height === 'number' && e.height > 0.5) ? e.height : 1.8;
      var stance = e.state || e.stance;
      if (stance === 'prone') h *= 0.45;
      else if (e.crouched === true || stance === 'crouch' || stance === 'crouched') h *= 0.74;
      out.y += h * 0.52;
      return true;
    }

    _playerCenter(out) {
      var pl = this.ctx.player;
      if (pl && pl.position) {
        out.copy(pl.position);
        out.y += (pl.eyeHeight || 1.65) * 0.55;
      } else if (this.ctx.camera) {
        out.copy(this.ctx.camera.position);
      } else {
        out.set(0, 1, 0);
      }
      return out;
    }

    _enemyYaw(e) {
      if (typeof e.yaw === 'number') return e.yaw;
      if (e.rotation && typeof e.rotation.y === 'number') return e.rotation.y;
      if (e.root && e.root.rotation) return e.root.rotation.y;
      if (e.mesh && e.mesh.rotation) return e.mesh.rotation.y;
      return 0;
    }

    // ========================================================================
    //  PROJECTILE INTEGRATION
    // ========================================================================
    _stepProjectile(p, h) {
      var st = p.st;
      var spec = st.spec;
      if (p.resting) return;

      // --- quadratic drag, applied along the velocity: dv/dt = -k*v^2 -------
      var speed = p.vel.length();
      if (speed > 1e-4) {
        var ns = speed - spec.drag * speed * speed * h;
        if (ns < 0.01) ns = 0.01;
        p.vel.multiplyScalar(ns / speed);
        speed = ns;
      }
      p.vel.y -= spec.gravity * h;

      _pj1.copy(p.vel).multiplyScalar(h);
      var segLen = _pj1.length();
      p.prev.copy(p.pos);
      if (segLen < 1e-7) return;

      st.dir.copy(_pj1).multiplyScalar(1 / segLen);
      st.point.copy(p.pos);

      var remaining = segLen;
      var th = this._th[3];
      var guard = 0;

      // The sweep is what makes sub-stepping safe: even a 3.7 m step at 880 m/s
      // is a continuous raycast, so nothing thin can be skipped over.
      while (remaining > 1e-5 && guard++ < 4) {
        this._trace(st.point, st.dir, remaining, st.flags, th);
        if (!th.hit) {
          st.point.addScaledVector(st.dir, remaining);
          st.distance += remaining;
          break;
        }

        if (spec.kind === 'grenade') { this._bounce(p, th); return; }
        if (spec.kind === 'rocket' || spec.explosive > 0) {
          p.pos.copy(th.point).addScaledVector(th.normal, 0.05);
          this._detonate(p);
          return;
        }

        var before = st.distance;
        var e0 = st.energy;
        var res = this._resolveHit(th, st);
        var used = st.distance - before;
        remaining -= (used > 0 ? used : th.distance);

        if (res === RES_STOP) {
          p.pos.copy(st.point);
          this._kill(p);
          return;
        }
        // Penetration/ricochet changed both direction and energy: carry that
        // into the velocity so the round genuinely slows down.
        var f = (e0 > 1e-4) ? (st.energy / e0) : 0.5;
        speed = Math.max(15, speed * M.clamp(f, 0.08, 1));
        p.vel.copy(st.dir).multiplyScalar(speed);
      }

      p.pos.copy(st.point);
      if (st.distance > spec.maxRange) this._kill(p);
    }

    _bounce(p, th) {
      var spec = p.st.spec;
      var def = materialDef(th.material);

      p.pos.copy(th.point).addScaledVector(th.normal, 0.045);
      p.bounces++;

      // Split into normal/tangent so a grenade skids along a floor instead of
      // pinballing like a superball.
      _pj2.copy(th.normal).multiplyScalar(p.vel.dot(th.normal));
      _pj3.copy(p.vel).sub(_pj2);
      var soft = (def.kind === 'sand' || def.kind === 'dirt') ? 0.35
        : (def.kind === 'metal' ? 1.15 : 1.0);
      _pj2.multiplyScalar(-M.clamp(spec.restitution * soft, 0.05, 0.7));
      _pj3.multiplyScalar(0.72);
      p.vel.copy(_pj2).add(_pj3);

      var sp = p.vel.length();
      this._sfx('grenade_bounce', p.pos, M.saturate(sp / 9) * 0.8, this.rng.range(0.85, 1.2));
      if (sp > 2.5 && this.ctx.vfx && this.ctx.vfx.impact) {
        try { this.ctx.vfx.impact(th.point, th.normal, def.kind); }
        catch (e) { GAME.logError('vfx.impact', e); }
      }

      if (sp < 0.55 || p.bounces > 9) { p.resting = true; p.vel.set(0, 0, 0); }
      p.spin.multiplyScalar(0.6);
    }

    _detonate(p) {
      var spec = p.st.spec;
      this.explode(p.pos, spec.blastRadius || 6, spec.explosive || 120, {
        owner: p.st.owner, weapon: p.st.weapon, source: p.st.shooter
      });
      this._kill(p);
    }

    _kill(p) {
      p.active = false;
      if (p.mesh) p.mesh.visible = false;
    }

    _orientMesh(p, dt) {
      var m = p.mesh;
      if (!m) return;
      m.position.copy(p.pos);
      if (p.st.spec.kind === 'rocket') {
        if (p.vel.lengthSq() > 1e-6) {
          _pj1.copy(p.vel).normalize();
          _pjQ.setFromUnitVectors(_FWD, _pj1);
          m.quaternion.copy(_pjQ);
        }
      } else if (!p.resting) {
        m.rotation.x += p.spin.x * dt;
        m.rotation.y += p.spin.y * dt;
        m.rotation.z += p.spin.z * dt;
      }
    }

    // A grenade nobody can see is a bug, and no other module owns the mesh for
    // an in-flight projectile - so we build a very cheap one here, lazily, and
    // it lives in the pool for the rest of the session.
    _attachMesh(p, spec) {
      var ctx = this.ctx;
      if (!ctx.scene) return;
      var geo, mat;
      if (spec.kind === 'grenade') {
        if (!this._grenadeGeo) {
          this._grenadeGeo = new THREE.IcosahedronGeometry(0.036, 1);
          this._grenadeMat = new THREE.MeshStandardMaterial({
            color: 0x39402c, roughness: 0.62, metalness: 0.45
          });
        }
        geo = this._grenadeGeo; mat = this._grenadeMat;
      } else {
        if (!this._rocketGeo) {
          this._rocketGeo = new THREE.CylinderGeometry(0.035, 0.046, 0.30, 8, 1);
          this._rocketGeo.rotateX(Math.PI * 0.5);   // cylinder axis +Y -> +Z
          this._rocketMat = new THREE.MeshStandardMaterial({
            color: 0x2b2f33, roughness: 0.5, metalness: 0.6
          });
        }
        geo = this._rocketGeo; mat = this._rocketMat;
      }
      if (!p.mesh) {
        p.mesh = new THREE.Mesh(geo, mat);
        p.mesh.castShadow = true;
        p.mesh.matrixAutoUpdate = true;
        ctx.scene.add(p.mesh);
      } else {
        p.mesh.geometry = geo;
        p.mesh.material = mat;
      }
      p.mesh.visible = true;
      p.mesh.position.copy(p.pos);
    }

    // ========================================================================
    //  DAMAGE / LINE OF SIGHT
    // ========================================================================
    _damageAtRange(spec, dist) {
      if (dist <= spec.rangeNear) return spec.damage;
      if (dist >= spec.rangeFar) return spec.damageFar;
      var t = (dist - spec.rangeNear) / (spec.rangeFar - spec.rangeNear);
      return M.lerp(spec.damage, spec.damageFar, t);
    }

    /**
     * How much of an explosion reaches `target`. 1 means clear line of sight.
     * Cover matters but never fully protects - a frag on the far side of a
     * market stall still hurts, one behind a concrete barrier mostly does not.
     */
    _losFactor(from, target) {
      _lo1.copy(target).sub(from);
      var dist = _lo1.length();
      if (dist < 0.35) return 1;
      _lo1.multiplyScalar(1 / dist);
      var th = this._th[2];
      this._trace(from, _lo1, dist - 0.25, SKIP_ENEMIES | SKIP_PLAYER, th);
      if (!th.hit) return 1;
      var def = materialDef(th.material);
      if (def.pen < 200) return 0.78;    // canvas, plaster, foliage
      if (def.pen < 900) return 0.42;    // wood, brick
      return 0.24;                        // concrete, sandbags, steel
    }

    /** Tell the AI that rounds are landing near them. */
    _suppress(point, radius) {
      var ai = this.ctx.ai;
      if (!ai) return;
      if (typeof ai.onBulletImpact === 'function') {
        try { ai.onBulletImpact(point, radius); return; }
        catch (e) { GAME.logError('ai.onBulletImpact', e); }
      }
      var list = ai.enemies;
      if (!list || !list.length) return;
      var r2 = radius * radius;
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (!isAlive(e)) continue;
        this._enemyCenter(e, _su1);
        if (_su1.distanceToSquared(point) > r2) continue;
        try {
          if (typeof e.onSuppressed === 'function') e.onSuppressed(point);
          else if (typeof e.suppress === 'function') e.suppress(point);
        } catch (e2) { GAME.logError('ai.suppress', e2); }
      }
    }

    // ========================================================================
    //  PRESENTATION
    // ========================================================================

    /** Tracer loading: roughly one round in three carries a tracer element. */
    _tracerTick(spec, pelletIndex) {
      if (!spec.tracerEvery) return false;
      if (pelletIndex > 0) return false;    // never one tracer per buckshot pellet
      this._shotCounter++;
      return (this._shotCounter % spec.tracerEvery) === 0;
    }

    _segmentFX(st, endPoint) {
      if (st.tracer) this._tracer(st.segStart, endPoint, st.spec);
      this._whizz(st.segStart, endPoint, st);
    }

    _tracer(from, to, spec) {
      var vfx = this.ctx.vfx;
      if (!vfx || !vfx.tracer) return;
      if (from.distanceToSquared(to) < 0.09) return;
      try { vfx.tracer(from, to, spec.muzzleVelocity); }
      catch (e) { GAME.logError('vfx.tracer', e); }
    }

    /**
     * Supersonic crack / whizz-by. Never for the player's own rounds - you do
     * not hear your own bullet go past your ear. The crack is the shockwave
     * cone of a supersonic round; the whizz is the subsonic tail.
     */
    _whizz(a, b, st) {
      var ctx = this.ctx;
      if (!ctx.camera || !ctx.audio || this._whizzBudget <= 0) return;
      if (st.owner === 'player') return;

      var cam = ctx.camera.position;
      _wz1.copy(b).sub(a);
      var len2 = _wz1.lengthSq();
      if (len2 < 1e-6) return;
      _wz2.copy(cam).sub(a);
      var t = M.saturate(_wz2.dot(_wz1) / len2);
      _wz3.copy(a).addScaledVector(_wz1, t);
      var d = _wz3.distanceTo(cam);
      if (d > 6) return;
      // Do not cue a round that started in the player's face.
      if (a.distanceToSquared(cam) < 1.44) return;

      this._whizzBudget--;
      var vol = M.saturate(1 - d / 6);
      if (st.spec.muzzleVelocity > 343 && st.energy > 0.4 && d < 3.2) {
        this._sfx('crack', _wz3, 0.55 + vol * 0.45, this.rng.range(0.94, 1.08), true);
      } else {
        this._sfx('whizz', _wz3, 0.35 + vol * 0.5, this.rng.range(0.8, 1.3), true);
      }
    }

    _impactFX(point, normal, def, phase) {
      var vfx = this.ctx.vfx;
      if (!vfx) return;
      if (vfx.impact) {
        try { vfx.impact(point, normal, def.kind); }
        catch (e) { GAME.logError('vfx.impact', e); }
      }
      // A ricochet throws a bright spark shower off hard surfaces - the single
      // most readable "that just bounced" cue there is.
      if (phase === 'ricochet' && def.hard > 0.6 && vfx.sparks) {
        try { vfx.sparks(point, normal, 14); }
        catch (e2) { GAME.logError('vfx.sparks', e2); }
      }
    }

    _sfx(name, position, volume, pitch, force) {
      var a = this.ctx.audio;
      if (!a || !a.play) return;
      if (!force && this._sfxBudget <= 0) return;
      this._sfxBudget--;
      _sfxPos.copy(position);
      try {
        a.play(name, {
          position: _sfxPos,
          volume: (volume === undefined) ? 1 : volume,
          pitch: (pitch === undefined) ? 1 : pitch
        });
      } catch (e) { GAME.logError('audio.play:' + name, e); }
    }

    // ========================================================================
    //  RING BUFFERS
    // ========================================================================
    _rec() {
      var r = this._recRing[this._recCur];
      this._recCur = (this._recCur + 1) % this._recRing.length;
      return r.reset();
    }

    _arr() {
      var a = this._arrRing[this._arrCur];
      this._arrCur = (this._arrCur + 1) % this._arrRing.length;
      a.length = 0;
      return a;
    }
  }

  // Expose the tables so the AI and any debug overlay can reason about cover
  // without duplicating these numbers.
  Ballistics.MATERIALS = MAT;
  Ballistics.PART_MULTIPLIERS = PART_MULT;
  Ballistics.materialDef = materialDef;

  GAME.Ballistics = Ballistics;

})(window.GAME, window.THREE);
