# OPERATION BLACKOUT — Architecture Contract

A AAA-target first-person shooter in Three.js r180. **Every agent must follow this
contract exactly.** It is the only thing keeping 14 independently-written modules
from colliding.

---

## 1. Hard environment constraints (non-negotiable)

| Constraint | Consequence |
|---|---|
| **No Node.js, no npm, no bundler** | Ship plain `<script>` tags. No `import`/`export`. No JSX/TS. |
| **Runs from `file://`** | `fetch`, `XHR`, and ES modules are BLOCKED. Never call them. |
| **Zero external assets** | No `.png`, `.jpg`, `.hdr`, `.glb`, `.mp3`, no CDN, no fonts. |
| **All content is procedural** | Textures as CPU float fields uploaded via `THREE.DataTexture` (see below), geometry via code, audio via WebAudio synthesis. |
| **three.js is a global** | `window.THREE`, revision 180. Loaded before all game code. |
| **No `examples/jsm` addons** | `EffectComposer`, `OrbitControls`, `GTAOPass` etc. DO NOT EXIST. Write your own. |

Anything requiring a network request or a file on disk is an automatic failure.

---

## 2. Module registration pattern

Every file is a classic script wrapped in an IIFE that hangs itself off the
global `GAME` namespace. **Never declare a global `var`/`let`/`const`/`function`.**

```js
(function (GAME, THREE) {
  'use strict';

  class Foo {
    constructor(ctx) { this.ctx = ctx; }
  }

  GAME.Foo = Foo;              // export
})(window.GAME, window.THREE);
```

`window.GAME` and `window.THREE` already exist by the time your file runs.

---

## 3. File ownership — ONE agent per file, never touch another's

| # | File | Owns |
|---|---|---|
| 0 | `src/core/util.js` | **[FOUNDATION — do not edit]** namespace, RNG, math, pools, events |
| 0 | `src/game/main.js` | **[INTEGRATION — do not edit]** bootstrap, frame loop, wiring |
| 0 | `index.html` | **[INTEGRATION — do not edit]** script order |
| 0 | `src/game/scenarios.js` | **[INTEGRATION — do not edit]** capture framings, material chart |
| 1 | `src/render/textures.js` | procedural PBR texture generation |
| 2 | `src/render/materials.js` | material library, triplanar, detail/parallax |
| 3 | `src/render/sky.js` | atmosphere, sun, IBL environment, fog |
| 4 | `src/render/lighting.js` | cascaded shadow maps, light rig |
| 5 | `src/render/postfx.js` | post-process stack (write the composer yourself) |
| 6 | `src/world/level.js` | level geometry + collision |
| 7 | `src/world/props.js` | props, clutter, debris, decal surfaces |
| 8 | `src/player/controller.js` | movement, camera, collision response |
| 9 | `src/weapons/weapons.js` | weapon meshes, viewmodel animation, recoil |
| 10 | `src/weapons/ballistics.js` | hitscan, penetration, damage |
| 11 | `src/fx/vfx.js` | particles, tracers, muzzle flash, impacts, shells |
| 12 | `src/audio/audio.js` | procedural weapon/world audio |
| 13 | `src/ai/ai.js` | enemy AI + procedural character animation |
| 14 | `src/ui/hud.js` | HUD, crosshair, hitmarkers, killfeed |
| 15 | `src/world/level_harbor.js` | LEVEL 2 geometry + collision (Cold Harbor) |
| 16 | `src/world/props_harbor.js` | LEVEL 2 props, clutter, containers dressing |
| 17 | `src/fx/weather.js` | rain, storm, lightning; **owns the weather contract** |

A **level** is a `Level`+`Props` pair registered in the `LEVELS` table in
`main.js` and selected at boot with `?level=<id>`. `market` maps to
`Level`/`Props`, `harbor` to `LevelHarbor`/`PropsHarbor`. Every level satisfies
the same contract in §5, so no other system needs to know which one is loaded;
systems branch on `ctx.levelId` / `ctx.levelDef`, never on a class name.

**Level 1 is shipped and frozen.** Any change to a shared module must be gated
on `ctx.levelId === 'harbor'`, on the presence of `ctx.weather`, or on an
explicit preset — never by changing the default path.

If you need something from another module, **call its documented API** below.
If the API you need is missing, code defensively (`if (ctx.foo && ctx.foo.bar)`)
so a missing dependency degrades instead of throwing.

---

## 4. The context object (`ctx`)

`main.js` constructs one `ctx` and passes it to every system. Fields appear in
this order during boot, so a system may only use what was built before it.

```js
ctx = {
  THREE, GAME,
  renderer,            // THREE.WebGLRenderer
  scene,               // THREE.Scene
  camera,              // THREE.PerspectiveCamera (the player's eye)
  viewScene,           // separate THREE.Scene for the first-person viewmodel
  viewCamera,          // narrow-FOV camera for the viewmodel
  clock, time,         // time = seconds since start (float)
  dt,                  // last frame delta, already clamped to <= 1/20
  rng,                 // GAME.RNG, seeded, deterministic
  input,               // GAME.Input (see util.js)
  quality,             // {shadowRes, ssaoScale, taa, bloom, motionBlur, ...}
  settings,            // user settings (fov, sensitivity)
  bus,                 // GAME.EventBus
  // systems, in boot order:
  textures, materials, sky, lighting, postfx,
  level, props, player, weapons, ballistics, vfx, audio, ai, hud,
}
```

### System lifecycle

Every system class implements as much of this as applies:

```js
class System {
  constructor(ctx) {}      // cheap wiring only
  async build() {}         // heavy generation; may yield via GAME.yieldFrame()
  update(dt, ctx) {}       // per-frame simulation
  resize(w, h) {}          // viewport change
}
```

`main.js` calls `build()` on each system in the table order above, reporting
progress to the loading screen, then runs `update()` every frame in that same
order, then `postfx.render()`.

---

## 5. Cross-module APIs (the contract)

Implement these exactly. Other agents are coding against these signatures.

### `textures` — `GAME.TextureLibrary`
```js
get(name, opts)   // -> {map, normalMap, roughnessMap, metalnessMap, aoMap,
                  //     ormMap, displacementMap, size, name,
                  //     and conditionally alphaTest, repeat}
                  // cached. opts: {repeat:[u,v], scale, seed}
noiseTexture(size, type)  // -> THREE.DataTexture ('blue','white','perlin')
                          // NOTE: no consumer anywhere in src/. build() makes a
                          // 64^2 blue set and a 256^2 perlin pack every boot and
                          // nothing samples them.
```

**There is no canvas in this module.** `textures.js` contains no `createElement`,
no `getContext` and no shader: every map is built as a CPU `Float32Array` field,
packed into a `Uint8ClampedArray` and uploaded as a `THREE.DataTexture`. Canvas 2D
*is* used for texture work elsewhere — `level.js`, `level_bunker.js`,
`level_boneyard.js`, `level_refinery.js`, `level_ruins.js`, `props_refinery.js`,
`props_ruins.js`, `props_snowbound.js`, `ai.js`, `weather.js` and `scenarios.js` —
for lettering, signage, marks and faces, i.e. the things that need a rasteriser
rather than a noise field. Don't reach for a canvas in the library.

`opts.repeat` note: `{repeat: 1}` returns the shared base set rather than a clone
(`textures.js:5346`), so `repeat: 1` and passing no opts at all are
indistinguishable downstream.
Required material names: `concrete`, `concrete_wall`, `rusted_metal`,
`painted_metal`, `wood_plank`, `sand`, `gravel`, `asphalt`, `plaster`,
`tile`, `fabric`, `rubber`, `glass`, `foliage`, `brick`, `corrugated_metal`.

### `materials` — `GAME.MaterialLibrary`
```js
get(name, opts)          // -> THREE.Material (cached, shared)
makeTriplanar(name)      // -> material with world-space triplanar mapping
decalMaterial(kind)      // -> material for bullet holes / scorch / blood
```

### `sky` — `GAME.Sky`
```js
sky.envMap               // THREE.Texture (PMREM) — assign to scene.environment
sky.sunDirection         // THREE.Vector3 (normalized, points TOWARD the sun)
sky.sunColor, sky.sunIntensity
sky.setTimeOfDay(t)      // 0..1
```

### `lighting` — `GAME.Lighting`
```js
lighting.sun             // THREE.DirectionalLight (the CSM caster)
lighting.update(dt, ctx) // updates cascade splits against ctx.camera
```

### `postfx` — `GAME.PostFX`
```js
postfx.render(ctx)       // renders scene + viewScene through the full chain
postfx.resize(w, h)
postfx.setQuality(q)
postfx.addImpulse(kind, strength)  // 'shake', 'hit', 'explosion'
```
You must write your own render-target ping-pong composer. Available building
blocks: `THREE.WebGLRenderTarget` (supports `{count:N}` for MRT in r180),
`THREE.DepthTexture`, `THREE.ShaderMaterial`, `THREE.OrthographicCamera` +
fullscreen triangle. **Do not import EffectComposer — it does not exist here.**

### `level` — `GAME.Level`
```js
level.root               // THREE.Object3D added to scene
level.colliders          // array of {type:'box'|'sphere', ...} — see §6
level.spawnPoints        // [{position:Vector3, yaw:Number}]
level.navGrid            // {origin, cellSize, w, h, walkable:Uint8Array}
level.raycast(origin, dir, maxDist)  // -> {hit, point, normal, material, distance}
```

### `player` — `GAME.PlayerController`
```js
player.position, player.velocity, player.yaw, player.pitch
player.state             // 'idle'|'walk'|'sprint'|'crouch'|'slide'|'air'|'mantle'
player.eyeHeight, player.isADS, player.speed
player.health, player.takeDamage(amount, fromDirection)
```

### `weapons` — `GAME.WeaponSystem`
```js
weapons.current          // {name, ammo, magSize, reserve, rpm, damage, ...}
weapons.fire(), weapons.reload(), weapons.switchTo(i)
weapons.muzzleWorldPosition(outVec3)
weapons.getSpreadDirection(outVec3)   // camera-forward + recoil + bloom
```

### `ballistics` — `GAME.Ballistics`
```js
ballistics.fireShot(origin, direction, weapon)  // -> array of hit records
```

### `vfx` — `GAME.VFX`
```js
vfx.muzzleFlash(pos, dir, weapon)
vfx.impact(point, normal, materialKind)
vfx.tracer(from, to, speed)
vfx.ejectShell(pos, dir, weapon)
vfx.decal(point, normal, kind, size)
vfx.bloodSpray(point, normal)
vfx.explosion(point, radius)
```

### `audio` — `GAME.Audio`
```js
audio.unlock()                       // call on first user gesture
audio.play(name, opts)               // opts: {position, volume, pitch}
audio.playGunshot(weapon, position)  // synthesized, layered
audio.setReverb(preset)              // 'outdoor'|'interior'|'hall'
```
**All sound must be synthesized** (oscillators, noise buffers, filters,
convolution with generated impulse responses). No audio files exist.

### `ai` — `GAME.AISystem`
```js
ai.enemies               // array of enemy instances
ai.spawn(position)       // -> enemy
enemy.takeDamage(amount, hitPart, direction)
```

### `hud` — `GAME.HUD`
```js
hud.showHitmarker(kind)  // 'hit'|'headshot'|'kill'
hud.setHealth(v), hud.setAmmo(cur, reserve), hud.addKillfeed(a, b, weapon)
hud.damageIndicator(worldDirection)
```
HUD is **DOM + CSS overlay** (crisp text, no font files — use system font
stacks). Do not render HUD in WebGL.

### `weather` — `GAME.Weather`
`src/fx/weather.js` **owns** this state. Everyone else reads it; nobody else
writes it. Always guard — a level with no weather leaves `ctx.weather` inert.

```js
weather.wetness          // 0..1 global surface wetness
weather.rainIntensity    // 0..1
weather.windDir          // THREE.Vector2, normalised (x = world X, y = world Z)
weather.windSpeed        // m/s
weather.flash            // 0..1 lightning intensity THIS frame (0 most frames)
weather.flashDir         // THREE.Vector3 TOWARD the flash (same convention as
                         // sky.sunDirection, so dot(n, flashDir) is the lambert term)
weather.fogDensity       // the fog density the current storm implies
weather.setPreset(name)  // 'storm' | 'drizzle' | 'clear'
weather.strike()         // force a strike now (capture determinism)
```
On any level that is not the harbor the preset is `clear`, and `clear` is
*absent*: no geometry, no texture, no light, nothing added to the scene.

---

## 6. Collision format

```js
{type:'box',    center:Vector3, halfExtents:Vector3, quaternion:Quaternion, material:'concrete'}
{type:'sphere', center:Vector3, radius:Number, material:'metal'}
```
`GAME.Collision` in `util.js` provides `sweepAABB`, `raycastBox`,
`raycastSphere`, and a broadphase `SpatialHash`. Use them — do not hand-roll.

---

## 7. Rendering rules (how we hit the visual bar)

1. **Linear workflow.** `renderer.outputColorSpace = SRGBColorSpace`. Every
   albedo/color texture sets `colorSpace = SRGBColorSpace`. Normal, roughness,
   AO, and data textures stay `NoColorSpace`. Getting this wrong looks washed out.
2. **Tone mapping is done in postfx**, not the renderer — set
   `renderer.toneMapping = NoToneMapping` and tonemap (AgX/ACES) in the final
   composite pass so bloom and DoF operate in HDR.
3. **Render targets are `HalfFloatType`.** Never `UnsignedByteType` for HDR.
4. **Physical light units.** `renderer.useLegacyLights` is gone in r180; use
   real intensities. Sun ≈ 3–6, bounce/hemisphere ≈ 0.3–1.0.
5. **The viewmodel renders in a separate pass** with its own narrow FOV camera
   and a cleared depth buffer, so the gun never clips into walls.
6. **No pure black, no pure white.** Ambient occlusion and bounce light fill
   shadows. Flat black shadows are the #1 amateur tell.
7. **Everything gets micro-detail.** Surfaces need normal-map detail at two
   scales (macro + a tiling detail normal) or they read as plastic.
8. **Wear where hands and feet go.** Edge wear, grime in crevices, scuffs on
   floors, dirt streaks below openings. Uniform surfaces read as fake.
9. **Target 60fps at 1080p.** Budget: <400 draw calls, <2M triangles. Use
   `InstancedMesh` for anything repeated. Merge static geometry.
10. **Color grade with intent.** A filmic LUT/curve, slight teal in shadows,
    warm highlights, deliberate desaturation. Untouched sRGB looks like a demo.

---

## 8. Capture API (how the critic agents screenshot the game)

`main.js` exposes this; systems just need to behave deterministically.

```
index.html?scenario=NAME&level=market&t=SECONDS&w=1920&h=1080&hud=1&seed=12345
```

The page simulates deterministically at a fixed 1/60 timestep to `t`, renders,
then sets `document.title = 'READY'` and `window.__READY__ = true`.

Scenarios are per level, because a market framing pointed at the harbor just
photographs a wall:

| Level | Scenarios |
|---|---|
| `market` | `overview`, `street`, `interior`, `alley`, `rooftop`, `dusk`, `night`, `materials` |
| `harbor` | `harbor_overview`, `quay`, `containers`, `warehouse`, `crane`, `gangway`, `lightning`, `rain_closeup` |
| both | `ads`, `weapon_closeup`, `muzzleflash`, `firefight`, `enemy_closeup`, `explosion` |

The six shared ones resolve their standpoint through `baseShot()` in
`scenarios.js`, which asks the loaded level for a framing instead of assuming
one. A shared scenario must never hard-code a world coordinate: the same mark
cannot be 16 m in front of the camera in two different levels.

Capture with:
```
python tools/shoot.py <scenario> [--level harbor] [--t 3] [--w 1920] [--h 1080]
python tools/shoot.py --all --level harbor
```

---

## 9. Quality bar

The build is graded by adversarial critic agents against real Call of Duty
screenshots. Things that get a build rejected instantly:

- Flat untextured or single-color surfaces
- Visible texture tiling/repetition
- Hard-edged aliased shadows, or shadow acne
- Blown-out or crushed exposure
- Gun that looks like grey boxes
- Muzzle flash that is a white sphere
- Enemies that are capsules or stiff mannequins
- Empty geometry with no props, clutter, or wear
- Perfectly straight, perfectly clean, perfectly uniform anything
- Static, dead lighting with no atmosphere/depth cueing

Aim for: **grounded, gritty, photographic, with atmospheric depth.**
