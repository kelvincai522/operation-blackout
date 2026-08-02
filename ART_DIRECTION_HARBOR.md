# ART DIRECTION — LEVEL 2: "COLD HARBOR"

The second level. Deliberately the **opposite** of Al-Bakr Market in every
axis, because a second level that looks like a re-dress of the first is not a
second level.

| | Market (level 1) | **Cold Harbor (level 2)** |
|---|---|---|
| Time | Golden hour | **Night, 02:00** |
| Weather | Hot, dry, dusty | **Heavy rain, storm** |
| Key light | Low raking sun | **Sodium/mercury practicals + lightning** |
| Palette | Warm ochre, teal shadows | **Cyan-green, sodium orange, near-black** |
| Surfaces | Dusty, matte, chalky | **Wet, glossy, reflective** |
| Space | Horizontal street canyon | **Vertical container stacks + open quay** |
| Scale | Human, cluttered | **Industrial, vast, sparse** |

---

## The shot we are chasing

> A container terminal at two in the morning, in driving rain. Sodium lamps on
> tall masts throw hard orange cones through the downpour — you can see the rain
> falling *through* the light. Everything is soaked: the concrete apron is a
> black mirror holding stretched reflections of every lamp, and the puddles
> ripple as drops hit them. Stacked shipping containers form dark canyons in
> faded red, blue and green, their corrugated flanks streaked with rust weeping
> from every weld. A gantry crane looms overhead, its legs disappearing into
> low cloud. Beyond the quay edge, black water and the hull of a moored
> freighter. Every few seconds, lightning flashes the entire scene cold blue-white
> for a fraction of a second, freezing the rain mid-air and throwing hard
> shadows in a completely different direction from the lamps — then it is dark
> again and your eye has to re-adapt.

**Wet is the whole look.** Level 1 sold atmosphere with dust; this one sells it
with water. Reflection, specular and contrast do the work that haze did before.

---

## Lighting recipe (non-negotiable)

| Element | Value |
|---|---|
| Ambient sky | Very low, cold. Overcast storm cloud, no stars, no moon disc |
| Practicals | Sodium mast lamps ~2000K deep orange; mercury/LED floods ~5600K cold |
| Practical falloff | Hard. Pools of light with genuine darkness between them |
| Lightning | 3–8s interval, 60–180ms, cold ~7000K, from a varying direction, casts real shadows |
| Fog | Dense low fog + rain scatter. Lamp cones must be visible volumetrically |
| Contrast | HIGH. Deep near-blacks are correct here — but never crushed to zero |
| Exposure | Low key. Mean luminance ~0.10–0.18. Highlights on wet metal may clip briefly |

The **light cone through rain** is the single most important effect in this
level. A mast lamp with no visible volumetric cone in a downpour is a fail.

## Palette

```
Sodium lamp        #ff9a3c    Mercury flood      #cfe6ff
Wet concrete       #16191c    Dry concrete       #4a4f55
Container red      #7a2f28    Container blue     #1f4a6b
Container green    #2c5040    Container rust     #8a4a2a
Sea (night)        #080d12    Lightning          #dceaff
Steam / rain haze  #39434d
```

Metals are **dark and specular**, not bright. Wet asphalt should read almost
black in albedo and get nearly all its visible value from reflections.

---

## Layout (`level_harbor.js` owns this; everyone aligns to it)

A working container terminal, roughly 90 m × 70 m, laid out for combat:

- **The apron** — open wet concrete, painted lane markings (worn), drainage
  channels, standing puddles. The main open sightline. Runs along −Z.
- **Container canyons** — 40ft containers stacked 2–4 high in rows, forming
  a grid of corridors with dead-ends, gaps and climbable stacks. This is the
  main combat space: tight, vertical, with flanking routes.
- **The gantry crane** — a full ship-to-shore crane straddling the quay, legs
  ~24 m apart, boom extending over the water. Climbable stairs to a walkway
  giving an elevated firing position over the containers.
- **The warehouse** — one enterable structure: roller doors (one open, one
  buckled), an interior with racking, forklift, pooled water under a hole in
  the roof with rain coming through and a shaft of light. Interior scenario.
- **The quay edge** — bollards, mooring ropes under tension, fenders, a
  chain rail, and the black water beyond. The moored freighter hull rises as
  a wall on the far side; deck lights and a foghorn.
- **Supporting** — a portacabin office with lit windows, a reefer stack with
  humming refrigeration units and condensation, a fuel bowser, stacked pallets
  under tarpaulins, chain-link perimeter fence with barbed top, a toppled
  container spilling cargo.

Player spawns at the landward south end looking north up the apron.

### Required camera poses

`level.cameraPoses` must publish these, framed like a cinematographer would —
strong foreground, leading line, lamp cones in shot:

`quay`, `containers`, `warehouse`, `crane`, `gangway`, `overview`

---

## Weather contract

`GAME.Weather` (`src/fx/weather.js`) owns rain and storm, and publishes state
that other systems read. Everyone else consumes; nobody else writes.

```js
weather.wetness        // 0..1 global surface wetness
weather.rainIntensity  // 0..1
weather.windDir        // THREE.Vector2, normalised
weather.windSpeed      // m/s
weather.flash          // 0..1 lightning intensity THIS frame (0 most frames)
weather.flashDir       // THREE.Vector3 direction the flash came from
weather.fogDensity     // current fog density
weather.setPreset(name)  // 'storm' | 'drizzle' | 'clear'
```

Required from weather.js:
- **Rain**: instanced/point streaks, camera-relative volume, wind-sheared,
  parallaxed by depth so it does not read as a flat overlay. Must be visible
  against dark AND against lamp cones.
- **Splash**: impact ring particles where rain meets ground and props.
- **Puddle ripples**: animated normal perturbation on wet ground.
- **Lightning**: a real directional light flash, not a screen fade — it must
  cast shadows and be visible on geometry. Follow with rolling thunder audio
  after a plausible delay for the distance.
- **Rain on the lens**: subtle droplet distortion at frame edges, streaking
  with camera motion. Restrained — this is not a car-window effect.
- **Drips**: water running off container edges, ledges and the crane.

---

## Instant-fail list

- Rain as a flat 2D screen overlay
- Lamps with no visible volumetric cone in the downpour
- Wet ground that is not reflective, or reflections that are just a blur
- Lightning as a full-screen white fade with no directional shadow change
- Containers that are flat-coloured boxes with no corrugation, no rust weeping,
  no door hardware, no stencilled markings
- A flat, uniformly-lit scene — this level lives on pools of light and darkness
- Crushed pure-black shadows with no detail whatsoever
- Reusing the market's warm ochre palette
- Puddles that do not ripple in the rain
