// ============================================================================
// OPERATION BLACKOUT - capture scenarios
// INTEGRATION FILE. Do not edit from a feature agent.
//
// Each scenario poses the world deterministically so the visual-critic agents
// screenshot the same framing every run and can compare builds fairly.
// Everything here is defensive: a scenario must still produce a picture when
// half the systems are missing.
//
// FRAMING CONVENTION - read this before touching a pose.
//   three.js cameras look down LOCAL -Z. place() writes rotation in 'YXZ', so
//   yaw = 0 looks toward world -Z and yaw = PI looks toward world +Z. The
//   market street runs along -Z (Z_SOUTH = +17 down to Z_NORTH = -55) and the
//   player spawns at the south end facing north, so nearly every pose in this
//   file wants a yaw near 0, NOT near PI. Two scenarios shipped with yaw = PI
//   and were therefore aimed at the back wall with their subject behind the
//   camera; that is why enemy_closeup showed no enemy and materials.png showed
//   a shopfront instead of the material chart. Prefer lookAtPoint(), which
//   solves the yaw from the subject and cannot get this wrong. The material
//   chart is the one pose that genuinely wants yaw = PI, and it says so.
// ============================================================================
(function (window, THREE) {
  'use strict';

  var GAME = window.GAME;
  var V = THREE.Vector3;

  function place(ctx, pos, yaw, pitch) {
    var cam = ctx.camera;
    cam.position.set(pos[0], pos[1], pos[2]);
    cam.rotation.set(pitch || 0, yaw || 0, 0, 'YXZ');
    if (ctx.player) {
      if (ctx.player.position) ctx.player.position.set(pos[0], pos[1] - (ctx.player.eyeHeight || 1.65), pos[2]);
      if ('yaw' in ctx.player) ctx.player.yaw = yaw || 0;
      if ('pitch' in ctx.player) ctx.player.pitch = pitch || 0;
      ctx.player.frozen = true;         // scenarios drive the camera, not input
    }
    ctx.viewCamera.rotation.set(0, 0, 0);
  }

  // Aim a camera at a world point instead of hand-tuning a yaw. Solving the
  // pose from the subject is the only way a framing stays correct when the
  // subject moves, and it removes the entire class of "camera faces the wrong
  // way" bug that this file shipped with.
  function lookAtPoint(ctx, pos, target, fov) {
    var dx = target.x - pos[0], dy = target.y - pos[1], dz = target.z - pos[2];
    var horiz = Math.sqrt(dx * dx + dz * dz);
    // forward for yaw t is (-sin t, 0, -cos t), so t = atan2(-dx, -dz)
    var yaw = Math.atan2(-dx, -dz);
    var pitch = Math.atan2(dy, Math.max(1e-4, horiz));
    place(ctx, pos, yaw, pitch);
    if (fov) setFov(ctx, fov);
    return { yaw: yaw, pitch: pitch, dist: Math.sqrt(horiz * horiz + dy * dy) };
  }

  function setFov(ctx, fov) {
    ctx.camera.fov = fov;
    ctx.camera.updateProjectionMatrix();
  }

  function timeOfDay(ctx, t) {
    if (ctx.sky && ctx.sky.setTimeOfDay) ctx.sky.setTimeOfDay(t);
  }

  function hideHud(ctx) {
    if (ctx.hud && ctx.hud.setVisible) ctx.hud.setVisible(false);
  }

  function hideViewmodel(ctx) {
    if (ctx.viewScene) ctx.viewScene.visible = false;
  }

  // The authored framings live in level.js (level.cameraPoses). These are the
  // same numbers, duplicated here ONLY as a fallback so a level that failed to
  // publish its poses still yields the intended composition rather than a shot
  // of the sky. Keep them in sync with Level.prototype._buildSpawns.
  var FALLBACK_POSES = {
    overview: { pos: [0.8, 20.0, 16.5], yaw: 0.092, pitch: -0.455 },
    street: { pos: [1.85, 1.66, 13.6], yaw: 0.062, pitch: -0.018 },
    interior: { pos: [-12.85, 1.61, -1.25], yaw: -2.03, pitch: -0.015 },
    alley: { pos: [15.2, 1.62, -3.95], yaw: 1.395, pitch: 0.035 },
    rooftop: { pos: [-7.85, 10.72, -11.6], yaw: -0.60, pitch: -0.185 }
  };

  // A named framing from the level, falling back to a sensible default.
  function look(ctx, key) {
    var def = FALLBACK_POSES[key] || FALLBACK_POSES.street;
    var pts = (ctx.level && ctx.level.cameraPoses) || null;
    var p = pts && pts[key];
    if (p && p.position) {
      place(ctx, [p.position.x, p.position.y, p.position.z], p.yaw || 0, p.pitch || 0);
      return true;
    }
    place(ctx, def.pos, def.yaw, def.pitch);
    return false;
  }

  // Pose the camera from a harbor level's published framing. Unlike the market
  // helper this does NOT carry duplicated fallback coordinates: the harbor
  // level is the single source of truth for its own framings, and if a pose is
  // missing we would rather stand at the spawn point than at a stale guess.
  function harborPose(ctx, key, fov) {
    var poses = (ctx.level && ctx.level.cameraPoses) || null;
    var p = poses && poses[key];
    if (p && p.position) {
      place(ctx, [p.position.x, p.position.y, p.position.z], p.yaw || 0, p.pitch || 0);
    } else {
      var sp = (ctx.level && ctx.level.spawnPoints && ctx.level.spawnPoints[0]) || null;
      if (sp && sp.position) {
        place(ctx, [sp.position.x, sp.position.y + 1.66, sp.position.z], sp.yaw || 0, 0);
      } else {
        place(ctx, [0, 1.66, 12], 0, 0);
      }
      GAME.logError('scenario', 'harbor pose "' + key + '" missing from level.cameraPoses');
    }
    if (fov) setFov(ctx, fov);
    // Storm night is the harbor's only condition; the sky's time-of-day dial
    // still drives the ambient term, so pin it to deep night.
    timeOfDay(ctx, 0.0);
    if (ctx.weather && ctx.weather.setPreset) {
      try { ctx.weather.setPreset('storm'); } catch (e) { GAME.logError('scenario.weather', e); }
    }
  }

  // Which level is loaded. The weapon and combat framings are SHARED by both
  // levels, so they are the only scenarios that have to ask.
  function isHarbor(ctx) {
    return !!(ctx && (ctx.levelId === 'harbor' ||
      (ctx.levelDef && ctx.levelDef.weather === 'storm')));
  }

  // Levels 3-10: the ones that publish the standard generic pose keys instead of
  // the two shipped levels' bespoke framings. Anything gated on this can never
  // move market or harbor, which is the point - both are frozen.
  function isGeneric(ctx) {
    return !!(ctx && ctx.levelId && ctx.levelId !== 'market' && !isHarbor(ctx));
  }

  // The standing pose every weapon/combat framing starts from.
  //
  // These used to call S.street() unconditionally. On the harbor that is wrong
  // twice over: level_harbor publishes no 'street' key, so look() fell through
  // to FALLBACK_POSES.street and planted the camera on the MARKET's measured
  // coordinates, and timeOfDay(0.32) then asked for mid-afternoon in a level
  // whose whole identity is 02:00 in a storm. Six of the fourteen harbor
  // captures - ads, weapon_closeup, muzzleflash, firefight, enemy_closeup and
  // explosion - were shot from a standpoint chosen for a different level.
  // (lighting.js pins the harbor clock itself, which is the only reason the
  // time-of-day half of that did not also print a container terminal at noon.)
  function baseShot(ctx, fov) {
    if (isHarbor(ctx)) {
      harborPose(ctx, 'containers', fov || 76);
      return true;
    }
    look(ctx, 'street');
    setFov(ctx, fov || 75);
    timeOfDay(ctx, 0.32);
    return false;
  }

  // A ground point `d` metres in front of the posed camera, `side` metres to
  // its right. Absolute marks belong to the level they were measured in, so a
  // scenario shared by two levels has to place its subjects relative to its own
  // framing or it is just guessing in the second level's coordinate system.
  var _fwd = new V();
  function aheadOfCamera(ctx, d, side) {
    var cam = ctx.camera;
    _fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
    var x = cam.position.x + _fwd.x * d - _fwd.z * (side || 0);
    var z = cam.position.z + _fwd.z * d + _fwd.x * (side || 0);
    var y = 0;
    var lv = ctx.level;
    if (lv && typeof lv.sampleGround === 'function') {
      try { var g = lv.sampleGround(x, z); if (isFinite(g)) y = g; } catch (e) { /* flat */ }
    }
    return new V(x, y, z);
  }

  // Generic framing for levels 3-10. The level is the single source of truth
  // for its own compositions; there are deliberately no duplicated fallback
  // coordinates here, because a stale guess photographs a wall more
  // convincingly than it fails.
  function genericPose(ctx, key, fov, cleanPlate) {
    var poses = (ctx.level && ctx.level.cameraPoses) || null;
    var p = poses && poses[key];
    if (p && p.position) {
      place(ctx, [p.position.x, p.position.y, p.position.z], p.yaw || 0, p.pitch || 0);
    } else {
      var sp = (ctx.level && ctx.level.spawnPoints && ctx.level.spawnPoints[0]) || null;
      if (sp && sp.position) {
        place(ctx, [sp.position.x, sp.position.y + 1.66, sp.position.z], sp.yaw || 0, 0);
      } else {
        place(ctx, [0, 1.66, 8], 0, 0);
      }
      GAME.logError('scenario', 'pose "' + key + '" missing from level.cameraPoses');
    }
    if (fov) setFov(ctx, fov);
    if (cleanPlate) { hideHud(ctx); hideViewmodel(ctx); }
  }

  // A point in front of the camera, for spawning combatants into frame without
  // each level having to hand-author a firefight position.
  function aheadOfCamera(ctx, dist) {
    var y = ctx.camera.rotation.y;
    return new V(
      ctx.camera.position.x - Math.sin(y) * dist,
      0,
      ctx.camera.position.z - Math.cos(y) * dist
    );
  }

  var S = {
    // ---- environment framing ----------------------------------------------
    overview: function (ctx) {
      look(ctx, 'overview');
      setFov(ctx, 62);
      hideHud(ctx); hideViewmodel(ctx);
      timeOfDay(ctx, 0.34);
    },
    street: function (ctx) {
      look(ctx, 'street');
      setFov(ctx, 75);
      timeOfDay(ctx, 0.32);
    },
    interior: function (ctx) {
      look(ctx, 'interior');
      setFov(ctx, 78);
      timeOfDay(ctx, 0.36);
    },
    alley: function (ctx) {
      look(ctx, 'alley');
      setFov(ctx, 76);
      timeOfDay(ctx, 0.3);
    },
    rooftop: function (ctx) {
      composeRooftop(ctx);
      timeOfDay(ctx, 0.28);
    },
    dusk: function (ctx) {
      S.street(ctx);
      timeOfDay(ctx, 0.86);
    },
    night: function (ctx) {
      S.street(ctx);
      timeOfDay(ctx, 0.02);
    },

    // ---- weapon framing ----------------------------------------------------
    ads: function (ctx) {
      baseShot(ctx);
      if (ctx.weapons) {
        ctx.weapons.forceADS = true;
        if (ctx.weapons.setADS) ctx.weapons.setADS(true, true);
      }
    },
    weapon_closeup: function (ctx) {
      baseShot(ctx);
      if (ctx.weapons && ctx.weapons.inspect) ctx.weapons.inspect();
      setFov(ctx, 60);
      hideHud(ctx);
    },
    muzzleflash: function (ctx) {
      baseShot(ctx);
      ctx._fireAt = 0.75;    // handled in tick()
    },

    // ---- combat ------------------------------------------------------------
    firefight: function (ctx) {
      baseShot(ctx);
      // Close enough to actually read as a firefight. The old cluster sat
      // 26-32 m out and every militiaman was three pixels tall behind the
      // muzzle flash. Staggered in depth so they overlap into a group rather
      // than lining up like a firing squad.
      //
      // The market's mark is measured and stays measured - it is a shipped
      // framing and must not move. The harbor solves the equivalent standoff
      // from its own pose, because the same absolute mark cannot be 16 m ahead
      // in two different levels.
      if (isHarbor(ctx)) {
        spawnEnemies(ctx, 4, combatMark(ctx, 4, 3.0, 3.4, 11, 30), 3.0, 3.4, true);
      } else {
        spawnEnemies(ctx, 4, new V(0.4, 0, -2.6), 3.0, 3.4);
      }
      ctx._fireAt = 1.2;
    },
    enemy_closeup: function (ctx) {
      // A three-quarter portrait, and the light dictates where the camera goes.
      // sky.js keeps the sun toward -Z and +X all day (AZ_BASE 0.42 rad east of
      // -Z), so the key arrives from the north-east: a camera standing south of
      // the subject - which is the intuitive place to put it, looking north up
      // the street - gets a black silhouette every time. Standing north-east
      // and looking back south-west puts N.L ~ 0.7 across his chest and face
      // and leaves the street receding behind him.
      //
      // Mark and camera are both searched, not guessed. Guessing put him inside
      // the rusted container at z = -6; guessing the next one put the camera
      // inside the burnt-out sedan; the one after that stood him in the market
      // row's cast shadow where he rendered as a black cut-out.
      //
      // 3.5 m on a 44 deg lens puts a 1.8 m man across ~64% of frame height:
      // close enough to read his rig and the terminator on his face, long
      // enough that the lens is not distorting his proportions.
      //
      // NONE of that reasoning transfers to the harbor, because none of it is
      // true there: the sun is 40 degrees below the horizon, sunlit() therefore
      // vetoes every mark, and the search falls through to PORTRAIT_MARKS[0] -
      // a market coordinate, in a level that has never heard of it. The first
      // harbor capture of this scenario returned precisely the black cut-out
      // the market version was written to avoid. On the harbor the key is a
      // sodium mast, so the subject is solved against the lamps instead - but
      // it cannot be solved HERE. lighting.js places the harbor rig against the
      // level's own camera poses, and level.js builds after lighting, so the
      // practicals do not exist until the first update; at apply() time the
      // lamp list is still empty. Stand on a published framing now so there is
      // always a picture, and re-solve on the first tick that has lamps in it.
      if (isHarbor(ctx)) {
        hideHud(ctx); hideViewmodel(ctx);
        harborPose(ctx, 'containers', PORTRAIT.fov);
        ctx._harborPortrait = 1;
        return;
      }
      // ...and none of it transfers to levels 3-10 either, for the same reason.
      // PORTRAIT_MARKS is sixteen coordinates MEASURED IN THE MARKET, and the
      // search that ranks them calls sunlit(), which returns false for every
      // candidate in a level with no sun above the horizon - metro has no sky at
      // all. So the search fell through to PORTRAIT_MARKS[0] and stood the
      // subject on a market coordinate in a flooded subway: the delivered frame
      // was a dutch-tilted view of a mannequin's legs against a wall. Solve it
      // from the level's OWN published framing instead, exactly as the harbor
      // does - stand on hero1, search forward for standable ground, and let
      // framePortrait re-solve the standoff from the subject's real height.
      //
      // framePortrait() is deliberately NOT used to deliver it. That function
      // re-seats the eye on PORTRAIT.ax/az - the market's sun bearing - at an
      // ABSOLUTE y of 1.68, which is only an eye height in a level whose floor
      // is at y = 0. It would also throw away the standpoint the level just
      // published, and with it the only guarantee that the subject is standing
      // somewhere lit. So the camera does not move at all here: it stays on
      // hero1 and simply looks at the man who has been put on its own lens axis.
      if (isGeneric(ctx)) {
        genericPose(ctx, 'hero1', PORTRAIT.fov, true);
        var gmark = combatMark(ctx, 1, 0, 0, 2.4, 5.0);
        var ge = spawnEnemies(ctx, 1, gmark, 0, 0, true);
        var gsub = (ge && ge.length) ? ge[0] : null;
        ctx._holdEnemy = gsub;
        ctx._holdMark = gmark;
        holdEnemy(gsub, gmark);
        // Aim at 53% of his measured height - heads read, boots are cheap.
        var gaimY = gmark.y + 0.95;
        var grp = gsub && (gsub.group || gsub.root || gsub.mesh);
        if (grp && grp.isObject3D) {
          try {
            grp.updateMatrixWorld(true);
            _pBox.makeEmpty(); _pBox.setFromObject(grp);
            if (!_pBox.isEmpty()) {
              _pBox.getSize(_pSize);
              if (isFinite(_pSize.y) && _pSize.y > 0.7 && _pSize.y < 3.0) {
                gaimY = _pBox.min.y + _pSize.y * 0.53;
              }
            }
          } catch (err) { GAME.logError('scenario.genericPortrait', err); }
        }
        var gcam = ctx.camera.position;
        lookAtPoint(ctx, [gcam.x, gcam.y, gcam.z],
          _pTarget.set(gmark.x, gaimY, gmark.z), PORTRAIT.fov);
        ctx.camera.updateMatrixWorld(true);
        return;
      }
      timeOfDay(ctx, 0.33);
      var shot = pickPortrait(ctx);
      var mark = shot.mark;
      hideHud(ctx); hideViewmodel(ctx);
      // Pose FIRST: ai.spawn turns a new enemy to face the player, and the
      // player is not where the scenario wants him until place() has run.
      lookAtPoint(ctx, shot.eye, new V(mark.x, PORTRAIT.aimY, mark.z), PORTRAIT.fov);
      var e = spawnEnemies(ctx, 1, mark);
      ctx._holdEnemy = (e && e.length) ? e[0] : null;
      ctx._holdMark = mark;
      holdEnemy(ctx._holdEnemy, mark);
      // Now that there is a subject, re-solve the standoff from how big he
      // really is instead of how big the art bible says he should be.
      framePortrait(ctx, ctx._holdEnemy, mark);
    },
    explosion: function (ctx) {
      baseShot(ctx);
      ctx._explodeAt = 0.9;
    },

    // ---- LEVEL 2: COLD HARBOR ----------------------------------------------
    // These only make sense with ?level=harbor. They read poses straight from
    // level.cameraPoses; a level that fails to publish one falls back to its
    // own default spawn rather than staring at the skybox.
    quay: function (ctx) {
      harborPose(ctx, 'quay', 74);
    },
    containers: function (ctx) {
      harborPose(ctx, 'containers', 76);
    },
    warehouse: function (ctx) {
      harborPose(ctx, 'warehouse', 78);
    },
    crane: function (ctx) {
      harborPose(ctx, 'crane', 70);
    },
    gangway: function (ctx) {
      harborPose(ctx, 'gangway', 72);
    },
    harbor_overview: function (ctx) {
      harborPose(ctx, 'overview', 64);
      hideHud(ctx); hideViewmodel(ctx);
    },
    // Deterministic lightning: force a strike so the capture always catches one
    // instead of depending on where the random interval happened to land.
    lightning: function (ctx) {
      harborPose(ctx, 'containers', 76);
      ctx._strikeAt = 1.1;
    },
    rain_closeup: function (ctx) {
      harborPose(ctx, 'quay', 55);
      hideHud(ctx);
    },

    // ---- GENERIC LEVEL FRAMINGS --------------------------------------------
    // Every level from 3 onward publishes cameraPoses under these standard
    // keys, so adding a level needs NO new scenario code here. The market and
    // harbor keep their bespoke names above for continuity.
    lv_overview: function (ctx) { genericPose(ctx, 'overview', 64, true); },
    lv_hero1: function (ctx) { genericPose(ctx, 'hero1', 75, false); },
    lv_hero2: function (ctx) { genericPose(ctx, 'hero2', 75, false); },
    lv_hero3: function (ctx) { genericPose(ctx, 'hero3', 75, false); },
    lv_hero4: function (ctx) { genericPose(ctx, 'hero4', 75, false); },
    lv_interior: function (ctx) { genericPose(ctx, 'interior', 78, false); },
    lv_ads: function (ctx) {
      genericPose(ctx, 'hero1', 75, false);
      if (ctx.weapons) {
        ctx.weapons.forceADS = true;
        if (ctx.weapons.setADS) ctx.weapons.setADS(true, true);
      }
    },
    lv_firefight: function (ctx) {
      genericPose(ctx, 'hero1', 75, false);
      // A flat 9 m straight ahead, with one shared base height for the whole
      // squad, is the exact failure combatMark()/`ground` were written to stop -
      // and levels 3-10 walked into it again. On snowbound (nothing but drift
      // flanks) it put one man on thin air over a drift edge and buried another
      // to the waist. Search outward for a standoff where all four are on
      // walkable ground, then re-sample each man onto the terrain under his own
      // feet. Same call the harbor firefight already makes.
      spawnEnemies(ctx, 4, combatMark(ctx, 4, 3.0, 3.4, 9, 26), 3.0, 3.4, true);
      ctx._fireAt = 1.2;
    },
    lv_muzzleflash: function (ctx) {
      genericPose(ctx, 'hero1', 75, false);
      ctx._fireAt = 0.75;
    },
    lv_explosion: function (ctx) {
      genericPose(ctx, 'hero1', 75, false);
      ctx._explodeAt = 0.9;
    },

    // ---- technical ---------------------------------------------------------
    materials: function (ctx) {
      hideHud(ctx); hideViewmodel(ctx);
      buildMaterialChart(ctx);
      // The chart's working faces point down -Z because that is where the sun
      // is, so the camera has to sit NORTH of it (more negative z) and look
      // back toward +Z. This is the one pose in the file that legitimately
      // wants yaw = PI.
      place(ctx, [CHART.x, CHART.y + CHART.eyeY, CHART.z - CHART.dist], Math.PI, 0);
      setFov(ctx, CHART.fov);
      timeOfDay(ctx, 0.36);
    }
  };

  function walkable(ctx, x, z) {
    var nav = ctx.level && ctx.level.navGrid;
    if (!nav || typeof nav.at !== 'function') return true;
    try { return !!nav.at(x, z); } catch (e) { return true; }
  }

  // Shared ray test over BOTH collider sets. props.js keeps its own collider
  // list and never registers with the level, so awnings, stalls, stacked crates
  // and the burnt-out sedan are all invisible to level.raycast on its own. This
  // runs a few hundred times during scenario setup, never per frame.
  var _rayO = new V(), _rayD = new V();
  function blocked(ctx, ox, oy, oz, dir, maxT) {
    _rayO.set(ox, oy, oz);
    _rayD.copy(dir).normalize();
    var lv = ctx.level;
    if (lv && typeof lv.raycast === 'function') {
      try {
        var r = lv.raycast(_rayO, _rayD, maxT);
        if (r && r.hit) return true;
      } catch (e) { GAME.logError('scenario.ray', e); }
    }
    var pc = ctx.props && ctx.props.colliders;
    if (pc && pc.length && GAME.Collision) {
      try {
        for (var i = 0; i < pc.length; i++) {
          var c = pc[i], t = -1;
          if (c.type === 'sphere' && GAME.Collision.raycastSphere) {
            t = GAME.Collision.raycastSphere(_rayO, _rayD, c.center, c.radius, null);
          } else if (c.halfExtents && GAME.Collision.raycastBox) {
            t = GAME.Collision.raycastBox(_rayO, _rayD, c, null);
          }
          if (t > 0.02 && t < maxT) return true;
        }
      } catch (e2) { GAME.logError('scenario.ray.props', e2); }
    }
    return false;
  }

  // Is a standing figure at (x,z) actually in the sun? The art direction runs
  // the sun at 14-20 degrees of elevation, which throws 40 m shadows, so most
  // of the street is in shade at any given hour and a hand-picked mark lands in
  // one about two times in three. Trace head and chest toward the sun: a low
  // sun clipped by an awning lights the boots and leaves the face black, which
  // is the worst possible portrait.
  var _sun = new V();
  function sunlit(ctx, x, z) {
    var sky = ctx.sky;
    if (!sky || !sky.sunDirection) return true;
    _sun.copy(sky.sunDirection).normalize();
    if (_sun.y <= 0.02) return false;                 // sun is down
    return !blocked(ctx, x, 1.62, z, _sun, 70) && !blocked(ctx, x, 1.05, z, _sun, 70);
  }

  // Ordered best-composition-first: mid-street depth so the market row reads
  // behind the subject and the arch closes the far end.
  var PORTRAIT_MARKS = [
    [0.2, -12.0], [1.4, -16.5], [-1.2, -9.5], [2.4, -20.5],
    [-1.8, -14.0], [0.8, -24.5], [-2.6, -19.0], [1.8, -8.5],
    [-0.6, -28.0], [3.0, -30.5], [-1.2, -34.0], [2.4, -38.0],
    [-2.2, -41.0], [-2.2, -3.5], [3.6, 6.4], [-3.4, 9.2]
  ];

  // Solve the whole portrait - subject mark AND camera - in one search, because
  // validating only the mark is how the camera ended up inside the burnt-out
  // sedan. A candidate has to be standable, lit, and have an unobstructed
  // sightline from a camera standpoint that is itself in open air.
  //   bearing (0.4429, -0.8966) = camera -> subject, i.e. the camera stands
  //   north-east of the mark, on the sun's side, so the subject is front-lit.
  // `dist` and `aimY` here are only the PROBE pose - the standoff the sightline
  // search validates. The delivered framing is solved from the subject's actual
  // bounding box in framePortrait(), because assuming his height is how this
  // shot stayed loose: the shipped 3.5 m / 44 deg / aim-at-the-belt pose was
  // computed for the 1.8 m militiaman ART_DIRECTION specifies, the model that
  // ai.js actually builds measures ~1.60 m, and the difference is the reason a
  // CLOSEUP spent a third of its height on empty tarmac and rendered his face
  // about 35 px tall. Measuring instead of assuming also means the framing
  // tracks ai.js if it rescales the character, in either direction.
  var PORTRAIT = {
    ax: 0.4429, az: -0.8966, dist: 3.15, eyeY: 1.68, aimY: 1.18, fov: 40,
    fill: 0.76,            // fraction of frame height the subject should cover
    minDist: 2.35, maxDist: 4.4
  };

  var _aim = new V();
  function pickPortrait(ctx) {
    var best = null, lit = null;
    for (var i = 0; i < PORTRAIT_MARKS.length; i++) {
      var c = PORTRAIT_MARKS[i];
      var mark = new V(c[0], 0, c[1]);
      var eye = [mark.x - PORTRAIT.ax * PORTRAIT.dist, PORTRAIT.eyeY,
        mark.z - PORTRAIT.az * PORTRAIT.dist];
      if (!walkable(ctx, mark.x, mark.z)) continue;
      if (!walkable(ctx, eye[0], eye[2])) continue;
      _aim.set(mark.x - eye[0], PORTRAIT.aimY - eye[1], mark.z - eye[2]);
      // stop short of the subject's own footprint or we hit his cover
      if (blocked(ctx, eye[0], eye[1], eye[2], _aim, PORTRAIT.dist - 0.6)) continue;
      var shot = { mark: mark, eye: eye };
      if (!best) best = shot;
      if (!lit && sunlit(ctx, mark.x, mark.z)) { lit = shot; break; }
    }
    var pick = lit || best;
    if (pick) return pick;
    var f = PORTRAIT_MARKS[0];
    var m = new V(f[0], 0, f[1]);
    return {
      mark: m,
      eye: [m.x - PORTRAIT.ax * PORTRAIT.dist, PORTRAIT.eyeY, m.z - PORTRAIT.az * PORTRAIT.dist]
    };
  }

  // ==========================================================================
  // HARBOR PORTRAIT
  //
  // The market portrait is solved against the sun. Cold Harbor has no sun - it
  // is 02:00 - so the only key in the level is the practicals, and a subject
  // stood anywhere else is a silhouette. This walks lighting.js's own practical
  // list, stands the subject just inside the brightest reachable pool, and puts
  // the camera on the lamp's side of him so the key lands on his face rather
  // than on his back. Everything is measured off live objects: if lighting.js
  // moves a mast, the framing moves with it.
  //
  // Returns null on any failure, which sends the caller back to the market
  // solver - a worse frame, but never a missing one.
  // ==========================================================================
  var HPORTRAIT = {
    dist: 3.15,        // probe standoff; framePortrait re-solves the real one
    eyeY: 1.68,
    inset: 1.9,        // metres from the pool centre toward the camera
    minLampY: 2.5,     // ignore ground-level fixtures and bulbs on props
    maxLampY: 16.0
  };
  var _hpDir = new V();

  function harborPortrait(ctx) {
    var pr = ctx.lighting && ctx.lighting.practicals;
    if (!pr || !pr.length) return null;

    // Irradiance under the fixture: intensity / height^2, decay 2. That ranks a
    // 380 cd lamp on a 6.5 m pole above a 1300 cd head 12 m up, which is right -
    // the low one throws the tighter, brighter pool.
    var cand = [];
    for (var i = 0; i < pr.length; i++) {
      var L = pr[i] && pr[i].light;
      if (!L || !L.position || !isFinite(L.intensity) || L.intensity <= 1) continue;
      var hy = L.position.y;
      if (!(hy > HPORTRAIT.minLampY && hy < HPORTRAIT.maxLampY)) continue;
      cand.push({ L: L, e: L.intensity / (hy * hy) });
    }
    if (!cand.length) return null;
    cand.sort(function (a, b) { return b.e - a.e; });

    // Eight azimuths per lamp: the subject sits `inset` from the pool centre on
    // the bearing, the camera a further `dist` out on the same line. That keeps
    // the lamp behind the subject's shoulder and above the camera, which is the
    // three-quarter key the market version gets from the sun.
    for (var c = 0; c < Math.min(6, cand.length); c++) {
      var lp = cand[c].L.position;
      for (var a = 0; a < 8; a++) {
        var th = a * Math.PI / 4;
        var bx = Math.sin(th), bz = Math.cos(th);
        var mx = lp.x + bx * HPORTRAIT.inset;
        var mz = lp.z + bz * HPORTRAIT.inset;
        var ex = lp.x + bx * (HPORTRAIT.inset + HPORTRAIT.dist);
        var ez = lp.z + bz * (HPORTRAIT.inset + HPORTRAIT.dist);
        if (!walkable(ctx, mx, mz) || !walkable(ctx, ex, ez)) continue;

        var gy = 0;
        var lv = ctx.level;
        if (lv && typeof lv.sampleGround === 'function') {
          try { var g = lv.sampleGround(mx, mz); if (isFinite(g)) gy = g; } catch (e) { /* flat */ }
        }
        var eye = [ex, gy + HPORTRAIT.eyeY, ez];
        _hpDir.set(mx - ex, PORTRAIT.aimY - HPORTRAIT.eyeY, mz - ez);
        if (blocked(ctx, eye[0], eye[1], eye[2], _hpDir, HPORTRAIT.dist - 0.6)) continue;
        // The subject has to actually see the lamp or the pool is on the far
        // side of a container from him.
        _hpDir.set(lp.x - mx, lp.y - (gy + 1.5), lp.z - mz);
        if (blocked(ctx, mx, gy + 1.5, mz, _hpDir, _hpDir.length() - 0.5)) continue;
        return { mark: new V(mx, gy, mz), eye: eye };
      }
    }
    return null;
  }

  // Deliver the harbor portrait once there are lamps to solve it against. Keeps
  // retrying for a few ticks and then settles for a subject placed straight in
  // front of the camera - a mediocre portrait beats an empty one, and the shot
  // has to be deterministic whatever the rig does.
  function settleHarborPortrait(ctx, i) {
    var shot = harborPortrait(ctx);
    if (!shot) {
      if (i < 12) return;
      shot = { mark: combatMark(ctx, 1, 0, 0, 2.4, 5.0), eye: null };
      GAME.logError('scenario', 'harbor portrait found no lit standpoint - ' +
        'placing the subject on the lens axis instead');
    }
    ctx._harborPortrait = 2;
    var mark = shot.mark;
    if (shot.eye) {
      lookAtPoint(ctx, shot.eye, new V(mark.x, PORTRAIT.aimY, mark.z), PORTRAIT.fov);
    }
    var e = spawnEnemies(ctx, 1, mark, 0, 0, true);
    ctx._holdEnemy = (e && e.length) ? e[0] : null;
    ctx._holdMark = mark;
    holdEnemy(ctx._holdEnemy, mark);
    framePortrait(ctx, ctx._holdEnemy, mark);
    ctx.camera.updateMatrixWorld(true);
  }

  // ==========================================================================
  // ROOFTOP COMPOSITION
  //
  // A rooftop shot only earns its place among five hero framings if it
  // OVERLOOKS something. level.js publishes a standpoint on the west roof, but
  // that standpoint is deliberately set back from the parapet, and a 1 m
  // parapet ten metres away occludes everything below the horizon: the shipped
  // frame was 35% empty sky over a near-black deck with no street in it at all,
  // which is why it graded as the weakest of the five.
  //
  // Hard-coding a replacement pose would go stale the moment level.js moves a
  // wall, so the standpoint is SOLVED instead. Walk laterally from the level's
  // own anchor toward the street centreline, one roof-tile at a time, and stop
  // at the LAST position that still has roof within groundProbe metres below
  // it. That position is the parapet, wherever level.js has since put it. Then
  // take the first aim point down the street with an unobstructed sightline.
  //
  // The march is deliberately lateral (pure X) rather than aimed at the target.
  // The first version pointed it at the far aim, which is 27 degrees off the
  // street normal, so sixteen 0.6 m steps advanced the camera only 4.3 m in X
  // and it never got within 6 m of the edge - every ray stayed behind the
  // parapet and the search fell back to the pose it was trying to replace.
  // Measured: anchor x = -16.6, roof edge near x = -7; the shot lives or dies
  // on crossing that 9.6 m.
  //
  // The aim points are all 30-50 m down-street on purpose. Aiming at the near
  // kerb solves to a ~35 degree plunge, which reads as a map screenshot; a
  // distant aim puts the horizon on the upper-third line for free, because the
  // horizon sits `pitch` above frame centre and pitch is then ~0.45 of the
  // half-FOV. Nothing here can regress the shot: if the collision data cannot
  // answer where the roof is, or no aim is ever clear, the level's published
  // pose is used verbatim.
  // ==========================================================================
  var ROOFTOP = {
    aims: [
      [0.5, 1.2, -42.0], [1.4, 1.4, -36.0], [-0.6, 1.6, -31.0],
      [2.2, 1.2, -48.0], [0.0, 2.4, -26.0]
    ],
    step: 0.5,
    maxSteps: 36,      // 18 m of travel: enough to cross any roof in the block
    edgeBack: 0.35,    // stand a hand's breadth back from the drop, not on it
    groundProbe: 2.8,
    fov: 68
  };

  var _rtDown = new V(0, -1, 0), _rtRay = new V(), _rtTarget = new V();

  // First aim with a clear line from `eye`; frac lets the relaxed second pass
  // ignore obstruction in the last stretch, where the street furniture we
  // actually want in frame lives.
  function rooftopAim(ctx, eye, frac) {
    for (var k = 0; k < ROOFTOP.aims.length; k++) {
      var a = ROOFTOP.aims[k];
      _rtRay.set(a[0] - eye[0], a[1] - eye[1], a[2] - eye[2]);
      var dist = _rtRay.length();
      if (dist < 12) continue;
      if (blocked(ctx, eye[0], eye[1], eye[2], _rtRay, dist * frac)) continue;
      return a;
    }
    return null;
  }

  function composeRooftop(ctx) {
    var pts = (ctx.level && ctx.level.cameraPoses) || null;
    var p = pts && pts.rooftop;
    var anchor = (p && p.position)
      ? [p.position.x, p.position.y, p.position.z]
      : FALLBACK_POSES.rooftop.pos.slice();

    // Can the collision data answer "is there roof under me"? If the anchor
    // itself reads as empty air the level has no collider there, and a probe
    // that vetoes every candidate is worse than no probe at all.
    var probe = blocked(ctx, anchor[0], anchor[1], anchor[2], _rtDown, ROOFTOP.groundProbe);
    if (!probe) {                             // no roof data: do not wander
      look(ctx, 'rooftop');
      setFov(ctx, ROOFTOP.fov);
      return false;
    }
    var sx = anchor[0] < 0 ? 1 : -1;          // toward the street centreline
    var edge = null, aim = null, walked = 0, eye;

    for (var s = 0; s <= ROOFTOP.maxSteps; s++) {
      eye = [anchor[0] + sx * s * ROOFTOP.step, anchor[1], anchor[2]];
      if (s > 0 && !blocked(ctx, eye[0], eye[1], eye[2], _rtDown, ROOFTOP.groundProbe)) break;
      edge = eye; walked = s;
      aim = rooftopAim(ctx, eye, 0.86);
      if (aim) break;
    }

    // Reaching the parapet without a strictly clear line usually means a cable
    // run or an awning clipped the ray, not that the street is hidden. Accept
    // the best available rather than retreating to a frame with no street.
    if (!aim && edge) aim = rooftopAim(ctx, edge, 0.55) || rooftopAim(ctx, edge, 0.30);
    if (aim && edge) {
      // Only ease back off the drop if we actually walked to it. If the level's
      // own anchor already saw the street, it is used exactly as published.
      var back = walked > 0 ? ROOFTOP.edgeBack : 0;
      lookAtPoint(ctx, [edge[0] - sx * back, edge[1], edge[2]],
        _rtTarget.set(aim[0], aim[1], aim[2]), ROOFTOP.fov);
      return true;
    }
    look(ctx, 'rooftop');
    setFov(ctx, ROOFTOP.fov);
    return false;
  }

  // Re-solve the portrait standoff from the subject's measured bounding box so
  // he covers PORTRAIT.fill of frame height whatever ai.js decides he is. Every
  // failure path returns false and leaves the probe pose - which is the pose
  // that shipped - untouched, so a broken or missing rig cannot cost us a frame.
  var _pBox = new THREE.Box3(), _pSize = new V(), _pTarget = new V();
  function framePortrait(ctx, e, mark) {
    var g = e && (e.group || e.root || e.mesh);
    if (!g || !g.isObject3D || !mark) return false;
    try {
      g.updateMatrixWorld(true);
      _pBox.makeEmpty();
      _pBox.setFromObject(g);
      if (_pBox.isEmpty()) return false;
      _pBox.getSize(_pSize);
      var hgt = _pSize.y;
      // A box this far outside human proportions means the rig is mid-build or
      // has a stray child in it; do not let it drive the camera.
      if (!isFinite(hgt) || hgt < 0.7 || hgt > 3.0) return false;

      var halfTan = Math.tan(PORTRAIT.fov * Math.PI / 360);
      var dist = hgt / (PORTRAIT.fill * 2 * halfTan);
      dist = Math.min(PORTRAIT.maxDist, Math.max(PORTRAIT.minDist, dist));
      // Slightly above centre of mass: heads read, boots are cheap to give up.
      var aimY = _pBox.min.y + hgt * 0.53;
      var eye = [mark.x - PORTRAIT.ax * dist, PORTRAIT.eyeY, mark.z - PORTRAIT.az * dist];
      if (!walkable(ctx, eye[0], eye[2])) return false;
      _aim.set(mark.x - eye[0], aimY - eye[1], mark.z - eye[2]);
      if (blocked(ctx, eye[0], eye[1], eye[2], _aim, dist - 0.55)) return false;
      lookAtPoint(ctx, eye, _pTarget.set(mark.x, aimY, mark.z), PORTRAIT.fov);
      return true;
    } catch (err) {
      GAME.logError('scenario.framePortrait', err);
      return false;
    }
  }

  // Where the i'th of n enemies stands, given the squad's centre. Shared with
  // the footprint test below so the two can never disagree about the layout.
  function squadX(base, i, n, sx) { return base.x + (i - (n - 1) / 2) * sx; }
  function squadZ(base, i, sz) { return base.z - i * sz; }

  function groundAt(ctx, x, z, fallback) {
    var lv = ctx.level;
    if (lv && typeof lv.sampleGround === 'function') {
      try { var g = lv.sampleGround(x, z); if (isFinite(g)) return g; } catch (e) { /* flat */ }
    }
    return fallback || 0;
  }

  // `ground` re-samples each man onto the terrain under his own feet. The
  // market is flat and passes y = 0, so it does not ask; the harbor must,
  // because one shared base height across a 3 m spread is how the first harbor
  // firefight left a militiaman standing on thin air (see combatMark).
  function spawnEnemies(ctx, n, at, spreadX, spreadZ, ground) {
    if (!ctx.ai || !ctx.ai.spawn) return null;
    var out = [];
    var base = at || new V(2, 0, -12);
    var sx = spreadX == null ? 3.2 : spreadX;
    var sz = spreadZ == null ? 2.1 : spreadZ;
    for (var i = 0; i < n; i++) {
      try {
        var px = squadX(base, i, n, sx), pz = squadZ(base, i, sz);
        var p = new V(px, ground ? groundAt(ctx, px, pz, base.y) : base.y, pz);
        var e = ctx.ai.spawn(p);
        if (e) out.push(e);
      } catch (e2) { GAME.logError('scenario.spawn', e2); }
    }
    return out;
  }

  // A standable firing line for a squad of n, searched outward along the view
  // axis. Taking a fixed distance on trust does not survive a second level: 16 m
  // straight ahead of the harbor's `containers` pose is inside a container
  // stack, sampleGround there returns the TOP of the stack, and the first
  // harbor firefight duly printed a man hanging ten metres up in the air with
  // his feet in nothing. Every candidate now has to put the whole squad on
  // walkable ground before it is accepted.
  function combatMark(ctx, n, spreadX, spreadZ, dMin, dMax) {
    var best = null;
    for (var d = dMin; d <= dMax; d += 1.0) {
      var c = aheadOfCamera(ctx, d);
      var ok = 0;
      for (var i = 0; i < n; i++) {
        if (walkable(ctx, squadX(c, i, n, spreadX), squadZ(c, i, spreadZ))) ok++;
      }
      if (ok === n) return c;
      if (!best && ok > n / 2) best = c;
    }
    return best || aheadOfCamera(ctx, dMin);
  }

  // Pin a portrait subject to its mark. Captures simulate for 1.5-3 s and a
  // live AI will happily walk a patrol leg or sprint to cover in that time,
  // which would leave the closeup framing empty air. Holding 'alert' keeps the
  // weapon at low ready - a soldier posture, not an idle mannequin.
  function holdEnemy(e, mark) {
    if (!e || e.alive === false || !mark) return;
    try {
      if (e.patrol && e.patrol.length) e.patrol.length = 0;
      e.moveTarget = null;
      e.speedWanted = 0;
      if (e.cover) { if (e._dropCover) e._dropCover(); else e.cover = null; }
      if (e.velocity && e.velocity.set) e.velocity.set(0, 0, 0);
      if (e.position && e.position.set) e.position.set(mark.x, e.position.y, mark.z);
      if (typeof e.awareness === 'number') e.awareness = Math.max(e.awareness, 0.7);
      if (e.setState) e.setState('alert');
      // Re-arm the reaction timer so 'alert' never graduates into seekCover
      // and runs the subject out of frame mid-capture.
      if (typeof e.reactTimer === 'number') e.reactTimer = Math.max(e.reactTimer, 0.75);
    } catch (err) { GAME.logError('scenario.hold', err); }
  }

  // ==========================================================================
  // MATERIAL CHART
  //
  // shots/materials.png exists for exactly one reason: to let a critic judge
  // every surface in the game side by side, out of the level's composition and
  // out of its clutter. Five things make that work.
  //
  //   1. The chart is parked at z = -78 and 64 m up, inside its own cyclorama.
  //      Ground level is not safe: level.js scatters a band of distant filler
  //      buildings from z = -124 to +40 out to x = 82, and one of them planted
  //      a blurred slab across the left third of the frame. 64 m clears the
  //      tallest of them (the minaret, 23.6 m) with room to spare, the key
  //      light and the IBL are identical up there, and the height fog thins to
  //      ~1% so nothing veils the samples.
  //   2. The camera stands NORTH of it looking back toward +Z. The sun always
  //      points toward -Z and +X (sky.js: AZ_BASE 0.42 rad east of -Z), so a
  //      surface whose normal is -Z is lit at N.L ~ 0.9 and the key lands over
  //      the camera's left shoulder. Framing it the other way - which is what
  //      shipped - puts the whole chart in its own shadow even when the yaw is
  //      right.
  //   3. Every material gets three samples: a sphere (form, specular, the
  //      terminator), a plate square to camera (albedo, tiling, macro normal)
  //      and a plate raked to 60 degrees (grazing-angle roughness, parallax /
  //      POM silhouette, anisotropy), under its printed name.
  //
  //   4. SAMPLE ASPECT AND DENSITY ARE SOLVED, NOT GUESSED.  The plates used
  //      to be 1.36 x 0.66 - a 2.06:1 rectangle - and materials.js keys tiling
  //      off a single scalar `repeat`, so every UV-mapped material was shown
  //      stretched to twice its proper width. Brick read as if the courses
  //      were 2:1 stretcher bond; genTile's square tiles read as rectangles.
  //      A critic auditing off that chart draws the wrong conclusion about
  //      five of the sixteen materials. The plates are now square (1.30 m) and
  //      the SPHERE, which maps u over the 2*pi*R equator and v over only the
  //      pi*R pole-to-pole arc, has its uv.x doubled so its texel density is
  //      isotropic too. Both are then normalised to the SAME tiles-per-metre
  //      (PLATE_UV), so a material's sphere, plate and rake finally agree with
  //      each other and with the wall it came off. This is done by editing the
  //      chart's own uv attribute rather than by passing a per-plate repeat:
  //      an opts.repeat override forces materials.js to CLONE every map in the
  //      set (see MaterialLibrary._prep), and 16 materials x ~5 maps of extra
  //      GPU uploads is not a price a test chart should charge.
  //
  //   5. THE CHART CARRIES ITS OWN LIGHT RIG.  Sun + IBL alone lights every
  //      sample from one direction with one lobe, which is why gun-metal,
  //      glass and plaster all photographed as the same matte dusty ball -
  //      the chart could not distinguish roughness 0.10 from roughness 0.95.
  //      Three local, shadow-free, distance-limited sources fix that:
  //        * a grazing spot from frame-left, nearly parallel to the plates,
  //          which is where Fresnel and roughness actually separate;
  //        * a small near source above frame-right, so a smooth material
  //          returns a tight bright ping and a rough one a broad dim wash;
  //        * a cool bounce from below to keep the shadow side off the floor.
  //      They live inside the chart group at y = 64 with `distance` set, so
  //      they cannot leak into any other scenario.
  //
  //   6. THE STEP WEDGE IS UNLIT, AND HAS TO BE.  It exists to answer one
  //      question - what does the tonemap plus grade do to a known neutral
  //      ramp - and a LIT wedge cannot answer it, because the answer comes back
  //      convolved with whatever the light rig happens to be doing down at
  //      floor level. It was measured doing exactly that: under the local rig
  //      the eight chips, authored 0x11 to 0xde, photographed at roughly 0.30,
  //      0.60, 0.72, 0.80, 0.86, 0.90, 0.93, 0.96 - the top six squeezed into
  //      the last sixth of the range, so the instrument read "the grade clips"
  //      when what actually clipped was the bounce light on the cove floor.
  //      An unlit MeshBasicMaterial carrying a SCENE-LINEAR value feeds the
  //      chain a known number per chip and nothing else, so the strip plots the
  //      transfer function directly: even steps mean a linear dump, while a
  //      lifted teal-tinted dark end and a compressed bright end mean the
  //      filmic curve and the grade are both landing. See WEDGE. It reads
  //      correctly now - on a NEUTRAL input the chips come back R-B = -0.048 in
  //      the shadows and +0.015 at the top, which is the art direction's teal
  //      shadow / warm highlight split measured with the materials taken out of
  //      the argument.
  //
  // The neutral step wedge along the bottom is an exposure reference: if the
  // darkest chip crushes or the brightest clips, the grade is wrong, and that
  // is a much faster read than arguing about a photo of a wall.
  //
  // The staging is deliberately NOT flat. A 22 x 14 m featureless grey card
  // measured 100% flat and dragged the whole frame's flat_area_pct to 49.65%,
  // so the metric was reporting the backdrop, not the materials. The card is
  // now a coved studio cyclorama (no floor/wall seam to read as a hard line)
  // finished in a procedurally mottled paper-grey that is generated HERE, in
  // staging code, and never comes from the texture library it exists to test.
  // ==========================================================================
  var CHART_ORDER = [
    'concrete', 'concrete_wall', 'plaster', 'brick',
    'tile', 'asphalt', 'sand', 'gravel',
    'wood_plank', 'rusted_metal', 'painted_metal', 'corrugated_metal',
    'fabric', 'rubber', 'glass', 'foliage'
  ];

  // Short enough to stay legible at 1.66 m wide in a 15 m frame.
  var CHART_LABEL = {
    concrete: 'CONCRETE', concrete_wall: 'CONC WALL', plaster: 'PLASTER',
    brick: 'BRICK', tile: 'TILE', asphalt: 'ASPHALT', sand: 'SAND',
    gravel: 'GRAVEL', wood_plank: 'WOOD', rusted_metal: 'RUST MTL',
    painted_metal: 'PAINT MTL', corrugated_metal: 'CORR MTL',
    fabric: 'FABRIC', rubber: 'RUBBER', glass: 'GLASS', foliage: 'FOLIAGE'
  };

  var CHART = {
    x: 0,
    y: 64,           // above every piece of level and filler geometry
    z: -78,          // north of the level, so the sun rakes the front faces
    cols: 8,
    cellW: 1.72,
    rowBase: [4.46, 0.76],   // cell origin (bottom of the raked plate) per row
    dist: 8.9,       // camera standoff; frames 15.4 x 8.7 m at 52 deg / 16:9
    // Relative to the chart's own base plane. 4.03 hung the step wedge on the
    // bottom frame edge - the chips' lower bevel sat at 98% of frame height and
    // read as clipped rather than as a deliberate strip. 3.90 drops everything
    // 23 cm down the frame, which still leaves 22 px above the top row's labels
    // at 16:9 and puts 38 px of cove under the wedge.
    eyeY: 3.90,
    fov: 52
  };

  // Cell layout, relative to the row's base. Content runs 0.00 -> 3.46 m.
  var CELL = {
    sphereR: 0.50, sphereY: 2.64,
    plateW: 1.30, plateT: 0.10, plateY: 1.36,
    rakeY: 0.36, rakeTilt: Math.PI / 3,
    labelY: 3.34, labelW: 1.66, labelH: 0.26
  };

  // uv gain that makes a plateW-wide plate carry the same texels per metre as
  // a sphere whose uv.x has been doubled: 2 tiles over the 2*pi*R equator is
  // 1/(pi*R) tiles per metre, and the plate covers plateW metres.
  var PLATE_UV = CELL.plateW / (Math.PI * CELL.sphereR);

  // Screen-space column position. yaw = PI mirrors world X, so negate.
  function chartX(col, cols) {
    return -(col - (cols - 1) / 2) * CHART.cellW;
  }

  // SCENE-LINEAR stop ladder, not display-sRGB chips. Doubling every step and
  // hung so that the sixth chip is photographic middle grey (0.18), which puts
  // five stops of shadow below it and two of highlight above. Authoring the
  // strip in sRGB display values was measured to be useless: 0x7a (linear
  // 0.195) came back at 0.78 on screen and the top four chips landed inside
  // 0.88-0.98, so the instrument reported "the grade clips" when what it was
  // actually measuring was the composite's exposure gain. A stop ladder cannot
  // make that mistake - it shows WHERE the curve rolls off, whatever the gain.
  // The top rung stops at 1.44 rather than continuing up so the wedge never
  // contributes blown pixels to the frame's own blown_white_pct: measured, 0.72
  // renders at 0.807 and one more stop lands near 0.90, well under the 0.968
  // near-white floor. The bottom rung starts at 0.01125 because the composite
  // was measured to clamp at 0.031 display below that - 0.005625 and 0.01125
  // both photographed at 0.031, and two visually identical chips read as a
  // broken instrument rather than as the toe they actually are.
  var WEDGE = [0.01125, 0.0225, 0.045, 0.09, 0.18, 0.36, 0.72, 1.44];
  var WEDGE_Y = 0.46, WEDGE_H = 0.30;

  // Charts run on geometry the level never uses, so make sure the attributes a
  // library material may reference actually exist. A material with an aoMap
  // wants uv1; one with vertexColors wants a colour attribute, and a missing
  // colour attribute reads as solid black in WebGL2.
  function chartGeo(geo, mat) {
    try {
      var a = geo.attributes;
      if (a.uv && !a.uv1) geo.setAttribute('uv1', a.uv);
      if (mat && mat.vertexColors && !a.color) {
        var n = a.position.count, arr = new Float32Array(n * 3);
        for (var i = 0; i < n * 3; i++) arr[i] = 1;
        geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      }
    } catch (e) { GAME.logError('chart.geo', e); }
    return geo;
  }

  // Rescale a geometry's uv in place. The only honest way to change a sample's
  // texel density without forcing materials.js to clone its whole map set.
  function scaleUV(geo, su, sv) {
    try {
      var uv = geo.attributes && geo.attributes.uv;
      if (!uv) return geo;
      for (var i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
      uv.needsUpdate = true;
    } catch (e) { GAME.logError('chart.uv', e); }
    return geo;
  }

  function box(w, h, d, bevel) {
    if (GAME.Geo && GAME.Geo.bevelBox) return GAME.Geo.bevelBox(w, h, d, bevel || 0.02);
    return new THREE.BoxGeometry(w, h, d);
  }

  // Unlit reference chip. No lighting, no fog, no shadow: the only thing
  // between the authored sRGB value and the pixel is the post chain, which is
  // the entire point of the strip.
  function wedgeMat(linear) {
    var c = new THREE.Color();
    // Straight into the working (linear-sRGB) space: no transfer function, no
    // light, no fog. What the composite does to this value is the measurement.
    if (c.setRGB.length >= 4) c.setRGB(linear, linear, linear, THREE.LinearSRGBColorSpace);
    else c.setRGB(linear, linear, linear);
    var m = new THREE.MeshBasicMaterial({ color: c, fog: false });
    m.name = 'chart_wedge';
    return m;
  }

  // --------------------------------------------------------------------------
  // Staging surfaces, generated here so the cyclorama can never be mistaken
  // for - or credited to - a library material. Deterministic: seeded RNG only.
  // --------------------------------------------------------------------------
  function chartRandom(seed) {
    if (GAME.RNG) {
      var r = new GAME.RNG(seed);
      return function () { return r.next(); };
    }
    var s = seed >>> 0;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  function chartLattice(next, n) {
    var a = new Float32Array(n * n);
    for (var i = 0; i < n * n; i++) a[i] = next();
    return a;
  }

  // Wrapping value noise with smoothstep interpolation; x,y in lattice cells.
  function chartNoise(a, n, x, y) {
    var x0 = Math.floor(x), y0 = Math.floor(y);
    var fx = x - x0, fy = y - y0;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    var i0 = ((x0 % n) + n) % n, j0 = ((y0 % n) + n) % n;
    var i1 = (i0 + 1) % n, j1 = (j0 + 1) % n;
    var v0 = a[j0 * n + i0] * (1 - fx) + a[j0 * n + i1] * fx;
    var v1 = a[j1 * n + i0] * (1 - fx) + a[j1 * n + i1] * fx;
    return v0 * (1 - fy) + v1 * fy;
  }

  // Mottled studio-paper grey: albedo + matching normal. flat_area_pct counts
  // any 9x9 neighbourhood whose luminance std is under 0.008, so the fine
  // octave and the per-texel grain are not decoration - they are the reason
  // the backdrop stops dominating the metric. 512 texels over 9 m is about
  // 1.4 screen pixels per texel at this framing, so the grain survives to mip 0.
  var CYC_SIZE = 512;
  function cycloramaMaps() {
    var next = chartRandom(20609);
    var oct = [
      { l: chartLattice(next, 4), n: 4, a: 0.50 },
      { l: chartLattice(next, 9), n: 9, a: 0.26 },
      { l: chartLattice(next, 19), n: 19, a: 0.14 },
      { l: chartLattice(next, 43), n: 43, a: 0.07 },
      { l: chartLattice(next, 97), n: 97, a: 0.035 }
    ];
    var S = CYC_SIZE, h = new Float32Array(S * S), i, j, k, o, v, sum = 0;
    for (j = 0; j < S; j++) {
      for (i = 0; i < S; i++) {
        v = 0;
        for (k = 0; k < oct.length; k++) {
          o = oct[k];
          v += o.a * chartNoise(o.l, o.n, i / S * o.n, j / S * o.n);
        }
        h[j * S + i] = v;
        sum += v;
      }
    }
    var mean = sum / (S * S);

    var alb = document.createElement('canvas');
    alb.width = alb.height = S;
    var ga = alb.getContext('2d');
    var id = ga.createImageData(S, S);
    var nrm = document.createElement('canvas');
    nrm.width = nrm.height = S;
    var gn = nrm.getContext('2d');
    var nd = gn.createImageData(S, S);
    var grain = chartRandom(7717);
    var BASE = 118;          // sRGB mid-grey, safely off both ends of the curve
    for (j = 0; j < S; j++) {
      for (i = 0; i < S; i++) {
        k = j * S + i;
        var d = h[k] - mean;
        // +-7 LSB of per-texel grain: std ~4 LSB, comfortably past the 0.008
        // local-std floor that flat_area_pct measures.
        var g = (grain() - 0.5) * 14;
        var lum = BASE * (1 + d * 1.55) + g;
        var p = k * 4;
        id.data[p] = Math.max(0, Math.min(255, lum * 1.015));
        id.data[p + 1] = Math.max(0, Math.min(255, lum));
        id.data[p + 2] = Math.max(0, Math.min(255, lum * 0.975));
        id.data[p + 3] = 255;

        var hx = h[k] - h[j * S + ((i + 1) % S)];
        var hy = h[k] - h[((j + 1) % S) * S + i];
        nd.data[p] = Math.max(0, Math.min(255, 128 + hx * 900 + (grain() - 0.5) * 10));
        nd.data[p + 1] = Math.max(0, Math.min(255, 128 - hy * 900 + (grain() - 0.5) * 10));
        nd.data[p + 2] = 255;
        nd.data[p + 3] = 255;
      }
    }
    ga.putImageData(id, 0, 0);
    gn.putImageData(nd, 0, 0);
    return { albedo: alb, normal: nrm };
  }

  var CYC_UV = 9.0;          // metres per texture tile
  function cycloramaMaterial(ctx) {
    var m;
    try {
      var maps = cycloramaMaps();
      var mk = function (canvas, srgb) {
        var t = new THREE.CanvasTexture(canvas);
        t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
        t.repeat.set(1 / CYC_UV, 1 / CYC_UV);
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.anisotropy = chartAniso(ctx);
        t.needsUpdate = true;
        return t;
      };
      m = new THREE.MeshStandardMaterial({
        map: mk(maps.albedo, true),
        normalMap: mk(maps.normal, false),
        normalScale: new THREE.Vector2(0.55, 0.55),
        roughness: 0.88,
        metalness: 0.0,
        side: THREE.DoubleSide
      });
    } catch (e) {
      GAME.logError('chart.cyclorama', e);
      m = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHex(0x767676, THREE.SRGBColorSpace),
        roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide
      });
    }
    m.name = 'chart_cyclorama';
    try { if (ctx.sky && ctx.sky.applyFogTo) ctx.sky.applyFogTo(m); }
    catch (e2) { GAME.logError('chart.fog', e2); }
    return m;
  }

  function chartAniso(ctx) {
    try {
      var c = ctx.renderer && ctx.renderer.capabilities;
      if (c && c.getMaxAnisotropy) return Math.min(8, c.getMaxAnisotropy() || 1);
    } catch (e) { /* SwiftShader reports 1; that is fine */ }
    return 1;
  }

  // A coved cyclorama: back wall -> quarter-round -> floor, extruded along X.
  // The old staging was a box floor butted into a box wall, and that seam read
  // as a hard black line across the frame under a raking sun. Normals are set
  // analytically so the cove shades as one continuous surface, and the uv is
  // authored in metres so the paper grain never stretches round the curve.
  function coveGeometry(halfW, zFront, zBack, radius, yTop) {
    var prof = [];      // {z, y, nz, ny, s}
    var cz = zBack - radius, cy = radius;
    var s = 0, i, t, a, y;
    var nFloor = 3, nArc = 12, nWall = 6;
    for (i = 0; i <= nFloor; i++) {
      t = i / nFloor;
      var z = zFront + (cz - zFront) * t;
      prof.push({ z: z, y: 0, nz: 0, ny: 1, s: z - zFront });
    }
    var floorLen = cz - zFront;
    for (i = 1; i <= nArc; i++) {
      a = -Math.PI / 2 + (Math.PI / 2) * (i / nArc);
      prof.push({
        z: cz + radius * Math.cos(a), y: cy + radius * Math.sin(a),
        nz: -Math.cos(a), ny: -Math.sin(a),
        s: floorLen + radius * (a + Math.PI / 2)
      });
    }
    var arcEnd = floorLen + radius * Math.PI / 2;
    for (i = 1; i <= nWall; i++) {
      t = i / nWall;
      y = radius + (yTop - radius) * t;
      prof.push({ z: zBack, y: y, nz: -1, ny: 0, s: arcEnd + (y - radius) });
    }

    var nx = 3, np = prof.length;
    var pos = new Float32Array((nx + 1) * np * 3);
    var nor = new Float32Array((nx + 1) * np * 3);
    var uv = new Float32Array((nx + 1) * np * 2);
    var idx = [];
    for (i = 0; i <= nx; i++) {
      var x = -halfW + (2 * halfW) * (i / nx);
      for (var p = 0; p < np; p++) {
        var k = i * np + p, e = prof[p];
        pos[k * 3] = x; pos[k * 3 + 1] = e.y; pos[k * 3 + 2] = e.z;
        nor[k * 3] = 0; nor[k * 3 + 1] = e.ny; nor[k * 3 + 2] = e.nz;
        uv[k * 2] = x + halfW; uv[k * 2 + 1] = e.s;
        if (i < nx && p < np - 1) {
          var a0 = k, b0 = k + 1, c0 = k + np, d0 = k + np + 1;
          idx.push(a0, c0, b0, b0, c0, d0);
        }
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return g;
  }

  // Printed sample names. Canvas 2D with a system font stack - no font file,
  // no asset, and crisp because the texture is authored at roughly twice its
  // on-screen width.
  function labelMesh(ctx, text) {
    try {
      var c = document.createElement('canvas');
      c.width = 256; c.height = 40;
      var g = c.getContext('2d');
      g.clearRect(0, 0, 256, 40);
      g.font = '600 26px "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineJoin = 'round';
      g.strokeStyle = 'rgba(10,12,14,0.9)';
      g.lineWidth = 6;
      g.strokeText(text, 128, 21);
      g.fillStyle = '#dcd6cb';
      g.fillText(text, 128, 21);
      var t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = chartAniso(ctx);
      t.needsUpdate = true;
      var m = new THREE.MeshBasicMaterial({
        map: t, transparent: true, depthWrite: false, alphaTest: 0.04
      });
      m.name = 'chart_label';
      return new THREE.Mesh(new THREE.PlaneGeometry(CELL.labelW, CELL.labelH), m);
    } catch (e) {
      GAME.logError('chart.label', e);
      return null;
    }
  }

  // Local rig. Shadow-free and distance-limited: the chart only ever exists in
  // the `materials` scenario, and these must not reach anything else.
  function chartLights(ctx, group) {
    try {
      // Grazing key from frame-left (screen right is world -X at yaw = PI, so
      // +X is frame-left). N.L on the plates is ~0.20 - almost no diffuse, all
      // Fresnel, which is exactly where roughness separates. It has to be a
      // DIRECTIONAL: a spot or point out at x = +14 obeys inverse square and
      // washes the left edge of the cyclorama five stops hotter than the right.
      var graze = new THREE.DirectionalLight(0xffe9d2, 0.95);
      graze.position.set(16.0, 4.2, -3.2);
      graze.target.position.set(0, 3.9, 0);
      graze.castShadow = false;
      group.add(graze);
      group.add(graze.target);

      // Small near source above frame-right. On a sphere its highlight is a
      // tight bright ping at roughness 0.1 and a broad dim wash at 0.95, and
      // it sweeps across the plates as a gloss band. This is the roughness
      // ruler the chart was missing.
      var ping = new THREE.PointLight(0xfff6ea, 60, 30, 2);
      ping.position.set(-3.4, 7.0, -4.8);
      ping.castShadow = false;
      group.add(ping);

      // Cool bounce off the cove floor so the shadow side never goes to mud.
      var bounce = new THREE.PointLight(0x9fc0e0, 26, 24, 2);
      bounce.position.set(2.4, 0.9, -5.2);
      bounce.castShadow = false;
      group.add(bounce);
    } catch (e) { GAME.logError('chart.lights', e); }
  }

  function buildMaterialChart(ctx) {
    var group = new THREE.Object3D();
    group.name = 'material_chart';
    var i;

    // ---- stage: coved cyclorama, sized to just cover the frame -------------
    // The floor runs back past the camera standpoint on purpose: the bottom
    // edge of a 52 deg frame lands within 10 cm of the cove curve, so a floor
    // that stopped at the frame edge would let the void in at any other aspect.
    var cyc = new THREE.Mesh(coveGeometry(9.8, -11.0, 1.15, 1.7, 9.8),
      cycloramaMaterial(ctx));
    cyc.receiveShadow = true;
    cyc.castShadow = false;
    group.add(cyc);

    chartLights(ctx, group);

    // ---- one cell per material: sphere, flat plate, raked plate, name ------
    for (i = 0; i < CHART_ORDER.length; i++) {
      var name = CHART_ORDER[i];
      var mat = null;
      try {
        mat = ctx.materials && ctx.materials.get ? ctx.materials.get(name) : null;
      } catch (e) { GAME.logError('chart:' + name, e); }
      if (!mat || !mat.isMaterial) {
        mat = new THREE.MeshStandardMaterial({ color: 0xff00ff, roughness: 0.6 });
        mat.name = 'chart_missing_' + name;
      }

      var col = i % CHART.cols;
      var row = Math.floor(i / CHART.cols);
      var cx = chartX(col, CHART.cols);
      var base = CHART.rowBase[Math.min(row, CHART.rowBase.length - 1)];

      // form + specular + terminator. uv.x doubled so the equator does not
      // squash the pattern to half width against the pole-to-pole arc.
      var sg = scaleUV(new THREE.SphereGeometry(CELL.sphereR, 40, 26), 2, 1);
      var sphere = new THREE.Mesh(chartGeo(sg, mat), mat);
      sphere.position.set(cx, base + CELL.sphereY, 0);
      sphere.castShadow = sphere.receiveShadow = true;
      group.add(sphere);

      // square to camera: albedo, tiling, macro normal
      var pg = scaleUV(box(CELL.plateW, CELL.plateW, CELL.plateT, 0.02),
        PLATE_UV, PLATE_UV);
      var plate = new THREE.Mesh(chartGeo(pg, mat), mat);
      plate.position.set(cx, base + CELL.plateY, 0);
      plate.castShadow = plate.receiveShadow = true;
      group.add(plate);

      // raked 60 degrees: grazing roughness, parallax silhouette, aniso
      var rg = scaleUV(box(CELL.plateW, CELL.plateW, CELL.plateT * 0.8, 0.02),
        PLATE_UV, PLATE_UV);
      var rake = new THREE.Mesh(chartGeo(rg, mat), mat);
      rake.position.set(cx, base + CELL.rakeY, 0);
      rake.rotation.x = CELL.rakeTilt;
      rake.castShadow = rake.receiveShadow = true;
      group.add(rake);

      var label = labelMesh(ctx, CHART_LABEL[name] || name);
      if (label) {
        label.position.set(cx, base + CELL.labelY, 0.02);
        label.rotation.y = Math.PI;     // faces the camera, which looks toward +Z
        group.add(label);
      }
    }

    // ---- neutral step wedge: the exposure / grade reference ----------------
    // Flat quads, not boxes: a bevelled box catches a rim highlight off the
    // grazing key on every chip, which is precisely the contamination the
    // unlit material is there to remove.
    for (i = 0; i < WEDGE.length; i++) {
      var chip = new THREE.Mesh(new THREE.PlaneGeometry(CELL.labelW, WEDGE_H),
        wedgeMat(WEDGE[i]));
      chip.position.set(chartX(i, WEDGE.length), WEDGE_Y, -0.55);
      chip.rotation.y = Math.PI;      // faces the camera, which looks toward +Z
      chip.castShadow = chip.receiveShadow = false;
      group.add(chip);
    }

    group.position.set(CHART.x, CHART.y, CHART.z);
    ctx.scene.add(group);
    ctx._chart = group;
    return group;
  }

  // ==========================================================================
  // Public surface. GAME.Scenarios is a constructor function rather than a
  // bare object literal so tools/check.py sees a real export like every other
  // module; the documented statics main.js calls are unchanged:
  //     GAME.Scenarios.apply(name, ctx)
  //     GAME.Scenarios.tick(name, ctx, t, i)
  // The static `apply` deliberately shadows Function.prototype.apply. Nothing
  // in the build ever invokes GAME.Scenarios reflectively, and main.js is the
  // only consumer.
  // ==========================================================================
  function applyScenario(name, ctx) {
    var fn = S[name] || S.street;
    fn(ctx);
    ctx.camera.updateMatrixWorld(true);
  }

  // Called before each simulated step; drives timed events like firing.
  function tickScenario(name, ctx, t, i) {
    // The harbor portrait is solved one tick late, because the lamps it is
    // solved against do not exist until lighting.js has seen the level. i >= 1
    // is the first tick with a completed update behind it.
    if (ctx._harborPortrait === 1 && i >= 1) settleHarborPortrait(ctx, i);

    if (ctx._holdEnemy) holdEnemy(ctx._holdEnemy, ctx._holdMark);

    if (ctx._fireAt != null && t >= ctx._fireAt) {
      ctx._fireAt = null;
      if (ctx.weapons && ctx.weapons.fire) {
        try { ctx.weapons.fire(); } catch (e) { GAME.logError('scenario.fire', e); }
      }
    }
    if (ctx._explodeAt != null && t >= ctx._explodeAt) {
      ctx._explodeAt = null;
      if (ctx.vfx && ctx.vfx.explosion) {
        try {
          var p = ctx.camera.position.clone();
          p.add(new V(Math.sin(ctx.camera.rotation.y) * -9, -0.6, Math.cos(ctx.camera.rotation.y) * -9));
          ctx.vfx.explosion(p, 4.5);
        } catch (e) { GAME.logError('scenario.explosion', e); }
      }
    }
    // Force a lightning strike at a fixed time so the capture reliably catches
    // one. Left to its own random interval, the strike lands inside the
    // captured frame only occasionally and the shot is not reproducible.
    if (ctx._strikeAt != null && t >= ctx._strikeAt) {
      ctx._strikeAt = null;
      if (ctx.weather && ctx.weather.strike) {
        try { ctx.weather.strike(); } catch (e) { GAME.logError('scenario.strike', e); }
      }
    }
  }

  function Scenarios(ctx) {
    this.ctx = ctx || null;
  }
  Scenarios.list = Object.keys(S);
  Scenarios.materialOrder = CHART_ORDER.slice();
  Scenarios.apply = applyScenario;
  Scenarios.tick = tickScenario;
  Scenarios.prototype.apply = function (name) { return applyScenario(name, this.ctx); };
  Scenarios.prototype.tick = function (name, t, i) { return tickScenario(name, this.ctx, t, i); };

  GAME.Scenarios = Scenarios;

})(window, window.THREE);
