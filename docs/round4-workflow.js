export const meta = {
  name: 'levels-round4',
  description: 'Round 4: the shared rendering systems are now the bottleneck. Fix those first, then let the levels consume them.',
  phases: [
    { title: 'Shared', detail: 'lighting/postfx/materials/sky - the limits five levels hit independently' },
    { title: 'Harness', detail: 'playtest --level, per-tag reports, integration fixes' },
    { title: 'Levels', detail: '8 levels consume the new capabilities and fix identity gaps' },
    { title: 'Critique', detail: '8 critics re-grade against the corrected gate' },
    { title: 'Verify', detail: 'canary, playtest on all 10, corrected gate on 40 frames' },
  ],
}

const ROOT = 'c:/Users/kelvi/Documents/cod'

const CONTEXT = `
You are working on "OPERATION BLACKOUT", a Three.js r180 FPS at ${ROOT}:
10 levels, ~171,000 lines across 36 modules, zero external assets, no build step.
Read ARCHITECTURE.md, LEVELS_ROSTER.md and DEVELOPMENT.md before anything else.

HARD CONSTRAINTS - violating any breaks the build:
- No Node.js/npm/bundler. Classic <script>, IIFE-wrapped. No import/export.
- No fetch/XHR, no external assets. Runs from file://. Everything procedural.
- three.js examples/jsm DOES NOT EXIST. Only window.THREE core + window.GAME.
- NEVER Math.random() - use ctx.rng / GAME.RNG or captures stop being reproducible.
- Never declare a global. Never throw from constructor/build/update.
- Colour space: albedo SRGBColorSpace; normal/rough/metal/AO NoColorSpace.

*** NEVER LOG DIAGNOSTICS THROUGH GAME.logError. ***
Three probes have now been removed for this (VMDIAG, BMDIAG, vfx.dbg). shoot.py
and playtest.py both read that channel as a real fault, so a probe there fails a
capture on a healthy build. Use console.log behind a URL flag and remove it before
you finish. A flag-gated logError is still a defect.

*** LEVELS 1 AND 2 (market, harbor) ARE FROZEN - THEY ARE THE REGRESSION CANARY ***
    python tools/shoot.py street --w 1280 --h 720 --t 1.5   -> 422 draws / 4,201,372 tris
    python tools/shoot.py quay --level harbor --w 1280 --h 720 --t 1.5 -> 270 / 2,047,292
If either count moves, a shared change has leaked. Do not touch those four files.

*** THE CANARY IS NOT A HEALTH CHECK - KNOW WHAT IT CANNOT SEE. ***
Round 2 found a market-street fire emitter firing in HIGHRISE: the fallback in
vfx.js _initAmbientEmitters sat at market coordinates guarded only by a ground
test, which every level passes. That corrupts levels 3-10 while leaving 1-2
byte-perfect. The canary proves levels 1-2 did not move. It says nothing about
whether a shared system is correct. Verify shared work on the levels that consume it.

BUDGET: under ~500 draw calls and ~4.5M triangles per framing. Current peaks:
  jungle    482 draws / 4,157,056 tris (lv_firefight)  <- 96% of draws, 92% of tris
  refinery  466 / 4,048,784 (lv_firefight)             <- tight
  boneyard  429 / 1,947,630     highrise  332 / 1,366,672
  ruins     405 / 1,669,646     snowbound 282 / 2,781,822
  bunker    247 / 1,154,678     metro     186 / 1,018,356
Jungle and refinery have almost no headroom. Metro and bunker have plenty.

*** THE METRIC GATE WAS JUST CORRECTED. USE THE NEW KEY. ***
coverage.dead_cell_pct judged each cell on its 95th percentile and was SATURATED:
it returned 0.00% on every frame it was ever run against, including both frozen
references, so it could neither pass nor fail anything. GATE ON
coverage.dead_cell_med_pct (per-cell median, target < 12). Re-gating round 3 on it
moved the failure count from 1 of 40 frames to 12 of 40. dead_cell_pct is retained
only so older recorded numbers stay readable - never gate on it.

TOOLS (PowerShell; python is 'python'; there is NO node):
  python tools/shoot.py <scenario> --level <id> --tag <id> --w 1280 --h 720 --t 1.5 --timeout 600
  python tools/analyze.py shots/<name>.png
  python tools/check.py <file> <Class>   /   python tools/check.py --all
ALWAYS pass --tag <id>: without it, concurrent agents collide on Chrome profiles.
Scenarios: lv_overview, lv_hero1, lv_hero2, lv_hero3, lv_interior, lv_firefight.

Metrics are necessary and NOT sufficient. They passed a level that scored 32/100.
Judge with your eyes, diagnose with instruments, and when the two disagree MEASURE
THE PIXELS before acting - that has twice reversed a wrong diagnosis on this project.
`

// ---------------------------------------------------------------------------
// PHASE 1 - the shared systems. Five levels independently named these limits.
// ---------------------------------------------------------------------------

const SHARED = [
  {
    file: 'src/render/lighting.js', cls: 'Lighting', label: 'lighting.js',
    task: `THREE separate levels named MAX_PRACTICALS_RIG = 24 as the binding constraint on
their level - ahead of triangles and draw calls. This is the most-requested change
in the project and it is yours.

1. THE 24-PRACTICAL CAP. Verbatim from the level owners:
   - refinery: "The site is 190 x 192 m with the key 6.8 degrees under the horizon,
     so every photon is a practical; the level models more than forty fixtures and
     only twenty-four of them do anything. To light the establishing frame's
     foreground I had to DELETE a working flood (rf_heater)."
   - metro: "The station is 126 m long with three distinct spaces; I could only
     improve the escalator hall by RELOCATING lamps away from the platform, and its
     flank walls are still dark because there is no slot for them."
   - bunker: "MAX_PRACTICALS_RIG = 24 is exactly what this level publishes, so it
     has zero headroom: every fix had to be a re-site rather than an addition, and
     correcting a grazing lamp is naturally two fittings rather than one."
   Find out what the cap actually protects (uniform array size? shadow maps? a
   per-frame cost?) and raise it as far as the real constraint allows. If the true
   limit is shadow-casting lights rather than lights, separate those two budgets: a
   non-shadowing fill lamp is cheap and levels need many. If a distance/frustum
   priority selection is the honest answer, implement that and let levels publish
   more fixtures than are ever simultaneously active. MEASURE the frame cost of
   whatever you choose and report it.

2. NO INDIRECT / GROUND-BOUNCE TERM. refinery calls this "the single largest"
   remaining issue; boneyard says "every underside in an outdoor level - wing lower
   skins, bellies, soffits, catwalk undersides, wheel arches - has literally no
   light source and prints as the flat black the architecture doc calls the #1
   amateur tell", and had to build its own. refinery: "a surface one metre outside a
   flood is 10-20x darker than one inside it and every dark region in this level is
   dark for the same reason." Add a level-publishable bounce/irradiance term. Even a
   crude "ground albedo x nearest-pool-lux" hemisphere for down-facing normals would
   pay for itself; an AO-modulated fill is better if you can afford it.

3. SHAFTS NEVER REACH A FLOOR. jungle proved both halves. (a) _makeShaft takes the
   haze glow to zero over the last 22% of the cone (1 - smoothstep(0.78, 1.0, t)),
   so no published beam ever visibly lands - that is the correct fix for the rim
   problem it solves, so ADD a landing term (a floor-facing gradient, or a soft ring
   where the axis meets the traced floor) rather than removing it. (b) haze opacity
   and floor irradiance are welded to one number: uAmt reads clamp(dlux*SHAFT_HAZE)
   and light.intensity reads dlux*len*len, and the two wants are OPPOSED - a shaft
   bright enough to land is an opaque column, one translucent enough to see through
   does not land. Give levels a separate optional haze or hazeGain field.

4. THE VOLUMETRIC BEAM SHELL HAS A HARD SILHOUETTE EDGE. A cone published by a
   level renders as a straight-edged translucent wedge with no feathering and no
   view-angle falloff, so when it crosses the subject it reads as a glass shard, not
   as light in air. refinery's hero2 had four of them lying across the frame.

5. SHADOW FILL. The unshadowed gap between two cast shadows prints as a hard pale
   wedge (measured 0.130 against 0.034 in shadow, on paving whose unshadowed value
   is 0.109) with no penumbra-scaled fill and no boundary softening.

6. THE SKY-VISIBILITY VOLUME IS TOO COARSE. boneyard: cells are 6.0 x 1.0 x 2.9 m,
   and next to a 32 m shed they return near their floor, so a wall standing in the
   OPEN photographs as if it were in a cave - the hangar's shaded end wall metered
   0.0035 linear against 0.373 on its own sunlit face.

Also: metro asks for a depth-haze term for levels with interior:true, because
40 m of interior air currently costs nothing and a lit space 40 m down a hall
arrives at full contrast.

Every change must be OPT-IN or preserve existing behaviour exactly, because the
canary must not move and eight levels are tuned against today's numbers. Verify on
the levels that consume it, not only on the canary.`,
  },
  {
    file: 'src/render/postfx.js', cls: 'PostFX', label: 'postfx.js',
    task: `1. heatShimmer.strength MUST NOT SCALE THE DISPLACEMENT AND THE MIRAGE WITH ONE
   MULTIPLIER. uHeat and uHeatPale are both written as (setting x heat.strength), so
   a level asking for a readable boil is forced to accept a proportionally
   full-strength paint-over of its own far field. THIS COST THE BONEYARD ITS
   ESTABLISHING FRAME FOR A WHOLE ROUND: BLEACH_GRADE publishes heatPale 0.55 and
   the level published strength 1.70, so the mirage ran at 0.935 and every ground
   pixel past 70 m and below 6.2 m was 51-94% REPLACED by one constant at 2.2x the
   metered key. A/B: with the mirage off, flat_area went 55.63 -> 38.70, edge_energy
   0.0757 -> 0.1311. The level's near-field wing shadows measure 10:1 at source and
   were arriving on screen at 1.2:1. Split the two controls.

2. THE MIRAGE BANDS ON THE WRONG QUANTITY. Its band term masks on the LIT SURFACE's
   height above the heat layer (wp.y - uHeatY against uHeatH0/H1), not on the VIEW
   RAY's path length through it. So an establishing eye 20 m up on a water tower,
   looking through ~3 m of hot air, receives exactly the same mirage as an eye at
   1.66 m looking through 150 m of it - the opposite of how an inferior mirage
   behaves. Make it path-length driven.

3. A DEPTH-AWARE SOFT-PARTICLE PATH. postfx owns the depth buffer and does not
   expose it, so a level that wants a volumetric card cannot fade its alpha against
   scene depth. ruins' own source records giving up on this ("There is no depth-fade
   available here (postfx owns the depth buffer), so the answer is geometric") and
   then maintaining a hand-written keep-out list of every wall, tower and rubble
   heap - which is why its mist kept getting sliced. Expose depth, or provide a
   soft-particle material path levels can opt into.

4. BLOOM DOES NOT ROUND OFF A CLIPPED EMISSIVE QUAD. An emissive card above ~2x
   white keeps its rectangular silhouette no matter how much bloom is applied,
   because there is no falloff inside it for the blur to spread. Any level using
   emissive cards for distant lights hits this; refinery worked around it locally
   with radial alpha and additive blending.

Preserve every existing preset's output exactly unless you are fixing a defect in
it, and re-verify the canary byte-identically (hash it, do not just compare counts
- two agents did this last round and it is the stronger check).`,
  },
  {
    file: 'src/render/materials.js', cls: 'Materials', label: 'materials.js',
    task: `1. THERE IS NO WAY FOR A LEVEL TO AUTHOR A GENUINELY SMOOTH SURFACE. metro:
   "detail, detailCm and meso are all forwardable, but the base map's own grain is
   unreachable - and for a surface read at ~1 m (a rail-car lining, a door leaf, a
   control panel) every recipe in the library is too grainy at every tile size." Add
   a "grain" scalar that attenuates the base map's own noise. Two rounds of uv
   tuning failed on metro's car ceiling because the tile IS the feature.

2. THE BASE-NORMAL LOD SCHEDULE IS GATED ON ldef.weather, SO NO DECLARATIVE LEVEL
   RECEIVES IT. Levels 3-10 all run their full-strength normal at every distance.
   refinery: "four of the six defects I fixed this round were specular or texture
   aliasing at distance. I worked around it with per-surface normalScale, which is a
   global dial rather than a distance schedule - it costs near-field detail to buy
   far-field calm." Ungate it. This is very likely the same underlying issue as the
   "television static" metro found and the "popcorn" bunker found - both diagnosed
   independently as GRAZING INCIDENCE on micro-relief, both previously mis-treated
   by halving amplitude. A distance schedule is the principled fix; consider whether
   an incidence-aware term belongs alongside it.

3. uvScaleFor(name, texels) CAN ONLY EXPRESS TEXEL DENSITY. A consumer with a
   locally-authored map whose features are sized in WORLD units (hazard striping,
   barrier tape, painted lines) has no way to ask for a world-scale UV, silently
   gets the library's texel figure, and renders a flat single-colour surface. That
   was a real refinery bug and it is invisible to review.

4. water() DEFAULTS planar reflection to graze: 0.5, which hands the surface to the
   ABSOLUTE brightness of the reflected geometry toward grazing incidence. On any
   level whose far bank is dark - a closed canopy, a night harbour - that darkens
   the water below what the level authored; the jungle river measured 25:1 under the
   sky above it. It is overridable, but the default is wrong.

5. 'stone' READS AS A SINGLE-SCALE ISOTROPIC PEBBLE FIELD between ~1 and 4 m
   (detail 0.9 at detailCm 5, macro 0.20). ruins maps it at 0.42 uv/m - about 427
   texels/m against ~556 screen px/m at 1.5 m in a 1280-wide frame, i.e.
   under-sampled at exactly the range a player stands at.

6. THERE IS NO MASONRY OR SNOW RECIPE. snowbound now authors FOUR map sets of its
   own in-file (snow, ice, conifer atlas, masonry) at ~1,600 lines. The masonry one
   - coursed rubble with a spalled render boundary, dark joints, biological staining
   - is not snowbound-specific: ruins, bunker and the market's plaster all want it,
   and the library's 'stone' is a near-neutral pebble field. Promote a masonry
   recipe into the library. Do NOT change what existing consumers of 'stone' get.

7. ALPHA-TESTED steel_grate HAS NO LOD OR AA HELP and resolves into a hard moire
   lattice at oblique angles over distance. bunker's operating platform and gantry
   ring fill the lower half of its establishing frame and are still the loudest
   thing in it after darkening the albedo two stops and tripling the grime. A
   distance-based alpha widening or a mip-biased coverage term would fix a whole
   class of alpha-tested detail.

Canary must stay byte-identical - hash it. Every existing consumer must render
unchanged unless you are fixing a defect it suffers from.`,
  },
  {
    file: 'src/render/sky.js', cls: 'Sky', label: 'sky.js',
    task: `1. setFog() SILENTLY DROPS UNRECOGNISED KEYS, AND IT COST TWO ROUNDS OF WORK.
   The loop is: for (var k in opts) if (k in this.fog) this.fog[k] = opts[k].
   level_highrise.js documented density: 0.0019 in THREE separate comment blocks and
   quoted three solved path opacities to the per cent - and the key was never in the
   object literal, so the level ran on sky.js's DEFAULT 0.0150, the market street's
   fog, for two rounds. At that level's baseY (-174) and heightScale (380) it put
   32% haze across 40 m of floor plate and pinned everything past 250 m at the 0.52
   opacity cap. It was found by elimination, not by reading, after two rounds of
   wrong diagnoses. Make an unknown key LOUD - warn through console.warn behind no
   flag at all (NOT GAME.logError, which fails captures). Then audit every other
   options bag in this file for the same silent-drop pattern and fix the class, not
   the instance.

2. THE SUNSET ZENITH HAS NO COOL END, AND IT IS THE ROOT OF A LEVEL'S BIGGEST GAP.
   highrise's critic: "The level has no cool light in it, and the root of that is
   the sky. The dome's zenith measures R/B 1.08 - neutral, not the 0.55-0.70 a clear
   sunset zenith has." A sunset sky's warm horizon must sit against a genuinely blue
   overhead or nothing in the scene has a cool fill to sit against. Note the last
   round already fixed the DAWN zenith being magenta (measured R the largest channel
   at (0.1537, 0.1011, 0.1258)) by working on the scattering integral - the sunset
   case is the sibling. Check whether it is the same root cause.

3. AERIAL PERSPECTIVE FOR INTERIOR LEVELS. metro: "hero1 looks 40 m down the hall
   at a brightly lit space and it arrives at full contrast, which is what made the
   east arch read as a blank white aperture. 40 m of air costs nothing." A depth-haze
   term for levels with interior:true would let a lit destination read as distant.
   metro solved it with a silhouette in the opening; the underlying gap remains.

4. A BUILD FAILURE WAS OBSERVED TWICE AND MUST BE EXPLAINED. During round 3 a level
   agent's captures twice failed with "[sky.build] ReferenceError: twiF is not
   defined" at sky.js:3581, then "[boot] missing system: GAME.Sky". Both times
   exposure, grade and fog were wrong for the whole frame. It resolved on its own -
   almost certainly a mid-edit read by a concurrent agent - but CONFIRM that no path
   through today's file can reference twiF out of scope, and that a sky build failure
   cannot silently take the whole frame's exposure with it. A level should not lose
   its grade because the sky threw.

Canary must stay byte-identical - hash it, do not merely compare counts.`,
  },
]

const SHARED_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['file', 'passesCheck', 'fixed', 'canary', 'summary'],
  properties: {
    file: { type: 'string' },
    passesCheck: { type: 'boolean' },
    fixed: { type: 'array', items: { type: 'string' } },
    deferred: { type: 'array', items: { type: 'string' } },
    newLevelAPI: {
      type: 'array',
      description: 'New opt-in APIs levels can now publish, with exact names and value ranges.',
      items: { type: 'string' },
    },
    canary: { type: 'string' },
    measuredCost: { type: 'string' },
    summary: { type: 'string' },
  },
}

phase('Shared')
log('Round 4 inverts the order: shared systems first. Five of eight levels reported them as the binding constraint.')

const sharedResults = await parallel(SHARED.map((s) => () =>
  agent(
    CONTEXT + `
=====================================================================
YOU OWN EXACTLY ONE FILE: ${s.file}
=====================================================================
Do NOT edit any other file. Three other agents own the other shared render files
and eight level agents will consume your work in the next phase.

These requests came from EIGHT INDEPENDENT LEVEL OWNERS in round 3, each of whom
had already tried to work around the limit inside their own files. Where two
levels reported the same thing, that is noted - treat it as strong evidence.

${s.task}

APPROACH:
1. Read the file and understand the existing contract before changing anything.
2. Every addition should be OPT-IN, defaulting to today's behaviour, unless you
   are fixing an outright defect. Eight levels are tuned against current numbers.
3. Verify with measurement, not by reasoning. On this project a stated cause has
   been wrong often enough that "I fixed X because Y" is not acceptable without a
   pixel measurement or an in-engine probe showing Y was true.
4. REPORT newLevelAPI precisely - exact option names, types, ranges, defaults. The
   level agents in the next phase are given your report verbatim and can only use
   what you describe accurately.

VALIDATE:
  cd ${ROOT} ; python tools/check.py ${s.file} ${s.cls}
  cd ${ROOT} ; python tools/check.py --all

CANARY - hash it, do not merely compare counts:
  python tools/shoot.py street --w 1280 --h 720 --t 1.5   -> 422 / 4,201,372
  python tools/shoot.py quay --level harbor --w 1280 --h 720 --t 1.5 -> 270 / 2,047,292
Then verify on a level that CONSUMES your change - the canary cannot see a defect
that only affects levels 3-10, which is exactly how a market fire emitter ran in
highrise for a whole round.`,
    { label: 'shared:' + s.label, phase: 'Shared', schema: SHARED_SCHEMA }
  )
))

phase('Harness')
const harness = await parallel([
  () => agent(
    CONTEXT + `
=====================================================================
YOU OWN: tools/playtest.py and tools/shoot.py
=====================================================================
Do NOT edit any other file. These are my tools and both have a real gap.

1. playtest.py HAS NO --level FLAG, so EIGHT OF TEN LEVELS HAVE NO INTERACTIVE-PATH
   REGRESSION TEST AT ALL. This matters more than it sounds: DEVELOPMENT.md records
   that two real bugs were found ONLY by playtest and by nothing else - boot hanging
   forever in a backgrounded tab (requestAnimationFrame does not fire there), and
   the player dying within 10 seconds of spawn. Both were on market, the one level
   it can reach. Add --level (and ideally --all) so every level's real interactive
   path is exercised: pointer lock, synthetic input, ctx.engine.step(DT) + render().
   Report the per-level results you get - if a level fails, that is a real find and
   you should report it rather than paper over it.

2. shots/report.json IS A SINGLE SHARED FILE AND CONCURRENT AGENTS OVERWRITE EACH
   OTHER'S COPY. A round-3 agent had to read draw and triangle counts out of
   shoot.py's stdout because of it. Make the report path carry the --tag (and level),
   the same way the Chrome profile lock already does after an earlier collision.

Keep both tools working exactly as they do today for existing invocations - other
agents are using them concurrently RIGHT NOW, so do not break the default path or
change existing output formats that agents parse.

Verify by actually running them, including at least three different levels.`,
    { label: 'harness:tools', phase: 'Harness',
      schema: {
        type: 'object', additionalProperties: false,
        required: ['passesCheck', 'fixed', 'summary'],
        properties: {
          passesCheck: { type: 'boolean' },
          fixed: { type: 'array', items: { type: 'string' } },
          perLevelPlaytest: { type: 'string' },
          bugsFound: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
        },
      } }
  ),
  () => agent(
    CONTEXT + `
=====================================================================
YOU OWN: src/game/main.js and src/game/scenarios.js
=====================================================================
Do NOT edit any other file. These are the integration files; level agents are
forbidden from touching them, so reported problems land here.

1. A REAL INCONSISTENCY IN THE BONEYARD PROFILE. LEVELS.boneyard.env publishes
   sunElevation: 66 while level_boneyard.js requests 58 via sky.setSolarArc() on
   frame 1. The level's call runs AFTER main applies the profile, so 58 is what
   renders - and every shadow-aware number in that level (shadeOffset, the shade
   zones, the hangar shafts, the bounce aim, all five camera poses) is solved
   against 58. So the profile is dead code that contradicts the level. Reconcile
   it, keeping 58 as the rendered value, and verify the boneyard's captures do not
   move. Note separately: the boneyard's roster brief specifies HIGH NOON with short
   hard shadows, and its round-3 verifier observed the tarmac shadows raking long
   and soft. 58 degrees may itself be wrong against the brief - report what you find
   and whether changing it is a level decision rather than yours.

2. scenarios.js combatMark() WALKS A WORLD-AXIS SQUAD FOOTPRINT that does not rotate
   with the camera bearing: base.x + (i-1.5)*3.0, base.z - i*3.4. And when no
   standoff in [dMin,dMax] has all four cells walkable, it falls back to
   aheadOfCamera(dMin) WITH NO WALKABILITY CHECK AT ALL. On highrise - a level whose
   premise is a 176 m drop - that makes an edge-facing hero1 impossible, because
   every squad mark lands off the plate. Rotate the footprint into the camera bearing
   and make the fallback checked.

3. highrise ASKS TO GO FULLY DECLARATIVE. LEVELS.highrise.env should carry
   timeOfDay: 0.712, turbidity: 0.062 and the fog block. The level currently
   overrides all three from update() behind three guards (API present, sky agrees
   the disc is down, runs once), and its own comments say that is the wrong place
   for it. sky.js resolveEnvProfile already reads env.fog / env.fogTint /
   env.fogTintAmount, so the declarative path exists. Move it, and verify highrise's
   captures are unchanged or better. IMPORTANT: a sibling agent owns sky.js this
   round and may be changing setFog's key handling - read the file as it stands.

Also check the LEVELS table for any OTHER env profile that contradicts what its
level does at runtime - the boneyard case suggests this class may not be unique.

VALIDATE: python tools/check.py --all, the canary byte-exact, and capture boneyard
and highrise to prove nothing moved that you did not intend.`,
    { label: 'harness:integration', phase: 'Harness',
      schema: {
        type: 'object', additionalProperties: false,
        required: ['passesCheck', 'fixed', 'canary', 'summary'],
        properties: {
          passesCheck: { type: 'boolean' },
          fixed: { type: 'array', items: { type: 'string' } },
          deferred: { type: 'array', items: { type: 'string' } },
          canary: { type: 'string' },
          summary: { type: 'string' },
        },
      } }
  ),
])

// Hand the level agents an accurate description of what is newly available.
const newAPI = sharedResults.filter(Boolean).map((r) => {
  const api = (r.newLevelAPI || [])
  return '### ' + r.file + '\n' + (api.length ? api.map((a) => '  - ' + a).join('\n')
    : '  (no new level-facing API reported)') + '\n  FIXED: ' +
    (r.fixed || []).slice(0, 8).map((f) => String(f).slice(0, 220)).join('\n         ')
}).join('\n\n')

log('Shared phase done. Handing the new level-facing APIs to the level agents verbatim.')

// ---------------------------------------------------------------------------
// PHASE 3 - the levels, now able to consume the above.
// ---------------------------------------------------------------------------

const LEVELS = [
  { id: 'refinery', cls: 'Refinery', name: 'Zubair Refinery', r3: 46,
    gate: 'FAILS the corrected dead-region gate on overview (14.06%) and hero3 (12.50%), limit 12.',
    task: `Your critic's verdict: "you have built a refinery and then lit it like a car park."
This is the only level whose score did not move in round 3, and its single biggest
gap is fully diagnosed and cheap - do it FIRST.

THE LIGHT DOES NOT OBEY THE LEVEL'S OWN PREMISE, AND IT IS MEASURED, NOT TASTE.
LEVELS_ROSTER specifies "orange fire from above and cold floods from below". In
hero1, rows 0-140 measure 11.8% warm / 76.4% cool at mean R-B -0.0091, while rows
430-560 measure 71.5% warm / 16.5% cool at +0.0520. The premise is not weakly
delivered, it is INVERTED - cool above, warm below.

Proof it is rig balance and not fog or grade: the flame measures R-B +0.2951, the
derrick lattice 5 m under it +0.0443, and then the two distillation columns 30-50 m
away drop to +0.0075 and -0.0173 (C2 is ACTIVELY COOL) while the apron 110 m from
the fire measures +0.0510. The fire is 6.4x less warm on the thing it stands beside
than on the ground it cannot reach, because three 6800 K uplights at a 3.6 m
stand-off out-vote a 6200 cd source at 40 m on precisely the surfaces the brief
assigns to the fire. Everything above 15 m in the frame belongs to the mercury
units. This is a handful of numbers in _buildLamps.

Round 3 fixed "everything is orange" (87.6% warm wedge) by winding the flare's
range 240 -> 110 and landed on 43.0% warm / 42.9% cool - a dead-even grey wash.
Do not swing it back; solve for the brief.

ALSO: hero3 is bimodal rather than composed - 8x8 cell medians give left two
columns 0.28-0.79 and right two columns 0.03-0.24, with 14 of 16 cells at or below
0.08. And the tank shell has now failed FOUR passes: medians 0.39-0.79 against a
frame median of 0.201, after six changes to uv (0.30/0.62/0.34/0.90/1.75/2.90) and
two to albedoTarget. Stop tuning it and find out what it actually is.

BUDGET WARNING: lv_firefight is at 466 draws / 4,048,784 tris against ~500/4.5M.
You have ~34 draws and ~450k triangles in the worst frame. The lighting fix costs
almost nothing, which is another reason to do it first.` },

  { id: 'metro', cls: 'Metro', name: 'Line 4 — Zarechnaya', r3: 46,
    gate: 'FAILS the corrected dead-region gate on FOUR of five framings: overview 20.31%, interior 29.69%, hero1 17.19%, hero2 15.62% (limit 12). Worst in the build.',
    task: `Round 3 built a station. It did not light one. Your critic's verdict:

"The level is lit by four non-shadowing, distance-invariant fill terms and
therefore has no lighting design at all."

lighting.js's interior path supplies AmbientLight 0.42 + HemisphereLight 0.55 + a
camera-anchored cfill hemisphere at 0.85 weight, and then level_metro.js _buildFill
adds its OWN HemisphereLight at intensity 1.55. None casts a shadow, none falls off
with distance, and together they dominate all 21 practicals.

Every other defect in this level is a symptom of that one decision:
  - up-facing surfaces clip (rubble chunk top face 229.8, p95 254.6)
  - down-facing surfaces get nothing (collapse 17.7 mean, 87% under 26/255)
  - the arcade wall is flat along its length: 1.35:1 over 5 m, against the market's
    sunlit 1.51:1; the dado sits at 146-151 for 8 of 14 bins
  - nothing has a contact shadow, because the dominant contributor cannot cast one
  - the enemy is DARKER than his own background (body 104 against wall 185)
  - what is lit is "whatever faces the lens" rather than "whatever is near a lamp",
    which is why the overview's left third measures 14.2 while the same wall in
    lv_firefight measures 185

Round 2 was rejected for being black; round 3 fixed the measurement and lost the
image. THE FIX IS FEWER FILL TERMS AND MORE SOURCES. Your critic names the route
and it is level-owned, touching no shared file: cut _buildFill to ~0.55 and publish
level.lightRig = { preset:'practicals', cfill:0.30, amb:0.85 } through the supported
_adoptLevelRig path, then buy the lost floor bounce back with real fixtures.

The practical cap that blocked you last round has been raised this round - read the
shared report above for exactly what is now available and how much it costs.

ALSO: props_metro.js took only 33 of round 3's 1,077 changed lines, so every
primitive-shaped object is still an unworked round-2 finding. The most concrete
single defect in the whole build is here: a ~7-facet near-white rubble chunk sitting
close to camera in hero1, the brightest thing in the lower frame, with no grime at
all in a level whose identity is rat-run grime, and not reading as seated - offset
contact shadow, no AO where it meets the floor. raw_concrete's popcorn normal is
also untouched while its two sibling surfaces were fixed.

You are the most under-spent level in the build: 186 draws and 1.02M triangles, 37%
of the draw cap and 23% of the triangle budget. Nothing here is a budget problem.` },

  { id: 'bunker', cls: 'Bunker', name: 'Facility K-17', r3: 45,
    gate: 'FAILS the corrected dead-region gate on THREE of five framings: interior 42.19%, hero2 31.25%, hero3 25.00% (limit 12).',
    task: `Round 3's incidence diagnosis was excellent work and it held. This round is about
legibility, and you have a specific mechanical bug in the signature frame.

1. THE MECHANICAL ONE. hero1's largest surface is a flat bright plate: strip-free
   patches high on the north wall read L 0.660/0.693 with a p05-p95 span of only
   0.14-0.20 and micro-detail energy hp3 5.4-7.2, against 29.2-43.1 on the SAME
   wall's lower band. Cause: level_bunker.js:3561-3562 runs boardMarks() to y=6.40
   in a room whose RG_CEIL is 11.00, so 42% of the wall height carries no form-board
   seams and no tie-rod cones - and it is precisely the band the camera looks at.

2. LEGIBILITY. Three of five framings fail the corrected dead-region gate and the
   level got noticeably darker in round 3: hero2 at mean 0.184 is the second-darkest
   frame in the build, with roughly the left third plus the upper band carrying no
   readable content, where the same corridor was legible throughout in the previous
   snapshot. blown_white also rose on three frames (hero2 0.76, interior 0.60,
   hero3 0.42) - the emergency strips are starting to clip. So you are simultaneously
   too dark in the field and clipping at the sources. That is a distribution problem,
   not an exposure one. NOTE: darkness itself is NOT the defect - a buried facility
   should be dark, and near_black_pct is deliberately not gated. Illegibility is.

3. hero1 IS A MONOCHROME GREY HALL: sat p50 0.095, an open evenly-ambient room with
   no alarm bar on any large surface and nothing in frame lit by anything you can
   point at. The level's premise (claustrophobic, oppressive, alarm state, long dark
   stretches) is delivered in exactly ONE of six frames - hero2, the spine corridor,
   which is genuinely good: layered cable trays against a red-lit oxide dado, real
   depth, real darkness, sat p50 0.214 and R-B +0.160 on the near wall. Work out what
   hero2 does that hero1 does not.

4. The roster's ROTATING RED ALARM BEACONS do not read as swept beams, only as a
   flat red ambient wash. The strip lights and fluorescents are bare glowing quads
   with no fixture housing - metro built a channelStrip() for exactly this problem
   this round; read how it did it (but do not edit metro's files).

You are under-spent at 247 draws / 1.15M triangles, ~26% of the triangle budget.
The practical cap that forced every round-3 lighting fix to be a re-site rather
than an addition has been raised - see the shared report above.` },

  { id: 'snowbound', cls: 'Snowbound', name: 'Kirovsk Pass', r3: 44,
    gate: 'PASSES the dead-region gate at 0.00% on all five framings - the OPPOSITE failure. But THREE of five frames fail the colour-grade gate: hero1 +0.0009, interior +0.0031, hero3 -0.0060 (INVERTED). hero3 is the only hard metric breach in the build.',
    task: `Your critic's verdict: "Inside 12 metres of every standpoint, this level contains
no modelled objects - only tinted primitives. boxR, box, cyl and revolve with ONE
flat face each."

Round 3's conifer rebuild and church masonry were real, measured wins and they are
not in question. Three things now:

1. THE NEAR FIELD HAS NO MODELLED OBJECTS. This is your biggest gap and it is a
   direct hit on the instant-fail list. The verifier also judged the drift field at
   2x to be "a scatter of hard-edged rectangular white slabs and cuboids with razor
   90-degree corners, flat faces, uniform albedo and no micro-relief, sparkle or
   translucent falloff - broken polystyrene sheet, not snow", in the level whose own
   brief names snow as its hardest material. And the convoy trucks got no new
   geometry at all in round 3: no lashings, jerry cans, chains or spare wheels.
   ruins built a reliefBox()/relBoxR atom this round for exactly this class of
   problem (bevelBox at 2 segments with per-vertex displacement hashed off local
   position - dished faces, wavy arrises) and measured its magnitude down once after
   it opened black canyons in the joints. Read how, and solve your own version.

2. THE COLOUR GRADE. Three of five frames have effectively none, and hero3 is
   inverted - the only hard metric breach in the build. IMPORTANT AND VERIFIED: this
   is NOT a round-3 regression. Restoring the round-2 level files and re-capturing
   under current shared code trips the same flag on the same three frames (hero1
   +0.0003, hero3 -0.0066, interior -0.0106). It is systemic to the level. hero3's
   shadow band is the conifer stand plus the viewmodel and its highlight band is the
   shared sky, so the frame has no warm/cool axis at all. You need something warm in
   the shadow band or something cool in the highlight band, in the geometry - not in
   the grade.

3. THE CONIFER TRUNKS. Every tree's trunk continues as a clean untextured pale spire
   well above its topmost frond, so the crowns terminate in bare needles. That single
   detail is what makes hero3's treeline read as dark antennas. Cheap, high payoff.

4. The overview remains the weakest framing (flat 43.4%, textured 7.0%). Round 3
   raised the ledge 8.0 -> 10.6 m and lifted dynamic range 0.531 -> 0.615, but the
   standpoint is 10 m from the nearest dacha so the composition is inherently
   roofs-over-village. Round 3's own note proposes the east buttress near z = -10
   looking SOUTH down the pass. If you agree after measuring, move it.

DEFEND the snow material's shading contract as before: sheen 0.70 with blue
sheenColor, sparkle emissive with real facet tilt, normalScale 1.45, albedo
calibrated against sky.js's ground-albedo assumption. Three critics have now called
it the best-reasoned authorship in the level. Improving the drift GEOMETRY is the
ask; do not regress the material.

Also: your own round-3 report says a veil in the church nave makes interior darks
unauthorable at honest values - the roof-hole shaft's inscatter, the blizzard
particles (present indoors) and the candle inscatter all land in the same 11 m of
air, and additive veil lifts a dark surface far more than a pale one, forcing the
iconostasis to a 0.075 albedo multiplier. Check whether the shared work this round
gives you a better route.` },

  { id: 'highrise', cls: 'Highrise', name: 'Meridian Tower', r3: 44,
    gate: 'PASSES every gate (worst dead-region 9.38%). Its critic scored it 44 anyway.',
    task: `Round 3 found the dropped fog key, which was the right find. Two gaps now, and the
first is a shared-system consequence you should verify has changed.

1. THE LEVEL HAS NO COOL LIGHT IN IT, AND THE ROOT IS THE SKY. Your critic: "The
   dome's zenith measures R/B 1.08 - neutral, not the 0.55-0.70 a clear sunset
   zenith has." A sunset's warm horizon needs a genuinely blue overhead or nothing
   in the scene has a cool fill to sit against. The sky.js owner was given exactly
   this finding this round - read the shared report above, re-capture, and MEASURE
   the zenith R/B yourself. Then do the level-side half: your practicals, glass
   tints and interior fills all have to sit against whatever the sky now gives you.

2. THE CITY IS NOW THE DOMINANT SUBJECT AND THE WEAKEST ASSET. It occupies ~55% of
   hero3. At 2x the facades DO have a real mullion grid and irregular warm/cool
   varied window lights, so it is better than it looks at full frame - but every
   tower is a plain flat-topped extruded box with no setbacks, crowns or mechanical
   penthouses, and the roofs are featureless flat planes with no plant, tanks or
   aerials. That last part matters because YOU ARE LOOKING DOWN AT THEM. Window
   lights render as soft round bokeh dots rather than lit rectangular rooms.
   You have ~3.1M unspent triangles and 168 unused draws - the largest unused
   headroom of any level with a big background subject. Spend it here.

3. Columns still render as sharp-cornered boxes with no rebar, and the marquee
   curtain wall photographs as blank rectangles.

4. Judge hardest whether the 176 m drop is legible from hero1 - that is the level's
   entire premise, and round 1 found you could not see down. NOTE: the integration
   owner is fixing scenarios.js combatMark() this round, which previously made an
   edge-facing hero1 impossible because the squad footprint did not rotate with the
   camera bearing and its fallback had no walkability check. Re-check whether an
   edge-facing pose is now available to you.` },

  { id: 'boneyard', cls: 'Boneyard', name: 'AMARG Boneyard', r3: 43,
    gate: 'PASSES the dead-region gate everywhere (0.00%), but has the highest flat_area in the build: 34-44% across four of five frames. Grade is weak on hero1 (+0.0255) and hero2 (+0.0171).',
    task: `Round 3's mirage diagnosis was the best single find of the round and it is not in
question. But this level EFFECTIVELY DID NOT SPEND: +0.97% triangles, -2 draws. It
has ~2.5M triangles and ~70 draws of headroom and used almost none of it, and its
largest surfaces are now the flattest in the build.

1. THE AIRFRAMES ARE PLASTIC PROPS. At 2x the fuselage has frame lines, a panel
   seam, a nice stencilled "AMARG / C-114" and boarding stairs - and no rivets, no
   panel-to-panel value variation, no exhaust or oil streaking, no sun-bleach
   differential, no dents, no oxidation. The UNDERSIDE IS NEARLY AS BRIGHT AS THE
   TOP WITH NO CONTACT DARKENING, which is the single thing most responsible for the
   plastic read. You reported that yourself as a shared need ("the shared rig has no
   GROUND BOUNCE term for down-facing normals") and the lighting.js owner was given
   it this round - read the shared report above and use the real term instead of your
   local workaround if one now exists.

2. YOUR LIGHTING CONTRADICTS YOUR OWN ROSTER ENTRY. The roster specifies high noon,
   brutal overhead sun, short hard shadows. The tarmac shadows in hero1 are long,
   soft and raking to one side, i.e. a low sun. The integration owner is reconciling
   a related bug this round - LEVELS.boneyard.env publishes sunElevation 66 while
   your file requests 58 via setSolarArc() on frame 1, and 58 is what renders
   because your call runs after the profile is applied. Every shadow-aware number in
   your file is solved against 58. Decide what the brief actually needs, say so
   explicitly, and re-solve your shade zones, shadeOffset, hangar shafts, bounce aim
   and all five poses against it. This is your call, not the integration owner's.

3. THE SHRINK-WRAP PATCH at the nose is a visibly tiled cross-hatch swatch with a
   hard rectangular boundary rather than wrapped plastic.

4. THE TARMAC HAS NO STORY ON IT. High noon is the hardest condition in the roster
   and it punishes flat surfaces hardest.

You are near the DRAW cap (429 of ~500) with large triangle headroom, so add detail
by merging into existing draws or instancing, never by adding materials - which is
exactly what you did correctly last round. The technique was right; the spend was not.` },

  { id: 'jungle', cls: 'Jungle', name: 'Mekong Delta', r3: 38,
    gate: 'PASSES every gate on every frame, and its critic scored it 38/100. This is the clearest case in the build of metrics being necessary and not sufficient.',
    task: `Your critic's verdict: "Foliage has no light response - the canopy does not transmit
and nothing overhead casts, so the level's dominant material is lit as opaque
painted card."

1. FOLIAGE LIGHT RESPONSE IS YOUR WHOLE LEVEL. A leaf is thin and translucent; lit
   from behind it glows, and a canopy above the camera must cast onto what is below
   it. Neither happens. Everything else here is secondary. Round 3 built the
   mid-storey stratum that was genuinely missing between 2 and 9 m, and that was
   right - now make it respond to light. The lighting.js owner was given your two
   shaft findings this round (haze opacity welded to floor irradiance through
   def.lux, and _makeShaft fading the glow to zero over the last 22% of the cone so
   no beam ever lands). Read the shared report above and use whatever landed.

2. THE GROUND IN THE SIGNATURE FRAME IS GREEN FELT. Uniform mid-green fuzzy carpet:
   even stipple, no hue, value or scale variation, no mud, soil, puddles or roots.
   Your brief warns BY NAME that saturated green must not become a flat green wash.
   Round 3 spent ~680k triangles on volume rather than on this material.

3. LEAF LITTER CARDS FLOAT OR INTERSECT THE GROUND AT WRONG ANGLES with no contact
   shadows - clearest at hero1 centre. The small three-leaf understory sprites repeat
   at identical scale and orientation in a near-uniform scatter.

*** YOU HAVE ALMOST NO BUDGET LEFT AND THIS IS NOW A CONSTRAINT ON YOUR APPROACH. ***
lv_firefight is at 482 draws / 4,157,056 tris against ~500 / 4.5M: 96% of the draw
cap and 92% of the triangle cap. Round 3 already had to trim 235k back after first
measuring 485/4,392k. You reported the reason yourself: the mid-storey and litter
passes added an almost IDENTICAL ~680k triangles to all five framings, so the 2x2
chunk grid (43 m bounding spheres over a 120x124 m level) rejected essentially
none of it. Every fix this round must be free or must pay for itself. Prefer
shading and material work over geometry, and if you can make the chunking actually
cull, that buys back headroom for everything else.` },

  { id: 'ruins', cls: 'Ruins', name: 'Bayon Ruins', r3: 38,
    gate: 'PASSES the dead-region gate everywhere, but hero1 grade_split is +0.0146 (second weakest in the build) and overview vertical_imbalance is 2.275, close to the 2.5 limit.',
    task: `Your critic's verdict names something different from every other level in the build:
"The Bayon face. Everything else on this list is a defect; this one is the level's
identity failing."

1. THERE ARE NO CARVED FACES IN ANY OF THE FIVE PUBLISHED FRAMINGS. The roster brief
   LEADS with "carved faces". Bayon is defined by them - it is the one thing a viewer
   would recognise, and the level is named after it. You built a faceTower this round
   with coursed frusta, per-course jog and per-course grime, which is good masonry -
   and it has no face on it. This is your entire round if it needs to be. A carved
   face is a hard procedural modelling problem: brow ridge, closed eyes, broad nose,
   the wide serene mouth, an ear-to-crown headdress, all at a scale that reads at
   20 m and survives at 3 m. Build it properly, put it where the camera already
   looks, and light it so the relief reads.

2. THE GROUND MIST IS STILL ABSENT FROM hero1 AND hero2. Round 3 fixed a genuinely
   subtle bug (the mist cell's alpha peaked at vv=1, which CanvasTexture's Y flip
   puts at the card's BOTTOM edge, buried 12 cm in the terrain) and added
   mistNearFade. That was correct work - but the verifier reports hero1's air is
   still clear under a bare blue-teal gradient sky, and "dawn in ground mist" with
   "long god rays between towers" is the level's stated condition. Verify with pixels
   whether the mist is now present and simply too weak, or still not arriving. The
   postfx owner was given your depth-aware soft-particle request this round - read
   the shared report above, because if depth is now exposed you can delete the
   hand-written keep-out list your own source calls a workaround.

3. MASONRY OUTSIDE THE NEW RELIEF WORK IS STILL PRISTINE 90-DEGREE CUBOIDS against a
   brief that explicitly demands chipped edges and differential erosion. Your
   reliefBox atom exists and is measured - apply it more widely. Moss, lichen and
   vertical water staining DO work; keep them.

4. hero1's grade is the second weakest in the build at +0.0146 and it went DOWN in
   round 3 (from +0.0430) - your own note says the interim 2.8-13 m mist window cost
   it half its grade split and you pulled the window in to 1.4-7 m. Re-check where
   it stands and get the dawn warm/cool axis back.

You have 95 draws and 2.83M triangles spare, the second-largest headroom in the
build. A carved face can be expensive.` },
]

const FIX_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['level', 'passesCheck', 'done', 'summary'],
  properties: {
    level: { type: 'string' },
    passesCheck: { type: 'boolean' },
    done: { type: 'array', items: { type: 'string' } },
    notDone: { type: 'array', items: { type: 'string' } },
    usedNewSharedAPI: { type: 'array', items: { type: 'string' } },
    budget: { type: 'string' },
    measured: { type: 'string' },
    gateAfter: { type: 'string' },
    sharedNeeds: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

phase('Levels')

const fixes = await parallel(LEVELS.map((lv) => () =>
  agent(
    CONTEXT + `
=====================================================================
YOU OWN BOTH FILES OF ONE LEVEL: ${lv.id} — "${lv.name}"
  src/world/level_${lv.id}.js   (GAME.Level${lv.cls})
  src/world/props_${lv.id}.js   (GAME.Props${lv.cls})
=====================================================================
Do NOT edit any other file. Seven other level agents are working concurrently, and
the shared render files were finalised earlier this round - do not touch them.

Round 3 scored this ${lv.r3}/100. Levels 1 and 2 plateaued at 49-52 after four
rounds each, so treat the low fifties as the realistic near-term target.

YOUR CURRENT STANDING ON THE CORRECTED GATE:
${lv.gate}

*** WHAT IS NEWLY AVAILABLE TO YOU THIS ROUND ***
The shared rendering systems were fixed FIRST this round, specifically because five
of eight levels independently reported them as the binding constraint. These are
the reports from the four agents who owned them, verbatim. Use what is real; if a
described API does not behave as reported, MEASURE and say so.

${newAPI || '(shared phase reported nothing)'}

${lv.task}

APPROACH:
1. Read both your files fully, and the specific functions behind everything named
   above, before changing anything.
2. Prefer STRUCTURAL fixes. On this project, tuning a broken approach has failed to
   move the measurement over and over - round 2 halved bunker's normalScale twice
   with no effect because the driver was incidence, and metro's cab was modelled
   three times when the defect was the camera being 11 degrees off its face normal.
3. DO NOT REGRESS. Every level renders with zero JS errors. An exception or a visual
   regression is worse than the defect it replaces.
4. Preserve the published contract: cameraPoses (overview, hero1, hero2, hero3,
   interior), anchors, lightShafts, practicalLights, colliders, navGrid, raycast,
   sampleGround, paintGroundContact.
5. If you still need something from a shared system, report it in sharedNeeds.

VALIDATE:
  cd ${ROOT} ; python tools/check.py src/world/level_${lv.id}.js Level${lv.cls}
  cd ${ROOT} ; python tools/check.py src/world/props_${lv.id}.js Props${lv.cls}

VERIFY VISUALLY - capture and READ the PNGs, do not infer:
  python tools/shoot.py lv_overview lv_hero1 lv_hero2 lv_hero3 lv_interior --level ${lv.id} --tag ${lv.id} --w 1280 --h 720 --t 1.5 --timeout 600
  python tools/analyze.py shots/lv_hero1_${lv.id}.png
Report draws and triangles per framing before and after, your
coverage.dead_cell_med_pct per framing (this is the gate now), the grade_split, and
what you actually SAW. Confirm you are under ~500 draws and ~4.5M triangles on
EVERY framing including lv_firefight.

An interactive regression test may now accept --level (a sibling agent added it this
round). If it does, run it on your level and report the result.`,
    { label: 'fix:' + lv.id, phase: 'Levels', schema: FIX_SCHEMA }
  )
))

const sharedNeeds = fixes.filter(Boolean).flatMap((f) => (f.sharedNeeds || []).map((s) => f.level + ': ' + s))
log('Levels done. ' + sharedNeeds.length + ' remaining shared needs reported (deferred to round 5).')

// ---------------------------------------------------------------------------
// PHASE 4 - critique
// ---------------------------------------------------------------------------

const CRITIC_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['level', 'score', 'verdict', 'presentable'],
  properties: {
    level: { type: 'string' },
    score: { type: 'number' },
    verdict: { type: 'string' },
    movedSinceRound3: { type: 'string' },
    biggestRemainingGap: { type: 'string' },
    presentable: { type: 'boolean' },
    sharedSystemStillBlocking: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['file', 'severity', 'issue', 'fix'],
        properties: {
          file: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          issue: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
  },
}

phase('Critique')

const critiques = await parallel(LEVELS.map((lv) => () =>
  agent(
    CONTEXT + `
You are a BRUTALLY HARSH art director who has shipped AAA shooters. You are
reviewing ${lv.id} — "${lv.name}" after its FOURTH round. Round 3 scored it ${lv.r3}/100.

Levels 1 and 2 plateaued at 49-52 after four rounds each. Grade against a shipped
title, not against this level's own past, and do not inflate for effort.

Capture the full published set with --tag ${lv.id}crit (lv_overview, lv_hero1,
lv_hero2, lv_hero3, lv_interior, lv_firefight), READ every PNG at full size and at
2x on anything you intend to criticise, and run analyze.py on each. GATE ON
coverage.dead_cell_med_pct (< 12), not the saturated dead_cell_pct.

Read the level and props source behind everything you criticise. Two rounds running,
the most valuable findings came from reading source and probing the live scene
rather than from looking at pixels alone - a market fire emitter running in
highrise, a documented fog density that was never in the object literal, a mist
alpha peaking at the card's buried bottom edge. Look for that class.

hero1 is the signature image. Judge it hardest.

This round fixed the SHARED rendering systems first, because five of eight levels
named them as the binding constraint. So also answer specifically: is this level
still blocked by a shared system, or is the remaining gap now genuinely its own?
Put that in sharedSystemStillBlocking. If the level failed to take up a capability
that was made available to it this round, say so - that is a real finding.

Report a blunt verdict, a score, what moved and what did not since round 3, the
single biggest remaining gap, and findings each naming ONE owning file with a
concrete technical remedy. State plainly whether this level is genuinely presentable
or still reads as a tech demo, and why.`,
    { label: 'critic4:' + lv.id, phase: 'Critique', schema: CRITIC_SCHEMA }
  )
))

// ---------------------------------------------------------------------------
// PHASE 5 - verify
// ---------------------------------------------------------------------------

phase('Verify')
const verify = await agent(
  CONTEXT + `
Round 4 is finished. Confirm the whole build is healthy and report the truth. Your
predecessor's round-3 report was excellent and its one flaw is instructive: it
reported "39 of 40 frames inside every metric gate" on the strength of a metric
that was SATURATED and returned 0.00% on every frame ever measured, including both
frozen references. Re-gated correctly, 12 of 40 frames failed. Do not repeat that -
sanity-check any metric you lean on by confirming it can separate a frame you
believe is good from one you believe is bad.

1. cd ${ROOT} ; python tools/check.py --all   (33+ modules must load clean)

2. *** GREP FOR DEBUG PROBES ON THE ERROR CHANNEL. *** Three have now been removed
   (VMDIAG, BMDIAG, vfx.dbg). Search src/ for logError calls whose first argument
   is an ALL-CAPS or obviously diagnostic tag, INCLUDING flag-gated ones - a
   flag-gated probe on that channel is still a defect because it fails a capture the
   moment the flag is set. Report and remove anything you find.
   Also re-check ai.js:5930 and :6003 ('ai.spawn.offscreen'), which round 3 left in
   place as a judgement call: it is a real composition-fault reporter, silent on all
   42 captures, but it WILL fail a capture if it ever fires. Decide and say why.

3. *** CANARY GATE - hash the PNGs, do not merely compare counts ***
   python tools/shoot.py street --w 1280 --h 720 --t 1.5   -> 422 / 4,201,372
   python tools/shoot.py quay --level harbor --w 1280 --h 720 --t 1.5 -> 270 / 2,047,292
   READ both PNGs and confirm they are still the known-good images. This round
   changed FOUR shared render files plus main.js and scenarios.js, so this gate
   matters more than in any previous round.

4. *** THEN GO BEYOND THE CANARY, BECAUSE IT IS STRUCTURALLY BLIND TO THE WORST
   BUG CLASS. *** A market-coordinate fire emitter ran in highrise for a whole round
   while both canaries stayed byte-perfect. This round's shared changes are exactly
   the kind that leak into levels 3-10 only. For each of the 8 levels, capture
   lv_overview lv_hero1 lv_hero2 lv_hero3 lv_interior lv_firefight
   (--tag <id>v4) and look for anything that does not belong in that level.

5. playtest.py may now accept --level (added this round). If it does, RUN IT ON ALL
   TEN LEVELS and report each result - eight of ten have never had an interactive
   regression test. If any level fails, that is a genuine find; report it with the
   error rather than working around it. If the flag was not added, say so and run
   market only.

6. python tools/analyze.py on every capture. Report per frame:
   coverage.dead_cell_med_pct (gate < 12), grade_split (> 0.004),
   crushed_black (~0), blown_white (< 1.5), vertical_imbalance (< 2.5),
   flat_area_pct (< 45). Name EVERY frame outside target and give the number. State
   the total as "N of 40 frames fail at least one gate" - round 3's honest figure
   was 12 of 40, so that is the number to beat.

7. Report draws and triangles per framing and FLAG any breach of ~500 / ~4.5M.
   Watch jungle and refinery hardest: they entered this round at 482/4,157,056 and
   466/4,048,784 respectively, i.e. 96% and 93% of the draw cap.

8. LOOK AT THE IMAGES. Per level, say whether it improved and name any regression.
   Be specific and be willing to say a level got worse.

9. Contact sheet per level:
   python tools/sheet.py shots/lv_overview_<id>v4.png shots/lv_hero1_<id>v4.png shots/lv_hero2_<id>v4.png shots/lv_hero3_<id>v4.png shots/lv_interior_<id>v4.png --cols 3 --cell 470 --out shots/<id>_r4.png

Report honestly. Do not claim a fix landed if the image does not show it.`,
  { label: 'verify:r4', phase: 'Verify',
    schema: {
      type: 'object', additionalProperties: false,
      required: ['modulesClean', 'canaryIntact', 'playtestPass', 'perLevel', 'jsErrors', 'gateFailures', 'notes'],
      properties: {
        modulesClean: { type: 'string' },
        canaryIntact: { type: 'boolean' },
        canaryHashes: { type: 'string' },
        playtestPass: { type: 'boolean' },
        playtestPerLevel: { type: 'string' },
        debugProbesFound: { type: 'array', items: { type: 'string' } },
        crossLevelLeaks: { type: 'array', items: { type: 'string' } },
        perLevel: { type: 'string' },
        jsErrors: { type: 'array', items: { type: 'string' } },
        gateFailures: { type: 'string' },
        budgetBreaches: { type: 'array', items: { type: 'string' } },
        regressions: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
      },
    } }
)

return {
  shared: sharedResults.filter(Boolean).map((r) => ({
    file: r.file, ok: r.passesCheck, fixed: (r.fixed || []).length,
    newAPI: (r.newLevelAPI || []).length, canary: r.canary,
    cost: r.measuredCost, summary: r.summary,
  })),
  harness: harness.filter(Boolean),
  levels: fixes.filter(Boolean).map((f) => ({
    level: f.level, ok: f.passesCheck, budget: f.budget, gateAfter: f.gateAfter,
    done: (f.done || []).length, usedNewAPI: f.usedNewSharedAPI || [],
    notDone: f.notDone || [],
  })),
  sharedNeeds,
  scores: critiques.filter(Boolean).map((c) => ({
    level: c.level, score: c.score, presentable: c.presentable,
    moved: c.movedSinceRound3, gap: c.biggestRemainingGap,
    blocked: c.sharedSystemStillBlocking, verdict: c.verdict,
  })),
  verify,
}
