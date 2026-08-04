# Where this stopped, and how to pick it up

Round 4 was stopped partway through, on request. This file exists so the state is
recoverable without the session that produced it.

## State of the tree

`main` is healthy and verified:

- `python tools/check.py --all` → 33/33 modules clean
- Canary exact, images confirmed by eye: `street` 422 draws / 4,201,372 tris,
  `quay` 270 / 2,047,292
- `python tools/playtest.py --all` → **10/10 levels PASS**, zero JS errors,
  600/600 frames, 15/15 systems, player alive, weapon fired on every level
- No budget breaches. Peaks: jungle `lv_firefight` 482 draws / 4,157,056 tris
  (96% of the draw cap), refinery 466 / 4,048,784

## What landed, and what did not

Round 4 ran **shared-systems-first**, inverting rounds 2–3, because five of eight
level owners had independently reported the shared rendering systems — not
triangles, not draw calls — as the binding constraint on their level.

**Landed (commit `e2522e9`).** All four shared render systems plus both integration
files and both tools. Every agent finished and self-verified. `lighting.js` gained a
split practical cap (build 1..64 / per-frame active), `groundBounce`, `shadowFill`,
shaft `haze`/`hazeGain`/`land`/`pool`, `beamFeather`/`beamPhase`, `svBox` and
`level.skyOccluders`. `materials.js` gained `grain`, `worldTile`/`uvScaleForWorld`,
`alphaLod` and a real `masonry` recipe. `sky.js` gained `setZenithTint` and
`setDepthHaze`, and every options bag now validates loudly. `postfx.js` gained
independent heat-shimmer scalars, path-length-driven mirage banding, published scene
depth for soft particles, and glow cards. Full detail and the measurements are in the
commit message.

**Did not land.** All eight level agents were mid-task when the round stopped. None
reported. Their partial work is snapshotted on branch **`round4-wip`** and is
explicitly *unverified* — it loads clean but no capture was taken and no agent
reached its own verification step. Level files on `main` are at their last verified
state (`b6cb5e1`).

To resume, re-run `docs/round4-workflow.js` (the exact script, kept for this
purpose). The shared phase will re-run — it is cheap relative to the level phase, and
re-running it is safer than trusting half-applied edits. Prefer this over building on
`round4-wip`.

## The per-level work that was queued

Round 3 scores and each critic's single biggest remaining gap. Every critic still
reported `presentable: false`.

| Level | R3 | The gap the critic named |
|---|---|---|
| refinery | 46 | Warm/cool is **inverted against its own brief**. Roster says "orange fire from above, cold floods from below"; hero1 rows 0–140 measure 11.8% warm / 76.4% cool, rows 430–560 measure 71.5% warm / 16.5% cool. Three 6800 K uplights at 3.6 m out-vote a 6200 cd flare at 40 m. A handful of numbers in `_buildLamps`. |
| metro | 46 | Lit by **four non-shadowing, distance-invariant fill terms**, so there is no lighting design. `_buildFill` adds a HemisphereLight at 1.55 on top of the shared interior amb 0.42 + hemi 0.55 + cfill 0.85. Fails the corrected dead-region gate on 4 of 5 framings. |
| bunker | 45 | `boardMarks()` runs to y=6.40 in a room whose ceiling is 11.00, so 42% of the wall height has no form-board seams — exactly the band the camera looks at. Fails the gate on 3 of 5 framings. |
| snowbound | 44 | **No modelled objects within 12 m of any standpoint** — only tinted primitives. Also the only hard metric breach in the build: hero3 `grade_split` −0.0060, inverted, with 3 of 5 frames carrying no grade at all. |
| highrise | 44 | No cool light anywhere, rooted in the sky (zenith R/B 1.08 where a clear sunset wants 0.55–0.70 — `setZenithTint` now exists for this). The city is ~55% of hero3 and is flat-topped boxes with featureless roofs you look down on. ~3.1M triangles unspent. |
| boneyard | 43 | Airframes read as plastic props: no rivets, no panel-to-panel variation, no streaking, and an underside nearly as bright as the top. `groundBounce` now exists for that. Effectively did not spend (+0.97% tris). Its shadows also contradict its own high-noon brief. |
| jungle | 38 | **Foliage has no light response** — the canopy neither transmits nor casts, so the level's dominant material is lit as opaque painted card. And it has almost no budget left, so fixes must be free or pay for themselves. |
| ruins | 38 | **There are no carved faces in any published framing.** The roster brief leads with them and the level is named after them. This is identity failing, not a defect. |

## Open questions I would take first

1. **`street.png` is not byte-reproducible run to run.** It flips between two stable
   states differing on 0.77% of pixels by more than 8/255 (max 185), while `meanL`
   and `dynamic_range` hold. `quay` *is* reproducible. Until this is diagnosed, the
   byte half of the canary gate is only meaningful on `street` when compared against
   the same-code noise floor. Everything downstream leans on this gate, so it should
   be first.
2. **`GAME.logError` is uncapped** — it pushes to an array for ever. A level that
   re-times its sun every frame against a broken LUT grows it without bound.
3. **Harbor never reaches sprint** in the scripted playtest path: 4.43 m/s peak
   against 6.4 elsewhere, 9.87 m travelled against ~35 m. Suggests something directly
   ahead of the harbor spawn. Harbor is frozen, so this was observed and not touched.
4. **`coverage.dead_cell_pct` is saturated** and retained only for reading old
   numbers. Gate on `coverage.dead_cell_med_pct`. Round 3's honest figure was
   **12 of 40 frames failing at least one gate** — that is the number to beat, not
   the "39 of 40 passing" that the broken metric produced. See DEVELOPMENT.md.

## Honest assessment

Ten levels exist, all boot, all play, all pass their metrics, and none of them
matches a shipped Call of Duty — which ships on the order of 200 GB of
photogrammetry and offline-baked lighting against this project's zero bytes of
external assets. The critics score them 38–46 out of 100 and call none of them
presentable. Levels 1 and 2 plateaued at 49–52 after four rounds each, so the
low fifties is the realistic near-term ceiling for the rest.

What the project does demonstrate is separable from that comparison, and is what the
write-up in `docs/technical-writeup.md` is actually about.
