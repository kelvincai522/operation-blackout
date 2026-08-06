# Where this stopped, and how to pick it up

Round 4 is complete — shared systems, tools, integration and all eight levels. This
file records the verified state and what round 5 should do.

## State of the tree

`main` is healthy and independently verified after the level phase:

- `python tools/check.py --all` → 33/33 modules clean
- **Canary intact.** Counts exact (`street` 422 / 4,201,372, `quay` 270 / 2,047,292),
  confirmed twice through two different harnesses. `quay` is byte-identical to every
  reference taken this round. `street` is byte-stable across four runs modulo a
  single-LSB flicker on one pixel.
- `python tools/playtest.py --all` → **10/10 levels PASS**, 600/600 frames, 15/15
  systems, zero JS errors
- **No cross-level leaks**, verified by a live scene-graph probe rather than by
  screenshots — see below
- No budget breaches. Peaks: 468 draws (94% of cap), 4,191,770 triangles (93%)

## Round 4 outcome

Every level improved. Scores are out of 100, graded against a shipped title.

| level | R3 | R4 | what closed |
|---|---|---|---|
| refinery | 46 | **50** | the flare now out-votes the floods by 5.7× |
| metro | 46 | **48** | 40 practicals instead of 24, and an actual lighting design |
| bunker | 45 | **47** | form-board seams reach the ceiling the camera looks at |
| highrise | 44 | **47** | the city was inside-out; the zenith is now cool (R/B 0.577) |
| boneyard | 43 | **46** | it finally spent (+47.6% triangles) |
| snowbound | 44 | **45** | the near field is modelled; the grade still is not |
| ruins | 38 | **43** | the Bayon faces exist (+77.4% triangles) |
| jungle | 38 | **43** | foliage transmits, for 26 *fewer* draw calls |

**Gate failures went from 12 of 40 frames to 2 of 40** (3 of 48 including
`lv_firefight`). All remaining failures are one defect on one level.

No critic has returned `presentable: true`. Levels 1–2 plateaued at 49–52 after four
rounds; refinery is now inside that band.

**The round's structural lesson.** It ran shared-systems-first, because five of eight
levels had independently named the shared rendering systems as their binding
constraint. That was correct: `MAX_PRACTICALS_RIG = 24` turned out to protect almost
nothing (1024 fragment uniform vectors against ~168 spent by 24 lights; the
16-texture-unit cliff applies only to shadow casters and every rig practical is
`castShadow:false`; ~0.009 ms per light, at the timer's resolution limit). After the
split cap, the three levels that had reported being blocked — bunker, metro, refinery —
are precisely the three now furthest above the old limit at 44, 40 and 35 practicals.
Fixing the shared layer first unblocked eight levels at once.

## Open work for round 5

**1. snowbound's colour grade — the only hard metric breach in the build, and it now
has an actionable diagnosis for the first time in three rounds.**
`grade_split` on hero3 −0.0050, hero1 +0.0013, firefight +0.0019 (gate > 0.004). The
shadows are correctly cool; the *highlights are just as cool*, and on hero3 cooler than
the shadows, which is what makes the split negative. The level applies a flat blue cast
to the whole frame instead of splitting warm against cool. It is not the grade code:
this level's own overview passes at +0.0400 and its interior, which has candlelight to
work against, passes at +0.0074. The three failures are the near-field whiteout
framings where `mean_saturation` is 0.081–0.100 against 0.277 on the market — almost no
chroma for a grade to act on. **The fix is a warm term in the highlights, not a cooler
shadow.**

**2. `lv_firefight` photographs a firefight with no visible opponent, across most of
the roster.** Refinery, jungle and metro show muzzle flash, tracers and an ejected
shell with no figure findable anywhere in frame; bunker has two, small and pushed into
the lower-left corner. `ai.spawn.offscreen` correctly stayed silent on all of them,
which is exactly why this survived: it projects the bounds centre into NDC and asks
whether it is in the frustum, and the enemies *are* in the frustum — they are occluded
by jersey barriers, pipe racks and foliage. **The composition pass has no occlusion or
screen-coverage test.** Invisible to every existing gate, and the firefight framing is
failing at its one job.

**3. Something is directly ahead of the snowbound spawn.** The scripted playtest
travels 11.96 m with `idle:356 / walk:122`, against ~35 m and `idle:41 / walk:421` on
the six levels that move freely. The input is identical on every level. Same signature
as harbor's known 9.87 m — but harbor is frozen and snowbound is not, so this one is
actionable. No gate catches it.

**4. Levels that still have not spent.** bunker (~250 draws and ~3.3M triangles
unused) and metro (~285 and ~3.35M) remain the cheapest in the roster by a wide margin.
bunker added +3.5% triangles this round.

**5. Named weaknesses, per level, from the round-4 critics.** boneyard: fuselages still
have scribed panel lines over one smooth albedo — no rivets, no streaking, no dirt in
the seams; hero3's tail fin is the largest flat surface in the build at 43.5% against a
45 gate. ruins: masonry is still perfectly rectangular blocks with sharp edges; only
the water staining of "chipped edges, differential erosion, water staining" landed.
jungle: the mid-ground dissolves into the flat green wash the roster warns about by
name. highrise: the sky is fixed but the interior fill is not, so floor-plate framings
are warm end to end. bunker: the sandbags are one rounded shape in tidy rows. refinery:
the floods measure `ffffff` — neutral, not cold — so "cold floods from below" is
neutralised rather than delivered.

## Resolved since the last edition of this file

- **`street.png` byte-reproducibility — SOLVED, and it was not a renderer defect.** The
  0.77%-of-pixels delta reproduces exactly and is *identical across four runs*, so it is
  not flipping. Amplifying the difference image shows every large-value pixel lying on a
  one-pixel-wide high-contrast silhouette — overhead power and washing lines against
  bright sky, awning edges, foliage edges. It is a TAA sub-pixel resolve difference.
  `shots/street.png` is a stale artifact left in the other resolve state;
  `street_canary.png` is the live reference. Re-bake or delete the stale one so the gate
  has a single unambiguous reference.
- **`ai.spawn.offscreen` — decided, keep.** It is a genuine composition-fault reporter,
  not instrumentation, and it is silent on a healthy build.
- **Debug probes — none remain.** A scan of all 46 non-catch `logError` sites found
  every one to be a genuine fault reporter on the lowercase `module.method` convention.
  The three previously removed (`VMDIAG`, `BMDIAG`, `vfx.dbg`) are gone from `src/`.
- **Branch `round4-wip` is superseded** and can be deleted. It held the interrupted
  level phase; the work that shipped is different and later.

## Verified non-leaks

Worth keeping, because this is the bug class the canary is structurally blind to — a
market-coordinate fire emitter ran in a high-rise level for a whole round while both
canaries stayed byte-perfect. Measured on the live scene graph, all ten levels:

- **vfx ambient emitters**: market 2 (its intended burnt-out sedan). Levels 3–10 all
  zero, except ruins' 2 which are at its own published coordinates. The
  `legacy = !(ctx.levelDef && ctx.levelDef.env)` gate is holding.
- **postfx heat shimmer**: non-null on boneyard only. No level-wide default.
- **weather**: matches the roster exactly; no storm state leaking off harbor.
- **sun**: metro and bunker report zero directional lights and sun intensity 0, correct
  for the two levels with no sky. Every other level's measured elevation matches its
  declared profile.
- *Latent oddness, not a regression*: harbor also carries the market sedan emitters,
  deliberately and documented — both frozen levels have `env:null` and fall through to
  the same fallback. Harbor is byte-identical to reference, so nothing moved.

## Honest assessment

Ten levels exist, all boot, all play, all pass their metrics but one, and none matches
a shipped Call of Duty — which ships on the order of 200 GB of photogrammetry and
offline-baked lighting against this project's zero bytes of external assets. Scores of
43–50 after four rounds, with levels 1–2 plateaued at 49–52, put the realistic near-term
ceiling in the low fifties.

What the project demonstrates is separable from that comparison, and is what
`docs/technical-writeup.md` is actually about — including §4.16, which documents how the
quality process itself worked and the three times its own instruments were wrong.
