# ART DIRECTION — "AL-BAKR MARKET DISTRICT"

Every agent builds toward *this one image*. Coherence is what separates a AAA
scene from a pile of individually-nice assets.

---

## The shot we are chasing

> A sun-baked, war-damaged market street in a Mediterranean/Middle-Eastern city.
> Late afternoon. The sun is low and raking down the street, so every surface
> catches a long warm highlight and throws a long soft shadow. The air is thick
> with dust — visible shafts of light cut between buildings, and distant
> geometry fades into a warm haze. Shadows are deep but never black; they are
> filled with cool blue skylight bouncing off the sky and teal-shifted by the
> grade. Everything is worn: plaster spalled off concrete, rust weeping from
> bolts, sand drifted into corners, bullet scars, scorch marks.

This is deliberately chosen: **low sun + volumetric haze + strong grade is the
highest-leverage path to photographic quality in real time.** Atmosphere does
the heavy lifting that raw polygon count cannot.

---

## Lighting recipe (non-negotiable, this is the whole look)

| Element | Value |
|---|---|
| Sun elevation | ~14° above horizon, raking down the street's long axis |
| Sun colour | warm, ~4200K, intensity 4.5–6.0 |
| Sky / ambient | cool blue-cyan hemisphere fill, ~0.35–0.8 |
| Bounce | warm sand-coloured bounce on lower surfaces |
| Fog | exponential height fog, warm dust, dense enough that 60m reads hazy |
| Volumetrics | god rays through gaps between buildings and window openings |
| Shadows | 4-cascade CSM, soft PCF, **never fully black** |
| Exposure | filmic; highlights roll off, they never clip to flat white |

**Grade:** lifted shadows tinted teal-blue, warm midtones, slightly desaturated
overall, gentle S-curve contrast, subtle vignette, very light chromatic
aberration at the frame edge, fine film grain. Think *Modern Warfare* — not
saturated, not neon, not grey-brown mud.

---

## Palette

```
Sunlit plaster    #d9c3a0    Shadowed plaster  #4a5568 (cool)
Concrete          #9a958c    Rust              #8a4a2a
Sand / dust       #c9b08a    Weathered wood    #6b5540
Sun disc/flash    #ffd9a0    Sky zenith        #4a7fb5
Foliage (dry)     #6b7248    Blood             #6e1410
```

Metals are **dark and tinted**, never bright grey. Gun metal ≈ `#2a2c30` with
roughness 0.35 and real edge wear picking up the sky.

---

## The street (level layout — `level.js` owns this, everyone else aligns to it)

- Main street runs along **−Z**, roughly 70m long × 14m wide, gently cambered.
- Buildings 2–4 storeys both sides: plaster over concrete, flat roofs, parapets,
  external stairs, AC units, satellite dishes, hanging cables crossing overhead.
- **Ground floor = market**: shop fronts under corrugated-metal awnings, cloth
  canopies in faded red/ochre/teal stripes, produce crates, oil drums.
- One **side alley** (east, around x≈+11) — narrow, deep shadow, one shaft of
  light, wet patch, dumpster, fire escape.
- One **enterable interior** (west, around x≈−6) — a gutted shop: broken
  counter, debris, dust motes in a window shaft. This is the interior scenario.
- One **accessible rooftop** (west, around −14, +9m) overlooking the street.
- **Set pieces:** a burnt-out sedan on its side mid-street, sandbag emplacement,
  concrete jersey barriers, a collapsed balcony spilling rubble, a shot-out bus
  shelter.
- Player spawns at the south end looking north (−Z) down the street.

Camera poses for the capture scenarios must be published as
`level.cameraPoses = { overview, street, interior, alley, rooftop }`, each
`{position: Vector3, yaw, pitch}` framed as a deliberate composition — leading
lines down the street, a strong foreground element, sun raking across frame.

---

## Weapon

An **M4-style carbine**: 14.5" barrel, free-float M-LOK rail, collapsible stock,
vertical foregrip, red-dot optic, 30-round STANAG mag. Modelled procedurally
from bevelled primitives — but with *silhouette detail*: rail slots, charging
handle, ejection port, mag well flare, trigger guard, sling loops. Finish is
worn matte black with edge wear revealing bare aluminium on the rail edges,
mag lips, and charging handle.

Hands are **gloved** — dark tactical gloves, visible fingers wrapped around
grip and foregrip. No floating gun.

---

## Enemies

Militia: dark utility trousers, olive/tan chest rig over a dark shirt,
mismatched headwear (shemagh, boonie, bare head). Proportions must read
human — 1.8m tall, correct limb ratios, weight on one leg in idle. Procedural
skeletal animation: idle sway, walk, run, aim, hit reaction, ragdoll-ish death.

---

## Instant-fail list

Anything on this list gets the build rejected by the critics:

- Flat single-colour surfaces, or obvious texture tiling
- Pure-black shadows, or blown-white highlights
- A grey-box level with no clutter, wear, or set dressing
- A weapon that reads as stacked cubes
- Enemies as capsules, or stiff T-posed mannequins
- Muzzle flash as a white sphere
- Perfectly clean, perfectly straight, perfectly uniform anything
- No haze, no depth cueing, flat dead lighting
- Neon/oversaturated colour, or uniform grey-brown mud
