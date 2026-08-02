# Development guide

How to change this codebase without breaking it. Read
[ARCHITECTURE.md](ARCHITECTURE.md) first — it is the contract every module was
written against — then [ART_DIRECTION.md](ART_DIRECTION.md) for the visual
target.

---

## The constraints are load-bearing

These are not preferences. Violating any one of them breaks the build for
everyone, and several are non-obvious:

| Constraint | Why |
|---|---|
| No `import` / `export` | Every file is a classic `<script>`. There is no bundler. |
| No `fetch` / `XHR` / asset files | The game runs from `file://`, which blocks all of them. |
| No `examples/jsm` addons | Only `window.THREE` core exists. No `EffectComposer`, no `*Pass`, no `OrbitControls`, no `BufferGeometryUtils`. |
| No `Math.random()` | Use `ctx.rng` / `GAME.RNG`. Captures must be reproducible or the critique loop is worthless. |
| No globals | Everything hangs off `window.GAME`. |
| Never throw from `build()` / `update()` | One exception blanks the screen for all 14 systems. |

Every module is an IIFE:

```js
(function (GAME, THREE) {
  'use strict';
  class Foo { constructor(ctx) { this.ctx = ctx; } }
  GAME.Foo = Foo;
})(window.GAME, window.THREE);
```

### Colour space is the most common silent bug

Albedo/colour textures get `colorSpace = THREE.SRGBColorSpace`. Normal,
roughness, metalness, AO and any data texture **must** stay
`THREE.NoColorSpace`. Getting this backwards produces a washed-out image that
looks like a lighting problem and isn't.

Tone mapping happens in `postfx`, **not** on the renderer — `renderer.toneMapping`
is deliberately `NoToneMapping` so bloom and DoF operate in HDR.

---

## Adding or changing a system

Systems are constructed and updated in the order listed in `SYSTEMS` in
[src/game/main.js](src/game/main.js). A system may only depend on ones built
before it.

```js
class MySystem {
  constructor(ctx) {}            // cheap wiring only
  async build(ctx) {}            // heavy generation; await GAME.yieldFrame() between chunks
  update(dt, ctx) {}             // per frame
  resize(w, h, ctx) {}           // viewport change
}
```

To add one:

1. Create `src/<area>/<name>.js` following the IIFE pattern.
2. Add a `<script>` tag to [index.html](index.html) in dependency order.
3. Add an entry to `SYSTEMS` in `src/game/main.js`.
4. Add it to the ownership table in `ARCHITECTURE.md`.
5. Register it in `MODULES` in `tools/check.py` so `check.py --all` covers it.

**Guard every cross-module call.** Any system may be missing or may have failed
to build; `main.js` records the failure and carries on rather than dying:

```js
if (ctx.vfx && ctx.vfx.impact) ctx.vfx.impact(point, normal, 'concrete');
```

### Adding a level

A level is a `Level`+`Props` pair registered in the `LEVELS` table in
`src/game/main.js` and selected with `?level=<id>`. No other system knows which
level is loaded — they branch on `ctx.levelId` / `ctx.levelDef`, never on a
class name. An unknown or failed level logs and falls back to `market`.

1. Write `src/world/level_<id>.js` exporting `GAME.Level<Id>`, satisfying the
   same Level contract in `ARCHITECTURE.md` §5 (`root`, `colliders`,
   `spawnPoints`, `navGrid`, `cameraPoses`, `raycast`, `sampleGround`).
2. Write `src/world/props_<id>.js` exporting `GAME.Props<Id>`.
3. Add both `<script>` tags to `index.html`, an entry to `LEVELS` in `main.js`,
   scenarios in `src/game/scenarios.js`, and a scenario list in
   `SCENARIOS_BY_LEVEL` in `tools/shoot.py`.
4. Register both modules in `MODULES` in `tools/check.py`.
5. Write an art-direction document for it. `ART_DIRECTION_HARBOR.md` is the
   model: it opens by tabulating how the level differs from the existing one on
   every axis, which is what stops a second level becoming a re-dress of the
   first.

**Extending a shared system for a new level:** gate every new behaviour on
`ctx.levelId === '<id>'`, on the presence of a system like `ctx.weather`, or on
an explicit preset. Never change the default path. Existing levels are frozen,
and the regression gate is a byte-comparison — capture `street.png` before and
after and confirm the hashes match.

**Publish anchors, don't derive placement from camera poses.** During the harbor
build, the level moved four camera poses mid-flight and two other modules had
placed fixtures and props relative to them, so lamps and props ended up in the
wrong corridor. A level should publish named anchors (quay edge, warehouse,
container rows) that other modules resolve at build time.

### Performance budget

60fps at 1080p, under ~500 draw calls and ~4.5M triangles for the whole frame.
Use `THREE.InstancedMesh` for anything repeated more than a few times, merge
static geometry with `GAME.Geo.mergeAll`, and pool all transients — allocation
during gameplay causes GC hitches that read as stutter.

---

## The tooling loop

All Python 3 + headless Chrome. **There is no Node.js on the original build
machine**, and the project deliberately does not require it.

```bash
python tools/check.py --all          # every module parses, loads and constructs
python tools/shoot.py --all          # render 14 deterministic scenarios to shots/
python tools/analyze.py shots/x.png  # objective image metrics
python tools/sheet.py                # contact sheet for reviewing many at once
python tools/playtest.py             # boot the REAL interactive path, drive 600
                                     # frames of scripted input, report state
python tools/build_three_global.py   # regenerate vendor/three.global.js
```

**Run `check.py` after every edit** — it catches syntax errors and boot-time
throws in about a minute, versus several minutes for a full capture.

**Run `playtest.py` for anything touching gameplay.** It exercises the
interactive code path, which is *different* from the capture path: capture mode
freezes the player, drives the camera itself, and steps a fixed timestep. Two
real bugs were found only by playtest — boot hanging forever in a background
tab (`requestAnimationFrame` does not fire when a page is hidden), and the
player dying within 10 seconds of spawn.

### Reading the metrics

`analyze.py` flags are tuned to the failure modes in `ART_DIRECTION.md`:

| Metric | Meaning |
|---|---|
| `crushed_black_pct` | Shadows dying to pure black — needs bounce/ambient fill |
| `blown_white_pct` | Highlights clipping — tonemap roll-off problem |
| `dynamic_range` | Below ~0.45 reads as flat and washed |
| `flat_area_pct` | Untextured surface area — missing normal/roughness detail |
| `grade_split` | Positive = warm highlights over cool shadows (the target look). Near zero or negative means the grade is not landing. |
| `coverage.dead_cell_pct` | % of an 8×8 grid whose *95th percentile* is below a visibility floor — i.e. cells containing nothing a player could see. Target under 12. |
| `coverage.vertical_imbalance` | top-half mean ÷ bottom-half mean. Above ~2.5 on a ground-level camera means the floor is unlit or missing. Target under 2.5. |
| `repetition` | **Advisory only.** It collapses each row to a mean, so on a 3D perspective scene it measures profile smoothness, not texture tiling. It reported the same "peak" for two frame halves showing different walls. Do not tune against it. |

The `grade_split` metric earned its keep: it caught the colour grade *inverting*
at night (−0.0198 against +0.11 everywhere else) in a frame that looked
acceptable as a thumbnail. The `coverage` metrics were added after mean
luminance reported a *black* harbor frame as healthy — a bright fog ceiling
averaged against a dead floor produces a perfectly normal-looking number.

**But metrics are necessary, not sufficient.** A later harbor round passed every
coverage check at 0.0% dead cells while a large untextured mound occupied half
the frame: `coverage` detects missing *light*, not missing *material*. Always
read the PNG.

### Capture scenarios

`shoot.py <name>` renders any of: `overview`, `street`, `interior`, `alley`,
`rooftop`, `ads`, `weapon_closeup`, `muzzleflash`, `firefight`, `enemy_closeup`,
`explosion`, `dusk`, `night`, `materials`.

Poses live in `level.cameraPoses` with fallbacks in
[src/game/scenarios.js](src/game/scenarios.js). Prefer `lookAtPoint()` over a
hand-tuned yaw — two scenarios originally shipped aimed 180° away from their own
subject, which is why `enemy_closeup` showed no enemy for two rounds.

`materials` renders a labelled chart of every material as a sphere plus a flat
plate. It is the honest test of the texture library — regressions show up there
before they show up in a level shot.

---

## How this codebase was built

Four rounds of: parallel agents implement or fix modules → adversarial critics
grade the captured frames against the AAA bar → findings routed back to the one
file that owns them. One agent per file, always, so concurrent edits never
collide.

The pattern worth repeating: **critics that read source and probe the live scene
graph find things critics that only look at screenshots cannot.** The three
highest-value findings of the whole build were all invisible in an image —
`emissiveLamps: 0` (the scene had no actual light sources, only lit surfaces),
zero specular response on all 16 chart materials (the material table clamped
roughness to ≥0.60), and five purpose-built textures being generated every boot
and silently discarded by a name redirect.

The complementary lesson: **automated metrics catch what tired eyes accept.**
Time-of-day was measurably broken (noon/dusk/night within 0.011 mean luminance
of each other) while looking fine in a contact sheet.

And the caution: an acceptance target that measures the wrong thing is worse
than no target. The `repetition` gate was withdrawn mid-run for exactly that
reason.

---

## Known weak points

Ranked by how much they cost the final image:

1. **Enemy faces** read at conversational distance but not in extreme close-up.
2. **The alley and interior** are the weakest of the five hero framings.
3. **Foliage** is alpha-tested cards; it does not hold up close.
4. **No LOD system** — everything renders at full detail at all distances.
5. **Audio occlusion** is a simple distance filter, not a real geometric solve.

Harsh-critic scores plateaued around 49–52 out of 100 against a *shipped AAA
title* benchmark, improving roughly +5 per round and flattening. This is a
strong-looking browser FPS; it is not Call of Duty, and the remaining gap is
real work rather than a tuning pass.
