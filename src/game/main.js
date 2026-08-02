// ============================================================================
// OPERATION BLACKOUT - bootstrap & frame loop
// INTEGRATION FILE. Owned by integration. Do not edit from a feature agent.
//
// Boots every system defensively: a system that is missing or that throws
// during build is skipped and recorded, so a partial build still renders
// something the critic loop can look at instead of a black screen.
// ============================================================================
(function (window, THREE) {
  'use strict';

  var GAME = window.GAME;
  var M = GAME.Math;

  // --------------------------------------------------------------------------
  // URL parameters drive headless capture.
  // --------------------------------------------------------------------------
  function params() {
    var p = {};
    var q = window.location.search.replace(/^\?/, '');
    if (!q) return p;
    q.split('&').forEach(function (kv) {
      var i = kv.indexOf('=');
      var k = i < 0 ? kv : kv.slice(0, i);
      var v = i < 0 ? '1' : decodeURIComponent(kv.slice(i + 1));
      p[k] = v;
    });
    return p;
  }
  var P = params();
  var CAPTURE = !!P.scenario;
  GAME.headless = CAPTURE;
  GAME.params = P;

  // --------------------------------------------------------------------------
  // Boot order. A system listed here is constructed from GAME[className]
  // if that class exists.
  // --------------------------------------------------------------------------
  var SYSTEMS = [
    { key: 'textures',   cls: 'TextureLibrary',    label: 'Generating materials' },
    { key: 'materials',  cls: 'MaterialLibrary',   label: 'Compiling shaders' },
    { key: 'sky',        cls: 'Sky',               label: 'Building atmosphere' },
    { key: 'lighting',   cls: 'Lighting',          label: 'Placing lights' },
    { key: 'postfx',     cls: 'PostFX',            label: 'Initialising post-process' },
    { key: 'level',      cls: 'Level',             label: 'Constructing level' },
    { key: 'props',      cls: 'Props',             label: 'Dressing the set' },
    { key: 'player',     cls: 'PlayerController',  label: 'Calibrating movement' },
    { key: 'weapons',    cls: 'WeaponSystem',      label: 'Assembling weapons' },
    { key: 'ballistics', cls: 'Ballistics',        label: 'Loading ballistics' },
    { key: 'vfx',        cls: 'VFX',               label: 'Warming effects' },
    { key: 'audio',      cls: 'Audio',             label: 'Synthesising audio' },
    { key: 'ai',         cls: 'AISystem',          label: 'Waking hostiles' },
    { key: 'hud',        cls: 'HUD',               label: 'Drawing HUD' }
  ];

  // --------------------------------------------------------------------------
  // Quality presets
  // --------------------------------------------------------------------------
  function qualityFor(level) {
    var q = {
      level: level,
      pixelRatio: 1,
      shadowRes: 2048,
      cascades: 4,
      ssao: true, ssaoScale: 0.5,
      taa: true, bloom: true, motionBlur: true, dof: true,
      volumetrics: true, ssr: false,
      decals: 96, particles: 1.0
    };
    if (level === 'low') {
      q.shadowRes = 1024; q.cascades = 2; q.ssao = false; q.taa = false;
      q.motionBlur = false; q.dof = false; q.volumetrics = false;
      q.decals = 32; q.particles = 0.5;
    } else if (level === 'medium') {
      q.shadowRes = 2048; q.cascades = 3; q.ssaoScale = 0.5;
      q.dof = false; q.decals = 64; q.particles = 0.75;
    } else if (level === 'ultra') {
      q.shadowRes = 4096; q.cascades = 4; q.ssaoScale = 1.0;
      q.ssr = true; q.decals = 160; q.particles = 1.5;
    }
    return q;
  }

  // --------------------------------------------------------------------------
  // Engine
  // --------------------------------------------------------------------------
  function Engine() {
    this.ctx = null;
    this.running = false;
    this.frame = 0;
    this.acc = 0;
    this.fps = 0;
    this._fpsAcc = 0;
    this._fpsN = 0;
  }

  Engine.prototype.boot = async function () {
    var status = document.getElementById('boot-status');
    var bar = document.getElementById('boot-bar');
    var self = this;

    function progress(pct, label) {
      if (bar) bar.style.width = (pct * 100).toFixed(1) + '%';
      if (status) status.textContent = label;
    }

    var w = parseInt(P.w || 0, 10) || window.innerWidth;
    var h = parseInt(P.h || 0, 10) || window.innerHeight;

    // ---- renderer -----------------------------------------------------------
    var canvas = document.getElementById('view');
    var renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: canvas,
        antialias: false,          // postfx does its own AA
        alpha: false,
        stencil: false,
        depth: true,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: CAPTURE
      });
    } catch (e) {
      GAME.logError('renderer', e);
      showFatal('WebGL is unavailable in this browser.');
      return;
    }

    var quality = qualityFor(P.quality || (CAPTURE ? 'ultra' : 'high'));
    renderer.setPixelRatio(CAPTURE ? 1 : Math.min(window.devicePixelRatio || 1, quality.pixelRatio || 1));
    renderer.setSize(w, h, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Tone mapping happens in the postfx composite so bloom/DoF work in HDR.
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.autoClear = false;
    renderer.info.autoReset = false;

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(
      parseFloat(P.fov || 0) || 80, w / h, 0.05, 600);
    camera.rotation.order = 'YXZ';

    // The viewmodel lives in its own scene/camera so the weapon can use a
    // narrow FOV (no fisheye distortion) and never intersect world geometry.
    var viewScene = new THREE.Scene();
    var viewCamera = new THREE.PerspectiveCamera(55, w / h, 0.002, 12);
    viewCamera.rotation.order = 'YXZ';

    var seed = parseInt(P.seed || 0, 10) || 20260801;

    var ctx = this.ctx = {
      THREE: THREE, GAME: GAME,
      renderer: renderer, canvas: canvas,
      scene: scene, camera: camera,
      viewScene: viewScene, viewCamera: viewCamera,
      width: w, height: h,
      clock: new THREE.Clock(),
      time: 0, dt: 0, frame: 0,
      rng: new GAME.RNG(seed),
      seed: seed,
      input: new GAME.Input(),
      quality: quality,
      capture: CAPTURE,
      settings: {
        fov: camera.fov,
        sensitivity: 0.0022,
        adsSensitivityScale: 0.65,
        invertY: false
      },
      bus: GAME.bus,
      engine: this
    };
    GAME.ctx = ctx;

    // ---- build systems ------------------------------------------------------
    var built = [];
    for (var i = 0; i < SYSTEMS.length; i++) {
      var s = SYSTEMS[i];
      progress(i / SYSTEMS.length, s.label + '…');
      if (!CAPTURE) await GAME.yieldFrame();
      var Cls = GAME[s.cls];
      if (typeof Cls !== 'function') {
        GAME.logError('boot', 'missing system: GAME.' + s.cls);
        continue;
      }
      try {
        var inst = new Cls(ctx);
        ctx[s.key] = inst;
        if (typeof inst.build === 'function') await inst.build(ctx);
        built.push(s.key);
      } catch (e) {
        GAME.logError('build:' + s.key, e);
        ctx[s.key] = null;
      }
    }
    this.built = built;
    progress(1, 'Ready');

    // Fallback so a build with no lighting system still shows something.
    if (!ctx.lighting && !scene.children.some(function (o) { return o.isLight; })) {
      var sun = new THREE.DirectionalLight(0xfff0dd, 3.0);
      sun.position.set(30, 50, 20);
      sun.castShadow = true;
      scene.add(sun, new THREE.HemisphereLight(0x9dbcff, 0x4a3b2a, 0.6));
    }

    window.addEventListener('resize', function () { self.resize(); });

    if (CAPTURE) {
      await this.runCapture();
    } else {
      this.startInteractive();
    }
  };

  // --------------------------------------------------------------------------
  // Interactive mode
  // --------------------------------------------------------------------------
  Engine.prototype.startInteractive = function () {
    var ctx = this.ctx, self = this;
    var overlay = document.getElementById('boot');
    var startBtn = document.getElementById('start-btn');
    if (overlay) overlay.classList.add('ready');

    function begin() {
      if (overlay) overlay.classList.add('hidden');
      ctx.input.requestLock(ctx.canvas);
      if (ctx.audio && ctx.audio.unlock) { try { ctx.audio.unlock(); } catch (e) { GAME.logError('audio.unlock', e); } }
      GAME.bus.emit('game:start');
    }
    if (startBtn) startBtn.addEventListener('click', begin);
    document.addEventListener('click', function () {
      if (overlay && overlay.classList.contains('hidden') && !ctx.input.locked) {
        ctx.input.requestLock(ctx.canvas);
      }
    });

    this.running = true;
    ctx.clock.start();
    var loop = function () {
      requestAnimationFrame(loop);
      var dt = Math.min(ctx.clock.getDelta(), 1 / 20);
      self.step(dt);
      self.render();
    };
    requestAnimationFrame(loop);
  };

  // --------------------------------------------------------------------------
  // Simulation step
  // --------------------------------------------------------------------------
  Engine.prototype.step = function (dt) {
    var ctx = this.ctx;
    ctx.dt = dt;
    ctx.time += dt;
    ctx.frame = ++this.frame;

    for (var i = 0; i < SYSTEMS.length; i++) {
      var sys = ctx[SYSTEMS[i].key];
      if (sys && typeof sys.update === 'function') {
        try { sys.update(dt, ctx); }
        catch (e) { GAME.logError('update:' + SYSTEMS[i].key, e); }
      }
    }
    ctx.input.endFrame();

    this._fpsAcc += dt; this._fpsN++;
    if (this._fpsAcc >= 0.5) {
      this.fps = this._fpsN / this._fpsAcc;
      this._fpsAcc = 0; this._fpsN = 0;
    }
  };

  Engine.prototype.render = function () {
    var ctx = this.ctx;
    ctx.renderer.info.reset();
    try {
      if (ctx.postfx && ctx.postfx.render) {
        ctx.postfx.render(ctx);
      } else {
        ctx.renderer.setRenderTarget(null);
        ctx.renderer.clear(true, true, true);
        ctx.renderer.render(ctx.scene, ctx.camera);
        ctx.renderer.clearDepth();
        ctx.renderer.render(ctx.viewScene, ctx.viewCamera);
      }
    } catch (e) {
      GAME.logError('render', e);
    }
  };

  Engine.prototype.resize = function () {
    var ctx = this.ctx;
    if (CAPTURE) return;
    var w = window.innerWidth, h = window.innerHeight;
    ctx.width = w; ctx.height = h;
    ctx.renderer.setSize(w, h, false);
    ctx.camera.aspect = w / h; ctx.camera.updateProjectionMatrix();
    ctx.viewCamera.aspect = w / h; ctx.viewCamera.updateProjectionMatrix();
    for (var i = 0; i < SYSTEMS.length; i++) {
      var sys = ctx[SYSTEMS[i].key];
      if (sys && typeof sys.resize === 'function') {
        try { sys.resize(w, h, ctx); } catch (e) { GAME.logError('resize', e); }
      }
    }
  };

  // --------------------------------------------------------------------------
  // Deterministic capture for the visual-critic loop.
  // --------------------------------------------------------------------------
  Engine.prototype.runCapture = async function () {
    var ctx = this.ctx;
    var name = P.scenario;
    var duration = parseFloat(P.t || '2.5');

    try { GAME.Scenarios.apply(name, ctx); }
    catch (e) { GAME.logError('scenario:' + name, e); }

    // Fixed timestep so a given (scenario, t, seed) always yields the same frame.
    var dt = 1 / 60;
    var steps = Math.max(1, Math.round(duration / dt));
    for (var i = 0; i < steps; i++) {
      try { GAME.Scenarios.tick(name, ctx, i * dt, i); }
      catch (e) { GAME.logError('scenario.tick', e); }
      this.step(dt);
      // Let the GPU breathe on long simulations so we do not trip a TDR.
      if ((i & 63) === 63) { this.render(); }
    }
    this.render();
    // Second render: TAA and any history-buffer effect need a stable frame.
    this.step(dt); this.render();

    if (P.hud === '0' && ctx.hud && ctx.hud.setVisible) ctx.hud.setVisible(false);

    var info = ctx.renderer.info;
    var report = {
      scenario: name,
      t: duration,
      built: this.built,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs ? info.programs.length : -1,
      textures: info.memory.textures,
      geometries: info.memory.geometries,
      errors: (GAME.errors || []).slice(0, 40)
    };
    window.__REPORT__ = report;
    window.__READY__ = true;
    document.title = 'READY ' + JSON.stringify(report).slice(0, 900);

    var el = document.getElementById('boot');
    if (el) el.remove();
    if ((GAME.errors || []).length) showErrorBadge(GAME.errors);
  };

  // --------------------------------------------------------------------------
  // Failure surfaces - a screenshot of an error beats a screenshot of black.
  // --------------------------------------------------------------------------
  function showFatal(msg) {
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;background:#140a0a;color:#ff8080;' +
      'font:16px ui-monospace,Consolas,monospace;padding:40px;white-space:pre-wrap;z-index:9999';
    d.textContent = 'FATAL: ' + msg + '\n\n' + (GAME.errors || []).join('\n\n');
    document.body.appendChild(d);
    document.title = 'FATAL';
  }

  function showErrorBadge(errors) {
    var d = document.createElement('div');
    d.id = 'err-badge';
    d.style.cssText = 'position:fixed;left:0;bottom:0;max-height:42vh;overflow:hidden;' +
      'background:rgba(60,0,0,.86);color:#ffb3b3;font:11px ui-monospace,Consolas,monospace;' +
      'padding:8px 10px;white-space:pre-wrap;z-index:9999;max-width:70vw;pointer-events:none';
    d.textContent = errors.length + ' ERROR(S)\n' + errors.join('\n').slice(0, 2600);
    document.body.appendChild(d);
  }

  window.addEventListener('error', function (e) {
    GAME.logError('window', e.error || e.message);
  });
  window.addEventListener('unhandledrejection', function (e) {
    GAME.logError('promise', e.reason);
  });

  // --------------------------------------------------------------------------
  GAME.Engine = Engine;

  function start() {
    var engine = new Engine();
    GAME.engine = engine;
    engine.boot().catch(function (e) {
      GAME.logError('boot', e);
      showFatal(String(e && e.stack || e));
      window.__READY__ = true;
      document.title = 'READY {"fatal":true}';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

})(window, window.THREE);
