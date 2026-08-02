// ============================================================================
// OPERATION BLACKOUT - HUD  (GAME.HUD)
//
// A DOM + CSS overlay. Nothing here touches WebGL: text rendered by the browser
// stays crisp at any resolution, costs zero draw calls, and never fights the
// post-process chain for the frame buffer.
//
// Design notes that matter:
//  * EVERY animation is driven numerically from update(dt) and written out as a
//    CSS custom property / transform. CSS keyframes are deliberately NOT used
//    for anything load-bearing because the headless capture harness simulates
//    the whole scene inside one synchronous JS block - wall-clock CSS
//    animations would be frozen at t=0 in every screenshot.
//  * Only transforms, opacities and custom properties are written per frame,
//    and every write is cached so an unchanged value never touches the DOM.
//    Layout is read exactly once per resize, never inside the frame loop.
//  * Sizing is expressed against a single `--u` unit, `clamp()`ed against vmin,
//    so 1280x720 and 2560x1440 both get a sane HUD without JS layout math.
//  * The look is restrained on purpose: the art direction is photographic, and
//    a bright, busy HUD is the fastest way to make a render look like a demo.
//    Thin strokes, ~85% opacity, dark outlines for legibility over sunlit sand.
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  var M = GAME.Math;

  // ---- tunables -------------------------------------------------------------
  var HITMARKER_TIME = 0.18;    // spec: snappy ~180ms pop
  var DAMAGE_TIME = 1.2;        // directional damage arc lifetime
  var KILLFEED_TIME = 5.0;      // seconds before an entry starts fading
  var KILLFEED_FADE = 0.75;
  var KILLFEED_MAX = 6;
  var POPUP_TIME = 1.35;
  var POPUP_MAX = 7;
  var THREAT_TIME = 1.6;        // how long a firing enemy stays flagged
  var MARKER_POOL = 10;
  var DAMAGE_POOL = 6;
  var COMPASS_PPD = 0.30;       // compass px-per-degree, expressed in `--u`
  var COMPASS_HALF_DEG = 62;    // visible half-width of the compass strip

  // Scratch objects. Allocation inside the frame loop causes GC hitches which
  // read as stutter, so everything transient is reused.
  var _v1 = new THREE.Vector3();
  var _v2 = new THREE.Vector3();
  var _v3 = new THREE.Vector3();
  var _mViewProj = new THREE.Matrix4();
  var _mTmp = new THREE.Matrix4();

  var CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

  // ---------------------------------------------------------------------------
  // DOM write helpers - every one caches, so a steady-state frame writes nothing
  // ---------------------------------------------------------------------------
  function setText(el, s) {
    if (!el) return;
    if (el.__t !== s) { el.__t = s; el.textContent = s; }
  }
  function setVar(el, k, v) {
    if (!el) return;
    var c = el.__v || (el.__v = {});
    if (c[k] !== v) { c[k] = v; el.style.setProperty(k, v); }
  }
  function setStyle(el, k, v) {
    if (!el) return;
    var c = el.__s || (el.__s = {});
    if (c[k] !== v) { c[k] = v; el.style[k] = v; }
  }
  function setClass(el, cls, on) {
    if (!el) return;
    var c = el.__c || (el.__c = {});
    if (c[cls] === on) return;
    c[cls] = on;
    if (on) el.classList.add(cls); else el.classList.remove(cls);
  }
  function n2(v) { return (Math.round(v * 100) / 100).toString(); }
  // Whole-pixel length. Hairline HUD furniture must land on exact device pixels
  // or it renders as a row of unevenly-lit smears; see _applyMetrics.
  function qpx(v, min) {
    var n = Math.round(v);
    if (n < min) n = min;
    return n + 'px';
  }

  function make(tag, cls, parent) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (parent) parent.appendChild(el);
    return el;
  }

  // Pull a value from an object under any of several plausible property names.
  // Other modules are written by other agents; this is how the HUD stays useful
  // whether the weapon system calls its magazine `ammo`, `rounds` or `magAmmo`.
  function pick(obj, names, dflt) {
    if (!obj) return dflt;
    for (var i = 0; i < names.length; i++) {
      var v = obj[names[i]];
      if (v !== undefined && v !== null && v === v) return v;
    }
    return dflt;
  }

  function sanitizeName(s, max) {
    if (s === undefined || s === null) return '';
    s = String(s).toUpperCase().replace(/[^A-Z0-9 ._\-]/g, '');
    s = s.replace(/\s+/g, ' ').trim();
    if (s.length > (max || 14)) s = s.slice(0, max || 14);
    return s;
  }

  // ---------------------------------------------------------------------------
  // Procedural weapon glyphs for the killfeed. Everything is a hand-authored
  // silhouette path - no logos, no real-world marks, no image assets.
  // ---------------------------------------------------------------------------
  var GLYPH_PATHS = {
    rifle:
      'M2 6.2h6.4v4.4H2z' +
      'M8.4 5h13v6.2h-13z' +
      'M12.6 2.4h6.6v2.6h-6.6z' +
      'M21.4 6.3h13.8v2.9H21.4z' +
      'M35.2 6.7h7.1v2.1h-7.1z' +
      'M42.3 5.9h2.7v3.7h-2.7z' +
      'M13.6 11.2h3.7l1.5 4.5h-3.7z' +
      'M8.9 11.2h2.9l1 3.3H9.9z',
    smg:
      'M6 6.4h5.6v4.2H6z' +
      'M11.6 5.1h11.8v6h-11.8z' +
      'M15 2.6h6v2.5h-6z' +
      'M23.4 6.4h9.4v2.8h-9.4z' +
      'M32.8 6.8h5.6v2h-5.6z' +
      'M15.6 11.1h3.4l1 4.6h-3.4z' +
      'M12.2 11.1h2.6l.8 3.2h-2.6z',
    pistol:
      'M13 4.8h19v4.1H13z' +
      'M32 5.5h3.4v2.6H32z' +
      'M13 8.9h5.4l-2.7 6.6h-4.5z' +
      'M18.4 8.9h8.8v1.5h-8.8z' +
      'M20.4 10.4h1.5v2.1h-1.5z',
    shotgun:
      'M2 6.6h6v4.2H2z' +
      'M8 5.4h11.4v5.8H8z' +
      'M19.4 6.5h20.4v2.6H19.4z' +
      'M22 9.4h9.6v2.1H22z' +
      'M39.8 6.2h4v3.2h-4z' +
      'M9.4 11.2h2.8l.9 3.4h-2.8z',
    sniper:
      'M1 6.4h6.6v4.6H1z' +
      'M7.6 5h12.4v6.4H7.6z' +
      'M10.4 1.6h9.8v3.2h-9.8z' +
      'M9 2.4h1.6v2.4H9z' +
      'M20 6.4h23v2.6H20z' +
      'M43 5.9h3.2v3.6H43z' +
      'M12.6 11.4h3.5l1.4 4.3h-3.5z' +
      'M24 9h1.4v4.4h-1.4z',
    explosive:
      'M24 0.6l3.1 6.5 6.6-2.6-2.9 6.4 7.1.8-5.7 4.3 5.7 4.3-7.1.8 2.9 6.4-6.6-2.6L24 31.4' +
      'l-3.1-6.5-6.6 2.6 2.9-6.4-7.1-.8 5.7-4.3-5.7-4.3 7.1-.8-2.9-6.4 6.6 2.6z',
    knife:
      'M4 9.6h13.5l3.4-3.4 18-4.4-3.6 6.2-14 4.2H4z' +
      'M4 8.4h9v3.6H4z'
  };

  function glyphKind(name) {
    var s = String(name || '').toLowerCase();
    if (/knife|melee|blade|bayonet/.test(s)) return 'knife';
    if (/nade|grenade|rocket|launch|rpg|explos|c4|mine|frag/.test(s)) return 'explosive';
    if (/sniper|dmr|marksman|bolt|scout/.test(s)) return 'sniper';
    if (/shotgun|slug|buck|pump/.test(s)) return 'shotgun';
    if (/pistol|sidearm|handgun|revolver|magnum/.test(s)) return 'pistol';
    if (/smg|sub|mp\d|pdw|vector/.test(s)) return 'smg';
    return 'rifle';
  }

  function glyphSVG(kind) {
    if (kind === 'explosive') {
      return '<svg class="ob-g" viewBox="0 0 48 32" aria-hidden="true">' +
        '<path d="' + GLYPH_PATHS.explosive + '"/></svg>';
    }
    return '<svg class="ob-g" viewBox="0 0 48 16" aria-hidden="true">' +
      '<path d="' + (GLYPH_PATHS[kind] || GLYPH_PATHS.rifle) + '"/></svg>';
  }

  // A skull for headshot kills. Eye sockets are punched with fill-rule evenodd.
  var SKULL_SVG =
    '<svg class="ob-skull" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path fill-rule="evenodd" d="M8 1.4c-3.1 0-5.2 2.1-5.2 4.8 0 1.6.7 2.6 1.5 3.2v2.4h1.5v-1.5h1v1.5h1.4v-1.5h1v1.5h1.5V9.4' +
    'c.8-.6 1.5-1.6 1.5-3.2C13.2 3.5 11.1 1.4 8 1.4z' +
    'M5.9 5.4a1.35 1.35 0 100 2.7 1.35 1.35 0 000-2.7z' +
    'M10.1 5.4a1.35 1.35 0 100 2.7 1.35 1.35 0 000-2.7z"/></svg>';

  // Directional damage arc.
  //
  // This used to be a constant-width stroked arc with an arrowhead sitting on
  // its apex. Rendered, that read as a flat red felt-tip swoosh with a comma on
  // it - uniform thickness, hard round caps, no falloff. Real damage indicators
  // are a crescent: thickest where the threat is, tapering to nothing at both
  // ends, so the shape itself encodes the bearing.
  //
  // So it is now a FILLED path, not a stroke: an outer arc of radius 47.5
  // spanning +-26 degrees closed against an inner arc of radius 44.5 spanning
  // only +-21. The narrower inner span is what makes the ends come to a point.
  // Geometry is baked as literals so nothing is computed per indicator.
  var DAMAGE_ARC =
    'M29.18 12.01A47.5 47.5 0 0 1 70.82 12.01L65.95 13.16A44.5 44.5 0 0 0 34.05 13.16Z';
  var DAMAGE_SVG =
    '<svg viewBox="0 0 100 100" aria-hidden="true">' +
    // Backing and core share the exact same path so the dark edge reads as an
    // outline rather than a second, offset shape.
    '<path class="ob-dmg-glow" d="' + DAMAGE_ARC + '" />' +
    '<path class="ob-dmg-core" d="' + DAMAGE_ARC + '" />' +
    '</svg>';

  // ---------------------------------------------------------------------------
  // Stylesheet
  // ---------------------------------------------------------------------------
  var CSS = [
    '#ob-hud{',
    '  position:fixed;inset:0;z-index:400;pointer-events:none;overflow:hidden;',
    '  contain:layout style;',
    '  font-family:ui-sans-serif,"Segoe UI Variable Text","Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;',
    '  font-variant-numeric:tabular-nums lining-nums;',
    '  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;',
    '  user-select:none;-webkit-user-select:none;',
    '  color:rgb(223,233,242);',
    // One unit drives every size in the HUD. Tied to vmin so it tracks screen
    // height, clamped so 720p is not microscopic and 1440p+ does not turn the
    // HUD into a billboard. 720p->9.5px, 1080p->13.5px, 1440p->16px.
    '  --u:clamp(9.5px,1.25vmin,19px);',
    '  --fg:223,233,242;',
    '  --amber:255,178,74;',
    '  --red:255,74,52;',
    '  --cyan:170,222,255;',
    '  --chg:0.95;--chl:1;--cht:0.165;--cho:0.85;--dot:0.85;',
    '  --hms:1;--hmo:0;--hmc:255,255,255;--hmg:0.62;--hml:0.8;--hmt:0.19;',
    '  --blood:0;--crit:0;--vig:0;',
    // Hairline furniture is sized in WHOLE DEVICE PIXELS, published from
    // _applyMetrics(). A 1px tick placed at a fractional x resolves as two
    // half-intensity columns, so a row of them renders as a scrappy, uneven
    // barcode - which is exactly what the compass tape and the ammo pip strip
    // looked like. Whole-pixel geometry plus a whole-pixel scroll offset is the
    // difference between "HUD" and "screenshot of a HUD".
    '  --ctw:2px;--cth:4px;--cthm:8px;--ctb:5px;--cmp:0px;--b:0px;',
    '  --pipw:3px;--piph:8px;--pipg:2px;',
    '}',
    '#ob-hud.ob-hidden{display:none!important}',
    // Headless capture fast-forwards the simulation inside one synchronous
    // block; wall-clock CSS animation would never advance, so kill it outright.
    '#ob-hud.ob-static *,#ob-hud.ob-static{transition:none!important;animation:none!important}',

    '#ob-hud .ob-layer{position:absolute;inset:0}',
    // consumes --u so JS can measure the resolved unit; see HUD._measure
    '#ob-hud .ob-probe{position:absolute;left:0;top:0;width:var(--u);height:1px;',
    '  visibility:hidden;pointer-events:none}',
    '#ob-hud .ob-center{position:absolute;left:50%;top:50%;width:0;height:0}',
    // Uppercase + wide tracking + a whisper of red/cyan fringing. The fringing
    // matches the chromatic aberration postfx puts on the frame edge, which is
    // what stops the HUD reading as a sticker pasted over the render.
    '#ob-hud .ob-t{text-transform:uppercase;letter-spacing:.18em;font-weight:600;',
    '  text-shadow:0 1px 2px rgba(0,0,0,.9),0 0 10px rgba(0,0,0,.55),',
    '   .7px 0 0 rgba(255,90,60,.10),-.7px 0 0 rgba(60,170,255,.10)}',

    // ---- REMOVED: full-frame scanline + edge-chroma veils --------------------
    // There used to be an `.ob-scan` element here at `inset:0` painting a 3px
    // repeating light/dark gradient, and an `.ob-chroma` element tinting the
    // frame edges. Both were mistakes and both are gone for good:
    //
    //  * The scanline was masked to the top ~30% and bottom ~32% of the frame,
    //    but that is still 62% of every row of the RENDER, not of the HUD. A
    //    period-3 comb of ~1 LSB laid over that much of the image put a
    //    measurable period-3 component (amplitude 0.0043) into the row-mean
    //    luminance profile. tools/analyze.py's repetition.h scores exactly that
    //    profile, so it read 0.84-0.94 on every frame captured WITH a HUD and
    //    0.00-0.10 on every frame captured without one. It was the whole of the
    //    "texture tiling" measurement, and a full-frame 1-LSB comb is also a
    //    direct micro-contrast tax - it is the classic cause of "the image
    //    looks slightly soft".
    //  * The chroma veil duplicated the chromatic aberration postfx already
    //    applies, at 5% alpha, lifting blacks at the frame edge for nothing.
    //
    // The rule this file now follows: THE HUD PAINTS ITS OWN FURNITURE AND
    // NOTHING ELSE. Any full-viewport overlay (other than the blood/critical
    // vignette, which is gameplay state and sits at opacity 0 while healthy) is
    // the HUD vandalising the render. Do not re-add a CRT filter here.

    // ---- blood vignette / critical pulse ------------------------------------
    // Layered radial blotches rather than one clean ring: a perfectly even
    // vignette reads as a filter, an uneven one reads as blood on the lens.
    // Deep, desaturated arterial red (palette: blood #6e1410), concentrated
    // hard at the frame edge with uneven blotches. An even ring reads as a
    // filter; an uneven one reads as blood on the lens.
    // Each blotch holds a plateau of full alpha before falling off, otherwise
    // only the exact gradient centre is opaque and the whole thing washes out
    // to a pale pink tint instead of reading as blood.
    // The blotches are deliberately kept OUT of the middle of the frame. At the
    // previous radii the left-hand one reached x=42% and the whole render went
    // red-brown at low health - which is a colour filter over the game, not
    // blood on the lens, and it destroys the grade every other module is
    // building toward. The centre ~45% now stays clear at any health.
    '#ob-hud .ob-blood{position:absolute;inset:0;opacity:0;',
    '  background:',
    '   radial-gradient(34% 46% at -8% 26%,rgba(88,12,9,.92) 0%,rgba(88,12,9,.66) 28%,rgba(88,12,9,0) 76%),',
    '   radial-gradient(31% 42% at 108% 66%,rgba(80,10,8,.9) 0%,rgba(80,10,8,.62) 28%,rgba(80,10,8,0) 74%),',
    '   radial-gradient(30% 22% at 74% -10%,rgba(74,12,9,.8) 0%,rgba(74,12,9,.52) 32%,rgba(74,12,9,0) 78%),',
    '   radial-gradient(32% 24% at 26% 110%,rgba(68,9,7,.84) 0%,rgba(68,9,7,.54) 30%,rgba(68,9,7,0) 76%),',
    '   radial-gradient(20% 30% at 101% 2%,rgba(84,12,9,.68) 0%,rgba(84,12,9,0) 78%),',
    // Radii are sized so the darkest stop actually lands on the frame edge:
    // a 100%-wide radial only reaches t=0.5 at the edge and never darkens.
    '   radial-gradient(66% 70% at 50% 52%,rgba(44,6,5,0) 48%,rgba(48,7,6,.4) 78%,rgba(24,3,3,.86) 100%)}',
    '#ob-hud .ob-crit{position:absolute;inset:0;opacity:0;',
    '  background:radial-gradient(66% 70% at 50% 50%,rgba(120,0,0,0) 54%,rgba(150,16,12,.34) 82%,rgba(118,8,8,.64) 100%)}',

    // ---- crosshair ----------------------------------------------------------
    // The dark outline has to fade WITH the stroke (element opacity, not
    // background alpha) or ADS leaves a black cross floating over the optic.
    '#ob-hud .ob-seg{position:absolute;left:50%;top:50%;',
    '  width:max(2px,calc(var(--u) * var(--cht)));height:calc(var(--u) * var(--chl));',
    '  background:rgba(var(--fg),.94);border-radius:.5px;opacity:var(--cho);',
    '  box-shadow:0 0 0 1px rgba(0,0,0,.62),0 0 5px rgba(0,0,0,.5);',
    '  transform:translate(-50%,-50%) rotate(var(--a)) translateY(calc(var(--u) * var(--chg) * -1))}',
    '#ob-hud .ob-dot{position:absolute;left:50%;top:50%;width:2px;height:2px;border-radius:50%;',
    '  background:rgba(var(--fg),.96);opacity:var(--dot);box-shadow:0 0 0 1px rgba(0,0,0,.66);',
    '  transform:translate(-50%,-50%)}',

    // ---- hitmarker ----------------------------------------------------------
    '#ob-hud .ob-hit{position:absolute;left:50%;top:50%;width:0;height:0;',
    '  transform:scale(var(--hms));opacity:var(--hmo)}',
    '#ob-hud .ob-hs{position:absolute;left:50%;top:50%;',
    '  width:calc(var(--u) * var(--hmt));height:calc(var(--u) * var(--hml));',
    '  background:rgb(var(--hmc));border-radius:.5px;',
    '  box-shadow:0 0 0 1px rgba(0,0,0,.55),0 0 6px rgba(0,0,0,.45);',
    '  transform:translate(-50%,-50%) rotate(var(--a)) translateY(calc(var(--u) * var(--hmg) * -1))}',

    // ---- reload arc + prompt -------------------------------------------------
    // Sized so the ring clears the crosshair even at full reload bloom - the
    // two must never overlap or the point of aim turns to mush.
    '#ob-hud .ob-arc{position:absolute;left:50%;top:50%;width:calc(var(--u)*11);height:calc(var(--u)*11);',
    '  margin-left:calc(var(--u)*-5.5);margin-top:calc(var(--u)*-5.5);opacity:0}',
    '#ob-hud .ob-arc svg{width:100%;height:100%;transform:rotate(-90deg);overflow:visible}',
    '#ob-hud .ob-arc .bg{fill:none;stroke:rgba(0,0,0,.42);stroke-width:2.6}',
    '#ob-hud .ob-arc .fg{fill:none;stroke:rgba(var(--amber),.92);stroke-width:2.2;stroke-linecap:round;',
    '  filter:drop-shadow(0 0 3px rgba(0,0,0,.6))}',
    '#ob-hud .ob-prompt{position:absolute;left:50%;top:calc(50% + var(--u)*5.4);transform:translateX(-50%);',
    '  font-size:calc(var(--u)*1.04);opacity:0;white-space:nowrap;display:flex;align-items:center;gap:.6em}',
    '#ob-hud .ob-key{display:inline-block;min-width:1.7em;padding:.16em .34em;text-align:center;',
    '  border:1px solid rgba(var(--fg),.5);border-radius:2px;background:rgba(6,10,14,.42);',
    '  font-size:.86em;letter-spacing:.06em;box-shadow:0 1px 3px rgba(0,0,0,.6)}',

    // ---- damage indicators ---------------------------------------------------
    '#ob-hud .ob-dmg{position:absolute;left:50%;top:50%;width:calc(var(--u)*34);height:calc(var(--u)*34);',
    '  margin-left:calc(var(--u)*-17);margin-top:calc(var(--u)*-17);opacity:0;display:none}',
    '#ob-hud .ob-dmg svg{width:100%;height:100%;overflow:visible}',
    // A filled crescent, not a stroked arc: the taper to a point at each end is
    // the whole reason the shape reads as a bearing rather than as a red
    // brush-stroke. The backing is the same path grown by a soft dark stroke,
    // so it works as an outline against sunlit plaster and against shadow.
    '#ob-hud .ob-dmg-glow{fill:rgba(12,2,2,.55);stroke:rgba(12,2,2,.55);stroke-width:2.6;',
    '  stroke-linejoin:round}',
    '#ob-hud .ob-dmg-core{fill:rgba(252,66,42,.9);',
    '  filter:drop-shadow(0 0 2.5px rgba(255,40,20,.5))}',

    // ---- ammo block ----------------------------------------------------------
    '#ob-hud .ob-ammo{position:absolute;right:calc(var(--u)*3.1);bottom:calc(var(--u)*2.5);',
    '  text-align:right;line-height:1}',
    // a soft scrim so white numerals stay legible over sunlit plaster
    '#ob-hud .ob-ammo::before{content:"";position:absolute;right:calc(var(--u)*-3.4);',
    '  bottom:calc(var(--u)*-3.2);width:calc(var(--u)*26);height:calc(var(--u)*15);',
    '  background:radial-gradient(70% 78% at 78% 72%,rgba(2,5,9,.42),rgba(2,5,9,0) 72%);pointer-events:none}',
    '#ob-hud .ob-wname{position:relative;font-size:calc(var(--u)*.98);letter-spacing:.26em;',
    '  color:rgba(var(--fg),.82);margin-bottom:calc(var(--u)*.42)}',
    '#ob-hud .ob-arow{position:relative;display:flex;align-items:flex-end;justify-content:flex-end;',
    '  gap:calc(var(--u)*.55)}',
    // scaleX fakes an industrial condensed face without shipping a font file
    '#ob-hud .ob-cur{font-size:calc(var(--u)*4.5);font-weight:700;letter-spacing:.005em;',
    '  transform:scaleX(.88);transform-origin:100% 100%;color:rgba(var(--fg),.96);',
    '  text-shadow:0 2px 5px rgba(0,0,0,.85),0 0 18px rgba(0,0,0,.5),',
    '   .8px 0 0 rgba(255,90,60,.12),-.8px 0 0 rgba(60,170,255,.12);',
    '  transition:color .18s ease}',
    '#ob-hud .ob-aside{display:flex;flex-direction:column;align-items:flex-end;',
    '  gap:calc(var(--u)*.32);padding-bottom:calc(var(--u)*.5)}',
    '#ob-hud .ob-res{font-size:calc(var(--u)*1.52);font-weight:600;color:rgba(var(--fg),.6);',
    '  letter-spacing:.04em;text-shadow:0 1px 3px rgba(0,0,0,.85)}',
    '#ob-hud .ob-mode{font-size:calc(var(--u)*.82);letter-spacing:.24em;color:rgba(var(--cyan),.62)}',
    // Whole-pixel width AND gap. At 720p the old fractional 2.66px pip on a
    // 4.06px pitch landed on a different sub-pixel phase every round, so the
    // magazine strip rendered as a ragged barcode of alternating thick and
    // thin bars. Integers make it a clean, machined-looking rail.
    '#ob-hud .ob-pips{position:relative;display:flex;justify-content:flex-end;align-items:flex-end;',
    '  gap:var(--pipg);margin-top:calc(var(--u)*.66);height:var(--piph)}',
    '#ob-hud .ob-pip{width:var(--pipw);height:100%;border-radius:0;',
    '  background:rgba(var(--fg),.17);box-shadow:0 0 2px rgba(0,0,0,.8)}',
    '#ob-hud .ob-pip.on{background:rgba(var(--fg),.9);box-shadow:0 0 3px rgba(0,0,0,.85)}',
    '#ob-hud .ob-ammo.low .ob-cur{color:rgb(var(--amber))}',
    '#ob-hud .ob-ammo.low .ob-pip.on{background:rgba(var(--amber),.86)}',
    '#ob-hud .ob-ammo.empty .ob-cur{color:rgb(var(--red))}',
    '#ob-hud .ob-ammo.empty .ob-pip.on{background:rgba(var(--red),.86)}',

    // ---- killfeed ------------------------------------------------------------
    '#ob-hud .ob-kf{position:absolute;right:calc(var(--u)*3.1);top:calc(var(--u)*6.4);',
    '  display:flex;flex-direction:column;align-items:flex-end;gap:calc(var(--u)*.36)}',
    // Feathered at BOTH ends. A backer that runs to full alpha and then stops
    // dead at the screen margin is the same straight-edged-panel tell as the old
    // compass scrim, just smaller.
    '#ob-hud .ob-kfr{display:flex;align-items:center;gap:calc(var(--u)*.6);',
    '  padding:calc(var(--u)*.34) calc(var(--u)*.62);border-radius:2px;',
    '  background:linear-gradient(90deg,rgba(4,8,12,0) 0%,rgba(4,8,12,.30) 24%,',
    '   rgba(4,8,12,.42) 58%,rgba(4,8,12,.30) 90%,rgba(4,8,12,0) 100%);',
    '  font-size:calc(var(--u)*1.06);white-space:nowrap;opacity:0}',
    '#ob-hud .ob-kfr .nm{letter-spacing:.14em;font-weight:600;color:rgba(var(--fg),.9);',
    '  text-shadow:0 1px 2px rgba(0,0,0,.95)}',
    '#ob-hud .ob-kfr .nm.me{color:rgb(var(--cyan))}',
    '#ob-hud .ob-kfr .nm.vic{color:rgba(var(--red),.94)}',
    '#ob-hud .ob-g{height:calc(var(--u)*1.28);width:auto;fill:rgba(var(--fg),.86);',
    '  filter:drop-shadow(0 1px 1px rgba(0,0,0,.85))}',
    '#ob-hud .ob-skull{height:calc(var(--u)*1.2);width:calc(var(--u)*1.2);fill:rgba(var(--amber),.95);',
    '  filter:drop-shadow(0 1px 1px rgba(0,0,0,.85))}',

    // ---- compass -------------------------------------------------------------
    // THE SCRIM IS NOT A BOX. There used to be a `linear-gradient(180deg,...)`
    // painted on `.ob-cmp` itself: a 42u x 3.05u rectangle at 44% alpha. On a
    // bright sky that measured as a luminance drop from 0.922 to 0.437 with a
    // 0.22-per-row step at its top and bottom edge - i.e. a hard-edged grey
    // rectangle stamped across the render. Straight-edged translucent panels
    // over the world are the single loudest "UI sticker pasted on a screenshot"
    // tell there is, and the art direction bans "perfectly straight anything".
    //
    // Legibility now comes from the tape ELEMENTS (a white core inside a hard
    // 1px black ring reads against sky and against shadow alike - that is how
    // real HUD tapes do it), and all that is left behind them is a wide,
    // unclipped ellipse. Measured A/B against the identical frame with no HUD:
    // the wash costs at most 0.006 luminance and 0.0005 per row, against 0.485
    // and 0.22 for the old panel - i.e. no edge anywhere for the eye to catch.
    '#ob-hud .ob-cscrim{position:absolute;left:50%;top:0;height:calc(var(--u)*8.4);',
    '  transform:translateX(-50%);pointer-events:none;',
    '  background:radial-gradient(50% 50% at 50% 44%,rgba(3,7,11,.058) 0%,',
    '   rgba(3,7,11,.052) 32%,rgba(3,7,11,.034) 58%,rgba(3,7,11,.013) 79%,',
    '   rgba(3,7,11,0) 100%)}',
    // Width is set from JS in whole pixels (see _applyMetrics) so the strip
    // always spans the same ~140 degrees of arc whatever the resolution.
    '#ob-hud .ob-cmp{position:absolute;left:50%;top:calc(var(--u)*1.3);transform:translateX(-50%);',
    '  max-width:78vw;height:calc(var(--u)*3.05);overflow:hidden;',
    // The ends of the tape still have to dissolve rather than stop dead.
    '  -webkit-mask-image:linear-gradient(90deg,transparent,#000 20%,#000 80%,transparent);',
    '  mask-image:linear-gradient(90deg,transparent,#000 20%,#000 80%,transparent)}',
    // Scroll offset is a whole number of pixels, so every tick lands on an
    // exact pixel column instead of shimmering between two of them.
    '#ob-hud .ob-ctrack{position:absolute;left:50%;top:0;height:100%;width:0;',
    '  transform:translate3d(var(--cmp),0,0)}',
    // 2px core, not 1px: a 1px box at a fractional x resolves as two half-lit
    // columns and the tape reads as an uneven barcode. 2px always keeps one
    // fully-lit column. The tight black ring is what makes it read over sky.
    '#ob-hud .ob-ct{position:absolute;bottom:var(--ctb);width:var(--ctw);height:var(--cth);',
    '  background:rgba(var(--fg),.92);transform:translateX(-50%);',
    '  box-shadow:0 0 0 1px rgba(0,0,0,.85),0 0 4px rgba(0,0,0,.72)}',
    '#ob-hud .ob-ct.maj{height:var(--cthm);background:rgba(255,255,255,.97)}',
    // Eight zero-blur shadows make a true 1px outline around the glyph; a blurred
    // shadow alone just greys the sky behind it and the letter still washes out.
    '#ob-hud .ob-cl{position:absolute;top:calc(var(--u)*.16);transform:translateX(-50%);',
    '  font-size:calc(var(--u)*1.12);letter-spacing:.1em;font-weight:700;color:rgba(var(--fg),.96);',
    '  text-shadow:1px 0 0 rgba(0,0,0,.94),-1px 0 0 rgba(0,0,0,.94),0 1px 0 rgba(0,0,0,.94),',
    '   0 -1px 0 rgba(0,0,0,.94),1px 1px 0 rgba(0,0,0,.82),-1px -1px 0 rgba(0,0,0,.82),',
    '   1px -1px 0 rgba(0,0,0,.82),-1px 1px 0 rgba(0,0,0,.82),0 0 7px rgba(0,0,0,.7)}',
    '#ob-hud .ob-cl.card{color:rgba(255,255,255,.99)}',
    '#ob-hud .ob-cl.sub{font-size:calc(var(--u)*.9);font-weight:600;color:rgba(var(--fg),.82);',
    '  top:calc(var(--u)*.32)}',
    '#ob-hud .ob-cmarks{position:absolute;left:50%;top:0;width:0;height:100%}',
    '#ob-hud .ob-cmk{position:absolute;bottom:calc(var(--u)*.04);width:calc(var(--u)*1.0);',
    '  height:calc(var(--u)*.6);display:none;',
    '  transform:translate3d(var(--b),0,0) translateX(-50%);',
    '  clip-path:polygon(50% 100%,0 0,100% 0);background:rgba(var(--cyan),.92);',
    '  filter:drop-shadow(0 1px 2px rgba(0,0,0,.9))}',
    '#ob-hud .ob-cmk.threat{background:rgba(var(--red),.95)}',
    // The needle is a short stem rising off the tick baseline, brightest where
    // it meets the tape. The old full-height version was a white stick hanging
    // in the sky above the letters with nothing to attach it to.
    '#ob-hud .ob-cneedle{position:absolute;left:50%;bottom:var(--ctb);width:var(--ctw);',
    '  height:calc(var(--u)*1.42);transform:translateX(-50%);',
    '  background:linear-gradient(180deg,rgba(255,255,255,.42),rgba(255,255,255,.98));',
    '  box-shadow:0 0 0 1px rgba(0,0,0,.68),0 0 5px rgba(0,0,0,.75)}',
    // The heading readout sits BELOW the scrim, over raw sky, so it needs the
    // most protection of anything on the strip: 62% grey on white was unreadable.
    // Same trick as the tape labels: a real 1px outline carries the glyph, so
    // the backing blob can drop to a whisper instead of reading as a dark pill.
    '#ob-hud .ob-hdg{position:absolute;left:50%;top:calc(var(--u)*4.5);transform:translateX(-50%);',
    '  font-size:calc(var(--u)*.9);letter-spacing:.26em;font-weight:700;color:rgba(var(--fg),.94);',
    '  padding:calc(var(--u)*.1) calc(var(--u)*.34);',
    '  background:radial-gradient(64% 128% at 50% 50%,rgba(3,7,11,.20),rgba(3,7,11,0) 76%);',
    '  text-shadow:1px 0 0 rgba(0,0,0,.9),-1px 0 0 rgba(0,0,0,.9),0 1px 0 rgba(0,0,0,.9),',
    '   0 -1px 0 rgba(0,0,0,.9),1px 1px 0 rgba(0,0,0,.78),-1px -1px 0 rgba(0,0,0,.78),',
    '   1px -1px 0 rgba(0,0,0,.78),-1px 1px 0 rgba(0,0,0,.78),0 0 6px rgba(0,0,0,.7)}',

    // ---- world markers -------------------------------------------------------
    // Placement is written as a share of the viewport in vw/vh, never in
    // pixels: headless capture lays the page out at one size and screenshots
    // it at another, and a pixel transform would freeze at the stale size.
    '#ob-hud .ob-mk{position:absolute;left:0;top:0;display:none;flex-direction:column;',
    '  align-items:center;gap:calc(var(--u)*.2);opacity:0;--mx:50;--my:50;',
    '  transform:translate3d(calc(var(--mx) * 1vw),calc(var(--my) * 1vh),0) translate(-50%,-50%)}',
    '#ob-hud .ob-mki{position:relative;width:calc(var(--u)*1.24);height:calc(var(--u)*1.24);',
    '  border:1.6px solid rgba(var(--cyan),.95);transform:rotate(45deg);',
    '  box-shadow:0 0 0 1px rgba(0,0,0,.55),0 0 9px rgba(0,0,0,.55)}',
    '#ob-hud .ob-mk.threat .ob-mki{border:none;transform:none;',
    '  width:calc(var(--u)*1.22);height:calc(var(--u)*1.05);',
    '  clip-path:polygon(50% 0,100% 92%,0 92%);background:rgba(var(--red),.92);',
    '  filter:drop-shadow(0 1px 2px rgba(0,0,0,.9))}',
    // Waypoint text lands anywhere in frame, including on sunlit plaster, so it
    // gets the same hard 1px outline as the compass glyphs. A blurred shadow
    // alone just greys the surface behind and the text still washes out.
    '#ob-hud .ob-mkl{font-size:calc(var(--u)*1.0);letter-spacing:.2em;font-weight:700;',
    '  color:rgba(255,255,255,.97);',
    '  text-shadow:1px 0 0 rgba(0,0,0,.92),-1px 0 0 rgba(0,0,0,.92),0 1px 0 rgba(0,0,0,.92),',
    '   0 -1px 0 rgba(0,0,0,.92),1px 1px 0 rgba(0,0,0,.8),-1px -1px 0 rgba(0,0,0,.8),',
    '   1px -1px 0 rgba(0,0,0,.8),-1px 1px 0 rgba(0,0,0,.8),0 0 7px rgba(0,0,0,.7)}',
    '#ob-hud .ob-mkd{font-size:calc(var(--u)*.82);letter-spacing:.14em;color:rgba(var(--fg),.82);',
    '  text-shadow:1px 0 0 rgba(0,0,0,.9),-1px 0 0 rgba(0,0,0,.9),0 1px 0 rgba(0,0,0,.9),',
    '   0 -1px 0 rgba(0,0,0,.9),1px 1px 0 rgba(0,0,0,.74),-1px -1px 0 rgba(0,0,0,.74),',
    '   1px -1px 0 rgba(0,0,0,.74),-1px 1px 0 rgba(0,0,0,.74),0 0 6px rgba(0,0,0,.68)}',
    '#ob-hud .ob-mka{position:absolute;left:50%;top:50%;width:calc(var(--u)*1.6);height:calc(var(--u)*1.0);',
    '  margin-left:calc(var(--u)*-.8);margin-top:calc(var(--u)*-.5);display:none;',
    '  clip-path:polygon(50% 0,100% 100%,0 100%);background:rgba(var(--cyan),.9);',
    '  filter:drop-shadow(0 1px 2px rgba(0,0,0,.9))}',
    '#ob-hud .ob-mk.threat .ob-mka{background:rgba(var(--red),.88)}',
    '#ob-hud .ob-mk.off .ob-mki,#ob-hud .ob-mk.off .ob-mkd{display:none}',

    // ---- score / streak popups ----------------------------------------------
    '#ob-hud .ob-pop{position:absolute;left:0;top:0;display:none;opacity:0;white-space:nowrap;',
    '  --px:8.4;--py:0;--ps:1;text-align:left;',
    '  transform:translate3d(calc(var(--u) * var(--px)),calc(var(--u) * var(--py)),0) scale(var(--ps))}',
    '#ob-hud .ob-pop .v{font-size:calc(var(--u)*1.72);font-weight:700;letter-spacing:.02em;',
    '  color:rgba(255,255,255,.97);',
    '  text-shadow:0 2px 4px rgba(0,0,0,1),0 0 9px rgba(0,0,0,.85),0 0 2px rgba(0,0,0,.95)}',
    '#ob-hud .ob-pop .k{font-size:calc(var(--u)*.92);letter-spacing:.24em;font-weight:700;',
    '  color:rgb(var(--amber));margin-left:.55em;',
    '  text-shadow:0 2px 4px rgba(0,0,0,1),0 0 9px rgba(0,0,0,.85),0 0 2px rgba(0,0,0,.95)}',
    '#ob-hud .ob-pop.streak .v{color:rgb(var(--amber));font-size:calc(var(--u)*2.05)}',
    ''
  ].join('\n');

  // ===========================================================================
  // HUD
  // ===========================================================================
  class HUD {
    constructor(ctx) {
      this.ctx = ctx || null;
      this.visible = true;
      this.built = false;
      this.root = null;
      this._errs = 0;

      // Deterministic jitter source. Never Math.random - captures must repeat.
      this.rng = (ctx && ctx.rng && ctx.rng.fork)
        ? ctx.rng.fork(0x48554400)
        : new GAME.RNG(0x48554400);

      // ---- values published for postfx ------------------------------------
      // postfx is built BEFORE the HUD, so it must read this lazily off ctx.
      this.state = {
        health: 1,          // 0..1
        damage: 0,          // 0..1, spikes on a hit then decays
        critical: 0,        // 0..1, how deep into "about to die" we are
        desaturation: 0,    // 0..1, drive a colour-drain in the grade
        heartbeat: 0,       // 0..1 pulse, peaks on each beat
        bloodVignette: 0,   // 0..1, matches the DOM vignette opacity
        hitFlash: 0,        // 0..1, spikes when the player lands a hit
        lowAmmo: 0
      };
      if (ctx) ctx.hudState = this.state;
      GAME.hudState = this.state;

      // ---- animated scalars -------------------------------------------------
      this.time = 0;
      this.health = 1;
      this.healthScale = 1;     // set to 100 the first time a >1 value arrives
      this._healthStamp = -99;
      this._prevHealth = 1;
      this.damageFlash = 0;
      this.critAmount = 0;
      this.beatPhase = 0;

      this.gap = 1.0;           // crosshair gap, in `--u`
      this.gapTarget = 1.0;
      this.bloom = 0;           // firing bloom, 0..1
      this.moveAmount = 0;
      this.adsAmount = 0;       // 0..1 aim blend, prefers the weapon's own ease
      this._adsFlag = 0;        // damped boolean fallback when none is published
      this._crossHidden = false;

      this.hitTimer = -1;
      this.hitKind = 'hit';

      this.ammo = 30;
      this.magSize = 30;
      this.reserve = 210;
      this._ammoStamp = -99;
      this.weaponName = 'CARBINE';
      this.fireMode = 'AUTO';
      this.reloading = false;
      this.reloadProgress = 0;
      this._prevReloadTimer = undefined;
      this._reloadCountsUp = false;
      this._pipCount = 0;
      this._lastAmmoSeen = 30;
      this._fireFlash = 0;

      this.damages = [];        // active directional indicators
      this.kills = [];          // killfeed entries
      this.popups = [];
      this.markers = [];        // {position, label, kind, ttl, id}
      this.objectives = [];
      this._threats = new Map();
      this._pendingKill = -1;
      this._streak = 0;
      this._streakTimer = 0;

      this.heading = 0;         // degrees clockwise from north
      this.W = 1920; this.H = 1080;
      this.unit = 13.5;
      this._ctape = null;       // [{el, deg}] compass tape, positioned in px
      this._cmpPPD = COMPASS_PPD * 13.5;  // compass pixels per degree
      this._aspect = 16 / 9;
      this._remeasure = 0;

      this._pools = { dmg: [], mk: [], kf: [], pop: [] };
      this._bindBus(ctx);
    }

    // -----------------------------------------------------------------------
    // Build - inject the stylesheet and the whole element tree once.
    // -----------------------------------------------------------------------
    async build(ctx) {
      this.ctx = ctx || this.ctx;
      try {
        this._injectStyle();
        this._buildTree();
        this._measure();
        this._remeasure = 0.25;
        this._seedObjectives();
        this.built = true;
      } catch (e) {
        GAME.logError('hud.build', e);
      }
    }

    _injectStyle() {
      if (document.getElementById('ob-hud-style')) return;
      var st = document.createElement('style');
      st.id = 'ob-hud-style';
      st.textContent = CSS;
      (document.head || document.documentElement).appendChild(st);
    }

    _buildTree() {
      var host = document.body || document.documentElement;
      var old = document.getElementById('ob-hud');
      if (old && old.parentNode) old.parentNode.removeChild(old);

      var root = this.root = make('div');
      root.id = 'ob-hud';
      // In capture mode every transition is disabled so the single rendered
      // frame shows the state the simulation actually arrived at.
      if (GAME.headless) root.classList.add('ob-static');

      this.elProbe = make('div', 'ob-probe', root);

      // --- ambience ---------------------------------------------------------
      this.elBlood = make('div', 'ob-blood', root);
      this.elCrit = make('div', 'ob-crit', root);

      // --- compass ----------------------------------------------------------
      this._buildCompass(root);

      // --- killfeed ---------------------------------------------------------
      this.elKF = make('div', 'ob-kf', root);
      for (var k = 0; k < KILLFEED_MAX; k++) {
        var row = make('div', 'ob-kfr');
        row.innerHTML = '<span class="nm a ob-t"></span>' +
          '<span class="ic"></span><span class="nm vic ob-t"></span>';
        row.__a = row.querySelector('.a');
        row.__ic = row.querySelector('.ic');
        row.__b = row.querySelector('.vic');
        this._pools.kf.push(row);
      }

      // --- world marker layer ----------------------------------------------
      // Each screen marker owns a matching tick on the compass strip, created
      // here (not in _buildCompass) because the marker pool does not exist yet
      // at the point the compass is assembled.
      this.elMarkers = make('div', 'ob-layer', root);
      for (var m = 0; m < MARKER_POOL; m++) {
        var mk = make('div', 'ob-mk', this.elMarkers);
        mk.innerHTML = '<div class="ob-mki"></div><div class="ob-mkl ob-t"></div>' +
          '<div class="ob-mkd ob-t"></div><div class="ob-mka"></div>';
        mk.__icon = mk.children[0];
        mk.__label = mk.children[1];
        mk.__dist = mk.children[2];
        mk.__arrow = mk.children[3];
        mk.__cmk = this.elCMarks ? make('div', 'ob-cmk', this.elCMarks) : null;
        this._pools.mk.push(mk);
      }

      // --- centre stack -----------------------------------------------------
      var centre = make('div', 'ob-center', root);

      // directional damage arcs
      var d;
      for (d = 0; d < DAMAGE_POOL; d++) {
        var di = make('div', 'ob-dmg', centre);
        di.innerHTML = DAMAGE_SVG;
        this._pools.dmg.push(di);
      }

      // reload arc
      this.elArc = make('div', 'ob-arc', centre);
      this.elArc.innerHTML =
        '<svg viewBox="0 0 100 100"><circle class="bg" cx="50" cy="50" r="42"/>' +
        '<circle class="fg" cx="50" cy="50" r="42"/></svg>';
      this.elArcFg = this.elArc.querySelector('.fg');
      this._arcLen = 2 * Math.PI * 42;
      this.elArcFg.setAttribute('stroke-dasharray', n2(this._arcLen));
      this.elArcFg.setAttribute('stroke-dashoffset', n2(this._arcLen));

      // crosshair: four segments + dot
      this.elCross = make('div', 'ob-center', root);
      var angles = ['0deg', '90deg', '180deg', '270deg'];
      for (var s = 0; s < 4; s++) {
        var seg = make('div', 'ob-seg', this.elCross);
        seg.style.setProperty('--a', angles[s]);
      }
      this.elDot = make('div', 'ob-dot', this.elCross);

      // hitmarker: an X of four strokes
      this.elHit = make('div', 'ob-hit', root);
      var ha = ['45deg', '135deg', '225deg', '315deg'];
      for (var h = 0; h < 4; h++) {
        var hs = make('div', 'ob-hs', this.elHit);
        hs.style.setProperty('--a', ha[h]);
      }

      // reload prompt
      this.elPrompt = make('div', 'ob-prompt ob-t', root);
      this.elPrompt.innerHTML = '<span class="ob-key">R</span><span class="lbl">Reload</span>';
      this.elPromptLbl = this.elPrompt.querySelector('.lbl');

      // --- ammo -------------------------------------------------------------
      this._buildAmmo(root);

      // --- score popups ------------------------------------------------------
      this.elPops = make('div', 'ob-center', root);
      for (var p = 0; p < POPUP_MAX; p++) {
        var pop = make('div', 'ob-pop', this.elPops);
        pop.innerHTML = '<span class="v"></span><span class="k ob-t"></span>';
        pop.__v = pop.children[0];
        pop.__k = pop.children[1];
        this._pools.pop.push(pop);
      }

      // (No full-viewport ambience layers - see the note in the stylesheet.
      // Everything above this point is bounded HUD furniture.)

      host.appendChild(root);
    }

    _buildCompass(root) {
      // The wash goes in first so it paints under the tape.
      this.elCScrim = make('div', 'ob-cscrim', root);
      var cmp = this.elCompass = make('div', 'ob-cmp', root);
      var track = this.elCTrack = make('div', 'ob-ctrack', cmp);
      // Three wraps of the circle laid out statically so the strip can scroll
      // continuously without ever rebuilding or re-measuring anything. Their
      // `left` is NOT written here: it is quantised to whole pixels against the
      // resolved unit in _applyMetrics(), which is also where a resize lands.
      this._ctape = [];
      for (var deg = -200; deg <= 560; deg += 10) {
        var norm = ((deg % 360) + 360) % 360;
        var isCard = (norm % 90) === 0;
        var isSub = (norm % 45) === 0 && !isCard;
        var el;
        if (isCard || isSub) {
          el = make('div', 'ob-cl ' + (isCard ? 'card' : 'sub'), track);
          el.textContent = CARDINALS[(norm / 45) | 0];
        } else {
          el = make('div', 'ob-ct' + ((norm % 30) === 0 ? ' maj' : ''), track);
        }
        this._ctape.push({ el: el, deg: deg });
      }
      this.elCMarks = make('div', 'ob-cmarks', cmp);
      make('div', 'ob-cneedle', cmp);
      this.elHeading = make('div', 'ob-hdg ob-t', root);
    }

    _buildAmmo(root) {
      var a = this.elAmmo = make('div', 'ob-ammo', root);
      this.elWName = make('div', 'ob-wname ob-t', a);
      var row = make('div', 'ob-arow', a);
      this.elCur = make('div', 'ob-cur', row);
      var side = make('div', 'ob-aside', row);
      this.elRes = make('div', 'ob-res', side);
      this.elMode = make('div', 'ob-mode ob-t', side);
      this.elPips = make('div', 'ob-pips', a);
      setText(this.elWName, this.weaponName);
      setText(this.elCur, String(this.ammo));
      setText(this.elRes, '/ ' + this.reserve);
      setText(this.elMode, this.fireMode);
      this._buildPips(this.magSize);
    }

    // Pips are only rebuilt when the magazine size changes; per-shot updates
    // toggle a class, which never touches layout.
    _buildPips(count) {
      count = M.clamp(Math.round(count) || 0, 0, 60);
      if (count === this._pipCount || !this.elPips) return;
      this._pipCount = count;
      this.elPips.textContent = '';
      this._pips = [];
      for (var i = 0; i < count; i++) this._pips.push(make('div', 'ob-pip', this.elPips));
    }

    // -----------------------------------------------------------------------
    // Event wiring - everything optional, everything guarded.
    // -----------------------------------------------------------------------
    _bindBus(ctx) {
      var bus = (ctx && ctx.bus) || GAME.bus;
      if (!bus || !bus.on) return;
      var self = this;
      var safe = function (fn) {
        return function (a, b, c) {
          try { fn(a, b, c); } catch (e) { self._fail('hud.event', e); }
        };
      };
      bus.on('weapon:fire', safe(function () { self.onShotFired(); }));
      bus.on('weapons:fire', safe(function () { self.onShotFired(); }));
      bus.on('shot', safe(function () { self.onShotFired(); }));
      bus.on('hud:hitmarker', safe(function (kind) { self.showHitmarker(kind); }));
      bus.on('player:damage', safe(function (amount, dir) { self.damageIndicator(dir); }));
      bus.on('player:hit', safe(function (amount, dir) { self.damageIndicator(dir); }));
      bus.on('kill', safe(function (a, b, w) { self.addKillfeed(a, b, w); }));
      bus.on('enemy:killed', safe(function (a, b, w) { self.addKillfeed(a || 'YOU', b, w); }));
      bus.on('ai:fire', safe(function (e) { self._flagThreat(e); }));
      bus.on('enemy:fire', safe(function (e) { self._flagThreat(e); }));
      bus.on('objective:add', safe(function (o) {
        if (o) self.addObjective(o.id, o.position, o.label, o.kind);
      }));
      bus.on('objective:remove', safe(function (id) { self.removeObjective(id); }));
    }

    _fail(where, e) {
      // A HUD that spams the error log every frame is worse than a broken HUD;
      // report the first few then go quiet.
      if (this._errs < 5) { this._errs++; GAME.logError(where, e); }
    }

    // The one place layout is read. Never call this from inside the frame loop
    // on a whim - read-after-write is what turns a smooth HUD into a stutter.
    _measure() {
      if (!this.root) return;
      this.W = this.root.clientWidth || window.innerWidth || 1920;
      this.H = this.root.clientHeight || window.innerHeight || 1080;
      // getComputedStyle on an unregistered custom property hands back the raw
      // token stream ("clamp(9.5px,1.25vmin,19px)"), not a resolved length, so
      // the value has to be measured off a probe element that consumes it.
      var u = 0;
      if (this.elProbe) u = this.elProbe.getBoundingClientRect().width;
      this.unit = (u && u > 0)
        ? u
        : M.clamp(Math.min(this.W, this.H) * 0.0125, 9.5, 19);
      this._applyMetrics();
    }

    // Everything that has to sit on an exact device pixel is derived here, once
    // per resize, and published as px-valued custom properties. `--u` is a
    // fractional length (9.5px at 720p), so anything sized directly off it -
    // a 1px tick, a 2.66px ammo pip - lands on a different sub-pixel phase for
    // every instance and the row renders as an uneven barcode. That ragged look
    // is a large part of why HUD furniture reads as "slightly soft".
    _applyMetrics() {
      var root = this.root;
      if (!root) return;
      var u = this.unit;
      setVar(root, '--ctw', qpx(u * 0.20, 2));   // tick width
      setVar(root, '--cth', qpx(u * 0.46, 4));   // minor tick height
      setVar(root, '--cthm', qpx(u * 0.86, 7));  // major tick height
      setVar(root, '--ctb', qpx(u * 0.50, 4));   // tick baseline offset
      setVar(root, '--pipw', qpx(u * 0.30, 2));
      setVar(root, '--piph', qpx(u * 0.85, 6));
      setVar(root, '--pipg', qpx(u * 0.16, 2));

      // Whole pixels per degree, so the tape scrolls in integer steps and every
      // tick keeps its exact column instead of shimmering between two.
      this._cmpPPD = COMPASS_PPD * u;
      setStyle(this.elCompass, 'width', qpx(u * 42, 40));
      setStyle(this.elCScrim, 'width', qpx(u * 54, 52));
      var tape = this._ctape;
      if (tape) {
        for (var i = 0; i < tape.length; i++) {
          setStyle(tape[i].el, 'left', qpx(tape[i].deg * this._cmpPPD, -1e9));
        }
      }
    }

    resize() {
      try {
        this._measure();
        this._remeasure = 0.25;
      } catch (e) { this._fail('hud.resize', e); }
    }

    // If nobody published objectives, place one at the far end of the market
    // street (the level runs along -Z) so the waypoint system has something
    // real to track instead of sitting dormant.
    _seedObjectives() {
      var ctx = this.ctx;
      var lvl = ctx && ctx.level;
      var given = lvl && (lvl.objectives || lvl.waypoints);
      if (given && given.length) {
        for (var i = 0; i < given.length && i < 4; i++) {
          var o = given[i];
          var p = o.position || o.point || o;
          if (p && p.x !== undefined) {
            this.addObjective(o.id || ('obj' + i), p, o.label || String.fromCharCode(65 + i), 'objective');
          }
        }
        return;
      }
      // Deliberately OFF the street's centre line and above eye level. Parked
      // dead ahead at eye height it landed exactly on the reticle, where the
      // point-of-aim fade correctly drives it to zero opacity - so the waypoint
      // system was invisible in every single hero framing. East side, first
      // floor, far end of the market reads as a real objective and still leaves
      // the point of aim completely clear.
      this.addObjective('primary', new THREE.Vector3(5.6, 4.2, -34), 'A', 'objective');
    }

    // =======================================================================
    // PUBLIC API
    // =======================================================================

    setVisible(v) {
      this.visible = !!v;
      if (this.root) setClass(this.root, 'ob-hidden', !this.visible);
    }

    // kind: 'hit' | 'headshot' | 'kill'
    showHitmarker(kind) {
      try {
        kind = (kind === 'headshot' || kind === 'kill') ? kind : 'hit';
        // A fresh marker always restarts the pop - stacking hits should feel
        // like a machine gun, not like one long smear.
        this.hitKind = kind;
        this.hitTimer = 0;
        this.state.hitFlash = kind === 'kill' ? 1 : (kind === 'headshot' ? 0.75 : 0.5);
        if (kind === 'headshot') this.addScore(50, 'Headshot');
        if (kind === 'kill') {
          this.addScore(100, 'Eliminated');
          this._registerStreak();
          // Give another module a beat to supply real names; if none arrives,
          // synthesise the entry from what we do know.
          this._pendingKill = 0.18;
        }
      } catch (e) { this._fail('hud.showHitmarker', e); }
    }

    // Accepts 0..1 or 0..100. The scale is latched the first time a value
    // above 1 shows up, so a health system using either convention works.
    setHealth(v) {
      try {
        if (typeof v !== 'number' || v !== v) return;
        if (v > 1.001) this.healthScale = 100;
        var f = M.saturate(v / this.healthScale);
        var drop = this.health - f;
        if (drop > 0.002) this.damageFlash = M.saturate(this.damageFlash + drop * 2.2 + 0.12);
        this.health = f;
        this._healthStamp = this.time;
      } catch (e) { this._fail('hud.setHealth', e); }
    }

    setAmmo(cur, reserve) {
      try {
        if (typeof cur === 'number' && cur === cur) {
          if (cur < this.ammo) this.onShotFired();
          this.ammo = Math.max(0, Math.round(cur));
          if (this.ammo > this.magSize) this.magSize = this.ammo;
        }
        if (typeof reserve === 'number' && reserve === reserve) {
          this.reserve = Math.max(0, Math.round(reserve));
        }
        this._ammoStamp = this.time;
      } catch (e) { this._fail('hud.setAmmo', e); }
    }

    // Optional extra so the weapon system can publish the rest of the block.
    setWeaponInfo(name, magSize, fireMode) {
      try {
        if (name) this.weaponName = sanitizeName(name, 18) || 'CARBINE';
        if (typeof magSize === 'number' && magSize > 0) this.magSize = Math.round(magSize);
        if (fireMode) this.fireMode = sanitizeName(fireMode, 8);
      } catch (e) { this._fail('hud.setWeaponInfo', e); }
    }

    addKillfeed(a, b, weapon) {
      try {
        this._pendingKill = -1;
        var head = false;
        var wname = weapon;
        if (weapon && typeof weapon === 'object') {
          head = !!(weapon.headshot || weapon.head);
          wname = weapon.name || weapon.weapon || '';
        }
        var entry = {
          a: sanitizeName(a, 14) || 'UNKNOWN',
          b: sanitizeName(b, 14) || 'UNKNOWN',
          kind: glyphKind(wname),
          head: head,
          age: 0,
          el: null
        };
        entry.mine = (entry.a === 'YOU' || entry.a === 'PLAYER');
        this.kills.unshift(entry);
        while (this.kills.length > KILLFEED_MAX) {
          var drop = this.kills.pop();
          this._releaseKF(drop);
        }
        this._mountKF(entry);
      } catch (e) { this._fail('hud.addKillfeed', e); }
    }

    // worldDirection: a THREE.Vector3 (or any {x,y,z}) pointing from the player
    // toward whatever hurt them.
    damageIndicator(worldDirection) {
      try {
        var ang = 0;
        if (worldDirection && worldDirection.x !== undefined) {
          _v1.set(worldDirection.x || 0, worldDirection.y || 0, worldDirection.z || 0);
          if (_v1.lengthSq() > 1e-8) ang = this._screenAngle(_v1);
        }
        // Merge with a very recent indicator from nearly the same bearing so a
        // burst of fire reads as one sustained arc instead of six stacked ones.
        for (var i = 0; i < this.damages.length; i++) {
          var d = this.damages[i];
          if (Math.abs(M.wrapAngle(d.angle - ang)) < 0.35 && d.age < 0.4) {
            d.age = 0; d.strength = Math.min(1, d.strength + 0.35);
            return;
          }
        }
        if (this.damages.length >= DAMAGE_POOL) this._releaseDamage(this.damages.length - 1);
        var el = this._pools.dmg[this.damages.length];
        if (!el) return;
        this.damages.push({ angle: ang, age: 0, strength: 0.75, el: el });
        setStyle(el, 'display', 'block');
      } catch (e) { this._fail('hud.damageIndicator', e); }
    }

    addScore(value, label, streak) {
      try {
        var el = null;
        for (var i = 0; i < this._pools.pop.length; i++) {
          if (!this._pools.pop[i].__busy) { el = this._pools.pop[i]; break; }
        }
        if (!el) {
          // recycle the oldest
          var oldest = this.popups.shift();
          if (!oldest) return;
          el = oldest.el;
        }
        el.__busy = true;
        // push everything already on screen up one line
        for (var j = 0; j < this.popups.length; j++) this.popups[j].y0 -= 1.55;
        setText(el.__v, (value >= 0 ? '+' : '') + Math.round(value));
        setText(el.__k, sanitizeName(label, 18));
        setClass(el, 'streak', !!streak);
        setStyle(el, 'display', 'block');
        // A hair of seeded horizontal scatter: a burst of callouts stacked in a
        // perfectly rigid column is one of those small tells that reads as UI
        // rather than as part of the moment.
        this.popups.push({ el: el, age: 0, y0: 0, jx: this.rng.range(-0.55, 0.55) });
      } catch (e) { this._fail('hud.addScore', e); }
    }

    addObjective(id, position, label, kind) {
      try {
        if (!position || position.x === undefined) return;
        this.removeObjective(id);
        this.objectives.push({
          id: id || ('obj' + this.objectives.length),
          position: new THREE.Vector3(position.x, position.y, position.z),
          label: sanitizeName(label, 10) || 'OBJ',
          kind: kind || 'objective'
        });
      } catch (e) { this._fail('hud.addObjective', e); }
    }

    removeObjective(id) {
      for (var i = this.objectives.length - 1; i >= 0; i--) {
        if (this.objectives[i].id === id) this.objectives.splice(i, 1);
      }
    }

    // Called whenever a round leaves the barrel; drives crosshair bloom.
    onShotFired() {
      this.bloom = Math.min(1, this.bloom + 0.34);
      this._fireFlash = 1;
    }

    // =======================================================================
    // FRAME
    // =======================================================================
    update(dt, ctx) {
      if (!this.built || !this.root) return;
      ctx = ctx || this.ctx;
      if (typeof dt !== 'number' || dt !== dt) dt = 0;
      dt = M.clamp(dt, 0, 0.1);
      this.time += dt;
      if (!this.visible) return;
      try {
        // One deferred re-measure: build() can run before the browser has done
        // its first layout pass, which would leave `unit` on its fallback.
        if (this._remeasure > 0) {
          this._remeasure -= dt;
          if (this._remeasure <= 0) { this._remeasure = 0; this._measure(); }
        }
        this._readSystems(dt, ctx);
        this._updateCrosshair(dt, ctx);
        this._updateHitmarker(dt);
        this._updateHealth(dt, ctx);
        this._updateDamage(dt);
        this._updateAmmo(dt);
        this._updateReload(dt);
        this._updateKillfeed(dt);
        this._updateCompass(dt, ctx);
        this._updateMarkers(dt, ctx);
        this._updatePopups(dt);
      } catch (e) {
        this._fail('hud.update', e);
      }
    }

    // ---- gather everything the HUD needs from other systems ----------------
    _readSystems(dt, ctx) {
      if (!ctx) return;
      var p = ctx.player;
      var w = ctx.weapons;

      // --- player ---------------------------------------------------------
      var speed = 0;
      if (p) {
        if (typeof p.speed === 'number') speed = p.speed;
        else if (p.velocity) {
          speed = Math.sqrt(p.velocity.x * p.velocity.x + p.velocity.z * p.velocity.z);
        }
        var ph = p.health;
        if (typeof ph === 'number' && ph === ph && this.time - this._healthStamp > 0.2) {
          var maxH = pick(p, ['maxHealth', 'healthMax'], null);
          if (maxH && maxH > 1) this.healthScale = maxH;
          else if (ph > 1.001) this.healthScale = 100;
          var f = M.saturate(ph / this.healthScale);
          var drop = this.health - f;
          if (drop > 0.002) this.damageFlash = M.saturate(this.damageFlash + drop * 2.2 + 0.1);
          this.health = f;
        }
      }
      // Sprint/strafe opens the crosshair; standing still closes it.
      this.moveAmount = M.damp(this.moveAmount, M.saturate(speed / 6.5), 9, dt);

      var ads = false;
      if (w) ads = !!pick(w, ['isADS', 'ads', 'aiming', 'isAiming'], false);
      if (!ads && p) ads = !!pick(p, ['isADS', 'ads', 'aiming'], false);
      if (w && w.forceADS) ads = true;
      // A damped boolean is only the fallback. When the weapon system publishes
      // its own eased aim blend, ride that instead: the reticle then leaves on
      // exactly the curve and duration the sights come up on, which is the
      // difference between "the crosshair went away" and "the crosshair
      // flickered off a moment before the optic arrived".
      this._adsFlag = M.damp(this._adsFlag, ads ? 1 : 0, 13, dt);
      var adsE = pick(w, ['adsEase', 'adsBlend', 'adsT'], null);
      if (typeof adsE !== 'number' || adsE !== adsE) adsE = pick(p, ['adsEase', 'adsT'], null);
      // max(), not a straight swap: if a published blend is ever stale or zero
      // while ADS is genuinely engaged, the safe failure is a hidden reticle,
      // never a second one stamped over the optic.
      this.adsAmount = (typeof adsE === 'number' && adsE === adsE)
        ? Math.max(this._adsFlag, M.saturate(adsE))
        : this._adsFlag;

      // --- weapon ----------------------------------------------------------
      if (w) {
        var cur = w.current || w.weapon || w.active || null;
        var nm = pick(cur, ['displayName', 'label', 'name'], null) ||
                 pick(w, ['weaponName'], null);
        if (nm) {
          var clean = sanitizeName(nm, 18);
          if (clean) this.weaponName = clean;
        }
        var mag = pick(cur, ['magSize', 'magazine', 'clipSize', 'capacity'], null);
        if (typeof mag === 'number' && mag > 0) this.magSize = Math.round(mag);

        if (this.time - this._ammoStamp > 0.25) {
          var a = pick(cur, ['ammo', 'magAmmo', 'rounds', 'inMag', 'loaded'], null);
          if (a === null) a = pick(w, ['ammo'], null);
          if (typeof a === 'number' && a === a) {
            var ai = Math.max(0, Math.round(a));
            // Detecting the decrement is the module-agnostic way to know a shot
            // was fired even if nobody emits an event for it.
            if (ai < this._lastAmmoSeen) this.onShotFired();
            this.ammo = ai;
          }
          var r = pick(cur, ['reserve', 'reserveAmmo', 'spare', 'stock', 'pool'], null);
          if (r === null) r = pick(w, ['reserve'], null);
          if (typeof r === 'number' && r === r) this.reserve = Math.max(0, Math.round(r));
        }
        this._lastAmmoSeen = this.ammo;

        var fm = pick(cur, ['fireMode', 'mode'], null) || pick(w, ['fireMode'], null);
        if (!fm) {
          var auto = pick(cur, ['auto', 'automatic', 'fullAuto'], null);
          if (auto !== null) fm = auto ? 'AUTO' : 'SEMI';
        }
        if (fm) {
          var fmc = sanitizeName(fm, 8);
          if (fmc) this.fireMode = fmc;
        }

        this.reloading = !!pick(w, ['reloading', 'isReloading'], false) ||
                         !!pick(cur, ['reloading', 'isReloading'], false);
        var prog = pick(w, ['reloadProgress'], null);
        if (prog === null) {
          var tmr = pick(w, ['reloadTimer', 'reloadElapsed'], null);
          var dur = pick(w, ['reloadDuration', 'reloadTime'], null) ||
                    pick(cur, ['reloadDuration', 'reloadTime'], null);
          if (typeof tmr === 'number' && typeof dur === 'number' && dur > 0) {
            // Some weapon systems count the timer down to zero, others count
            // elapsed time up. Watch which way it moves rather than guessing -
            // guessing wrong runs the progress arc backwards.
            if (this._prevReloadTimer !== undefined && this.reloading) {
              if (tmr > this._prevReloadTimer + 1e-6) this._reloadCountsUp = true;
              else if (tmr < this._prevReloadTimer - 1e-6) this._reloadCountsUp = false;
            }
            this._prevReloadTimer = tmr;
            prog = this._reloadCountsUp ? M.saturate(tmr / dur) : M.saturate(1 - tmr / dur);
          }
        }
        if (typeof prog === 'number' && prog === prog) {
          this.reloadProgress = M.saturate(prog);
        } else if (this.reloading) {
          // No progress published - advance a plausible 2.1s reload ourselves so
          // the arc still animates rather than sitting frozen.
          this.reloadProgress = M.saturate(this.reloadProgress + dt / 2.1);
        } else {
          this.reloadProgress = 0;
        }

        // spread/bloom, in whatever unit the weapon system publishes
        var sp = pick(w, ['spread', 'bloom', 'currentSpread'], null);
        if (sp === null) sp = pick(cur, ['spread', 'bloom'], null);
        if (typeof sp === 'number' && sp === sp) {
          // Normalise: radians (<0.3), degrees (<25) or an explicit 0..1 factor
          // all end up as a sane 0..1 crosshair drive.
          var norm = sp <= 0.35 ? sp / 0.09 : (sp <= 25 ? sp / 5 : sp / 100);
          this.weaponSpread = M.clamp(norm, 0, 2.2);
        } else {
          this.weaponSpread = 0;
        }
      } else {
        this.weaponSpread = 0;
        this.reloading = false;
      }

      // decay transient drives
      this.bloom = Math.max(0, this.bloom - dt * 2.6);
      this._fireFlash = Math.max(0, this._fireFlash - dt * 6);

      if (this._pendingKill > 0) {
        this._pendingKill -= dt;
        if (this._pendingKill <= 0) {
          this._pendingKill = -1;
          this.addKillfeed('YOU', 'HOSTILE', this.weaponName);
        }
      }

      this._scanThreats(dt, ctx);
    }

    // ---- crosshair ---------------------------------------------------------
    _updateCrosshair(dt, ctx) {
      var g = 0.86;                              // resting gap, in `--u`
      g += this.moveAmount * 1.05;               // movement bloom
      g += this.bloom * 1.15;                    // firing bloom
      g += (this.weaponSpread || 0) * 1.15;      // weapon's own spread
      if (this.reloading) g += 0.55;
      // Hard ceiling. Measured on firefight.png the gap reached ~2.6u while the
      // arms were only 0.98u long, so the reticle stopped reading as a cross and
      // became four unrelated dashes floating around the point of aim. Bloom has
      // to stay legible as one shape or it stops communicating anything.
      g = Math.min(g, 2.5);
      g *= (1 - this.adsAmount * 0.72);          // ADS tightens hard

      // Damped rather than snapped: the eye reads a snapping crosshair as a bug.
      this.gap = M.damp(this.gap, g, 16, dt);

      // ADS: the optic IS the aiming reference. The hipfire cross has to be
      // gone, not faint. Fading it to a few percent is not enough - each
      // segment carries a 1px black outline plus a 5px black glow, four of them
      // stack at the centre, and against a blown-out red dot that residue still
      // resolves as a hard cross (measured: a warm 252,233,213 dot going neutral
      // 220,222,217 under the arms, i.e. a teal cross over the sight picture).
      // So: fade out over the first ~60% of the aim blend, then stop rendering
      // the element entirely.
      var f = M.saturate(1 - this.adsAmount * 1.7);
      var fade = f * f * (3 - 2 * f);            // smoothstep - leaves cleanly
      var gone = fade <= 0.002;

      if (gone !== this._crossHidden) {
        this._crossHidden = gone;
        setStyle(this.elCross, 'display', gone ? 'none' : 'block');
      }
      if (gone) return;                          // nothing rendered, nothing to drive

      // Arms grow with the gap, not independently of it: the ratio of arm length
      // to stand-off is what the eye uses to read the shape, and holding the arm
      // fixed while the gap doubles is what breaks it apart.
      var len = 0.95 + Math.max(0, this.gap - 0.86) * 0.46;
      var op = 0.86 * fade * (1 - 0.25 * this._fireFlash);
      var dotOp = 0.9 * fade;

      setVar(this.root, '--chg', n2(this.gap));
      setVar(this.root, '--chl', n2(len));
      setVar(this.root, '--cho', n2(M.saturate(op)));
      setVar(this.root, '--dot', n2(M.saturate(dotOp)));
    }

    // ---- hitmarker ---------------------------------------------------------
    _updateHitmarker(dt) {
      if (this.hitTimer < 0) {
        setVar(this.elHit, '--hmo', '0');
        return;
      }
      this.hitTimer += dt;
      var t = M.saturate(this.hitTimer / HITMARKER_TIME);
      if (t >= 1) {
        this.hitTimer = -1;
        setVar(this.elHit, '--hmo', '0');
        return;
      }
      // pop in fast, scale outward, fade on an ease-out so it feels struck
      var ease = 1 - Math.pow(1 - t, 2.4);
      var scale = 0.55 + ease * 0.85;
      var alpha = Math.pow(1 - t, 1.5);
      var kind = this.hitKind;
      var col = '255,255,255';
      var thick = 0.16, len = 0.6, gap = 0.5;
      if (kind === 'headshot') { col = '255,196,86'; thick = 0.185; len = 0.66; }
      else if (kind === 'kill') { col = '255,64,44'; thick = 0.26; len = 0.78; gap = 0.55; }

      setVar(this.elHit, '--hmc', col);
      setVar(this.elHit, '--hmt', n2(thick));
      setVar(this.elHit, '--hml', n2(len));
      setVar(this.elHit, '--hmg', n2(gap + ease * 0.16));
      setVar(this.elHit, '--hms', n2(scale));
      setVar(this.elHit, '--hmo', n2(alpha));
    }

    // ---- health / vignette / heartbeat --------------------------------------
    _updateHealth(dt, ctx) {
      // Modern regenerating-health treatment: no bar, the screen tells you.
      this.damageFlash = Math.max(0, this.damageFlash - dt * 1.15);
      var missing = 1 - this.health;

      // Base vignette from missing health, plus a fast spike on each hit.
      // Capped well short of opaque: at 0.92 the blotches closed over roughly
      // half the frame and the whole render went red-brown, which destroys the
      // grade the rest of the build is chasing. Near-death has to be legible as
      // damage, not as a colour filter over the game.
      var vig = M.smoothstep(0.16, 0.92, missing) * 0.78 + this.damageFlash * 0.55;
      var crit = M.smoothstep(0.62, 0.9, missing);       // health below ~38%
      this.critAmount = M.damp(this.critAmount, crit, 6, dt);

      // Heartbeat: rate climbs as health falls. A double-thump (lub-dub) reads
      // far more like a pulse than a plain sine.
      var bpm = 62 + this.critAmount * 78;
      this.beatPhase += dt * (bpm / 60);
      if (this.beatPhase > 1) this.beatPhase -= Math.floor(this.beatPhase);
      var ph = this.beatPhase;
      var beat = Math.exp(-Math.pow((ph - 0.06) / 0.055, 2)) +
                 0.62 * Math.exp(-Math.pow((ph - 0.24) / 0.06, 2));
      beat = M.saturate(beat);

      var bloodOp = Math.min(0.86, M.saturate(vig + this.critAmount * beat * 0.18));
      setStyle(this.elBlood, 'opacity', n2(bloodOp));
      setStyle(this.elCrit, 'opacity', n2(this.critAmount * (0.2 + beat * 0.58)));

      // Publish for postfx (desaturation + pulse are its job, not the DOM's).
      var st = this.state;
      st.health = this.health;
      st.damage = this.damageFlash;
      st.critical = this.critAmount;
      st.heartbeat = beat * this.critAmount;
      st.desaturation = this.critAmount * 0.78;
      st.bloodVignette = bloodOp;
      st.hitFlash = Math.max(0, st.hitFlash - dt * 5.5);
      st.lowAmmo = this.magSize > 0 ? M.saturate(1 - this.ammo / this.magSize) : 0;
    }

    // ---- directional damage indicators --------------------------------------
    _updateDamage(dt) {
      for (var i = this.damages.length - 1; i >= 0; i--) {
        var d = this.damages[i];
        d.age += dt;
        var t = d.age / DAMAGE_TIME;
        if (t >= 1) { this._releaseDamage(i); continue; }
        // hold briefly at full strength, then fall away
        var a = d.strength * (t < 0.18 ? M.smoothstep(0, 0.18, t) : Math.pow(1 - (t - 0.18) / 0.82, 1.7));
        var push = 1 + (1 - M.saturate(t * 4)) * 0.07;   // small outward kick
        setStyle(d.el, 'opacity', n2(M.saturate(a)));
        setStyle(d.el, 'transform',
          'rotate(' + n2(d.angle * 57.2957795) + 'deg) scale(' + n2(push) + ')');
      }
    }

    _releaseDamage(i) {
      var d = this.damages[i];
      if (!d) return;
      setStyle(d.el, 'opacity', '0');
      setStyle(d.el, 'display', 'none');
      this.damages.splice(i, 1);
      // keep the pool packed so index == element stays valid
      for (var j = 0; j < this.damages.length; j++) {
        var el = this._pools.dmg[j];
        if (this.damages[j].el !== el) {
          setStyle(this.damages[j].el, 'display', 'none');
          this.damages[j].el = el;
          setStyle(el, 'display', 'block');
        }
      }
    }

    // ---- ammo ---------------------------------------------------------------
    _updateAmmo(dt) {
      setText(this.elWName, this.weaponName);
      setText(this.elCur, String(this.ammo));
      setText(this.elRes, '/ ' + this.reserve);
      setText(this.elMode, this.fireMode);

      var frac = this.magSize > 0 ? M.saturate(this.ammo / this.magSize) : 1;
      this._buildPips(this.magSize);
      if (this._pips && this._pips.length) {
        // For magazines larger than the pip cap each pip stands for several
        // rounds, so drive the strip off the fraction, not the raw count.
        var lit = this.ammo <= 0 ? 0 : Math.max(1, Math.ceil(frac * this._pips.length));
        for (var i = 0; i < this._pips.length; i++) {
          setClass(this._pips[i], 'on', i < lit);
        }
      }

      var empty = this.ammo <= 0;
      var low = !empty && frac <= 0.3;
      setClass(this.elAmmo, 'low', low);
      setClass(this.elAmmo, 'empty', empty);

      // A restrained pulse: enough to catch peripheral vision, not enough to
      // strobe. Driven numerically so it survives headless capture.
      var pulse = 1;
      if (empty) pulse = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(this.time * 9.5));
      else if (low) pulse = 0.82 + 0.18 * (0.5 + 0.5 * Math.sin(this.time * 5.2));
      setStyle(this.elCur, 'opacity', n2(pulse));
    }

    // ---- reload arc + prompt -------------------------------------------------
    _updateReload(dt) {
      var showArc = this.reloading && this.reloadProgress < 0.999;
      setStyle(this.elArc, 'opacity', showArc ? '1' : '0');
      if (showArc) {
        var off = this._arcLen * (1 - this.reloadProgress);
        var s = n2(off);
        if (this.elArcFg.__d !== s) {
          this.elArcFg.__d = s;
          this.elArcFg.setAttribute('stroke-dashoffset', s);
        }
      }

      var needReload = !this.reloading && this.reserve > 0 &&
        (this.ammo <= 0 || (this.magSize > 0 && this.ammo / this.magSize <= 0.25));
      var promptOp = 0;
      if (needReload) {
        var urgent = this.ammo <= 0;
        promptOp = (urgent ? 0.95 : 0.6) *
          (0.7 + 0.3 * (0.5 + 0.5 * Math.sin(this.time * (urgent ? 6.4 : 3.2))));
        setText(this.elPromptLbl, urgent ? 'Reload' : 'Low Ammo');
      }
      setStyle(this.elPrompt, 'opacity', n2(promptOp));
    }

    // ---- killfeed -------------------------------------------------------------
    _mountKF(entry) {
      var el = null;
      for (var i = 0; i < this._pools.kf.length; i++) {
        if (!this._pools.kf[i].__busy) { el = this._pools.kf[i]; break; }
      }
      if (!el) return;
      el.__busy = true;
      entry.el = el;
      setText(el.__a, entry.a);
      setText(el.__b, entry.b);
      setClass(el.__a, 'me', entry.mine);
      var html = glyphSVG(entry.kind) + (entry.head ? SKULL_SVG : '');
      if (el.__ic.__html !== html) { el.__ic.__html = html; el.__ic.innerHTML = html; }
      el.__ic.style.display = 'flex';
      el.__ic.style.alignItems = 'center';
      el.__ic.style.gap = '0.35em';
      // newest on top
      if (this.elKF.firstChild) this.elKF.insertBefore(el, this.elKF.firstChild);
      else this.elKF.appendChild(el);
    }

    _releaseKF(entry) {
      if (!entry || !entry.el) return;
      entry.el.__busy = false;
      setStyle(entry.el, 'opacity', '0');
      if (entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
      entry.el = null;
    }

    _updateKillfeed(dt) {
      for (var i = this.kills.length - 1; i >= 0; i--) {
        var k = this.kills[i];
        k.age += dt;
        if (k.age > KILLFEED_TIME + KILLFEED_FADE) {
          this._releaseKF(k);
          this.kills.splice(i, 1);
          continue;
        }
        if (!k.el) continue;
        var slide = k.age < 0.22 ? (1 - M.smootherstep(0, 0.22, k.age)) : 0;
        var a = 1;
        if (k.age > KILLFEED_TIME) a = 1 - (k.age - KILLFEED_TIME) / KILLFEED_FADE;
        setStyle(k.el, 'opacity', n2(M.saturate(a)));
        setStyle(k.el, 'transform', 'translate3d(' + n2(slide * 26) + 'px,0,0)');
      }
    }

    // ---- compass --------------------------------------------------------------
    _updateCompass(dt, ctx) {
      var yaw = 0;
      if (ctx && ctx.player && typeof ctx.player.yaw === 'number') yaw = ctx.player.yaw;
      else if (ctx && ctx.camera) yaw = ctx.camera.rotation.y;
      // yaw 0 looks down -Z which we call north; +yaw swings the view west.
      var deg = (-yaw * 57.2957795) % 360;
      if (deg < 0) deg += 360;
      this.heading = deg;

      // Whole-pixel scroll. Sub-pixel scrolling of a hairline tape is what makes
      // it crawl and shimmer; 1px is 0.35 degrees here, far below anything the
      // eye can read off a compass.
      setVar(this.elCTrack, '--cmp', qpx(-deg * this._cmpPPD, -1e9));
      var h = Math.round(deg) % 360;
      setText(this.elHeading, (h < 100 ? (h < 10 ? '00' : '0') : '') + h);
    }

    // ---- threats --------------------------------------------------------------
    _flagThreat(e) {
      if (!e) return;
      var pos = e.position || (e.root && e.root.position) || (e.isVector3 ? e : null);
      if (!pos || pos.x === undefined) return;
      var id = e.id !== undefined ? e.id : (e.uuid || pos);
      var t = this._threats.get(id);
      if (t) { t.ttl = THREAT_TIME; t.position.copy(pos); }
      else this._threats.set(id, { position: new THREE.Vector3(pos.x, pos.y, pos.z), ttl: THREAT_TIME });
    }

    // Only enemies that are actually shooting become threat markers - a HUD
    // that paints every enemy is a wallhack, not a HUD.
    _scanThreats(dt, ctx) {
      var it, k;
      for (it = this._threats.entries(), k = it.next(); !k.done; k = it.next()) {
        k.value[1].ttl -= dt;
        if (k.value[1].ttl <= 0) this._threats.delete(k.value[0]);
      }
      var ai = ctx && ctx.ai;
      var list = ai && (ai.enemies || ai.agents);
      if (!list || !list.length) return;
      var now = (ctx && ctx.time) || this.time;
      for (var i = 0; i < list.length && i < 32; i++) {
        var e = list[i];
        if (!e) continue;
        if (e.dead || e.isDead || (typeof e.health === 'number' && e.health <= 0)) continue;
        var firing = !!(e.firing || e.isFiring || e.shooting || e.isShooting);
        if (!firing) {
          var lf = pick(e, ['lastFireTime', 'lastShotTime', 'lastFire'], null);
          if (typeof lf === 'number' && now - lf >= 0 && now - lf < 0.4) firing = true;
        }
        if (!firing) {
          var mf = pick(e, ['muzzleTimer', 'flashTimer'], null);
          if (typeof mf === 'number' && mf > 0) firing = true;
        }
        if (firing) {
          if (e.id === undefined) e.id = 'e' + i;
          this._flagThreat(e);
        }
      }
    }

    // ---- world -> screen markers ------------------------------------------------
    _updateMarkers(dt, ctx) {
      var cam = ctx && ctx.camera;
      var pool = this._pools.mk;
      if (!cam) {
        for (var z = 0; z < pool.length; z++) setStyle(pool[z], 'display', 'none');
        return;
      }
      // Build our own view-projection: during update() the renderer has not run
      // yet this frame, so camera.matrixWorldInverse may be one frame stale.
      cam.updateMatrixWorld();
      _mViewProj.copy(cam.projectionMatrix).multiply(_mTmp.copy(cam.matrixWorld).invert());
      _v2.setFromMatrixPosition(cam.matrixWorld);
      _v3.set(0, 0, -1).applyQuaternion(cam.quaternion);

      // Everything below works in viewport FRACTIONS, not pixels. Aspect comes
      // from the camera because that is what the image was framed with; the DOM
      // viewport can legitimately disagree (see the vw/vh note on .ob-mk).
      var W = this.W, H = this.H;
      this._aspect = (cam.aspect > 0.1 ? cam.aspect : (W / H)) || 1.7778;
      // Keep the icon and its label fully inside the frame when clamped.
      var marginX = Math.min(0.5 - (this.unit * 3.4) / W, 0.47);
      var marginY = Math.min(0.5 - (this.unit * 5.6) / H, 0.44);

      var slot = 0;
      var i;
      for (i = 0; i < this.objectives.length && slot < pool.length; i++) {
        this._drawMarker(pool[slot++], this.objectives[i].position,
          this.objectives[i].label, 'obj', marginX, marginY);
      }
      var it, k;
      for (it = this._threats.values(), k = it.next(); !k.done && slot < pool.length; k = it.next()) {
        this._drawMarker(pool[slot++], k.value.position, '', 'threat', marginX, marginY);
      }
      for (; slot < pool.length; slot++) {
        setStyle(pool[slot], 'display', 'none');
        if (pool[slot].__cmk) setStyle(pool[slot].__cmk, 'display', 'none');
      }
    }

    _drawMarker(el, pos, label, kind, marginX, marginY) {
      _v1.copy(pos);
      var dx = _v1.x - _v2.x, dy = _v1.y - _v2.y, dz = _v1.z - _v2.z;
      var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      var behind = (dx * _v3.x + dy * _v3.y + dz * _v3.z) <= 0.02;

      _v1.applyMatrix4(_mViewProj);
      var nx = _v1.x, ny = _v1.y;
      if (behind) {
        // Mirror through the centre and shove it well outside the frustum so
        // the clamp below always lands it on the correct screen edge.
        var l = Math.sqrt(nx * nx + ny * ny) || 1e-4;
        nx = -nx / l * 2.4; ny = -ny / l * 2.4;
      }
      // ox/oy are signed fractions of the viewport, -0.5 .. +0.5.
      var ox = nx * 0.5;
      var oy = -ny * 0.5;

      var scale = 1;
      if (Math.abs(ox) > marginX) scale = Math.min(scale, marginX / Math.abs(ox));
      if (Math.abs(oy) > marginY) scale = Math.min(scale, marginY / Math.abs(oy));
      var off = behind || scale < 0.999;
      ox *= scale; oy *= scale;

      setStyle(el, 'display', 'flex');
      setClass(el, 'threat', kind === 'threat');
      setClass(el, 'off', off);
      setVar(el, '--mx', n2((0.5 + ox) * 100));
      setVar(el, '--my', n2((0.5 + oy) * 100));

      // Threat pips read hot; objectives stay legible but quiet.
      var op = kind === 'threat' ? 0.92 : 0.8;
      // Fade a marker that sits right on the crosshair so it never fights it.
      // Distance is measured in units of viewport HEIGHT so it is aspect-correct.
      var near = Math.sqrt(ox * this._aspect * ox * this._aspect + oy * oy);
      var nearFar = (this.unit * 4.5) / this.H;
      if (!off && near < nearFar) {
        op *= M.smoothstep((this.unit * 1.6) / this.H, nearFar, near);
      }
      setStyle(el, 'opacity', n2(op));

      setText(el.__label, off ? '' : label);
      setText(el.__dist, (kind === 'threat' || off) ? '' : (Math.round(dist) + 'M'));
      if (off) {
        // Convert the fractional offset back to a square space before taking
        // the angle, or the arrow points wrong on any non-square viewport.
        var ang = Math.atan2(oy, ox * this._aspect) * 57.2957795 + 90;
        setStyle(el.__arrow, 'display', 'block');
        setStyle(el.__arrow, 'transform', 'rotate(' + n2(ang) + 'deg)');
      } else {
        setStyle(el.__arrow, 'display', 'none');
      }

      // matching tick on the compass strip
      if (el.__cmk) {
        var bearing = Math.atan2(dx, -dz) * 57.2957795;   // clockwise from north
        var delta = ((bearing - this.heading + 540) % 360) - 180;
        if (Math.abs(delta) > COMPASS_HALF_DEG) {
          setStyle(el.__cmk, 'display', 'none');
        } else {
          setStyle(el.__cmk, 'display', 'block');
          setClass(el.__cmk, 'threat', kind === 'threat');
          setVar(el.__cmk, '--b', qpx(delta * this._cmpPPD, -1e9));
          setStyle(el.__cmk, 'opacity',
            n2(M.smoothstep(COMPASS_HALF_DEG, COMPASS_HALF_DEG * 0.72, Math.abs(delta)) * 0.92 + 0.08));
        }
      }
    }

    // ---- score popups ------------------------------------------------------
    _updatePopups(dt) {
      for (var i = this.popups.length - 1; i >= 0; i--) {
        var p = this.popups[i];
        p.age += dt;
        var t = p.age / POPUP_TIME;
        if (t >= 1) {
          setStyle(p.el, 'display', 'none');
          setStyle(p.el, 'opacity', '0');
          p.el.__busy = false;
          this.popups.splice(i, 1);
          continue;
        }
        var rise = M.smootherstep(0, 1, t) * 2.1;              // in `--u`
        var pop = t < 0.12 ? 0.86 + 0.14 * (t / 0.12) : 1;     // small entry snap
        var a = t < 0.08 ? t / 0.08 : Math.pow(1 - (t - 0.08) / 0.92, 1.6);
        // Offsets stay in `--u` (the x offset lives in the stylesheet) so the
        // stack is parked clear of the crosshair at any resolution. The point
        // of aim is the one thing on screen a callout must never occlude.
        setStyle(p.el, 'opacity', n2(M.saturate(a)));
        setVar(p.el, '--px', n2(8.4 + (p.jx || 0)));
        setVar(p.el, '--py', n2(2.9 + p.y0 - rise));
        setVar(p.el, '--ps', n2(pop));
      }
    }

    _registerStreak() {
      // Kills inside 5s of each other chain into a multikill callout.
      if (this.time - this._streakTimer < 5) this._streak++;
      else this._streak = 1;
      this._streakTimer = this.time;
      var names = ['', '', 'Double Kill', 'Triple Kill', 'Multi Kill'];
      if (this._streak >= 2) {
        this.addScore(50 * this._streak, names[Math.min(this._streak, 4)], true);
      }
    }

    // ---- helpers -------------------------------------------------------------
    // Screen-space bearing of a world direction: 0 = dead ahead, +ve = to the
    // right. Used to aim the damage arcs.
    _screenAngle(dir) {
      var cam = this.ctx && this.ctx.camera;
      if (!cam) return 0;
      cam.updateMatrixWorld();
      var e = cam.matrixWorld.elements;
      var rx = e[0], ry = e[1], rz = e[2];      // camera right
      var fx = -e[8], fy = -e[9], fz = -e[10];  // camera forward
      var d = _v1.copy(dir).normalize();
      var right = d.x * rx + d.y * ry + d.z * rz;
      var fwd = d.x * fx + d.y * fy + d.z * fz;
      return Math.atan2(right, fwd);
    }

    dispose() {
      try {
        if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
        var st = document.getElementById('ob-hud-style');
        if (st && st.parentNode) st.parentNode.removeChild(st);
      } catch (e) { /* teardown must never throw */ }
      this.root = null;
      this.built = false;
    }
  }

  GAME.HUD = HUD;

})(window.GAME, window.THREE);
