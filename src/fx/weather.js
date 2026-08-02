// ============================================================================
// OPERATION BLACKOUT - src/fx/weather.js  ->  GAME.Weather
//
// Rain, storm and lightning for LEVEL 2 "COLD HARBOR". This module OWNS the
// weather contract; every other system reads it and nobody else writes it:
//
//   weather.wetness        0..1 global surface wetness
//   weather.rainIntensity  0..1
//   weather.windDir        THREE.Vector2, normalised (x = world X, y = world Z)
//   weather.windSpeed      m/s
//   weather.flash          0..1 lightning intensity THIS frame (0 most frames)
//   weather.flashDir       THREE.Vector3 pointing TOWARD the flash, i.e. the
//                          same convention as sky.sunDirection, so
//                          dot(normal, flashDir) is the lambert term
//   weather.fogDensity     the fog density the current storm implies
//   weather.setPreset(n)   'storm' | 'drizzle' | 'clear'
//   weather.strike()       force a lightning strike now (capture determinism)
//
// LEVEL 1 SAFETY. On any level that is not the harbor the preset is 'clear',
// and 'clear' is not merely quiet - it is *absent*. No geometry is generated,
// no texture is allocated, no light is created, nothing is added to the scene
// and no bus event is emitted. Resources are built lazily by _activate(), which
// only a wet preset ever calls. The market's frame cannot regress because this
// module is not in it.
//
// WHY THE RAIN IS WHAT IT IS
//   * Three camera-relative volumes (near / mid / far) rather than one. Depth
//     parallax is the entire difference between rain and a screensaver: near
//     drops are large, fast and soft-edged, far drops are small, slow and dim,
//     and because the three volumes wrap at different rates the field has real
//     motion parallax when you turn.
//   * Positions are computed ENTIRELY in the vertex shader from a fixed base
//     point plus an accumulated drift, wrapped with mod() against the volume.
//     A drop that leaves the box re-enters on the far side - that is the
//     recycling, and it costs zero CPU and zero allocation per frame.
//   * Streaks are stretched along the drop's VELOCITY (gravity + wind), not
//     along Y. Per-drop speed variance makes heavy drops fall steeper while
//     light ones blow further downwind: that spread of angles is the wind
//     shear, and it is what makes a downpour read as a storm instead of as a
//     screen full of parallel lines.
//   * Drops are lit by the eight nearest practicals every frame, with a real
//     cone test, so rain BRIGHTENS crossing a sodium pool and falls back to a
//     dim cold glint outside it. Without this the rain vanishes inside the
//     light cones, which is the most obvious tell there is.
//   * Soft-faded against a linearised copy of the previous frame's depth
//     buffer. We never sample postfx's depth texture directly during the scene
//     pass: it is bound to the active framebuffer and reading it forms a
//     feedback loop that ANGLE resolves by silently dropping the draw call.
//
// PERFORMANCE. Everything repeated is one InstancedBufferGeometry and one draw
// call: 3 rain volumes + splash rings + splash droplets + drips + mist + spray
// = 8 draw calls and ~35k triangles, plus two offscreen fullscreen passes
// (depth linearise, ripple normals). Nothing allocates after activation except
// the level raycasts used to find ground, which are capped at two per frame.
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  var M = GAME.Math;

  // Shared scratch. Nothing here survives a call boundary.
  var _v1 = new THREE.Vector3();
  var _v2 = new THREE.Vector3();
  var _v3 = new THREE.Vector3();
  var _v4 = new THREE.Vector3();
  var _c1 = new THREE.Color();
  var _size = new THREE.Vector2();
  var _box3 = new THREE.Box3();

  // --------------------------------------------------------------------------
  // Presets.
  //
  // `fog` IS THE VOLUME EXTINCTION COEFFICIENT, IN PER-METRE, and that unit is
  // the contract. It is the sigma in exp(-sigma * d): sky.js reads it straight
  // into fogDensityEffective (an exponential height fog), writes
  // scene.fog.density = sigma * 0.6 for three's FogExp2, and postfx derives its
  // volumetric raymarch density from that same scene.fog.density. One number,
  // three consumers, one unit - so it has to be a real extinction coefficient
  // and not a taste dial.
  //
  // Derived, not eyeballed. Meteorological visibility V (the 5% contrast
  // threshold) relates to extinction by Koschmieder: sigma = 3.912 / V.
  //   * Rain ALONE barely attenuates: sigma ~= 0.21 * R^0.74 km^-1, so even at
  //     R = 25 mm/h (heavy) that is only 0.0023 m^-1 - visibility over a km.
  //     Rain is loud and wet, it is not fog.
  //   * What actually closes a harbour down at 02:00 is the mist and spray the
  //     rain kicks up off the water and the apron, and that is a mist regime:
  //     V = 250-350 m, i.e. sigma = 0.011-0.016 m^-1.
  // 0.0145 m^-1 is V = 270 m. Over the 90 m set that is 73% transmittance at
  // 20 m and 27% at the far quay - genuine aerial depth on a scene this size.
  //
  // The value here was 0.0265 (V = 148 m, a bad sea fog), which at ultra came
  // back through sky.js and the volumetric pass as a flat orange lid that ate
  // the container canyon whole while the SAME pose at --quality low (no
  // volumetrics) was perfectly legible. A density that only looks right when
  // the atmosphere is switched off is the wrong density.
  // --------------------------------------------------------------------------
  var PRESETS = {
    clear: {
      rain: 0.0, wetness: 0.0, wind: 1.1, gust: 0.35, fog: 0.0045,
      lightning: 0, mist: 0.0, spray: 0.0, lens: 0.0
    },
    drizzle: {
      rain: 0.32, wetness: 0.62, wind: 3.6, gust: 1.1, fog: 0.0080,
      lightning: 0.35, mist: 0.40, spray: 0.35, lens: 0.30
    },
    storm: {
      rain: 1.0, wetness: 1.0, wind: 9.5, gust: 3.4, fog: 0.0145,
      lightning: 1, mist: 1.0, spray: 1.0, lens: 1.0
    }
  };

  // Published alongside fogDensity so a consumer never has to guess the unit or
  // re-derive the sight distance from it. Optional extras; nobody is required
  // to read them and every current consumer still uses fogDensity alone.
  function visibilityFor(sigma) {
    return (sigma > 1e-6) ? 3.912 / sigma : 1e6;
  }

  // ART_DIRECTION_HARBOR: lightning is cold ~7000K, #dceaff.
  var LIGHTNING_K = 7000;
  var MAX_LIGHTS = 8;
  var PROBE_CAP = 30;

  // ==========================================================================
  // GLSL: the practical-light sampler.
  // Shared verbatim by rain, splash, drip and mist so a drop, a splash ring and
  // a wisp of mist standing in the same lamp cone pick up the same colour.
  // It runs in the VERTEX stage - per-particle is ample spatial resolution and
  // it keeps the fragment cost at essentially nothing.
  // ==========================================================================
  var LIGHT_PARS = [
    'uniform vec4 uLightPos[' + MAX_LIGHTS + '];',  // xyz position, w range (0 = empty slot)
    'uniform vec4 uLightDir[' + MAX_LIGHTS + '];',  // xyz cone axis, w cos(outer) (<= -1 = omni)
    'uniform vec3 uLightCol[' + MAX_LIGHTS + '];',  // colour * intensity, pre-scaled
    '',
    'vec3 gbSampleLights(vec3 wp) {',
    '  vec3 acc = vec3(0.0);',
    '  for (int i = 0; i < ' + MAX_LIGHTS + '; i++) {',
    '    vec4 lp = uLightPos[i];',
    '    if (lp.w <= 0.0) continue;',
    '    vec3 d = lp.xyz - wp;',
    '    float dist2 = dot(d, d);',
    '    // Inverse-square with a soft core, so a drop passing through the bulb',
    '    // does not become one infinitely bright pixel.',
    '    float atten = 1.0 / (1.0 + dist2 / max(lp.w * lp.w, 0.01));',
    '    atten *= atten;',
    '    vec4 lc = uLightDir[i];',
    '    if (lc.w > -0.5) {',
    '      vec3 nd = d * inversesqrt(max(dist2, 1e-4));',
    '      float ca = dot(-nd, lc.xyz);',
    '      // Widen the cone: the visible shaft of a mast lamp in a downpour is',
    '      // always broader than the geometric spot angle.',
    '      float outer = clamp(lc.w - 0.10, -0.999, 0.999);',
    '      atten *= smoothstep(outer, mix(outer, 1.0, 0.45), ca);',
    '    }',
    '    acc += uLightCol[i] * atten;',
    '  }',
    '  return acc;',
    '}'
  ].join('\n');

  // Depth soft-fade, fragment stage. uSoft stays 0 until the depth copy is live.
  var SOFT_PARS = [
    'uniform sampler2D uDepth;',
    'uniform float uSoft;',
    'uniform vec2 uInvRes;',
    'float gbSoft(float viewZ, float dist) {',
    '  vec2 uvS = gl_FragCoord.xy * uInvRes;',
    '  float sceneZ = texture2D(uDepth, uvS).x;',
    '  float f = smoothstep(0.0, dist, sceneZ - viewZ);',
    '  return mix(1.0, f, uSoft);',
    '}'
  ].join('\n');

  // ==========================================================================
  // RAIN
  // ==========================================================================
  var RAIN_VERT = [
    'attribute vec3 aBase;',   // 0..1 inside the volume
    'attribute vec4 aRand;',   // x speed mul, y width mul, z brightness, w spare
    'uniform vec3 uCentre;',
    'uniform vec3 uBox;',
    'uniform vec3 uDrift;',
    'uniform vec3 uVel;',
    'uniform float uLen;',
    'uniform float uWidth;',
    'uniform float uPixelScale;',
    'uniform float uNearFade;',
    'uniform float uFarFade;',
    'uniform float uRain;',
    'uniform float uFlash;',
    'uniform vec3 uFlashCol;',
    'uniform vec3 uBaseCol;',
    'uniform vec3 uAirCol;',
    'uniform float uGain;',
    'uniform float uMaxPx;',
    'uniform float uSubpixFloor;',
    'uniform float uFogSigma;',
    'uniform vec2 uSheetDir;',
    'uniform float uSheetPhase;',
    'uniform vec4 uRoofRect;',   // xy world origin, zw 1/span
    'uniform float uRoofScale;',
    'uniform sampler2D uRoofMap;',
    // Identity for every world volume; the camera's matrixWorld for the
    // viewmodel volume, whose "world" is really camera-local space.
    'uniform mat4 uLightXf;',
    LIGHT_PARS,
    'varying vec2 vUv;',
    'varying vec3 vCol;',
    'varying float vAlpha;',
    'varying float vViewZ;',
    'void main() {',
    '  vUv = uv;',
    '  float sp = aRand.x;',
    '  // A heavy drop (sp > 1) falls faster and is blown LESS far; a light one',
    '  // lags and drifts. That spread of angles is the shear.',
    '  float wsc = 2.0 - sp;',
    '  vec3 base = aBase * uBox;',
    '  vec3 drift = vec3(uDrift.x * wsc, uDrift.y * sp, uDrift.z * wsc);',
    '  vec3 hb = uBox * 0.5;',
    '  vec3 world = uCentre + mod(base + drift - uCentre + hb, uBox) - hb;',
    '  vec3 wp = (uLightXf * vec4(world, 1.0)).xyz;',
    '',
    '  vec3 vel = vec3(uVel.x * wsc, uVel.y * sp, uVel.z * wsc);',
    '  vec4 vp = viewMatrix * vec4(world, 1.0);',
    '  float dist = max(-vp.z, 0.001);',
    '  vec3 vdir = (viewMatrix * vec4(vel, 0.0)).xyz;',
    '  float vl = length(vdir);',
    '  vdir = vl > 1e-5 ? vdir / vl : vec3(0.0, -1.0, 0.0);',
    '  vec3 toEye = normalize(-vp.xyz);',
    '  vec3 side = cross(vdir, toEye);',
    '  float sl = length(side);',
    '  side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);',
    '',
    '  // HOW MUCH LIGHT THIS DROP IS ACTUALLY STANDING IN. Sampled ONCE and',
    '  // spent three ways - colour, opacity and screen WIDTH - because a lit',
    '  // drop is not merely hotter, it is physically bigger on film, and width',
    '  // is the part that survives a tone curve. An additive colour term alone',
    '  // lands where the curve is already compressed (the lit apron sits three',
    '  // times higher than the dark between the pools) so an equal linear add',
    '  // prints three times SMALLER inside the cone than outside it, which is',
    '  // exactly backwards and is why the cone and the rain used to read as two',
    '  // unrelated effects that happened to overlap.',
    '  vec3 lightCol = gbSampleLights(wp);',
    '  float lit = min(dot(lightCol, vec3(0.2126, 0.7152, 0.0722)), 1.0);',
    '',
    '  float streak = uLen * (0.55 + 0.85 * sp);',
    '  // A 60-180 ms stroke freezes the drop into a SHORT dash. Shortening it on',
    '  // the flash (while widening and brightening it below) is the actual',
    '  // photographic signature of rain in lightning.',
    '  streak *= mix(1.0, 0.34, uFlash);',
    '  float wpp = dist * uPixelScale;',
    '  // SCREEN-SPACE CLAMP. A world-space streak length is a shutter speed, and',
    '  // close to the lens it stops being one: 0.5 m at 0.8 m from the eye is a',
    '  // 430 px slash, i.e. a 1/28 s exposure, and a game camera reads as',
    '  // 1/60-1/100. No drop may exceed uMaxPx pixels however close it gets.',
    '  streak = min(streak, uMaxPx * wpp);',
    '  // One pixel is the floor. A streak thinner than a texel stops existing',
    '  // under any resolve, which is exactly how distant rain disappears.',
    '  float minW = wpp * 1.15;',
    '  float wantW = uWidth * aRand.y;',
    '  float wid = max(wantW, minW);',
    '  // The sub-pixel dim is computed BEFORE the light/flash widening, so the',
    '  // compensation cannot divide out the very gain it is meant to survive.',
    '  float subpix = clamp(wantW / max(wid, 1e-5), uSubpixFloor, 1.0);',
    '  wid *= (1.0 + 1.15 * lit) * (1.0 + 0.85 * uFlash);',
    '  vp.xyz += vdir * (position.y * streak) + side * (position.x * wid);',
    '  gl_Position = projectionMatrix * vp;',
    '  vViewZ = dist;',
    '',
    '  // Fade toward the volume boundary so a drop that wraps does it out of',
    '  // sight instead of popping in the middle of the frame.',
    '  vec3 rel = (world - uCentre) / hb;',
    '  float edge = max(max(abs(rel.x), abs(rel.y)), abs(rel.z));',
    '  float a = 1.0 - smoothstep(0.66, 1.0, edge);',
    '  a *= smoothstep(uNearFade, uNearFade * 4.0, dist);',
    '  a *= mix(1.0, 1.0 - smoothstep(uFarFade * 0.45, uFarFade, dist), 0.85);',
    '  // Real extinction, same sigma the fog uses. Distant rain belongs IN the',
    '  // veil, not drawn crisply on top of it. At 0.6 sigma because uFarFade',
    '  // above is already fading the far end and the two would double-count.',
    '  a *= exp(-dist * uFogSigma * 0.6);',
    '  a *= uRain * uGain * (0.55 + 0.75 * aRand.z);',
    '  // The more a streak had to be widened to survive the resolve, the more',
    '  // it must dim - otherwise distant rain turns into a grey wash.',
    '  a *= subpix;',
    '  // SQUALL SHEETS. A world-anchored travelling wave downwind, so denser and',
    '  // thinner curtains advect through the terminal instead of the whole field',
    '  // dimming together. ~59 m wavelength: the scale that reads at 40-80 m.',
    '  float sheet = 0.5 + 0.5 * cos(6.2831853 * (dot(wp.xz, uSheetDir) * 0.017 + uSheetPhase));',
    '  a *= mix(0.55, 1.45, sheet * sheet);',
    '  // COVERAGE, NOT JUST RADIANCE: a lit drop is more OPAQUE as well as',
    '  // fatter, and an unlit one is barely there at all. This is a 0.34x floor',
    '  // rising to 3.7x, so the field genuinely appears inside the pools and',
    '  // thins between them rather than being drawn everywhere at one strength',
    '  // with a colour tint on top.',
    '  a *= 0.44 + 3.2 * lit;',
    '  a *= 1.0 + 2.2 * uFlash;',
    '  // ROOF MASK. It does not rain indoors. A coarse world-XZ grid of "highest',
    '  // sheltering surface here" built once from the level, so a drop whose',
    '  // column is covered simply does not exist - which also stops the budget',
    '  // being spent inside solid container stacks.',
    '  vec2 ruv = (wp.xz - uRoofRect.xy) * uRoofRect.zw;',
    '  float roofY = 0.0;',
    '  if (ruv.x > 0.0 && ruv.x < 1.0 && ruv.y > 0.0 && ruv.y < 1.0) {',
    '    roofY = texture2D(uRoofMap, ruv).r * uRoofScale;',
    '  }',
    '  a *= 1.0 - step(0.5, roofY) * step(wp.y + 0.05, roofY);',
    '  vAlpha = a;',
    '',
    '  // AIRLIGHT. The one term that is allowed to grow with distance: a drop',
    '  // 60 m away is seen through 60 m of illuminated rain column, so the',
    '  // scattered skylight and lamp spill between it and the lens adds up. That',
    '  // is what a rain VEIL is, and it is why the far field of a wide shot',
    '  // reads as weather while the near field must stay a dark glint. Keeping',
    '  // it off until 18 m is what stops it undoing the near-field dimming that',
    '  // took rain out of being the highest-contrast element in the frame.',
    '  vec3 col = uBaseCol + uAirCol * smoothstep(18.0, 70.0, dist);',
    '  col += lightCol;',
    '  col += uFlashCol * (uFlash * (0.7 + 0.6 * aRand.z));',
    '  vCol = col;',
    '}'
  ].join('\n');

  var RAIN_FRAG = [
    SOFT_PARS,
    'uniform float uSoftDist;',
    'uniform float uBlur;',
    'varying vec2 vUv;',
    'varying vec3 vCol;',
    'varying float vAlpha;',
    'varying float vViewZ;',
    'void main() {',
    '  float x = vUv.x * 2.0 - 1.0;',
    '  float y = vUv.y * 2.0 - 1.0;',
    '  // Near drops get a broader, softer core: they are inside the lens focal',
    '  // falloff, and a crisp near streak reads as a scratch on the film.',
    '  float across = pow(max(0.0, 1.0 - x * x), uBlur);',
    '  float along = smoothstep(1.0, 0.18, abs(y));',
    '  float a = across * along * vAlpha;',
    '  if (a < 0.0015) discard;',
    '  a *= gbSoft(vViewZ, uSoftDist);',
    '  gl_FragColor = vec4(vCol, a);',
    '}'
  ].join('\n');

  // ==========================================================================
  // LENS BEADS
  // Water ON the front element. It lives in ctx.viewScene next to the gun, at a
  // fixed 0.115 m, because that is the only pass in this renderer that composites
  // OVER the world - postfx clears the viewmodel depth buffer and mixes the
  // result on top, so nothing in ctx.scene can ever be in front of the weapon.
  // A bead is a negative lens: it DARKENS its core (it is bending the scene away)
  // and carries a bright rim, so it needs a blend that can subtract. The
  // premultiplied 'over' path below does that and still resolves correctly
  // through postfx's mix(world, view.rgb, view.a) composite.
  // ==========================================================================
  var BEAD_VERT = [
    'attribute vec4 aBase;',   // xy plane position -1..1, z rate, w phase
    'attribute vec4 aRand;',   // x size, y bright, z tail mul, w squash
    'uniform vec2 uPlaneHalf;',
    'uniform float uTime;',
    'uniform float uWet;',
    'uniform vec2 uSmear;',
    'uniform float uSmearLen;',
    'varying vec2 vUv;',
    'varying float vAlpha;',
    'varying float vTail;',
    'void main() {',
    '  vUv = uv;',
    '  float u = fract(uTime * aBase.z + aBase.w);',
    '  vec2 p = aBase.xy;',
    '  // Beads accumulate, hang, then run off downward. The run-off accelerates.',
    '  float run = smoothstep(0.55, 1.0, u);',
    '  p.y -= run * run * 0.55;',
    '  p += uSmear * (uSmearLen * (0.4 + 0.9 * aRand.z) * run);',
    '  vec3 c = vec3(p * uPlaneHalf, -0.115);',
    '  float sz = aRand.x * uPlaneHalf.y;',
    '  // Camera motion stretches a bead into a streak along the motion vector.',
    '  float tail = 1.0 + uSmearLen * 5.5 * aRand.z;',
    '  vTail = tail;',
    '  vec2 ax = normalize(uSmear + vec2(0.0, -1.0) * 0.35 + vec2(1e-5, 0.0));',
    '  vec2 pe = vec2(-ax.y, ax.x);',
    '  c.xy += (pe * position.x + ax * (position.y * tail)) * sz;',
    '  // c IS ALREADY VIEW SPACE. Water on the front element is pinned to the',
    '  // lens, not to the scene, so it must not go through viewMatrix - that',
    '  // would make the beads counter-shake with the weapon.',
    '  gl_Position = projectionMatrix * vec4(c, 1.0);',
    '  float a = smoothstep(0.0, 0.10, u) * (1.0 - smoothstep(0.72, 1.0, u));',
    '  // Weighted to the frame edges: the middle of a lens stays clear longest',
    '  // and a bead over the reticle is a bug, not an effect.',
    '  float rad = length(aBase.xy);',
    '  a *= 0.14 + 0.86 * smoothstep(0.25, 0.95, rad);',
    '  vAlpha = a * uWet * (0.45 + 0.8 * aRand.y);',
    '}'
  ].join('\n');

  var BEAD_FRAG = [
    'uniform vec3 uRimCol;',
    'uniform vec3 uCoreCol;',
    'varying vec2 vUv;',
    'varying float vAlpha;',
    'varying float vTail;',
    'void main() {',
    '  vec2 p = vUv * 2.0 - 1.0;',
    '  p.y /= max(vTail, 1e-3);',
    '  float r = length(p);',
    '  if (r > 1.0) discard;',
    '  // SOFT, and mostly DARK. A bead 11 cm from the front element is far',
    '  // inside the focal falloff - it is a blurred lozenge, never a crisp ring,',
    '  // and the first pass at this printed forty hard white circles across the',
    '  // frame, which is a bubble machine, not a lens. What a droplet actually',
    '  // does is refract the scene away from the sensor: it is a dark blob with',
    '  // a faint bright edge, so it disappears against a dark wall and only',
    '  // shows where there is something behind it to bend.',
    '  float core = 1.0 - smoothstep(0.0, 1.0, r);',
    '  float rim = smoothstep(0.42, 0.94, r) * (1.0 - smoothstep(0.94, 1.0, r));',
    '  float a = (core * 0.80 + rim * 0.45) * vAlpha;',
    '  if (a < 0.004) discard;',
    '  vec3 col = uCoreCol * core + uRimCol * (rim * 1.5 + core * 0.35);',
    '  gl_FragColor = vec4(col, a);',
    '}'
  ].join('\n');

  // ==========================================================================
  // LIGHTNING CHANNEL
  // The single element that makes a STILL read as lightning rather than as an
  // exposure change. One camera-facing quad parked along flashDir; the channel
  // itself is procedural in the fragment stage, so there is no geometry to
  // rebuild per strike and nothing to allocate. Alive only while a return
  // stroke is - the continuing-current plateau has no visible channel.
  // ==========================================================================
  var CHAN_VERT = [
    'uniform vec2 uSize;',
    'varying vec2 vUv;',
    'void main() {',
    '  vUv = uv;',
    '  vec4 vp = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);',
    '  vp.xy += position.xy * uSize;',
    '  gl_Position = projectionMatrix * vp;',
    '}'
  ].join('\n');

  var CHAN_FRAG = [
    'uniform vec3 uCol;',
    'uniform float uAmp;',
    'uniform float uSeed;',
    'varying vec2 vUv;',
    'float chNoise(float x) {',
    '  float i = floor(x); float f = fract(x);',
    '  float a = fract(sin(i * 12.9898 + uSeed) * 43758.5453);',
    '  float b = fract(sin((i + 1.0) * 12.9898 + uSeed) * 43758.5453);',
    '  f = f * f * (3.0 - 2.0 * f);',
    '  return mix(a, b, f) * 2.0 - 1.0;',
    '}',
    'void main() {',
    '  if (uAmp < 0.002) discard;',
    '  float y = vUv.y;',
    '  // Jagged, not wobbly: high-frequency segments with a slow lean.',
    '  float path = chNoise(y * 7.0) * 0.24 + chNoise(y * 21.0) * 0.075 + chNoise(y * 2.3) * 0.16;',
    '  float dx = (vUv.x - 0.5) - path;',
    '  float w = 0.0075 + 0.020 * (1.0 - y);',
    '  float core = exp(-abs(dx) / w);',
    '  float glow = exp(-abs(dx) / (w * 9.0)) * 0.30;',
    '  // Brightest at the ground termination and dying into the cloud base at',
    '  // the top - and it must NOT fade out at the bottom of the quad, because',
    '  // the bottom of the quad is the only part of a 340 m column that is ever',
    '  // inside a 76-degree frame.',
    '  float ramp = smoothstep(0.0, 0.03, y) * (0.35 + 0.65 * (1.0 - y * 0.85));',
    '  float a = (core + glow) * ramp * uAmp;',
    '  if (a < 0.0025) discard;',
    '  gl_FragColor = vec4(uCol * (0.35 + 1.5 * core), a);',
    '}'
  ].join('\n');

  // ==========================================================================
  // SPLASH: the expanding impact ring, ground aligned.
  // ==========================================================================
  var SPLASH_VERT = [
    'attribute vec4 aOrigin;',  // xyz world, w = t0
    'attribute vec4 aRand;',    // x radius, y life, z bright, w 0 = ring, 1 = crown
    'uniform float uTime;',
    'uniform float uFlash;',
    'uniform vec3 uFlashCol;',
    'uniform vec3 uBaseCol;',
    'uniform float uGain;',
    LIGHT_PARS,
    'varying vec2 vUv;',
    'varying vec3 vCol;',
    'varying float vAlpha;',
    'varying float vU;',
    'varying float vKind;',
    'void main() {',
    '  vUv = uv;',
    '  float age = uTime - aOrigin.w;',
    '  float u = age / max(aRand.y, 0.01);',
    '  if (u < 0.0 || u > 1.0) {',
    '    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);',
    '    vAlpha = 0.0; vU = 1.0; vKind = 0.0; vCol = vec3(0.0);',
    '    return;',
    '  }',
    '  vU = u;',
    '  vKind = aRand.w;',
    '  vec3 world;',
    '  if (aRand.w > 0.5) {',
    '    // THE CROWN. An impact is not a flat ring - the sheet of water that',
    '    // rebounds vertically is most of what the eye reads as "water" rather',
    '    // than "decal". Camera-facing, 4-8 cm, gone in 0.12 s.',
    '    vec3 toCam = cameraPosition - aOrigin.xyz;',
    '    toCam.y = 0.0;',
    '    float tl = length(toCam);',
    '    toCam = tl > 1e-4 ? toCam / tl : vec3(0.0, 0.0, 1.0);',
    '    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));',
    '    float hgt = aRand.x * (0.55 + 1.5 * sqrt(u));',
    '    float wdt = aRand.x * (0.32 + 0.85 * u);',
    '    world = aOrigin.xyz + right * (position.x * wdt) +',
    '            vec3(0.0, (position.y + 0.5) * hgt, 0.0);',
    '  } else {',
    '    // sqrt() expansion: a real ring decelerates hard right after impact.',
    '    float rad = aRand.x * (0.18 + 0.95 * sqrt(u));',
    '    world = aOrigin.xyz + vec3(position.x * rad, 0.012 + 0.02 * u, position.y * rad);',
    '  }',
    '  vec4 vp = viewMatrix * vec4(world, 1.0);',
    '  gl_Position = projectionMatrix * vp;',
    '  float dist = max(-vp.z, 0.001);',
    '  float a = (1.0 - u) * (1.0 - u) * uGain * (0.6 + 0.7 * aRand.z);',
    '  a *= smoothstep(0.20, 0.9, dist) * (1.0 - smoothstep(23.0, 38.0, dist));',
    '  vAlpha = a;',
    '  vCol = uBaseCol + gbSampleLights(world) + uFlashCol * uFlash * 0.8;',
    '}'
  ].join('\n');

  var SPLASH_FRAG = [
    'varying vec2 vUv;',
    'varying vec3 vCol;',
    'varying float vAlpha;',
    'varying float vU;',
    'varying float vKind;',
    'void main() {',
    '  float a;',
    '  if (vKind > 0.5) {',
    '    // A crown is a thin water sheet: bright edges, hollow middle, and it',
    '    // tears into droplets as it rises.',
    '    float x = vUv.x * 2.0 - 1.0;',
    '    float edge = smoothstep(0.30, 1.0, abs(x)) * (1.0 - smoothstep(0.86, 1.0, abs(x)));',
    '    float body = (1.0 - x * x) * 0.30;',
    '    float up = (1.0 - smoothstep(0.35, 1.0, vUv.y));',
    '    a = (edge * 0.9 + body) * up * vAlpha;',
    '  } else {',
    '    vec2 p = vUv * 2.0 - 1.0;',
    '    float r = length(p);',
    '    if (r > 1.0) discard;',
    '    // The ring thins as it expands, exactly like surface tension letting go.',
    '    float w = mix(0.34, 0.11, vU);',
    '    float ring = smoothstep(w, 0.0, abs(r - 0.76));',
    '    float pip = smoothstep(0.55, 0.0, r) * (1.0 - smoothstep(0.0, 0.35, vU)) * 0.7;',
    '    a = (ring + pip) * vAlpha;',
    '  }',
    '  if (a < 0.002) discard;',
    '  gl_FragColor = vec4(vCol, a);',
    '}'
  ].join('\n');

  // Droplets thrown off an impact: pure ballistics in the vertex shader, so the
  // CPU writes each one exactly once and never touches it again.
  var DROP_VERT = [
    'attribute vec4 aOrigin;',  // xyz, w = t0
    'attribute vec4 aVel;',     // xyz, w = life
    'attribute vec4 aRand;',    // x size, y bright, z/w spare
    'uniform float uTime;',
    'uniform float uPixelScale;',
    'uniform float uFlash;',
    'uniform vec3 uFlashCol;',
    'uniform vec3 uBaseCol;',
    'uniform float uGain;',
    LIGHT_PARS,
    'varying vec2 vUv;',
    'varying vec3 vCol;',
    'varying float vAlpha;',
    'void main() {',
    '  vUv = uv;',
    '  float age = uTime - aOrigin.w;',
    '  float u = age / max(aVel.w, 0.01);',
    '  if (u < 0.0 || u > 1.0) {',
    '    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);',
    '    vAlpha = 0.0; vCol = vec3(0.0);',
    '    return;',
    '  }',
    '  vec3 world = aOrigin.xyz + aVel.xyz * age + vec3(0.0, -5.6, 0.0) * age * age;',
    '  vec4 vp = viewMatrix * vec4(world, 1.0);',
    '  float dist = max(-vp.z, 0.001);',
    '  float sz = max(aRand.x, dist * uPixelScale * 1.1);',
    '  vp.xy += position.xy * sz;',
    '  gl_Position = projectionMatrix * vp;',
    '  float a = (1.0 - u * u) * uGain * (0.5 + 0.8 * aRand.y);',
    '  a *= 1.0 - smoothstep(18.0, 32.0, dist);',
    '  vAlpha = a;',
    '  vCol = uBaseCol + gbSampleLights(world) + uFlashCol * uFlash * 0.9;',
    '}'
  ].join('\n');

  var DROP_FRAG = [
    'varying vec2 vUv;',
    'varying vec3 vCol;',
    'varying float vAlpha;',
    'void main() {',
    '  vec2 p = vUv * 2.0 - 1.0;',
    '  float d = dot(p, p);',
    '  if (d > 1.0) discard;',
    '  float a = (1.0 - d) * vAlpha;',
    '  if (a < 0.002) discard;',
    '  gl_FragColor = vec4(vCol, a);',
    '}'
  ].join('\n');

  // ==========================================================================
  // DRIPS: water running off container lips, ledges, the crane, awnings.
  //
  // A ROPE, NOT A BEAD. This was a translating 4-17 mm droplet, which at 10 m
  // subtends half a pixel, is inflated to the 1 px floor and prints as a
  // hairline dot - I could not find one in any capture either. A running edge in
  // a downpour is not a detaching drop, it is a continuous unbroken 1-3 cm sheet
  // hanging the whole fall distance with brightness waves travelling down it.
  // So the quad now SPANS the fall and the animation is a scrolling wave along
  // a static ribbon: same instance count, twenty times the screen coverage, and
  // the CPU still writes the buffer exactly once at build.
  // ==========================================================================
  var DRIP_VERT = [
    'attribute vec4 aOrigin;',  // xyz, w = phase 0..1
    'attribute vec4 aRand;',    // x rate (waves/s), y fall dist, z width, w sway
    'uniform float uTime;',
    'uniform float uPixelScale;',
    'uniform vec2 uWindDir;',
    'uniform float uRain;',
    'uniform float uFlash;',
    'uniform vec3 uFlashCol;',
    'uniform vec3 uBaseCol;',
    'uniform float uGain;',
    LIGHT_PARS,
    'varying vec2 vUv;',
    'varying vec3 vCol;',
    'varying float vAlpha;',
    'varying float vViewZ;',
    'varying float vPh;',
    'varying float vRate;',
    'void main() {',
    '  vUv = uv;',
    '  vPh = aOrigin.w;',
    '  vRate = aRand.x;',
    '  float fall = aRand.y;',
    '  // The whole ribbon leans downwind and sways as one, the way a running',
    '  // sheet of water does; it does not travel.',
    '  float sway = sin(uTime * 1.05 + aOrigin.w * 43.0) * aRand.w;',
    '  float drop = (0.5 - position.y) * fall;',
    '  float lean = sway * (drop / max(fall, 0.01));',
    '  vec3 world = vec3(aOrigin.x + lean * uWindDir.x, aOrigin.y - drop,',
    '                    aOrigin.z + lean * uWindDir.y);',
    '  vec4 vp = viewMatrix * vec4(world, 1.0);',
    '  float dist = max(-vp.z, 0.001);',
    '  float wid = max(aRand.z, dist * uPixelScale * 1.25);',
    '  vp.xyz += vec3(position.x * wid, 0.0, 0.0);',
    '  gl_Position = projectionMatrix * vp;',
    '  vViewZ = dist;',
    '  float a = uGain * uRain;',
    '  a *= 1.0 - smoothstep(26.0, 46.0, dist);',
    '  vAlpha = a;',
    '  vCol = uBaseCol + gbSampleLights(world) + uFlashCol * uFlash * 0.85;',
    '}'
  ].join('\n');

  var DRIP_FRAG = [
    SOFT_PARS,
    'uniform float uSoftDist;',
    'uniform float uTime;',
    'varying vec2 vUv;',
    'varying vec3 vCol;',
    'varying float vAlpha;',
    'varying float vViewZ;',
    'varying float vPh;',
    'varying float vRate;',
    'void main() {',
    '  float x = vUv.x * 2.0 - 1.0;',
    '  // The brightness wave running DOWN a static ribbon. vUv.y = 1 at the lip.',
    '  float s = fract(vUv.y * 1.7 + uTime * vRate + vPh);',
    '  float bead = pow(s, 4.0);',
    '  float ribbon = 1.0 - x * x;',
    '  // Thins and breaks up toward the bottom of the fall.',
    '  float taper = smoothstep(-0.05, 0.34, vUv.y) * (0.45 + 0.55 * vUv.y);',
    '  float a = ribbon * (0.20 + 0.85 * bead) * taper * vAlpha;',
    '  if (a < 0.002) discard;',
    '  a *= gbSoft(vViewZ, uSoftDist);',
    '  gl_FragColor = vec4(vCol, a);',
    '}'
  ].join('\n');

  // ==========================================================================
  // MIST: wind-driven low cloud across the apron, and spray off the quay.
  // Y-axis billboards hugging the ground. They pick up the practicals, so a
  // bank crossing a sodium cone glows orange and gives the cone a volume, which
  // is the one effect the art direction calls the most important in the level.
  // ==========================================================================
  var MIST_VERT = [
    'attribute vec4 aBase;',   // xyz 0..1 in the volume, w = phase
    'attribute vec4 aRand;',   // x width, y height, z bright, w drift mul
    'uniform vec3 uCentre;',
    'uniform vec3 uBox;',
    'uniform vec3 uDrift;',
    'uniform float uGroundY;',
    'uniform float uTime;',
    'uniform float uFlash;',
    'uniform vec3 uFlashCol;',
    'uniform vec3 uBaseCol;',
    'uniform float uGain;',
    LIGHT_PARS,
    'varying vec2 vUv;',
    'varying vec3 vCol;',
    'varying float vAlpha;',
    'varying float vViewZ;',
    'void main() {',
    '  vUv = uv;',
    '  vec2 hb = uBox.xz * 0.5;',
    '  vec2 base = aBase.xz * uBox.xz;',
    '  vec2 drift = uDrift.xz * aRand.w;',
    '  vec2 xz = uCentre.xz + mod(base + drift - uCentre.xz + hb, uBox.xz) - hb;',
    '  float y = uGroundY + aBase.y * uBox.y + sin(uTime * 0.31 + aBase.w * 39.0) * 0.12;',
    '  vec3 world = vec3(xz.x, y, xz.y);',
    '  vec3 toCam = cameraPosition - world;',
    '  toCam.y = 0.0;',
    '  float tl = length(toCam);',
    '  toCam = tl > 1e-4 ? toCam / tl : vec3(0.0, 0.0, 1.0);',
    '  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));',
    '  world += right * (position.x * aRand.x) + vec3(0.0, position.y * aRand.y, 0.0);',
    '  vec4 vp = viewMatrix * vec4(world, 1.0);',
    '  gl_Position = projectionMatrix * vp;',
    '  float dist = max(-vp.z, 0.001);',
    '  vViewZ = dist;',
    '  vec2 rel = (xz - uCentre.xz) / hb;',
    '  float edge = max(abs(rel.x), abs(rel.y));',
    '  float a = 1.0 - smoothstep(0.62, 1.0, edge);',
    '  // These are NORMAL-blended cards, so they compound: nine of them within',
    '  // 20 m at 0.29 alpha each is 96% opacity, i.e. a lid over the apron. The',
    '  // near fade was 1.4-5.0 m, which put full-strength cards a stride in',
    '  // front of the lens. Pushing it to 2.5-11 m means the bank you are',
    '  // standing in is thin and the one across the terminal is thick, which is',
    '  // both what fog does and what keeps the ground legible.',
    '  a *= smoothstep(2.5, 11.0, dist);',
    '  a *= uGain * (0.5 + 0.8 * aRand.z);',
    '  vAlpha = a;',
    '  vCol = uBaseCol + gbSampleLights(world) * 0.32 + uFlashCol * uFlash * 0.9;',
    '}'
  ].join('\n');

  var MIST_FRAG = [
    SOFT_PARS,
    'uniform float uSoftDist;',
    'uniform sampler2D uMap;',
    'varying vec2 vUv;',
    'varying vec3 vCol;',
    'varying float vAlpha;',
    'varying float vViewZ;',
    'void main() {',
    '  float m = texture2D(uMap, vUv).r;',
    '  float a = m * vAlpha;',
    '  if (a < 0.003) discard;',
    '  a *= gbSoft(vViewZ, uSoftDist);',
    '  gl_FragColor = vec4(vCol, a);',
    '}'
  ].join('\n');

  var FS_VERT = [
    'varying vec2 vUv;',
    'void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }'
  ].join('\n');

  // ==========================================================================
  // RIPPLE NORMAL FIELD
  // A tiling normal map of expanding concentric rings, rebuilt on the GPU every
  // frame from a pool of ripple centres. materials.js consumes it through
  // weather.rippleTexture / weather.uniforms.uRippleMap, so wet ground gets a
  // moving surface instead of a static gloss - "puddles that do not ripple in
  // the rain" is on the instant-fail list.
  // Gradients are analytic; finite-differencing 24 ripples per texel would cost
  // four times as much for a worse normal.
  // ==========================================================================
  // 40 rings on a 2.6 m tile at a 2.0 s life is 5.9 alive per square metre from
  // 3 arrivals per square metre per second, and the apron photographed as a
  // static black mirror with a few isolated circles on it. Real heavy rain on
  // standing water is a BOILING surface. 96 on a 1.15 s life is 83 spawns a
  // second per 6.8 m tile - 12 arrivals per square metre per second, still a
  // fraction of reality but the point where the surface stops reading as
  // discrete events. The cost is linear in the ring count and it is one extra
  // early-out per texel per ring on a 256 target, which is the cheapest pass in
  // the module by an order of magnitude.
  var RIPPLE_COUNT = 96;
  var RIPPLE_LIFE = 1.15;

  var RIPPLE_FRAG = [
    'precision highp float;',
    'uniform vec4 uRip[' + RIPPLE_COUNT + '];',   // xy centre (tile space), z t0, w amp
    'uniform float uTime;',
    'uniform float uStrength;',
    'varying vec2 vUv;',
    'void main() {',
    '  vec2 grad = vec2(0.0);',
    '  for (int i = 0; i < ' + RIPPLE_COUNT + '; i++) {',
    '    vec4 r = uRip[i];',
    '    if (r.w <= 0.0) continue;',
    '    float age = uTime - r.z;',
    '    if (age < 0.0 || age > ' + RIPPLE_LIFE.toFixed(2) + ') continue;',
    '    vec2 diff = vUv - r.xy;',
    '    // Toroidal: the texture tiles, so the nearest copy of the centre wins.',
    '    diff -= floor(diff + 0.5);',
    '    float d = length(diff);',
    '    if (d < 1e-4) continue;',
    '    float front = age * 0.30;',
    '    float ring = d - front;',
    '    float env = exp(-abs(ring) * 26.0) * exp(-age * 1.9) * r.w;',
    '    float k = 62.0;',
    '    grad += (diff / d) * (cos(ring * k) * k * env) * 0.012;',
    '  }',
    '  vec3 n = normalize(vec3(-grad.x * uStrength, -grad.y * uStrength, 1.0));',
    '  gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);',
    '}'
  ].join('\n');

  function RippleField(rng) {
    this.rng = rng;
    this.size = 256;
    this.rt = new THREE.WebGLRenderTarget(this.size, this.size, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false
    });
    // A normal map is DATA. sRGB here is the classic silent bug.
    this.rt.texture.colorSpace = THREE.NoColorSpace;
    this.rt.texture.wrapS = THREE.RepeatWrapping;
    this.rt.texture.wrapT = THREE.RepeatWrapping;
    this.rt.texture.name = 'weather.rippleNormal';

    this.data = new Float32Array(RIPPLE_COUNT * 4);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uRip: { value: this.data },
        uTime: { value: 0 },
        uStrength: { value: 1.0 }
      },
      vertexShader: FS_VERT,
      fragmentShader: RIPPLE_FRAG,
      depthTest: false,
      depthWrite: false
    });
    this.mesh = new THREE.Mesh(GAME.fullscreenGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._next = 0;
    this._acc = 0;
    this._primed = false;
  }

  RippleField.prototype.spawn = function (time) {
    var i = this._next;
    this._next = (this._next + 1) % RIPPLE_COUNT;
    var o = i * 4;
    this.data[o] = this.rng.next();
    this.data[o + 1] = this.rng.next();
    this.data[o + 2] = time;
    this.data[o + 3] = this.rng.range(0.40, 1.05);
  };

  RippleField.prototype.update = function (dt, time, intensity, renderer) {
    if (!renderer) return;
    // Prime the whole pool the first live frame, so even a capture at t=0.1
    // shows a full ripple field instead of one lonely ring.
    if (!this._primed && intensity > 0.02) {
      this._primed = true;
      for (var k = 0; k < RIPPLE_COUNT; k++) {
        var q = k * 4;
        this.data[q] = this.rng.next();
        this.data[q + 1] = this.rng.next();
        this.data[q + 2] = time - this.rng.range(0, RIPPLE_LIFE * 0.95);
        this.data[q + 3] = this.rng.range(0.40, 1.05);
      }
    }
    // A pool of RIPPLE_COUNT on a RIPPLE_LIFE second life needs
    // RIPPLE_COUNT / RIPPLE_LIFE spawns a second to stay full.
    var rate = (RIPPLE_COUNT / RIPPLE_LIFE) * M.saturate(intensity);
    if (rate > 0) {
      this._acc += dt * rate;
      var guard = 0;
      while (this._acc >= 1 && guard++ < 12) { this._acc -= 1; this.spawn(time); }
    }
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uStrength.value = 0.35 + 1.25 * M.saturate(intensity);

    var prev = renderer.getRenderTarget();
    var prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.rt);
    renderer.render(this.mesh, this.camera);
    renderer.setRenderTarget(prev);
    renderer.autoClear = prevAuto;
  };

  RippleField.prototype.dispose = function () {
    this.rt.dispose();
    this.material.dispose();
  };

  // ==========================================================================
  // DEPTH PROBE
  // A half-res R-channel copy of the PREVIOUS frame's linear view depth.
  // Sampling postfx's depth attachment while it is bound would form a feedback
  // loop, so it is linearised into our own target during update(). One frame
  // stale, which for a soft fade is invisible and for the hazard is decisive.
  // ==========================================================================
  var DEPTH_FRAG = [
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
  ].join('\n');

  function DepthProbe(w, h) {
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
      vertexShader: FS_VERT,
      fragmentShader: DEPTH_FRAG,
      depthTest: false,
      depthWrite: false
    });
    this.mesh = new THREE.Mesh(GAME.fullscreenGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  DepthProbe.prototype.run = function (renderer, depthTexture, near, far) {
    this.material.uniforms.tDepth.value = depthTexture;
    this.material.uniforms.uNF.value.set(near, far);
    var prev = renderer.getRenderTarget();
    var prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.rt);
    renderer.render(this.mesh, this.camera);
    renderer.setRenderTarget(prev);
    renderer.autoClear = prevAuto;
  };

  DepthProbe.prototype.resize = function (w, h) {
    this.rt.setSize(Math.max(2, w >> 1), Math.max(2, h >> 1));
  };

  DepthProbe.prototype.dispose = function () {
    this.rt.dispose();
    this.material.dispose();
  };

  // ==========================================================================
  // Geometry helpers
  // ==========================================================================
  var _quad = null;
  function quadSource() {
    if (_quad) return _quad;
    var g = new THREE.PlaneGeometry(1, 1);
    _quad = { index: g.index, position: g.attributes.position, uv: g.attributes.uv };
    return _quad;
  }

  function instancedQuads(count) {
    var q = quadSource();
    var g = new THREE.InstancedBufferGeometry();
    g.setIndex(q.index);
    g.setAttribute('position', q.position);
    g.setAttribute('uv', q.uv);
    g.instanceCount = count;
    // Everything here is camera-relative or shader-placed, so a bounding sphere
    // would be a lie; frustum culling is off on all of it.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    return g;
  }

  function iattr(geo, name, itemSize, count) {
    var a = new THREE.InstancedBufferAttribute(new Float32Array(count * itemSize), itemSize);
    a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(name, a);
    return a;
  }

  // Soft blob for the mist cards. Wide and low, because a fog card is an
  // ellipse and never a circle. Mask lives in RGB with alpha pinned at 255 so
  // no premultiply path can square it.
  function mistTexture(noise) {
    var S = 128;
    var cv = document.createElement('canvas');
    cv.width = cv.height = S;
    var g2 = cv.getContext('2d');
    var img = g2.createImageData(S, S);
    var d = img.data;
    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        var u = (x + 0.5) / S * 2 - 1;
        var v = (y + 0.5) / S * 2 - 1;
        var r = Math.sqrt(u * u * 0.55 + v * v * 1.5);
        var fall = M.saturate(1 - r);
        fall = fall * fall * (3 - 2 * fall);
        var n = noise.fbm2(x * 0.045, y * 0.045, 4, 2.1, 0.55) * 0.5 + 0.5;
        var a = Math.round(M.saturate(fall * (0.32 + 0.95 * n)) * 255);
        var i = (y * S + x) * 4;
        d[i] = a; d[i + 1] = a; d[i + 2] = a; d[i + 3] = 255;
      }
    }
    g2.putImageData(img, 0, 0);
    var t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.NoColorSpace;   // mask data, not colour
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    return t;
  }

  // ==========================================================================
  // GAME.Weather
  // ==========================================================================
  function Weather(ctx) {
    this.ctx = ctx || {};
    this.rng = (this.ctx.rng && this.ctx.rng.fork) ? this.ctx.rng.fork(0x5741) : new GAME.RNG(0x5741);
    // THE STORM GETS ITS OWN STREAM, forked before anything has drawn from the
    // main one. Every strike used to be drawn from the same RNG the splash
    // emitter pulls from tens of times a frame, so changing the splash RATE -
    // a completely unrelated tuning value - silently changed the bearing,
    // elevation and distance of the strike a capture would photograph. Two
    // `lightning` frames taken either side of a splash tweak were not an A/B of
    // the splash tweak, they were two different strikes, and the metrics moved
    // for a reason that had nothing to do with the edit. Forking isolates it:
    // fork() derives from the current state without consuming it, and this runs
    // before the first draw, so the schedule is a pure function of the seed.
    this.lrng = this.rng.fork(0x71A5);
    this.noise = new GAME.Noise(0xC01D);

    // ---- the published contract --------------------------------------------
    this.wetness = 0;
    this.rainIntensity = 0;
    this.windDir = new THREE.Vector2(0.82, -0.57).normalize();
    this.windSpeed = 0;
    this.flash = 0;
    this.flashDir = new THREE.Vector3(0.35, 0.62, -0.70).normalize();
    this.flashColor = new THREE.Color(0.72, 0.83, 1.0);
    this.fogDensity = PRESETS.clear.fog;
    this.fogUnits = 'extinction-per-metre';
    this.fogVisibility = visibilityFor(this.fogDensity);
    this.preset = 'clear';

    // ---- optional extras; every consumer guards on its own side ------------
    this.lensWetness = 0;        // for postfx's lens-rain, if it wants it
    this.rippleTexture = null;   // for materials.js wet ground
    this.rippleNormal = null;
    this.rippleTiling = 2.6;     // world metres per tile of the ripple map
    this.rippleStrength = 0;
    this.thunderPending = 0;
    this.volumeCentre = new THREE.Vector3();

    this.active = false;
    this.ready = false;
    this.enabled = true;
    this.time = 0;

    this.root = new THREE.Object3D();
    this.root.name = 'weather';
    this.root.matrixAutoUpdate = false;
    this.root.frustumCulled = false;

    var q = this.ctx.quality || {};
    this.qp = typeof q.particles === 'number' ? M.clamp(q.particles, 0.25, 2.0) : 1.0;

    this._built = false;
    this._target = PRESETS.clear;
    this._rainCur = 0;
    this._mistCur = 0;
    this._sprayCur = 0;
    this._windVec = new THREE.Vector2(0, 0);
    this._windAccum = new THREE.Vector2(0, 0);
    this._fallAccum = 0;
    this._gustPhase = this.rng.range(0, 100);
    this._fwd = new THREE.Vector3(0, 0, -1);
    this._groundY = 0;
    // Squall envelope 0..1. Long lulls, short surges; every density, wind and
    // atmosphere term hangs off this one number so the storm breathes together.
    this.squall = 0.5;
    this._sheetPhase = this.rng.next();

    // ---- viewmodel-scene water (rain across the gun, beads on the lens) -----
    this.viewRain = null;
    this.beads = null;
    this._viewDrift = new THREE.Vector3();
    this._viewQ = new THREE.Quaternion();
    this._smear = new THREE.Vector2(0, -1);
    this._smearLen = 0;
    this._lastYaw = null;
    this._lastPitch = 0;

    // ---- roof mask (it does not rain indoors) ------------------------------
    this._roofTex = null;
    this._roofData = null;
    this._roofSize = 0;
    this._roofRect = new THREE.Vector4(0, 0, 1, 1);
    this._roofScale = 48.0;
    this.roofMask = null;
    this._dripFeet = null;

    // ---- lightning channel -------------------------------------------------
    this._channel = null;
    this._chanAmp = 0;

    // ---- lightning ---------------------------------------------------------
    this._nextStrikeAt = 4.0;
    this._strike = null;
    this._thunder = [];
    this._flashLight = null;
    this._flashFill = null;
    this._flashTarget = null;
    this._shadowPrime = 0;
    // Public handles for the strike rig. lighting.js looks for
    // `flashLight` / `flashFill` before falling back to the underscored names
    // so it can budget its own lightning key against ours; publishing them is
    // how two modules that were both told to make lightning a real light avoid
    // billing the player twice.
    this.flashLight = null;
    this.flashFill = null;

    // ---- practicals feeding the water shaders ------------------------------
    this._lightCache = [];
    this._lightScanAt = -1e9;
    this._lightPickAt = -1e9;
    this._pick = [];
    for (var pi = 0; pi < 64; pi++) this._pick.push({ e: null, d2: 0, x: 0, y: 0, z: 0 });
    this._pickN = 0;
    this._uLightPos = new Float32Array(MAX_LIGHTS * 4);
    this._uLightDir = new Float32Array(MAX_LIGHTS * 4);
    this._uLightCol = new Float32Array(MAX_LIGHTS * 3);

    this._depth = null;
    this._depthTex = null;
    this._depthRT = null;
    this._ripples = null;
    this._mistMap = null;

    this.layers = [];
    this.splash = null;
    this.drops = null;
    this.drips = null;
    this.mist = null;
    this.spray = null;

    // Ground probes for splashes. Pre-allocated: they are refreshed two per
    // frame forever, so allocating one would be allocating one per frame.
    this._probes = [];
    for (var k = 0; k < PROBE_CAP; k++) {
      this._probes.push({ x: 0, y: 0, z: 0, ok: false });
    }
    this._probeHead = 0;
    this._probesPrimed = false;
    this._poolX = 0;
    this._poolZ = 0;
    this._sprayLine = null;
    this._sprayProbed = false;
    this._errored = false;

    // A 1x1 white stand-in so uDepth is never null: a null sampler is a
    // validation error on some drivers, and "far away" is the right answer for
    // a frame where the real depth is not available yet.
    var fb = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
    fb.colorSpace = THREE.NoColorSpace;
    fb.needsUpdate = true;
    this._fallbackDepth = fb;

    // Shared uniform OBJECTS. Keeping the objects (not the values) means one
    // write per frame reaches every material that references them.
    this.uniforms = {
      uTime: { value: 0 },
      uPixelScale: { value: 0.0028 },
      uWindDir: { value: new THREE.Vector2(1, 0) },
      uFlash: { value: 0 },
      uFlashCol: { value: new THREE.Color(0, 0, 0) },
      uRain: { value: 0 },
      uDepth: { value: fb },
      uSoft: { value: 0 },
      uInvRes: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
      uLightPos: { value: this._uLightPos },
      uLightDir: { value: this._uLightDir },
      uLightCol: { value: this._uLightCol },
      uMaxPx: { value: 68 },
      uFogSigma: { value: PRESETS.clear.fog },
      uSheetDir: { value: new THREE.Vector2(1, 0) },
      uSheetPhase: { value: 0 },
      uRoofMap: { value: null },
      uRoofRect: { value: this._roofRect },
      uRoofScale: { value: this._roofScale },
      // published for materials.js / postfx
      uRippleMap: { value: null },
      uRippleTiling: { value: 2.6 },
      uWetness: { value: 0 }
    };
    // A 1x1 zero mask so the roof lookup is valid before the grid is built.
    var rm = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    rm.colorSpace = THREE.NoColorSpace;
    rm.needsUpdate = true;
    this._roofFallback = rm;
    this.uniforms.uRoofMap.value = rm;
  }

  // --------------------------------------------------------------------------
  Weather.prototype.build = async function (ctx) {
    ctx = ctx || this.ctx;
    this.ctx = ctx;
    try {
      var want = 'clear';
      if (ctx.levelId === 'harbor') want = 'storm';
      if (ctx.levelDef && PRESETS[ctx.levelDef.weather]) want = ctx.levelDef.weather;

      this._groundY = this._guessGroundY(ctx);

      if (want !== 'clear') {
        // Only a wet level pays for any of this.
        this._buildRoofMask(ctx);
        this._buildRain();
        if (!GAME.headless) await GAME.yieldFrame();
        this._buildSplash();
        this._buildDrips(ctx);
        if (!GAME.headless) await GAME.yieldFrame();
        this._buildMist();
        this._buildRipples(ctx);
        this._buildChannel();
        this._built = true;
      }

      this.ready = true;
      this.setPreset(want);

      if (this.active) {
        // A stormy level starts already soaked. A container terminal does not
        // begin to get wet the moment you spawn.
        var p = this._target;
        this.wetness = p.wetness;
        this._rainCur = p.rain;
        this._mistCur = p.mist;
        this._sprayCur = p.spray;
        this.rainIntensity = p.rain;
        this.fogDensity = p.fog;
        this.fogVisibility = visibilityFor(p.fog);
        this.windSpeed = p.wind;
        this.lensWetness = p.rain * p.lens;
        this.rippleStrength = p.rain * p.wetness;
        this.uniforms.uRain.value = p.rain;
        this.uniforms.uWetness.value = p.wetness;
        // Deliberately later than any capture window (shoot.py defaults to
        // 1.5-2.5 s): every framing except `lightning` must be lit by the
        // practicals, and `lightning` forces its own strike at a fixed time.
        this._nextStrikeAt = this.lrng.range(3.2, 6.0);
      }
    } catch (e) {
      GAME.logError('weather.build', e);
    }
  };

  Weather.prototype._buildResources = function (ctx) {
    if (this._built) return;
    try {
      this._buildRoofMask(ctx);
      this._buildRain();
      this._buildSplash();
      this._buildDrips(ctx);
      this._buildMist();
      this._buildRipples(ctx);
      this._buildChannel();
      this._built = true;
    } catch (e) {
      GAME.logError('weather.buildResources', e);
    }
  };

  // --------------------------------------------------------------------------
  // Rain: three camera-relative volumes.
  //  count  box (m)          fall  windMul  streak  width   blur near far  gain
  // --------------------------------------------------------------------------
  // `bl` is the exponent on the across-streak profile: HIGH is a soft, blurred
  // core and LOW is a flat, hard-edged one. Near drops sit inside the lens
  // focal falloff and must be the soft ones - at 0.55 they printed as white
  // scratches across the frame.
  //
  // `wd` IS A REAL WIDTH IN METRES and it is the number that decides whether
  // this reads as rain or as a curtain. It was 0.0165 on the near layer: a
  // 16 mm raindrop, four times the biggest drop the atmosphere can hold
  // together, which at 2 m subtends five pixels. Nine hundred five-pixel
  // streaks is a venetian blind. 8-10 mm still flatters a real 2-5 mm drop
  // (a stretched streak has to survive the resolve) but it is the right order
  // of magnitude, and it takes the near layer's screen coverage down 40%
  // without removing a single drop - the field keeps its texture and its
  // parallax and stops being opaque.
  //
  // `l` came down with it for the same reason: a 9.6 m/s drop travels 16 cm in
  // a 1/60 s exposure, and the layer was drawing 0.51-0.77 m streaks.
  //
  // NESTED LOGARITHMICALLY, AND THE COUNTS EQUALISE SCREEN DENSITY, NOT VOLUME
  // DENSITY. The screen area a depth shell covers goes as r^2, so a volume that
  // holds a constant drops-per-cubic-metre paints fewer and fewer pixels the
  // nearer it is. With 900 drops in a 17 m box against 3800 in an 86 m one, the
  // near layer contributed about a sixth of the screen density of the other two
  // - and the near layer is the ONLY one that survives an eight-metre occluder,
  // because mid and far are depth-tested away by the container in front of you.
  // That is why container flanks - which is most of this level - photographed
  // dry while the open sky above them photographed wet. Re-spacing to 1-8 / 8-24
  // / 24-70 m and moving 1700 instances from far to near equalises density * r^2
  // across the three at a flat total instance count.
  var LAYER_DEFS = [
    { n: 'near', c: 2100, b: [14, 13, 14], f: 11.4, w: 1.00, l: 0.18, wd: 0.0095, bl: 1.90, nf: 1.10, ff: 17, g: 0.42, ro: 13 },
    { n: 'mid',  c: 3100, b: [34, 26, 34], f: 9.60, w: 0.92, l: 0.26, wd: 0.0082, bl: 1.15, nf: 0.90, ff: 40, g: 0.46, ro: 12 },
    { n: 'far',  c: 1900, b: [70, 44, 70], f: 7.60, w: 0.80, l: 0.21, wd: 0.0062, bl: 0.65, nf: 2.00, ff: 82, g: 0.38, ro: 11 }
  ];

  // The fourth volume, and it does not live in ctx.scene. postfx renders
  // ctx.viewScene into its own target with a CLEARED depth buffer and composites
  // it over the world, so nothing in the world scene can ever draw in front of
  // the weapon: every streak in the level stopped dead at the receiver and the
  // player stood in a downpour inside a dry bubble. This one is parented to the
  // viewmodel scene instead, in camera-local space, and the same RAIN_VERT works
  // unchanged because three feeds viewMatrix/projectionMatrix per camera.
  var VIEW_DEF = {
    n: 'view', c: 480, b: [2.8, 2.4, 2.8], f: 11.4, w: 1.00, l: 0.085,
    wd: 0.0072, bl: 2.5, nf: 0.09, ff: 2.6, g: 0.62, ro: 3
  };

  Weather.prototype._buildRain = function () {
    var li;
    for (li = 0; li < LAYER_DEFS.length; li++) {
      this._makeRainLayer(LAYER_DEFS[li], false);
    }
    this._buildViewRain();
  };

  // THE RESTING COLOUR OF A DROP OUTSIDE EVERY LAMP CONE.
  //
  // A raindrop is a clear dielectric sphere. It emits nothing; it is visible
  // only as whatever it scatters, and at 02:00 under storm cloud, in the black
  // between the sodium pools, that is a very small amount of skylight.
  //
  // It was 0.20/0.25/0.33, then 0.136/0.170/0.224, and both were still a
  // BRIGHTNESS FLOOR INDEPENDENT OF THE LIGHT RIG - which is precisely what
  // makes rain read as a particle effect. Measured on the previous value:
  // streaks over unlit sky printed 0.327 against a 0.070 background and over the
  // unlit freighter hull 0.402 against 0.061, i.e. drops tens of metres from any
  // source were five to six times brighter than the scene they fell through, and
  // rain was the single highest-contrast element in the frame. It also
  // compresses every bit of variation the field does have into the top of the
  // range, which is why it read as uniform as well as as bright.
  //
  // Everything the eye reads now comes from gbSampleLights - so the rain appears
  // inside the pools and thins between them, and the gustiness and density
  // variation the brief asks for arrive as a free consequence of the light rig
  // instead of as a second noise function layered on top of it.
  //
  // MEASURED TWICE. At 0.058/0.073/0.100 a streak over unlit sky in gangway.png
  // still printed p99.7 = 0.410 against a 0.062 local background - a 6.6:1
  // ratio, i.e. rain was STILL the highest-contrast element in the frame, and
  // still more contrasty outside a lamp cone (6.6:1) than inside one (2.8:1),
  // which is exactly backwards. Halving it again and taking two thirds of the
  // unlit drop's ALPHA as well (see the `0.34 + 3.4*lit` term in RAIN_VERT)
  // takes the unlit ratio to ~3:1 while leaving a lit streak untouched, because
  // a lit streak's radiance is dominated by gbSampleLights and not by this.
  // Cut once more after re-measuring: 0.030 still left the unlit sky streak at
  // 6.0:1 against its background where the lit-cone streak sits at 2.8:1, and
  // rain must not be more contrasty outside a lamp than inside one.
  var RAIN_BASE_COL = [0.019, 0.024, 0.033];

  Weather.prototype._makeRainLayer = function (D, isView) {
    var U = this.uniforms;
    var count = Math.max(60, Math.round(D.c * this.qp));
    var geo = instancedQuads(count);
    var base = iattr(geo, 'aBase', 3, count);
    var rand = iattr(geo, 'aRand', 4, count);
    for (var i = 0; i < count; i++) {
      base.array[i * 3] = this.rng.next();
      base.array[i * 3 + 1] = this.rng.next();
      base.array[i * 3 + 2] = this.rng.next();
      // Skewed speed variance: most drops sit near terminal velocity, a few
      // are big and fast. Uniform variance looks like noise, not like rain.
      var s = this.rng.next();
      rand.array[i * 4] = 0.72 + 0.68 * s * s;
      rand.array[i * 4 + 1] = this.rng.range(0.62, 1.55);
      rand.array[i * 4 + 2] = this.rng.next();
      rand.array[i * 4 + 3] = this.rng.next();
    }
    base.needsUpdate = true;
    rand.needsUpdate = true;

    var mat = new THREE.ShaderMaterial({
      uniforms: {
        // uCentre must be PER LAYER: the forward bias scales with the layer's
        // own box, so one shared vector would put every volume in one place.
        uCentre: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector3(D.b[0], D.b[1], D.b[2]) },
        uDrift: { value: new THREE.Vector3() },
        uVel: { value: new THREE.Vector3() },
        uLen: { value: D.l },
        uWidth: { value: D.wd },
        uPixelScale: U.uPixelScale,
        uNearFade: { value: D.nf },
        uFarFade: { value: D.ff },
        uRain: U.uRain,
        uFlash: U.uFlash,
        uFlashCol: U.uFlashCol,
        uBaseCol: { value: new THREE.Color(RAIN_BASE_COL[0], RAIN_BASE_COL[1], RAIN_BASE_COL[2]) },
        // WARM, where uBaseCol is cold, and that is physics rather than a grade
        // dial. An unlit drop scatters the cold skylight and nothing else, so
        // the near field is a blue glint. The airlight is what the rain COLUMN
        // between the drop and the lens is glowing with, and over a terminal
        // running twenty sodium masts at 02:00 that column is orange - it is the
        // same effect as the sodium dome over a city seen from outside it.
        // Only mildly warm, and that is a measurement rather than taste: pushing
        // it to full sodium moved gangway.png's grade_split the WRONG way
        // (-0.025 -> -0.038), which is the proof that the veil sits in the
        // mid-tones and is not what is making that frame's highlights cool - the
        // cold mercury floods over the whole quay are. Same luminance as the
        // cold version it replaced, a slight sodium bias, no grade chasing.
        uAirCol: { value: new THREE.Color(0.108, 0.098, 0.086) },
        uGain: { value: D.g },
        uMaxPx: U.uMaxPx,
        // The far volume is entirely sub-pixel - at 60 m a 6 mm drop is a
        // fifteenth of a texel and the 0.14 floor annihilated it, which is why
        // the establishing shot had 3.9% rain coverage over the terminal and
        // 8.1% over empty sky. It is not trying to be individual streaks out
        // there; it is the veil, and a veil needs to survive the clamp.
        uSubpixFloor: { value: D.n === 'far' ? 0.26 : 0.14 },
        // The viewmodel volume is 2.8 m across; extinction over it is nothing,
        // and there is no fog in the viewmodel pass to hand it to.
        uFogSigma: isView ? { value: 0 } : U.uFogSigma,
        uSheetDir: U.uSheetDir,
        uSheetPhase: U.uSheetPhase,
        uRoofMap: U.uRoofMap,
        uRoofRect: U.uRoofRect,
        uRoofScale: U.uRoofScale,
        uLightXf: { value: new THREE.Matrix4() },
        uLightPos: U.uLightPos,
        uLightDir: U.uLightDir,
        uLightCol: U.uLightCol,
        uDepth: U.uDepth,
        // No depth copy exists for the viewmodel pass, and it does not need one:
        // the gun is the only thing in that scene and it is opaque.
        uSoft: isView ? { value: 0 } : U.uSoft,
        uInvRes: U.uInvRes,
        uSoftDist: { value: 0.65 },
        uBlur: { value: D.bl }
      },
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // The world volumes add light to an already-composited frame. The
      // viewmodel volume is resolved by postfx as mix(world, view.rgb, view.a),
      // so it has to produce a straight OVER composite in its own target
      // instead: premultiplied 'one / one-minus-src-alpha' does exactly that
      // from a vec4(colour, alpha) fragment over a zeroed clear.
      blending: isView ? THREE.NormalBlending : THREE.AdditiveBlending,
      premultipliedAlpha: !!isView,
      side: THREE.DoubleSide,
      fog: false
    });

    var mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = D.ro;
    mesh.name = 'rain-' + D.n;

    var rec = {
      def: D, mesh: mesh, mat: mat, count: count,
      centre: mat.uniforms.uCentre.value,
      drift: mat.uniforms.uDrift.value,
      vel: mat.uniforms.uVel.value,
      box: mat.uniforms.uBox.value,
      xf: mat.uniforms.uLightXf.value
    };
    if (!isView) {
      this.root.add(mesh);
      this.layers.push(rec);
    }
    return rec;
  };

  // --------------------------------------------------------------------------
  // Viewmodel-scene water: rain across the gun, and beads on the front element.
  // Both are guarded on ctx.viewScene existing; a build with no viewmodel simply
  // has neither.
  // --------------------------------------------------------------------------
  Weather.prototype._buildViewRain = function () {
    var ctx = this.ctx;
    if (!ctx || !ctx.viewScene) return;
    try {
      this.viewRain = this._makeRainLayer(VIEW_DEF, true);
      this._buildBeads();
    } catch (e) {
      GAME.logError('weather.viewRain', e);
      this.viewRain = null;
    }
  };

  Weather.prototype._buildBeads = function () {
    // ART_DIRECTION_HARBOR: "restrained - this is not a car-window effect."
    // 34 beads at ~2 cm covers well under 3% of frame area at peak.
    var count = Math.max(18, Math.round(34 * this.qp));
    var geo = instancedQuads(count);
    var base = iattr(geo, 'aBase', 4, count);
    var rand = iattr(geo, 'aRand', 4, count);
    for (var i = 0; i < count; i++) {
      // Spawn radius weighted outward: sqrt() would be uniform in area, and
      // ^0.35 pushes the population toward the frame edges, which is where the
      // art direction wants it and where it cannot sit over the reticle.
      var ang = this.rng.range(0, M.TAU);
      var rad = Math.pow(this.rng.next(), 0.35) * 1.15;
      base.array[i * 4] = Math.cos(ang) * rad;
      base.array[i * 4 + 1] = Math.sin(ang) * rad * 0.82;
      base.array[i * 4 + 2] = this.rng.range(0.075, 0.30);   // 3-13 s per bead
      base.array[i * 4 + 3] = this.rng.next();
      rand.array[i * 4] = this.rng.range(0.010, 0.032);
      rand.array[i * 4 + 1] = this.rng.next();
      rand.array[i * 4 + 2] = this.rng.range(0.4, 1.4);
      rand.array[i * 4 + 3] = this.rng.next();
    }
    base.needsUpdate = true; rand.needsUpdate = true;

    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uPlaneHalf: { value: new THREE.Vector2(0.06, 0.10) },
        uTime: this.uniforms.uTime,
        uWet: { value: 0 },
        uSmear: { value: new THREE.Vector2(0, -1) },
        uSmearLen: { value: 0 },
        uRimCol: { value: new THREE.Color(0.055, 0.068, 0.088) },
        uCoreCol: { value: new THREE.Color(0.006, 0.008, 0.011) }
      },
      vertexShader: BEAD_VERT,
      fragmentShader: BEAD_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
      premultipliedAlpha: true,
      side: THREE.DoubleSide,
      fog: false
    });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 4;
    mesh.name = 'lens-beads';
    this.beads = { mesh: mesh, mat: mat, count: count };
  };

  // --------------------------------------------------------------------------
  // Splash rings + thrown droplets. Both are ring buffers sized so the oldest
  // slot is always dead before it is reused: a pool with none of a pool's
  // bookkeeping, and the highest-count effect in the level.
  // --------------------------------------------------------------------------
  Weather.prototype._buildSplash = function () {
    var U = this.uniforms;
    var i;

    // Sized off the emission rate, not off a round number: at 52 rings a frame
    // and a 0.46 s worst-case life the buffer has to hold 52 * 60 * 0.46 = 1435
    // live instances, and the ring pointer must not lap a slot that is still
    // drawing. 1900 gives 0.61 s against a 0.46 s worst case.
    // Doubled with the crown: every impact now writes TWO instances (ring +
    // crown) so the head walks the buffer twice as fast, and the pointer must
    // still never lap a slot that is still drawing.
    var ringCap = Math.max(192, Math.round(3600 * this.qp));
    var geo = instancedQuads(ringCap);
    var ro = iattr(geo, 'aOrigin', 4, ringCap);
    var rr = iattr(geo, 'aRand', 4, ringCap);
    for (i = 0; i < ringCap; i++) { ro.array[i * 4 + 3] = -1000; rr.array[i * 4 + 1] = 0.4; }
    ro.needsUpdate = true; rr.needsUpdate = true;

    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: U.uTime,
        uFlash: U.uFlash,
        uFlashCol: U.uFlashCol,
        uBaseCol: { value: new THREE.Color(0.15, 0.19, 0.25) },
        // The apron is #16191c: near-black by art direction. An additive ring
        // has to be well above unity gain to register on it at all.
        uGain: { value: 1.55 },
        uLightPos: U.uLightPos,
        uLightDir: U.uLightDir,
        uLightCol: U.uLightCol
      },
      vertexShader: SPLASH_VERT,
      fragmentShader: SPLASH_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false
    });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 9;
    mesh.name = 'rain-splash';
    this.root.add(mesh);
    this.splash = { mesh: mesh, mat: mat, cap: ringCap, head: 0, o: ro, r: rr, dirty: false };

    var dCap = Math.max(256, Math.round(3200 * this.qp));
    var dgeo = instancedQuads(dCap);
    var dOrigin = iattr(dgeo, 'aOrigin', 4, dCap);
    var dVel = iattr(dgeo, 'aVel', 4, dCap);
    var dRand = iattr(dgeo, 'aRand', 4, dCap);
    for (i = 0; i < dCap; i++) { dOrigin.array[i * 4 + 3] = -1000; dVel.array[i * 4 + 3] = 0.35; }
    dOrigin.needsUpdate = true; dVel.needsUpdate = true; dRand.needsUpdate = true;

    var dmat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: U.uTime,
        uPixelScale: U.uPixelScale,
        uFlash: U.uFlash,
        uFlashCol: U.uFlashCol,
        uBaseCol: { value: new THREE.Color(0.19, 0.24, 0.31) },
        // At 0.80 gain and 7-18 mm the thrown spray contributed nothing that
        // could be measured in any capture. Twice the gain and twice the size is
        // what makes an impact read as water rather than as a ring decal.
        uGain: { value: 1.60 },
        uLightPos: U.uLightPos,
        uLightDir: U.uLightDir,
        uLightCol: U.uLightCol
      },
      vertexShader: DROP_VERT,
      fragmentShader: DROP_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false
    });
    var dmesh = new THREE.Mesh(dgeo, dmat);
    dmesh.frustumCulled = false;
    dmesh.matrixAutoUpdate = false;
    dmesh.renderOrder = 10;
    dmesh.name = 'rain-droplets';
    this.root.add(dmesh);
    this.drops = {
      mesh: dmesh, mat: dmat, cap: dCap, head: 0,
      o: dOrigin, v: dVel, r: dRand, dirty: false
    };
  };

  // --------------------------------------------------------------------------
  // Drips. Emitters are harvested from the level's own collision boxes: the top
  // edge of anything at container height or above is, physically, a place where
  // water runs off. That puts the drips on the real silhouette of the set
  // without level_harbor having to publish a thing - and if it does publish
  // `dripEdges`, that wins.
  // --------------------------------------------------------------------------
  Weather.prototype._buildDrips = function (ctx) {
    var U = this.uniforms;
    var cap = Math.max(48, Math.round(200 * this.qp));
    var geo = instancedQuads(cap);
    var o = iattr(geo, 'aOrigin', 4, cap);
    var r = iattr(geo, 'aRand', 4, cap);

    var edges = this._collectDripEdges(ctx, cap);
    var n = edges.length;
    this._dripFeet = [];
    for (var i = 0; i < cap; i++) {
      var e = n ? edges[i % n] : null;
      if (!e) {
        // No level geometry: park the instance far under the floor rather than
        // leaving a stripe of zeroes at the world origin.
        o.array[i * 4] = 0; o.array[i * 4 + 1] = -9999; o.array[i * 4 + 2] = 0;
        o.array[i * 4 + 3] = 0;
        r.array[i * 4] = 0.4; r.array[i * 4 + 1] = 0.5;
        r.array[i * 4 + 2] = 0.004; r.array[i * 4 + 3] = 0;
        continue;
      }
      o.array[i * 4] = e.x;
      o.array[i * 4 + 1] = e.y;
      o.array[i * 4 + 2] = e.z;
      o.array[i * 4 + 3] = this.rng.next();
      // Waves per second down the rope, and the rope's own width. 1-3 cm is a
      // real running edge; the 4-17 mm it used to be was a detaching bead, which
      // is a different (and, at these distances, invisible) phenomenon.
      var fat = this.rng.bool(0.30);
      r.array[i * 4] = fat ? this.rng.range(0.55, 1.10) : this.rng.range(1.20, 2.40);
      r.array[i * 4 + 1] = Math.max(0.5, e.fall);
      r.array[i * 4 + 2] = fat ? this.rng.range(0.019, 0.030) : this.rng.range(0.010, 0.019);
      r.array[i * 4 + 3] = this.rng.range(0.03, 0.13);
      // Where the rope lands. The ribbon itself breaks up well short of the
      // deck, but the water still arrives, so the foot of every stream feeds the
      // splash emitter - a wet-set cue that costs one array entry.
      if (this._dripFeet.length < 288 && e.fall > 0.7) {
        this._dripFeet.push(e.x, this._groundY + 0.006, e.z);
      }
    }
    o.needsUpdate = true; r.needsUpdate = true;

    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: U.uTime,
        uPixelScale: U.uPixelScale,
        uWindDir: U.uWindDir,
        uRain: U.uRain,
        uFlash: U.uFlash,
        uFlashCol: U.uFlashCol,
        uBaseCol: { value: new THREE.Color(0.17, 0.22, 0.29) },
        uGain: { value: 1.0 },
        uLightPos: U.uLightPos,
        uLightDir: U.uLightDir,
        uLightCol: U.uLightCol,
        uDepth: U.uDepth,
        uSoft: U.uSoft,
        uInvRes: U.uInvRes,
        uSoftDist: { value: 0.35 }
      },
      vertexShader: DRIP_VERT,
      fragmentShader: DRIP_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false
    });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 14;
    mesh.name = 'rain-drips';
    this.root.add(mesh);
    this.drips = { mesh: mesh, mat: mat, cap: cap, o: o, r: r, count: n };
  };

  Weather.prototype._collectDripEdges = function (ctx, cap) {
    var out = [];
    try {
      var lvl = ctx && ctx.level;
      if (!lvl) return out;

      var pub = lvl.dripEdges || lvl.ledges;
      if (Array.isArray(pub) && pub.length) {
        for (var p = 0; p < pub.length && out.length < cap; p++) {
          var pe = pub[p];
          var pos = pe && (pe.position || pe.point || pe);
          if (!pos || !isFinite(pos.x) || !isFinite(pos.y)) continue;
          out.push({ x: pos.x, y: pos.y, z: pos.z, fall: isFinite(pe.fall) ? pe.fall : 2.4 });
        }
        if (out.length) return out;
      }

      var cols = lvl.colliders;
      if (!Array.isArray(cols) || !cols.length) return out;

      var cands = [];
      for (var i = 0; i < cols.length; i++) {
        var c = cols[i];
        if (!c || c.type === 'sphere' || !c.halfExtents || !c.center) continue;
        var h = c.halfExtents, ce = c.center;
        var top = ce.y + h.y;
        if (top < 1.6 || top > 26) continue;         // gutter height to crane walkway
        if (h.x < 0.45 || h.z < 0.45) continue;      // a post has no ledge
        if (h.x > 40 || h.z > 40) continue;          // that is the ground plane
        cands.push(c);
      }
      if (!cands.length) return out;

      // CLUSTERED, AND CLUSTERED WHERE THE PLAYER IS LOOKING. Two hundred single
      // ropes scattered uniformly over a 90 x 70 m terminal is one rope every
      // 30 m2 - statistically invisible. Water runs off a corner casting in a
      // sheet of five or six adjacent streams, and the budget belongs on the
      // edges nearest the published camera poses, not spread evenly over a set
      // the player only ever sees a tenth of at a time.
      var focus = [];
      var poses = lvl.cameraPoses;
      if (poses) {
        for (var pk in poses) {
          var pp = poses[pk] && poses[pk].position;
          if (pp && isFinite(pp.x)) focus.push(pp);
        }
      }
      var ranked = [];
      for (var ci = 0; ci < cands.length; ci++) {
        var cb = cands[ci];
        var best = 1e9;
        for (var fi = 0; fi < focus.length; fi++) {
          var fdx = cb.center.x - focus[fi].x, fdz = cb.center.z - focus[fi].z;
          var fd = fdx * fdx + fdz * fdz;
          if (fd < best) best = fd;
        }
        ranked.push({ c: cb, d: focus.length ? best : this.rng.next() * 1e4 });
      }
      ranked.sort(function (a, b) { return a.d - b.d; });
      // Everything within 34 m of some hero mark, capped so a small level still
      // gets a spread.
      var pool = [];
      for (var ri = 0; ri < ranked.length; ri++) {
        if (pool.length >= 8 || ranked[ri].d < 1156) pool.push(ranked[ri].c);
        if (pool.length >= 26) break;
      }
      if (!pool.length) pool = cands;

      var want = Math.min(cap, 200);
      while (out.length < want) {
        var box = pool[Math.floor(this.rng.next() * pool.length) % pool.length];
        var hh = box.halfExtents, cc = box.center;
        var side = this.rng.int(0, 3);
        var t0 = this.rng.range(-0.90, 0.72);
        var run = this.rng.int(4, 8);
        for (var q = 0; q < run && out.length < want; q++) {
          var t = M.clamp(t0 + q * 0.055 + this.rng.range(-0.012, 0.012), -0.94, 0.94);
          var lx = 0, lz = 0;
          if (side === 0) { lx = t * hh.x; lz = hh.z; }
          else if (side === 1) { lx = t * hh.x; lz = -hh.z; }
          else if (side === 2) { lx = hh.x; lz = t * hh.z; }
          else { lx = -hh.x; lz = t * hh.z; }
          _v1.set(lx, hh.y, lz);
          if (box.quaternion) _v1.applyQuaternion(box.quaternion);
          _v1.add(cc);
          var fall = Math.min(2.6, Math.max(0.55, (_v1.y - this._groundY) * 0.5));
          out.push({ x: _v1.x, y: _v1.y + 0.02, z: _v1.z, fall: fall });
        }
      }
    } catch (e) {
      GAME.logError('weather.dripEdges', e);
    }
    return out;
  };

  // --------------------------------------------------------------------------
  // ROOF MASK. "Rain falls indoors" is the flat-2D-overlay tell, and a
  // camera-relative volume with no occlusion test rains on you inside a covered
  // building. A per-drop raycast is impossible in a vertex shader and a
  // per-respawn one does not exist (there are no respawns - the volume wraps in
  // the shader), so the level is baked ONCE into a coarse world-XZ grid of "the
  // highest sheltering surface over this square metre" and the shader reads it.
  // Deterministic, one texel fetch, and it doubles as a free occlusion cull:
  // drops inside a solid container stack stop being drawn at all.
  // --------------------------------------------------------------------------
  Weather.prototype._buildRoofMask = function (ctx) {
    try {
      var lvl = ctx && ctx.level;
      if (!lvl) return;
      var rects = [], holes = [];
      var i;

      // An explicit publication always wins.
      var pub = lvl.rainShelters;
      if (Array.isArray(pub)) {
        for (i = 0; i < pub.length; i++) {
          var ps = pub[i];
          if (!ps || !isFinite(ps.x0) || !isFinite(ps.h)) continue;
          rects.push({ x0: Math.min(ps.x0, ps.x1), x1: Math.max(ps.x0, ps.x1),
                       z0: Math.min(ps.z0, ps.z1), z1: Math.max(ps.z0, ps.z1), h: ps.h });
        }
      }

      // The warehouse is a shed: its roof is geometry, not collision, so no
      // collider describes it. level_harbor publishes the footprint by name.
      var A = lvl.anchors;
      if (A && A.warehouse && isFinite(A.warehouse.x0)) {
        var w = A.warehouse;
        rects.push({
          x0: Math.min(w.x0, w.x1) + 0.30, x1: Math.max(w.x0, w.x1) - 0.30,
          z0: Math.min(w.z0, w.z1) + 0.30, z1: Math.max(w.z0, w.z1) - 0.30,
          // THE RIDGE, NOT THE EAVE. Taking the eave left the 1.8 m of volume
          // between the two inside the shed unmasked, and warehouse.png came
          // back with lit streaks running through the roof trusses.
          h: (isFinite(w.ridge) ? w.ridge : (isFinite(w.eave) ? w.eave + 2.2 : 9.0)) + 0.5
        });
        // ...except through the hole in it, which is the whole point of the
        // warehouse framing: rain and a shaft of light coming through the roof.
        if (w.roofHole && isFinite(w.roofHole.x)) {
          holes.push({ x: w.roofHole.x, z: w.roofHole.z, r: 2.1 });
        }
      }

      var cols = lvl.colliders;
      if (Array.isArray(cols)) {
        for (i = 0; i < cols.length; i++) {
          var c = cols[i];
          if (!c || c.floor || c.type === 'sphere' || !c.halfExtents || !c.center) continue;
          // A rotated footprint's AABB is bigger than the footprint, so the
          // conservative shrink below would stop being conservative. There are
          // very few of them; skip rather than over-cover the apron.
          if (c.quaternion && Math.abs(c.quaternion.w) < 0.9995) continue;
          var h = c.halfExtents, ce = c.center;
          if (h.x < 1.0 || h.z < 1.0 || h.x > 30 || h.z > 30) continue;
          var top = ce.y + h.y;
          if (top < this._groundY + 2.6 || top > this._groundY + 40) continue;
          var ex = h.x - 0.55, ez = h.z - 0.55;
          if (ex < 0.35 || ez < 0.35) continue;
          rects.push({ x0: ce.x - ex, x1: ce.x + ex, z0: ce.z - ez, z1: ce.z + ez, h: top });
        }
      }
      if (!rects.length) return;

      var minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
      for (i = 0; i < rects.length; i++) {
        var R = rects[i];
        if (R.x0 < minX) minX = R.x0;
        if (R.x1 > maxX) maxX = R.x1;
        if (R.z0 < minZ) minZ = R.z0;
        if (R.z1 > maxZ) maxZ = R.z1;
      }
      minX -= 3; maxX += 3; minZ -= 3; maxZ += 3;
      var spanX = Math.max(4, maxX - minX), spanZ = Math.max(4, maxZ - minZ);
      var S = 128;
      var data = new Uint8Array(S * S * 4);
      var inv = 1 / this._roofScale;
      for (var gz = 0; gz < S; gz++) {
        var wz = minZ + (gz + 0.5) / S * spanZ;
        for (var gx = 0; gx < S; gx++) {
          var wx = minX + (gx + 0.5) / S * spanX;
          var best = 0;
          for (i = 0; i < rects.length; i++) {
            var Q = rects[i];
            if (wx < Q.x0 || wx > Q.x1 || wz < Q.z0 || wz > Q.z1) continue;
            if (Q.h > best) best = Q.h;
          }
          if (best > 0) {
            for (i = 0; i < holes.length; i++) {
              var hx = wx - holes[i].x, hz = wz - holes[i].z;
              if (hx * hx + hz * hz < holes[i].r * holes[i].r) { best = 0; break; }
            }
          }
          var o = (gz * S + gx) * 4;
          var v = Math.round(M.saturate(best * inv) * 255);
          data[o] = v; data[o + 1] = v; data[o + 2] = v; data[o + 3] = 255;
        }
      }
      var tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
      tex.colorSpace = THREE.NoColorSpace;
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      tex.name = 'weather.roofMask';
      this._roofTex = tex;
      this._roofData = data;
      this._roofSize = S;
      this._roofRect.set(minX, minZ, 1 / spanX, 1 / spanZ);
      this.uniforms.uRoofMap.value = tex;
      this.roofMask = { texture: tex, origin: [minX, minZ], span: [spanX, spanZ], scale: this._roofScale };
    } catch (e) {
      GAME.logError('weather.roofMask', e);
    }
  };

  // --------------------------------------------------------------------------
  Weather.prototype._buildMist = function () {
    this._mistMap = mistTexture(this.noise);
    // THE BOX WAS 3.4 m TALL, i.e. a knee-high fog band, and the mast cones are
    // WIDEST at 5-12 m. Nothing the module contributed ever intersected a cone
    // at the height where it has any area, which is exactly why the cones
    // photographed as smooth structureless grey wedges instead of as lit air -
    // and "lamps with no visible volumetric cone in the downpour" is on the
    // instant-fail list. Two thirds of the cards keep the y^1.7 ground bias so
    // the ground band is unchanged; the other third is spread uniformly from 3
    // to 14 m so banks cross the cones where the cones are.
    //
    // MEASURED AND PULLED BACK ONCE. The first attempt at this raised the card
    // count with the ceiling and pushed the quay spray box from 3 to 7 m, and
    // gangway.png came back at mean 0.238 against a 0.10-0.18 target with
    // grade_split at -0.048: these are NORMAL-blended cards, they compound, and
    // a standing-height card at 0.4 alpha two of them deep is a lid. The ground
    // band is now byte-for-byte the population it always had (44 cards inside
    // the bottom 3.5 m) and the height is bought with 20 EXTRA cards at a third
    // of the opacity - enough to give a cone some structure at 6-12 m, not
    // enough to be a veil.
    this.mist = this._makeMistLayer('mist', Math.max(16, Math.round(64 * this.qp)),
      [86, 13.0, 86], [7.0, 14.0], [1.6, 4.2],
      new THREE.Color(0.055, 0.072, 0.088), 0.30, 5, 0.27);
    this.spray = this._makeMistLayer('spray', Math.max(12, Math.round(38 * this.qp)),
      [24, 3.6, 24], [3.0, 6.5], [1.2, 2.9],
      new THREE.Color(0.085, 0.105, 0.125), 0.42, 6, 1.0);
    // Spray stays dark until a quay line is found.
    this.spray.mesh.visible = false;
  };

  Weather.prototype._makeMistLayer = function (name, count, box, wRange, hRange, col, gain, order, groundFrac) {
    var U = this.uniforms;
    var gf = isFinite(groundFrac) ? groundFrac : 1.0;
    var geo = instancedQuads(count);
    var base = iattr(geo, 'aBase', 4, count);
    var rand = iattr(geo, 'aRand', 4, count);
    for (var i = 0; i < count; i++) {
      var high = (gf < 0.999) && (i % 3 === 2);
      base.array[i * 4] = this.rng.next();
      // Two thirds hug the ground inside the bottom `gf` of the box; the rest
      // stand up through it so a bank can cross a lamp cone at cone height.
      base.array[i * 4 + 1] = high
        ? this.rng.range(gf * 0.90, 1.0)
        : Math.pow(this.rng.next(), 1.7) * gf;
      base.array[i * 4 + 2] = this.rng.next();
      base.array[i * 4 + 3] = this.rng.next();
      rand.array[i * 4] = this.rng.range(wRange[0], wRange[1]);
      rand.array[i * 4 + 1] = this.rng.range(hRange[0], hRange[1]);
      // The high cards are a THIRD of the opacity of the ground band. They are
      // there to let a lamp cone find something to scatter off at 6-12 m, not
      // to put a second fog deck over the terminal.
      rand.array[i * 4 + 2] = high ? this.rng.range(0.0, 0.22) : this.rng.next();
      rand.array[i * 4 + 3] = this.rng.range(0.55, 1.35);
    }
    base.needsUpdate = true; rand.needsUpdate = true;

    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uCentre: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector3(box[0], box[1], box[2]) },
        uDrift: { value: new THREE.Vector3() },
        uGroundY: { value: 0 },
        uTime: U.uTime,
        uFlash: U.uFlash,
        uFlashCol: U.uFlashCol,
        uBaseCol: { value: col },
        uGain: { value: gain },
        uLightPos: U.uLightPos,
        uLightDir: U.uLightDir,
        uLightCol: U.uLightCol,
        uDepth: U.uDepth,
        uSoft: U.uSoft,
        uInvRes: U.uInvRes,
        uSoftDist: { value: 2.2 },
        uMap: { value: this._mistMap }
      },
      vertexShader: MIST_VERT,
      fragmentShader: MIST_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      fog: false
    });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = order;
    mesh.name = 'weather-' + name;
    this.root.add(mesh);
    return {
      mesh: mesh, mat: mat, count: count,
      centre: mat.uniforms.uCentre.value,
      drift: mat.uniforms.uDrift.value,
      box: mat.uniforms.uBox.value
    };
  };

  // --------------------------------------------------------------------------
  // The visible channel. Without it a strike is an exposure change: the frame
  // gets brighter and nothing in it says LIGHTNING. One camera-facing quad
  // parked along flashDir, the bolt drawn procedurally in the fragment stage,
  // alive only while a return stroke is.
  // --------------------------------------------------------------------------
  Weather.prototype._buildChannel = function () {
    var g = new THREE.PlaneGeometry(1, 1);
    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uSize: { value: new THREE.Vector2(90, 300) },
        uCol: { value: new THREE.Color(0.70, 0.81, 1.0) },
        uAmp: { value: 0 },
        uSeed: { value: 0 }
      },
      vertexShader: CHAN_VERT,
      fragmentShader: CHAN_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false
    });
    var mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 8;
    mesh.name = 'lightning-channel';
    mesh.visible = false;
    this.root.add(mesh);
    this._channel = { mesh: mesh, mat: mat };
  };

  Weather.prototype._buildRipples = function (ctx) {
    this._ripples = new RippleField(this.rng.fork(0x2211));
    this.rippleTexture = this._ripples.rt.texture;
    this.rippleNormal = this.rippleTexture;
    this.uniforms.uRippleMap.value = this.rippleTexture;
    this.uniforms.uRippleTiling.value = this.rippleTiling;
    // Announce it once so materials.js can wire up without polling us.
    var bus = (ctx && ctx.bus) || GAME.bus;
    if (bus && bus.emit) {
      bus.emit('weather:ripples', {
        texture: this.rippleTexture,
        tiling: this.rippleTiling,
        uniform: this.uniforms.uRippleMap
      });
    }
  };

  Weather.prototype._guessGroundY = function (ctx) {
    try {
      var lvl = ctx && ctx.level;
      if (lvl && Array.isArray(lvl.spawnPoints) && lvl.spawnPoints.length &&
          lvl.spawnPoints[0].position && isFinite(lvl.spawnPoints[0].position.y)) {
        return lvl.spawnPoints[0].position.y;
      }
      if (lvl && isFinite(lvl.groundY)) return lvl.groundY;
    } catch (e) { /* 0 is a perfectly good answer */ }
    return 0;
  };

  // --------------------------------------------------------------------------
  // Preset selection. Activation is lazy: nothing joins the scene, no texture
  // is allocated and no light exists until a wet preset is chosen. That is what
  // makes level 1 provably untouched.
  // --------------------------------------------------------------------------
  Weather.prototype.setPreset = function (name) {
    var p = PRESETS[name];
    if (!p) return this.preset;
    this.preset = name;
    this._target = p;
    if (p.rain > 0.001 || p.mist > 0.001 || p.lightning > 0) this._activate();
    else this._deactivate();
    return this.preset;
  };

  Weather.prototype._activate = function () {
    this.active = true;
    var ctx = this.ctx;
    if (!ctx || !ctx.scene) return;
    if (!this._built) this._buildResources(ctx);
    if (this.root.parent !== ctx.scene) ctx.scene.add(this.root);
    this.root.visible = this.enabled;
    // The viewmodel-scene water is parented separately, because that scene is
    // the only one that composites in front of the weapon.
    if (ctx.viewScene) {
      if (!this.viewRain && !this.beads) this._buildViewRain();
      if (this.viewRain && this.viewRain.mesh.parent !== ctx.viewScene) {
        ctx.viewScene.add(this.viewRain.mesh);
      }
      if (this.beads && this.beads.mesh.parent !== ctx.viewScene) {
        ctx.viewScene.add(this.beads.mesh);
      }
    }
    this._ensureLightning(ctx);
  };

  Weather.prototype._deactivate = function () {
    this.active = false;
    this.flash = 0;
    this.rainIntensity = 0;
    this.rippleStrength = 0;
    this.lensWetness = 0;
    this.uniforms.uRain.value = 0;
    this.uniforms.uFlash.value = 0;
    if (this._flashLight) this._flashLight.intensity = 0;
    if (this._flashFill) this._flashFill.intensity = 0;
    if (this.root.parent) this.root.parent.remove(this.root);
    this.root.visible = false;
    if (this.viewRain && this.viewRain.mesh.parent) {
      this.viewRain.mesh.parent.remove(this.viewRain.mesh);
    }
    if (this.beads && this.beads.mesh.parent) {
      this.beads.mesh.parent.remove(this.beads.mesh);
    }
  };

  // --------------------------------------------------------------------------
  // Lightning rig. A real DirectionalLight with a real shadow map: "lightning
  // as a full-screen white fade" is on the instant-fail list precisely because
  // a fade cannot move a shadow.
  //
  // The shadow map is on manual update. Rendering the whole scene's depth every
  // frame for a light that is dark ~97% of the time is waste, but toggling
  // castShadow would change NUM_DIR_LIGHT_SHADOWS and recompile every material
  // in the level twice per strike. shadow.autoUpdate is the seam that buys the
  // cost of the first without the hitch of the second.
  // --------------------------------------------------------------------------
  Weather.prototype._ensureLightning = function (ctx) {
    if (this._flashLight || !ctx || !ctx.scene) return;
    try {
      var q = ctx.quality || {};
      var res = M.clamp((q.shadowRes | 0) || 2048, 512, 2048);

      // ART_DIRECTION_HARBOR names the colour, #dceaff, and it is competing
      // against sodium at #ff9a3c: the ONE thing the strike has to be is
      // unmistakably colder than the lamps it is overpowering. A 7000 K
      // blackbody is only slightly cool; the specified colour has real blue
      // separation, so the kelvin sample is pulled most of the way to it.
      var col = GAME.Color.kelvin(LIGHTNING_K, new THREE.Color());
      col.lerp(_c1.setRGB(0.66, 0.80, 1.0), 0.72);
      this.flashColor.copy(col);
      if (this._channel) this._channel.mat.uniforms.uCol.value.copy(col);

      // It is a SPOT light, and that is not a compromise - it is the only way
      // to get a real cast shadow out of this build.
      //
      // lighting.js patches three's `lights_fragment_begin` so that the
      // directional shadow lookup runs ONLY for UNROLLED_LOOP_INDEX == 0 (its
      // CSM sun); every other directional is deliberately shadow-free, because
      // in that rig they are cascade carriers and bounce fills. A second
      // shadow-casting DirectionalLight added here would render a 2048 shadow
      // map that nothing ever samples - the flash would relight geometry but
      // throw no shadow, which is exactly the failure the art direction calls
      // out. The spot path in that chunk is untouched, so a spot 200 m away
      // with a 24-degree cone is a parallel-enough light that DOES shadow.
      //
      // decay 0 + distance 0 removes all distance attenuation, so it behaves
      // like a directional in intensity as well as in direction.
      var l = new THREE.SpotLight(col.getHex(), 0);
      l.name = 'lightning';
      l.angle = 0.42;               // ~90 m cone radius at 200 m: the whole set
      l.penumbra = 0.45;
      l.decay = 0;
      l.distance = 0;
      l.castShadow = true;
      l.shadow.mapSize.set(res, res);
      l.shadow.bias = -0.0004;
      l.shadow.normalBias = 0.08;
      l.shadow.radius = 2.2;
      l.shadow.focus = 1.0;
      // near/far are ours; SpotLightShadow only overwrites `far` when
      // light.distance is non-zero, and it is not.
      l.shadow.camera.near = 100;
      l.shadow.camera.far = 360;
      l.shadow.autoUpdate = false;
      l.shadow.needsUpdate = true;
      l.position.set(60, 190, -40);

      var target = new THREE.Object3D();
      target.name = 'lightning-target';
      l.target = target;

      // Directional-only would leave every shadow at pure black, which is the
      // other thing on the instant-fail list. A cold hemisphere at ~16% of the
      // key keeps detail on the shadow side of a lit container.
      var fill = new THREE.HemisphereLight(0xcfe0ff, 0x1b2530, 0);
      fill.name = 'lightning-fill';

      ctx.scene.add(target);
      ctx.scene.add(l);
      ctx.scene.add(fill);
      this._flashLight = l;
      this._flashFill = fill;
      this._flashTarget = target;
      this.flashLight = l;
      this.flashFill = fill;
      this._shadowPrime = 3;
    } catch (e) {
      GAME.logError('weather.lightningRig', e);
    }
  };

  /**
   * Force a strike now. Scenarios call this so a capture always catches one
   * instead of depending on where the random interval happened to land.
   * opts (all optional): {distanceKm, azimuth, elevation}
   */
  Weather.prototype.strike = function (opts) {
    try {
      if (!this.active) this._activate();
      this._beginStrike(opts || null, true);
    } catch (e) {
      GAME.logError('weather.strike', e);
    }
    return this;
  };

  Weather.prototype._beginStrike = function (opts, forced) {
    var rng = this.lrng;

    // Distance drives brightness, the thunder delay, whether the report cracks
    // or rumbles - and, now, the ELEVATION. A forced strike is a CLOSE one: a
    // capture asking for lightning wants the shot the art direction describes,
    // not a distant flicker on the horizon.
    var km;
    if (opts && isFinite(opts.distanceKm)) km = opts.distanceKm;
    else if (forced) km = rng.range(0.20, 1.00);
    else km = rng.range(0.25, 3.60);
    var near = M.saturate(1 - (km - 0.15) / 3.45);

    // ELEVATION IS DERIVED FROM DISTANCE, not drawn independently, and that is
    // a correctness fix rather than a preference. A lightning channel is a
    // near-vertical column hanging from the cloud base; the angle you see it at
    // is fixed by how far away it is. It used to be a free draw over 0.32-0.95
    // rad, so a strike 200 m away could arrive at 18 degrees above the horizon -
    // geometrically impossible with a storm base at a kilometre, and visually
    // ruinous: at that angle a horizontal apron collects sin(18) = 0.31 of the
    // key while the air, the cloud deck and every vertical face collect all of
    // it. The `lightning` capture came back with a blown milky sky over a
    // completely black quay, vertical_imbalance 4.76.
    //
    // atan(cloudBase / distance) puts a 200 m strike at 79 degrees and a 3.6 km
    // one at 17, which is both what the sky does and what guarantees that a
    // forced (close, therefore high) strike relights the deck.
    var az;
    if (opts && isFinite(opts.azimuth)) {
      az = opts.azimuth;
    } else if (forced && this.ctx && this.ctx.camera) {
      // A FORCED strike is a capture asking for the shot the art direction
      // describes, and a bolt behind the lens is not that shot. Placed 3-15
      // degrees off the look axis, because in a container canyon the only sky
      // in the picture is the slot straight ahead - a bearing further out puts
      // the channel behind a four-high stack. Natural strikes stay uniform over
      // the full circle, which is where the contract's "varying direction"
      // lives; this branch only ever runs for a capture.
      this.ctx.camera.getWorldDirection(_v1);
      az = Math.atan2(_v1.z, _v1.x) + (rng.bool() ? 1 : -1) * rng.range(0.06, 0.26);
    } else {
      az = rng.range(0, M.TAU);
    }
    var el;
    if (opts && isFinite(opts.elevation)) {
      el = opts.elevation;
    } else {
      var cloudKm = rng.range(0.85, 1.45);
      // Capped WELL short of the zenith. The old ceiling of 1.24 rad (71 deg)
      // meant a forced - therefore close - strike arrived almost overhead, and
      // a light overhead drops its shadows straight down where nothing can see
      // them: the contract asks for "hard shadows in a completely different
      // direction from the lamps" and the flash was photographing as a frontal,
      // shadowless relight. 0.92 rad is 53 degrees, which still puts 0.80 of the
      // key on a horizontal apron (so the deck is relit) but rakes the container
      // shadows a container-and-a-half across it.
      el = M.clamp(Math.atan2(cloudKm, Math.max(0.08, km)), 0.30, 0.92);
    }
    var ce = Math.cos(el);
    this.flashDir.set(Math.cos(az) * ce, Math.sin(el), Math.sin(az) * ce).normalize();

    // Sub-flashes with irregular gaps. A single clean flash reads as a bug;
    // real return strokes stutter.
    //
    // The COUNT and the SPAN scale with proximity, and that is physics rather
    // than a capture convenience: a distant cell shows one or two strokes of a
    // flash that is mostly hidden in cloud, while a close cloud-to-ground
    // flash is a 4-5 stroke train that genuinely flickers for a third of a
    // second. It also happens to be what makes the `lightning` capture work -
    // shoot.py forces the strike at t=1.1 and photographs at t=1.5, and a
    // strike that is over in 90 ms is a storm with no lightning in the picture.
    var n = 2 + Math.round(near * 3);
    var subs = [];
    var t = 0;
    for (var i = 0; i < n; i++) {
      var dur = rng.range(0.018, 0.048);
      subs.push({ t0: t, t1: t + dur, amp: i === 0 ? 1.0 : rng.range(0.62, 1.0), hold: 0.22 });
      t += dur + rng.range(0.022, 0.030 + 0.075 * near);
    }
    var mainEnd = Math.min(0.18 + 0.36 * near, t);

    // EVERY LIGHTNING CAPTURE USED TO PHOTOGRAPH THE FLAT PART OF THE STRIKE.
    // The continuing-current plateau is physically right and it is also what the
    // shutter lands on nine times out of ten - the return strokes are 18-48 ms
    // inside a 0.4 s train - so a still came back as a soft, even, shadowless
    // relight with no spike in it. The plateau is now capped BELOW the strokes
    // (see `glow`) and a forced strike schedules one stroke on a lattice that
    // guarantees the shutter opens on it: scenarios.js forces at t = 1.1 and
    // shoot.py photographs at t = 1.5, so a stroke is placed to be at full
    // amplitude across age 0.336-0.430 - three frames either side of 0.400.
    if (forced) {
      var cd = 0.20;
      subs.push({ t0: 0.30, t1: 0.30 + cd, amp: 1.0, hold: 0.65 });
      if (mainEnd < 0.54) mainEnd = 0.54;
      if (t < 0.50) t = 0.50;
    }

    this._strike = {
      t0: this.time,
      subs: subs,
      mainEnd: mainEnd,
      // THE CONTINUING CURRENT, and it is the value a capture almost always
      // lands on. The return strokes above are 18-48 ms each inside a 0.4 s
      // train; shoot.py forces the strike at t=1.1 and photographs at t=1.5, so
      // the odds of the shutter opening on a stroke are about one in eight. It
      // was 0.30-0.58, i.e. the `lightning` framing was photographing a strike
      // at half strength and reading as "the frame merely got darker" - the
      // frame HAD dimmed, because postfx compresses by 1/(1 + 0.95 * flash)
      // whether or not a stroke is currently lit.
      //
      // 0.50-0.80 is also the more honest number. A close cloud-to-ground flash
      // carries a continuing current between strokes that keeps the channel and
      // the whole cloud base luminous for a few hundred milliseconds; the gaps
      // in a real flash are not dark, they are just not peak.
      //
      // But at 0.50-0.80 against strokes that cannot exceed 1.0, the envelope
      // was a 0.67 s SQUARE PULSE - probed live, forcing a strike and stepping
      // 40 frames returned flash = 0.78 on every single frame. A square pulse is
      // somebody turning a floodlight on. Capping the plateau at 0.34-0.58 and
      // guaranteeing a stroke on the shutter (above) restores a 1.7:1 spike, and
      // the capture now lands on the spike rather than on the flat.
      glow: 0.34 + 0.24 * near,
      // The decay of that same channel once the main phase ends. It starts FROM
      // `glow`, which it did not before: tailStart was 0.66-0.88 against a glow
      // of 0.30-0.58, so the envelope stepped UP at t = mainEnd - the strike
      // got brighter as it died.
      tailTau: 0.30 + 0.18 * near,
      // MEASURED, not guessed. A 4x probe capture of the `lightning` framing
      // moved mean luminance 0.097 -> 0.137, near-black 48% -> 30%, dynamic
      // range 0.73 -> 0.87 and coverage.dead_cell_pct 15.6 -> 0.0 at 0.12%
      // blown - i.e. the strike is by a wide margin the largest single lever on
      // this frame, and at ~34 lux of combined key it is still not clipping.
      // A first pass at 3.6-9.5 (sized to leave room for lighting.js's own 9.5
      // lightning key, which does not budget itself down against this one
      // because its _findExternalFlash only accepts an isDirectionalLight and
      // this is deliberately a SpotLight) produced a strike that was barely
      // distinguishable from the resting frame. That was the overcorrection.
      //
      // The reason the number has to be this large is in the art direction:
      // wet concrete is #16191c, which is 0.008 linear. A surface that dark
      // returns 34 * 0.008 / PI = 0.09 radiance under the full strike, and
      // postfx compresses the whole frame by 1/(1 + 0.95 * flash) = 0.57 while
      // it is up. A "daylight" 3-6 does not survive either of those.
      //
      // Stable whichever way lighting.js goes: if it learns to see a spot here,
      // its budget rule floors its own share at 45% of ours and the pair still
      // lands near 34.
      // The resting frame moved under this number twice while it was being
      // measured, and that is the whole reason it is so large. `lightning` and
      // `containers` are the SAME pose at the same FOV - the only difference
      // between the two captures is the strike - so they are a direct A/B, and
      // at 34 combined lux the strike frame still metered DARKER than the
      // resting one (0.146 against 0.163) even though it was revealing the
      // entire far half of the terminal (dead_cell_pct 6.25 -> 0.00). That is
      // the exact failure this is being retuned for: postfx compresses by
      // 1/(1 + 0.95 * flash), the auto-exposure re-meters underneath it, and a
      // key has to beat BOTH before a single pixel gets brighter.
      // Measured on the `lightning` / `containers` A/B (identical pose, the
      // only difference is the strike):
      //   30 lux  mean 0.146 vs resting 0.163 - range 0.786, dead 0.00
      //   44 lux  mean 0.174 vs resting 0.143 - range 0.622, dead 12.5
      // Past ~40 the auto-exposure stops the whole frame down faster than the
      // key lifts it, so the strike buys mean luminance by throwing away
      // dynamic range and pushing the unlit apron back below the visibility
      // floor. ~36 for a close strike is the knee: brighter than the resting
      // frame, still 0.75+ range, still full coverage.
      // Trimmed from 38 with the plateau change: the capture now lands on a
      // stroke at flash = 1.0 instead of on a plateau at 0.78, so the same
      // photographed key needs about a fifth less peak. The A/B that set this
      // number (30 lux -> mean 0.146, range 0.786, dead 0.00; 44 lux -> mean
      // 0.174, range 0.622, dead 12.5) puts the knee just under 36, and
      // 1.0 * 34 lands on it where 0.78 * 38 = 29.6 fell short of it.
      peak: M.lerp(10.0, 30.0, near * near),
      km: km,
      near: near,
      seed: rng.next() * 100.0,
      life: mainEnd + 1.6
    };

    this.flash = 1;
    // ~343 m/s: 2.94 s per km. Close strikes crack almost on top of the flash.
    var delay = km * 2.94;
    this._thunder.push({ at: this.time + delay, km: km, near: near });
    this.thunderPending = this._thunder.length;

    var bus = (this.ctx && this.ctx.bus) || GAME.bus;
    if (bus && bus.emit) {
      bus.emit('weather:lightning', {
        distance: km * 1000,
        distanceKm: km,
        delay: delay,
        intensity: near,
        direction: this.flashDir.clone(),
        forced: !!forced
      });
    }
    return this._strike;
  };

  Weather.prototype._updateLightning = function (dt, ctx) {
    var lit = this._target.lightning;
    if (lit > 0 && !this._strike) {
      this._nextStrikeAt -= dt * (0.55 + 0.75 * lit);
      if (this._nextStrikeAt <= 0) {
        this._beginStrike(null, false);
        this._nextStrikeAt = this.lrng.range(3.0, 8.0);
      }
    }

    var f = 0;
    var stroke = 0;      // the return-stroke component alone, for the channel
    var s = this._strike;
    if (s) {
      var age = this.time - s.t0;
      if (age >= s.life) {
        this._strike = null;
        s = null;
      } else {
        for (var i = 0; i < s.subs.length; i++) {
          var sb = s.subs[i];
          if (age >= sb.t0 && age <= sb.t1) {
            var u = (age - sb.t0) / Math.max(1e-4, sb.t1 - sb.t0);
            var hold = sb.hold || 0.22;
            // Fast attack, a hold, then decay. The hold is what lets a stroke be
            // scheduled to land under the shutter without making it a ramp.
            var env = u < 0.18 ? u / 0.18
                    : (u < hold ? 1.0 : Math.pow(1 - (u - hold) / Math.max(1e-3, 1 - hold), 1.4));
            stroke = Math.max(stroke, sb.amp * env);
          }
        }
        f = stroke;
        // Continuous at t = mainEnd: the tail is the glow decaying, not a
        // second, larger envelope taking over from it.
        if (age <= s.mainEnd) f = Math.max(f, s.glow);
        else f = Math.max(f, s.glow * Math.exp(-(age - s.mainEnd) / s.tailTau));
      }
    }
    this.flash = M.saturate(f);
    this.uniforms.uFlash.value = this.flash;
    // The channel exists only while the stroke does. A continuing-current glow
    // has no visible bolt in it - that is the whole difference between the two.
    this._chanAmp = M.saturate((stroke - 0.30) / 0.55);

    var L = this._flashLight;
    if (!L) {
      this.uniforms.uFlashCol.value.setRGB(0, 0, 0);
      this._updateChannel(ctx, s);
      return;
    }

    L.intensity = this.flash * (s ? s.peak : 0);
    // Same double-billing story as the key: lighting.js already raises its own
    // hemisphere by 1.85 and its ambient by 1.15 on the flash, and it cannot
    // see this one either. This fraction came DOWN as the key went up, because
    // the two are not interchangeable - the flash has to throw hard shadows in
    // a direction the sodium lamps do not, and an omnidirectional fill scaled
    // off a 34-lux key would flatten exactly the contrast that sells it. 5% is
    // a shadow-side floor, not a second key.
    if (this._flashFill) this._flashFill.intensity = L.intensity * 0.05;

    // Colour the shader's flash term. It is additive on the water, so it has to
    // carry the strike's strength as well as its hue. Deliberately well under
    // the light's own energy: postfx meters the frame, and rain bright enough
    // to dominate the average stops the exposure down and cancels out the very
    // relight the flash exists to deliver.
    // DERIVED FROM THE STRIKE'S OWN IRRADIANCE, not from a hand-tuned constant.
    // It used to be flashColor * 0.72 * (0.45 + 0.55*near), which is a fixed
    // number per strike: the rain's flash gain could not track the light's
    // envelope at all, so at the moment the flash relit the entire terminal the
    // rain's relative contrast COLLAPSED - measured, rain added 104% of the
    // background with no flash and 30% during one, a 3.4x loss. Scaling off
    // L.intensity ties the two together by construction, and the alpha and width
    // terms in RAIN_VERT do the rest: "freezing the rain mid-air" needs the drop
    // to gain screen FOOTPRINT, because footprint is what survives postfx's
    // 1/(1 + 0.95*flash) compression when radiance alone does not.
    var fk = s ? M.saturate(L.intensity / 30.0) : 0;
    this.uniforms.uFlashCol.value.copy(this.flashColor).multiplyScalar(fk * 0.95);

    this._updateChannel(ctx, s);

    if (this.flash > 0.001 || this._shadowPrime > 0) {
      var cam = ctx.camera;
      var cx = cam ? cam.position.x : 0;
      var cy = cam ? cam.position.y : 1.7;
      var cz = cam ? cam.position.z : 0;
      L.position.set(cx + this.flashDir.x * 200,
                     cy + this.flashDir.y * 200,
                     cz + this.flashDir.z * 200);
      if (this._flashTarget) this._flashTarget.position.set(cx, cy - 1.2, cz);
      L.shadow.needsUpdate = true;
      if (this._shadowPrime > 0) this._shadowPrime--;
    }
  };

  Weather.prototype._updateChannel = function (ctx, s) {
    var C = this._channel;
    if (!C) return;
    var amp = s ? this._chanAmp : 0;
    if (amp < 0.004) { C.mesh.visible = false; return; }
    var cam = ctx && ctx.camera;
    if (!cam) { C.mesh.visible = false; return; }
    // A CHANNEL IS A COLUMN STANDING ON THE GROUND, not a marker hung along the
    // light's direction. flashDir carries the ELEVATION the strike is seen at,
    // which for a close bolt is 53 degrees - straight off the top of any of the
    // harbor framings - so parking the quad along it put the bolt out of frame
    // every time. What has to be in frame is the bottom of the channel, where it
    // terminates, so the quad stands on the deck at the strike's own bearing and
    // range and rises out of the top of the picture.
    var az = Math.atan2(this.flashDir.z, this.flashDir.x);
    var d = M.clamp((s.km || 0.5) * 1000, 130, 420);
    var H = 340, W = 80;
    C.mesh.position.set(cam.position.x + Math.cos(az) * d,
                        this._groundY + H * 0.48,
                        cam.position.z + Math.sin(az) * d);
    C.mat.uniforms.uSize.value.set(W, H);
    C.mesh.updateMatrix();
    C.mesh.updateMatrixWorld();
    C.mat.uniforms.uAmp.value = amp * 0.35;
    C.mat.uniforms.uSeed.value = s.seed || 0;
    C.mesh.visible = true;
  };

  Weather.prototype._pumpThunder = function (ctx) {
    var list = this._thunder;
    if (!list.length) return;
    for (var i = list.length - 1; i >= 0; i--) {
      if (this.time < list[i].at) continue;
      var ev = list[i];
      list.splice(i, 1);
      var payload = {
        distance: ev.km * 1000,
        distanceKm: ev.km,
        intensity: ev.near,
        // Publish the character so audio does not have to re-derive it.
        kind: ev.km < 0.7 ? 'crack' : (ev.km < 1.8 ? 'clap' : 'rumble'),
        volume: M.clamp(0.35 + 0.65 * ev.near, 0.2, 1.0)
      };
      var bus = (ctx && ctx.bus) || GAME.bus;
      if (bus && bus.emit) bus.emit('weather:thunder', payload);
      if (ctx && ctx.audio && ctx.audio.play) {
        // audio.play() returns silently on a name it does not know, so this is
        // safe whether or not audio.js has grown a thunder voice yet.
        try { ctx.audio.play('thunder', payload); } catch (e) { /* optional */ }
      }
    }
    this.thunderPending = list.length;
  };

  // --------------------------------------------------------------------------
  // Practicals. The eight nearest lit sources feed the rain, splash, drip and
  // mist shaders, so water brightens crossing a lamp pool. The scene traverse
  // is amortised; only the ranking runs at a useful rate.
  // --------------------------------------------------------------------------
  Weather.prototype._scanLights = function (ctx) {
    var cache = this._lightCache;
    cache.length = 0;
    try {
      if (ctx.scene) {
        ctx.scene.traverse(function (o) {
          if (!o.visible) return;
          if ((o.isSpotLight || o.isPointLight) && o.intensity > 0.02) {
            cache.push({ light: o, shaft: null });
          }
        });
      }
      // Top up from the level's published shafts. These carry no colour of
      // their own, so they get the sodium the art direction specifies.
      var shafts = ctx.level && ctx.level.lightShafts;
      if (Array.isArray(shafts)) {
        for (var i = 0; i < shafts.length && cache.length < 60; i++) {
          var s = shafts[i];
          if (!s || !s.origin || !isFinite(s.origin.x)) continue;
          cache.push({ light: null, shaft: s });
        }
      }
    } catch (e) {
      GAME.logError('weather.scanLights', e);
    }
  };

  Weather.prototype._updateLights = function (ctx) {
    // Rescan often for the first couple of seconds - lighting.js builds before
    // the level exists and creates its practicals during its own first updates,
    // so a single scan at t=0 would find an empty rig and a 1.5 s capture would
    // never see a lit drop.
    var scanEvery = this.time < 2.5 ? 0.35 : 2.0;
    if (this.time - this._lightScanAt > scanEvery) {
      this._lightScanAt = this.time;
      this._scanLights(ctx);
    }
    if (this._lightPickAt >= 0 && this.time - this._lightPickAt < 0.22) return;
    this._lightPickAt = this.time;

    var cam = ctx.camera;
    var cp = cam ? cam.position : _v4.set(0, 1.7, 0);
    var cache = this._lightCache;
    var pos = this._uLightPos, dir = this._uLightDir, col = this._uLightCol;
    var i;
    for (i = 0; i < MAX_LIGHTS; i++) {
      pos[i * 4] = 0; pos[i * 4 + 1] = 0; pos[i * 4 + 2] = 0; pos[i * 4 + 3] = 0;
      dir[i * 4] = 0; dir[i * 4 + 1] = -1; dir[i * 4 + 2] = 0; dir[i * 4 + 3] = -2;
      col[i * 3] = 0; col[i * 3 + 1] = 0; col[i * 3 + 2] = 0;
    }
    if (!cache.length) return;

    // Rank by distance. Nothing beyond 60 m puts a readable amount of light
    // into a raindrop at this exposure.
    var slots = this._pick;
    var n = 0;
    for (i = 0; i < cache.length && n < slots.length; i++) {
      var ent = cache[i];
      var px, py, pz;
      if (ent.light) {
        if (!ent.light.visible || ent.light.intensity <= 0.02) continue;
        ent.light.getWorldPosition(_v1);
        px = _v1.x; py = _v1.y; pz = _v1.z;
      } else {
        px = ent.shaft.origin.x; py = ent.shaft.origin.y; pz = ent.shaft.origin.z;
      }
      var dx = px - cp.x, dy = py - cp.y, dz = pz - cp.z;
      var d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 3600) continue;
      var sl = slots[n++];
      sl.e = ent; sl.d2 = d2; sl.x = px; sl.y = py; sl.z = pz;
    }
    this._pickN = n;
    if (!n) return;
    // Partial selection sort for the top MAX_LIGHTS - cheaper than sorting the
    // whole list and it never allocates a comparator closure.
    var take = Math.min(MAX_LIGHTS, n);
    for (i = 0; i < take; i++) {
      var bi = i;
      for (var j = i + 1; j < n; j++) if (slots[j].d2 < slots[bi].d2) bi = j;
      if (bi !== i) { var tmp = slots[i]; slots[i] = slots[bi]; slots[bi] = tmp; }
    }

    for (i = 0; i < take; i++) {
      var b = slots[i];
      var e = b.e;
      var range, r, g, bl, cosOuter = -2, ax = 0, ay = -1, az = 0;
      if (e.light) {
        var L = e.light;
        var inten = M.clamp(L.intensity, 0, 200);
        range = L.distance > 0.1 ? L.distance * 0.55 : M.clamp(Math.sqrt(inten) * 1.9, 4, 26);
        _c1.copy(L.color);
        // CLAMPED, not scaled. lighting.js owns the practicals' candela and it
        // is free to change them; an unclamped 0.020-per-candela response met a
        // 60 cd mast lamp and painted the rain inside the cone at 1.8 linear,
        // which bloomed into an orange wash that ate half the frame. The clamp
        // means a brighter lamp makes a bigger POOL, not a hotter drop.
        // The ceiling moved up with the resting base colour coming down: the
        // whole point of dimming a drop outside the cones is that the cones get
        // to be the contrast, and 0.42 against a 0.136 base was only a 3:1
        // ratio at the bulb and 1.5:1 out at the pool.
        // ...but the ceiling now SCALES WITH COLOUR TEMPERATURE. One flat 0.50
        // for every practical flattened a 1000 cd sodium mast and a 240 cd cold
        // flood to identical drop brightness, which is both wrong and against
        // the palette: ART_DIRECTION_HARBOR asks for #ff9a3c cones, not white
        // ones. Warmth here is just the red-blue separation of the lamp's own
        // colour, so a sodium mast pushes 0.74 and a mercury flood stays at
        // 0.38 without weather.js needing to know anything about the rig.
        var warm = M.saturate((_c1.r - _c1.b) * 1.7 + 0.12);
        var gain = M.clamp(0.022 * inten, 0, M.lerp(0.38, 0.74, warm));
        r = _c1.r * gain; g = _c1.g * gain; bl = _c1.b * gain;
        if (L.isSpotLight) {
          L.getWorldPosition(_v1);
          if (L.target) { L.target.getWorldPosition(_v2); _v3.copy(_v2).sub(_v1); }
          else _v3.set(0, -1, 0);
          if (_v3.lengthSq() < 1e-8) _v3.set(0, -1, 0);
          _v3.normalize();
          ax = _v3.x; ay = _v3.y; az = _v3.z;
          cosOuter = Math.cos(M.clamp(L.angle || 0.6, 0.05, 1.5));
        }
      } else {
        var s = e.shaft;
        var len = isFinite(s.length) ? M.clamp(s.length, 2, 60) : 12;
        var wid = isFinite(s.width) ? M.clamp(s.width, 0.5, 20) : 3;
        var st = isFinite(s.strength) ? M.clamp(s.strength, 0, 3) : 1;
        range = len * 0.6;
        // ART_DIRECTION_HARBOR: sodium mast lamp #ff9a3c.
        var sc = (s.color && s.color.isColor) ? _c1.copy(s.color) : _c1.setRGB(1.0, 0.60, 0.235);
        var swarm = M.saturate((sc.r - sc.b) * 1.7 + 0.12);
        var sg = M.lerp(0.30, 0.52, swarm) * st;
        r = sc.r * sg; g = sc.g * sg; bl = sc.b * sg;
        if (s.dir && isFinite(s.dir.x)) {
          _v3.copy(s.dir);
          if (_v3.lengthSq() > 1e-8) { _v3.normalize(); ax = _v3.x; ay = _v3.y; az = _v3.z; }
        }
        cosOuter = Math.cos(M.clamp(Math.atan2(wid * 0.75, len * 0.5) + 0.12, 0.08, 1.4));
      }
      var o4 = i * 4, o3 = i * 3;
      pos[o4] = b.x; pos[o4 + 1] = b.y; pos[o4 + 2] = b.z; pos[o4 + 3] = range;
      dir[o4] = ax; dir[o4 + 1] = ay; dir[o4 + 2] = az; dir[o4 + 3] = cosOuter;
      col[o3] = r; col[o3 + 1] = g; col[o3 + 2] = bl;
    }
  };

  // --------------------------------------------------------------------------
  Weather.prototype._findDepthTexture = function (ctx) {
    var pf = ctx.postfx;
    if (!pf) return null;
    if (pf.rtScene && pf.rtScene.depthTexture && pf.rtScene.depthTexture.isDepthTexture) {
      this._depthRT = pf.rtScene;
      return pf.rtScene.depthTexture;
    }
    var names = ['rtMain', 'rtColor', 'depthTexture', 'sceneDepth'];
    for (var i = 0; i < names.length; i++) {
      var v = pf[names[i]];
      if (!v) continue;
      if (v.isDepthTexture) { this._depthRT = null; return v; }
      if (v.isWebGLRenderTarget && v.depthTexture) { this._depthRT = v; return v.depthTexture; }
    }
    return null;
  };

  Weather.prototype._updateDepth = function (ctx) {
    var U = this.uniforms;
    if (!ctx.renderer || !ctx.camera) { U.uSoft.value = 0; return; }
    if (!this._depth) {
      this._depth = new DepthProbe(ctx.width || 1280, ctx.height || 720);
    }
    // Re-probe every frame until it connects: postfx builds before us, but a
    // resize swaps the texture object out from under the handle.
    if (!this._depthTex || !this._depthTex.isDepthTexture) {
      this._depthTex = this._findDepthTexture(ctx);
    }
    if (!this._depthTex) { U.uSoft.value = 0; return; }

    var rt = this._depthRT;
    if (rt && rt.width > 1) {
      U.uInvRes.value.set(1 / rt.width, 1 / rt.height);
      if (this._depth.rt.width !== Math.max(2, rt.width >> 1)) {
        this._depth.resize(rt.width, rt.height);
      }
    } else {
      ctx.renderer.getDrawingBufferSize(_size);
      U.uInvRes.value.set(1 / Math.max(1, _size.x), 1 / Math.max(1, _size.y));
    }

    this._depth.run(ctx.renderer, this._depthTex, ctx.camera.near, ctx.camera.far);
    U.uDepth.value = this._depth.rt.texture;
    U.uSoft.value = 1;
  };

  // --------------------------------------------------------------------------
  // Wind. A base bearing that wanders slowly plus squared gusts, so the rain
  // angle is never constant - constant-angle rain is the other half of "flat
  // overlay".
  // --------------------------------------------------------------------------
  // A SQUALL ENVELOPE, NOT A SPEED WOBBLE. Probed live, the old rig produced
  // windSpeed samples of 10.0-11.3 m/s over thirty seconds - plus or minus 6%,
  // an eight-degree swing in streak tilt no viewer will ever read - and the
  // rain DENSITY never changed at all, because uRain was damped toward a
  // constant. That is a particle emitter running at a fixed rate, which is
  // precisely what the brief says must not happen.
  //
  // One low-frequency field raised to 2.2 gives long lulls and short surges,
  // and everything hangs off it: wind speed (4.3-15.2 m/s, so the tilt swings
  // 25-55 degrees), rain density, mist gain and drift, and ripple arrival rate.
  // A storm surges as ONE thing; layering an independent noise per system is
  // what makes weather read as several unrelated effects.
  Weather.prototype._updateWind = function (dt) {
    var p = this._target;
    this._gustPhase += dt;
    var n = this.noise;
    var swing = n.perlin2(this._gustPhase * 0.055, 11.3) * 0.55;
    var gust = n.perlin2(this._gustPhase * 0.31, 4.7) * 0.5 + 0.5;
    gust *= gust;
    var sq = M.saturate(0.5 + 0.5 * n.perlin2(this._gustPhase * 0.09, 71.0));
    this.squall = Math.pow(sq, 2.2);

    var baseAngle = Math.atan2(-0.57, 0.82) + swing;
    this.windDir.set(Math.cos(baseAngle), Math.sin(baseAngle));
    if (this.active) {
      // Rate down from 1.4: a gust front arrives in half a second, it does not
      // ease in over two.
      var want = p.wind * (0.45 + 1.15 * this.squall) + p.gust * gust;
      this.windSpeed = M.damp(this.windSpeed, want, 0.5, dt);
    } else {
      // LEVEL 1 IS FROZEN, AND windSpeed IS NOT A PRIVATE VARIABLE. materials.js
      // feeds it into the global wind uniform that drives cloth and foliage
      // sway, and sky.js integrates it into the cloud deck drift - both
      // unconditionally, on every level. Changing the recurrence here would move
      // a market awning by a fraction of a degree, and that is a regression on a
      // shipped frame. The inactive path is the original expression at the
      // original rate, byte for byte.
      this.windSpeed = M.damp(this.windSpeed, p.wind + p.gust * gust, 1.4, dt);
    }
    this._windVec.copy(this.windDir).multiplyScalar(this.windSpeed);
    this.uniforms.uWindDir.value.copy(this.windDir);
    // The spatial half of the same idea: curtains of denser rain travelling
    // downwind, so a squall is a SHEET crossing the terminal and not a global
    // dimmer. The phase advances at the wind speed, in tile units.
    this._sheetPhase += dt * this.windSpeed * 0.017;
    this.uniforms.uSheetDir.value.set(this.windDir.x, this.windDir.y);
    this.uniforms.uSheetPhase.value = this._sheetPhase;
  };

  Weather.prototype._updateState = function (dt) {
    var p = this._target;
    // Wetting is fast, drying is slow. A soaked apron does not clear in ten
    // seconds because the rain eased off.
    var rate = p.wetness > this.wetness ? 0.42 : 0.09;
    this.wetness = M.damp(this.wetness, p.wetness, rate, dt);
    this._rainCur = M.damp(this._rainCur, p.rain, 0.9, dt);
    this._mistCur = M.damp(this._mistCur, p.mist, 0.5, dt);
    this._sprayCur = M.damp(this._sprayCur, p.spray, 0.5, dt);
    this.rainIntensity = M.saturate(this._rainCur);
    this.fogDensity = M.damp(this.fogDensity, p.fog, 0.5, dt);
    this.fogVisibility = visibilityFor(this.fogDensity);
    this.lensWetness = M.saturate(this._rainCur * (p.lens || 0));
    this.rippleStrength = this.rainIntensity * this.wetness;

    this.uniforms.uTime.value = this.time;
    // Density breathes with the squall. Deliberately a narrow band (0.72-1.14):
    // the whole-frame term only has to say "it is getting heavier", and the
    // spatial sheet term in RAIN_VERT carries the local variation, which is
    // both the more convincing half and the half that cannot make a whole
    // capture arrive thin because the noise happened to be in a lull.
    this.uniforms.uRain.value = this.rainIntensity * (0.72 + 0.42 * this.squall);
    this.uniforms.uWetness.value = this.wetness;
    this.uniforms.uFogSigma.value = this.fogDensity;
  };

  // --------------------------------------------------------------------------
  Weather.prototype._updateRain = function (dt, ctx) {
    var cam = ctx.camera;
    if (!cam || !this.layers.length) return;

    // Volume centre: the camera, pushed forward so the drop budget is spent in
    // front of the eye. Damped, because snapping the centre would wrap every
    // drop at once and the whole field would strobe.
    cam.getWorldDirection(_v1);
    // The look direction's Y used to be damped to 0.35 of itself, which meant
    // that from an elevated pose looking down the volumes sat around the EYE and
    // never reached the apron below - the establishing shot painted 94% of its
    // rain over empty sky and left the terminal itself behind a structureless
    // veil with almost nothing falling through it. The full Y goes in, and the
    // per-layer centre below pulls the box down over the ground as well.
    if (_v1.lengthSq() < 1e-6) _v1.set(0, 0, -1);
    _v1.normalize();
    this._fwd.x = M.damp(this._fwd.x, _v1.x, 2.2, dt);
    this._fwd.y = M.damp(this._fwd.y, _v1.y, 2.2, dt);
    this._fwd.z = M.damp(this._fwd.z, _v1.z, 2.2, dt);

    // Accumulated drift. Deliberately NOT wrapped: the shader multiplies it by
    // a per-drop speed factor, so folding it by a whole box on the CPU would
    // NOT be invisible after that multiply - every drop would teleport
    // sideways. highp float holds millimetre accuracy out past a day of
    // continuous play, which is the correct trade.
    this._fallAccum += dt;
    this._windAccum.x += this._windVec.x * dt;
    this._windAccum.y += this._windVec.y * dt;

    var U = this.uniforms;
    var h = ctx.height || 720;
    var f = cam.projectionMatrix.elements[5];
    // world units per pixel, per metre of view depth
    U.uPixelScale.value = 2.0 / (h * Math.max(0.05, f));

    var vis = this.rainIntensity > 0.01;
    var camY = cam.position.y;
    // How far above the deck the eye is. On the crane walkway or the overview
    // mark this is 20 m and the terminal is a long way DOWN.
    var high = M.saturate((camY - this._groundY - 4.0) / 14.0);
    for (var i = 0; i < this.layers.length; i++) {
      var L = this.layers[i];
      var D = L.def;
      var b = L.box;
      var yc = camY + this._fwd.y * b.y * 0.30;
      if (high > 0) {
        // Pull the box down over the terminal, but never so far that its top
        // leaves the eye behind - the near volume still belongs around the head
        // even when the subject is 25 m below it.
        var floorWant = this._groundY + b.y * 0.40;
        if (floorWant < yc) yc = M.lerp(yc, Math.max(floorWant, camY - b.y * 0.34), high);
      }
      L.centre.set(
        cam.position.x + this._fwd.x * b.x * 0.26,
        yc,
        cam.position.z + this._fwd.z * b.z * 0.26);
      L.drift.set(this._windAccum.x * D.w, -this._fallAccum * D.f, this._windAccum.y * D.w);
      L.vel.set(this._windVec.x * D.w, -D.f, this._windVec.y * D.w);
      L.mesh.visible = vis;
      if (i === 0) this.volumeCentre.copy(L.centre);
    }

    this._updateViewWater(dt, ctx, vis);
  };

  // --------------------------------------------------------------------------
  // The viewmodel scene's water. Its "world" is camera-local space, so the fall
  // and wind vector has to be rotated into the camera's frame, and the light
  // sampler and roof mask are handed the camera's matrixWorld so a drop 40 cm in
  // front of the lens is lit by the same mast as one 40 m away.
  // --------------------------------------------------------------------------
  Weather.prototype._updateViewWater = function (dt, ctx, vis) {
    var vcam = ctx.viewCamera;
    var cam = ctx.camera;
    if (!cam) return;

    // Camera angular velocity, for the bead smear.
    cam.getWorldDirection(_v3);
    var ryaw = Math.atan2(-_v3.x, -_v3.z);
    var rpitch = Math.asin(M.clamp(_v3.y, -1, 1));
    if (this._lastYaw === null) { this._lastYaw = ryaw; this._lastPitch = rpitch; }
    var dyaw = M.wrapAngle(ryaw - this._lastYaw);
    var dpit = rpitch - this._lastPitch;
    this._lastYaw = ryaw; this._lastPitch = rpitch;
    var inv = dt > 1e-4 ? 1 / dt : 0;
    var sx = -dyaw * inv, sy = dpit * inv;
    var slen = Math.sqrt(sx * sx + sy * sy);
    this._smearLen = M.damp(this._smearLen, M.saturate(slen / 3.2), 7.0, dt);
    if (slen > 1e-3) {
      this._smear.x = M.damp(this._smear.x, sx / slen, 9.0, dt);
      this._smear.y = M.damp(this._smear.y, sy / slen, 9.0, dt);
    } else {
      this._smear.x = M.damp(this._smear.x, 0, 4.0, dt);
      this._smear.y = M.damp(this._smear.y, -1, 4.0, dt);
    }

    var V = this.viewRain;
    if (V) {
      V.mesh.visible = vis;
      if (vis) {
        cam.getWorldQuaternion(this._viewQ);
        this._viewQ.invert();
        var D = V.def;
        _v2.set(this._windVec.x * D.w, -D.f, this._windVec.y * D.w)
          .applyQuaternion(this._viewQ);
        // Accumulated in the volume's OWN frame, so turning the head changes the
        // fall direction smoothly instead of teleporting every drop sideways.
        this._viewDrift.x += _v2.x * dt;
        this._viewDrift.y += _v2.y * dt;
        this._viewDrift.z += _v2.z * dt;
        V.drift.copy(this._viewDrift);
        V.vel.copy(_v2);
        V.centre.set(0, 0, -0.95);
        if (vcam && vcam.position) V.centre.add(vcam.position);
        cam.updateMatrixWorld();
        V.xf.copy(cam.matrixWorld);
      }
    }

    var B = this.beads;
    if (B) {
      var wet = this.lensWetness;
      B.mesh.visible = wet > 0.02;
      if (B.mesh.visible) {
        var u = B.mat.uniforms;
        u.uWet.value = wet * 0.50;
        u.uSmear.value.set(this._smear.x, this._smear.y);
        u.uSmearLen.value = this._smearLen;
        var fov = (vcam && vcam.fov) || 55;
        var asp = (vcam && vcam.aspect) || 1.7778;
        var hh = 0.115 * Math.tan(fov * 0.5 * M.DEG);
        u.uPlaneHalf.value.set(hh * asp, hh);
        // Beads glint with whatever the player is standing in, and pick up the
        // strike: a lens full of water is one of the loudest things in a flash.
        var lc = u.uRimCol.value;
        lc.setRGB(0.055, 0.068, 0.088);
        if (this.flash > 0.01) {
          _c1.copy(this.flashColor).multiplyScalar(this.flash * 0.55);
          lc.add(_c1);
        }
      }
    }
  };

  // --------------------------------------------------------------------------
  // Splashes. Ground is found with the level's own raycast - two probes a
  // frame, cached in a fixed ring, biased toward where the player is looking.
  // Splashes behind the camera are pure cost, and a raycast per splash would be
  // twenty allocations a frame for no visible gain.
  // --------------------------------------------------------------------------
  Weather.prototype._updateSplash = function (dt, ctx) {
    var S = this.splash, DP = this.drops;
    if (!S) return;
    var vis = this.rainIntensity > 0.02;
    S.mesh.visible = vis;
    if (DP) DP.mesh.visible = vis;
    if (!vis) return;

    var cam = ctx.camera;
    if (!cam) return;

    var refresh = this._probesPrimed ? 2 : PROBE_CAP;
    this._probesPrimed = true;
    for (var p = 0; p < refresh; p++) this._refreshProbe(ctx, cam);

    var rng = this.rng;
    // 13 rings a frame over a 17 m probe disc was 0.9 impacts per square metre
    // per second. Real heavy rain is nearer 1600, and the eye does not need
    // anything like that, but it does need the apron to look like it is
    // BOILING rather than like it is being hit by the occasional pebble - and
    // now that the ground is lit, the difference is visible. 52 over the 22 m
    // disc is 2.0 per square metre per second, which with a ~0.37 s mean ring
    // life keeps about three quarters of a ring per square metre alive at all
    // times. Against the 0.46 s worst case that is 1435 live instances, inside
    // the 1900 the buffer holds, so the head never laps a slot still drawing.
    var want = Math.round(52 * this.qp * this.rainIntensity * (0.7 + 0.5 * this.squall));
    for (var k = 0; k < want; k++) {
      var pr = this._probes[Math.floor(rng.next() * PROBE_CAP) % PROBE_CAP];
      if (!pr.ok) continue;
      // Jitter around the cached hit: rain does not arrive one drop at a time,
      // and a metre of scatter around a known-flat point is still flat.
      this._emitSplash(pr.x + rng.range(-1.1, 1.1), pr.y + 0.006,
                       pr.z + rng.range(-1.1, 1.1), rng);
    }

    // Every rope of water running off a container lip lands somewhere. Two a
    // frame is enough to keep a visible puddle boiling at the foot of a stack.
    var feet = this._dripFeet;
    if (feet && feet.length >= 3) {
      var nf = (feet.length / 3) | 0;
      for (var fk = 0; fk < 2; fk++) {
        var fi = (Math.floor(rng.next() * nf) % nf) * 3;
        var fx = feet[fi], fz = feet[fi + 2];
        var ddx = fx - cam.position.x, ddz = fz - cam.position.z;
        if (ddx * ddx + ddz * ddz > 900) continue;
        this._emitSplash(fx + rng.range(-0.22, 0.22), feet[fi + 1],
                         fz + rng.range(-0.22, 0.22), rng);
      }
    }

    if (S.dirty) { S.o.needsUpdate = true; S.r.needsUpdate = true; S.dirty = false; }
    if (DP && DP.dirty) {
      DP.o.needsUpdate = true; DP.v.needsUpdate = true; DP.r.needsUpdate = true;
      DP.dirty = false;
    }
  };

  Weather.prototype._refreshProbe = function (ctx, cam) {
    var rng = this.rng;
    var idx = this._probeHead;
    var slot = this._probes[idx];
    this._probeHead = (idx + 1) % PROBE_CAP;

    var x, z;
    // ...but the pool bias is CAPPED at the first 30% of the ring. It used to be
    // an unconditional coin flip on every probe, and in a pose where every lamp
    // happens to be ahead-left the emission collapsed into one corner: measured
    // on the gangway plate, about forty impacts confined to the bottom-left,
    // stopping dead two thirds of the way across, with the entire right half of
    // the visible apron completely dry. A bias that can eat the whole budget is
    // not a bias, it is a bug.
    var poolOk = idx < Math.round(PROBE_CAP * 0.30);
    // HALF THE PROBES ARE AIMED AT A LAMP POOL, and that is the single change
    // that makes splashes readable in this level. Rain falls uniformly; the
    // splashes an eye can SEE are the ones standing in a cone, because the
    // apron between the pools is #16191c and an additive ring on it has almost
    // nothing to read against. Spreading the budget evenly over the disc spent
    // most of it in the dark. The cone axis is already in the uniform block
    // from _updateLights, so the pool centre is a ray-plane intersection and
    // costs nothing.
    if (!poolOk || !this._poolProbe(cam, rng)) {
      // Uniform in AREA, not in radius: sqrt() stops every splash piling up on
      // the player's boots.
      // THE FIELD HAS TO REACH AS FAR AS THE GROUND YOU CAN SEE. At 16 m the
      // splashes stopped well short of the visible apron in any narrow framing
      // - `rain_closeup` is a 55 degree lens, so the deck in shot runs from
      // about 8 m out to past 25, and the entire lower third of that frame came
      // back with no impacts in it at all. sqrt() keeps the distribution
      // uniform in AREA, so pushing the radius out does not thin the near
      // field, it just stops the far field being empty.
      var yaw = Math.atan2(-this._fwd.x, -this._fwd.z) + rng.range(-1.55, 1.55);
      var dist = 1.2 + Math.sqrt(rng.next()) * 21.0;
      x = cam.position.x - Math.sin(yaw) * dist;
      z = cam.position.z - Math.cos(yaw) * dist;
    } else {
      x = this._poolX; z = this._poolZ;
    }

    slot.x = x; slot.z = z; slot.y = this._groundY; slot.ok = true;

    var lvl = ctx.level;
    if (lvl && typeof lvl.raycast === 'function') {
      _v1.set(x, cam.position.y + 7.0, z);
      // (the ray is fired from the probe's XZ, whichever way it was chosen)
      _v2.set(0, -1, 0);
      var hit = null;
      try { hit = lvl.raycast(_v1, _v2, 34); } catch (e) { hit = null; }
      if (hit && hit.hit) {
        if (hit.normal && hit.normal.y < 0.55) { slot.ok = false; return; }   // a wall
        if (hit.point.y > cam.position.y + 0.4) { slot.ok = false; return; }  // a roof
        slot.y = hit.point.y;
      }
    }
    // THE SAME RULE THE DROPS OBEY. Rain that cannot reach a patch of floor
    // cannot splash on it either, and the warehouse interior was coming back
    // covered in impact rings under a solid roof. It costs one texel lookup, and
    // it hands the whole budget to ground the player can actually see rain hit -
    // including, correctly, the pool under the hole in the roof, because the
    // hole is punched out of the mask.
    var roofY = this._roofAt(x, z);
    if (roofY > 0.5 && slot.y < roofY - 0.15) slot.ok = false;
  };

  // World XZ -> height of the highest sheltering surface, 0 for open sky. The
  // CPU-side read of the same grid the rain shader samples.
  Weather.prototype._roofAt = function (x, z) {
    var d = this._roofData;
    if (!d) return 0;
    var r = this._roofRect;
    var u = (x - r.x) * r.z, v = (z - r.y) * r.w;
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return 0;
    var S = this._roofSize;
    var gx = (u * S) | 0, gz = (v * S) | 0;
    return d[(gz * S + gx) * 4] * (this._roofScale / 255);
  };

  // Pick a point inside a practical's ground pool. Returns false (and the
  // caller falls back to the uniform disc) whenever there is no usable lamp,
  // so a level with no practicals still gets rain hitting the deck.
  Weather.prototype._poolProbe = function (cam, rng) {
    var pos = this._uLightPos, dir = this._uLightDir;
    var i, n = 0;
    for (i = 0; i < MAX_LIGHTS; i++) if (pos[i * 4 + 3] > 0) n++;
    if (!n) return false;
    var pick = Math.floor(rng.next() * n) % n;
    var idx = -1;
    for (i = 0; i < MAX_LIGHTS; i++) {
      if (pos[i * 4 + 3] <= 0) continue;
      if (pick === 0) { idx = i; break; }
      pick--;
    }
    if (idx < 0) return false;

    var o = idx * 4;
    var lx = pos[o], ly = pos[o + 1], lz = pos[o + 2];
    var ax = dir[o], ay = dir[o + 1], az = dir[o + 2], cosO = dir[o + 3];
    var drop = ly - this._groundY;
    if (drop < 0.4) return false;                 // a light at or below the deck

    var cx = lx, cz = lz;
    var isCone = cosO > -0.5;
    if (isCone && ay < -0.15) {
      var t = drop / -ay;                          // axis-to-deck intersection
      if (t > 60) return false;
      cx = lx + ax * t;
      cz = lz + az * t;
    }
    // Footprint of the cone on the deck, widened a little: the wet ring of a
    // sodium pool is always broader than the geometric spot angle.
    var half = isCone ? Math.acos(M.clamp(cosO, -1, 1)) : 0.5;
    var rad = M.clamp(drop * Math.tan(M.clamp(half, 0.08, 1.1)) * 1.15, 1.2, 9.0);
    var a = rng.range(0, M.TAU);
    var r = Math.sqrt(rng.next()) * rad;
    var px = cx + Math.cos(a) * r;
    var pz = cz + Math.sin(a) * r;

    var ddx = px - cam.position.x, ddz = pz - cam.position.z;
    var d2 = ddx * ddx + ddz * ddz;
    if (d2 > 1550 || d2 < 1.2) return false;       // past 39 m a ring is subpixel
    // ...and reject a pool point that is not roughly in FRONT of the lens. The
    // second half of the corner-collapse: a lamp 40 degrees off the look axis
    // still passes the distance test, and every probe it wins is emission spent
    // at the edge of frame or outside it.
    var fx = this._fwd.x, fz = this._fwd.z;
    var fl = Math.sqrt(fx * fx + fz * fz);
    if (fl > 1e-4) {
      var dl = Math.sqrt(d2);
      var ct = (ddx * fx + ddz * fz) / (fl * dl);
      if (ct < 0.42) return false;                 // beyond ~65 degrees off axis
    }
    this._poolX = px; this._poolZ = pz;
    return true;
  };

  Weather.prototype._emitSplash = function (x, y, z, rng) {
    var S = this.splash;
    var i = S.head;
    S.head = (S.head + 1) % S.cap;
    var o = i * 4;
    S.o.array[o] = x; S.o.array[o + 1] = y; S.o.array[o + 2] = z;
    S.o.array[o + 3] = this.time;
    // Ring radius and life. These came DOWN once the apron was actually lit and
    // the rings became legible: at 0.085-0.205 m expanding to 1.13x they were
    // 45 cm soap bubbles sitting three to a square metre, which reads as a
    // puddle being dripped into rather than as an apron in a downpour. Smaller
    // and more numerous is both the physics and the picture.
    S.r.array[o] = rng.range(0.075, 0.180);
    S.r.array[o + 1] = rng.range(0.28, 0.46);
    S.r.array[o + 2] = rng.next();
    S.r.array[o + 3] = 0;                     // 0 = ground ring
    S.dirty = true;

    // THE CROWN. A ground-aligned expanding ring on its own produces neat white
    // circles on the deck, which reads as a decal; what an impact actually looks
    // like at 2-6 m is a vertical sheet of water rebounding out of it. Same
    // instanced buffer, one flag in aRand.w switching the whole profile, so it
    // costs an instance and not a draw call.
    var ci = S.head;
    S.head = (S.head + 1) % S.cap;
    var co = ci * 4;
    S.o.array[co] = x; S.o.array[co + 1] = y; S.o.array[co + 2] = z;
    S.o.array[co + 3] = this.time;
    S.r.array[co] = rng.range(0.042, 0.082);
    S.r.array[co + 1] = rng.range(0.10, 0.15);
    S.r.array[co + 2] = rng.next();
    S.r.array[co + 3] = 1;                    // 1 = crown

    var DP = this.drops;
    if (!DP) return;
    var n = rng.int(1, 3);
    for (var k = 0; k < n; k++) {
      var j = DP.head;
      DP.head = (DP.head + 1) % DP.cap;
      var q = j * 4;
      var a = rng.range(0, M.TAU);
      var sp = rng.range(0.55, 1.5);
      DP.o.array[q] = x; DP.o.array[q + 1] = y + 0.01; DP.o.array[q + 2] = z;
      DP.o.array[q + 3] = this.time;
      DP.v.array[q] = Math.cos(a) * sp * 0.55 + this._windVec.x * 0.05;
      DP.v.array[q + 1] = rng.range(1.1, 2.4);
      DP.v.array[q + 2] = Math.sin(a) * sp * 0.55 + this._windVec.y * 0.05;
      DP.v.array[q + 3] = rng.range(0.26, 0.46);
      DP.r.array[q] = rng.range(0.014, 0.036);
      DP.r.array[q + 1] = rng.next();
      DP.r.array[q + 2] = 0;
      DP.r.array[q + 3] = 0;
      DP.dirty = true;
    }
  };

  // --------------------------------------------------------------------------
  Weather.prototype._updateDrips = function () {
    var D = this.drips;
    if (!D) return;
    D.mesh.visible = this.rainIntensity > 0.05 && D.count > 0;
    D.mat.uniforms.uGain.value = 0.60 + 0.28 * this.squall;
  };

  // --------------------------------------------------------------------------
  Weather.prototype._updateMist = function (dt, ctx) {
    var cam = ctx.camera;
    if (!cam || !this.mist) return;

    // The atmosphere surges with the gusts. It had no response to the wind at
    // all beyond a fixed drift and a 0.31 Hz bob, which is why the air read as
    // static in a storm.
    var sqm = 0.80 + 0.32 * this.squall;
    this.mist.mesh.visible = this._mistCur > 0.02;
    this.mist.mat.uniforms.uGain.value = 0.15 * this._mistCur * sqm;
    this.mist.mat.uniforms.uGroundY.value = this._groundY - 0.15;
    this.mist.centre.set(cam.position.x, 0, cam.position.z);
    this.mist.drift.set(this._windAccum.x * 0.34, 0, this._windAccum.y * 0.34);

    if (!this.spray) return;
    if (!this._sprayProbed) this._findSprayLine(ctx);
    var line = this._sprayLine;
    var svis = !!line && this._sprayCur > 0.05;
    this.spray.mesh.visible = svis;
    if (!svis) return;
    this.spray.mat.uniforms.uGain.value = 0.30 * this._sprayCur * sqm;
    this.spray.mat.uniforms.uGroundY.value = line.y;
    // The spray volume rides the quay line, centred on the point nearest the
    // camera, so the budget follows the player along the wharf.
    var t = closestOnSegment(line.a, line.b, cam.position);
    _v1.copy(line.b).sub(line.a).multiplyScalar(t).add(line.a);
    this.spray.centre.set(_v1.x, 0, _v1.z);
    this.spray.drift.set(this._windAccum.x * 0.5, 0, this._windAccum.y * 0.5);
  };

  function closestOnSegment(a, b, p) {
    var abx = b.x - a.x, abz = b.z - a.z;
    var l2 = abx * abx + abz * abz;
    if (l2 < 1e-6) return 0;
    return M.clamp(((p.x - a.x) * abx + (p.z - a.z) * abz) / l2, 0, 1);
  }

  // Quay edge. An explicit publication wins; otherwise find the water mesh and
  // take the edge of its bounding box that faces the play space. If neither
  // exists there is simply no spray, which is the right answer for a level with
  // no water in it.
  Weather.prototype._findSprayLine = function (ctx) {
    this._sprayProbed = true;
    try {
      var lvl = ctx && ctx.level;
      if (!lvl) { this._sprayProbed = false; return; }
      var pub = lvl.quayEdge || lvl.sprayLine ||
                (Array.isArray(lvl.sprayLines) ? lvl.sprayLines[0] : null);
      if (pub && pub.a && pub.b && isFinite(pub.a.x)) {
        this._sprayLine = {
          a: new THREE.Vector3(pub.a.x, pub.a.y, pub.a.z),
          b: new THREE.Vector3(pub.b.x, pub.b.y, pub.b.z),
          y: isFinite(pub.y) ? pub.y : pub.a.y
        };
        this._orientSpray();
        return;
      }
      var root = lvl.root;
      if (!root) return;
      var found = null;
      root.traverse(function (o) {
        if (found || !o.isMesh) return;
        var nm = (o.name || '') + ' ' + ((o.material && o.material.name) || '');
        if (/sea|water|basin|harbou?r_?water/i.test(nm)) found = o;
      });
      if (!found) return;
      _box3.setFromObject(found);
      if (!isFinite(_box3.min.x) || _box3.max.x - _box3.min.x < 2) return;
      _box3.getCenter(_v1);
      var sp = (lvl.spawnPoints && lvl.spawnPoints[0] && lvl.spawnPoints[0].position) ||
               _v2.set(0, 0, 0);
      var dx = sp.x - _v1.x, dz = sp.z - _v1.z;
      var y = _box3.max.y + 0.15;
      if (Math.abs(dz) >= Math.abs(dx)) {
        var z = dz > 0 ? _box3.max.z : _box3.min.z;
        this._sprayLine = {
          a: new THREE.Vector3(_box3.min.x, y, z),
          b: new THREE.Vector3(_box3.max.x, y, z), y: y
        };
      } else {
        var x = dx > 0 ? _box3.max.x : _box3.min.x;
        this._sprayLine = {
          a: new THREE.Vector3(x, y, _box3.min.z),
          b: new THREE.Vector3(x, y, _box3.max.z), y: y
        };
      }
      this._orientSpray();
    } catch (e) {
      GAME.logError('weather.sprayLine', e);
    }
  };

  // A wharf is a line, so the spray volume is a slab along it, not a cube.
  Weather.prototype._orientSpray = function () {
    var line = this._sprayLine;
    if (!line || !this.spray) return;
    var dx = Math.abs(line.b.x - line.a.x);
    var dz = Math.abs(line.b.z - line.a.z);
    if (dx >= dz) this.spray.box.set(Math.min(34, Math.max(8, dx)), 3.0, 8.0);
    else this.spray.box.set(8.0, 3.0, Math.min(34, Math.max(8, dz)));
  };

  // --------------------------------------------------------------------------
  Weather.prototype.update = function (dt, ctx) {
    ctx = ctx || this.ctx;
    this.ctx = ctx;
    if (!this.enabled) return;
    try {
      this.time += dt;
      this._updateWind(dt);
      this._updateState(dt);

      if (!this.active) {
        // The contract still has to read correctly on a clear level.
        this.flash = 0;
        this.rainIntensity = 0;
        return;
      }
      // A late activation (setPreset called before build finished) still has to
      // find its way into the scene.
      if (this.root.parent !== ctx.scene && ctx.scene) this._activate();

      this._updateLightning(dt, ctx);
      this._pumpThunder(ctx);
      this._updateLights(ctx);
      this._updateDepth(ctx);
      this._updateRain(dt, ctx);
      this._updateSplash(dt, ctx);
      this._updateDrips();
      this._updateMist(dt, ctx);
      if (this._ripples) {
        // Arrival rate rides the squall, so the puddles visibly react when a
        // gust front comes through instead of boiling at one fixed rate.
        this._ripples.update(dt, this.time,
          this.rainIntensity * (0.70 + 0.50 * this.squall), ctx.renderer);
      }
    } catch (e) {
      // One bad frame must not take the other fourteen systems with it, and a
      // per-frame logError would flood the capture's error badge until it is
      // the only thing in the shot.
      if (!this._errored) {
        this._errored = true;
        GAME.logError('weather.update', e);
      }
    }
  };

  // --------------------------------------------------------------------------
  Weather.prototype.resize = function (w, h) {
    try {
      if (this._depth) this._depth.resize(w, h);
      this.uniforms.uInvRes.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
      // Force a re-probe: postfx rebuilt its targets, so our handle is stale.
      this._depthTex = null;
      this._depthRT = null;
    } catch (e) {
      GAME.logError('weather.resize', e);
    }
  };

  Weather.prototype.setEnabled = function (v) {
    this.enabled = !!v;
    if (this.root) this.root.visible = this.enabled && this.active;
    return this.enabled;
  };

  Weather.prototype.dispose = function () {
    try {
      this._deactivate();
      var i;
      for (i = 0; i < this.layers.length; i++) {
        this.layers[i].mesh.geometry.dispose();
        this.layers[i].mat.dispose();
      }
      var parts = [this.splash, this.drops, this.drips, this.mist, this.spray,
                   this.viewRain, this.beads, this._channel];
      for (i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        parts[i].mesh.geometry.dispose();
        parts[i].mat.dispose();
      }
      if (this._depth) this._depth.dispose();
      if (this._ripples) this._ripples.dispose();
      if (this._mistMap) this._mistMap.dispose();
      if (this._roofTex) this._roofTex.dispose();
      if (this._roofFallback) this._roofFallback.dispose();
      if (this._fallbackDepth) this._fallbackDepth.dispose();
      var ctx = this.ctx;
      if (ctx && ctx.scene) {
        if (this._flashLight) ctx.scene.remove(this._flashLight);
        if (this._flashFill) ctx.scene.remove(this._flashFill);
        if (this._flashTarget) ctx.scene.remove(this._flashTarget);
      }
    } catch (e) {
      GAME.logError('weather.dispose', e);
    }
  };

  GAME.Weather = Weather;

})(window.GAME, window.THREE);
