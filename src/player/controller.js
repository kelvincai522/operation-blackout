// ============================================================================
// OPERATION BLACKOUT - player controller
// Owns: movement simulation, capsule collision response, and the player camera.
//
// Design notes that matter for "feel":
//  * Velocity is integrated with a Quake-style accelerate/friction pair rather
//    than a lerp toward a target velocity. Accelerate only ever ADDS speed in
//    the wish direction, so existing momentum (a slide, a jump, a step-up) is
//    never silently erased - that is what makes air control feel responsive
//    instead of floaty.
//  * Collision is capsule-vs-collider MTV depenetration, resolving the single
//    DEEPEST overlap per iteration. Resolving every contact in one pass
//    double-pushes in corners and produces the classic corner jitter.
//  * Ground contact comes from an explicit downward probe, not from "gravity
//    pushed me into the floor and I got pushed back". The latter oscillates by
//    g*dt^2 (~5mm at 60fps) every frame, which is visible in the view bob.
//  * The camera never reads its own transform back: position and rotation are
//    written from scratch each frame from (position + eyeHeight + offsets).
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  if (!GAME || !THREE) return;          // never throw at load time

  var M = GAME.Math;
  var COL = GAME.Collision;
  var V3 = THREE.Vector3;
  var DEG = Math.PI / 180;

  // --------------------------------------------------------------------------
  // Tuning. Everything a designer would touch lives here.
  // Distances are metres, speeds m/s, accelerations m/s^2, times seconds.
  // --------------------------------------------------------------------------
  var C = {
    RADIUS: 0.35,
    STAND_H: 1.80,
    CROUCH_H: 1.25,
    EYE_STAND: 1.65,
    EYE_CROUCH: 1.05,
    EYE_SLIDE: 0.82,
    CROUCH_TIME: 0.14,

    // Games use ~2x real gravity: at 9.81 a 1m jump hangs for 0.9s and reads as
    // moon-walking. -20 with a 1.05m apex gives a 0.65s arc, which is the CoD
    // pocket.
    GRAVITY: -20.0,
    JUMP_APEX: 1.05,
    TERMINAL: -58.0,

    SPEED_WALK: 4.0,
    SPEED_SPRINT: 6.4,
    SPEED_CROUCH: 2.0,
    SPEED_ADS: 2.6,
    STRAFE_SCALE: 0.86,
    BACK_SCALE: 0.80,

    ACCEL_GROUND: 60.0,
    ACCEL_AIR: 12.0,          // 20% of ground accel
    AIR_STRAFE_ACCEL: 58.0,   // only ever applied against AIR_STRAFE_CAP
    AIR_STRAFE_CAP: 1.15,     // classic air-strafe wishspeed clamp
    FRICTION: 9.0,
    STOP_SPEED: 1.4,          // friction floor so you stop crisply, not asymptotically

    COYOTE: 0.09,
    JUMP_BUFFER: 0.12,
    STEP_HEIGHT: 0.35,
    GROUND_MIN_Y: 0.60,       // cos(53deg) - steeper than this is a wall
    SNAP_DOWN: 0.30,          // must stay < RADIUS or the capsule test misses

    SLIDE_MIN_SPEED: 4.4,
    SLIDE_BOOST: 8.4,
    SLIDE_MIN_TIME: 0.34,
    SLIDE_MAX_TIME: 1.15,
    SLIDE_DECAY: 1.55,        // 8.4 -> 2.5 m/s in ~0.8s
    SLIDE_END_SPEED: 2.5,
    SLIDE_STEER: 2.0,         // rad/s the slide direction can be steered
    SLIDE_COOLDOWN: 0.42,

    MANTLE_MIN: 0.40,
    MANTLE_MAX: 1.50,
    MANTLE_TIME: 0.35,

    FOV_SPRINT: 8.0,
    FOV_SPRINT_TIME: 0.25,
    FOV_SLIDE: 6.0,
    ADS_FOV_SCALE: 0.72,
    ADS_TIME: 0.22,

    LEAN_ROLL: 1.2 * DEG,
    BOB_X: 0.032,
    BOB_Y: 0.028,
    BOB_Z: 0.013,
    BOB_ROLL: 0.72 * DEG,

    HEALTH_MAX: 100,
    REGEN_DELAY: 4.2,
    REGEN_RATE: 26,
    RESPAWN_TIME: 3.4,
    // Post-spawn immunity. Without it a squad already in contact deletes the
    // player inside the first second - before they have moved, let alone
    // sprinted - and the whole session becomes a respawn screen. Dropped the
    // instant the player fires so it can never be camped behind.
    SPAWN_PROTECT: 2.0,
    FALL_DAMAGE_SPEED: 14.0   // ~10m drop before it hurts
  };
  C.JUMP_VEL = Math.sqrt(2 * -C.GRAVITY * C.JUMP_APEX);   // 6.48 m/s

  // --------------------------------------------------------------------------
  // Module scratch. Nothing in update() may allocate - GC hitches read as
  // stutter and stutter is indistinguishable from bad netcode to a player.
  // --------------------------------------------------------------------------
  var _v1 = new V3(), _v2 = new V3();
  var _wish = new V3(), _probe = new V3(), _tgt = new V3();
  var _min = new V3(), _max = new V3();
  var _n = new V3(), _bn = new V3();
  var _down = new V3(0, -1, 0);
  var _rayOut = { point: new V3(), normal: new V3() };
  var _emptyList = [];

  // ==========================================================================
  class PlayerController {
    constructor(ctx) {
      this.ctx = ctx || null;

      // ---- documented public API -----------------------------------------
      this.position = new V3(0, 0.1, 14);   // FEET, not eye
      this.velocity = new V3();
      this.yaw = Math.PI;
      this.pitch = 0;
      this.state = 'idle';
      this.eyeHeight = C.EYE_STAND;
      this.isADS = false;
      this.speed = 0;
      this.health = C.HEALTH_MAX;
      this.maxHealth = C.HEALTH_MAX;
      this.frozen = false;                  // scenarios drive the camera

      // ---- state other systems read --------------------------------------
      this.dead = false;
      this.grounded = false;
      this.crouching = false;
      this.sprinting = false;
      this.forward = new V3(0, 0, -1);
      this.right = new V3(1, 0, 0);
      this.headPosition = new V3();
      this.groundNormal = new V3(0, 1, 0);
      this.groundMaterial = 'concrete';
      this.capsuleRadius = C.RADIUS;
      this.capsuleHeight = C.STAND_H;
      this.adsT = 0;                        // raw 0..1
      this.adsEase = 0;                     // smoothed, for viewmodel blends
      this.sprintBlend = 0;
      this.crouchT = 0;
      this.mantleProgress = 0;
      this.mantleDir = new V3(0, 0, -1);
      this.weaponReady = 1;                 // 0 while sprinting / mantling
      this.canFire = true;
      this.viewRoll = 0;
      this.viewOffset = new V3();           // camera-space bob+dip, for the viewmodel
      this.lookDelta = { yaw: 0, pitch: 0 };
      this.moveInput = { x: 0, z: 0 };

      // ---- internal timers / springs --------------------------------------
      this.coyote = 0;
      this.jumpBuffer = -1;
      this.slideTime = 0;
      this.slideCooldown = 0;
      this.slideRoll = 0;
      this.slideBlend = 0;
      this.sprintLock = 0;
      this.regenTimer = 0;
      this.deathTimer = 0;
      this.spawnProtect = 0;

      this.bobPhase = 0;
      this.bobAmp = 0;
      this._nextStep = Math.PI;
      this._foot = 0;
      this.landOffset = 0;
      this._landVel = { v: 0 };
      this.leanRoll = 0;
      this.punchPitch = 0;
      this.punchYaw = 0;
      this.punchRoll = 0;
      this.fovKick = 0;
      this._sprintRaw = 0;

      this._mantleT = 0;
      this._mantleDur = C.MANTLE_TIME;
      this._mantleFrom = new V3();
      this._mantleTo = new V3();
      this._rollSide = 1;          // which way slide/mantle rolls the view

      this._crouchToggle = false;
      this._crouchWasHeld = false;
      this._crouchHeld = false;
      this._jumpedThisFrame = false;
      this._hitWall = false;
      this._frame = 0;
      this._wasFrozen = false;

      // ---- broadphase ------------------------------------------------------
      this._hash = new GAME.SpatialHash(6);
      this._big = [];              // colliders too large to hash sensibly
      this._colliders = null;
      this._colliderCount = -1;
      this._cands = [];
      this._cands2 = [];
      this._rayCands = [];
      this._rayN = new V3();
      this._rayP = new V3();
      this._rayMat = 'concrete';

      this.spawn = { position: new V3(0, 0.1, 14), yaw: Math.PI };
    }

    // ------------------------------------------------------------------------
    // Boot
    // ------------------------------------------------------------------------
    async build(ctx) {
      ctx = ctx || this.ctx;
      this.ctx = ctx;
      if (!ctx) return;

      var base = (ctx.settings && ctx.settings.fov) || (ctx.camera && ctx.camera.fov) || 80;
      this._baseFov = base;

      this._refreshBroadphase();
      this._applySpawn();

      // Settle onto the floor so frame one does not open with a fall + landing
      // dip. Repeated short probes because a single probe deeper than the
      // capsule radius would miss the surface entirely.
      this._queryCandidates(0);
      this._depenetrate(6, false);
      for (var i = 0; i < 10; i++) {
        if (this._groundProbe(C.SNAP_DOWN)) break;
        this.position.y -= C.SNAP_DOWN;
        this._queryCandidates(0);
      }
      this.grounded = true;
      this.velocity.set(0, 0, 0);
      this.spawnProtect = C.SPAWN_PROTECT;
      this._updateBasis();
      this._writeCamera(ctx, 0, 0, 0, 0, 0, 0);
    }

    _applySpawn() {
      var lvl = this.ctx && this.ctx.level;
      var pts = lvl && lvl.spawnPoints;
      if (pts && pts.length && pts[0] && pts[0].position) {
        this.position.copy(pts[0].position);
        if (typeof pts[0].yaw === 'number') this.yaw = pts[0].yaw;
      }
      this.position.y += 0.05;
      this.spawn.position.copy(this.position);
      this.spawn.yaw = this.yaw;
    }

    // ------------------------------------------------------------------------
    // Frame entry. Simulation and view are separately guarded: if the sim
    // throws we still write a camera transform, so the screen never blanks.
    // ------------------------------------------------------------------------
    update(dt, ctx) {
      ctx = ctx || this.ctx;
      this.ctx = ctx;
      if (!ctx) return;
      if (!(dt > 0)) dt = 1 / 60;
      if (dt > 1 / 20) dt = 1 / 20;
      this._frame++;

      try { this._simulate(dt, ctx); }
      catch (e) { GAME.logError('player.simulate', e); }
      try { this._updateView(dt, ctx); }
      catch (e) { GAME.logError('player.view', e); }
    }

    _simulate(dt, ctx) {
      this._updateBasis();
      this._refreshBroadphase();

      if (this.frozen) {
        // Scenario poses hold: no input, no integration, no drift.
        this.velocity.set(0, 0, 0);
        this.speed = 0;
        this._wasFrozen = true;
        return;
      }
      if (this._wasFrozen) {
        // Coming back under player control - clear stale intent.
        this._wasFrozen = false;
        this.jumpBuffer = -1;
        this._crouchWasHeld = true;
      }

      this._jumpedThisFrame = false;
      this._readInput(dt, ctx);
      // Broadphase candidates are gathered before the stance update because the
      // ceiling test, the mantle probe and the move all share this one list.
      // The AABB pad (0.75) comfortably covers the height change a stance
      // transition can make within the same frame.
      this._queryCandidates(dt);
      this._updateStance(dt, ctx);

      if (this.state === 'mantle') this._updateMantle(dt, ctx);
      else this._updateMovement(dt, ctx);

      this.speed = Math.sqrt(this.velocity.x * this.velocity.x +
                             this.velocity.z * this.velocity.z);
      this._updateStateName();
      this._updateStride(dt, ctx);
      this._updateHealth(dt, ctx);

      // Safety net: if the level is missing or the player falls out of the
      // world, put them back rather than falling forever.
      if (this.position.y < -60) this.respawn();
    }

    _updateBasis() {
      var s = Math.sin(this.yaw), c = Math.cos(this.yaw);
      this.forward.set(-s, 0, -c);
      this.right.set(c, 0, -s);
    }

    // ------------------------------------------------------------------------
    // Look. Raw mouse delta -> yaw/pitch with no smoothing and no acceleration:
    // any filtering here is instantly felt as input lag by anyone who plays
    // shooters.
    // ------------------------------------------------------------------------
    _readInput(dt, ctx) {
      var input = ctx.input;
      var st = ctx.settings || {};
      var sens = typeof st.sensitivity === 'number' ? st.sensitivity : 0.0022;
      var adsScale = typeof st.adsSensitivityScale === 'number' ? st.adsSensitivityScale : 0.65;
      var mult = M.lerp(1, adsScale, this.adsEase);
      var dx = 0, dy = 0;

      if (input && input.enabled !== false && input.mouse) {
        dx = input.mouse.dx || 0;
        dy = input.mouse.dy || 0;
      }
      if (this.dead) { dx *= 0.15; dy *= 0.15; }

      var dyaw = -dx * sens * mult;
      var dpitch = -dy * sens * mult * (st.invertY ? -1 : 1);

      this.yaw = M.wrapAngle(this.yaw + dyaw);
      this.pitch = M.clamp(this.pitch + dpitch, -88 * DEG, 88 * DEG);
      this.lookDelta.yaw = dyaw;
      this.lookDelta.pitch = dpitch;
      this._updateBasis();
    }

    // ------------------------------------------------------------------------
    // Stance: crouch / sprint / ADS / slide / jump intent.
    // ------------------------------------------------------------------------
    _updateStance(dt, ctx) {
      var input = ctx.input;
      var live = !!input && input.enabled !== false && !this.dead;
      var mx = 0, mz = 0, jump = false, sprintHeld = false;
      var ctrlHeld = false, fire = false, adsHeld = false;

      if (live) {
        mx = input.axis('KeyA', 'KeyD');
        mz = input.axis('KeyS', 'KeyW');
        jump = input.justPressed('Space');
        sprintHeld = input.down('ShiftLeft') || input.down('ShiftRight');
        ctrlHeld = input.down('ControlLeft') || input.down('ControlRight');
        if (input.justPressed('KeyC')) this._crouchToggle = !this._crouchToggle;
        fire = !!input.mouse.left;
        adsHeld = !!input.mouse.right;
      }
      this.moveInput.x = mx;
      this.moveInput.z = mz;

      var crouchHeld = ctrlHeld || this._crouchToggle;
      var crouchPressed = crouchHeld && !this._crouchWasHeld;
      this._crouchWasHeld = crouchHeld;

      // Clamped at zero: these are one-shot lockouts, not counters, and letting
      // them free-run negative for a whole session is just accumulating noise.
      if (this.slideCooldown > 0) this.slideCooldown -= dt;
      if (this.sprintLock > 0) this.sprintLock -= dt;
      // Firing or aiming breaks the sprint and holds it broken for the length
      // of the weapon raise, so you cannot machine-gun the sprint key.
      if (fire || adsHeld) this.sprintLock = 0.22;
      // Taking a shot is what ends spawn immunity - you cannot shoot from
      // behind the shield.
      if (fire) this.spawnProtect = 0;

      // ---- slide entry (checked before the sprint auto-stand) --------------
      if (crouchPressed && this.state !== 'slide' && this.grounded &&
          this.slideCooldown <= 0 && this.speed > C.SLIDE_MIN_SPEED) {
        this._startSlide(ctx);
      }
      // Tapping sprint stands you out of a toggled crouch.
      if (sprintHeld && mz > 0.35 && this._crouchToggle && !crouchPressed &&
          this.state !== 'slide') {
        this._crouchToggle = false;
        crouchHeld = ctrlHeld;
      }
      this._crouchHeld = crouchHeld;

      // ---- ADS -------------------------------------------------------------
      var wantADS = adsHeld && this.state !== 'slide' && this.state !== 'mantle' && !this.dead;
      if (ctx.weapons && ctx.weapons.canADS === false) wantADS = false;
      this.isADS = wantADS;
      var adsTime = this._weaponNum('adsTime', C.ADS_TIME);
      this.adsT = M.moveTowards(this.adsT, wantADS ? 1 : 0, dt / Math.max(0.05, adsTime));
      this.adsEase = M.smootherstep(0, 1, this.adsT);

      // ---- sprint ----------------------------------------------------------
      var wantSprint = sprintHeld && mz > 0.35 && !crouchHeld && !wantADS &&
                       this.sprintLock <= 0 && this.state !== 'slide' &&
                       this.state !== 'mantle' && !this.dead;
      // Sprint started on the ground survives a jump; you cannot start one mid-air.
      this.sprinting = wantSprint && (this.grounded || this.sprinting);
      this._sprintRaw = M.moveTowards(this._sprintRaw, this.sprinting ? 1 : 0,
                                      dt / C.FOV_SPRINT_TIME);
      this.sprintBlend = M.smootherstep(0, 1, this._sprintRaw);

      // ---- weapon raise ----------------------------------------------------
      var readyTarget = (this.sprinting || this.state === 'mantle') ? 0 : 1;
      this.weaponReady = M.moveTowards(this.weaponReady, readyTarget,
        dt * (readyTarget > this.weaponReady ? 4.4 : 8.5));
      this.canFire = this.weaponReady > 0.72 && this.state !== 'mantle' && !this.dead;

      // ---- crouch height ---------------------------------------------------
      var wantCrouch = (this.state === 'slide') || crouchHeld;
      if (!wantCrouch && this.crouchT > 0 && this._headBlocked()) wantCrouch = true;
      this.crouching = wantCrouch && this.state !== 'mantle';
      this.crouchT = M.moveTowards(this.crouchT, this.crouching ? 1 : 0, dt / C.CROUCH_TIME);
      var ce = M.smootherstep(0, 1, this.crouchT);
      this.capsuleHeight = M.lerp(C.STAND_H, C.CROUCH_H, ce);

      // Into the slide fast, out of it gently - a slow dip reads as sluggish.
      this.slideBlend = M.damp(this.slideBlend, this.state === 'slide' ? 1 : 0,
                               this.state === 'slide' ? 17 : 9, dt);
      var eye = M.lerp(C.EYE_STAND, C.EYE_CROUCH, ce);
      eye = M.lerp(eye, C.EYE_SLIDE, this.slideBlend);
      if (this.dead) eye = M.damp(this.eyeHeight, 0.34, 4.5, dt);
      this.eyeHeight = this.dead ? eye : M.damp(this.eyeHeight, eye, 26, dt);

      // ---- jump buffering + coyote ----------------------------------------
      if (jump) this.jumpBuffer = C.JUMP_BUFFER;
      else if (this.jumpBuffer > -1) this.jumpBuffer -= dt;
      if (this.jumpBuffer > 0 && this.state !== 'mantle' && !this.dead) {
        if (this._tryMantle(ctx)) {
          this.jumpBuffer = -1;
        } else if ((this.grounded || this.coyote > 0) && !this._headBlocked()) {
          this._doJump(ctx);
        }
      }
      // Automatic vault: drifting into a ledge while falling forward.
      if (this.state !== 'mantle' && !this.grounded && !this.dead &&
          mz > 0.4 && this.velocity.y < 1.0 && (this._frame % 3) === 0) {
        this._tryMantle(ctx);
      }
    }

    _doJump(ctx) {
      if (this.state === 'slide') this._endSlide(ctx, true);
      this._crouchToggle = false;
      this.velocity.y = C.JUMP_VEL;
      this.grounded = false;
      this.coyote = 0;
      this.jumpBuffer = -1;
      this._jumpedThisFrame = true;
      this._viewImpulse(0.016);
      this._emit('player:jump', {
        position: this.position.clone(),
        speed: this.speed,
        material: this.groundMaterial
      });
    }

    _weaponNum(key, def) {
      var w = this.ctx && this.ctx.weapons;
      var cur = w && w.current;
      if (cur && typeof cur[key] === 'number') return cur[key];
      if (w && typeof w[key] === 'number') return w[key];
      return def;
    }

    // ------------------------------------------------------------------------
    // Movement integration
    // ------------------------------------------------------------------------
    _updateMovement(dt, ctx) {
      var vel = this.velocity;
      var mx = this.dead ? 0 : this.moveInput.x;
      var mz = this.dead ? 0 : this.moveInput.z;

      // Anisotropic wish vector: strafing and backpedalling are slower, but the
      // resulting DIRECTION is still exactly where the stick points.
      var fw = mz * (mz < 0 ? C.BACK_SCALE : 1);
      var sw = mx * C.STRAFE_SCALE;
      _wish.set(this.forward.x * fw + this.right.x * sw, 0,
                this.forward.z * fw + this.right.z * sw);
      var wl = Math.sqrt(_wish.x * _wish.x + _wish.z * _wish.z);
      var wishSpeed = 0;
      if (wl > 1e-4) {
        _wish.x /= wl; _wish.z /= wl;
        wishSpeed = this._targetSpeed() * Math.min(1, wl);
      } else {
        _wish.set(0, 0, 0);
      }

      var sliding = this.state === 'slide';
      if (sliding) {
        this._updateSlide(dt, ctx);
      } else if (this.grounded) {
        this._friction(dt, 1);
        if (wishSpeed > 0) this._accelerate(_wish, wishSpeed, C.ACCEL_GROUND, dt);
      } else {
        if (wishSpeed > 0) {
          this._accelerate(_wish, wishSpeed, C.ACCEL_AIR, dt);
          // Classic air-strafe: a second pass with a hard low wishspeed cap.
          // Turning the mouse while holding pure strafe redirects (and slightly
          // adds to) momentum instead of fighting it.
          if (Math.abs(mz) < 0.01 && Math.abs(mx) > 0.01) {
            this._accelerate(_wish, Math.min(wishSpeed, C.AIR_STRAFE_CAP),
                             C.AIR_STRAFE_ACCEL, dt);
          }
        }
      }

      // Gravity is applied as two half steps around the move (velocity Verlet).
      // A single full step is what makes naive controllers land ~5% short of
      // their designed jump apex, and makes that error framerate dependent.
      var halfG = C.GRAVITY * dt * 0.5;
      vel.y += halfG;
      if (vel.y < C.TERMINAL) vel.y = C.TERMINAL;

      var wasGrounded = this.grounded;
      var prevVy = vel.y;

      var contact = this._move(dt);

      // ---- ground probe ----------------------------------------------------
      var snap = 0;
      if (!this._jumpedThisFrame) {
        if (wasGrounded) snap = C.SNAP_DOWN;             // stairs + slope descent
        else if (vel.y <= 0.1) snap = 0.06;              // precise landing contact
      }
      var g = snap > 0 ? this._groundProbe(snap) : false;
      this.grounded = g || (contact && vel.y <= 0.001 && !this._jumpedThisFrame);

      // Fallback floor: with no level at all the player must still stand up.
      if (!this.grounded && this._colliderCount === 0 && this.position.y <= 0) {
        this.position.y = 0;
        this.groundNormal.set(0, 1, 0);
        this.grounded = true;
      }

      if (this.grounded) {
        if (this.velocity.y < 0) this.velocity.y = 0;
        this.coyote = C.COYOTE;
      } else {
        vel.y += halfG;                       // second half of the Verlet step
        if (vel.y < C.TERMINAL) vel.y = C.TERMINAL;
        this.coyote -= dt;
        this.groundNormal.set(0, 1, 0);
      }
      if (this.grounded && !wasGrounded) this._onLand(ctx, -prevVy);
    }

    _targetSpeed() {
      var base = this.crouching
        ? C.SPEED_CROUCH
        : M.lerp(C.SPEED_WALK, C.SPEED_SPRINT, this.sprintBlend);
      if (this.adsT > 0) base = M.lerp(base, Math.min(base, C.SPEED_ADS), this.adsEase);
      // In the air keep the reference speed at least walk pace so air control
      // does not collapse when you jump while aiming.
      if (!this.grounded) base = Math.max(base, C.SPEED_WALK);
      return base;
    }

    // Quake accelerate: only adds speed along wishDir, and only up to
    // wishSpeed. Momentum above wishSpeed in other directions is untouched.
    _accelerate(wishDir, wishSpeed, accel, dt) {
      var cur = this.velocity.x * wishDir.x + this.velocity.z * wishDir.z;
      var add = wishSpeed - cur;
      if (add <= 0) return;
      var a = accel * dt;
      if (a > add) a = add;
      this.velocity.x += wishDir.x * a;
      this.velocity.z += wishDir.z * a;
    }

    _friction(dt, scale) {
      var vx = this.velocity.x, vz = this.velocity.z;
      var sp = Math.sqrt(vx * vx + vz * vz);
      if (sp < 1e-4) { this.velocity.x = 0; this.velocity.z = 0; return; }
      var drop = Math.max(sp, C.STOP_SPEED) * C.FRICTION * scale * dt;
      var ns = Math.max(0, sp - drop) / sp;
      this.velocity.x *= ns;
      this.velocity.z *= ns;
    }

    // ------------------------------------------------------------------------
    // Slide
    // ------------------------------------------------------------------------
    _startSlide(ctx) {
      var vx = this.velocity.x, vz = this.velocity.z;
      var sp = Math.sqrt(vx * vx + vz * vz);
      var dx, dz;
      if (sp > 0.4) { dx = vx / sp; dz = vz / sp; }
      else { dx = this.forward.x; dz = this.forward.z; }
      var boost = Math.max(sp * 1.16, C.SLIDE_BOOST);
      this.velocity.x = dx * boost;
      this.velocity.z = dz * boost;
      this.state = 'slide';
      this.slideTime = 0;
      this.fovKick += C.FOV_SLIDE;
      this._viewImpulse(-0.055);
      // Roll into whichever side the look direction sits relative to travel.
      this._rollSide = (this.right.x * dx + this.right.z * dz) >= 0 ? -1 : 1;
      this._emit('player:slide', {
        phase: 'start',
        position: this.position.clone(),
        speed: boost,
        material: this.groundMaterial
      });
    }

    _updateSlide(dt, ctx) {
      var vel = this.velocity;
      this.slideTime += dt;

      var sp = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
      if (sp > 0.05) {
        // Steering: rotate the travel direction toward where you look, rate
        // limited. This is the single biggest reason a slide feels controlled
        // rather than like being on ice.
        var dx = vel.x / sp, dz = vel.z / sp;
        var cross = dx * this.forward.z - dz * this.forward.x;
        var dot = M.clamp(dx * this.forward.x + dz * this.forward.z, -1, 1);
        var ang = Math.atan2(-cross, dot);
        var maxTurn = C.SLIDE_STEER * dt;
        var turn = M.clamp(ang, -maxTurn, maxTurn);
        var cs = Math.cos(turn), sn = Math.sin(turn);
        vel.x = dx * cs - dz * sn;
        vel.z = dx * sn + dz * cs;
        vel.x *= sp; vel.z *= sp;
      }

      // Slopes: project gravity onto the ground plane, so downhill slides carry
      // and uphill slides die. Physically correct and reads instantly.
      if (this.grounded) {
        var n = this.groundNormal;
        vel.x += -C.GRAVITY * n.y * n.x * dt;
        vel.z += -C.GRAVITY * n.y * n.z * dt;
      }

      var decay = Math.exp(-C.SLIDE_DECAY * dt);
      vel.x *= decay;
      vel.z *= decay;

      var speedNow = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
      var done = false;
      if (this.slideTime > C.SLIDE_MIN_TIME) {
        if (speedNow < C.SLIDE_END_SPEED) done = true;
        else if (this.slideTime > C.SLIDE_MAX_TIME) done = true;
        else if (!this._crouchHeld) done = true;
      }
      if (!this.grounded && this.slideTime > 0.14) done = true;
      if (done) this._endSlide(ctx, true);
    }

    _endSlide(ctx, toCrouch) {
      if (this.state !== 'slide') return;
      this.state = this.grounded ? (toCrouch && this._crouchHeld ? 'crouch' : 'idle') : 'air';
      this.slideCooldown = C.SLIDE_COOLDOWN;
      this._emit('player:slide', {
        phase: 'end',
        position: this.position.clone(),
        speed: this.speed,
        material: this.groundMaterial
      });
    }

    // ------------------------------------------------------------------------
    // Mantle / vault
    // ------------------------------------------------------------------------
    _tryMantle(ctx) {
      if (this.state === 'mantle' || this.dead) return false;
      var pos = this.position;
      var f = this.forward;

      // 1) something solid at chest height, roughly vertical
      _probe.set(pos.x, pos.y + 0.55, pos.z);
      var wallDist = this._ray(_probe, f, C.RADIUS + 0.55);
      if (wallDist < 0 || Math.abs(this._rayN.y) > 0.55) return false;

      // 2) head height must be clear, otherwise it is a wall not a ledge
      _probe.set(pos.x, pos.y + C.STAND_H + 0.10, pos.z);
      if (this._ray(_probe, f, C.RADIUS + 0.80) >= 0) return false;

      // 3) find the top surface just past the face
      var fx = pos.x + f.x * (wallDist + 0.28);
      var fz = pos.z + f.z * (wallDist + 0.28);
      _probe.set(fx, pos.y + C.MANTLE_MAX + 0.40, fz);
      var d = this._ray(_probe, _down, C.MANTLE_MAX + 0.60);
      if (d < 0 || this._rayN.y < 0.70) return false;

      var ledgeY = this._rayP.y;
      var h = ledgeY - pos.y;
      if (h < C.MANTLE_MIN || h > C.MANTLE_MAX) return false;

      // 4) somewhere to actually stand once up there
      _tgt.set(fx + f.x * 0.20, ledgeY + 0.03, fz + f.z * 0.20);
      if (this._overlapAt(_tgt, C.RADIUS * 0.92, C.CROUCH_H, 0.02)) return false;

      this._mantleFrom.copy(pos);
      this._mantleTo.copy(_tgt);
      this._mantleDur = M.clamp(0.26 + h * 0.10, 0.26, 0.46);
      this._mantleT = 0;
      this.mantleProgress = 0;
      this.mantleDir.set(f.x, 0, f.z);
      this.state = 'mantle';
      this.velocity.set(0, 0, 0);
      this.grounded = false;
      this.sprinting = false;
      this.isADS = false;
      this._crouchToggle = false;
      this._rollSide = (this._frame & 1) ? 1 : -1;
      this._emit('player:mantle', {
        position: this._mantleFrom.clone(),
        target: this._mantleTo.clone(),
        height: h,
        duration: this._mantleDur,
        material: this._rayMat
      });
      return true;
    }

    _updateMantle(dt, ctx) {
      this._mantleT += dt / this._mantleDur;
      var t = M.saturate(this._mantleT);
      this.mantleProgress = t;

      // Vertical leads, horizontal follows: you rise onto the ledge and are
      // then carried over it. Doing both linearly clips you through the lip.
      var vt = M.smootherstep(0, 0.72, t);
      var ht = M.smootherstep(0.18, 1.0, t);
      var arc = Math.sin(t * Math.PI) * 0.11;

      this.position.x = M.lerp(this._mantleFrom.x, this._mantleTo.x, ht);
      this.position.z = M.lerp(this._mantleFrom.z, this._mantleTo.z, ht);
      this.position.y = M.lerp(this._mantleFrom.y, this._mantleTo.y, vt) + arc;
      this.velocity.set(0, 0, 0);

      if (t >= 1) {
        this.state = 'idle';
        this.grounded = true;
        this.mantleProgress = 0;
        // A little exit momentum keeps the vault from feeling like a teleport.
        this.velocity.set(this.mantleDir.x * 1.9, 0, this.mantleDir.z * 1.9);
        this._queryCandidates(dt);
        this._depenetrate(4, false);
        this._groundProbe(C.SNAP_DOWN);
        this._viewImpulse(-0.03);
      }
    }

    // ------------------------------------------------------------------------
    // Collision
    // ------------------------------------------------------------------------
    _refreshBroadphase() {
      var lvl = this.ctx && this.ctx.level;
      var cols = (lvl && lvl.colliders) || _emptyList;
      if (cols === this._colliders && cols.length === this._colliderCount) return;
      this._colliders = cols;
      this._colliderCount = cols.length;
      this._hash.clear();
      this._big.length = 0;
      var cs = this._hash.cell;
      for (var i = 0; i < cols.length; i++) {
        var c = cols[i];
        if (!c || !c.center) continue;
        if (c.type === 'sphere') {
          var r = c.radius || 0;
          _min.set(c.center.x - r, c.center.y - r, c.center.z - r);
          _max.set(c.center.x + r, c.center.y + r, c.center.z + r);
        } else {
          if (!c.halfExtents) continue;
          COL.boxBounds(c, _min, _max);
        }
        // A 70m ground slab would otherwise occupy thousands of cells and make
        // insertion (and every query that touches it) pointless work.
        var cells = ((_max.x - _min.x) / cs + 1) * ((_max.y - _min.y) / cs + 1) *
                    ((_max.z - _min.z) / cs + 1);
        if (cells > 2500) this._big.push(c);
        else this._hash.insert(c, _min, _max);
      }
    }

    _queryCandidates(dt) {
      var p = this.position, r = this.capsuleRadius, h = this.capsuleHeight;
      var ex = Math.abs(this.velocity.x * dt), ey = Math.abs(this.velocity.y * dt);
      var ez = Math.abs(this.velocity.z * dt);
      var pad = 0.75;   // covers step-up (0.35) and snap-down (0.30)
      _min.set(p.x - r - ex - pad, p.y - ey - pad, p.z - r - ez - pad);
      _max.set(p.x + r + ex + pad, p.y + h + ey + pad, p.z + r + ez + pad);
      this._hash.query(_min, _max, this._cands);
      for (var i = 0; i < this._big.length; i++) this._cands.push(this._big[i]);
      return this._cands;
    }

    _shapeMTV(c, base, r, h, out) {
      if (!c || c.solid === false || c.trigger) return 0;
      if (c.type === 'sphere') {
        if (!c.center) return 0;
        var y0 = base.y + r, y1 = base.y + h - r;
        var cy = M.clamp(c.center.y, Math.min(y0, y1), Math.max(y0, y1));
        var dx = base.x - c.center.x, dy = cy - c.center.y, dz = base.z - c.center.z;
        var rr = r + (c.radius || 0);
        var d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > rr * rr) return 0;
        var d = Math.sqrt(d2);
        if (d > 1e-6) out.set(dx / d, dy / d, dz / d);
        else out.set(0, 1, 0);
        return rr - d;
      }
      if (!c.center || !c.halfExtents) return 0;
      return COL.capsuleBoxMTV(base, r, h, c, out);
    }

    // Resolve the deepest overlap, re-test, repeat. Converges cleanly in a
    // corner where a naive "push out of everything at once" oscillates.
    _depenetrate(iters, clipVel) {
      var cands = this._cands, pos = this.position;
      var r = this.capsuleRadius, h = this.capsuleHeight;
      var grounded = false;
      this._hitWall = false;
      for (var it = 0; it < iters; it++) {
        var bestD = 1e-5, bestC = null;
        for (var i = 0; i < cands.length; i++) {
          var d = this._shapeMTV(cands[i], pos, r, h, _n);
          if (d > bestD) { bestD = d; _bn.copy(_n); bestC = cands[i]; }
        }
        if (!bestC) break;
        pos.addScaledVector(_bn, bestD + 1e-4);
        if (_bn.y > C.GROUND_MIN_Y) {
          grounded = true;
          this.groundNormal.copy(_bn);
          if (bestC.material) this.groundMaterial = bestC.material;
        } else {
          // Anything not walkable counts as a wall for step-up purposes,
          // including the shallow slanted normal a capsule gets from a step's
          // top edge - that contact is exactly the one we want to climb.
          this._hitWall = true;
        }
        if (clipVel !== false) {
          var vn = this.velocity.dot(_bn);
          if (vn < 0) this.velocity.addScaledVector(_bn, -vn);   // slide along
        }
      }
      return grounded;
    }

    _maxOverlap(p) {
      var cands = this._cands, best = 0;
      for (var i = 0; i < cands.length; i++) {
        var d = this._shapeMTV(cands[i], p, this.capsuleRadius, this.capsuleHeight, _n);
        if (d > best) best = d;
      }
      return best;
    }

    _overlapAt(p, r, h, tol) {
      var min = _v1, max = _v2;
      min.set(p.x - r, p.y, p.z - r);
      max.set(p.x + r, p.y + h, p.z + r);
      this._hash.query(min, max, this._cands2);
      var list = this._cands2;
      var i;
      for (i = 0; i < list.length; i++) {
        if (this._shapeMTV(list[i], p, r, h, _n) > (tol || 0.015)) return true;
      }
      for (i = 0; i < this._big.length; i++) {
        if (this._shapeMTV(this._big[i], p, r, h, _n) > (tol || 0.015)) return true;
      }
      return false;
    }

    // Head-clearance probe: a shrunk capsule occupying only the band between
    // crouch height and stand height, so brushing a wall never blocks standing.
    _headBlocked() {
      var r = C.RADIUS * 0.86;
      var h = C.STAND_H - C.CROUCH_H + r;
      _probe.set(this.position.x, this.position.y + C.CROUCH_H - r, this.position.z);
      var cands = this._cands;
      for (var i = 0; i < cands.length; i++) {
        if (this._shapeMTV(cands[i], _probe, r, h, _n) > 0.02) return true;
      }
      return false;
    }

    _move(dt) {
      var pos = this.position;
      _v1.copy(this.velocity).multiplyScalar(dt);
      var len = _v1.length();
      if (len < 1e-7) return this._depenetrate(4, true);

      // Substep so a fast fall cannot tunnel through a floor.
      var steps = Math.min(6, Math.max(1, Math.ceil(len / (C.RADIUS * 0.7))));
      _v2.copy(_v1).divideScalar(steps);
      var contact = false;
      for (var s = 0; s < steps; s++) {
        var bx = pos.x, by = pos.y, bz = pos.z;
        pos.add(_v2);
        var g = this._depenetrate(5, true);
        contact = contact || g;
        if (this._hitWall && (this.grounded || g) && this.state !== 'mantle') {
          if (this._tryStepUp(bx, by, bz, _v2)) contact = true;
        }
      }
      return contact;
    }

    // Lift, move, settle. Costs one extra depenetration pass, and only when a
    // grounded move actually got blocked by a wall.
    _tryStepUp(bx, by, bz, step) {
      var pos = this.position;
      var ax = pos.x, ay = pos.y, az = pos.z;
      var progA = (ax - bx) * (ax - bx) + (az - bz) * (az - bz);
      var svx = this.velocity.x, svz = this.velocity.z;

      pos.set(bx, by + C.STEP_HEIGHT, bz);
      if (this._maxOverlap(pos) > 0.02) { pos.set(ax, ay, az); return false; }

      pos.x += step.x;
      pos.z += step.z;
      this._depenetrate(4, false);
      var landed = this._groundProbe(C.STEP_HEIGHT + 0.05);
      var progB = (pos.x - bx) * (pos.x - bx) + (pos.z - bz) * (pos.z - bz);
      if (!landed || progB <= progA + 1e-5) { pos.set(ax, ay, az); return false; }

      // A step must not cost momentum, so undo the velocity the wall clipped.
      this.velocity.x = svx;
      this.velocity.z = svz;
      this.velocity.y = 0;
      this.grounded = true;
      return true;
    }

    // Drop by maxDrop, then settle back onto whatever is underneath. Gives
    // exact surface contact with zero per-frame oscillation, and doubles as
    // slope and stair snapping. maxDrop must stay below the capsule radius or
    // the bottom sphere clears the surface entirely and finds nothing.
    //
    // Two details make or break this:
    //  * contacts are accepted well below the walkable slope limit, because a
    //    capsule bridging a step edge reports a shallow slanted normal;
    //  * the resolve is VERTICAL, not along the contact normal. Pushing along
    //    an edge normal shoves the player back the way they came, which is the
    //    classic "character refuses to climb stairs" stall.
    _groundProbe(maxDrop) {
      var pos = this.position, y0 = pos.y;
      var r = this.capsuleRadius, h = this.capsuleHeight;
      var cands = this._cands;
      var drop = Math.min(maxDrop, r - 0.02);
      pos.y -= drop;
      var budget = drop + 0.002;          // a probe may never lift the player
      var found = false, walkable = false;
      for (var it = 0; it < 4; it++) {
        var bestD = 1e-5, bestC = null;
        for (var i = 0; i < cands.length; i++) {
          var d = this._shapeMTV(cands[i], pos, r, h, _n);
          if (d > bestD && _n.y > 0.15) { bestD = d; _bn.copy(_n); bestC = cands[i]; }
        }
        if (!bestC || budget <= 0) break;
        // Exact vertical separation for a sphere-vs-surface contact: raise the
        // bottom sphere until its centre is again `r` from the contact point.
        var dist = Math.max(0, r - bestD);
        var dy = _bn.y * dist;
        var dh2 = Math.max(0, dist * dist - dy * dy);
        var lift = Math.min(Math.sqrt(Math.max(0, r * r - dh2)) - dy + 1e-4, budget);
        if (lift <= 0) break;
        pos.y += lift;
        budget -= lift;
        found = true;
        if (_bn.y > C.GROUND_MIN_Y) { walkable = true; this.groundNormal.copy(_bn); }
        else if (!walkable) { this.groundNormal.set(0, 1, 0); }   // an edge is not a slope
        if (bestC.material) this.groundMaterial = bestC.material;
      }
      if (!found) pos.y = y0;
      else if (pos.y > y0) pos.y = y0;
      return found;
    }

    // ------------------------------------------------------------------------
    // Raycast against the collider set (used by mantle detection).
    // ------------------------------------------------------------------------
    _ray(origin, dir, maxDist) {
      var ox = origin.x, oy = origin.y, oz = origin.z;
      var ex = ox + dir.x * maxDist, ey = oy + dir.y * maxDist, ez = oz + dir.z * maxDist;
      _min.set(Math.min(ox, ex) - 0.05, Math.min(oy, ey) - 0.05, Math.min(oz, ez) - 0.05);
      _max.set(Math.max(ox, ex) + 0.05, Math.max(oy, ey) + 0.05, Math.max(oz, ez) + 0.05);
      this._hash.query(_min, _max, this._rayCands);
      var list = this._rayCands;
      var best = -1, i, c, t;
      for (i = 0; i < list.length + this._big.length; i++) {
        c = i < list.length ? list[i] : this._big[i - list.length];
        if (!c || !c.center || c.solid === false || c.trigger) continue;
        if (c.type === 'sphere') t = COL.raycastSphere(origin, dir, c.center, c.radius || 0, _rayOut);
        else if (c.halfExtents) t = COL.raycastBox(origin, dir, c, _rayOut);
        else continue;
        if (t >= 0 && t <= maxDist && (best < 0 || t < best)) {
          best = t;
          this._rayN.copy(_rayOut.normal);
          this._rayP.copy(_rayOut.point);
          this._rayMat = c.material || 'concrete';
        }
      }
      return best;
    }

    // ------------------------------------------------------------------------
    // Landing, stride, health
    // ------------------------------------------------------------------------
    _onLand(ctx, impact) {
      impact = Math.max(0, impact);
      var s = M.saturate(impact / 13);
      // Dip + spring return. springDamp needs a non-zero offset to work from,
      // otherwise its overshoot guard snaps the injected velocity straight back.
      this._viewImpulse(-(0.035 + s * 0.155));
      this.punchPitch -= s * 0.045;
      if (impact > 9) this.fovKick += Math.min(4.5, (impact - 9) * 0.55);
      if (impact > 6.5 && ctx.postfx && ctx.postfx.addImpulse) {
        try { ctx.postfx.addImpulse('shake', M.saturate((impact - 6.5) / 12) * 0.6); }
        catch (e) { GAME.logError('player.landImpulse', e); }
      }
      this._emit('player:land', {
        position: this.position.clone(),
        impact: impact,
        hard: impact > 9,
        material: this.groundMaterial,
        speed: this.speed
      });
      // Reset the stride so the first step after landing is a full one.
      this.bobPhase = 0;
      this._nextStep = Math.PI;
      if (impact > C.FALL_DAMAGE_SPEED && !this.dead) {
        this.takeDamage(Math.min(85, (impact - C.FALL_DAMAGE_SPEED) * 9), null);
      }
    }

    _viewImpulse(mag) {
      this.landOffset += mag;
      this._landVel.v += mag * 4.5;
    }

    _updateStateName() {
      if (this.state === 'mantle' || this.state === 'slide') return;
      if (this.dead) { this.state = 'idle'; return; }
      if (!this.grounded) this.state = 'air';
      else if (this.crouching) this.state = 'crouch';
      else if (this.sprinting && this.speed > 1.5) this.state = 'sprint';
      else if (this.speed > 0.35) this.state = 'walk';
      else this.state = 'idle';
    }

    // Bob phase is driven by DISTANCE travelled, not by time, so footsteps land
    // on the stride no matter the speed and never sound like a treadmill.
    _updateStride(dt, ctx) {
      var moving = this.grounded && this.speed > 0.35 &&
                   this.state !== 'slide' && this.state !== 'mantle';
      var target = moving ? M.saturate(this.speed / C.SPEED_WALK) : 0;
      this.bobAmp = M.damp(this.bobAmp, target, moving ? 7 : 9, dt);

      if (moving) {
        var stepDist = M.lerp(1.22, 1.95, M.saturate((this.speed - 2.0) / 4.4));
        if (this.crouching) stepDist *= 0.72;
        // pi of phase == one step == stepDist metres travelled
        this.bobPhase += (this.speed / stepDist) * Math.PI * dt;
        var guard = 0;
        while (this.bobPhase >= this._nextStep && guard++ < 4) {
          this._nextStep += Math.PI;
          this._footstep(ctx);
        }
      } else if (this.bobAmp < 0.02) {
        this.bobPhase = 0;
        this._nextStep = Math.PI;
      }
    }

    _footstep(ctx) {
      this._foot ^= 1;
      var vol = M.saturate(this.speed / C.SPEED_SPRINT);
      if (this.crouching) vol *= 0.45;
      // A heel strike nudges the head down a hair - free weight in the walk.
      this._viewImpulse(-0.0035 * this.bobAmp * (0.5 + vol));
      this._emit('player:footstep', {
        position: this.position.clone(),
        material: this.groundMaterial,
        foot: this._foot ? 'right' : 'left',
        speed: this.speed,
        volume: 0.25 + vol * 0.75,
        sprint: this.state === 'sprint',
        crouch: this.crouching
      });
    }

    _updateHealth(dt, ctx) {
      if (this.spawnProtect > 0) this.spawnProtect -= dt;
      if (this.dead) {
        this.deathTimer -= dt;
        if (this.deathTimer <= 0) this.respawn();
        return;
      }
      if (this.regenTimer > 0) {
        this.regenTimer -= dt;
      } else if (this.health < this.maxHealth) {
        this.health = Math.min(this.maxHealth, this.health + C.REGEN_RATE * dt);
        if (ctx.hud && ctx.hud.setHealth) {
          try { ctx.hud.setHealth(this.health); } catch (e) { GAME.logError('player.hud', e); }
        }
      }
    }

    // ------------------------------------------------------------------------
    // Damage / death / respawn
    // ------------------------------------------------------------------------
    takeDamage(amount, fromDirection) {
      if (this.dead || !(amount > 0)) return this.health;
      // Post-spawn immunity. Being deleted before the fade-in finishes is not
      // difficulty, it is a coin flip, and it suppresses every movement verb
      // the player has for the length of the respawn timer.
      if (this.spawnProtect > 0) return this.health;
      var ctx = this.ctx;
      this.health = Math.max(0, this.health - amount);
      this.regenTimer = C.REGEN_DELAY;

      var dx = 0, dz = -1;
      if (fromDirection && typeof fromDirection.x === 'number') {
        dx = fromDirection.x; dz = fromDirection.z;
        var l = Math.sqrt(dx * dx + dz * dz);
        if (l > 1e-5) { dx /= l; dz /= l; } else { dx = 0; dz = -1; }
      }
      // Punch the view away from the impact so the hit direction is readable
      // before the HUD indicator is even parsed.
      var side = this.right.x * dx + this.right.z * dz;
      var fwdDot = this.forward.x * dx + this.forward.z * dz;
      var mag = M.clamp(amount / 32, 0.15, 1.4);
      this.punchPitch += mag * 0.030 * (0.35 + 0.65 * Math.max(0, fwdDot));
      this.punchYaw -= side * mag * 0.022;
      this.punchRoll -= side * mag * 0.055;
      this._viewImpulse(-mag * 0.022);

      if (ctx) {
        if (ctx.postfx && ctx.postfx.addImpulse) {
          try { ctx.postfx.addImpulse('hit', M.saturate(amount / 45)); }
          catch (e) { GAME.logError('player.hitImpulse', e); }
        }
        if (ctx.hud) {
          try {
            if (ctx.hud.setHealth) ctx.hud.setHealth(this.health);
            if (ctx.hud.damageIndicator && fromDirection) ctx.hud.damageIndicator(fromDirection);
          } catch (e) { GAME.logError('player.hud', e); }
        }
      }
      this._emit('player:damage', {
        amount: amount,
        health: this.health,
        direction: fromDirection || null,
        position: this.position.clone()
      });

      if (this.health <= 0) {
        this.dead = true;
        this.deathTimer = C.RESPAWN_TIME;
        this.sprinting = false;
        this.isADS = false;
        this.canFire = false;
        this.velocity.multiplyScalar(0.25);
        this._emit('player:death', { position: this.position.clone() });
      }
      return this.health;
    }

    respawn() {
      this.dead = false;
      this.health = this.maxHealth;
      this.regenTimer = 0;
      this.deathTimer = 0;
      this.spawnProtect = C.SPAWN_PROTECT;
      this.position.copy(this.spawn.position);
      this.yaw = this.spawn.yaw;
      this.pitch = 0;
      this.velocity.set(0, 0, 0);
      this.state = 'idle';
      this.eyeHeight = C.EYE_STAND;
      this.crouchT = 0;
      this.crouching = false;
      // Clear every stance latch, or the first frame back can inherit a sprint
      // blend / slide cooldown from the life that just ended.
      this.sprinting = false;
      this._sprintRaw = 0;
      this.sprintBlend = 0;
      this.sprintLock = 0;
      this.slideCooldown = 0;
      this.slideTime = 0;
      this.coyote = 0;
      this.jumpBuffer = -1;
      this._crouchToggle = false;
      this.landOffset = 0;
      this._landVel.v = 0;
      this.punchPitch = this.punchYaw = this.punchRoll = 0;
      this._updateBasis();
      this._emit('player:respawn', { position: this.position.clone() });
      var ctx = this.ctx;
      if (ctx && ctx.hud && ctx.hud.setHealth) {
        try { ctx.hud.setHealth(this.health); } catch (e) { GAME.logError('player.hud', e); }
      }
    }

    teleport(pos, yaw) {
      if (pos) this.position.copy(pos);
      if (typeof yaw === 'number') this.yaw = yaw;
      this.velocity.set(0, 0, 0);
      this.landOffset = 0;
      this._landVel.v = 0;
      this._updateBasis();
    }

    getEyePosition(out) {
      out = out || new V3();
      return out.copy(this.headPosition);
    }

    _emit(name, payload) {
      var bus = (this.ctx && this.ctx.bus) || GAME.bus;
      if (bus && bus.emit) bus.emit(name, payload);
    }

    // ========================================================================
    // View
    // ========================================================================
    _updateView(dt, ctx) {
      var cam = ctx.camera;
      if (!cam) return;
      this._updateBasis();

      var frozen = !!this.frozen;
      var bobX = 0, bobY = 0, bobZ = 0, bobRoll = 0;
      var yawOff = 0, pitchOff = 0;

      if (frozen) {
        // Collapse every procedural offset so the authored pose is exact.
        var k = Math.exp(-18 * dt);
        this.bobAmp *= k;
        this.landOffset *= k;
        this._landVel.v *= k;
        this.leanRoll *= k;
        this.slideRoll *= k;
        this.punchPitch *= k;
        this.punchYaw *= k;
        this.punchRoll *= k;
        this.fovKick *= k;
      } else {
        // ---- figure-8 view bob (1:2 Lissajous) ---------------------------
        // x traces once per stride, y twice, giving the classic figure-8 head
        // path. y is written as (1-cos) so it is exactly zero at foot-plant -
        // no pop when the bob fades in or out.
        var amp = this.bobAmp;
        if (amp > 0.0005) {
          var scale = M.lerp(1, 1.55, this.sprintBlend);
          if (this.crouching) scale *= 0.62;
          scale *= M.lerp(1, 0.16, this.adsEase);      // heavily damped when aiming
          var p = this.bobPhase;
          var a = amp * scale;
          bobX = Math.sin(p) * C.BOB_X * a;
          bobY = (1 - Math.cos(2 * p)) * 0.5 * C.BOB_Y * a;
          bobZ = Math.sin(2 * p) * C.BOB_Z * a;
          bobRoll = Math.sin(p) * C.BOB_ROLL * a;
        }

        // ---- breathing: never let the view be perfectly static ------------
        var t = ctx.time || 0;
        var still = 1 - M.saturate(this.speed / 2.5);
        var bAmp = (0.0011 + 0.0020 * this.adsEase) * (0.30 + 0.70 * still);
        yawOff += GAME.noise.perlin2(t * 0.31, 11.3) * bAmp;
        pitchOff += GAME.noise.perlin2(t * 0.27, 41.7) * bAmp;
        bobY += Math.sin(t * 1.15) * 0.0042 * still * M.lerp(1, 0.35, this.adsEase);

        // ---- strafe lean --------------------------------------------------
        var leanTarget = -this.moveInput.x * C.LEAN_ROLL *
                         M.lerp(1, 0.35, this.adsEase) * (this.grounded ? 1 : 0.6);
        this.leanRoll = M.damp(this.leanRoll, leanTarget, 7.5, dt);

        // ---- slide / mantle roll ------------------------------------------
        var slideRollTarget = this.state === 'slide' ? this._rollSide * 5.0 * DEG : 0;
        this.slideRoll = M.damp(this.slideRoll, slideRollTarget, 9, dt);
        if (this.state === 'mantle') {
          var mt = Math.sin(this.mantleProgress * Math.PI);
          bobRoll += mt * 3.6 * DEG * this._rollSide;
          pitchOff += mt * -2.6 * DEG;
          // slight lateral reach toward the hand planting on the ledge
          bobX += mt * 0.05 * this._rollSide;
        }
        if (this.dead) this.punchRoll = M.damp(this.punchRoll, 16 * DEG, 3, dt);

        this.punchPitch = M.damp(this.punchPitch, 0, 6.5, dt);
        this.punchYaw = M.damp(this.punchYaw, 0, 6.5, dt);
        if (!this.dead) this.punchRoll = M.damp(this.punchRoll, 0, 6.0, dt);
      }

      // ---- landing dip spring ---------------------------------------------
      this.landOffset = M.springDamp(this.landOffset, 0, this._landVel, 0.185, dt);
      if (this.landOffset < -0.42) this.landOffset = -0.42;

      var roll = this.leanRoll + bobRoll + this.slideRoll + this.punchRoll;
      var pitch = M.clamp(this.pitch + pitchOff + this.punchPitch, -89.5 * DEG, 89.5 * DEG);
      var yaw = this.yaw + yawOff + this.punchYaw;

      this._writeCamera(ctx, bobX, bobY + this.landOffset, bobZ, pitch, yaw, roll);
      if (!frozen) this._updateFov(dt, ctx);
      this._syncViewCamera(ctx, roll);
    }

    _writeCamera(ctx, bobX, bobY, bobZ, pitch, yaw, roll) {
      var cam = ctx.camera;
      var p = this.position;
      var eye = this.eyeHeight + bobY;
      this.headPosition.set(
        p.x + this.right.x * bobX + this.forward.x * bobZ,
        p.y + eye,
        p.z + this.right.z * bobX + this.forward.z * bobZ);
      cam.position.copy(this.headPosition);
      cam.rotation.order = 'YXZ';
      cam.rotation.set(pitch, yaw, roll, 'YXZ');
      this.viewRoll = roll;
      this.viewOffset.set(bobX, bobY, bobZ);
    }

    _updateFov(dt, ctx) {
      var cam = ctx.camera;
      var base = (ctx.settings && ctx.settings.fov) || this._baseFov || cam.fov;
      this.fovKick = M.damp(this.fovKick, 0, 4.2, dt);

      var target = base + C.FOV_SPRINT * this.sprintBlend + this.fovKick;
      if (this.adsEase > 0.0001) {
        var adsFov = this._weaponNum('adsFov', base * C.ADS_FOV_SCALE);
        target = M.lerp(target, adsFov + this.fovKick * 0.25, this.adsEase);
      }
      var next = M.damp(cam.fov, target, 16, dt);
      if (Math.abs(next - cam.fov) > 0.003) {
        cam.fov = next;
        cam.updateProjectionMatrix();
      }
    }

    // The viewmodel is authored in camera space in its own scene, so the view
    // camera stays at the origin and only inherits ROLL (lean, slide, mantle) -
    // copying yaw/pitch here would swing the gun out of frame. A weapon module
    // that would rather work in world space can opt in with
    // ctx.viewCamera.userData.followWorld = true.
    _syncViewCamera(ctx, roll) {
      var vc = ctx.viewCamera;
      if (!vc) return;
      vc.rotation.order = 'YXZ';
      if (vc.userData && vc.userData.followWorld) {
        vc.position.copy(ctx.camera.position);
        vc.rotation.set(ctx.camera.rotation.x, ctx.camera.rotation.y, ctx.camera.rotation.z, 'YXZ');
      } else {
        vc.rotation.set(0, 0, roll, 'YXZ');
      }
    }

    resize() { /* nothing viewport dependent */ }
  }

  GAME.PlayerController = PlayerController;
  GAME.PlayerTuning = C;

})(window.GAME, window.THREE);
