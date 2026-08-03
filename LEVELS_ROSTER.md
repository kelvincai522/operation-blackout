# LEVEL ROSTER — 10 levels

Two shipped (`market`, `harbor`) and eight to build. Read this with
[ARCHITECTURE.md](ARCHITECTURE.md) and [DEVELOPMENT.md](DEVELOPMENT.md).

**The roster is designed so no two levels share a look.** Each one is pinned to
a different point in time-of-day, weather, palette, spatial character, light
source and dominant material family. If your level starts resembling another,
you have drifted.

| id | Name | Time | Condition | Light source | Space | Palette |
|---|---|---|---|---|---|---|
| `market` | Al-Bakr Market | golden hour | hot, dusty | raking sun | horizontal street | warm ochre / teal |
| `harbor` | Cold Harbor | 02:00 | storm, rain | sodium + lightning | vertical canyons | cyan-green / sodium |
| `snowbound` | Kirovsk Pass | overcast day | blizzard | diffuse whiteout | open valley + village | white / pale blue |
| `metro` | Line 4 — Zarechnaya | none (underground) | flooded | emergency fluorescents | tight tunnels | sickly green / grime |
| `highrise` | Meridian Tower | sunset | clear, windy | low sun + interior | extreme vertical | orange / glass blue |
| `boneyard` | AMARG Boneyard | high noon | arid, heat haze | brutal overhead sun | vast flat sprawl | bleached tan / alu |
| `bunker` | Facility K-17 | none (buried) | dry, dusty | failing lights + alarm | claustrophobic | concrete grey / red |
| `jungle` | Mekong Delta | midday | humid, drizzle | filtered canopy light | dense organic | saturated green |
| `refinery` | Zubair Refinery | dusk | clear | flare stacks + floods | industrial lattice | orange fire / steel |
| `ruins` | Bayon Ruins | dawn | ground mist | soft low sun | stone courtyards | grey-gold / moss |

Environment is **declarative**. Each level's `env` profile in the `LEVELS`
table in `src/game/main.js` configures sky, weather, grade, exposure and light
rig through existing APIs. **Do not edit shared systems to support your level** —
if a preset you need does not exist, say so in your report.

---

## Contract every level must satisfy

Your level publishes `cameraPoses` under these **exact standard keys**, so the
generic capture scenarios work with no new scenario code:

```
overview   a wide establishing shot of the whole space
hero1      the primary combat framing (this is the level's signature image)
hero2      a second distinct framing, different space and different depth
hero3      a third, ideally showing verticality or a landmark
interior   an enclosed/covered space within the level
```

Plus the full `Level` contract in ARCHITECTURE.md §5: `root`, `colliders`,
`spawnPoints`, `navGrid`, `cameraPoses`, `lightShafts`, `raycast`,
`sampleGround`, `build`, `update`.

**Publish named anchors** (`level.anchors = {...}`) for your major structures so
props can place against them. Never make props derive placement from a camera
pose — the harbor build broke exactly that way when poses moved mid-flight.

---

## Level briefs

### `snowbound` — Kirovsk Pass
An alpine road through a half-buried village, in a blizzard. Wooden dachas with
snow-loaded roofs, a stone church, a stalled convoy of trucks, a collapsed
bridge, pine forest fading into whiteout. Deep snow drifts that read as *depth*
(shovelled paths, drift shadows, footprints, tyre ruts). **Snow is the hardest
material here** — it needs a bright but not blown albedo, a soft translucent
falloff, sparkle glints, and blue-shifted shadow. Visibility falls off hard;
distant geometry should dissolve into white. Wind-driven snow streaks, not rain.

### `metro` — Line 4, Zarechnaya
An abandoned flooded subway station and its running tunnels. Platform with
tiled walls and fallen ceiling panels, escalator hall, service corridors, a
derailed train you can walk through, tunnels with standing water reflecting
emergency strips. **No sky at all** — every photon is from failing fluorescents,
red emergency strips, and worklights. Tight sightlines, hard corners, strong
darkness between light sources. Water on the floor everywhere; use the wet
vertex contract. Peeling tile, cable bundles, rat-run grime, soviet-era signage
in an invented script.

### `highrise` — Meridian Tower
An unfinished skyscraper at sunset: open floor plates, exposed columns and
rebar, plastic sheeting snapping in the wind, tower cranes, and a city
stretching to the horizon far below. **Verticality is the whole point** — open
edges with real drop, scaffolding, a glass curtain-wall section that reflects
the sunset. The low sun rakes straight through the open plates casting enormous
column shadows. The city below needs believable depth haze and points of light
as the sun drops.

### `boneyard` — AMARG Boneyard
An aircraft storage yard in the desert at high noon. Rows of shrink-wrapped
airframes, stripped fuselages, stacked engines and wings, hardstanding cracked
by heat. **Brutal overhead sun** — short hard shadows, bleached highlights, heat
shimmer over the tarmac, dust devils. This is the hardest lighting condition in
the roster and the trap is a flat, white, contrastless frame: use the enormous
aircraft shapes to throw deep shade you can fight in.

### `bunker` — Facility K-17
A buried cold-war command facility. Blast doors, concrete corridors with cable
trays, a control room with dead CRT banks, a reactor gallery, flooded lower
level. **Failing lights and an alarm state** — flickering fluorescents,
rotating red alarm beacons that sweep the walls, emergency lighting, long dark
stretches. Claustrophobic and oppressive. Concrete, steel, peeling paint,
rust streaks, dust in the beams.

### `jungle` — Mekong Delta
Dense tropical growth around a river and a ruined firebase. **Foliage density is
the challenge** — layered canopy, understory, vines, buttress roots, elephant
grass. Light arrives as shafts filtered through canopy, dappling everything.
Humid drizzle, mist between the trunks, water dripping from leaves. Mud, rotting
sandbags, a downed helicopter reclaimed by growth. Saturated green must not
become a flat green wash — it needs value range and warm/cool separation.

### `refinery` — Zubair Refinery
A petrochemical plant at dusk. Distillation columns, pipe racks, catwalks,
storage tanks, and **flare stacks throwing real moving firelight** across
everything. Steam venting, sodium floods, hazard striping, warning placards in
an invented script. The dominant idea is *complex industrial silhouette against
a dusk sky*, lit by orange fire from above and cold floods from below.

### `ruins` — Bayon Ruins
An overgrown stone temple complex at dawn in ground mist. Carved faces, collapsed
galleries, roots prising apart masonry, moss and lichen, standing water in
courtyards. **Soft low-angle light through mist** with long god rays between
towers. The quietest level in the roster — its power is atmosphere and scale,
not intensity. Stone needs real weathering: water staining, biological growth,
chipped edges, differential erosion.

---

## Instant-fail list (applies to every level)

- Any surface that is flat, untextured, or single-colour
- A frame with no readable subject, or an unlit ground plane
- Reusing another level's palette or lighting recipe
- Props that float, intersect wrongly, or scatter uniformly at random
- Perfectly clean, straight, or uniform anything
- Geometry with no silhouette detail — boxes standing in for objects
- A level that photographs well in one pose and is empty everywhere else
