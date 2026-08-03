// ============================================================================
// OPERATION BLACKOUT - src/world/level_bunker.js  ->  GAME.LevelBunker
//
// "FACILITY K-17": a buried cold-war command post, sealed, dry, dusty, and in
// an ALARM STATE. There is no sky and no weather. Every photon comes from a
// failing fluorescent, a low-level escape marker, a rotating red beacon, a
// rigged worklight or a live CRT - so the level publishes its whole rig as
// `practicalLights`, its apertures as `lightShafts`, and every fitting twice
// over (housing as merged geometry, lens as an instanced emitter).
//
// THE PLAN, in world coordinates (the facility runs WEST -> EAST along +X,
// +Z is north on the plan):
//
//   x = -55 .. -46   approach tunnel, collapsed at its far end
//   x = -46          THE BLAST DOOR: a 5.0 x 4.3 x 1.35 m steel-clad plug,
//                    slid 2.9 m north into its pocket, rams still under load
//   x = -46 .. -33   blast vestibule, 5.4 m clear, decon stalls, guard cabin
//   x = -33 .. +9    THE SPINE: 3.9 m wide, 2.86 m to the soffit, downstand
//                    beams at 2.6 m centres, three tiers of cable tray, two
//                    more blast doors, beacons, long dark stretches
//   x = -30 .. -13.6, z = 4.6 .. 17.4    THE CONTROL ROOM, raised access
//                    floor at 0.30, dead CRT consoles, a backlit status wall
//   x = -12.5 .. -3.5, z = -8.6 .. -1.95 plant room: switchgear, transformers
//   x = +9 .. +37, |z| < 13.2            THE REACTOR GALLERY, 11 m clear
//        well x 14.4..33.6, |z| < 9.6 open to the flooded lower level at -4.60
//        the vessel stands on the centre line at (24, 0): concrete bioshield
//        to y 1.10, steel vessel to 6.50, head dome to 8.00, drive stalks to
//        9.30, an operating platform ringing it at deck level, a gantry ring
//        at 5.70 and a crane girder at 9.70
//   lower level: standing water at -4.02, i.e. 58 cm, all round the vessel
//
// ============================================================================
// WHY THIS FILE LOOKS THE WAY IT DOES
// ============================================================================
// * MERGED BUCKETS. Everything static is authored into per-material buckets and
//   merged ONCE with GAME.Geo.mergeAll, so the whole facility is ~18 draw calls.
//   The emissive fittings are a single InstancedMesh with per-instance colour,
//   because a tube at the end of its life has to fail on its OWN schedule -
//   one shared emissive material flickers forty fittings in unison, which reads
//   as a screen effect rather than as a dying facility.
//
// * THE ALARM IS REAL, NOT A GRADE. Eight beacons carry a rotating additive
//   wedge (level-owned mesh, spun in update()) and the two that matter to a
//   framing also carry a level-owned SpotLight whose target is spun with them.
//   A red bar that crosses the reactor's flank and the corridor walls is the
//   single thing that separates this level from every other interior in the
//   roster, and a static red pool cannot buy it.
//
// * IT IS DRY. The metro is flooded and green; this is dusty and grey/red, and
//   that separation is enforced in the wear pass rather than hoped for. Global
//   wetness is 0.22 - a damp basement, not a flood - and the vertex wear mask's
//   B channel (which BRIGHTENS toward a pale substrate) is driven by an
//   up-facing DUST term instead of by polish. The only wet surfaces in the
//   level are below y = -3.6, where the lower level is genuinely under water.
//
// * THE FLOOD IS A WET FLOOR, NOT A WATER BODY. Same finding the metro paid
//   for: materials.water() is an absorbing body with a Fresnel that hands
//   everything to a specular there is nothing down here to reflect, and it
//   photographs as a hole. 58 cm of standing water over concrete IS a wet
//   floor, so it is authored as one through the vertex wear contract.
//
// ============================================================================
// THE PLACEMENT CONTRACT  -  `level.anchors`
// ============================================================================
// props_bunker.js and anyone else placing against this facility reads ANCHORS,
// never camera poses. A pose is a composition and moves whenever the
// composition improves; an anchor is the facility's own survey, derived from
// the same constants the geometry is. Available immediately after
// `new LevelBunker(ctx)` - you do not have to wait for build().
//
//   anchors.vestibule   { x0,x1,hz, y, ceil, centre, doorCentre, cabin, decon }
//   anchors.blastDoor   { centre, plane, w,h,thick, openZ, pocket, railZ[] }
//   anchors.spine       { x0,x1, hz, y, ceil, centre, groundY(x,z),
//                         doorsX[], beamPitch, trayY[], junctions[] }
//   anchors.control     { x0,x1,z0,z1, floorY, ceil, centre, statusWall,
//                         consoles[], voidPanels[], doorway }
//   anchors.plant       { x0,x1,z0,z1, y, ceil, centre, cabinets[] }
//   anchors.hall        { x0,x1,hz, deckY, ceil, portal, westDeck, eastDeck,
//                         northDeck, southDeck, wellX0,wellX1,wellZ0,wellZ1 }
//   anchors.reactor     { centre, bioR, vesselR, bioTop, vesselTop, domeTop,
//                         platR0, platR1, bridges[], gantryY, gantryR0/R1,
//                         craneY, craneX }
//   anchors.lower       { floorY, waterY, centre, ring[], stair, sump }
//   anchors.lamps       [ { name, kind, pos:Vector3, aim:Vector3, cone } ]
//   anchors.beacons     [ { pos:Vector3, axis, radius } ]
//   anchors.spawn       { centre, yaw }
//
// Also published, all consumed generically by lighting.js:
//   level.practicalLights  the rig, MOST-IMPORTANT-FIRST (the module caps a
//                          declarative level at 24 and truncates the TAIL, so
//                          the ordering is load bearing).
//   level.lightShafts      four real fixtures: the high bay over the vessel,
//                          the vestibule flood on the blast door, the control
//                          room troffer, the pit worklight.
//   level.litWindows       additive glow cards on every fitting, so a lamp has
//                          a visible source even edge-on.
//   level.waterPlane       { y, x0, x1, z0, z1 } for anyone placing impacts.
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  var M = GAME.Math;
  var Geo = GAME.Geo;

  // ------------------------------------------------------------------ layout --
  // Blast vestibule and the approach beyond the door.
  var VEST_X0 = -46.0, VEST_X1 = -33.0;
  var VEST_HZ = 6.60;
  var VEST_CEIL = 5.40;
  var APPR_X0 = -55.0;                    // collapsed approach tunnel
  var APPR_HZ = 2.90;
  var APPR_CEIL = 4.60;

  // The blast door itself.
  var DOOR_X = -45.40;                    // the plug's centre plane
  var DOOR_W = 5.00, DOOR_H = 4.30, DOOR_T = 1.35;
  var DOOR_OPEN = 2.92;                   // how far it has slid north (+z)

  // The spine corridor.
  var SPN_X0 = -33.0, SPN_X1 = 9.0;
  var SPN_HZ = 1.95;
  var SPN_CEIL = 2.86;
  var BEAM_PITCH = 2.60;                  // downstand beam / pilaster rhythm
  var SPN_DOORS = [-32.60, -3.20];        // blast door frames along the spine
  var HALL_DOOR_X = 8.40;                 // the portal into the reactor gallery

  // Control room, north off the spine through a short link.
  var CTL_X0 = -30.0, CTL_X1 = -13.6;
  var CTL_Z0 = 4.60, CTL_Z1 = 17.40;
  var CTL_CEIL = 3.70;
  var CTL_FLOOR = 0.30;                   // raised access floor
  var LINK_X0 = -22.60, LINK_X1 = -19.00;

  // Plant room, south off the spine.
  var PLT_X0 = -12.50, PLT_X1 = -3.50;
  var PLT_Z0 = -8.60, PLT_Z1 = -1.95;
  var PLT_CEIL = 3.20;

  // The reactor gallery.
  var RG_X0 = 9.0, RG_X1 = 37.0;
  var RG_HZ = 13.20;
  var RG_CEIL = 11.00;
  var DECK_Y = 0.0;
  var WELL_X0 = 14.40, WELL_X1 = 33.60;
  var WELL_Z0 = -9.60, WELL_Z1 = 9.60;
  var PIT_Y = -4.60;
  var WATER_Y = -4.02;                    // 58 cm of standing water

  // The reactor.
  var REAC_CX = 24.0, REAC_CZ = 0.0;
  var BIO_R = 5.50, BIO_TOP = 1.10;       // concrete bioshield drum
  var VES_R = 3.95, VES_TOP = 6.50;       // steel vessel
  var DOME_TOP = 8.00;
  var STALK_TOP = 9.30;
  var PLAT_R0 = 5.65, PLAT_R1 = 7.60;     // operating platform annulus, y = 0
  var GANT_Y = 5.70, GANT_R0 = 6.20, GANT_R1 = 8.40;
  var CRANE_Y = 9.70, CRANE_X = 27.40;

  // The pit stair, hung on the west face of the well.
  var STAIR_X0 = 14.40, STAIR_X1 = 15.70;
  var STAIR_Z0 = -9.00, STAIR_Z1 = -3.00;

  // The two bridges onto the operating platform. The WEST one is 5.2 m wide -
  // a 3.2 m grating walkway and a 2.0 m pipe rack beside it - because it is the
  // leading line of the level's signature framing and a 3 m catwalk does not
  // carry a frame. The NORTH one is an ordinary 3.6 m access bridge.
  var BRIDGE_HW_W = 2.60, BRIDGE_HW_N = 1.80;

  var UP = new THREE.Vector3(0, 1, 0);

  // ---------------------------------------------------------------- surfaces --
  // `uv` is world-metres -> uv for the post-merge Geo.worldUV pass. `wear: true`
  // asks materials.js for the VERTEX WEAR shader (white = pristine, R grime,
  // G wetness, B edge/dust); everything else takes wearMode 'multiply', where
  // the colour attribute is a plain albedo multiplier. `base` is a name
  // materials.js certainly HAS - every request goes through lib.has() first, so
  // a name this library has never heard of can never silently resolve to a
  // plausible piece of concrete.
  var SURF = {
    // The main deck. Power-floated concrete, painted once in 1974, worn back to
    // the aggregate down the middle of every route. Largest surface in four of
    // six framings, so its wear mask sets those frames' exposure on its own.
    deck_conc:   { uv: 0.40, cast: false, recv: true,  wear: true,
                   base: 'concrete', col: 0x8c8880, rough: 0.86 },
    // Board-marked in-situ concrete: walls, soffits, the bioshield.
    wall_conc:   { uv: 0.44, cast: true,  recv: true,  wear: true,
                   base: 'concrete_wall', col: 0x928d85 },
    // Precast slab soffits and the heavy structure. Kept separate from the
    // walls so the ceiling can carry its own soot/drip channel without dragging
    // the walls' splash-line with it.
    ceil_conc:   { uv: 0.38, cast: true,  recv: true,  wear: true,
                   base: 'concrete', col: 0x8a857c },
    // THE DADO. Red oxide primer to 1.15 m through the whole facility - this is
    // half the level's palette and the reason a grey corridor is not monochrome.
    // Deliberately NOT a tint on wall_conc: a wear mask and an albedo
    // multiplier cannot share one colour attribute.
    dado_paint:  { uv: 0.72, cast: true,  recv: true,  wear: false,
                   base: 'lime_wash', col: 0x8a4034, rough: 0.72, metal: 0.0 },
    // Painted plant: cabinet cases, door leaves, duct, machine casings. The
    // library's painted_metal is an ENAMEL - its own metalness channel keeps the
    // dielectric film dielectric and only the chips conductive - which is what
    // makes it safe on a level whose environment probe is nearly black.
    // THE ENAMEL. Three bases were tried and the reasons are worth keeping.
    // `paint_blue` is metal 0.55, and on a sealed level with a near-zero
    // environment probe that deletes half the diffuse and gives it nothing back
    // - every console, cabinet and door leaf rendered as a black silhouette.
    // `lime_wash` is metal 0 but TRIPLANAR at 0.49 tiles/m, i.e. a 2 m plaster
    // blotch on a 1.5 m console. `plastic` is metal 0 and uv-mapped, but
    // gun_polymer's sheet is a close-range weapon texture and at any density
    // that hid the blotching it printed as a visible repeating damask.
    // structural_steel is what a console case actually is: metal 0.06, so it
    // cannot go black; STOCHASTICALLY tiled, so it cannot repeat; and its
    // colour is made here rather than taken from the library.
    hull_paint:  { uv: 1.85, cast: true,  recv: true,  wear: false,
                   base: 'structural_steel', col: 0x7f8c8a, rough: 0.55, metal: 0.06 },
    // Structural steel. metal 0.06 in the library, so gantries and handrails
    // never go black under a dead probe - they are the level's silhouette.
    steel:       { uv: 0.36, cast: true,  recv: true,  wear: false,
                   base: 'structural_steel', col: 0x6a6e72, rough: 0.62, metal: 0.10 },
    // Corroded pipework, brackets, conduit, the rails the door runs on.
    rust_metal:  { uv: 0.92, cast: true,  recv: true,  wear: false,
                   base: 'rusted_metal', col: 0x76483a, rough: 0.76, metal: 0.55 },
    // Open grating: decks, the operating platform, stair treads. side 2 and
    // alpha tested in the library, so you see the flooded pit through the deck
    // from above and the deck's underside from below.
    grate:       { uv: 0.62, cast: false, recv: true,  wear: true,
                   base: 'steel_grate', col: 0x55585a, rough: 0.68, metal: 0.30 },
    // Chequer plate: landings, stair stringers, the bridge decks.
    plate_steel: { uv: 0.62, cast: true,  recv: true,  wear: false,
                   base: 'deck_plate', col: 0x60594f, rough: 0.60, metal: 0.22 },
    // Bakelite console fascias, switch panels, lamp diffusers.
    panel_bake:  { uv: 1.10, cast: true,  recv: true,  wear: false,
                   base: 'plastic', col: 0x6b6558, rough: 0.52, metal: 0.0 },
    glass_dirty: { uv: 1.50, cast: false, recv: false, wear: false,
                   base: 'glass', col: 0x6d767c, rough: 0.26, metal: 0.0 },
    cable_rub:   { uv: 1.50, cast: true,  recv: true,  wear: false,
                   base: 'rubber', col: 0x2a2c2e, rough: 0.90, metal: 0.0 },
    // Floor markings: hazard bands, route lines, bay numbers.
    paint_line:  { uv: 0.66, cast: false, recv: true,  wear: true,
                   base: 'painted_line', col: 0xc9b96a, rough: 0.78 },
    // Spalled concrete, fallen ceiling, the collapse in the approach tunnel.
    rubble:      { uv: 0.55, cast: true,  recv: true,  wear: true,
                   base: 'rubble', col: 0x847f75 },
    // THE FLOOD. See the header - a wet floor, not a water body.
    flood:       { uv: 0.30, cast: false, recv: true,  wear: true,
                   base: 'wet_concrete', col: 0x2f3336, rough: 0.12 },
    // This file's own alpha-tested signage / staining / stencil atlas.
    decal:       { uv: 1.0, cast: false, recv: true,  wear: false,
                   own: true, keepUV: true },
    // Additive smears on the standing water under every red strip.
    glint:       { uv: 1.0, cast: false, recv: false, wear: false,
                   own: true, keepUV: true }
  };

  // If materials.js is missing entirely the facility must still read as grey
  // concrete and red paint rather than as magenta error boxes.
  var FALLBACK = {
    deck_conc:   [0x6f6b64, 0.88, 0.0],
    wall_conc:   [0x77726a, 0.90, 0.0],
    ceil_conc:   [0x6d685f, 0.92, 0.0],
    dado_paint:  [0x7c3a2f, 0.72, 0.0],
    hull_paint:  [0x78858a, 0.54, 0.0],
    steel:       [0x5d6167, 0.62, 0.10],
    rust_metal:  [0x67402f, 0.80, 0.50],
    grate:       [0x4a4d50, 0.70, 0.28],
    plate_steel: [0x565046, 0.62, 0.20],
    panel_bake:  [0x5d5849, 0.54, 0.0],
    glass_dirty: [0x4f5a60, 0.22, 0.0],
    cable_rub:   [0x232527, 0.92, 0.0],
    paint_line:  [0xb6a75e, 0.80, 0.0],
    rubble:      [0x6f6a61, 0.96, 0.0],
    flood:       [0x11181b, 0.11, 0.0],
    decal:       [0xffffff, 0.82, 0.0],
    glint:       [0xffffff, 1.00, 0.0]
  };

  // ----------------------------------------------------------- small helpers --
  var _e1 = new THREE.Euler();

  function makeM(x, y, z, rx, ry, rz) {
    var m = new THREE.Matrix4();
    if (rx || ry || rz) {
      _e1.set(rx || 0, ry || 0, rz || 0, 'YXZ');
      m.makeRotationFromEuler(_e1);
    }
    m.elements[12] = x || 0; m.elements[13] = y || 0; m.elements[14] = z || 0;
    return m;
  }

  function vertCount(g) {
    return g.index ? g.index.count : g.attributes.position.count;
  }

  // Slightly bevelled boxes, cached by dimension. A perfectly sharp 90 degree
  // edge never catches a highlight, and in a facility lit entirely by small
  // fittings the edge highlight is most of what describes a shape at all.
  var _boxCache = new Map();
  function box(w, h, d, bevel) {
    w = Math.max(w, 0.004); h = Math.max(h, 0.004); d = Math.max(d, 0.004);
    if (bevel === undefined) bevel = Math.min(0.012, Math.min(w, h, d) * 0.26);
    var k = w.toFixed(3) + ',' + h.toFixed(3) + ',' + d.toFixed(3) + ',' + bevel.toFixed(3);
    var g = _boxCache.get(k);
    if (!g) {
      var src = Geo.bevelBox(w, h, d, bevel);
      g = src.toNonIndexed(); src.dispose();
      _boxCache.set(k, g);
    }
    return g;
  }

  var _cylCache = new Map();
  function cyl(rTop, rBot, len, seg) {
    seg = seg || 10;
    var k = rTop.toFixed(4) + ',' + rBot.toFixed(4) + ',' + len.toFixed(3) + ',' + seg;
    var g = _cylCache.get(k);
    if (!g) {
      var src = new THREE.CylinderGeometry(rTop, rBot, len, seg, 1, false);
      g = src.toNonIndexed(); src.dispose();
      _cylCache.set(k, g);
    }
    return g;
  }

  // A flat quad in the XY plane facing +Z. Decal cards, glint cards, beams.
  var _quadCache = new Map();
  function quad(w, h, u0, v0, u1, v1) {
    var k = w.toFixed(3) + ',' + h.toFixed(3) + ',' + u0 + ',' + v0 + ',' + u1 + ',' + v1;
    var g = _quadCache.get(k);
    if (g) return g;
    var hw = w * 0.5, hh = h * 0.5;
    var pos = new Float32Array([
      -hw, -hh, 0, hw, -hh, 0, hw, hh, 0,
      -hw, -hh, 0, hw, hh, 0, -hw, hh, 0
    ]);
    var nor = new Float32Array(18);
    for (var i = 0; i < 6; i++) nor[i * 3 + 2] = 1;
    var uv = new Float32Array([u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1]);
    g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    _quadCache.set(k, g);
    return g;
  }

  // Keep a tint bright (it multiplies albedo) but shift its hue.
  function tint(hex, strength) {
    var c = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
    var mx = Math.max(c.r, Math.max(c.g, c.b)) || 1;
    c.multiplyScalar(1 / mx);
    var s = strength === undefined ? 1 : strength;
    c.r = 1 + (c.r - 1) * s; c.g = 1 + (c.g - 1) * s; c.b = 1 + (c.b - 1) * s;
    return c;
  }

  // ---------------------------------------------------------------------------
  // SURFACES OF REVOLUTION.  The bioshield drum, the vessel, its head dome, the
  // steam generators and every pipe elbow in the reactor gallery are one 2D
  // profile in (radius, y) spun about a vertical axis.
  //
  // Normals are ANALYTIC, from the profile's own tangent, not averaged off
  // triangles: a 48-segment vessel lit by two high bays shows a facet band under
  // every raking source otherwise, because the eye reads the second derivative
  // of the shading. WINDING is (A, D, C) + (A, C, B) with A=(t0,p0) B=(t0,p1)
  // C=(t1,p1) D=(t1,p0), which puts the normal OUTWARD; `flip` reverses it for
  // anything seen from inside.
  // ---------------------------------------------------------------------------
  function revolveY(prof, cx, cz, segs, a0, a1, flip) {
    var np = prof.length;
    if (np < 2 || segs < 2) return null;
    a0 = a0 || 0; a1 = (a1 === undefined) ? Math.PI * 2 : a1;
    // per-profile-point normals in (r, y) from central differences
    var pn = [], j, i;
    for (j = 0; j < np; j++) {
      var a = prof[Math.max(0, j - 1)], b = prof[Math.min(np - 1, j + 1)];
      var dr = b[0] - a[0], dy = b[1] - a[1];
      var l = Math.sqrt(dr * dr + dy * dy) || 1;
      pn.push([dy / l, -dr / l]);            // (nr, ny)
    }
    var pos = [], nor = [];
    var sgn = flip ? -1 : 1;
    for (i = 0; i < segs; i++) {
      var t0 = a0 + (a1 - a0) * (i / segs);
      var t1 = a0 + (a1 - a0) * ((i + 1) / segs);
      var c0 = Math.cos(t0), s0 = Math.sin(t0);
      var c1 = Math.cos(t1), s1 = Math.sin(t1);
      for (j = 0; j < np - 1; j++) {
        var p0 = prof[j], p1 = prof[j + 1];
        var n0 = pn[j], n1 = pn[j + 1];
        var Ax = cx + p0[0] * c0, Az = cz + p0[0] * s0, Ay = p0[1];
        var Bx = cx + p1[0] * c0, Bz = cz + p1[0] * s0, By = p1[1];
        var Cx = cx + p1[0] * c1, Cz = cz + p1[0] * s1, Cy = p1[1];
        var Dx = cx + p0[0] * c1, Dz = cz + p0[0] * s1, Dy = p0[1];
        var An = [n0[0] * c0 * sgn, n0[1] * sgn, n0[0] * s0 * sgn];
        var Bn = [n1[0] * c0 * sgn, n1[1] * sgn, n1[0] * s0 * sgn];
        var Cn = [n1[0] * c1 * sgn, n1[1] * sgn, n1[0] * s1 * sgn];
        var Dn = [n0[0] * c1 * sgn, n0[1] * sgn, n0[0] * s1 * sgn];
        if (flip) {
          pos.push(Ax, Ay, Az, Cx, Cy, Cz, Dx, Dy, Dz);
          nor.push(An[0], An[1], An[2], Cn[0], Cn[1], Cn[2], Dn[0], Dn[1], Dn[2]);
          pos.push(Ax, Ay, Az, Bx, By, Bz, Cx, Cy, Cz);
          nor.push(An[0], An[1], An[2], Bn[0], Bn[1], Bn[2], Cn[0], Cn[1], Cn[2]);
        } else {
          pos.push(Ax, Ay, Az, Dx, Dy, Dz, Cx, Cy, Cz);
          nor.push(An[0], An[1], An[2], Dn[0], Dn[1], Dn[2], Cn[0], Cn[1], Cn[2]);
          pos.push(Ax, Ay, Az, Cx, Cy, Cz, Bx, By, Bz);
          nor.push(An[0], An[1], An[2], Cn[0], Cn[1], Cn[2], Bn[0], Bn[1], Bn[2]);
        }
      }
    }
    if (!pos.length) return null;
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    return g;
  }

  // An UP-FACING annulus - the operating platform, the gantry ring, every
  // grating deck that goes round the reactor. `fn(x,z)` may return -999 to drop
  // a cell, which is how the platform gets its stair void without any CSG.
  function annulus(cx, cz, r0, r1, y, segs, rings, fn) {
    rings = rings || 2;
    var pos = [], nor = [], i, j;
    for (i = 0; i < segs; i++) {
      var t0 = (i / segs) * Math.PI * 2, t1 = ((i + 1) / segs) * Math.PI * 2;
      var c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
      for (j = 0; j < rings; j++) {
        var ra = r0 + (r1 - r0) * (j / rings);
        var rb = r0 + (r1 - r0) * ((j + 1) / rings);
        var Ax = cx + ra * c0, Az = cz + ra * s0;
        var Bx = cx + rb * c0, Bz = cz + rb * s0;
        var Cx = cx + rb * c1, Cz = cz + rb * s1;
        var Dx = cx + ra * c1, Dz = cz + ra * s1;
        var ya = y, yb = y, yc = y, yd = y;
        if (fn) {
          ya = fn(Ax, Az); yb = fn(Bx, Bz); yc = fn(Cx, Cz); yd = fn(Dx, Dz);
          if (ya < -900 || yb < -900 || yc < -900 || yd < -900) continue;
        }
        pos.push(Ax, ya, Az, Cx, yc, Cz, Bx, yb, Bz);
        nor.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
        pos.push(Ax, ya, Az, Dx, yd, Dz, Cx, yc, Cz);
        nor.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
      }
    }
    if (!pos.length) return null;
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    return g;
  }

  // An up-facing grid surface following `fn(x,z)`. Every horizontal slab in the
  // facility, because a settled floor with real relief is what gives the dust
  // and damp pass somewhere to sit - a flat plane has no low spots and a stain
  // painted on one is a decal, not a floor.
  function deck(x0, x1, z0, z1, step, fn) {
    var nx = Math.max(1, Math.round((x1 - x0) / step));
    var nz = Math.max(1, Math.round((z1 - z0) / step));
    var dx = (x1 - x0) / nx, dz = (z1 - z0) / nz;
    var pos = [], nor = [], i, j;
    var ys = [];
    for (i = 0; i <= nx; i++) {
      ys.push([]);
      for (j = 0; j <= nz; j++) ys[i].push(fn(x0 + i * dx, z0 + j * dz));
    }
    function samp(i2, j2, fb) {
      var v = ys[M.clamp(i2, 0, nx)][M.clamp(j2, 0, nz)];
      return v < -900 ? fb : v;
    }
    function nAt(i2, j2) {
      var c0 = ys[i2][j2];
      if (c0 < -900) return [0, 1, 0];
      var a = samp(i2 - 1, j2, c0), b = samp(i2 + 1, j2, c0);
      var c = samp(i2, j2 - 1, c0), d = samp(i2, j2 + 1, c0);
      var gx = (b - a) / (2 * dx), gz = (d - c) / (2 * dz);
      var l = Math.sqrt(gx * gx + 1 + gz * gz) || 1;
      return [-gx / l, 1 / l, -gz / l];
    }
    for (i = 0; i < nx; i++) {
      for (j = 0; j < nz; j++) {
        var xa = x0 + i * dx, xb = xa + dx;
        var za = z0 + j * dz, zb = za + dz;
        var y00 = ys[i][j], y01 = ys[i][j + 1], y11 = ys[i + 1][j + 1], y10 = ys[i + 1][j];
        if (y00 < -900 || y01 < -900 || y11 < -900 || y10 < -900) continue;
        var n00 = nAt(i, j), n01 = nAt(i, j + 1), n11 = nAt(i + 1, j + 1), n10 = nAt(i + 1, j);
        pos.push(xa, y00, za, xa, y01, zb, xb, y11, zb);
        nor.push(n00[0], n00[1], n00[2], n01[0], n01[1], n01[2], n11[0], n11[1], n11[2]);
        pos.push(xa, y00, za, xb, y11, zb, xb, y10, za);
        nor.push(n00[0], n00[1], n00[2], n11[0], n11[1], n11[2], n10[0], n10[1], n10[2]);
      }
    }
    if (!pos.length) return null;
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    return g;
  }

  // ---------------------------------------------------------------------------
  // THE GROUND, analytically. One function per region, so sampleGround, the
  // navgrid, the wear paint and every prop placed against an anchor cannot
  // disagree about where the floor is.
  // ---------------------------------------------------------------------------
  var SLAB_PITCH = 2.44;                  // the bay size the slab was poured in
  function slabJoint(x, z) {
    var a = ((x + 1.22) % SLAB_PITCH + SLAB_PITCH) % SLAB_PITCH - SLAB_PITCH * 0.5;
    var b = ((z + 0.61) % SLAB_PITCH + SLAB_PITCH) % SLAB_PITCH - SLAB_PITCH * 0.5;
    var d = 0;
    a = Math.abs(a); b = Math.abs(b);
    if (a < 0.026) d = (1 - a / 0.026) * 0.013;
    if (b < 0.026) d = Math.max(d, (1 - b / 0.026) * 0.013);
    return d;
  }

  // How far a deck point sits below its own surroundings. Damp collects here,
  // never against an absolute plane - an absolute plane and a settling slab get
  // out of step and then the whole floor measures as flooded.
  function deckDip(x, z, N) {
    var d = (N.fbm2(x * 0.068 + 11.3, z * 0.068 - 4.1, 3) * 0.5 + 0.5);
    return M.smoothstep(0.46, 0.96, d) * 0.046 + slabJoint(x, z);
  }

  function deckY(x, z, N) {
    return DECK_Y - (N.fbm2(x * 0.026 - 3.4, z * 0.026 + 7.1, 3) * 0.5 + 0.5) * 0.042
      - deckDip(x, z, N);
  }

  // The lower level. A fall toward the sump in the south-west corner of the
  // ring, which is where the water is deepest and where the pumps are.
  function pitY(x, z, N) {
    var y = PIT_Y - 0.02 - (N.fbm2(x * 0.055 + 2.2, z * 0.055 - 1.6, 2) * 0.5 + 0.5) * 0.055;
    var sx = (x - 16.6) / 3.4, sz = (z + 7.6) / 3.0;
    y -= Math.exp(-(sx * sx + sz * sz)) * 0.22;
    return y;
  }

  // The raised access floor in the control room is FLAT - it is 600 mm panels on
  // pedestals, not a poured slab - so it gets panel joints and nothing else.
  // That contrast is half of what makes the control room read as a different
  // kind of space from the corridor outside it.
  function ctlY(x, z) {
    var a = ((x + 0.30) % 0.60 + 0.60) % 0.60 - 0.30;
    var b = ((z + 0.30) % 0.60 + 0.60) % 0.60 - 0.30;
    var d = 0;
    a = Math.abs(a); b = Math.abs(b);
    if (a < 0.016) d = (1 - a / 0.016) * 0.009;
    if (b < 0.016) d = Math.max(d, (1 - b / 0.016) * 0.009);
    return CTL_FLOOR - d;
  }

  // The pit stair, hung on the west face of the well: a straight flight running
  // south, 6.0 m of going for 4.6 m of rise.
  function stairY(z) {
    var t = M.saturate((STAIR_Z1 - z) / (STAIR_Z1 - STAIR_Z0));
    return DECK_Y + (PIT_Y - DECK_Y) * t;
  }

  function inRect(x, z, x0, x1, z0, z1) {
    return x >= x0 && x <= x1 && z >= z0 && z <= z1;
  }
  function inWell(x, z) {
    return inRect(x, z, WELL_X0, WELL_X1, WELL_Z0, WELL_Z1);
  }
  function reacDist(x, z) {
    var dx = x - REAC_CX, dz = z - REAC_CZ;
    return Math.sqrt(dx * dx + dz * dz);
  }
  // The two bridges from the ring deck onto the operating platform.
  function onBridge(x, z) {
    if (z >= REAC_CZ - BRIDGE_HW_W && z <= REAC_CZ + BRIDGE_HW_W &&
        x >= WELL_X0 - 0.3 && x <= REAC_CX - PLAT_R1 + 0.4) return true;
    if (Math.abs(x - REAC_CX) <= BRIDGE_HW_N && z >= WELL_Z0 - 0.3 &&
        z <= REAC_CZ - PLAT_R1 + 0.4) return true;
    return false;
  }

  // ================================================================ Builder ==
  // A transform stack plus per-material geometry buckets. Deliberately the same
  // shape as the market's, the harbour's and the metro's builders: this file
  // follows those files' patterns rather than inventing new ones.
  function Builder() {
    this.buckets = Object.create(null);
    this._stack = [new THREE.Matrix4()];
    this.tint = null;
    this.paint = 'metal';
    this.dark = 0;
    this.count = 0;
  }
  Builder.prototype.top = function () { return this._stack[this._stack.length - 1]; };
  Builder.prototype.push = function (m) {
    this._stack.push(new THREE.Matrix4().multiplyMatrices(this.top(), m));
    return this;
  };
  Builder.prototype.pushXYZ = function (x, y, z, rx, ry, rz) {
    return this.push(makeM(x, y, z, rx, ry, rz));
  };
  Builder.prototype.pop = function () { this._stack.pop(); return this; };
  Builder.prototype.add = function (key, geo, local) {
    if (!geo) return null;
    var b = this.buckets[key] || (this.buckets[key] = []);
    var wm = new THREE.Matrix4();
    if (local) wm.multiplyMatrices(this.top(), local); else wm.copy(this.top());
    var e = { geometry: geo, matrix: wm, tint: this.tint, paint: this.paint, dark: this.dark };
    b.push(e); this.count++;
    return e;
  };
  Builder.prototype.box = function (key, w, h, d, x, y, z, bevel) {
    return this.add(key, box(w, h, d, bevel), makeM(x, y, z));
  };
  Builder.prototype.boxR = function (key, w, h, d, x, y, z, rx, ry, rz, bevel) {
    return this.add(key, box(w, h, d, bevel), makeM(x, y, z, rx, ry, rz));
  };
  Builder.prototype.cyl = function (key, r0, r1, len, x, y, z, rx, ry, rz, seg) {
    return this.add(key, cyl(r0, r1, len, seg), makeM(x, y, z, rx, ry, rz));
  };
  // A member between two arbitrary world points - every brace, rail, pipe run
  // and cable drop in the facility.
  Builder.prototype.strut = function (key, ax, ay, az, bx, by, bz, w, d) {
    var dx = bx - ax, dy = by - ay, dz = bz - az;
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-4) return null;
    var yaw = Math.atan2(dx, dz);
    var pitch = Math.acos(M.clamp(dy / len, -1, 1));
    var m = new THREE.Matrix4();
    _e1.set(pitch, yaw, 0, 'YXZ');
    m.makeRotationFromEuler(_e1);
    m.elements[12] = (ax + bx) * 0.5;
    m.elements[13] = (ay + by) * 0.5;
    m.elements[14] = (az + bz) * 0.5;
    return this.add(key, box(w, len, d || w), m);
  };
  // A round member between two points - pipework, conduit, handrail.
  Builder.prototype.pipe = function (key, ax, ay, az, bx, by, bz, r, seg) {
    var dx = bx - ax, dy = by - ay, dz = bz - az;
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-4) return null;
    var yaw = Math.atan2(dx, dz);
    var pitch = Math.acos(M.clamp(dy / len, -1, 1));
    var m = new THREE.Matrix4();
    _e1.set(pitch, yaw, 0, 'YXZ');
    m.makeRotationFromEuler(_e1);
    m.elements[12] = (ax + bx) * 0.5;
    m.elements[13] = (ay + by) * 0.5;
    m.elements[14] = (az + bz) * 0.5;
    return this.add(key, cyl(r, r, len, seg || 8), m);
  };
  Builder.prototype.worldPoint = function (x, y, z, out) {
    return (out || new THREE.Vector3()).set(x, y, z).applyMatrix4(this.top());
  };

  // ---------------------------------------------------------------------------
  // THE SIGNAGE / GRIME ATLAS
  //
  // Stencilled facility markings in an INVENTED SCRIPT, plus the staining that
  // matters more than the lettering. The glyphs are STENCIL forms - constructed
  // from strokes with bridge gaps cut through them - for two reasons: it is what
  // a military facility really uses, and a headless capture machine cannot be
  // relied on to have any particular face in whatever the CSS stack lands on. A
  // sign that renders as tofu boxes on one machine and as text on another is not
  // a sign, it is a lottery.
  //
  // Everything else on this sheet is wear: efflorescence, peeling primer, rust
  // weeps, soot, dust scuffs, a hand-painted crew tag. A concrete wall with no
  // staining on it is the flat-untextured-surface failure wearing a texture, and
  // the atlas is how this level buys per-place variation a tiling material
  // physically cannot.
  // ---------------------------------------------------------------------------
  var ATLAS_PX = 1024, ATLAS_N = 4, ATLAS_CELL = 256;
  var CELL = {
    NAME: 0,       // the facility plate  K-17
    HAZARD: 1,     // yellow/black chevron band
    RAD: 2,        // radiation trefoil placard
    DOOR: 3,       // door / compartment plate
    STAIN: 4,      // water staining + efflorescence
    PEEL: 5,       // peeling primer, spalled render
    WEEP: 6,       // rust weep from a fixing
    SOOT: 7,       // scorch / soot smear
    STENCIL: 8,    // stencilled legend
    ARROW: 9,      // escape-route chevrons
    SCHEM: 10,     // mimic diagram
    GRID: 11,      // plotting-board grid
    DUST: 12,      // dust + scuff patch
    NUM: 13,       // large stencilled numerals
    CRT: 14,       // a CRT raster face
    TAG: 15        // hand-painted crew marking
  };

  function atlasRect(cell) {
    var cx = cell % ATLAS_N, cy = (cell / ATLAS_N) | 0;
    return [cx * ATLAS_CELL, cy * ATLAS_CELL];
  }
  function atlasUV(cell) {
    var cx = cell % ATLAS_N, cy = (cell / ATLAS_N) | 0;
    var s = 1 / ATLAS_N;
    return [cx * s, 1 - (cy + 1) * s, (cx + 1) * s, 1 - cy * s];
  }

  // One constructed STENCIL letterform: heavy slab strokes on a common baseline,
  // with the bridges a real stencil needs so a closed counter cannot fall out.
  function glyph(g, x, y, w, h, id) {
    var l = x, r = x + w, t = y, b = y + h;
    var mx = x + w * 0.5, my = y + h * 0.50;
    var br = h * 0.13;                    // the stencil bridge gap
    g.beginPath();
    switch (((id % 12) + 12) % 12) {
      case 0:  // closed box with a bridged waist
        g.moveTo(l, t); g.lineTo(r, t); g.moveTo(r, t + br); g.lineTo(r, b);
        g.moveTo(r - br, b); g.lineTo(l, b); g.moveTo(l, b - br); g.lineTo(l, t + br);
        break;
      case 1:  // vertical + two arms
        g.moveTo(l, t); g.lineTo(l, b);
        g.moveTo(l + br, t); g.lineTo(r, t);
        g.moveTo(l + br, my); g.lineTo(r - w * 0.2, my);
        break;
      case 2:  // A-form with a bridged crossbar
        g.moveTo(l, b); g.lineTo(mx, t); g.lineTo(r, b);
        g.moveTo(l + w * 0.18, my); g.lineTo(mx - br * 0.5, my);
        g.moveTo(mx + br * 0.5, my); g.lineTo(r - w * 0.18, my);
        break;
      case 3:  // T
        g.moveTo(l, t); g.lineTo(r, t); g.moveTo(mx, t + br); g.lineTo(mx, b);
        break;
      case 4:  // Z
        g.moveTo(l, t); g.lineTo(r, t); g.lineTo(l, b); g.lineTo(r, b);
        break;
      case 5:  // U
        g.moveTo(l, t); g.lineTo(l, b - w * 0.2); g.lineTo(l + w * 0.24, b);
        g.lineTo(r - w * 0.24, b); g.lineTo(r, b - w * 0.2); g.lineTo(r, t);
        break;
      case 6:  // E
        g.moveTo(r, t); g.lineTo(l, t); g.lineTo(l, b); g.lineTo(r, b);
        g.moveTo(l + br, my); g.lineTo(r - w * 0.18, my);
        break;
      case 7:  // N
        g.moveTo(l, b); g.lineTo(l, t); g.lineTo(r, b); g.lineTo(r, t);
        break;
      case 8:  // Y-form
        g.moveTo(l, t); g.lineTo(mx, my); g.lineTo(r, t);
        g.moveTo(mx, my + br * 0.4); g.lineTo(mx, b);
        break;
      case 9:  // bridged D
        g.moveTo(l, t); g.lineTo(r - w * 0.22, t); g.lineTo(r, t + h * 0.22);
        g.moveTo(r, t + h * 0.22 + br); g.lineTo(r, b - h * 0.22);
        g.lineTo(r - w * 0.22, b); g.lineTo(l, b); g.moveTo(l, b - br); g.lineTo(l, t + br);
        break;
      case 10: // K
        g.moveTo(l, t); g.lineTo(l, b);
        g.moveTo(l + br, my); g.lineTo(r, t);
        g.moveTo(l + br, my); g.lineTo(r, b);
        break;
      default: // H
        g.moveTo(l, t); g.lineTo(l, b); g.moveTo(r, t); g.lineTo(r, b);
        g.moveTo(l + br, my); g.lineTo(r - br, my);
        break;
    }
    g.stroke();
  }

  function word(g, cx, cy, h, n, rng, weight) {
    var w = h * 0.60, gap = h * 0.30;
    var total = n * w + (n - 1) * gap;
    var x = cx - total * 0.5;
    g.lineWidth = Math.max(2, h * (weight || 0.20));
    g.lineCap = 'butt'; g.lineJoin = 'miter';
    for (var i = 0; i < n; i++) {
      glyph(g, x, cy - h * 0.5, w, h, rng.int(0, 11));
      x += w + gap;
    }
    return total;
  }

  // Speckle a cell with erosion so nothing on the sheet is factory fresh.
  function erode(g, ox, oy, rng, amount, sz) {
    var n = Math.round(ATLAS_CELL * amount);
    g.save();
    g.globalCompositeOperation = 'destination-out';
    for (var i = 0; i < n; i++) {
      var x = ox + rng.range(0, ATLAS_CELL), y = oy + rng.range(0, ATLAS_CELL);
      var r = rng.range(1.0, sz || 6.0);
      g.globalAlpha = rng.range(0.25, 1.0);
      g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
    }
    g.restore();
  }

  // A soft vertical run - the shape water, rust and soot all actually make.
  function run(g, x, y0, y1, w, rng, col, alpha) {
    var steps = 26;
    g.save();
    for (var i = 0; i < steps; i++) {
      var t = i / (steps - 1);
      var yy = y0 + (y1 - y0) * t;
      var ww = w * (0.35 + 0.65 * Math.sin(Math.PI * Math.pow(t, 0.6)));
      g.globalAlpha = alpha * (1 - t * 0.72) * rng.range(0.6, 1.0);
      g.fillStyle = col;
      g.beginPath();
      g.ellipse(x + rng.range(-w * 0.2, w * 0.2), yy, ww,
        Math.abs(y1 - y0) / steps * 1.6, 0, 0, 6.2832);
      g.fill();
    }
    g.restore();
  }

  function buildAtlas(rng) {
    var cv, g;
    try {
      cv = document.createElement('canvas');
      cv.width = ATLAS_PX; cv.height = ATLAS_PX;
      g = cv.getContext('2d');
    } catch (e) { return null; }
    if (!g) return null;
    g.clearRect(0, 0, ATLAS_PX, ATLAS_PX);
    var R, ox, oy, i, k;

    // ---- NAME : the facility plate ----------------------------------------
    R = atlasRect(CELL.NAME); ox = R[0]; oy = R[1];
    g.save();
    g.fillStyle = 'rgba(196,198,190,0.94)';
    g.fillRect(ox + 12, oy + 74, ATLAS_CELL - 24, 112);
    g.strokeStyle = 'rgba(52,54,52,0.9)'; g.lineWidth = 5;
    g.strokeRect(ox + 12, oy + 74, ATLAS_CELL - 24, 112);
    g.strokeStyle = 'rgba(38,40,40,0.95)';
    word(g, ox + ATLAS_CELL * 0.5, oy + 112, 34, 5, rng, 0.21);
    g.font = 'bold 48px monospace'; g.textAlign = 'center';
    g.fillStyle = 'rgba(38,40,40,0.95)';
    g.fillText('K-17', ox + ATLAS_CELL * 0.5, oy + 176);
    g.restore();
    erode(g, ox, oy, rng, 0.26, 5);

    // ---- HAZARD : chevron band --------------------------------------------
    R = atlasRect(CELL.HAZARD); ox = R[0]; oy = R[1];
    g.save();
    g.beginPath(); g.rect(ox, oy + 78, ATLAS_CELL, 100); g.clip();
    g.fillStyle = 'rgba(198,166,44,0.95)';
    g.fillRect(ox, oy + 78, ATLAS_CELL, 100);
    g.fillStyle = 'rgba(26,26,26,0.94)';
    for (i = -3; i < 10; i++) {
      var bx = ox + i * 44;
      g.beginPath();
      g.moveTo(bx, oy + 78); g.lineTo(bx + 22, oy + 78);
      g.lineTo(bx + 122, oy + 178); g.lineTo(bx + 100, oy + 178);
      g.closePath(); g.fill();
    }
    g.restore();
    erode(g, ox, oy, rng, 0.42, 7);

    // ---- RAD : trefoil placard --------------------------------------------
    R = atlasRect(CELL.RAD); ox = R[0]; oy = R[1];
    g.save();
    g.translate(ox + ATLAS_CELL * 0.5, oy + ATLAS_CELL * 0.5);
    g.fillStyle = 'rgba(198,170,48,0.95)';
    g.beginPath(); g.moveTo(0, -104); g.lineTo(104, 76); g.lineTo(-104, 76);
    g.closePath(); g.fill();
    g.strokeStyle = 'rgba(28,28,28,0.95)'; g.lineWidth = 9; g.stroke();
    g.fillStyle = 'rgba(26,26,26,0.95)';
    g.translate(0, 18);
    for (i = 0; i < 3; i++) {
      g.beginPath();
      g.arc(0, 0, 62, i * 2.0944 - 0.52, i * 2.0944 + 0.52);
      g.arc(0, 0, 22, i * 2.0944 + 0.52, i * 2.0944 - 0.52, true);
      g.closePath(); g.fill();
    }
    g.beginPath(); g.arc(0, 0, 14, 0, 6.2832); g.fill();
    g.restore();
    erode(g, ox, oy, rng, 0.22, 5);

    // ---- DOOR : compartment plate -----------------------------------------
    R = atlasRect(CELL.DOOR); ox = R[0]; oy = R[1];
    g.save();
    g.fillStyle = 'rgba(72,86,80,0.92)';
    g.fillRect(ox + 26, oy + 92, ATLAS_CELL - 52, 76);
    g.strokeStyle = 'rgba(186,190,182,0.92)'; g.lineWidth = 4;
    g.strokeRect(ox + 26, oy + 92, ATLAS_CELL - 52, 76);
    word(g, ox + ATLAS_CELL * 0.5, oy + 130, 26, 4, rng, 0.22);
    g.restore();
    erode(g, ox, oy, rng, 0.30, 5);

    // ---- STAIN : efflorescence + water staining ---------------------------
    R = atlasRect(CELL.STAIN); ox = R[0]; oy = R[1];
    for (i = 0; i < 7; i++) {
      run(g, ox + rng.range(24, ATLAS_CELL - 24), oy + rng.range(0, 40),
        oy + rng.range(150, ATLAS_CELL), rng.range(9, 26), rng,
        'rgba(206,208,196,0.9)', 0.30);
    }
    for (i = 0; i < 5; i++) {
      run(g, ox + rng.range(20, ATLAS_CELL - 20), oy + rng.range(0, 60),
        oy + rng.range(120, ATLAS_CELL), rng.range(14, 34), rng,
        'rgba(70,68,62,0.9)', 0.22);
    }

    // ---- PEEL : peeling primer --------------------------------------------
    R = atlasRect(CELL.PEEL); ox = R[0]; oy = R[1];
    g.save();
    for (i = 0; i < 26; i++) {
      var px = ox + rng.range(10, ATLAS_CELL - 10), py = oy + rng.range(10, ATLAS_CELL - 10);
      var pr = rng.range(9, 40);
      g.globalAlpha = rng.range(0.30, 0.80);
      g.fillStyle = rng.bool(0.55) ? 'rgba(126,120,110,0.9)' : 'rgba(150,74,58,0.9)';
      g.beginPath();
      for (k = 0; k <= 9; k++) {
        var a = k / 9 * 6.2832;
        var rr = pr * (0.62 + 0.5 * rng.next());
        var xx = px + Math.cos(a) * rr, yy = py + Math.sin(a) * rr * 0.8;
        if (k === 0) g.moveTo(xx, yy); else g.lineTo(xx, yy);
      }
      g.closePath(); g.fill();
    }
    g.restore();

    // ---- WEEP : rust weep --------------------------------------------------
    R = atlasRect(CELL.WEEP); ox = R[0]; oy = R[1];
    g.save();
    g.fillStyle = 'rgba(128,66,36,0.85)';
    g.beginPath(); g.arc(ox + 128, oy + 44, 20, 0, 6.2832); g.fill();
    g.restore();
    for (i = 0; i < 4; i++) {
      run(g, ox + 108 + i * 14, oy + 46, oy + rng.range(160, 250), rng.range(6, 15),
        rng, 'rgba(134,68,34,0.9)', 0.46);
    }

    // ---- SOOT --------------------------------------------------------------
    R = atlasRect(CELL.SOOT); ox = R[0]; oy = R[1];
    g.save();
    for (i = 0; i < 40; i++) {
      g.globalAlpha = rng.range(0.04, 0.18);
      g.fillStyle = 'rgba(18,16,15,1)';
      g.beginPath();
      g.ellipse(ox + rng.gaussian(128, 46), oy + rng.gaussian(150, 60),
        rng.range(16, 62), rng.range(20, 70), rng.range(0, 3.14), 0, 6.2832);
      g.fill();
    }
    g.restore();

    // ---- STENCIL : legend --------------------------------------------------
    R = atlasRect(CELL.STENCIL); ox = R[0]; oy = R[1];
    g.save();
    g.strokeStyle = 'rgba(212,214,204,0.90)';
    word(g, ox + ATLAS_CELL * 0.5, oy + 96, 30, 6, rng, 0.20);
    word(g, ox + ATLAS_CELL * 0.5, oy + 160, 24, 4, rng, 0.20);
    g.restore();
    erode(g, ox, oy, rng, 0.40, 6);

    // ---- ARROW : escape chevrons -------------------------------------------
    R = atlasRect(CELL.ARROW); ox = R[0]; oy = R[1];
    g.save();
    g.fillStyle = 'rgba(196,206,192,0.92)';
    for (i = 0; i < 3; i++) {
      var ax = ox + 40 + i * 66;
      g.beginPath();
      g.moveTo(ax, oy + 92); g.lineTo(ax + 44, oy + 128); g.lineTo(ax, oy + 164);
      g.lineTo(ax + 16, oy + 128); g.closePath(); g.fill();
    }
    g.restore();
    erode(g, ox, oy, rng, 0.30, 5);

    // ---- SCHEM : mimic diagram --------------------------------------------
    R = atlasRect(CELL.SCHEM); ox = R[0]; oy = R[1];
    g.save();
    g.fillStyle = 'rgba(24,30,30,0.86)';
    g.fillRect(ox + 8, oy + 8, ATLAS_CELL - 16, ATLAS_CELL - 16);
    g.strokeStyle = 'rgba(150,178,164,0.85)'; g.lineWidth = 3;
    for (i = 0; i < 8; i++) {
      var sy = oy + 34 + i * 26;
      g.beginPath(); g.moveTo(ox + 22, sy); g.lineTo(ox + rng.range(90, 234), sy); g.stroke();
    }
    for (i = 0; i < 5; i++) {
      var sx2 = ox + 44 + i * 42;
      g.beginPath(); g.moveTo(sx2, oy + 30); g.lineTo(sx2, oy + rng.range(90, 228)); g.stroke();
    }
    g.fillStyle = 'rgba(198,120,54,0.9)';
    for (i = 0; i < 9; i++) {
      g.beginPath();
      g.arc(ox + rng.range(30, 226), oy + rng.range(30, 226), rng.range(4, 9), 0, 6.2832);
      g.fill();
    }
    g.restore();

    // ---- GRID : plotting board --------------------------------------------
    R = atlasRect(CELL.GRID); ox = R[0]; oy = R[1];
    g.save();
    g.fillStyle = 'rgba(30,34,32,0.88)';
    g.fillRect(ox + 6, oy + 6, ATLAS_CELL - 12, ATLAS_CELL - 12);
    g.strokeStyle = 'rgba(126,146,136,0.55)'; g.lineWidth = 1.6;
    for (i = 1; i < 14; i++) {
      g.beginPath(); g.moveTo(ox + 6 + i * 17.4, oy + 6); g.lineTo(ox + 6 + i * 17.4, oy + 250); g.stroke();
      g.beginPath(); g.moveTo(ox + 6, oy + 6 + i * 17.4); g.lineTo(ox + 250, oy + 6 + i * 17.4); g.stroke();
    }
    // a coastline scrawl, so it reads as a map and not as graph paper
    g.strokeStyle = 'rgba(180,196,180,0.75)'; g.lineWidth = 3.2;
    g.beginPath();
    var gx = ox + 22, gy = oy + 60;
    g.moveTo(gx, gy);
    for (i = 0; i < 16; i++) {
      gx += rng.range(6, 18); gy += rng.gaussian(0, 13);
      g.lineTo(gx, M.clamp(gy, oy + 20, oy + 236));
    }
    g.stroke();
    g.restore();

    // ---- DUST : scuff patch ------------------------------------------------
    R = atlasRect(CELL.DUST); ox = R[0]; oy = R[1];
    g.save();
    for (i = 0; i < 34; i++) {
      g.globalAlpha = rng.range(0.03, 0.13);
      g.fillStyle = 'rgba(186,180,166,1)';
      g.beginPath();
      g.ellipse(ox + rng.gaussian(128, 54), oy + rng.gaussian(128, 54),
        rng.range(22, 80), rng.range(10, 34), rng.range(0, 3.14), 0, 6.2832);
      g.fill();
    }
    g.restore();

    // ---- NUM : bay numerals ------------------------------------------------
    R = atlasRect(CELL.NUM); ox = R[0]; oy = R[1];
    g.save();
    g.font = 'bold 150px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = 'rgba(200,202,192,0.9)';
    g.fillText(String(rng.int(1, 9)) + String(rng.int(0, 9)), ox + 128, oy + 132);
    g.restore();
    erode(g, ox, oy, rng, 0.36, 6);

    // ---- CRT : raster face -------------------------------------------------
    R = atlasRect(CELL.CRT); ox = R[0]; oy = R[1];
    g.save();
    g.fillStyle = 'rgba(10,14,12,0.94)';
    g.fillRect(ox + 4, oy + 4, ATLAS_CELL - 8, ATLAS_CELL - 8);
    g.fillStyle = 'rgba(255,168,60,0.30)';
    for (i = 0; i < 62; i++) g.fillRect(ox + 8, oy + 10 + i * 4, ATLAS_CELL - 16, 2);
    g.strokeStyle = 'rgba(255,182,84,0.95)'; g.lineWidth = 3;
    g.beginPath();
    for (i = 0; i <= 40; i++) {
      var tx = ox + 14 + i * 5.7;
      var ty = oy + 168 + Math.sin(i * 0.6) * 26 * Math.exp(-i * 0.04) + rng.range(-3, 3);
      if (i === 0) g.moveTo(tx, ty); else g.lineTo(tx, ty);
    }
    g.stroke();
    g.strokeStyle = 'rgba(255,176,72,0.85)';
    word(g, ox + 128, oy + 54, 22, 5, rng, 0.20);
    word(g, ox + 128, oy + 96, 18, 6, rng, 0.20);
    g.restore();

    // ---- TAG : hand-painted crew marking -----------------------------------
    R = atlasRect(CELL.TAG); ox = R[0]; oy = R[1];
    g.save();
    g.strokeStyle = 'rgba(190,72,54,0.85)';
    g.lineWidth = 9; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath();
    var tgx = ox + 34, tgy = oy + 150;
    g.moveTo(tgx, tgy);
    for (i = 0; i < 11; i++) {
      tgx += rng.range(10, 24); tgy += rng.gaussian(0, 26);
      g.lineTo(tgx, M.clamp(tgy, oy + 60, oy + 216));
    }
    g.stroke();
    g.restore();
    erode(g, ox, oy, rng, 0.30, 8);

    var tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  }

  // Place one atlas card. `axis` is the outward normal axis, `s` its sign.
  function card(B, cell, x, y, z, w, h, axis, s, tintC, roll) {
    var uv = atlasUV(cell);
    var g = quad(w, h, uv[0], uv[1], uv[2], uv[3]);
    var rx = 0, ry = 0;
    if (axis === 'x') ry = s > 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
    else if (axis === 'y') { rx = s > 0 ? -Math.PI * 0.5 : Math.PI * 0.5; }
    else ry = s > 0 ? 0 : Math.PI;
    var old = B.tint;
    if (tintC) B.tint = tintC;
    B.add('decal', g, makeM(x, y, z, rx, ry, roll || 0));
    B.tint = old;
  }

  // ---------------------------------------------------------------------------
  // Two generated textures with no source file: the specular smear laid on the
  // standing water under every emergency strip, and the beacon's sweep wedge.
  // ---------------------------------------------------------------------------
  var _glintTex = null;
  function glintTexture() {
    if (_glintTex) return _glintTex;
    var W = 256, H = 64, cv, g;
    try {
      cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      g = cv.getContext('2d');
    } catch (e) { return null; }
    if (!g) return null;
    var img = g.createImageData(W, H), d = img.data;
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var u = x / (W - 1), v = y / (H - 1);
        var a = M.smoothstep(0.0, 0.18, u) * (1 - M.smoothstep(0.82, 1.0, u));
        var c = Math.abs(v - 0.5) * 2;
        var across = Math.exp(-c * c * 8.0) * 0.70 + Math.exp(-c * c * 1.7) * 0.30;
        var br = 0.58 + 0.42 * Math.sin(u * 37.0) * Math.sin(u * 11.3 + 0.7);
        var i = (y * W + x) * 4;
        d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
        d[i + 3] = Math.round(M.saturate(a * across * br) * 255);
      }
    }
    g.putImageData(img, 0, 0);
    var tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    _glintTex = tex;
    return tex;
  }

  // The sweep wedge: bright and narrow at the lens, wide and dying at the tip.
  var _beamTex = null;
  function beamTexture() {
    if (_beamTex) return _beamTex;
    var W = 128, H = 64, cv, g;
    try {
      cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      g = cv.getContext('2d');
    } catch (e) { return null; }
    if (!g) return null;
    var img = g.createImageData(W, H), d = img.data;
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var u = x / (W - 1), v = y / (H - 1);
        var along = 1 - M.smoothstep(0.0, 1.0, Math.pow(u, 0.72));
        along *= M.smoothstep(0.0, 0.26, u);
        var c = Math.abs(v - 0.5) * 2;
        var across = Math.exp(-c * c * 5.5) * 0.66 + Math.exp(-c * c * 1.2) * 0.34;
        var i = (y * W + x) * 4;
        d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
        d[i + 3] = Math.round(M.saturate(along * across) * 255);
      }
    }
    g.putImageData(img, 0, 0);
    var tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    _beamTex = tex;
    return tex;
  }

  // A glint card lying flat on the water. `ax` picks its long axis.
  function glint(B, x, z, len, wide, col, y, ax) {
    var g = quad(len, wide, 0, 0, 1, 1);
    var old = B.tint;
    B.tint = col;
    B.add('glint', g, makeM(x, y, z, -Math.PI * 0.5, ax === 'z' ? Math.PI * 0.5 : 0, 0));
    B.tint = old;
  }

  // ===========================================================================
  // WALLS WITH OPENINGS
  //
  // Every wall in the facility is this, and it emits its own colliders as
  // BANDS rather than as one slab. That is not tidiness: lighting.js rasterises
  // level.colliders into the occupancy grid that both its sky-visibility bake
  // and its shaft solver read, so a solid box across a doorway reports the
  // doorway as filled - the light that should spill through it is deleted, and
  // the failure is completely silent.
  //
  // `axis` 'x' puts the wall plane at x = at, running along z from a0 to a1.
  // `axis` 'z' puts it at z = at, running along x.
  // ===========================================================================
  function slotWall(B, L, key, axis, at, thick, a0, a1, y0, y1, holes, mat, noCol) {
    holes = (holes || []).slice().sort(function (p, q) { return p.c - q.c; });
    var i;
    function slab(b0, b1, c0, c1) {
      if (b1 - b0 < 0.02 || c1 - c0 < 0.02) return;
      var mid = (b0 + b1) * 0.5, ymid = (c0 + c1) * 0.5;
      if (axis === 'x') {
        B.box(key, thick, c1 - c0, b1 - b0, at, ymid, mid);
        if (!noCol) L.addCollider(at, ymid, mid, thick * 0.5, (c1 - c0) * 0.5, (b1 - b0) * 0.5, mat);
      } else {
        B.box(key, b1 - b0, c1 - c0, thick, mid, ymid, at);
        if (!noCol) L.addCollider(mid, ymid, at, (b1 - b0) * 0.5, (c1 - c0) * 0.5, thick * 0.5, mat);
      }
    }
    var cur = a0;
    for (i = 0; i < holes.length; i++) {
      var h = holes[i];
      var ha = h.c - h.hw, hb = h.c + h.hw;
      if (ha > cur) slab(cur, ha, y0, y1);
      var hy0 = h.y0 === undefined ? y0 : h.y0;
      var hy1 = h.y1 === undefined ? y1 : h.y1;
      if (hy0 > y0 + 0.02) slab(Math.max(ha, cur), hb, y0, hy0);
      if (y1 > hy1 + 0.02) slab(Math.max(ha, cur), hb, hy1, y1);
      cur = Math.max(cur, hb);
    }
    if (a1 > cur) slab(cur, a1, y0, y1);
  }

  // A ceiling / floor slab plus its collider. Ceilings must exist as colliders
  // or the sky-visibility bake reports the facility as open to the sky and every
  // interior gets an unoccluded ambient it has no business having.
  function slab(B, L, key, x0, x1, z0, z1, y, thick, mat, isFloor) {
    B.box(key, x1 - x0, thick, z1 - z0, (x0 + x1) * 0.5, y + thick * 0.5, (z0 + z1) * 0.5);
    L.addCollider((x0 + x1) * 0.5, y + thick * 0.5, (z0 + z1) * 0.5,
      (x1 - x0) * 0.5, thick * 0.5, (z1 - z0) * 0.5, mat || 'concrete', !!isFloor);
  }

  // ---------------------------------------------------------------------------
  // CABLE TRAY. Three tiers of it run the whole spine and every service route in
  // the facility, and they are the strongest converging line the corridor has
  // after the downstand beams. A tray is a real channel - base, two rails, rungs
  // at 0.30 - with bundles laid in it and droppers every few metres, because a
  // solid box painted grey at ceiling height reads as a duct and nothing else.
  // ---------------------------------------------------------------------------
  function cableTray(B, x0, x1, y, z, w, rng, dropSide) {
    var len = x1 - x0;
    if (len < 0.3) return;
    B.paint = 'metal';
    B.box('rust_metal', len, 0.020, w, (x0 + x1) * 0.5, y, z);
    B.box('rust_metal', len, 0.075, 0.020, (x0 + x1) * 0.5, y + 0.038, z - w * 0.5 + 0.01);
    B.box('rust_metal', len, 0.075, 0.020, (x0 + x1) * 0.5, y + 0.038, z + w * 0.5 - 0.01);
    var n = Math.floor(len / 0.30);
    for (var i = 0; i <= n; i++) {
      B.box('rust_metal', 0.028, 0.014, w - 0.02, x0 + i * 0.30, y + 0.008, z);
    }
    // brackets back to the wall
    var nb = Math.floor(len / 2.0);
    for (i = 0; i <= nb; i++) {
      var bx = x0 + i * 2.0;
      B.box('rust_metal', 0.05, 0.06, w + 0.12, bx, y - 0.04, z + (dropSide || 0) * 0.05);
    }
    // the bundles themselves
    B.paint = 'cable';
    var nc = 4;
    for (i = 0; i < nc; i++) {
      var cz = z - w * 0.5 + 0.06 + i * ((w - 0.12) / Math.max(1, nc - 1));
      var r = rng.range(0.026, 0.048);
      B.pipe('cable_rub', x0, y + r + 0.02, cz, x1, y + r + 0.02, cz, r, 6);
    }
    B.paint = 'metal';
  }

  // A cable drop: a bundle leaving a tray, sagging, and disappearing into a
  // gland box. The one thing in a corridor of straight lines that is not one.
  function cableDrop(B, x, y0, z, y1, rng, sag) {
    B.paint = 'cable';
    var prev = null;
    for (var k = 0; k <= 6; k++) {
      var t = k / 6;
      var cx = x + Math.sin(t * 2.2) * (sag || 0.18);
      var cy = y0 + (y1 - y0) * t;
      var cz = z + Math.sin(t * 3.1 + 1.0) * (sag || 0.18) * 0.6;
      if (prev) B.pipe('cable_rub', prev[0], prev[1], prev[2], cx, cy, cz, 0.036, 6);
      prev = [cx, cy, cz];
    }
    B.paint = 'metal';
  }

  // A handrail run: top rail, knee rail, kicking plate, stanchions. Published as
  // a helper because it appears on every gantry, bridge and stair in the level
  // and it is what gives an open edge a readable silhouette against a dark hall.
  function railRun(B, ax, ay, az, bx, by, bz, h, kick) {
    var dx = bx - ax, dy = by - ay, dz = bz - az;
    var len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.2) return;
    h = h || 1.05;
    B.paint = 'metal';
    B.pipe('steel', ax, ay + h, az, bx, by + h, bz, 0.024, 6);
    B.pipe('steel', ax, ay + h * 0.55, az, bx, by + h * 0.55, bz, 0.019, 6);
    var n = Math.max(1, Math.round(len / 1.5));
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      var px = ax + dx * t, py = ay + dy * t, pz = az + dz * t;
      B.box('steel', 0.045, h, 0.045, px, py + h * 0.5, pz);
    }
    if (kick !== false) {
      var ux = -dz / len, uz = dx / len;
      B.paint = 'plate';
      B.strut('plate_steel', ax + ux * 0.0, ay + 0.055, az + uz * 0.0,
        bx + ux * 0.0, by + 0.055, bz + uz * 0.0, 0.020, 0.11);
      B.paint = 'metal';
    }
  }

  // ===========================================================================
  // THE BLAST VESTIBULE and the approach tunnel beyond the door.
  //
  // The great door is the level's landmark: a 5.0 x 4.3 x 1.35 m steel-clad
  // concrete plug on floor rails, slid 2.92 m north into its pocket and stopped
  // there - the rams are still extended and the gap is what the light comes
  // through. Everything about the framing depends on the plug being SOLID and
  // PROUD, so it is built as a real box with a chevron-painted face, a stepped
  // sealing rebate, six lifting eyes and a rack of dogs down its leading edge.
  // ===========================================================================
  function buildVestibule(L, B, rng, N) {
    var i, k;
    var f = function (x, z) { return deckY(x, z, N); };

    // ---- floor -------------------------------------------------------------
    B.paint = 'floor';
    B.add('deck_conc', deck(VEST_X0 - 0.6, VEST_X1, -VEST_HZ, VEST_HZ, 0.60, f));
    B.paint = 'metal';
    L.addCollider((VEST_X0 + VEST_X1) * 0.5, -0.26, 0,
      (VEST_X1 - VEST_X0) * 0.5 + 0.3, 0.26, VEST_HZ, 'concrete', true);

    // ---- shell -------------------------------------------------------------
    B.paint = 'wall';
    // north and south walls
    slotWall(B, L, 'wall_conc', 'z', VEST_HZ + 0.35, 0.70, VEST_X0 - 0.6, VEST_X1,
      -0.4, VEST_CEIL + 0.7, [], 'concrete');
    slotWall(B, L, 'wall_conc', 'z', -VEST_HZ - 0.35, 0.70, VEST_X0 - 0.6, VEST_X1,
      -0.4, VEST_CEIL + 0.7, [], 'concrete');
    // east wall: the opening into the spine
    slotWall(B, L, 'wall_conc', 'x', VEST_X1 + 0.45, 0.90, -VEST_HZ - 0.7, VEST_HZ + 0.7,
      -0.4, VEST_CEIL + 0.7,
      [{ c: 0, hw: SPN_HZ, y0: -0.4, y1: SPN_CEIL }], 'concrete');
    // west wall: the blast door aperture, in 2.4 m of concrete
    slotWall(B, L, 'wall_conc', 'x', VEST_X0 - 1.20, 2.40, -VEST_HZ - 0.7, VEST_HZ + 0.7,
      -0.4, VEST_CEIL + 0.7,
      [{ c: 0, hw: DOOR_W * 0.5, y0: -0.4, y1: DOOR_H }], 'concrete');
    B.paint = 'ceil';
    slab(B, L, 'ceil_conc', VEST_X0 - 0.6, VEST_X1 + 0.9, -VEST_HZ - 0.7, VEST_HZ + 0.7,
      VEST_CEIL, 0.75, 'concrete');
    B.paint = 'metal';

    // ---- the approach tunnel, collapsed at its far end ---------------------
    B.paint = 'floor';
    B.add('deck_conc', deck(APPR_X0, VEST_X0 - 1.0, -APPR_HZ, APPR_HZ, 0.7, f));
    B.paint = 'wall';
    slotWall(B, L, 'wall_conc', 'z', APPR_HZ + 0.4, 0.80, APPR_X0 - 0.8, VEST_X0 - 1.0,
      -0.4, APPR_CEIL + 0.6, [], 'concrete');
    slotWall(B, L, 'wall_conc', 'z', -APPR_HZ - 0.4, 0.80, APPR_X0 - 0.8, VEST_X0 - 1.0,
      -0.4, APPR_CEIL + 0.6, [], 'concrete');
    slotWall(B, L, 'wall_conc', 'x', APPR_X0 - 0.4, 0.80, -APPR_HZ - 0.8, APPR_HZ + 0.8,
      -0.4, APPR_CEIL + 0.6, [], 'concrete');
    B.paint = 'ceil';
    slab(B, L, 'ceil_conc', APPR_X0 - 0.8, VEST_X0 - 1.0, -APPR_HZ - 0.8, APPR_HZ + 0.8,
      APPR_CEIL, 0.7, 'concrete');
    B.paint = 'metal';
    // the collapse: the tunnel has come in and there is no way out that way
    B.paint = 'rubble';
    for (i = 0; i < 64; i++) {
      var cx = rng.range(APPR_X0 + 0.6, APPR_X0 + 7.0);
      var t = M.saturate((cx - APPR_X0) / 7.0);
      var pile = (1 - t) * APPR_CEIL * 0.92;
      var cz = rng.range(-APPR_HZ + 0.2, APPR_HZ - 0.2);
      var sz = rng.range(0.24, 1.05) * (0.6 + 0.6 * (1 - t));
      B.boxR('rubble', sz * rng.range(0.8, 1.7), sz * rng.range(0.4, 1.0),
        sz * rng.range(0.8, 1.6), cx, deckY(cx, cz, N) + rng.range(0, pile), cz,
        rng.range(-0.7, 0.7), rng.range(0, 3.14), rng.range(-0.7, 0.7));
    }
    B.paint = 'metal';
    for (i = 0; i < 18; i++) {
      var rx = rng.range(APPR_X0 + 0.8, APPR_X0 + 6.4);
      var rz = rng.range(-APPR_HZ + 0.3, APPR_HZ - 0.3);
      var ry0 = deckY(rx, rz, N) + rng.range(0.4, 2.6);
      B.strut('rust_metal', rx, ry0, rz, rx + rng.range(-0.7, 0.7),
        ry0 + rng.range(0.5, 1.8), rz + rng.range(-0.5, 0.5), 0.026, 0.026);
    }
    L.addCollider(APPR_X0 + 3.4, 1.8, 0, 3.4, 2.4, APPR_HZ, 'rubble');

    // ---- THE BLAST DOOR ----------------------------------------------------
    var dz = DOOR_OPEN;                     // the plug's centre, slid north
    B.paint = 'clad';
    B.dark = 0.12;
    // the plug: a stepped plug, so the sealing rebate reads at a glance
    B.box('hull_paint', DOOR_T, DOOR_H, DOOR_W, DOOR_X, DOOR_H * 0.5 - 0.10, dz);
    B.box('hull_paint', DOOR_T - 0.34, DOOR_H - 0.30, DOOR_W + 0.30,
      DOOR_X, DOOR_H * 0.5 - 0.10, dz);
    B.dark = 0;
    B.paint = 'metal';
    // stiffening ribs across the face
    for (i = 0; i < 5; i++) {
      B.box('steel', 0.10, DOOR_H - 0.24, 0.13, DOOR_X + DOOR_T * 0.5 + 0.04,
        DOOR_H * 0.5 - 0.10, dz - DOOR_W * 0.5 + 0.5 + i * ((DOOR_W - 1.0) / 4));
    }
    // the dogs down the leading (south) edge, and their sockets in the jamb
    for (i = 0; i < 6; i++) {
      var dy = 0.32 + i * ((DOOR_H - 0.9) / 5);
      B.cyl('steel', 0.085, 0.085, 0.52, DOOR_X, dy, dz - DOOR_W * 0.5 - 0.12,
        Math.PI * 0.5, 0, 0, 8);
      B.cyl('rust_metal', 0.13, 0.13, 0.22, DOOR_X, dy, -DOOR_W * 0.5 - 0.18,
        Math.PI * 0.5, 0, 0, 8);
    }
    // lifting eyes on the head
    for (i = 0; i < 3; i++) {
      B.box('steel', 0.09, 0.22, 0.22, DOOR_X, DOOR_H - 0.06,
        dz - 1.6 + i * 1.6);
    }
    // hazard chevrons across the plug face and a radiation placard beside it
    card(B, CELL.HAZARD, DOOR_X + DOOR_T * 0.5 + 0.03, 1.05, dz, DOOR_W - 0.4, 1.55,
      'x', 1, tint(0xfff0c0, 0.35));
    card(B, CELL.HAZARD, DOOR_X + DOOR_T * 0.5 + 0.03, 3.35, dz, DOOR_W - 0.4, 1.55,
      'x', 1, tint(0xfff0c0, 0.35));
    card(B, CELL.NAME, DOOR_X + DOOR_T * 0.5 + 0.03, 2.30, dz - 0.1, 2.3, 2.3,
      'x', 1, tint(0xf0f2ea, 0.4));
    card(B, CELL.RAD, VEST_X0 - 0.02, 2.55, -DOOR_W * 0.5 - 1.05, 1.5, 1.5,
      'x', 1, tint(0xfff4cc, 0.4));
    card(B, CELL.WEEP, DOOR_X + DOOR_T * 0.5 + 0.02, 2.6, dz + 1.9, 1.5, 2.9,
      'x', 1, tint(0xc08858, 0.7));

    // the rails the plug runs on, carried right across the pocket
    B.paint = 'metal';
    for (k = -1; k <= 1; k += 2) {
      var rz2 = k * (DOOR_W * 0.5 - 0.55);
      B.box('rust_metal', 0.30, 0.10, DOOR_W + DOOR_OPEN * 2 + 1.0,
        DOOR_X + k * 0.0, 0.045, DOOR_OPEN * 0.4);
    }
    B.box('rust_metal', 0.34, 0.11, DOOR_W + DOOR_OPEN * 2 + 1.2, DOOR_X - 0.42, 0.05, DOOR_OPEN * 0.4);
    B.box('rust_metal', 0.34, 0.11, DOOR_W + DOOR_OPEN * 2 + 1.2, DOOR_X + 0.42, 0.05, DOOR_OPEN * 0.4);
    // the hydraulic rams, still extended, and their anchor blocks
    for (i = 0; i < 2; i++) {
      var ry2 = 0.85 + i * 2.35;
      B.paint = 'clad';
      B.cyl('hull_paint', 0.19, 0.19, 2.20, DOOR_X, ry2, dz - DOOR_W * 0.5 - 2.4,
        Math.PI * 0.5, 0, 0, 10);
      B.paint = 'metal';
      B.cyl('steel', 0.085, 0.085, 2.6, DOOR_X, ry2, dz - DOOR_W * 0.5 - 0.9,
        Math.PI * 0.5, 0, 0, 8);
      B.box('rust_metal', 0.55, 0.55, 0.42, DOOR_X, ry2, dz - DOOR_W * 0.5 - 3.6);
      L.addCollider(DOOR_X, ry2, dz - DOOR_W * 0.5 - 2.6, 0.24, 0.24, 1.4, 'metal');
    }
    // the plug's collider, and the jamb reveal it seals against
    L.addCollider(DOOR_X, DOOR_H * 0.5 - 0.10, dz, DOOR_T * 0.5, DOOR_H * 0.5 + 0.10,
      DOOR_W * 0.5, 'metal');

    // ---- decontamination stalls on the south wall --------------------------
    for (i = 0; i < 3; i++) {
      var sx = VEST_X0 + 2.2 + i * 2.30;
      B.paint = 'clad';
      B.box('hull_paint', 0.09, 2.35, 2.05, sx, 1.18, -VEST_HZ + 1.05);
      B.paint = 'metal';
      B.pipe('rust_metal', sx - 1.0, 2.30, -VEST_HZ + 0.25, sx - 1.0, 2.30, -VEST_HZ + 1.9, 0.030, 6);
      B.pipe('rust_metal', sx - 1.0, 2.30, -VEST_HZ + 1.9, sx - 1.0, 2.02, -VEST_HZ + 1.9, 0.030, 6);
      B.cyl('rust_metal', 0.11, 0.06, 0.10, sx - 1.0, 1.96, -VEST_HZ + 1.9, 0, 0, 0, 8);
      L.addCollider(sx, 1.18, -VEST_HZ + 1.05, 0.06, 1.18, 1.02, 'metal');
    }
    card(B, CELL.STENCIL, VEST_X0 + 4.6, 3.05, -VEST_HZ + 0.06, 2.6, 1.3, 'z', 1,
      tint(0xe8ece0, 0.4));
    // hose reel
    B.paint = 'metal';
    B.cyl('rust_metal', 0.42, 0.42, 0.26, VEST_X0 + 9.4, 1.55, -VEST_HZ + 0.35,
      0, 0, Math.PI * 0.5, 12);
    B.box('rust_metal', 0.16, 0.75, 0.16, VEST_X0 + 9.4, 0.75, -VEST_HZ + 0.30);

    // ---- the guard cabin, north side, up a short flight --------------------
    // A real mezzanine: it is the vestibule's verticality and it puts a lit
    // window 3 m up in the frame, which is what stops the top third of hero3
    // being an unbroken concrete wall.
    var cbx0 = VEST_X0 + 2.6, cbx1 = VEST_X0 + 7.4;
    var cbY = 2.95;
    B.paint = 'plate';
    B.box('plate_steel', cbx1 - cbx0, 0.14, 3.10, (cbx0 + cbx1) * 0.5, cbY - 0.07,
      VEST_HZ - 1.55);
    B.paint = 'metal';
    for (i = 0; i < 4; i++) {
      var px2 = cbx0 + 0.35 + i * ((cbx1 - cbx0 - 0.7) / 3);
      B.box('steel', 0.14, cbY, 0.14, px2, cbY * 0.5, VEST_HZ - 3.0);
    }
    B.paint = 'clad';
    B.dark = 0.10;
    B.box('hull_paint', cbx1 - cbx0, 1.05, 0.10, (cbx0 + cbx1) * 0.5, cbY + 0.52, VEST_HZ - 3.05);
    B.box('hull_paint', 0.10, 2.30, 3.10, cbx0, cbY + 1.15, VEST_HZ - 1.55);
    B.box('hull_paint', 0.10, 2.30, 3.10, cbx1, cbY + 1.15, VEST_HZ - 1.55);
    B.box('hull_paint', cbx1 - cbx0, 0.55, 0.10, (cbx0 + cbx1) * 0.5, cbY + 2.02, VEST_HZ - 3.05);
    B.dark = 0;
    B.paint = 'metal';
    // the glazing
    B.paint = 'glass';
    B.box('glass_dirty', cbx1 - cbx0 - 0.2, 0.90, 0.04, (cbx0 + cbx1) * 0.5, cbY + 1.28, VEST_HZ - 3.05);
    B.paint = 'metal';
    L.addCollider((cbx0 + cbx1) * 0.5, cbY - 0.07, VEST_HZ - 1.55,
      (cbx1 - cbx0) * 0.5, 0.10, 1.55, 'metal', true);
    L.addCollider((cbx0 + cbx1) * 0.5, cbY + 1.2, VEST_HZ - 3.05,
      (cbx1 - cbx0) * 0.5, 1.2, 0.09, 'metal');
    // the stair up to it
    var stx0 = cbx1 + 0.25, stn = 12;
    B.paint = 'plate';
    for (i = 0; i < stn; i++) {
      var tx2 = stx0 + i * 0.29;
      B.box('plate_steel', 0.29, 0.045, 1.05, tx2, (i + 1) * (cbY / stn), VEST_HZ - 1.9);
      B.box('rust_metal', 0.03, cbY / stn, 1.05, tx2 + 0.14, (i + 0.5) * (cbY / stn), VEST_HZ - 1.9);
    }
    B.paint = 'metal';
    railRun(B, stx0, 0.0, VEST_HZ - 2.45, stx0 + stn * 0.29, cbY, VEST_HZ - 2.45, 1.02, false);
    railRun(B, cbx0, cbY, VEST_HZ - 3.05, cbx0, cbY, VEST_HZ - 0.05, 1.05);

    // ---- floor markings ----------------------------------------------------
    B.paint = 'line';
    B.box('paint_line', 0.55, 0.014, VEST_HZ * 2 - 1.2, VEST_X0 + 1.35, 0.012, 0);
    B.box('paint_line', VEST_X1 - VEST_X0 - 2.0, 0.014, 0.16, (VEST_X0 + VEST_X1) * 0.5, 0.012, -2.20);
    B.box('paint_line', VEST_X1 - VEST_X0 - 2.0, 0.014, 0.16, (VEST_X0 + VEST_X1) * 0.5, 0.012, 2.20);
    B.paint = 'metal';
    for (i = 0; i < 4; i++) {
      card(B, CELL.HAZARD, VEST_X0 + 1.35, 0.020, -4.2 + i * 2.8, 2.6, 1.1, 'y', 1,
        tint(0xffeeb8, 0.45), Math.PI * 0.5);
    }
    card(B, CELL.NUM, VEST_X1 - 3.0, 0.021, -3.6, 2.2, 2.2, 'y', 1, tint(0xe6e8dc, 0.4));
    card(B, CELL.DUST, VEST_X0 + 6.0, 0.019, 3.2, 6.0, 5.0, 'y', 1, null);
    card(B, CELL.DUST, VEST_X1 - 4.0, 0.019, -1.0, 5.0, 4.4, 'y', 1, null);

    // wall staining, both sides
    for (i = 0; i < 7; i++) {
      var wx = rng.range(VEST_X0 + 1.0, VEST_X1 - 1.0);
      var sgn = rng.bool() ? 1 : -1;
      card(B, rng.pick([CELL.STAIN, CELL.PEEL, CELL.WEEP, CELL.SOOT]),
        wx, rng.range(1.6, 4.2), sgn * (VEST_HZ - 0.02), rng.range(2.0, 3.6),
        rng.range(2.4, 4.2), 'z', -sgn, null);
    }
  }

  // ===========================================================================
  // THE SPINE.  42 m of 3.9 m corridor, 2.86 m to the soffit, and the level's
  // whole claustrophobic argument. Everything in it exists to make the
  // perspective read: downstand beams and wall pilasters at 2.60 m centres, three
  // tiers of cable tray converging on the vanishing point, a ventilation trunk
  // above the south tray, three blast door frames breaking the run, and a
  // continuous low-level escape marker line at 0.32 m.
  //
  // That marker line is not decoration. The metro measured half its 8x8 coverage
  // grid below the visibility floor when a long space was lit by a few ceiling
  // pools; a continuous line is the one thing a row of points cannot be, and it
  // is what puts value on 42 m of floor.
  // ===========================================================================
  function buildSpine(L, B, rng, N) {
    var i, k, s;
    var f = function (x, z) { return deckY(x, z, N); };

    B.paint = 'floor';
    B.add('deck_conc', deck(SPN_X0, SPN_X1, -SPN_HZ, SPN_HZ, 0.55, f));
    B.paint = 'metal';
    L.addCollider((SPN_X0 + SPN_X1) * 0.5, -0.26, 0,
      (SPN_X1 - SPN_X0) * 0.5, 0.26, SPN_HZ, 'concrete', true);

    // ---- walls -------------------------------------------------------------
    B.paint = 'wall';
    slotWall(B, L, 'wall_conc', 'z', SPN_HZ + 0.30, 0.60, SPN_X0, SPN_X1,
      -0.4, SPN_CEIL + 0.6,
      [{ c: (LINK_X0 + LINK_X1) * 0.5, hw: (LINK_X1 - LINK_X0) * 0.5, y0: -0.4, y1: 2.42 }],
      'concrete');
    slotWall(B, L, 'wall_conc', 'z', -SPN_HZ - 0.30, 0.60, SPN_X0, SPN_X1,
      -0.4, SPN_CEIL + 0.6,
      [{ c: -9.5, hw: 1.55, y0: -0.4, y1: 2.42 }], 'concrete');
    B.paint = 'ceil';
    slab(B, L, 'ceil_conc', SPN_X0, SPN_X1, -SPN_HZ - 0.6, SPN_HZ + 0.6,
      SPN_CEIL, 0.62, 'concrete');
    B.paint = 'metal';

    // ---- the rhythm: downstand beams and wall pilasters --------------------
    var nBeam = Math.floor((SPN_X1 - SPN_X0) / BEAM_PITCH);
    B.paint = 'ceil';
    for (i = 1; i < nBeam; i++) {
      var bx = SPN_X0 + i * BEAM_PITCH;
      B.box('ceil_conc', 0.42, 0.24, SPN_HZ * 2, bx, SPN_CEIL - 0.12, 0);
      for (s = -1; s <= 1; s += 2) {
        B.box('wall_conc', 0.42, SPN_CEIL - 0.24, 0.14, bx, (SPN_CEIL - 0.24) * 0.5,
          s * (SPN_HZ - 0.07));
      }
    }
    B.paint = 'metal';

    // ---- the dado: red oxide primer to 1.15, peeling ----------------------
    B.paint = 'paint';
    B.tint = tint(0x8a4034, 1.0);
    for (s = -1; s <= 1; s += 2) {
      B.box('dado_paint', SPN_X1 - SPN_X0, 1.15, 0.05,
        (SPN_X0 + SPN_X1) * 0.5, 0.575, s * (SPN_HZ - 0.025));
      // the skirt line: a paler band the mop never reached above
      B.box('dado_paint', SPN_X1 - SPN_X0, 0.055, 0.075,
        (SPN_X0 + SPN_X1) * 0.5, 1.175, s * (SPN_HZ - 0.035));
    }
    B.tint = null;
    B.paint = 'metal';

    // ---- services ----------------------------------------------------------
    // three tiers of tray on the north wall, one on the south, and a trunk
    for (i = 0; i < 3; i++) {
      cableTray(B, SPN_X0 + 0.3, SPN_X1 - 0.3, 2.62 - i * 0.30, SPN_HZ - 0.34, 0.48, rng, 1);
    }
    cableTray(B, SPN_X0 + 0.3, SPN_X1 - 0.3, 2.30, -SPN_HZ + 0.34, 0.40, rng, -1);
    // the ventilation trunk, rectangular, with flanged joints
    B.paint = 'clad';
    B.box('hull_paint', SPN_X1 - SPN_X0 - 0.4, 0.44, 0.52, (SPN_X0 + SPN_X1) * 0.5,
      2.55, -SPN_HZ + 0.42);
    B.paint = 'metal';
    for (i = 0; i * 3.2 < SPN_X1 - SPN_X0; i++) {
      var fx = SPN_X0 + 0.6 + i * 3.2;
      if (fx > SPN_X1 - 0.4) break;
      B.box('rust_metal', 0.07, 0.52, 0.60, fx, 2.55, -SPN_HZ + 0.42);
      B.box('rust_metal', 0.05, 0.16, 0.16, fx, 2.20, -SPN_HZ + 0.42);
    }
    // junction boxes, conduit droppers, isolators
    for (i = 0; i < 16; i++) {
      var jx = SPN_X0 + 1.6 + i * 2.55;
      if (jx > SPN_X1 - 1.0) break;
      var js = (i % 2) ? 1 : -1;
      B.paint = 'clad';
      B.box('hull_paint', 0.26, 0.34, 0.16, jx, rng.range(1.62, 1.96), js * (SPN_HZ - 0.09));
      B.paint = 'metal';
      B.pipe('rust_metal', jx, 1.96, js * (SPN_HZ - 0.06), jx, 2.28, js * (SPN_HZ - 0.06), 0.022, 6);
      if (i % 3 === 1) cableDrop(B, jx, 2.30, js * (SPN_HZ - 0.20), 1.98, rng, 0.10);
    }

    // ---- blast door frames -------------------------------------------------
    // Three of them break 42 m into legible bays. The middle one is the mid
    // ground subject of the corridor framing: its leaf is dogged back against
    // the wall and the beacon above it throws a red bar straight across it.
    for (i = 0; i < SPN_DOORS.length; i++) {
      var dx2 = SPN_DOORS[i];
      B.paint = 'wall';
      // the thickened jamb the frame is cast into
      slotWall(B, L, 'wall_conc', 'x', dx2, 0.75, -SPN_HZ, SPN_HZ, 0, SPN_CEIL,
        [{ c: 0, hw: 1.10, y0: 0, y1: 2.22 }], 'concrete');
      B.paint = 'metal';
      // the frame: a rolled steel section all round the opening
      B.box('steel', 0.86, 0.16, 0.20, dx2, 2.30, -1.10);
      B.box('steel', 0.86, 0.16, 0.20, dx2, 2.30, 1.10);
      B.box('steel', 0.86, 0.16, 2.40, dx2, 2.30, 0);
      B.box('steel', 0.86, 2.30, 0.18, dx2, 1.15, -1.19);
      B.box('steel', 0.86, 2.30, 0.18, dx2, 1.15, 1.19);
      // the leaf, dogged back against the north wall, with its wheel and dogs
      var leafZ = SPN_HZ - 0.34;
      B.paint = 'clad';
      B.dark = 0.10;
      B.boxR('hull_paint', 0.12, 2.16, 2.10, dx2 + 0.62, 1.10, leafZ, 0, -1.42, 0);
      B.dark = 0;
      B.paint = 'metal';
      B.cyl('steel', 0.20, 0.20, 0.07, dx2 + 0.72, 1.35, leafZ - 0.30,
        0, -1.42, Math.PI * 0.5, 12);
      for (k = 0; k < 4; k++) {
        B.box('steel', 0.07, 0.10, 0.10, dx2 + 0.66, 0.42 + k * 0.55, leafZ - 0.95);
      }
      L.addCollider(dx2 + 0.62, 1.10, leafZ, 0.42, 1.08, 0.32, 'metal');
      card(B, CELL.DOOR, dx2 - 0.40, 1.95, -1.30, 0.75, 0.75, 'z', -1, tint(0xdfe6da, 0.4));
      card(B, CELL.HAZARD, dx2 + 0.44, 0.55, 0, 2.30, 0.55, 'x', 1, tint(0xffeeb8, 0.4));
    }

    // ---- floor: the worn route, a centre line, and hazard at each door ------
    B.paint = 'line';
    B.box('paint_line', SPN_X1 - SPN_X0 - 1.0, 0.013, 0.10, (SPN_X0 + SPN_X1) * 0.5, 0.011, -SPN_HZ + 0.55);
    B.box('paint_line', SPN_X1 - SPN_X0 - 1.0, 0.013, 0.10, (SPN_X0 + SPN_X1) * 0.5, 0.011, SPN_HZ - 0.55);
    B.paint = 'metal';
    for (i = 0; i < 14; i++) {
      var ax2 = SPN_X0 + 3.0 + i * 3.0;
      if (ax2 > SPN_X1 - 2.0) break;
      card(B, CELL.DUST, ax2, 0.018, rng.range(-1.1, 1.1), rng.range(2.6, 4.4),
        rng.range(1.8, 3.0), 'y', 1, null);
    }
    for (i = 0; i < 6; i++) {
      card(B, CELL.ARROW, SPN_X0 + 5.0 + i * 6.4, 0.34, -SPN_HZ + 0.02, 0.80, 0.36,
        'z', 1, tint(0xd8e4d0, 0.5));
    }
    // wall dressing
    for (i = 0; i < 22; i++) {
      var wx2 = rng.range(SPN_X0 + 1.0, SPN_X1 - 1.0);
      var sg2 = rng.bool() ? 1 : -1;
      card(B, rng.pick([CELL.STAIN, CELL.PEEL, CELL.WEEP, CELL.STAIN, CELL.SOOT, CELL.TAG]),
        wx2, rng.range(1.2, 2.6), sg2 * (SPN_HZ - 0.015), rng.range(1.4, 2.8),
        rng.range(1.4, 2.4), 'z', -sg2, null);
    }
    for (i = 0; i < 5; i++) {
      card(B, CELL.STENCIL, SPN_X0 + 6.0 + i * 8.0, 1.95, -SPN_HZ + 0.015, 1.7, 0.85,
        'z', 1, tint(0xe4e8dc, 0.4));
    }
  }

  // The link corridor's floor ramps 0.30 m up onto the control room's raised
  // access floor. Solved here so sampleGround, the navgrid and the geometry all
  // read the same number.
  var LINK_Z0 = SPN_HZ, LINK_Z1 = CTL_Z0;
  function linkY(z) {
    var t = M.saturate((z - (LINK_Z0 + 0.25)) / ((LINK_Z1 - 0.4) - (LINK_Z0 + 0.25)));
    return DECK_Y + (CTL_FLOOR - DECK_Y) * M.smoothstep(0, 1, t);
  }

  // The two lifted access-floor panels. Real holes, 30 cm deep, with the panels
  // stood against the console beside them - the detail that says somebody was
  // working on this and left in a hurry.
  var CTL_VOIDS = [
    { x0: -25.8, x1: -24.0, z0: 9.4, z1: 10.6 },
    { x0: -19.2, x1: -18.0, z0: 12.8, z1: 14.0 }
  ];
  function inCtlVoid(x, z) {
    for (var i = 0; i < CTL_VOIDS.length; i++) {
      var v = CTL_VOIDS[i];
      if (x > v.x0 && x < v.x1 && z > v.z0 && z < v.z1) return true;
    }
    return false;
  }

  // The console rows. Published as anchors so props can put a chair, a mug and a
  // fallen binder against a console that actually exists.
  var CTL_ROWS = [
    { z: 8.30, x0: -28.20, n: 5, w: 1.62 },
    { z: 11.70, x0: -27.40, n: 4, w: 1.62 }
  ];

  // ===========================================================================
  // THE CONTROL ROOM.
  //
  // The one room in the facility with a different floor, a different ceiling and
  // a different light. A raised access floor on pedestals (flat, panel-jointed,
  // two panels lifted), a suspended tile grid at 2.95 that has come down over a
  // third of the room, a horseshoe of dead CRT consoles, and a backlit status
  // wall with three of its eight panels still alight. That wall is the only
  // large emitting surface in the level and it is the interior framing's subject.
  // ===========================================================================
  function buildControlRoom(L, B, rng, N) {
    var i, k, s;

    // ---- structural slab, then the raised floor over it --------------------
    B.paint = 'floor';
    B.add('deck_conc', deck(CTL_X0, CTL_X1, CTL_Z0, CTL_Z1, 0.9,
      function (x, z) { return deckY(x, z, N); }));
    B.add('deck_conc', deck(CTL_X0, CTL_X1, CTL_Z0, CTL_Z1, 0.60,
      function (x, z) { return inCtlVoid(x, z) ? -999 : ctlY(x, z); }));
    B.paint = 'metal';
    L.addCollider((CTL_X0 + CTL_X1) * 0.5, CTL_FLOOR - 0.16, (CTL_Z0 + CTL_Z1) * 0.5,
      (CTL_X1 - CTL_X0) * 0.5, 0.16, (CTL_Z1 - CTL_Z0) * 0.5, 'metal', true);
    // pedestals and the cable void seen through the lifted panels
    B.paint = 'metal';
    for (i = 0; i < CTL_VOIDS.length; i++) {
      var v = CTL_VOIDS[i];
      for (k = 0; k < 6; k++) {
        var px = v.x0 + rng.range(0.1, v.x1 - v.x0 - 0.1);
        var pz = v.z0 + rng.range(0.1, v.z1 - v.z0 - 0.1);
        B.box('steel', 0.05, 0.30, 0.05, px, 0.15, pz);
      }
      B.paint = 'cable';
      for (k = 0; k < 5; k++) {
        B.pipe('cable_rub', v.x0 - 0.2, 0.06 + k * 0.035, v.z0 + 0.2 + k * 0.16,
          v.x1 + 0.2, 0.06 + k * 0.035, v.z0 + 0.28 + k * 0.16, rng.range(0.022, 0.038), 6);
      }
      B.paint = 'plate';
      // the lifted panel itself, stood on edge against the nearest console
      B.boxR('plate_steel', 0.60, 0.60, 0.032, v.x0 - 0.42, 0.60, (v.z0 + v.z1) * 0.5,
        0, 0.22, -0.30);
      B.paint = 'metal';
      L.addCollider((v.x0 + v.x1) * 0.5, 0.0, (v.z0 + v.z1) * 0.5,
        (v.x1 - v.x0) * 0.5, 0.02, (v.z1 - v.z0) * 0.5, 'concrete', true);
    }

    // ---- shell -------------------------------------------------------------
    B.paint = 'wall';
    slotWall(B, L, 'wall_conc', 'z', CTL_Z0 - 0.30, 0.60, CTL_X0 - 0.6, CTL_X1 + 0.6,
      -0.4, CTL_CEIL + 0.6,
      [{ c: (LINK_X0 + LINK_X1) * 0.5, hw: (LINK_X1 - LINK_X0) * 0.5, y0: -0.4, y1: 2.52 }],
      'concrete');
    slotWall(B, L, 'wall_conc', 'z', CTL_Z1 + 0.30, 0.60, CTL_X0 - 0.6, CTL_X1 + 0.6,
      -0.4, CTL_CEIL + 0.6, [], 'concrete');
    slotWall(B, L, 'wall_conc', 'x', CTL_X0 - 0.30, 0.60, CTL_Z0 - 0.6, CTL_Z1 + 0.6,
      -0.4, CTL_CEIL + 0.6, [], 'concrete');
    slotWall(B, L, 'wall_conc', 'x', CTL_X1 + 0.30, 0.60, CTL_Z0 - 0.6, CTL_Z1 + 0.6,
      -0.4, CTL_CEIL + 0.6, [], 'concrete');
    B.paint = 'ceil';
    slab(B, L, 'ceil_conc', CTL_X0 - 0.6, CTL_X1 + 0.6, CTL_Z0 - 0.6, CTL_Z1 + 0.6,
      CTL_CEIL, 0.70, 'concrete');
    B.paint = 'metal';

    // ---- the link corridor -------------------------------------------------
    B.paint = 'floor';
    B.add('deck_conc', deck(LINK_X0, LINK_X1, LINK_Z0 - 0.2, LINK_Z1 + 0.1, 0.35,
      function (x, z) { return linkY(z); }));
    B.paint = 'wall';
    slotWall(B, L, 'wall_conc', 'x', LINK_X0 - 0.3, 0.60, LINK_Z0 - 0.3, LINK_Z1 + 0.3,
      -0.4, 2.52 + 0.5, [], 'concrete');
    slotWall(B, L, 'wall_conc', 'x', LINK_X1 + 0.3, 0.60, LINK_Z0 - 0.3, LINK_Z1 + 0.3,
      -0.4, 2.52 + 0.5, [], 'concrete');
    B.paint = 'ceil';
    slab(B, L, 'ceil_conc', LINK_X0 - 0.6, LINK_X1 + 0.6, LINK_Z0, LINK_Z1 + 0.3,
      2.52, 0.5, 'concrete');
    B.paint = 'metal';
    L.addCollider((LINK_X0 + LINK_X1) * 0.5, 0.0, (LINK_Z0 + LINK_Z1) * 0.5,
      (LINK_X1 - LINK_X0) * 0.5, 0.20, (LINK_Z1 - LINK_Z0) * 0.5, 'concrete', true);
    // a glazed supervisor's screen down one side of the link
    B.paint = 'clad';
    B.box('hull_paint', 0.09, 0.95, 2.30, LINK_X0 + 0.05, 0.62, (LINK_Z0 + LINK_Z1) * 0.5);
    B.paint = 'glass';
    B.box('glass_dirty', 0.04, 1.05, 2.30, LINK_X0 + 0.05, 1.66, (LINK_Z0 + LINK_Z1) * 0.5);
    B.paint = 'metal';
    cableTray(B, LINK_X0 + 0.2, LINK_X1 - 0.2, 2.28, LINK_X1 - 0.4, 0.40, rng, 0);
    card(B, CELL.DOOR, LINK_X1 - 0.32, 1.95, LINK_Z1 - 0.6, 0.70, 0.70, 'x', -1,
      tint(0xdfe6da, 0.4));

    // ---- the dado, carried through ----------------------------------------
    B.paint = 'paint';
    B.tint = tint(0x8a4034, 1.0);
    B.box('dado_paint', CTL_X1 - CTL_X0, 1.05, 0.05, (CTL_X0 + CTL_X1) * 0.5,
      CTL_FLOOR + 0.525, CTL_Z0 + 0.025);
    B.box('dado_paint', 0.05, 1.05, CTL_Z1 - CTL_Z0, CTL_X0 + 0.025,
      CTL_FLOOR + 0.525, (CTL_Z0 + CTL_Z1) * 0.5);
    B.box('dado_paint', 0.05, 1.05, CTL_Z1 - CTL_Z0, CTL_X1 - 0.025,
      CTL_FLOOR + 0.525, (CTL_Z0 + CTL_Z1) * 0.5);
    B.tint = null;
    B.paint = 'metal';

    // ---- the suspended ceiling, half of it on the floor --------------------
    // The grid runs the whole room; the TILES stop where the ceiling came down.
    var gy = 2.95;
    B.paint = 'metal';
    for (i = 0; (CTL_X0 + 0.3 + i * 1.20) < CTL_X1; i++) {
      var gx2 = CTL_X0 + 0.3 + i * 1.20;
      B.box('steel', 0.05, 0.06, CTL_Z1 - CTL_Z0 - 0.4, gx2, gy, (CTL_Z0 + CTL_Z1) * 0.5);
    }
    for (i = 0; (CTL_Z0 + 0.4 + i * 1.20) < CTL_Z1; i++) {
      var gz2 = CTL_Z0 + 0.4 + i * 1.20;
      B.box('steel', CTL_X1 - CTL_X0 - 0.4, 0.06, 0.05, (CTL_X0 + CTL_X1) * 0.5, gy, gz2);
      // hangers
      for (k = 0; k < 5; k++) {
        var hx = CTL_X0 + 1.6 + k * 3.2;
        if (hx > CTL_X1 - 0.6) break;
        B.pipe('steel', hx, gy, gz2, hx, CTL_CEIL, gz2, 0.008, 4);
      }
    }
    B.paint = 'clad';
    B.dark = 0.05;
    for (i = 0; i < 11; i++) {
      for (k = 0; k < 9; k++) {
        var tx3 = CTL_X0 + 0.9 + i * 1.20, tz3 = CTL_Z0 + 1.0 + k * 1.20;
        if (tx3 > CTL_X1 - 0.5 || tz3 > CTL_Z1 - 0.5) continue;
        // the collapse: everything in the south-east third is gone
        var gone = (tx3 > -20.0 && tz3 < 11.5) &&
          (N.fbm2(tx3 * 0.32, tz3 * 0.32, 2) * 0.5 + 0.5) > 0.36;
        if (gone) continue;
        B.box('panel_bake', 1.14, 0.022, 1.14, tx3, gy - 0.03, tz3);
      }
    }
    B.dark = 0;
    B.paint = 'metal';
    // the fallen tiles, on the floor and over the consoles
    B.paint = 'clad';
    for (i = 0; i < 26; i++) {
      var fx2 = rng.range(-20.6, CTL_X1 - 0.8), fz2 = rng.range(CTL_Z0 + 0.8, 11.4);
      B.boxR('panel_bake', rng.range(0.5, 1.14), 0.022, rng.range(0.5, 1.14),
        fx2, CTL_FLOOR + rng.range(0.02, 0.10), fz2,
        rng.range(-0.35, 0.35), rng.range(0, 3.14), rng.range(-0.35, 0.35));
    }
    B.paint = 'metal';
    // torn hangers and a dangling cable where it let go
    for (i = 0; i < 10; i++) {
      var dx3 = rng.range(-20.0, CTL_X1 - 1.0), dz3 = rng.range(CTL_Z0 + 1.0, 11.0);
      B.pipe('steel', dx3, CTL_CEIL, dz3, dx3 + rng.range(-0.2, 0.2),
        CTL_CEIL - rng.range(0.4, 1.5), dz3 + rng.range(-0.2, 0.2), 0.008, 4);
    }
    for (i = 0; i < 3; i++) {
      cableDrop(B, rng.range(-19.5, -15.0), CTL_CEIL - 0.05, rng.range(6.0, 10.5),
        CTL_FLOOR + rng.range(0.6, 1.6), rng, 0.30);
    }

    // ---- THE CONSOLES ------------------------------------------------------
    for (var r = 0; r < CTL_ROWS.length; r++) {
      var row = CTL_ROWS[r];
      for (i = 0; i < row.n; i++) {
        var cx2 = row.x0 + i * row.w;
        var cz2 = row.z;
        var lean = (r === 0 && i === 2) ? 0.05 : 0;   // one unit shoved out of line
        buildConsole(L, B, rng, N, cx2, cz2 + lean, row.w - 0.06, (r * 7 + i));
      }
    }
    // equipment racks down the west wall
    for (i = 0; i < 6; i++) {
      var rx2 = CTL_X0 + 0.85;
      var rz2 = CTL_Z0 + 1.4 + i * 0.86;
      B.paint = 'clad';
      B.dark = 0.16;
      B.box('hull_paint', 0.90, 2.05, 0.82, rx2, CTL_FLOOR + 1.025, rz2);
      B.dark = 0;
      B.paint = 'metal';
      for (k = 0; k < 7; k++) {
        B.box('panel_bake', 0.02, 0.20, 0.72, rx2 + 0.46, CTL_FLOOR + 0.35 + k * 0.24, rz2);
      }
      L.addCollider(rx2, CTL_FLOOR + 1.025, rz2, 0.45, 1.025, 0.41, 'metal');
    }

    // ---- THE STATUS WALL ---------------------------------------------------
    // 13 m of backlit plotting board in eight bays. Five are dark glass; three
    // still have a tube behind them, and those three are the brightest surface
    // in the level after the beacons.
    var swZ = CTL_Z1 - 0.10, swX0 = -28.6, swX1 = -15.4;
    B.paint = 'clad';
    B.dark = 0.20;
    B.box('hull_paint', swX1 - swX0 + 0.5, 2.85, 0.22, (swX0 + swX1) * 0.5,
      CTL_FLOOR + 2.05, swZ + 0.10);
    B.dark = 0;
    B.paint = 'metal';
    var LITBAY = { 1: 1, 4: 1, 6: 1 };
    var bayW = (swX1 - swX0) / 8;
    for (i = 0; i < 8; i++) {
      var bx2 = swX0 + (i + 0.5) * bayW;
      // the frame
      B.box('steel', 0.055, 2.55, 0.10, bx2 - bayW * 0.5, CTL_FLOOR + 2.05, swZ);
      B.box('steel', bayW, 0.06, 0.10, bx2, CTL_FLOOR + 0.80, swZ);
      B.box('steel', bayW, 0.06, 0.10, bx2, CTL_FLOOR + 3.30, swZ);
      if (LITBAY[i]) {
        // the diffuser, and the map on it
        B.paint = 'clad';
        B.dark = 0.0;
        B.box('panel_bake', bayW - 0.10, 2.40, 0.035, bx2, CTL_FLOOR + 2.05, swZ - 0.03);
        B.paint = 'metal';
        card(B, i === 4 ? CELL.GRID : CELL.SCHEM, bx2, CTL_FLOOR + 2.05, swZ - 0.055,
          bayW - 0.14, 2.30, 'z', -1, null);
        L.statusBays.push({ x: bx2, y: CTL_FLOOR + 2.05, z: swZ - 0.05,
          w: bayW - 0.10, h: 2.40, lit: true });
      } else {
        B.paint = 'glass';
        B.dark = 0.55;
        B.box('glass_dirty', bayW - 0.10, 2.40, 0.03, bx2, CTL_FLOOR + 2.05, swZ - 0.03);
        B.dark = 0;
        B.paint = 'metal';
        card(B, rng.pick([CELL.SCHEM, CELL.GRID]), bx2, CTL_FLOOR + 2.05, swZ - 0.05,
          bayW - 0.16, 2.20, 'z', -1, tint(0x707c78, 0.9));
        L.statusBays.push({ x: bx2, y: CTL_FLOOR + 2.05, z: swZ - 0.05,
          w: bayW - 0.10, h: 2.40, lit: false });
      }
    }
    B.box('steel', swX1 - swX0, 0.06, 0.10, (swX0 + swX1) * 0.5, CTL_FLOOR + 0.80, swZ);
    L.addCollider((swX0 + swX1) * 0.5, CTL_FLOOR + 2.05, swZ + 0.05,
      (swX1 - swX0) * 0.5, 1.30, 0.16, 'metal');
    card(B, CELL.NAME, swX0 - 0.9, CTL_FLOOR + 2.5, swZ - 0.02, 1.6, 1.6, 'z', -1,
      tint(0xe8ece0, 0.4));

    // ---- wall dressing -----------------------------------------------------
    for (i = 0; i < 12; i++) {
      var ws = rng.bool() ? 1 : -1;
      card(B, rng.pick([CELL.STAIN, CELL.PEEL, CELL.WEEP, CELL.SOOT]),
        ws > 0 ? CTL_X1 - 0.015 : CTL_X0 + 0.015,
        rng.range(1.4, 3.2), rng.range(CTL_Z0 + 1.0, CTL_Z1 - 1.0),
        rng.range(1.8, 3.4), rng.range(1.8, 3.0), 'x', -ws, null);
    }
    card(B, CELL.DUST, -22.0, CTL_FLOOR + 0.016, 9.6, 8.0, 5.0, 'y', 1, null);
    card(B, CELL.DUST, -17.5, CTL_FLOOR + 0.016, 13.6, 6.0, 5.0, 'y', 1, null);
    card(B, CELL.SOOT, -17.2, CTL_FLOOR + 0.017, 8.0, 5.0, 4.4, 'y', 1, null);
  }

  // One operator console: pedestal, sloped switch fascia, a CRT bay above with
  // two tubes in it. `seed` decides which tubes are alive - three in the room
  // still are, and they are the only warm chroma in the interior framing.
  function buildConsole(L, B, rng, N, cx, cz, w, seed) {
    var y0 = CTL_FLOOR;
    var i;
    B.paint = 'clad';
    B.dark = 0.14;
    // pedestal + kick recess
    B.box('hull_paint', w, 0.72, 0.86, cx, y0 + 0.40, cz);
    B.box('hull_paint', w - 0.12, 0.10, 0.72, cx, y0 + 0.05, cz);
    // worktop
    B.dark = 0.26;
    B.box('hull_paint', w + 0.06, 0.055, 0.94, cx, y0 + 0.79, cz);
    B.dark = 0;
    B.paint = 'metal';
    // the sloped fascia of switches and lamps
    B.paint = 'clad';
    B.boxR('panel_bake', w - 0.08, 0.34, 0.05, cx, y0 + 0.94, cz + 0.30, -0.62, 0, 0);
    B.paint = 'metal';
    for (i = 0; i < 9; i++) {
      var sx = cx - w * 0.42 + i * (w * 0.84 / 8);
      B.boxR('steel', 0.028, 0.075, 0.028, sx, y0 + 0.99, cz + 0.245, -0.62, 0, 0);
    }
    var PILOT = [0xff3a18, 0xffb437, 0x8fe37a, 0xff3a18, 0xffb437,
                 0x8fe37a, 0xff8a20, 0xff3a18];
    for (i = 0; i < 8; i++) {
      var lx = cx - w * 0.40 + i * (w * 0.80 / 7);
      var on = ((seed * 5 + i * 3) % 4) !== 0;
      B.paint = 'metal';
      B.boxR('steel', 0.036, 0.036, 0.022, lx, y0 + 0.885, cz + 0.29, -0.62, 0, 0);
      if (on) {
        emitBox(L, lx, y0 + 0.878, cz + 0.302, 0.028, 0.028, 0.014, 0,
          PILOT[i], 1.15, ((seed + i) % 5 === 0) ? 'crt' : 'steady', -0.62);
      }
    }
    // the CRT bay
    B.paint = 'clad';
    B.dark = 0.20;
    B.box('hull_paint', w, 1.02, 0.62, cx, y0 + 1.36, cz - 0.20);
    B.dark = 0;
    B.paint = 'metal';
    for (i = 0; i < 2; i++) {
      var tx = cx - w * 0.24 + i * (w * 0.48);
      var live = ((seed * 3 + i * 5) % 7) === 1;
      B.paint = 'clad';
      B.dark = 0.34;
      B.box('hull_paint', 0.50, 0.44, 0.50, tx, y0 + 1.46, cz - 0.22);
      B.dark = 0;
      B.paint = 'metal';
      // the tube face, sunk into its bezel
      B.paint = 'glass';
      B.dark = live ? 0.0 : 0.62;
      B.box('glass_dirty', 0.40, 0.34, 0.035, tx, y0 + 1.46, cz + 0.055);
      B.dark = 0;
      B.paint = 'metal';
      if (live) {
        card(B, CELL.CRT, tx, y0 + 1.46, cz + 0.082, 0.38, 0.32, 'z', 1, null);
        L.crtFaces.push({ x: tx, y: y0 + 1.46, z: cz + 0.09, w: 0.38, h: 0.32 });
      } else {
        card(B, CELL.CRT, tx, y0 + 1.46, cz + 0.082, 0.38, 0.32, 'z', 1,
          tint(0x4a4e50, 0.95));
      }
    }
    B.paint = 'metal';
    B.box('steel', w - 0.10, 0.06, 0.05, cx, y0 + 0.845, cz + 0.455);
    emitBox(L, cx, y0 + 0.818, cz + 0.470, w - 0.16, 0.026, 0.030, 0,
      0xffdcb0, ((seed * 7) % 6 === 0) ? 0.0 : 0.86,
      ((seed * 7) % 6 === 0) ? 'dying' : 'emerg');
    L.addCollider(cx, y0 + 0.45, cz, w * 0.5, 0.45, 0.48, 'metal');
    L.addCollider(cx, y0 + 1.36, cz - 0.20, w * 0.5, 0.52, 0.32, 'metal');
    L.consoles.push({ x: cx, y: y0, z: cz, w: w });
  }

  // ===========================================================================
  // THE PLANT ROOM, south off the spine. Switchgear, a transformer bay and the
  // air handling set that feeds the trunk in the corridor. Its job in the level
  // is to stop the spine being a pure tube and to give the corridor framing a
  // lit side-opening halfway down its length.
  // ===========================================================================
  function buildPlant(L, B, rng, N) {
    var i, k;
    B.paint = 'floor';
    B.add('deck_conc', deck(PLT_X0, PLT_X1, PLT_Z0, PLT_Z1, 0.65,
      function (x, z) { return deckY(x, z, N); }));
    B.paint = 'metal';
    L.addCollider((PLT_X0 + PLT_X1) * 0.5, -0.26, (PLT_Z0 + PLT_Z1) * 0.5,
      (PLT_X1 - PLT_X0) * 0.5, 0.26, (PLT_Z1 - PLT_Z0) * 0.5, 'concrete', true);

    B.paint = 'wall';
    slotWall(B, L, 'wall_conc', 'x', PLT_X0 - 0.30, 0.60, PLT_Z0 - 0.6, PLT_Z1,
      -0.4, PLT_CEIL + 0.5, [], 'concrete');
    slotWall(B, L, 'wall_conc', 'x', PLT_X1 + 0.30, 0.60, PLT_Z0 - 0.6, PLT_Z1,
      -0.4, PLT_CEIL + 0.5, [], 'concrete');
    slotWall(B, L, 'wall_conc', 'z', PLT_Z0 - 0.30, 0.60, PLT_X0 - 0.6, PLT_X1 + 0.6,
      -0.4, PLT_CEIL + 0.5, [], 'concrete');
    B.paint = 'ceil';
    slab(B, L, 'ceil_conc', PLT_X0 - 0.6, PLT_X1 + 0.6, PLT_Z0 - 0.6, PLT_Z1,
      PLT_CEIL, 0.60, 'concrete');
    B.paint = 'metal';

    // ---- switchgear: a row of cubicles, one with its door hanging open -----
    for (i = 0; i < 6; i++) {
      var sx = PLT_X0 + 1.1 + i * 1.24;
      B.paint = 'clad';
      B.dark = 0.12;
      B.box('hull_paint', 1.16, 2.15, 0.92, sx, 1.075, PLT_Z0 + 0.90);
      B.dark = 0;
      B.paint = 'metal';
      // door furniture: a handle, a mimic strip, three lamps
      B.box('steel', 0.06, 0.30, 0.05, sx + 0.44, 1.20, PLT_Z0 + 1.38);
      B.paint = 'clad';
      B.box('panel_bake', 0.86, 0.16, 0.03, sx, 1.72, PLT_Z0 + 1.37);
      B.paint = 'metal';
      if (i === 3) {
        // the open one - the cubicle interior and the busbars behind it
        B.paint = 'clad';
        B.dark = 0.10;
        B.boxR('hull_paint', 1.10, 2.05, 0.05, sx + 0.90, 1.05, PLT_Z0 + 1.30, 0, -1.15, 0);
        B.dark = 0;
        B.paint = 'metal';
        for (k = 0; k < 3; k++) {
          B.box('rust_metal', 0.05, 1.50, 0.10, sx - 0.30 + k * 0.30, 1.20, PLT_Z0 + 0.72);
        }
      }
      L.addCollider(sx, 1.075, PLT_Z0 + 0.90, 0.58, 1.075, 0.46, 'metal');
    }
    card(B, CELL.HAZARD, PLT_X0 + 4.0, 2.42, PLT_Z0 + 1.38, 2.6, 0.6, 'z', 1,
      tint(0xffeeb8, 0.4));

    // ---- the transformer bay ----------------------------------------------
    B.paint = 'clad';
    B.dark = 0.22;
    B.box('hull_paint', 2.10, 1.95, 1.55, PLT_X1 - 1.7, 0.975, PLT_Z1 - 1.5);
    B.dark = 0;
    B.paint = 'metal';
    for (i = 0; i < 9; i++) {
      B.box('rust_metal', 0.05, 1.55, 1.62, PLT_X1 - 2.65 + i * 0.24, 0.90, PLT_Z1 - 1.5);
    }
    for (i = 0; i < 3; i++) {
      B.cyl('panel_bake', 0.11, 0.14, 0.42, PLT_X1 - 2.3 + i * 0.6, 2.16, PLT_Z1 - 1.5, 0, 0, 0, 10);
      B.pipe('rust_metal', PLT_X1 - 2.3 + i * 0.6, 2.36, PLT_Z1 - 1.5,
        PLT_X1 - 2.3 + i * 0.6, PLT_CEIL - 0.2, PLT_Z1 - 1.5, 0.03, 6);
    }
    L.addCollider(PLT_X1 - 1.7, 0.975, PLT_Z1 - 1.5, 1.05, 0.975, 0.78, 'metal');
    // the safety cage round it
    B.paint = 'metal';
    railRun(B, PLT_X1 - 3.1, 0, PLT_Z1 - 2.6, PLT_X1 - 0.4, 0, PLT_Z1 - 2.6, 1.15, false);

    // ---- the air handling set and its trunk into the corridor --------------
    B.paint = 'clad';
    B.dark = 0.10;
    B.box('hull_paint', 2.60, 1.70, 1.30, PLT_X0 + 2.2, 0.85, PLT_Z1 - 1.2);
    B.dark = 0;
    B.paint = 'metal';
    B.cyl('rust_metal', 0.52, 0.52, 0.28, PLT_X0 + 2.2, 1.20, PLT_Z1 - 1.95,
      Math.PI * 0.5, 0, 0, 14);
    for (i = 0; i < 10; i++) {
      var fa = i / 10 * 6.2832;
      B.boxR('steel', 0.09, 0.42, 0.03, PLT_X0 + 2.2 + Math.cos(fa) * 0.26,
        1.20 + Math.sin(fa) * 0.26, PLT_Z1 - 1.90, Math.PI * 0.5, 0, fa);
    }
    B.paint = 'clad';
    B.box('hull_paint', 0.60, 0.52, 2.4, PLT_X0 + 3.9, 2.55, PLT_Z1 - 1.0);
    B.paint = 'metal';
    L.addCollider(PLT_X0 + 2.2, 0.85, PLT_Z1 - 1.2, 1.30, 0.85, 0.65, 'metal');

    // ---- a floor trench with its cover plates part-lifted ------------------
    B.paint = 'plate';
    for (i = 0; i < 9; i++) {
      var tx4 = PLT_X0 + 0.9 + i * 0.9;
      if (i === 4 || i === 5) continue;
      B.box('plate_steel', 0.86, 0.045, 0.72, tx4, 0.018, (PLT_Z0 + PLT_Z1) * 0.5);
    }
    B.paint = 'cable';
    for (i = 0; i < 6; i++) {
      B.pipe('cable_rub', PLT_X0 + 4.2, -0.16 + i * 0.04, (PLT_Z0 + PLT_Z1) * 0.5 - 0.28 + i * 0.10,
        PLT_X0 + 6.2, -0.16 + i * 0.04, (PLT_Z0 + PLT_Z1) * 0.5 - 0.28 + i * 0.10, 0.032, 6);
    }
    B.paint = 'metal';
    for (i = 0; i < 8; i++) {
      var ps = rng.bool() ? 1 : -1;
      card(B, rng.pick([CELL.STAIN, CELL.PEEL, CELL.WEEP, CELL.RAD, CELL.STENCIL]),
        rng.range(PLT_X0 + 1.0, PLT_X1 - 1.0), rng.range(1.4, 2.9),
        ps > 0 ? PLT_Z1 - 0.02 : PLT_Z0 + 0.02, rng.range(1.2, 2.4),
        rng.range(1.2, 2.2), 'z', ps > 0 ? -1 : 1, null);
    }
    card(B, CELL.DUST, PLT_X0 + 4.5, 0.017, (PLT_Z0 + PLT_Z1) * 0.5 + 1.6, 7.0, 4.0, 'y', 1, null);
  }

  // ===========================================================================
  // THE REACTOR GALLERY.
  //
  // 28 x 26.4 m on plan and 11 m clear, with a 19 x 19 m well cut through the
  // deck to the flooded lower level. The vessel stands on the centre line: a
  // stepped concrete bioshield out of the water, a welded steel vessel above it,
  // a torispherical head and twenty-four control-rod drive stalks. An operating
  // platform rings it at deck level, a gantry rings it again at 5.70, and a
  // crane girder crosses the whole hall at 9.70.
  //
  // The composition the hero framing is built on is fixed by the geometry, not
  // by the camera: you come out of the spine onto the west deck band, and the
  // WEST BRIDGE - 5.2 m wide, walkway on the south half, a four-pipe rack on the
  // north half, and a bundle of coolant lines overhead - runs dead ahead into
  // the bioshield. That is the leading line. Everything else in the frame is
  // arranged around it.
  // ===========================================================================
  function buildReactorHall(L, B, rng, N) {
    var i, k, s;
    var fd = function (x, z) { return deckY(x, z, N); };

    // ---- the perimeter deck bands -----------------------------------------
    B.paint = 'floor';
    B.add('deck_conc', deck(RG_X0, RG_X1, -RG_HZ, WELL_Z0, 0.70, fd));
    B.add('deck_conc', deck(RG_X0, RG_X1, WELL_Z1, RG_HZ, 0.70, fd));
    B.add('deck_conc', deck(RG_X0, WELL_X0, WELL_Z0, WELL_Z1, 0.70, fd));
    B.add('deck_conc', deck(WELL_X1, RG_X1, WELL_Z0, WELL_Z1, 0.70, fd));
    B.paint = 'metal';
    L.addCollider((RG_X0 + RG_X1) * 0.5, -0.26, (-RG_HZ + WELL_Z0) * 0.5,
      (RG_X1 - RG_X0) * 0.5, 0.26, (WELL_Z0 + RG_HZ) * 0.5, 'concrete', true);
    L.addCollider((RG_X0 + RG_X1) * 0.5, -0.26, (WELL_Z1 + RG_HZ) * 0.5,
      (RG_X1 - RG_X0) * 0.5, 0.26, (RG_HZ - WELL_Z1) * 0.5, 'concrete', true);
    L.addCollider((RG_X0 + WELL_X0) * 0.5, -0.26, 0,
      (WELL_X0 - RG_X0) * 0.5, 0.26, WELL_Z1, 'concrete', true);
    L.addCollider((WELL_X1 + RG_X1) * 0.5, -0.26, 0,
      (RG_X1 - WELL_X1) * 0.5, 0.26, WELL_Z1, 'concrete', true);

    // ---- shell -------------------------------------------------------------
    B.paint = 'wall';
    slotWall(B, L, 'wall_conc', 'x', RG_X0 - 0.60, 1.20, -RG_HZ - 0.8, RG_HZ + 0.8,
      PIT_Y - 0.6, RG_CEIL + 0.8,
      [{ c: 0, hw: 1.10, y0: 0, y1: 2.22 }], 'concrete');
    slotWall(B, L, 'wall_conc', 'x', RG_X1 + 0.55, 1.10, -RG_HZ - 0.8, RG_HZ + 0.8,
      PIT_Y - 0.6, RG_CEIL + 0.8, [], 'concrete');
    slotWall(B, L, 'wall_conc', 'z', -RG_HZ - 0.55, 1.10, RG_X0 - 1.2, RG_X1 + 1.1,
      PIT_Y - 0.6, RG_CEIL + 0.8, [], 'concrete');
    slotWall(B, L, 'wall_conc', 'z', RG_HZ + 0.55, 1.10, RG_X0 - 1.2, RG_X1 + 1.1,
      PIT_Y - 0.6, RG_CEIL + 0.8, [], 'concrete');
    B.paint = 'ceil';
    slab(B, L, 'ceil_conc', RG_X0 - 1.2, RG_X1 + 1.1, -RG_HZ - 1.1, RG_HZ + 1.1,
      RG_CEIL, 0.90, 'concrete');
    // deep coffers across the soffit - an 11 m ceiling with no relief on it
    // photographs as a lid, and this is the top third of two framings
    for (i = 0; i < 12; i++) {
      var cbx = RG_X0 + 1.2 + i * 2.4;
      if (cbx > RG_X1 - 0.8) break;
      B.box('ceil_conc', 0.55, 0.55, RG_HZ * 2, cbx, RG_CEIL - 0.27, 0);
    }
    for (i = 0; i < 8; i++) {
      var cbz = -RG_HZ + 1.8 + i * 3.3;
      if (cbz > RG_HZ - 1.0) break;
      B.box('ceil_conc', RG_X1 - RG_X0, 0.36, 0.42, (RG_X0 + RG_X1) * 0.5, RG_CEIL - 0.18, cbz);
    }
    B.paint = 'metal';

    // ---- the blast portal from the spine ----------------------------------
    B.paint = 'metal';
    B.box('steel', 1.30, 0.18, 2.44, HALL_DOOR_X, 2.30, 0);
    B.box('steel', 1.30, 2.34, 0.20, HALL_DOOR_X, 1.17, -1.20);
    B.box('steel', 1.30, 2.34, 0.20, HALL_DOOR_X, 1.17, 1.20);
    B.paint = 'clad';
    B.dark = 0.10;
    B.boxR('hull_paint', 0.12, 2.16, 2.10, HALL_DOOR_X + 0.85, 1.10, -1.95, 0, 1.38, 0);
    B.dark = 0;
    B.paint = 'metal';
    card(B, CELL.RAD, HALL_DOOR_X + 0.68, 2.55, -1.9, 1.15, 1.15, 'x', 1,
      tint(0xfff4cc, 0.4));
    card(B, CELL.HAZARD, HALL_DOOR_X + 0.68, 0.50, 0, 2.30, 0.55, 'x', 1,
      tint(0xffeeb8, 0.4));

    // ---- the well: pit walls, deck nosing, handrails -----------------------
    B.paint = 'wall';
    slotWall(B, L, 'wall_conc', 'x', WELL_X0 - 0.35, 0.70, WELL_Z0 - 0.4, WELL_Z1 + 0.4,
      PIT_Y - 0.5, DECK_Y, [], 'concrete', true);
    slotWall(B, L, 'wall_conc', 'x', WELL_X1 + 0.35, 0.70, WELL_Z0 - 0.4, WELL_Z1 + 0.4,
      PIT_Y - 0.5, DECK_Y, [], 'concrete', true);
    slotWall(B, L, 'wall_conc', 'z', WELL_Z0 - 0.35, 0.70, WELL_X0 - 0.4, WELL_X1 + 0.4,
      PIT_Y - 0.5, DECK_Y, [], 'concrete', true);
    slotWall(B, L, 'wall_conc', 'z', WELL_Z1 + 0.35, 0.70, WELL_X0 - 0.4, WELL_X1 + 0.4,
      PIT_Y - 0.5, DECK_Y, [], 'concrete', true);
    B.paint = 'metal';
    // the nosing kerb round the well, and the rail on it. This is the strongest
    // foreground element in the hero framing.
    B.paint = 'floor';
    B.box('deck_conc', 0.34, 0.16, WELL_Z1 - WELL_Z0 + 0.7, WELL_X0 - 0.17, 0.08, 0);
    B.box('deck_conc', 0.34, 0.16, WELL_Z1 - WELL_Z0 + 0.7, WELL_X1 + 0.17, 0.08, 0);
    B.box('deck_conc', WELL_X1 - WELL_X0 + 0.7, 0.16, 0.34, (WELL_X0 + WELL_X1) * 0.5, 0.08, WELL_Z0 - 0.17);
    B.box('deck_conc', WELL_X1 - WELL_X0 + 0.7, 0.16, 0.34, (WELL_X0 + WELL_X1) * 0.5, 0.08, WELL_Z1 + 0.17);
    B.paint = 'metal';
    // rails, broken where the bridges and the stair land
    railRun(B, WELL_X0 - 0.15, 0.16, WELL_Z0, WELL_X0 - 0.15, 0.16, STAIR_Z0 - 0.1);
    railRun(B, WELL_X0 - 0.15, 0.16, STAIR_Z1 + 0.1, WELL_X0 - 0.15, 0.16, -BRIDGE_HW_W);
    railRun(B, WELL_X0 - 0.15, 0.16, BRIDGE_HW_W, WELL_X0 - 0.15, 0.16, WELL_Z1);
    railRun(B, WELL_X1 + 0.15, 0.16, WELL_Z0, WELL_X1 + 0.15, 0.16, WELL_Z1);
    railRun(B, WELL_X0, 0.16, WELL_Z0 - 0.15, REAC_CX - BRIDGE_HW_N, 0.16, WELL_Z0 - 0.15);
    railRun(B, REAC_CX + BRIDGE_HW_N, 0.16, WELL_Z0 - 0.15, WELL_X1, 0.16, WELL_Z0 - 0.15);
    railRun(B, WELL_X0, 0.16, WELL_Z1 + 0.15, WELL_X1, 0.16, WELL_Z1 + 0.15);
    L.addCollider(WELL_X0 - 0.2, 0.55, 0, 0.10, 0.55, (WELL_Z1 - WELL_Z0) * 0.5, 'metal');
    L.addCollider(WELL_X1 + 0.2, 0.55, 0, 0.10, 0.55, (WELL_Z1 - WELL_Z0) * 0.5, 'metal');
    L.addCollider((WELL_X0 + WELL_X1) * 0.5, 0.55, WELL_Z1 + 0.2,
      (WELL_X1 - WELL_X0) * 0.5, 0.55, 0.10, 'metal');

    // ---- the lower level: floor and pit dressing ---------------------------
    B.paint = 'floor';
    B.add('deck_conc', deck(WELL_X0, WELL_X1, WELL_Z0, WELL_Z1, 0.70,
      function (x, z) { return reacDist(x, z) < BIO_R + 0.30 ? -999 : pitY(x, z, N); }));
    B.paint = 'metal';
    L.addCollider((WELL_X0 + WELL_X1) * 0.5, PIT_Y - 0.30, 0,
      (WELL_X1 - WELL_X0) * 0.5, 0.30, (WELL_Z1 - WELL_Z0) * 0.5, 'concrete', true);

    // ---- THE VESSEL --------------------------------------------------------
    // The bioshield: a stepped concrete drum with a cast-in cooling collar.
    var bioProf = [
      [BIO_R + 0.36, PIT_Y - 0.30], [BIO_R + 0.36, PIT_Y + 0.55],
      [BIO_R, PIT_Y + 0.92], [BIO_R, -1.35],
      [BIO_R + 0.20, -1.20], [BIO_R + 0.20, -0.42],
      [BIO_R, -0.26], [BIO_R, BIO_TOP - 0.22],
      [BIO_R + 0.26, BIO_TOP - 0.10], [BIO_R + 0.26, BIO_TOP],
      [VES_R + 0.62, BIO_TOP], [VES_R + 0.62, BIO_TOP - 0.16]
    ];
    B.paint = 'wall';
    B.add('wall_conc', revolveY(bioProf, REAC_CX, REAC_CZ, 44, 0, Math.PI * 2, false));
    B.paint = 'metal';
    // the vessel: welded courses with proud girth seams, a nozzle belt, and the
    // torispherical head
    var vesProf = [
      [VES_R + 0.62, BIO_TOP - 0.16], [VES_R + 0.62, BIO_TOP + 0.10],
      [VES_R, BIO_TOP + 0.30], [VES_R, 2.30],
      [VES_R + 0.16, 2.42], [VES_R + 0.16, 2.86],
      [VES_R, 2.98], [VES_R, 4.30],
      [VES_R + 0.14, 4.40], [VES_R + 0.14, 4.72],
      [VES_R, 4.82], [VES_R, VES_TOP - 0.30],
      [VES_R + 0.22, VES_TOP - 0.18], [VES_R + 0.22, VES_TOP]
    ];
    for (i = 0; i <= 9; i++) {
      var a = i / 9 * Math.PI * 0.5;
      vesProf.push([VES_R * Math.cos(a), VES_TOP + (DOME_TOP - VES_TOP) * Math.sin(a)]);
    }
    // STEEL, not painted plant. It was hull_paint (the library's paint_blue,
    // metal 0.9) for one round and the vessel came back as a pale blue drum with
    // a single mirror-bright vertical column down it: a metal-0.9 dielectric on a
    // 4 m cylinder returns one lamp as a specular bar, and it took the frame's
    // whole highlight range cool - measured grade_split -0.0066 against a level
    // briefed as grey and red. structural_steel is metal 0.06 and warm grey, so
    // the barrel shades instead of mirroring.
    B.paint = 'clad';
    B.dark = 0.10;
    B.add('steel', revolveY(vesProf, REAC_CX, REAC_CZ, 44, 0, Math.PI * 2, false));
    B.dark = 0;
    B.paint = 'metal';
    // vertical stiffeners on the barrel so a 4 m cylinder is not a smooth tube
    for (i = 0; i < 22; i++) {
      var va = i / 22 * Math.PI * 2;
      B.boxR('steel', 0.09, 3.30, 0.17,
        REAC_CX + Math.cos(va) * (VES_R + 0.05), 3.65,
        REAC_CZ + Math.sin(va) * (VES_R + 0.05), 0, -va, 0);
    }
    // the control-rod drive stalks and the service bridge over them
    B.paint = 'metal';
    for (i = 0; i < 26; i++) {
      var sa = (i / 26) * Math.PI * 2 + 0.12;
      var sr = (i % 3 === 0) ? 0.9 : ((i % 3 === 1) ? 1.9 : 2.8);
      var sx2 = REAC_CX + Math.cos(sa) * sr, sz2 = REAC_CZ + Math.sin(sa) * sr;
      var sh = STALK_TOP - DOME_TOP - (sr * 0.10);
      B.cyl('steel', 0.085, 0.10, sh, sx2,
        DOME_TOP - 0.25 + sh * 0.5 - Math.pow(sr / 3.2, 2) * 0.9, sz2, 0, 0, 0, 8);
      B.box('rust_metal', 0.18, 0.10, 0.18, sx2,
        DOME_TOP - 0.25 + sh - Math.pow(sr / 3.2, 2) * 0.9, sz2);
    }
    B.paint = 'plate';
    B.box('plate_steel', 1.40, 0.05, 7.20, REAC_CX, STALK_TOP + 0.10, REAC_CZ);
    B.paint = 'metal';
    railRun(B, REAC_CX - 0.70, STALK_TOP + 0.12, REAC_CZ - 3.6,
      REAC_CX - 0.70, STALK_TOP + 0.12, REAC_CZ + 3.6, 0.95, false);
    railRun(B, REAC_CX + 0.70, STALK_TOP + 0.12, REAC_CZ - 3.6,
      REAC_CX + 0.70, STALK_TOP + 0.12, REAC_CZ + 3.6, 0.95, false);
    // colliders: a polygon ring plus a solid core, so the occupancy bake sees a
    // reactor and not a hollow shell it can shoot rays straight through
    for (i = 0; i < 12; i++) {
      var ca = i / 12 * Math.PI * 2;
      _e1.set(0, -ca, 0, 'YXZ');
      L.addCollider(REAC_CX + Math.cos(ca) * (BIO_R * 0.72),
        (PIT_Y + DOME_TOP) * 0.5, REAC_CZ + Math.sin(ca) * (BIO_R * 0.72),
        BIO_R * 0.42, (DOME_TOP - PIT_Y) * 0.5, BIO_R * 0.30, 'concrete', false,
        new THREE.Euler(0, -ca, 0, 'YXZ'));
    }
    L.addCollider(REAC_CX, (PIT_Y + DOME_TOP) * 0.5, REAC_CZ,
      BIO_R * 0.62, (DOME_TOP - PIT_Y) * 0.5, BIO_R * 0.62, 'concrete');
    // the bioshield's top annulus is a real ledge - give it a rail
    railRunRing(B, REAC_CX, REAC_CZ, VES_R + 0.62, BIO_TOP, 22, 1.02);

    // ---- the operating platform and the bridges ----------------------------
    B.paint = 'grate';
    B.add('grate', annulus(REAC_CX, REAC_CZ, PLAT_R0, PLAT_R1, DECK_Y, 40, 3, null));
    B.paint = 'metal';
    // its supporting ring beam and columns down to the pit floor
    for (i = 0; i < 16; i++) {
      var pa = i / 16 * Math.PI * 2;
      var pxx = REAC_CX + Math.cos(pa) * (PLAT_R1 - 0.30);
      var pzz = REAC_CZ + Math.sin(pa) * (PLAT_R1 - 0.30);
      B.box('steel', 0.16, 4.55, 0.16, pxx, PIT_Y + 2.30, pzz);
      B.boxR('steel', 0.90, 0.26, 0.14, pxx, DECK_Y - 0.22, pzz, 0, -pa + Math.PI * 0.5, 0);
    }
    for (i = 0; i < 40; i++) {
      var ba0 = i / 40 * Math.PI * 2, ba1 = (i + 1) / 40 * Math.PI * 2;
      B.strut('steel',
        REAC_CX + Math.cos(ba0) * (PLAT_R1 - 0.12), DECK_Y - 0.14, REAC_CZ + Math.sin(ba0) * (PLAT_R1 - 0.12),
        REAC_CX + Math.cos(ba1) * (PLAT_R1 - 0.12), DECK_Y - 0.14, REAC_CZ + Math.sin(ba1) * (PLAT_R1 - 0.12),
        0.10, 0.24);
    }
    railRunRing(B, REAC_CX, REAC_CZ, PLAT_R1 - 0.06, DECK_Y, 40, 1.05, [
      { a0: Math.PI - 0.44, a1: Math.PI + 0.44 },      // the west bridge
      { a0: -Math.PI * 0.5 - 0.30, a1: -Math.PI * 0.5 + 0.30 }  // the north bridge
    ]);
    railRunRing(B, REAC_CX, REAC_CZ, PLAT_R0 + 0.06, DECK_Y, 32, 1.05, null);

    // the WEST BRIDGE: 5.2 m wide, walkway south, pipe rack north
    B.paint = 'grate';
    B.add('grate', deck(WELL_X0 - 0.2, REAC_CX - PLAT_R1 + 0.35, -BRIDGE_HW_W, 0.60,
      0.55, function () { return DECK_Y; }));
    B.paint = 'plate';
    B.add('plate_steel', deck(WELL_X0 - 0.2, REAC_CX - PLAT_R1 + 0.35, 0.60, BRIDGE_HW_W,
      0.60, function () { return DECK_Y; }));
    B.paint = 'metal';
    for (i = 0; i < 4; i++) {
      var bgz = -BRIDGE_HW_W + i * (BRIDGE_HW_W * 2 / 3);
      B.strut('steel', WELL_X0 - 0.2, DECK_Y - 0.24, bgz,
        REAC_CX - PLAT_R1 + 0.35, DECK_Y - 0.24, bgz, 0.16, 0.42);
    }
    railRun(B, WELL_X0 - 0.2, DECK_Y, -BRIDGE_HW_W, REAC_CX - PLAT_R1 + 0.35, DECK_Y, -BRIDGE_HW_W);
    railRun(B, WELL_X0 - 0.2, DECK_Y, BRIDGE_HW_W, REAC_CX - PLAT_R1 + 0.35, DECK_Y, BRIDGE_HW_W);
    L.addCollider((WELL_X0 - 0.2 + REAC_CX - PLAT_R1 + 0.35) * 0.5, DECK_Y - 0.14,
      0, (REAC_CX - PLAT_R1 + 0.55 - WELL_X0) * 0.5, 0.14, BRIDGE_HW_W, 'metal', true);

    // the NORTH BRIDGE
    B.paint = 'grate';
    B.add('grate', deck(REAC_CX - BRIDGE_HW_N, REAC_CX + BRIDGE_HW_N,
      WELL_Z0 - 0.2, REAC_CZ - PLAT_R1 + 0.35, 0.55, function () { return DECK_Y; }));
    B.paint = 'metal';
    for (i = 0; i < 3; i++) {
      var bgx = REAC_CX - BRIDGE_HW_N + i * BRIDGE_HW_N;
      B.strut('steel', bgx, DECK_Y - 0.24, WELL_Z0 - 0.2,
        bgx, DECK_Y - 0.24, REAC_CZ - PLAT_R1 + 0.35, 0.14, 0.38);
    }
    railRun(B, REAC_CX - BRIDGE_HW_N, DECK_Y, WELL_Z0 - 0.2,
      REAC_CX - BRIDGE_HW_N, DECK_Y, REAC_CZ - PLAT_R1 + 0.35);
    railRun(B, REAC_CX + BRIDGE_HW_N, DECK_Y, WELL_Z0 - 0.2,
      REAC_CX + BRIDGE_HW_N, DECK_Y, REAC_CZ - PLAT_R1 + 0.35);
    L.addCollider(REAC_CX, DECK_Y - 0.14, (WELL_Z0 - 0.2 + REAC_CZ - PLAT_R1 + 0.35) * 0.5,
      BRIDGE_HW_N, 0.14, (REAC_CZ - PLAT_R1 + 0.55 - WELL_Z0) * 0.5, 'metal', true);

    // ---- THE COOLANT LINES -------------------------------------------------
    // Four 0.42 m lines on the bridge's north rack, running from the west wall
    // into the bioshield, and a bundle of six overhead at 3.1 m. Insulated, so
    // they are lagging-clad rather than bare steel, and every one of them
    // converges on the vessel: this is the frame's leading line.
    var pipeX0 = RG_X0 - 0.1, pipeX1 = REAC_CX - BIO_R - 0.05;
    for (i = 0; i < 4; i++) {
      var pz2 = 0.95 + i * 0.48;
      B.paint = 'clad';
      B.pipe('steel', pipeX0, 0.78, pz2, pipeX1, 0.78, pz2, 0.21, 12);
      B.paint = 'metal';
      for (k = 0; k < 5; k++) {
        var fx3 = pipeX0 + 1.0 + k * ((pipeX1 - pipeX0 - 1.6) / 4);
        B.cyl('rust_metal', 0.26, 0.26, 0.07, fx3, 0.78, pz2, 0, 0, Math.PI * 0.5, 12);
      }
      // the saddle it sits in
      for (k = 0; k < 4; k++) {
        var sxx = pipeX0 + 1.6 + k * ((pipeX1 - pipeX0 - 2.4) / 3);
        B.box('steel', 0.10, 0.56, 0.10, sxx, 0.28, pz2);
      }
    }
    B.paint = 'metal';
    B.strut('steel', pipeX0, 0.50, 0.80, pipeX1, 0.50, 0.80, 0.10, 0.30);
    B.strut('steel', pipeX0, 0.50, 2.50, pipeX1, 0.50, 2.50, 0.10, 0.30);
    // The overhead bundle, at 5.3 m. It ran at 3.05 for one round and, because
    // it starts at the hall wall BEHIND the eye, six 0.31 m lines passed 1.4 m
    // over the camera and filled the top half of the signature framing with
    // tubes. Height is what fixes that, not moving them: they still have to
    // start at the wall, and they still have to converge on the vessel.
    for (i = 0; i < 5; i++) {
      var oz = -1.70 + i * 0.78;
      var oy = 5.30 + (i % 2) * 0.32;
      B.paint = 'clad';
      B.pipe('steel', RG_X0 - 0.1, oy, oz, REAC_CX - BIO_R - 0.3, oy, oz, 0.130, 10);
      B.paint = 'metal';
    }
    for (i = 0; i < 5; i++) {
      var hx2 = RG_X0 + 1.4 + i * 1.8;
      B.box('steel', 0.10, 0.14, 4.6, hx2, 5.92, 0.30);
      B.pipe('steel', hx2, 5.98, -1.9, hx2, RG_CEIL - 0.4, -1.9, 0.020, 6);
      B.pipe('steel', hx2, 5.98, 2.5, hx2, RG_CEIL - 0.4, 2.5, 0.020, 6);
    }
    // where they enter the shield: four nozzle blocks
    for (i = 0; i < 4; i++) {
      B.paint = 'metal';
      B.cyl('rust_metal', 0.34, 0.34, 0.45, REAC_CX - BIO_R + 0.10, 0.78, 0.95 + i * 0.48,
        0, 0, Math.PI * 0.5, 12);
    }

    // ---- the pit stair -----------------------------------------------------
    var nSt = 22, stRise = (DECK_Y - PIT_Y) / nSt, stGo = (STAIR_Z1 - STAIR_Z0) / nSt;
    B.paint = 'plate';
    for (i = 0; i < nSt; i++) {
      var tz = STAIR_Z1 - (i + 0.5) * stGo;
      var ty2 = DECK_Y - (i + 1) * stRise;
      B.box('plate_steel', STAIR_X1 - STAIR_X0, 0.045, stGo + 0.02,
        (STAIR_X0 + STAIR_X1) * 0.5, ty2, tz);
      B.box('rust_metal', STAIR_X1 - STAIR_X0, stRise, 0.030,
        (STAIR_X0 + STAIR_X1) * 0.5, ty2 + stRise * 0.5, tz - stGo * 0.5);
    }
    B.paint = 'metal';
    B.strut('steel', STAIR_X0 + 0.06, DECK_Y - 0.18, STAIR_Z1, STAIR_X0 + 0.06, PIT_Y - 0.18, STAIR_Z0, 0.10, 0.34);
    B.strut('steel', STAIR_X1 - 0.06, DECK_Y - 0.18, STAIR_Z1, STAIR_X1 - 0.06, PIT_Y - 0.18, STAIR_Z0, 0.10, 0.34);
    railRun(B, STAIR_X1 - 0.05, DECK_Y, STAIR_Z1, STAIR_X1 - 0.05, PIT_Y, STAIR_Z0, 1.02, false);
    railRun(B, STAIR_X0 + 0.05, DECK_Y, STAIR_Z1, STAIR_X0 + 0.05, PIT_Y, STAIR_Z0, 1.02, false);
    L.addCollider((STAIR_X0 + STAIR_X1) * 0.5, (DECK_Y + PIT_Y) * 0.5 - 0.55,
      (STAIR_Z0 + STAIR_Z1) * 0.5, (STAIR_X1 - STAIR_X0) * 0.5, 0.10,
      (STAIR_Z1 - STAIR_Z0) * 0.5, 'metal', true,
      new THREE.Euler(Math.atan2(DECK_Y - PIT_Y, STAIR_Z1 - STAIR_Z0), 0, 0, 'YXZ'));

    // ---- the gantry ring, its access stair and bridge ----------------------
    B.paint = 'grate';
    B.add('grate', annulus(REAC_CX, REAC_CZ, GANT_R0, GANT_R1, GANT_Y, 40, 3, null));
    B.paint = 'metal';
    for (i = 0; i < 16; i++) {
      var ga = i / 16 * Math.PI * 2;
      var gr = PLAT_R1 - 0.30;
      var gxx = REAC_CX + Math.cos(ga) * gr;
      var gzz = REAC_CZ + Math.sin(ga) * gr;
      B.box('steel', 0.15, GANT_Y - DECK_Y, 0.15, gxx, (GANT_Y + DECK_Y) * 0.5, gzz);
      // the bracket that carries the ring out past the column
      B.strut('steel', gxx, GANT_Y - 0.14, gzz,
        REAC_CX + Math.cos(ga) * (GANT_R1 - 0.15), GANT_Y - 0.14,
        REAC_CZ + Math.sin(ga) * (GANT_R1 - 0.15), 0.10, 0.22);
      B.strut('steel', gxx, GANT_Y - 1.05, gzz,
        REAC_CX + Math.cos(ga) * (GANT_R1 - 0.20), GANT_Y - 0.30,
        REAC_CZ + Math.sin(ga) * (GANT_R1 - 0.20), 0.07, 0.14);
    }
    railRunRing(B, REAC_CX, REAC_CZ, GANT_R1 - 0.06, GANT_Y, 40, 1.05,
      [{ a0: -0.58, a1: 0.10 }]);
    railRunRing(B, REAC_CX, REAC_CZ, GANT_R0 + 0.06, GANT_Y, 32, 1.05, null);
    L.addCollider(REAC_CX, GANT_Y - 0.10, REAC_CZ + (GANT_R0 + GANT_R1) * 0.5,
      (GANT_R1 - GANT_R0) * 1.4, 0.10, (GANT_R1 - GANT_R0) * 0.5, 'metal', true);
    L.addCollider(REAC_CX, GANT_Y - 0.10, REAC_CZ - (GANT_R0 + GANT_R1) * 0.5,
      (GANT_R1 - GANT_R0) * 1.4, 0.10, (GANT_R1 - GANT_R0) * 0.5, 'metal', true);
    L.addCollider(REAC_CX + (GANT_R0 + GANT_R1) * 0.5, GANT_Y - 0.10, REAC_CZ,
      (GANT_R1 - GANT_R0) * 0.5, 0.10, (GANT_R1 - GANT_R0) * 1.4, 'metal', true);
    L.addCollider(REAC_CX - (GANT_R0 + GANT_R1) * 0.5, GANT_Y - 0.10, REAC_CZ,
      (GANT_R1 - GANT_R0) * 0.5, 0.10, (GANT_R1 - GANT_R0) * 1.4, 'metal', true);

    // the access stair, up the east deck band, and the bridge onto the ring
    var asX = RG_X1 - 2.2, asZ0 = -3.60, asZ1 = 4.20, asN = 26;
    var asRise = GANT_Y / asN, asGo = (asZ1 - asZ0) / asN;
    B.paint = 'plate';
    for (i = 0; i < asN; i++) {
      var az2 = asZ1 - (i + 0.5) * asGo;
      var ay2 = DECK_Y + (i + 1) * asRise;
      B.box('plate_steel', 1.25, 0.045, asGo + 0.02, asX, ay2, az2);
      B.box('rust_metal', 1.25, asRise, 0.030, asX, ay2 - asRise * 0.5, az2 - asGo * 0.5);
    }
    B.paint = 'metal';
    B.strut('steel', asX - 0.60, DECK_Y - 0.18, asZ1, asX - 0.60, GANT_Y - 0.18, asZ0, 0.10, 0.34);
    B.strut('steel', asX + 0.60, DECK_Y - 0.18, asZ1, asX + 0.60, GANT_Y - 0.18, asZ0, 0.10, 0.34);
    railRun(B, asX - 0.62, DECK_Y, asZ1, asX - 0.62, GANT_Y, asZ0, 1.02, false);
    railRun(B, asX + 0.62, DECK_Y, asZ1, asX + 0.62, GANT_Y, asZ0, 1.02, false);
    L.addCollider(asX, GANT_Y * 0.5 - 0.55, (asZ0 + asZ1) * 0.5, 0.62, 0.10,
      (asZ1 - asZ0) * 0.5, 'metal', true,
      new THREE.Euler(-Math.atan2(GANT_Y, asZ1 - asZ0), 0, 0, 'YXZ'));
    B.paint = 'grate';
    B.add('grate', deck(REAC_CX + 7.0, asX + 0.62, asZ0 - 0.65, asZ0 + 0.65, 0.5,
      function () { return GANT_Y; }));
    B.paint = 'metal';
    railRun(B, REAC_CX + 7.0, GANT_Y, asZ0 - 0.65, asX + 0.62, GANT_Y, asZ0 - 0.65);
    railRun(B, REAC_CX + 7.0, GANT_Y, asZ0 + 0.65, asX + 0.62, GANT_Y, asZ0 + 0.65);
    B.strut('steel', REAC_CX + 7.0, GANT_Y - 0.20, asZ0, asX + 0.62, GANT_Y - 0.20, asZ0, 0.14, 0.36);
    L.addCollider((REAC_CX + 7.0 + asX) * 0.5, GANT_Y - 0.10, asZ0,
      (asX - REAC_CX - 7.0) * 0.5 + 0.4, 0.10, 0.65, 'metal', true);

    // ---- the crane ---------------------------------------------------------
    for (s = -1; s <= 1; s += 2) {
      var cz3 = s * 10.90;
      B.paint = 'metal';
      B.box('steel', RG_X1 - RG_X0 + 1.6, 0.62, 0.34, (RG_X0 + RG_X1) * 0.5, CRANE_Y - 0.31, cz3);
      B.box('steel', RG_X1 - RG_X0 + 1.6, 0.10, 0.16, (RG_X0 + RG_X1) * 0.5, CRANE_Y + 0.05, cz3);
      // corbels off the wall
      for (i = 0; i < 8; i++) {
        var kx = RG_X0 + 1.6 + i * 3.6;
        if (kx > RG_X1 - 0.8) break;
        B.paint = 'wall';
        B.box('wall_conc', 0.70, 0.90, 1.20, kx, CRANE_Y - 0.95, s * (RG_HZ - 0.55));
        B.paint = 'metal';
        B.strut('steel', kx, CRANE_Y - 0.62, s * (RG_HZ - 0.1), kx, CRANE_Y - 0.62, cz3, 0.10, 0.24);
      }
    }
    // the bridge girder, its end carriages, the trolley and the hook block
    B.paint = 'clad';
    B.dark = 0.10;
    B.box('hull_paint', 1.05, 1.35, 22.6, CRANE_X, CRANE_Y + 0.78, 0);
    B.dark = 0;
    B.paint = 'metal';
    for (i = 0; i < 14; i++) {
      var gz3 = -10.4 + i * 1.6;
      B.box('steel', 1.12, 0.10, 0.14, CRANE_X, CRANE_Y + 0.16, gz3);
    }
    for (s = -1; s <= 1; s += 2) {
      B.paint = 'clad';
      B.box('hull_paint', 1.90, 0.70, 1.10, CRANE_X, CRANE_Y + 0.22, s * 10.90);
      B.paint = 'metal';
      B.cyl('steel', 0.30, 0.30, 0.16, CRANE_X - 0.65, CRANE_Y - 0.02, s * 10.90, 0, 0, Math.PI * 0.5, 12);
      B.cyl('steel', 0.30, 0.30, 0.16, CRANE_X + 0.65, CRANE_Y - 0.02, s * 10.90, 0, 0, Math.PI * 0.5, 12);
    }
    B.paint = 'clad';
    B.dark = 0.06;
    B.box('hull_paint', 1.35, 0.95, 2.20, CRANE_X, CRANE_Y + 1.90, 3.40);
    B.dark = 0;
    B.paint = 'metal';
    B.cyl('steel', 0.42, 0.42, 1.30, CRANE_X, CRANE_Y + 1.95, 3.40, 0, 0, Math.PI * 0.5, 14);
    for (i = -1; i <= 1; i += 2) {
      B.pipe('steel', CRANE_X + i * 0.24, CRANE_Y + 1.62, 3.40,
        CRANE_X + i * 0.24, GANT_Y + 0.55, 3.40, 0.018, 5);
    }
    B.paint = 'clad';
    B.box('hull_paint', 0.62, 0.52, 0.62, CRANE_X, GANT_Y + 0.30, 3.40);
    B.paint = 'metal';
    B.cyl('steel', 0.13, 0.06, 0.62, CRANE_X, GANT_Y - 0.22, 3.40, 0, 0, 0, 8);
    L.addCollider(CRANE_X, CRANE_Y + 0.78, 0, 0.55, 0.70, 11.4, 'metal');

    // ---- the two heat exchangers on the north band -------------------------
    var HX = [[19.5, 11.30], [28.9, 11.30], [16.4, -11.30]];
    for (i = 0; i < HX.length; i++) {
      var hxx = HX[i][0], hzz = HX[i][1];
      var hTop = 7.20 - i * 0.6;
      B.paint = 'clad';
      B.dark = 0.08;
      B.add('steel', revolveY([
        [1.55, 0.30], [1.55, hTop - 0.9],
        [1.44, hTop - 0.30], [1.10, hTop], [0.55, hTop + 0.30], [0, hTop + 0.42]
      ], hxx, hzz, 24, 0, Math.PI * 2, false));
      B.dark = 0;
      B.paint = 'metal';
      // the skirt and its holding-down bolts
      B.cyl('steel', 1.62, 1.72, 0.32, hxx, 0.16, hzz, 0, 0, 0, 24);
      for (k = 0; k < 10; k++) {
        var ha2 = k / 10 * Math.PI * 2;
        B.box('rust_metal', 0.14, 0.10, 0.14, hxx + Math.cos(ha2) * 1.80, 0.06,
          hzz + Math.sin(ha2) * 1.80);
      }
      // girth bands and a nozzle
      for (k = 0; k < 4; k++) {
        B.cyl('rust_metal', 1.60, 1.60, 0.10, hxx, 1.1 + k * 1.6, hzz, 0, 0, 0, 24);
      }
      B.paint = 'clad';
      B.pipe('steel', hxx, 2.35, hzz, hxx, 2.35, hzz - 3.2, 0.20, 10);
      B.paint = 'metal';
      L.addCollider(hxx, (hTop + 0.3) * 0.5, hzz, 1.62, (hTop + 0.3) * 0.5, 1.62, 'metal');
      card(B, CELL.STENCIL, hxx, 3.6, hzz - 1.60, 1.5, 0.75, 'z', -1, tint(0xe4e8dc, 0.4));
      card(B, CELL.WEEP, hxx + 1.2, 2.2, hzz - 1.05, 1.2, 2.6, 'z', -1, tint(0xc08858, 0.75));
    }

    // ---- floor markings and dressing --------------------------------------
    B.paint = 'line';
    B.box('paint_line', RG_X1 - RG_X0, 0.014, 0.14, (RG_X0 + RG_X1) * 0.5, 0.013, WELL_Z1 + 1.55);
    B.box('paint_line', RG_X1 - RG_X0, 0.014, 0.14, (RG_X0 + RG_X1) * 0.5, 0.013, WELL_Z0 - 1.55);
    B.box('paint_line', 0.14, 0.014, WELL_Z1 * 2, RG_X0 + 1.70, 0.013, 0);
    B.paint = 'metal';
    for (i = 0; i < 10; i++) {
      card(B, CELL.HAZARD, RG_X0 + 2.6 + i * 2.8, 0.020, WELL_Z1 + 0.55, 2.6, 0.95,
        'y', 1, tint(0xffeeb8, 0.45), Math.PI * 0.5);
    }
    card(B, CELL.NUM, RG_X0 + 3.4, 0.021, -5.0, 2.6, 2.6, 'y', 1, tint(0xe6e8dc, 0.4));
    card(B, CELL.RAD, RG_X0 - 0.01, 4.2, -6.4, 2.4, 2.4, 'x', 1, tint(0xfff4cc, 0.4));
    card(B, CELL.NAME, RG_X0 - 0.01, 4.4, 5.6, 3.0, 3.0, 'x', 1, tint(0xe8ece0, 0.4));
    for (i = 0; i < 20; i++) {
      var ws2 = rng.bool() ? 1 : -1;
      card(B, rng.pick([CELL.STAIN, CELL.PEEL, CELL.WEEP, CELL.SOOT, CELL.TAG]),
        rng.range(RG_X0 + 1.5, RG_X1 - 1.5), rng.range(0.8, 7.5),
        ws2 * (RG_HZ - 0.02), rng.range(2.2, 4.6), rng.range(2.6, 5.0),
        'z', -ws2, null);
    }
    for (i = 0; i < 8; i++) {
      card(B, CELL.DUST, rng.range(RG_X0 + 2, RG_X1 - 2),
        0.018, rng.bool() ? rng.range(WELL_Z1 + 0.4, RG_HZ - 0.6) : rng.range(-RG_HZ + 0.6, WELL_Z0 - 0.4),
        rng.range(4, 8), rng.range(3, 5), 'y', 1, null);
    }
    // spalled concrete along the well kerb, and a fallen coffer
    B.paint = 'rubble';
    for (i = 0; i < 26; i++) {
      var rbx = rng.range(RG_X0 + 1.0, RG_X1 - 1.0);
      var rbz = rng.bool() ? rng.range(WELL_Z1 + 0.3, RG_HZ - 0.5)
        : rng.range(-RG_HZ + 0.5, WELL_Z0 - 0.3);
      var rsz = rng.range(0.14, 0.62);
      B.boxR('rubble', rsz * rng.range(0.7, 1.6), rsz * rng.range(0.3, 0.8),
        rsz * rng.range(0.7, 1.5), rbx, deckY(rbx, rbz, N) + rsz * 0.22, rbz,
        rng.range(-0.6, 0.6), rng.range(0, 3.14), rng.range(-0.6, 0.6));
    }
    B.paint = 'metal';
  }

  // A handrail following a circle, with optional angular gaps where a bridge or
  // a stair lands. Gaps matter: a continuous rail across an access opening reads
  // as a cage and, worse, tells the player the route is closed.
  function railRunRing(B, cx, cz, r, y, segs, h, gaps) {
    function gapped(a) {
      if (!gaps) return false;
      for (var q = 0; q < gaps.length; q++) {
        var g0 = gaps[q].a0, g1 = gaps[q].a1;
        var aa = a;
        while (aa < g0 - Math.PI) aa += Math.PI * 2;
        while (aa > g0 + Math.PI) aa -= Math.PI * 2;
        if (aa >= g0 && aa <= g1) return true;
      }
      return false;
    }
    B.paint = 'metal';
    for (var i = 0; i < segs; i++) {
      var a0 = i / segs * Math.PI * 2, a1 = (i + 1) / segs * Math.PI * 2;
      var am = (a0 + a1) * 0.5;
      if (gapped(am)) continue;
      var x0 = cx + Math.cos(a0) * r, z0 = cz + Math.sin(a0) * r;
      var x1 = cx + Math.cos(a1) * r, z1 = cz + Math.sin(a1) * r;
      B.pipe('steel', x0, y + h, z0, x1, y + h, z1, 0.024, 6);
      B.pipe('steel', x0, y + h * 0.55, z0, x1, y + h * 0.55, z1, 0.019, 6);
      if (i % 3 === 0) B.box('steel', 0.045, h, 0.045, x0, y + h * 0.5, z0);
      B.paint = 'plate';
      B.strut('plate_steel', x0, y + 0.055, z0, x1, y + 0.055, z1, 0.020, 0.11);
      B.paint = 'metal';
    }
  }

  // ===========================================================================
  // THE FLOOD.
  //
  // 58 cm of standing water over the whole lower level. Authored as a WET FLOOR
  // through materials.js's vertex wear contract rather than as a water body -
  // see the file header. The surface carries real relief (a long swell plus a
  // fine chop) so a strip light 8 m away becomes a metre of sheen instead of one
  // hot texel, and every emergency strip lays an additive glint card under it.
  // ===========================================================================
  function buildWater(L, B, rng, N) {
    var i;
    B.paint = 'water';
    B.add('flood', deck(WELL_X0 + 0.05, WELL_X1 - 0.05, WELL_Z0 + 0.05, WELL_Z1 - 0.05, 0.55,
      function (x, z) {
        if (reacDist(x, z) < BIO_R + 0.34) return -999;
        var w = N.fbm2(x * 0.55 + 4.2, z * 0.55 - 2.7, 3) * 0.5 + 0.5;
        var w2 = N.fbm2(x * 2.6 - 1.1, z * 2.6 + 3.3, 2) * 0.5 + 0.5;
        return WATER_Y + (w - 0.5) * 0.020 + (w2 - 0.5) * 0.008;
      }));
    B.paint = 'metal';
    L.waterPlane = { y: WATER_Y, x0: WELL_X0, x1: WELL_X1, z0: WELL_Z0, z1: WELL_Z1 };
    for (i = 0; i < 6; i++) {
      L.wetPatches.push({ x: rng.range(WELL_X0 + 2, WELL_X1 - 2),
        z: rng.range(WELL_Z0 + 2, WELL_Z1 - 2), r: rng.range(1.4, 3.2) });
    }

    // things standing in it: pumps, valve stations, a fallen section of duct
    B.paint = 'metal';
    for (i = 0; i < 5; i++) {
      var px = [16.6, 31.4, 24.0, 18.4, 30.2][i];
      var pz = [-6.6, 5.4, 7.9, 7.6, -7.4][i];
      B.paint = 'clad';
      B.dark = 0.16;
      B.box('hull_paint', 1.30, 1.05, 0.90, px, PIT_Y + 0.52, pz);
      B.dark = 0;
      B.paint = 'metal';
      B.cyl('rust_metal', 0.34, 0.34, 0.95, px + 0.45, PIT_Y + 1.30, pz, 0, 0, 0, 12);
      B.pipe('rust_metal', px + 0.45, PIT_Y + 1.72, pz, px + 0.45, PIT_Y + 1.72, pz + 1.8, 0.15, 10);
      B.pipe('rust_metal', px + 0.45, PIT_Y + 1.72, pz + 1.8, px + 0.45, DECK_Y - 0.45, pz + 1.8, 0.15, 10);
      // a handwheel, because a valve without one is a cylinder
      B.cyl('rust_metal', 0.30, 0.30, 0.045, px + 0.45, PIT_Y + 1.86, pz, 0, 0, 0, 14);
      B.cyl('rust_metal', 0.06, 0.06, 0.30, px + 0.45, PIT_Y + 1.86, pz, 0, 0, 0, 8);
      L.addCollider(px, PIT_Y + 0.52, pz, 0.65, 0.52, 0.45, 'metal');
    }
    // the ring main round the pit, half submerged
    for (i = 0; i < 2; i++) {
      var pyy = PIT_Y + 0.55 + i * 0.62;
      B.pipe('rust_metal', WELL_X0 + 0.6, pyy, WELL_Z0 + 0.75 + i * 0.4,
        WELL_X1 - 0.6, pyy, WELL_Z0 + 0.75 + i * 0.4, 0.14, 10);
      B.pipe('rust_metal', WELL_X0 + 0.6, pyy, WELL_Z1 - 0.75 - i * 0.4,
        WELL_X1 - 0.6, pyy, WELL_Z1 - 0.75 - i * 0.4, 0.14, 10);
      B.pipe('rust_metal', WELL_X0 + 0.75 + i * 0.4, pyy, WELL_Z0 + 0.6,
        WELL_X0 + 0.75 + i * 0.4, pyy, WELL_Z1 - 0.6, 0.14, 10);
      B.pipe('rust_metal', WELL_X1 - 0.75 - i * 0.4, pyy, WELL_Z0 + 0.6,
        WELL_X1 - 0.75 - i * 0.4, pyy, WELL_Z1 - 0.6, 0.14, 10);
    }
    // the fallen duct: the one diagonal in a hall of orthogonals
    B.paint = 'clad';
    B.boxR('hull_paint', 4.60, 0.60, 0.70, 19.0, PIT_Y + 0.95, -7.4, 0.0, 0.36, -0.34);
    B.paint = 'metal';
    L.addCollider(19.0, PIT_Y + 0.95, -7.4, 2.3, 0.35, 0.6, 'metal', false,
      new THREE.Euler(0, 0.36, -0.34, 'YXZ'));
  }

  // ============================================================== THE LIGHTS ==
  // Every fitting is built TWICE: as HOUSING, which is ordinary merged geometry
  // and takes shadow like anything else, and as an EMITTER, which is one
  // instance in a single InstancedMesh carrying its own per-instance colour.
  // The split is what buys independent failure - forty diffusers sharing one
  // emissive material gutter in unison, and a whole facility flickering on the
  // same beat reads as a screen effect rather than as a dying building.
  function emitBox(L, x, y, z, sx, sy, sz, ry, colHex, gain, kind, rz) {
    var m = new THREE.Matrix4();
    _e1.set(0, ry || 0, rz || 0, 'YXZ');
    m.compose(new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(_e1),
      new THREE.Vector3(sx, sy, sz));
    L.emitters.push({
      m: m, col: new THREE.Color().setHex(colHex, THREE.SRGBColorSpace),
      gain: gain, kind: kind || 'steady', phase: L.rng.range(0, 100)
    });
    return L.emitters.length - 1;
  }

  // A twin-tube fluorescent in a sheet-steel channel. `state` is
  // 'lit' | 'dying' | 'dead'. The dead ones matter as much as the lit ones: the
  // darkness between sources IS the level, and a fitting you can see is not
  // working is what makes it read as failure rather than as art direction.
  function batten(L, B, x, y, z, len, ry, state, hang) {
    B.paint = 'clad';
    B.dark = 0.10;
    B.boxR('hull_paint', len, 0.115, 0.24, x, y, z, 0, ry, 0);
    B.dark = 0;
    B.paint = 'metal';
    B.boxR('steel', 0.06, 0.15, 0.26, x - Math.cos(ry) * len * 0.5, y, z + Math.sin(ry) * len * 0.5, 0, ry, 0);
    B.boxR('steel', 0.06, 0.15, 0.26, x + Math.cos(ry) * len * 0.5, y, z - Math.sin(ry) * len * 0.5, 0, ry, 0);
    // the wire guard a facility fitting always has
    for (var k = 0; k < 5; k++) {
      var t = -0.5 + k * 0.25;
      B.boxR('steel', 0.016, 0.10, 0.28, x + Math.cos(ry) * len * t, y - 0.06,
        z - Math.sin(ry) * len * t, 0, ry, 0);
    }
    if (hang) {
      B.pipe('steel', x - Math.cos(ry) * len * 0.32, y + 0.055, z + Math.sin(ry) * len * 0.32,
        x - Math.cos(ry) * len * 0.32, y + hang, z + Math.sin(ry) * len * 0.32, 0.014, 5);
      B.pipe('steel', x + Math.cos(ry) * len * 0.32, y + 0.055, z - Math.sin(ry) * len * 0.32,
        x + Math.cos(ry) * len * 0.32, y + hang, z - Math.sin(ry) * len * 0.32, 0.014, 5);
    }
    if (state === 'dead') {
      // a dead tube is still a tube: a dark diffuser, not a hole
      B.paint = 'clad';
      B.dark = 0.48;
      B.boxR('panel_bake', len - 0.12, 0.055, 0.17, x, y - 0.07, z, 0, ry, 0);
      B.dark = 0;
      B.paint = 'metal';
      return -1;
    }
    return emitBox(L, x, y - 0.068, z, len - 0.12, 0.058, 0.175, ry,
      state === 'dying' ? 0xc8dcf0 : 0xd8e6f4,
      state === 'dying' ? 1.55 : 2.25, state === 'dying' ? 'dying' : 'fluoro');
  }

  // A recessed low-level escape marker. Warm, weak, and CONTINUOUS along every
  // route in the facility. This is the single cheapest coverage fix there is:
  // five ceiling pools 8 m apart leave four fifths of a 42 m corridor floor
  // black, and a line does what a row of points physically cannot.
  function marker(L, B, x, y, z, len, ry, out) {
    out = (out === undefined) ? 0.045 : out;
    var ox = out * Math.sin(ry), oz = out * Math.cos(ry);
    B.paint = 'metal';
    B.boxR('steel', len, 0.10, 0.055, x, y, z, 0, ry, 0);
    B.boxR('steel', len + 0.06, 0.022, 0.075, x, y + 0.055, z, 0, ry, 0);
    return emitBox(L, x + ox, y - 0.012, z + oz, len - 0.05, 0.038, 0.030, ry,
      0xffd7a4, 0.80, 'emerg');
  }

  // A red emergency strip in an aluminium channel. Everywhere the escape route
  // goes, and everywhere the water is - it is what puts the level's red into the
  // reflections without adding a light slot.
  function emergStrip(L, B, x, y, z, len, ry, out) {
    out = (out === undefined) ? 0.048 : out;
    var ox = out * Math.sin(ry), oz = out * Math.cos(ry);
    B.paint = 'metal';
    B.boxR('rust_metal', len, 0.085, 0.070, x, y, z, 0, ry, 0);
    return emitBox(L, x + ox, y - 0.030, z + oz, len - 0.06, 0.040, 0.040, ry,
      0xff2814, 1.42, 'emerg');
  }

  // ---------------------------------------------------------------------------
  // THE ALARM BEACON, and it is the level's signature.
  //
  // Three parts. A cast housing with a wire cage, so the fitting reads as a
  // fitting when it is nowhere near you. A red lens as a steady emitter, so it
  // is always a visible source. And a SWEEP - a pair of opposed additive wedges
  // on a pivot this file spins in update() - so a red bar genuinely crosses the
  // walls, the vessel and the water instead of a static pool pretending to.
  // `key` marks the two beacons that also get a real rotating SpotLight; those
  // are the only lights in the level this file owns rather than publishes, and
  // they are what make the sweep land as light and not just as haze.
  // ---------------------------------------------------------------------------
  function beacon(L, B, x, y, z, len, gain, key) {
    B.paint = 'metal';
    // the back plate and the pillar it stands on
    B.box('steel', 0.20, 0.30, 0.30, x, y - 0.26, z);
    B.box('rust_metal', 0.26, 0.055, 0.36, x, y - 0.41, z);
    // the lens: a squat red drum
    B.paint = 'clad';
    B.dark = 0.30;
    B.cyl('panel_bake', 0.175, 0.175, 0.215, x, y, z, 0, 0, 0, 14);
    B.dark = 0;
    B.paint = 'metal';
    B.cyl('steel', 0.195, 0.195, 0.04, x, y + 0.125, z, 0, 0, 0, 14);
    B.cyl('steel', 0.195, 0.195, 0.04, x, y - 0.125, z, 0, 0, 0, 14);
    // the cage
    for (var k = 0; k < 6; k++) {
      var a = k / 6 * Math.PI * 2;
      B.box('steel', 0.022, 0.30, 0.022, x + Math.cos(a) * 0.215, y, z + Math.sin(a) * 0.215);
    }
    emitBox(L, x, y, z, 0.30, 0.185, 0.30, 0, 0xff2410, gain || 2.1, 'beacon');
    L.sweeps.push({
      x: x, y: y, z: z, len: len || 7.0, gain: gain || 2.1,
      speed: 2.35 + L.rng.range(-0.25, 0.25),
      phase: L.rng.range(0, 6.2832), key: !!key
    });
    return L.sweeps.length - 1;
  }

  // A rigged worklight on a tripod. It takes a LOOK-AT rather than a yaw: the
  // metro paid for a hand-tuned angle that put the lens facing away from its own
  // subject, so the frame's subject was lit from behind while the fitting showed
  // the camera its bright side. Solving the head from the target cannot do that.
  function workLight(L, B, x, y, z, tx, ty, tz, colHex, gain, drop) {
    var dx = tx - x, dz = tz - z;
    var yaw = Math.atan2(dx, dz);
    var fx = Math.sin(yaw), fz = Math.cos(yaw);
    B.paint = 'metal';
    for (var k = 0; k < 3; k++) {
      var a = k / 3 * 6.2832 + 0.4;
      B.strut('steel', x, y - 0.22, z, x + Math.cos(a) * 0.44,
        y - (drop === undefined ? 1.35 : drop), z + Math.sin(a) * 0.44, 0.033, 0.033);
    }
    B.box('steel', 0.09, 0.32, 0.09, x, y - 0.19, z);
    B.paint = 'clad';
    B.boxR('hull_paint', 0.36, 0.30, 0.40, x, y, z, 0, yaw, 0);
    // the back plate and hood, so the fitting has a DARK side. On the plain
    // metal paint mode the metro's came back as an orange rusted slab that read
    // as a brick standing on a tripod in front of the subject.
    B.dark = 0.55;
    B.boxR('hull_paint', 0.38, 0.34, 0.05, x - fx * 0.20, y, z - fz * 0.20, 0, yaw, 0);
    B.boxR('hull_paint', 0.40, 0.05, 0.19, x + fx * 0.10, y + 0.18, z + fz * 0.10, 0, yaw, 0);
    B.dark = 0;
    B.paint = 'metal';
    // the trailing lead, coiled on the floor
    B.paint = 'cable';
    var prev = null;
    for (k = 0; k <= 7; k++) {
      var t = k / 7;
      var cxp = x - fx * 0.25 + Math.sin(t * 4.1) * 0.55;
      var cyp = y - (drop === undefined ? 1.35 : drop) * Math.min(1, t * 1.4) + 0.03;
      var czp = z - fz * 0.25 + t * 1.9;
      if (prev) B.pipe('cable_rub', prev[0], prev[1], prev[2], cxp, cyp, czp, 0.026, 5);
      prev = [cxp, cyp, czp];
    }
    B.paint = 'metal';
    return emitBox(L, x + fx * 0.18, y, z + fz * 0.18,
      0.28, 0.22, 0.05, yaw, colHex || 0xffd2a0, gain || 3.0, 'work');
  }

  // A reflector high bay on a drop rod - the reactor hall's own fitting.
  function highBay(L, B, x, y, z, gain, state) {
    B.paint = 'metal';
    B.pipe('steel', x, y + 0.28, z, x, y + 1.20, z, 0.028, 6);
    B.box('steel', 0.16, 0.10, 0.16, x, y + 1.24, z);
    B.paint = 'clad';
    B.dark = 0.14;
    B.add('hull_paint', revolveY([
      [0.10, y + 0.30], [0.55, y + 0.30], [0.62, y + 0.16], [0.62, y + 0.05], [0.20, y - 0.02]
    ], x, z, 16, 0, Math.PI * 2, false));
    B.dark = 0;
    B.paint = 'metal';
    for (var k = 0; k < 4; k++) {
      var a = k / 4 * 6.2832 + 0.5;
      B.box('steel', 0.02, 0.30, 0.02, x + Math.cos(a) * 0.55, y - 0.10, z + Math.sin(a) * 0.55);
    }
    B.cyl('steel', 0.60, 0.60, 0.02, x, y - 0.16, z, 0, 0, 0, 18);
    if (state === 'dead') return -1;
    return emitBox(L, x, y + 0.02, z, 0.46, 0.15, 0.46, 0,
      state === 'dying' ? 0xcadcee : 0xdce8f6, state === 'dying' ? 1.05 : 1.55,
      state === 'dying' ? 'dying' : 'fluoro');
  }

  // ---------------------------------------------------------------------------
  // THE RIG.
  //
  // EVERY LAMP HERE IS SOLVED FOR A TARGET IRRADIANCE, NOT CHOSEN. The first
  // pass authored these by eye against the metro's numbers - and a metro
  // platform batten hangs 6.2 m over its floor while a bunker corridor batten
  // hangs 2.4 m over its own. Same intensity, thirteen times the irradiance.
  // The result was the same defect in four framings: the one surface directly
  // under a fitting blew out, postfx's meter stopped down to match it, and the
  // whole rest of the room printed black - which photographs as a level with no
  // lights in it, the exact opposite of the truth.
  //
  //     I = lux * d^2 / 1.45          (1.45 is lighting.js's levelLampGain)
  //
  // Roughly 8-11 lux for a working area and 4-6 for a wash, which is also what
  // keeps the lit-to-unlit ratio inside the ~50:1 any tone curve holds.
  //
  // Ordered by importance, and that ordering is load bearing: lighting.js caps a
  // declarative level at 24 practicals and truncates the TAIL. Twenty-two
  // entries are published here; the remaining two slots are deliberately left
  // free for the two rotating beacon spots this file owns itself, so the total
  // count in the scene matches what the module would have allowed anyway.
  // ---------------------------------------------------------------------------
  function buildLighting(L, B, rng, N) {
    var i, k, s;
    var P = L.practicalLights;
    var W = L.litWindows;

    function lamp(d) { P.push(d); return d; }
    function glowCard(x, y, z, w, h, kelvin, gain, yaw, tintC) {
      if (W.length >= 20) return;
      W.push({ x: x, y: y, z: z, w: w, h: h, kelvin: kelvin, gain: gain,
        yaw: yaw || 0, scale: 1.25, tint: tintC || null, tintAmt: 0.55,
        haloSize: Math.min(w, 1.6) * 1.1 });
    }

    var FL = new THREE.Color(0.82, 0.90, 1.00);   // cool failing fluorescent
    var RD = new THREE.Color(1.00, 0.16, 0.09);   // the alarm
    var WK = new THREE.Color(1.00, 0.84, 0.62);   // rigged tungsten
    var AM = new THREE.Color(1.00, 0.66, 0.30);   // CRT / status-wall phosphor

    // ======================================================== the spine ======
    // Sixteen battens at 2.6 m centres; four still strike, three gutter, the
    // rest are dead. The lit ones are deliberately CLUSTERED rather than spread:
    // an evenly failing corridor is just a dim corridor, and what the brief asks
    // for is long dark stretches with light at the ends of them.
    var SPN_STATE = { 2: 'lit', 3: 'dying', 7: 'lit', 8: 'dying', 10: 'lit',
      12: 'lit', 13: 'dying', 15: 'lit' };
    for (i = 1; i < 17; i++) {
      var bx = SPN_X0 + i * BEAM_PITCH;
      if (bx > SPN_X1 - 1.0) break;
      var st = SPN_STATE[i] || 'dead';
      batten(L, B, bx - 1.3, SPN_CEIL - 0.30, 0, 1.55, 0, st, 0.16);
      if (st !== 'dead') {
        glowCard(bx - 1.3, SPN_CEIL - 0.40, 0, 1.4, 0.18, 4300, st === 'dying' ? 0.42 : 0.62,
          0, new THREE.Color(0.86, 0.93, 1.0));
      }
    }
    // the continuous escape marker line, both walls, the whole 42 m
    for (s = -1; s <= 1; s += 2) {
      for (i = 0; i < 22; i++) {
        var mx = SPN_X0 + 1.2 + i * 1.95;
        if (mx > SPN_X1 - 0.8) break;
        marker(L, B, mx, 0.34, s * (SPN_HZ - 0.06), 1.70, 0, -s * 0.045);
      }
    }
    // an emergency strip over each blast door frame and at both ends
    // A CONTINUOUS red line down the north wall at cable-tray height. The
    // corridor framing came back with its whole right side black: the trays and
    // the trunk are there, but nothing was lighting them and nothing on that
    // side was emitting. A line at 2.36 m does for the upper half of the frame
    // exactly what the marker line does for the floor, and it is the level's own
    // colour rather than more white.
    for (i = 0; i < 14; i++) {
      var esx = SPN_X0 + 2.0 + i * 3.05;
      if (esx > SPN_X1 - 1.2) break;
      emergStrip(L, B, esx, 2.36, SPN_HZ - 0.10, 2.55, 0, -0.048);
    }
    for (i = 0; i < 15; i++) {
      var cvx = SPN_X0 + 1.8 + i * 2.85;
      if (cvx > SPN_X1 - 1.0) break;
      B.paint = 'metal';
      B.box('rust_metal', 2.45, 0.085, 0.13, cvx, 2.52, -SPN_HZ + 0.16);
      emitBox(L, cvx, 2.565, -SPN_HZ + 0.21, 2.20, 0.032, 0.095, 0,
        0xcfe0f2, (i % 5 === 3) ? 0.0 : 1.05, (i % 5 === 3) ? 'dying' : 'fluoro');
    }
    emergStrip(L, B, -5.2, 2.36, -SPN_HZ + 0.10, 2.4, 0, 0.048);
    emergStrip(L, B, -17.0, 2.36, -SPN_HZ + 0.10, 2.4, 0, 0.048);
    emergStrip(L, B, 5.6, 2.36, -SPN_HZ + 0.10, 2.4, 0, 0.048);

    // ======================================================= the beacons =====
    // Eight of them. The two marked `key` also carry a rotating SpotLight.
    beacon(L, B, -6.20, 2.22, SPN_HZ - 0.30, 7.0, 2.0, true);   // over the mid door
    beacon(L, B, -21.5, 2.22, -SPN_HZ + 0.30, 6.0, 1.8, false);
    beacon(L, B, 4.40, 2.22, -SPN_HZ + 0.30, 6.0, 1.8, false);
    beacon(L, B, -30.4, 2.22, SPN_HZ - 0.30, 5.6, 1.7, false);
    beacon(L, B, RG_X0 + 1.05, 5.40, -8.60, 13.0, 2.6, true);   // the reactor hall
    beacon(L, B, RG_X1 - 1.05, 5.40, 8.60, 12.0, 2.2, false);
    beacon(L, B, VEST_X1 - 1.10, 3.90, -VEST_HZ + 0.30, 8.0, 2.2, false);
    beacon(L, B, CTL_X1 - 0.35, 3.05, 12.20, 8.0, 2.0, false);
    beacon(L, B, 17.20, PIT_Y + 2.30, 6.80, 7.0, 1.9, false);   // in the pit
    beacon(L, B, RG_X1 - 1.05, 6.90, -4.20, 15.0, 2.5, false);  // across the vessel

    // ==================================================== the control room ===
    var CTL_STATE = ['dead', 'lit', 'dying', 'lit', 'dying', 'lit', 'lit', 'dead'];
    for (i = 0; i < 8; i++) {
      var tx = CTL_X0 + 1.6 + (i % 4) * 4.0;
      var tz = CTL_Z0 + 2.6 + ((i / 4) | 0) * 6.6;
      var cst = CTL_STATE[i];
      // recessed troffers in the grid, so the housing sits IN the ceiling plane
      B.paint = 'clad';
      B.dark = 0.24;
      B.box('hull_paint', 1.24, 0.14, 0.66, tx, 2.95 + 0.05, tz);
      B.dark = 0;
      B.paint = 'metal';
      B.box('steel', 1.26, 0.02, 0.06, tx, 2.90, tz - 0.28);
      B.box('steel', 1.26, 0.02, 0.06, tx, 2.90, tz + 0.28);
      if (cst === 'dead') {
        B.paint = 'clad'; B.dark = 0.50;
        B.box('panel_bake', 1.12, 0.03, 0.54, tx, 2.905, tz);
        B.dark = 0; B.paint = 'metal';
      } else {
        emitBox(L, tx, 2.905, tz, 1.12, 0.035, 0.54, 0,
          cst === 'dying' ? 0xc8dcf0 : 0xd8e6f4, cst === 'dying' ? 0.95 : 1.45,
          cst === 'dying' ? 'dying' : 'fluoro');
        glowCard(tx, 2.88, tz, 1.10, 0.20, 4300, cst === 'dying' ? 0.35 : 0.52, 0,
          new THREE.Color(0.86, 0.93, 1.0));
      }
    }
    // the status wall's own tubes, behind the three live bays
    for (i = 0; i < L.statusBays.length; i++) {
      var bay = L.statusBays[i];
      if (!bay.lit) continue;
      emitBox(L, bay.x, bay.y, bay.z + 0.005, bay.w, bay.h, 0.02, 0,
        0xf0e2c4, 0.56, i === 4 ? 'dying' : 'fluoro');
      glowCard(bay.x, bay.y, bay.z - 0.05, bay.w * 0.55, 0.30, 3900, 0.30, 0,
        new THREE.Color(1.0, 0.94, 0.82));
    }
    // the live CRTs
    for (i = 0; i < L.crtFaces.length; i++) {
      var cf = L.crtFaces[i];
      emitBox(L, cf.x, cf.y, cf.z, cf.w, cf.h, 0.02, 0, 0xffa63c, 0.85,
        (i % 3 === 1) ? 'crt' : 'steady');
      if (i < 2) glowCard(cf.x, cf.y, cf.z + 0.02, 0.36, 0.16, 2300, 0.30, 0, AM.clone());
    }
    // A cove down both side walls at 3.10 m. Same reasoning as the corridor's:
    // eight ceiling panels light the floor and nothing else, and a 16 x 13 m
    // room whose walls return nothing has no readable size.
    for (i = 0; i < 9; i++) {
      var ccz = CTL_Z0 + 1.2 + i * 1.75;
      if (ccz > CTL_Z1 - 0.8) break;
      for (s = -1; s <= 1; s += 2) {
        var ccx = s < 0 ? CTL_X0 + 0.14 : CTL_X1 - 0.14;
        B.paint = 'metal';
        B.box('rust_metal', 0.13, 0.085, 1.55, ccx, 3.12, ccz);
        emitBox(L, ccx - s * 0.055, 3.165, ccz, 0.095, 0.030, 1.35, 0,
          0xcfe0f2, (i % 4 === 2) ? 0.0 : 1.00, (i % 4 === 2) ? 'dying' : 'fluoro');
      }
    }

    // the escape line and one strip in here too
    for (i = 0; i < 7; i++) {
      marker(L, B, CTL_X0 + 1.6 + i * 2.1, CTL_FLOOR + 0.34, CTL_Z0 + 0.06, 1.60, 0, 0.045);
    }
    emergStrip(L, B, CTL_X0 + 3.2, CTL_FLOOR + 2.30, CTL_Z0 + 0.10, 2.4, 0, 0.048);
    emergStrip(L, B, CTL_X0 + 9.6, CTL_FLOOR + 2.30, CTL_Z0 + 0.10, 2.4, 0, 0.048);
    // and a batten in the link corridor, so the doorway spills into the spine
    batten(L, B, (LINK_X0 + LINK_X1) * 0.5, 2.30, LINK_Z1 - 0.9, 1.40, Math.PI * 0.5, 'dying', 0.10);
    glowCard((LINK_X0 + LINK_X1) * 0.5, 2.20, LINK_Z1 - 0.9, 1.3, 0.18, 4300, 0.45,
      Math.PI * 0.5, new THREE.Color(0.86, 0.93, 1.0));

    // ===================================================== the vestibule =====
    highBay(L, B, VEST_X0 + 4.2, VEST_CEIL - 0.95, 2.60, 2.4, 'lit');
    highBay(L, B, VEST_X0 + 6.6, VEST_CEIL - 0.95, -3.60, 2.2, 'dying');
    highBay(L, B, VEST_X0 + 10.4, VEST_CEIL - 0.95, 3.40, 0, 'dead');
    glowCard(VEST_X0 + 4.2, VEST_CEIL - 1.18, 2.60, 0.95, 0.26, 4200, 0.55, 0,
      new THREE.Color(0.88, 0.94, 1.0));
    for (i = 0; i < 6; i++) {
      var vcx = VEST_X0 + 1.6 + i * 2.15;
      if (vcx > VEST_X1 - 0.8) break;
      for (s = -1; s <= 1; s += 2) {
        B.paint = 'metal';
        B.box('rust_metal', 1.90, 0.09, 0.14, vcx, 3.72, s * (VEST_HZ - 0.16));
        emitBox(L, vcx, 3.765, s * (VEST_HZ - 0.22), 1.70, 0.032, 0.10, 0,
          0xcfe0f2, (i % 4 === 1) ? 0.0 : 1.35, (i % 4 === 1) ? 'dying' : 'fluoro');
      }
    }
    // a lit reveal round the door aperture itself, so the 2.4 m of concrete the
    // plug seals into is a shape rather than a black frame
    for (i = 0; i < 5; i++) {
      var dvy = 0.55 + i * 0.92;
      B.paint = 'metal';
      B.box('rust_metal', 0.14, 0.09, 0.30, VEST_X0 + 0.12, dvy, -DOOR_W * 0.5 - 0.28);
      emitBox(L, VEST_X0 + 0.20, dvy, -DOOR_W * 0.5 - 0.28, 0.075, 0.030, 0.22, 0,
        0xffd7a4, (i === 2) ? 0.0 : 0.95, (i === 2) ? 'dying' : 'emerg');
    }
    workLight(L, B, VEST_X0 + 7.6, 3.05, -2.60, DOOR_X, 1.60, DOOR_OPEN * 0.4,
      0xffd2a0, 3.4, 1.42);
    glowCard(VEST_X0 + 7.72, 3.05, -2.44, 0.32, 0.24, 3100, 0.60, 0, WK.clone());
    for (i = 0; i < 7; i++) {
      marker(L, B, VEST_X0 + 1.4 + i * 1.7, 0.34, -VEST_HZ + 0.06, 1.45, 0, 0.045);
    }
    emergStrip(L, B, VEST_X0 + 2.6, 3.10, VEST_HZ - 0.10, 2.6, 0, -0.048);
    emergStrip(L, B, VEST_X0 + 6.4, 3.10, VEST_HZ - 0.10, 2.6, 0, -0.048);
    emergStrip(L, B, VEST_X1 - 2.4, 3.10, -VEST_HZ + 0.10, 2.6, 0, 0.048);
    emergStrip(L, B, VEST_X0 + 4.0, 3.10, -VEST_HZ + 0.10, 2.6, 0, 0.048);
    // the guard cabin's own light, seen through its glazing
    emitBox(L, VEST_X0 + 5.0, 4.35, VEST_HZ - 1.55, 1.30, 0.05, 0.22, 0, 0xd8e6f4, 1.9, 'fluoro');
    glowCard(VEST_X0 + 5.0, 4.28, VEST_HZ - 3.10, 1.6, 0.28, 4300, 0.45, 0,
      new THREE.Color(0.86, 0.93, 1.0));
    // and one lamp down the approach tunnel, so the collapse is not a black hole
    workLight(L, B, VEST_X0 - 4.2, 2.35, 1.40, APPR_X0 + 6.4, 1.2, 0.0, 0xffe0b0, 2.4, 1.60);

    // ======================================================== the plant ======
    batten(L, B, PLT_X0 + 3.0, PLT_CEIL - 0.34, PLT_Z0 + 2.6, 1.60, 0, 'lit', 0.24);
    batten(L, B, PLT_X1 - 2.6, PLT_CEIL - 0.34, PLT_Z1 - 2.4, 1.60, 0, 'dying', 0.24);
    glowCard(PLT_X0 + 3.0, PLT_CEIL - 0.44, PLT_Z0 + 2.6, 1.4, 0.18, 4300, 0.50, 0,
      new THREE.Color(0.86, 0.93, 1.0));
    for (i = 0; i < 5; i++) {
      marker(L, B, PLT_X0 + 1.2 + i * 1.9, 0.34, PLT_Z0 + 0.06, 1.55, 0, 0.045);
    }
    emergStrip(L, B, PLT_X0 + 5.4, 2.55, PLT_Z0 + 0.10, 2.6, 0, 0.048);

    // ================================================= the reactor gallery ===
    // Six high bays under the crane girder, two of them out. Plus a cove of
    // emissive strip along the gantry ring and along the well kerb: the hall is
    // 28 x 26 x 11 m and six point sources cannot carry it, but the kerb line
    // is continuous, it outlines the well, and it doubles in the water below.
    var HB = [[13.6, -6.4, 'lit'], [13.6, 6.4, 'dying'], [24.0, -10.4, 'lit'],
              [24.0, 10.4, 'dead'], [33.4, -6.4, 'lit'], [33.4, 6.4, 'dead']];
    for (i = 0; i < HB.length; i++) {
      highBay(L, B, HB[i][0], RG_CEIL - 1.55, HB[i][1], 2.4, HB[i][2]);
      if (HB[i][2] !== 'dead') {
        glowCard(HB[i][0], RG_CEIL - 1.78, HB[i][1], 0.95, 0.26, 4300,
          HB[i][2] === 'dying' ? 0.42 : 0.58, 0, new THREE.Color(0.88, 0.94, 1.0));
      }
    }
    // the gantry cove, throwing UP into the coffers
    for (i = 0; i < 20; i++) {
      var ca2 = i / 20 * Math.PI * 2;
      if (i % 5 === 3) continue;
      var cx3 = REAC_CX + Math.cos(ca2) * (GANT_R1 - 0.10);
      var cz4 = REAC_CZ + Math.sin(ca2) * (GANT_R1 - 0.10);
      B.paint = 'metal';
      B.boxR('rust_metal', 1.25, 0.075, 0.11, cx3, GANT_Y + 0.30, cz4, 0, -ca2 + Math.PI * 0.5, 0);
      emitBox(L, cx3, GANT_Y + 0.345, cz4, 1.10, 0.030, 0.085, -ca2 + Math.PI * 0.5,
        0xcfe0f2, (i % 7 === 2) ? 0.0 : 1.05, (i % 7 === 2) ? 'dying' : 'fluoro');
    }
    // THE WALL COVE. A continuous channel at 4.55 m round all four walls of the
    // hall. It was added for a measured reason: with only high bays and the
    // gantry cove, everything more than ~12 m from a fitting - which is all four
    // walls of a 28 x 26 m room - returned nothing at all, and the establishing
    // frame photographed as a lit reactor floating in a black void. A wall the
    // eye can find is what tells you how big the room is.
    for (i = 0; i < 11; i++) {
      var wcx = RG_X0 + 1.4 + i * 2.55;
      if (wcx > RG_X1 - 1.0) break;
      for (s = -1; s <= 1; s += 2) {
        B.paint = 'metal';
        B.box('rust_metal', 2.30, 0.10, 0.16, wcx, 4.62, s * (RG_HZ - 0.18));
        emitBox(L, wcx, 4.545, s * (RG_HZ - 0.24), 2.05, 0.036, 0.10, 0,
          0xcfe0f2, (i % 4 === 2) ? 0.0 : 1.10, (i % 4 === 2) ? 'dying' : 'fluoro');
      }
    }
    for (i = 0; i < 10; i++) {
      var wcz = -RG_HZ + 1.6 + i * 2.75;
      if (wcz > RG_HZ - 1.0) break;
      for (s = -1; s <= 1; s += 2) {
        var wcxx = s < 0 ? RG_X0 + 0.18 : RG_X1 - 0.18;
        B.paint = 'metal';
        B.box('rust_metal', 0.16, 0.10, 2.30, wcxx, 4.62, wcz);
        emitBox(L, wcxx - s * 0.06, 4.545, wcz, 0.10, 0.036, 2.05, 0,
          0xcfe0f2, (i % 4 === 1) ? 0.0 : 1.10, (i % 4 === 1) ? 'dying' : 'fluoro');
      }
    }

    // the well kerb line, all four sides, broken at the bridges and the stair
    for (i = 0; i < 26; i++) {
      var kz = WELL_Z0 + 0.6 + i * ((WELL_Z1 - WELL_Z0 - 1.2) / 25);
      if (Math.abs(kz) < BRIDGE_HW_W + 0.3) continue;
      if (kz > STAIR_Z0 - 0.3 && kz < STAIR_Z1 + 0.3) continue;
      emergStrip(L, B, WELL_X0 - 0.30, 0.22, kz, 0.62, Math.PI * 0.5, 0.050);
    }
    for (i = 0; i < 26; i++) {
      var kz2 = WELL_Z0 + 0.6 + i * ((WELL_Z1 - WELL_Z0 - 1.2) / 25);
      emergStrip(L, B, WELL_X1 + 0.30, 0.22, kz2, 0.62, Math.PI * 0.5, -0.050);
    }
    for (i = 0; i < 26; i++) {
      var kx2 = WELL_X0 + 0.6 + i * ((WELL_X1 - WELL_X0 - 1.2) / 25);
      if (Math.abs(kx2 - REAC_CX) < BRIDGE_HW_N + 0.3) continue;
      emergStrip(L, B, kx2, 0.22, WELL_Z0 - 0.30, 0.62, 0, 0.050);
      emergStrip(L, B, kx2, 0.22, WELL_Z1 + 0.30, 0.62, 0, -0.050);
    }
    // markers on the deck routes
    for (i = 0; i < 9; i++) {
      marker(L, B, RG_X0 + 1.2 + i * 3.0, 0.34, -RG_HZ + 0.06, 1.60, 0, 0.045);
      marker(L, B, RG_X0 + 1.2 + i * 3.0, 0.34, RG_HZ - 0.06, 1.60, 0, -0.045);
    }
    // the bridge and platform: a strip down the walkway's edge
    for (i = 0; i < 5; i++) {
      emergStrip(L, B, WELL_X0 + 0.4 + i * 1.30, 0.16, -BRIDGE_HW_W + 0.10, 1.15, 0, -0.050);
    }
    // the pit ring: red strips at head height above the water, all the way round
    for (i = 0; i < 10; i++) {
      var pz3 = WELL_Z0 + 1.2 + i * ((WELL_Z1 - WELL_Z0 - 2.4) / 9);
      emergStrip(L, B, WELL_X0 + 0.16, PIT_Y + 1.85, pz3, 1.30, Math.PI * 0.5, 0.050);
      emergStrip(L, B, WELL_X1 - 0.16, PIT_Y + 1.85, pz3, 1.30, Math.PI * 0.5, -0.050);
    }
    for (i = 0; i < 10; i++) {
      var px3 = WELL_X0 + 1.2 + i * ((WELL_X1 - WELL_X0 - 2.4) / 9);
      emergStrip(L, B, px3, PIT_Y + 1.85, WELL_Z0 + 0.16, 1.30, 0, 0.050);
      emergStrip(L, B, px3, PIT_Y + 1.85, WELL_Z1 - 0.16, 1.30, 0, -0.050);
    }
    // the two rigged worklights: one on the west deck on the vessel, one in the
    // pit at the foot of the stair. These are the warm accents in two framings.
    workLight(L, B, RG_X0 + 3.30, 2.95, -3.10, REAC_CX - BIO_R, 1.30, -0.60,
      0xffd2a0, 3.2, 1.44);
    glowCard(RG_X0 + 3.46, 2.95, -2.94, 0.32, 0.24, 3100, 0.58, 0, WK.clone());
    workLight(L, B, 16.30, PIT_Y + 2.05, -7.60, 20.6, PIT_Y + 0.4, -4.2,
      0xffdcae, 2.8, 1.46);

    // ---- the glint cards on the water --------------------------------------
    // Deliberately faint. Run at full chroma they print as solid glowing bars
    // laid on the surface, and a reflection brighter than its own source is not
    // a reflection - it is a light strip painted on the water. A specular smear
    // on rippled water is a low-contrast wash the eye reads as depth.
    var RC = new THREE.Color(0.44, 0.075, 0.045);
    var WC = new THREE.Color(0.40, 0.31, 0.20);
    for (i = 0; i < 8; i++) {
      var gz4 = WELL_Z0 + 1.4 + i * ((WELL_Z1 - WELL_Z0 - 2.8) / 7);
      glint(B, WELL_X0 + 1.5, gz4, 5.0, 0.85, RC, WATER_Y + 0.010, 'x');
      glint(B, WELL_X1 - 1.5, gz4, 5.0, 0.85, RC, WATER_Y + 0.010, 'x');
    }
    for (i = 0; i < 6; i++) {
      var gx4 = WELL_X0 + 2.0 + i * ((WELL_X1 - WELL_X0 - 4.0) / 5);
      glint(B, gx4, WELL_Z0 + 1.5, 5.0, 0.85, RC, WATER_Y + 0.010, 'z');
      glint(B, gx4, WELL_Z1 - 1.5, 5.0, 0.85, RC, WATER_Y + 0.010, 'z');
    }
    glint(B, 18.8, -6.6, 9.0, 1.40, WC, WATER_Y + 0.013, 'x');
    glint(B, 28.4, 6.2, 8.0, 1.30, WC, WATER_Y + 0.013, 'x');

    // ========================================================================
    // THE PRACTICALS.  Twenty-two, most important first.
    // ========================================================================
    // 1-6 : the reactor gallery. These carry the signature framing.
    lamp({ name: 'bnk_reac_key', kind: 'fluoro', pos: [13.6, RG_CEIL - 1.70, -6.4],
      color: FL.clone(), kelvin: 4300, intensity: 340, distance: 26, cone: 1.00, penumbra: 0.44,
      dayBase: 1, aimPos: [REAC_CX - 2.0, 3.20, -1.20], fixed: true, halo: 1.5, haloGain: 0.22,
      bulbR: 0.11, bulbFlat: 0.5, bulbGain: 0.16, beam: 0.20 });
    lamp({ name: 'bnk_reac_work', kind: 'led', pos: [RG_X0 + 3.30, 2.95, -3.10],
      color: WK.clone(), kelvin: 3100, intensity: 105, distance: 22, cone: 0.72, penumbra: 0.46,
      dayBase: 1, aimPos: [REAC_CX - BIO_R, 1.30, -0.60], fixed: true, halo: 0.8, haloGain: 0.24,
      bulbR: 0.08, bulbFlat: 0.3, bulbGain: 0.14, beam: 0.22 });
    lamp({ name: 'bnk_reac_deck', kind: 'fluoro', pos: [10.30, 4.60, 3.60],
      color: FL.clone(), kelvin: 4200, intensity: 110, distance: 16, cone: 1.15, penumbra: 0.50,
      dayBase: 1, aimPos: [12.0, DECK_Y, 2.40], fixed: true, halo: 0.9, haloGain: 0.20,
      bulbR: 0.07, bulbFlat: 0.4, bulbGain: 0.12, beam: 0.14 });
    lamp({ name: 'bnk_reac_fill', kind: 'fluoro', pos: [33.4, RG_CEIL - 1.70, -6.4],
      color: FL.clone(), kelvin: 4400, intensity: 300, distance: 26, cone: 1.00, penumbra: 0.46,
      dayBase: 1, aimPos: [REAC_CX + 2.4, 3.60, 1.40], fixed: true, halo: 1.4, haloGain: 0.22,
      bulbR: 0.11, bulbFlat: 0.5, bulbGain: 0.16, beam: 0.20 });
    lamp({ name: 'bnk_reac_north', kind: 'fluoro', pos: [24.0, RG_CEIL - 1.70, -10.4],
      color: FL.clone(), kelvin: 4300, intensity: 260, distance: 24, cone: 1.05, penumbra: 0.48,
      dayBase: 1, aimPos: [24.0, 1.20, -6.4], fixed: true, halo: 1.3, haloGain: 0.22,
      bulbR: 0.10, bulbFlat: 0.5, bulbGain: 0.14, beam: 0.18 });
    lamp({ name: 'bnk_gantry', kind: 'fluoro', pos: [REAC_CX, GANT_Y + 0.36, REAC_CZ + GANT_R1 - 0.1],
      color: FL.clone(), kelvin: 4600, intensity: 84, distance: 16, cone: 1.10, penumbra: 0.52,
      dayBase: 1, aimPos: [REAC_CX, RG_CEIL - 0.4, REAC_CZ + 2.0], fixed: true,
      halo: 0.9, haloGain: 0.20, bulbR: 0.06, bulbFlat: 0.4, bulbGain: 0.10, beam: 0.32 });

    // 7-9 : the lower level. Weak, red, and aimed at the WATER - the standing
    // water is the only surface down here that can return a strip as a
    // highlight, and it can only do that if a source is actually pointed at it.
    lamp({ name: 'bnk_pit_work', kind: 'led', pos: [16.30, PIT_Y + 2.05, -7.60],
      color: WK.clone(), kelvin: 3200, intensity: 96, distance: 18, cone: 0.72, penumbra: 0.46,
      dayBase: 1, aimPos: [20.6, PIT_Y + 0.4, -4.2], fixed: true, halo: 0.75, haloGain: 0.24,
      bulbR: 0.08, bulbFlat: 0.3, bulbGain: 0.14, beam: 0.42 });
    lamp({ name: 'bnk_pit_w', kind: 'led', pos: [WELL_X0 + 0.30, PIT_Y + 1.85, 3.0],
      color: RD.clone(), kelvin: 1900, intensity: 30, distance: 12, cone: 1.25, penumbra: 0.58,
      dayBase: 1, aimPos: [WELL_X0 + 2.8, WATER_Y, 1.6], fixed: true, halo: 0.45,
      haloGain: 0.26, bulbR: 0.05, bulbFlat: 0.5, bulbGain: 0.18, beam: 0.22 });
    lamp({ name: 'bnk_pit_e', kind: 'led', pos: [WELL_X1 - 0.30, PIT_Y + 1.85, -3.0],
      color: RD.clone(), kelvin: 1900, intensity: 30, distance: 12, cone: 1.25, penumbra: 0.58,
      dayBase: 1, aimPos: [WELL_X1 - 2.8, WATER_Y, -1.6], fixed: true, halo: 0.45,
      haloGain: 0.26, bulbR: 0.05, bulbFlat: 0.5, bulbGain: 0.18, beam: 0.22 });

    // 10-13 : the spine. Three battens and the doorway spill from the link.
    lamp({ name: 'bnk_spine_c', kind: 'fluoro', pos: [-16.10, SPN_CEIL - 0.42, 0],
      color: FL.clone(), kelvin: 4300, intensity: 48, distance: 15, cone: 1.18, penumbra: 0.50,
      dayBase: 1, aimPos: [-15.4, DECK_Y, 0], fixed: true, halo: 1.1, haloGain: 0.22,
      bulbR: 0.07, bulbFlat: 0.4, bulbGain: 0.14, beam: 0.45 });
    lamp({ name: 'bnk_spine_e', kind: 'fluoro', pos: [4.70, SPN_CEIL - 0.42, 0],
      color: FL.clone(), kelvin: 4300, intensity: 44, distance: 14, cone: 1.10, penumbra: 0.46,
      dayBase: 1, aimPos: [5.8, DECK_Y, 0], fixed: true, halo: 1.1, haloGain: 0.22,
      bulbR: 0.07, bulbFlat: 0.4, bulbGain: 0.14, beam: 0.45 });
    lamp({ name: 'bnk_spine_link', kind: 'fluoro', pos: [(LINK_X0 + LINK_X1) * 0.5, 2.24, LINK_Z1 - 0.9],
      color: FL.clone(), kelvin: 4300, intensity: 40, distance: 12, cone: 1.15, penumbra: 0.52,
      dayBase: 1, aimPos: [(LINK_X0 + LINK_X1) * 0.5, DECK_Y, LINK_Z0 - 1.2], fixed: true,
      halo: 0.9, haloGain: 0.22, bulbR: 0.06, bulbFlat: 0.4, bulbGain: 0.12, beam: 0.38 });
    lamp({ name: 'bnk_spine_w', kind: 'fluoro', pos: [-29.10, SPN_CEIL - 0.42, 0],
      color: FL.clone(), kelvin: 4200, intensity: 42, distance: 13, cone: 1.10, penumbra: 0.46,
      dayBase: 1, aimPos: [-28.4, DECK_Y, 0], fixed: true, halo: 1.0, haloGain: 0.22,
      bulbR: 0.07, bulbFlat: 0.4, bulbGain: 0.14, beam: 0.45 });

    // 14-17 : the vestibule. The flood on the blast door is hero3's key.
    lamp({ name: 'bnk_vest_flood', kind: 'led', pos: [VEST_X0 + 7.6, 3.05, -2.60],
      color: WK.clone(), kelvin: 3100, intensity: 250, distance: 22, cone: 0.62, penumbra: 0.42,
      dayBase: 1, aimPos: [DOOR_X, 1.60, DOOR_OPEN * 0.4], fixed: true, halo: 0.85,
      haloGain: 0.26, bulbR: 0.09, bulbFlat: 0.3, bulbGain: 0.16, beam: 0.48 });
    lamp({ name: 'bnk_vest_bay', kind: 'fluoro', pos: [VEST_X0 + 4.2, VEST_CEIL - 1.20, 2.60],
      color: FL.clone(), kelvin: 4200, intensity: 112, distance: 17, cone: 1.05, penumbra: 0.48,
      dayBase: 1, aimPos: [VEST_X0 + 4.6, DECK_Y, 1.20], fixed: true, halo: 1.2,
      haloGain: 0.22, bulbR: 0.09, bulbFlat: 0.5, bulbGain: 0.14, beam: 0.48 });
    lamp({ name: 'bnk_vest_bay2', kind: 'fluoro', pos: [VEST_X0 + 6.6, VEST_CEIL - 1.20, -3.60],
      color: FL.clone(), kelvin: 4300, intensity: 108, distance: 17, cone: 1.05, penumbra: 0.50,
      dayBase: 1, aimPos: [VEST_X0 + 7.4, DECK_Y, -4.6], fixed: true, halo: 1.1,
      haloGain: 0.22, bulbR: 0.08, bulbFlat: 0.5, bulbGain: 0.14, beam: 0.44 });
    lamp({ name: 'bnk_spine_d', kind: 'fluoro', pos: [-3.10, SPN_CEIL - 0.42, 0],
      color: FL.clone(), kelvin: 4300, intensity: 46, distance: 14, cone: 1.12, penumbra: 0.46,
      dayBase: 1, aimPos: [-2.20, DECK_Y, 0], fixed: true, halo: 1.1, haloGain: 0.22,
      bulbR: 0.07, bulbFlat: 0.4, bulbGain: 0.14, beam: 0.30 });

    // 18-21 : the control room.
    lamp({ name: 'bnk_ctl_key', kind: 'fluoro', pos: [-25.60, 2.88, 7.90],
      color: FL.clone(), kelvin: 4300, intensity: 62, distance: 16, cone: 1.15, penumbra: 0.50,
      dayBase: 1, aimPos: [-25.0, CTL_FLOOR, 8.60], fixed: true, halo: 1.1, haloGain: 0.22,
      bulbR: 0.08, bulbFlat: 0.5, bulbGain: 0.14, beam: 0.42 });
    lamp({ name: 'bnk_ctl_wall', kind: 'led', pos: [-22.0, 3.05, 14.6],
      color: new THREE.Color(1.0, 0.94, 0.82), kelvin: 3900, intensity: 78, distance: 15,
      cone: 1.20, penumbra: 0.55, dayBase: 1, aimPos: [-22.0, CTL_FLOOR + 2.1, CTL_Z1],
      fixed: true, halo: 0.8, haloGain: 0.22, bulbR: 0.06, bulbFlat: 0.4, bulbGain: 0.12, beam: 0.30 });
    lamp({ name: 'bnk_ctl_fill', kind: 'fluoro', pos: [-17.6, 2.88, 15.8],
      color: FL.clone(), kelvin: 4400, intensity: 62, distance: 16, cone: 1.15, penumbra: 0.52,
      dayBase: 1, aimPos: [-18.4, CTL_FLOOR, 14.2], fixed: true, halo: 1.0, haloGain: 0.22,
      bulbR: 0.07, bulbFlat: 0.5, bulbGain: 0.12, beam: 0.38 });
    lamp({ name: 'bnk_spine_b', kind: 'fluoro', pos: [-8.30, SPN_CEIL - 0.42, 0],
      color: FL.clone(), kelvin: 4200, intensity: 45, distance: 14, cone: 1.12, penumbra: 0.48,
      dayBase: 1, aimPos: [-7.4, DECK_Y, 0], fixed: true, halo: 1.0, haloGain: 0.22,
      bulbR: 0.07, bulbFlat: 0.4, bulbGain: 0.14, beam: 0.28 });

    // 22 : the plant room, so the corridor's side opening is not a black slot.
    lamp({ name: 'bnk_plant', kind: 'fluoro', pos: [PLT_X0 + 3.0, PLT_CEIL - 0.46, PLT_Z0 + 2.6],
      color: FL.clone(), kelvin: 4300, intensity: 50, distance: 15, cone: 1.10, penumbra: 0.48,
      dayBase: 1, aimPos: [PLT_X0 + 3.4, DECK_Y, PLT_Z0 + 3.6], fixed: true, halo: 1.1,
      haloGain: 0.22, bulbR: 0.08, bulbFlat: 0.5, bulbGain: 0.14, beam: 0.42 });

    // 23-24 : the wall wash. Appended LAST on purpose - the module caps a
    // declarative level at 24 and truncates the tail, so these are the two that
    // can be lost without costing a framing its subject. They exist so the hall
    // has walls in it rather than a horizon of black.
    lamp({ name: 'bnk_hall_wall_n', kind: 'fluoro', pos: [20.0, 4.62, RG_HZ - 0.55],
      color: FL.clone(), kelvin: 4300, intensity: 74, distance: 22, cone: 1.30, penumbra: 0.60,
      dayBase: 1, aimPos: [20.0, 7.60, RG_HZ + 0.4], fixed: true, halo: 1.0, haloGain: 0.18,
      bulbR: 0.07, bulbFlat: 0.4, bulbGain: 0.10, beam: 0.24 });
    lamp({ name: 'bnk_hall_wall_s', kind: 'fluoro', pos: [26.0, 4.62, -RG_HZ + 0.55],
      color: FL.clone(), kelvin: 4400, intensity: 74, distance: 22, cone: 1.30, penumbra: 0.60,
      dayBase: 1, aimPos: [26.0, 7.60, -RG_HZ - 0.4], fixed: true, halo: 1.0, haloGain: 0.18,
      bulbR: 0.07, bulbFlat: 0.4, bulbGain: 0.10, beam: 0.24 });

    // ---- the shafts ---------------------------------------------------------
    // Four real fixtures, one per framing that needs one. lighting.js builds a
    // spot plus an additive haze cone for each; `lux` marks them as FIXTURES so
    // they stop tracking a sun this level does not have. Ordered, because the
    // module caps a declarative level at four and takes the first four.
    L.lightShafts.push({
      origin: new THREE.Vector3(13.6, RG_CEIL - 1.85, -6.4),
      dir: new THREE.Vector3(0.30, -1, 0.16), width: 2.40, length: 10.5,
      strength: 0.62, lux: 10, kelvin: 4300, always: true, kind: 'hall'
    });
    L.lightShafts.push({
      origin: new THREE.Vector3(VEST_X0 + 4.2, VEST_CEIL - 1.35, 2.60),
      dir: new THREE.Vector3(0.10, -1, -0.22), width: 2.20, length: 4.2,
      strength: 0.90, lux: 9, kelvin: 4200, always: true, kind: 'vestibule'
    });
    L.lightShafts.push({
      origin: new THREE.Vector3(-25.6, 2.82, 7.90),
      dir: new THREE.Vector3(0.06, -1, 0.10), width: 1.70, length: 3.0,
      strength: 0.85, lux: 8, kelvin: 4300, always: true, kind: 'control'
    });
    L.lightShafts.push({
      origin: new THREE.Vector3(16.30, PIT_Y + 1.95, -7.60),
      dir: new THREE.Vector3(0.62, -1, 0.44), width: 1.90, length: 4.0,
      strength: 0.90, lux: 9, kelvin: 3200, always: true, kind: 'pit'
    });
    L.lightShafts.push({
      origin: new THREE.Vector3(33.4, RG_CEIL - 1.85, -6.4),
      dir: new THREE.Vector3(-0.26, -1, 0.14), width: 2.90, length: 10.0,
      strength: 0.80, lux: 9, kelvin: 4400, always: true, kind: 'hall2'
    });

    // ---- publish the rig as anchors ----------------------------------------
    for (i = 0; i < P.length; i++) {
      var d = P[i];
      L.anchors.lamps.push({
        name: d.name, kind: d.kind, cone: d.cone || 0,
        pos: new THREE.Vector3(d.pos[0], d.pos[1], d.pos[2]),
        aim: d.aimPos ? new THREE.Vector3(d.aimPos[0], d.aimPos[1], d.aimPos[2]) : null
      });
    }
    for (i = 0; i < L.sweeps.length; i++) {
      var sw = L.sweeps[i];
      L.anchors.beacons.push({
        pos: new THREE.Vector3(sw.x, sw.y, sw.z), radius: sw.len, key: sw.key
      });
    }
  }

  // ============================================================ LevelBunker ==
  function LevelBunker(ctx) {
    this.ctx = ctx || null;
    this.root = new THREE.Object3D();
    this.root.name = 'level_bunker';
    this.colliders = [];
    this.spawnPoints = [];
    this.navGrid = null;
    this.cameraPoses = {};
    this.meshes = [];
    this.emitters = [];
    this.sweeps = [];
    this.lightShafts = [];
    this.practicalLights = [];
    this.litWindows = [];
    this.wetPatches = [];
    this.statusBays = [];
    this.crtFaces = [];
    this.consoles = [];
    this.dripEdges = [];
    this.waterPlane = null;
    this._matCache = Object.create(null);
    this._hash = new GAME.SpatialHash(4.0);
    this._stamp = 0;
    this._atlasOk = false;
    this._emitMesh = null;
    this._sweepMeshes = [];
    this._beaconLights = [];
    this._t = 0;
    var seed = (ctx && ctx.seed) || 20260801;
    this.rng = (ctx && ctx.rng && ctx.rng.fork) ? ctx.rng.fork(0x424B3137) : new GAME.RNG(seed);
    this.noise = new GAME.Noise(seed ^ 0x4B31);
    // Buried, sealed and DRY. There is no weather system to ask - ctx.weather is
    // inert here by contract - so the level states its own condition, and 0.22
    // is a damp basement rather than a flood. Only the lower level is wet, and
    // that is decided per-vertex off its own height, not off this number.
    this.wetness = 0.22;
    this.bounds = new THREE.Box3(
      new THREE.Vector3(APPR_X0 - 4, PIT_Y - 3.0, -RG_HZ - 4),
      new THREE.Vector3(RG_X1 + 4, RG_CEIL + 3.0, RG_HZ + 4));
    // THE PLACEMENT CONTRACT. Available before build().
    this.anchors = buildAnchors(this.noise);
  }

  // ---------------------------------------------------------------------------
  // Every anchor is derived from the same constants the geometry is, so an
  // anchor and the thing it names cannot drift apart. Nothing in here reads a
  // camera pose, and nothing in here is a remembered number.
  // ---------------------------------------------------------------------------
  function buildAnchors(N) {
    function V(x, y, z) { return new THREE.Vector3(x, y, z); }
    var A = {};

    A.vestibule = {
      x0: VEST_X0, x1: VEST_X1, hz: VEST_HZ, y: DECK_Y, ceil: VEST_CEIL,
      centre: V((VEST_X0 + VEST_X1) * 0.5, DECK_Y, 0),
      doorCentre: V(DOOR_X, DOOR_H * 0.5, 0),
      cabin: { x0: VEST_X0 + 2.6, x1: VEST_X0 + 7.4, y: 2.95, z: VEST_HZ - 1.55,
        centre: V(VEST_X0 + 5.0, 2.95, VEST_HZ - 1.55) },
      decon: [V(VEST_X0 + 2.2, DECK_Y, -VEST_HZ + 1.05),
              V(VEST_X0 + 4.5, DECK_Y, -VEST_HZ + 1.05),
              V(VEST_X0 + 6.8, DECK_Y, -VEST_HZ + 1.05)],
      approach: { x0: APPR_X0, x1: VEST_X0 - 1.0, hz: APPR_HZ, ceil: APPR_CEIL,
        collapse: V(APPR_X0 + 3.4, DECK_Y, 0) }
    };

    A.blastDoor = {
      centre: V(DOOR_X, DOOR_H * 0.5 - 0.10, DOOR_OPEN),
      plane: DOOR_X, w: DOOR_W, h: DOOR_H, thick: DOOR_T,
      openZ: DOOR_OPEN, gap: V(DOOR_X, 1.6, DOOR_OPEN - DOOR_W * 0.5 - 0.8),
      pocket: V(DOOR_X, DOOR_H * 0.5, DOOR_OPEN + DOOR_W * 0.5),
      railZ: [-0.42, 0.42], ramY: [0.85, 3.20]
    };

    A.spine = {
      x0: SPN_X0, x1: SPN_X1, hz: SPN_HZ, y: DECK_Y, ceil: SPN_CEIL,
      centre: V((SPN_X0 + SPN_X1) * 0.5, DECK_Y, 0),
      westEnd: V(SPN_X0 + 1.5, DECK_Y, 0), eastEnd: V(SPN_X1 - 1.5, DECK_Y, 0),
      beamPitch: BEAM_PITCH,
      doorsX: SPN_DOORS.concat([HALL_DOOR_X]),
      trayY: [2.62, 2.32, 2.02], trayZ: SPN_HZ - 0.34,
      trunkY: 2.55, trunkZ: -SPN_HZ + 0.42,
      markerY: 0.34,
      junctions: [
        { name: 'control', x: (LINK_X0 + LINK_X1) * 0.5, z: SPN_HZ, dir: 1 },
        { name: 'plant', x: -9.5, z: -SPN_HZ, dir: -1 }
      ],
      groundY: function (x, z) { return deckY(x, z, N); }
    };

    A.control = {
      x0: CTL_X0, x1: CTL_X1, z0: CTL_Z0, z1: CTL_Z1,
      floorY: CTL_FLOOR, ceil: CTL_CEIL, gridY: 2.95,
      centre: V((CTL_X0 + CTL_X1) * 0.5, CTL_FLOOR, (CTL_Z0 + CTL_Z1) * 0.5),
      statusWall: { z: CTL_Z1 - 0.10, x0: -28.6, x1: -15.4,
        y0: CTL_FLOOR + 0.80, y1: CTL_FLOOR + 3.30,
        centre: V(-22.0, CTL_FLOOR + 2.05, CTL_Z1 - 0.10) },
      consoles: (function () {
        var out = [];
        for (var r = 0; r < CTL_ROWS.length; r++) {
          for (var i = 0; i < CTL_ROWS[r].n; i++) {
            out.push({ centre: V(CTL_ROWS[r].x0 + i * CTL_ROWS[r].w, CTL_FLOOR,
              CTL_ROWS[r].z), w: CTL_ROWS[r].w - 0.06, row: r });
          }
        }
        return out;
      })(),
      racks: V(CTL_X0 + 0.85, CTL_FLOOR, CTL_Z0 + 3.5),
      voidPanels: CTL_VOIDS.map(function (v) {
        return { centre: V((v.x0 + v.x1) * 0.5, DECK_Y, (v.z0 + v.z1) * 0.5),
          hx: (v.x1 - v.x0) * 0.5, hz: (v.z1 - v.z0) * 0.5 };
      }),
      doorway: V((LINK_X0 + LINK_X1) * 0.5, CTL_FLOOR, CTL_Z0),
      link: { x0: LINK_X0, x1: LINK_X1, z0: LINK_Z0, z1: LINK_Z1,
        groundY: function (z) { return linkY(z); } }
    };

    A.plant = {
      x0: PLT_X0, x1: PLT_X1, z0: PLT_Z0, z1: PLT_Z1, y: DECK_Y, ceil: PLT_CEIL,
      centre: V((PLT_X0 + PLT_X1) * 0.5, DECK_Y, (PLT_Z0 + PLT_Z1) * 0.5),
      doorway: V(-9.5, DECK_Y, PLT_Z1),
      cabinets: (function () {
        var out = [];
        for (var i = 0; i < 6; i++) {
          out.push(V(PLT_X0 + 1.1 + i * 1.24, DECK_Y, PLT_Z0 + 0.90));
        }
        return out;
      })(),
      transformer: V(PLT_X1 - 1.7, DECK_Y, PLT_Z1 - 1.5),
      ahu: V(PLT_X0 + 2.2, DECK_Y, PLT_Z1 - 1.2),
      trenchZ: (PLT_Z0 + PLT_Z1) * 0.5
    };

    A.hall = {
      x0: RG_X0, x1: RG_X1, hz: RG_HZ, deckY: DECK_Y, ceil: RG_CEIL,
      centre: V((RG_X0 + RG_X1) * 0.5, DECK_Y, 0),
      portal: V(HALL_DOOR_X, DECK_Y, 0),
      wellX0: WELL_X0, wellX1: WELL_X1, wellZ0: WELL_Z0, wellZ1: WELL_Z1,
      westDeck: V((RG_X0 + WELL_X0) * 0.5, DECK_Y, 0),
      eastDeck: V((WELL_X1 + RG_X1) * 0.5, DECK_Y, 0),
      northDeck: V((RG_X0 + RG_X1) * 0.5, DECK_Y, (WELL_Z1 + RG_HZ) * 0.5),
      southDeck: V((RG_X0 + RG_X1) * 0.5, DECK_Y, (WELL_Z0 - RG_HZ) * 0.5),
      heatExchangers: [V(19.5, DECK_Y, 11.30), V(28.9, DECK_Y, 11.30),
                       V(16.4, DECK_Y, -11.30)],
      groundY: function (x, z) { return deckY(x, z, N); }
    };

    A.reactor = {
      centre: V(REAC_CX, DECK_Y, REAC_CZ),
      bioR: BIO_R, bioTop: BIO_TOP, vesselR: VES_R, vesselTop: VES_TOP,
      domeTop: DOME_TOP, stalkTop: STALK_TOP,
      platR0: PLAT_R0, platR1: PLAT_R1, platY: DECK_Y,
      gantryY: GANT_Y, gantryR0: GANT_R0, gantryR1: GANT_R1,
      craneY: CRANE_Y, craneX: CRANE_X,
      bridges: [
        { name: 'west', from: V(WELL_X0, DECK_Y, 0),
          to: V(REAC_CX - PLAT_R1, DECK_Y, 0), hw: BRIDGE_HW_W,
          walkZ: [-BRIDGE_HW_W, 0.60], rackZ: [0.60, BRIDGE_HW_W] },
        { name: 'north', from: V(REAC_CX, DECK_Y, WELL_Z0),
          to: V(REAC_CX, DECK_Y, REAC_CZ - PLAT_R1), hw: BRIDGE_HW_N }
      ],
      gantryBridge: { y: GANT_Y, z: -3.60, x0: REAC_CX + 7.0, x1: RG_X1 - 1.58 },
      gantryStair: { x: RG_X1 - 2.2, z0: -3.60, z1: 4.20, y0: DECK_Y, y1: GANT_Y },
      coolantY: 0.78, coolantZ: [0.95, 1.43, 1.91, 2.39], coolantOverY: 3.05
    };

    A.lower = {
      floorY: PIT_Y, waterY: WATER_Y,
      centre: V(REAC_CX, PIT_Y, REAC_CZ),
      x0: WELL_X0, x1: WELL_X1, z0: WELL_Z0, z1: WELL_Z1,
      innerR: BIO_R,
      ring: [V(WELL_X0 + 2.0, PIT_Y, 0), V(WELL_X1 - 2.0, PIT_Y, 0),
             V(REAC_CX, PIT_Y, WELL_Z0 + 2.0), V(REAC_CX, PIT_Y, WELL_Z1 - 2.0)],
      stair: { x0: STAIR_X0, x1: STAIR_X1, z0: STAIR_Z0, z1: STAIR_Z1,
        head: V((STAIR_X0 + STAIR_X1) * 0.5, DECK_Y, STAIR_Z1),
        foot: V((STAIR_X0 + STAIR_X1) * 0.5, PIT_Y, STAIR_Z0),
        groundY: function (z) { return stairY(z); } },
      sump: V(16.6, PIT_Y - 0.22, -7.6),
      pumps: [V(16.6, PIT_Y, -6.6), V(31.4, PIT_Y, 5.4), V(24.0, PIT_Y, 7.9),
              V(18.4, PIT_Y, 7.6), V(30.2, PIT_Y, -7.4)]
    };

    A.lamps = [];
    A.beacons = [];
    A.spawn = { centre: V(SPN_X0 + 3.0, DECK_Y, 0.30), yaw: -Math.PI * 0.5 };
    return A;
  }

  // ---- material access, defensively -----------------------------------------
  // Every bunker surface is requested BY THE NAME IN ITS OWN TABLE, and that
  // name is checked against materials.js first. The library does not know
  // 'deck_conc' - it is not supposed to - so the request resolves to the
  // calibrated library entry named in `base`, WITHOUT this file second-guessing
  // its roughness, metalness or albedo. The col/rough fields in SURF exist only
  // for the no-materials.js path below, where nothing has calibrated anything.
  LevelBunker.prototype.material = function (key) {
    if (this._matCache[key]) return this._matCache[key];
    var surf = SURF[key] || SURF.wall_conc;
    var m = null;
    var lib = this.ctx && this.ctx.materials;
    var libHas = false;
    try { libHas = !!(lib && typeof lib.has === 'function' && lib.has(key)); }
    catch (e) { libHas = false; }

    if (key === 'decal') {
      m = this._decalMaterial();
    } else if (key === 'glint') {
      m = this._glintMaterial();
    } else if (lib && typeof lib.get === 'function') {
      var name = libHas ? key : (surf.base || 'concrete');
      var opts = { vertexColors: true, wearMode: surf.wear ? 'wear' : 'multiply' };
      try { m = lib.get(name, opts); }
      catch (e2) { GAME.logError('bunker.material:' + key, e2); m = null; }
    }
    if (!m || !m.isMaterial) m = this._fallbackMaterial(key);
    this._matCache[key] = m;
    return m;
  };

  LevelBunker.prototype._fallbackMaterial = function (key) {
    var fb = FALLBACK[key] || FALLBACK.wall_conc;
    var surf = SURF[key] || SURF.wall_conc;
    var m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(fb[0], THREE.SRGBColorSpace),
      roughness: fb[1], metalness: fb[2],
      // A stock material has no wear shader, so a WEAR MASK written into the
      // colour attribute would be multiplied straight onto albedo - which
      // renders a soaked pit floor (R 0.5 / G 0.1 / B 0.9) as bright purple.
      vertexColors: !surf.wear,
      envMapIntensity: 1.0
    });
    m.name = 'bunker_fallback_' + key;
    return m;
  };

  LevelBunker.prototype._decalMaterial = function () {
    var tex = null;
    try { tex = buildAtlas(this.rng.fork ? this.rng.fork(0x5349474E) : this.rng); }
    catch (e) { GAME.logError('bunker.atlas', e); tex = null; }
    this._atlasOk = !!tex;
    var m = new THREE.MeshStandardMaterial({
      map: tex, color: 0xffffff, roughness: 0.84, metalness: 0.0,
      transparent: true, depthWrite: false, alphaTest: 0.05,
      vertexColors: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3
    });
    try {
      var caps = this.ctx && this.ctx.renderer && this.ctx.renderer.capabilities;
      if (tex && caps && caps.getMaxAnisotropy) {
        tex.anisotropy = Math.max(1, Math.min(8, caps.getMaxAnisotropy() || 1));
      }
    } catch (e2) { /* anisotropy is a nicety */ }
    m.name = 'bunker_signage';
    return m;
  };

  LevelBunker.prototype._glintMaterial = function () {
    var tex = null;
    try { tex = glintTexture(); } catch (e) { tex = null; }
    var m = new THREE.MeshBasicMaterial({
      map: tex, color: 0xffffff, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, vertexColors: true,
      side: THREE.DoubleSide, toneMapped: false, fog: true
    });
    if (!tex) m.opacity = 0.0;
    m.name = 'bunker_glint';
    return m;
  };

  // ---- colliders -------------------------------------------------------------
  LevelBunker.prototype.addCollider = function (cx, cy, cz, hx, hy, hz, material, isFloor, euler) {
    var q = new THREE.Quaternion();
    if (euler) q.setFromEuler(euler);
    var c = {
      type: 'box',
      center: new THREE.Vector3(cx, cy, cz),
      halfExtents: new THREE.Vector3(Math.abs(hx), Math.abs(hy), Math.abs(hz)),
      quaternion: q,
      material: material || 'concrete',
      floor: !!isFloor
    };
    this.colliders.push(c);
    return c;
  };

  // ---- build -----------------------------------------------------------------
  LevelBunker.prototype.build = async function (ctx) {
    if (ctx) this.ctx = ctx;
    var self = this;
    var rng = this.rng, N = this.noise;
    var B = new Builder();

    function stage(name, fn) {
      try { fn(); } catch (e) { GAME.logError('bunker.' + name, e); }
    }

    stage('vestibule', function () { buildVestibule(self, B, rng, N); });
    await GAME.yieldFrame();

    stage('spine', function () { buildSpine(self, B, rng, N); });
    stage('plant', function () { buildPlant(self, B, rng, N); });
    await GAME.yieldFrame();

    stage('control', function () { buildControlRoom(self, B, rng, N); });
    await GAME.yieldFrame();

    stage('hall', function () { buildReactorHall(self, B, rng, N); });
    await GAME.yieldFrame();

    stage('water', function () { buildWater(self, B, rng, N); });
    stage('lighting', function () { buildLighting(self, B, rng, N); });
    await GAME.yieldFrame();

    stage('merge', function () { self._finalize(B); });
    stage('emitters', function () { self._buildEmitters(); });
    stage('sweeps', function () { self._buildSweeps(); });
    await GAME.yieldFrame();

    stage('nav', function () { self._buildNav(); });
    stage('spawns', function () { self._buildSpawns(); });
    stage('broadphase', function () { self._buildBroadphase(); });

    if (this.ctx && this.ctx.scene) this.ctx.scene.add(this.root);

    _boxCache.forEach(function (g) { g.dispose(); }); _boxCache.clear();
    _cylCache.forEach(function (g) { g.dispose(); }); _cylCache.clear();
    _quadCache.forEach(function (g) { g.dispose(); }); _quadCache.clear();
    return this;
  };

  // ---- merge + vertex-colour pass ---------------------------------------------
  LevelBunker.prototype._finalize = function (B) {
    var keys = Object.keys(B.buckets);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var entries = B.buckets[key];
      if (!entries || !entries.length) continue;
      var surf = SURF[key] || SURF.wall_conc;
      if (key === 'decal') {
        this.material('decal');
        if (!this._atlasOk) { B.buckets[key] = null; continue; }
      }
      var geo;
      try { geo = Geo.mergeAll(entries); }
      catch (e) { GAME.logError('bunker.merge:' + key, e); continue; }
      // keepUV means the source authored its own UVs (the atlas cards, the
      // glint streaks). mergeAll drops the whole uv attribute if ANY entry in
      // the bucket lacks one, so the second clause is not belt and braces:
      // without it a single un-UV'd solid landing in a keepUV bucket hands a
      // mapped material a geometry with no uv at all.
      if (!surf.keepUV || !geo.attributes.uv) Geo.worldUV(geo, surf.uv);
      Geo.copyUV1(geo);
      try { this._paint(key, entries, geo); }
      catch (e2) { GAME.logError('bunker.paint:' + key, e2); }
      geo.computeBoundingSphere();
      var mesh = new THREE.Mesh(geo, this.material(key));
      mesh.name = 'bunker_' + key;
      mesh.castShadow = surf.cast;
      mesh.receiveShadow = surf.recv;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      if (key === 'decal') mesh.renderOrder = 2;
      if (key === 'glint') mesh.renderOrder = 3;
      this.root.add(mesh);
      this.meshes.push(mesh);
      B.buckets[key] = null;
    }
  };

  // Vertex colours. On a `wear` surface this is materials.js's WEAR MASK -
  // white = pristine, R grime, G wetness, B edge/dust - and B is what carries
  // this level: it mixes the surface toward a PALE substrate, which is exactly
  // what forty years of settled concrete dust does to a horizontal face. On
  // everything else the attribute is a plain albedo multiplier.
  LevelBunker.prototype._paint = function (key, entries, geo) {
    var pos = geo.attributes.position, nrm = geo.attributes.normal;
    var pa = pos.array, na = nrm.array;
    var Nv = pos.count;
    var col = new Float32Array(Nv * 3);
    var noise = this.noise;
    var W = this.wetness;
    var surf = SURF[key] || SURF.wall_conc;
    var isWear = !!surf.wear;
    var vi = 0, e, i, j;

    for (e = 0; e < entries.length; e++) {
      var ent = entries[e];
      var cnt = vertCount(ent.geometry);
      var tr = 1, tg = 1, tb = 1;
      if (ent.tint) { tr = ent.tint.r; tg = ent.tint.g; tb = ent.tint.b; }
      var dk = ent.dark ? Math.max(0.05, 1 - ent.dark) : 1;
      var mode;
      // Force the mode to agree with the surface's shader: a multiplier written
      // into a wear mask (or the reverse) is a silent, catastrophic bug.
      if (isWear) {
        if (key === 'deck_conc') mode = 'floor';
        else if (key === 'flood') mode = 'water';
        else if (key === 'paint_line') mode = 'line';
        else if (key === 'grate') mode = 'grate';
        else if (key === 'ceil_conc') mode = 'ceil';
        else if (key === 'rubble') mode = 'rub';
        else mode = 'wall';
      } else if (key === 'decal' || key === 'glint') {
        mode = 'flat';
      } else if (key === 'hull_paint') {
        mode = 'hull';
      } else if (ent.paint === 'clad') {
        mode = 'clad';
      } else if (ent.paint === 'glass') {
        mode = 'glassm';
      } else if (ent.paint === 'cable') {
        mode = 'cablem';
      } else if (ent.paint === 'paint') {
        mode = 'paintm';
      } else {
        mode = 'metal';
      }

      for (i = 0; i < cnt; i++) {
        j = (vi + i) * 3;
        var x = pa[j], y = pa[j + 1], z = pa[j + 2];
        var nx = na[j], ny = na[j + 1], nz = na[j + 2];
        var r, g, b;
        // Below the deck the facility is genuinely under water; above it, it is
        // dust. One test, used by every branch, so the two never blend.
        var sub = M.smoothstep(-3.10, -4.20, y);

        if (mode === 'floor') {
          // ---- DUST --------------------------------------------------------
          // The whole deck carries a settled film, thinner down the routes feet
          // still use. B brightens toward a pale substrate, so this is what
          // stops 1000 sq m of grey concrete being one flat value.
          var route = M.smoothstep(2.4, 0.35, Math.abs(z));           // the spine
          route = Math.max(route, M.smoothstep(3.0, 0.6, Math.abs(z - 0.0)) *
            M.smoothstep(RG_X0 - 1, RG_X0 + 3, x));
          route *= 0.55 + 0.45 * (noise.fbm2(x * 0.42 - 4, z * 0.42 + 1, 2) * 0.5 + 0.5);
          var dust = M.saturate(0.30 + 0.34 * (noise.fbm2(x * 0.19 + 2.5, z * 0.19 - 6.1, 3) * 0.5 + 0.5)
            - route * 0.42);
          // ---- GRIME -------------------------------------------------------
          var gm = M.saturate(0.16 + 0.24 * (noise.fbm2(x * 0.14 + 5, z * 0.14 - 3, 3) * 0.5 + 0.5) +
            route * 0.26);
          gm = M.saturate(gm + M.smoothstep(2.2, 0.05, Math.abs(Math.abs(z) - SPN_HZ)) * 0.16);
          // ---- DAMP --------------------------------------------------------
          var dip = deckDip(x, z, noise);
          var pud = M.saturate((dip - 0.030) / 0.028);
          var wet = M.saturate(0.05 + W * 0.22 + pud * 0.34 + sub * 0.86);
          r = 1 - gm * 0.72; g = 1 - wet; b = 1 - M.saturate(dust * (1 - sub * 0.7));
        } else if (mode === 'water') {
          // Standing water as a wear mask. G is 0.30-0.46, i.e. two thirds of
          // the way to soaked, NOT 0.95: the contract takes roughness to 0.09 at
          // full wetness, and 0.09 is a mirror, which in a level with nothing to
          // reflect returns nothing at all and photographs as a hole in the
          // floor. Two thirds lands roughness around 0.30-0.42, where a strip
          // light 8 m away becomes a metre of sheen instead of one hot texel.
          var rip = noise.fbm2(x * 1.25 + 6, z * 1.25 - 2, 3) * 0.5 + 0.5;
          var rip2 = noise.fbm2(x * 5.2, z * 5.2, 2) * 0.5 + 0.5;
          r = 0.90 - rip * 0.10;
          g = 0.44 + rip2 * 0.16;
          b = 0.92;
        } else if (mode === 'wall') {
          // Board-marked concrete: filthy at the base from mop and boot,
          // streaked from every fixing above, efflorescent where the ground
          // water comes through, and dusty on any face that is even half up.
          var hgt = y;
          var gw = M.saturate(0.20 + 0.30 * (noise.fbm3(x * 0.26, y * 0.40, z * 0.26, 3) * 0.5 + 0.5));
          gw += M.smoothstep(1.05, 0.02, hgt) * 0.30;
          gw += M.smoothstep(2.6, 4.4, hgt) * 0.12;
          var st = M.smoothstep(0.54, 0.94,
            noise.fbm2((Math.abs(nx) > Math.abs(nz) ? z : x) * 2.2, y * 0.13, 3) * 0.5 + 0.5);
          gw = M.saturate(gw + st * 0.26);
          var ww = M.saturate(0.04 + W * 0.22 + st * 0.22 * W + sub * 0.84 +
            M.smoothstep(-2.4, -4.4, y) * 0.30);
          var ew = M.saturate(M.smoothstep(0.62, 0.94, noise.fbm3(x * 1.2, y * 1.0, z * 1.2, 2) * 0.5 + 0.5) * 0.34
            + M.saturate(ny) * 0.34);
          r = 1 - gw * 0.70; g = 1 - ww; b = 1 - ew * (1 - sub * 0.6);
        } else if (mode === 'ceil') {
          // Soffits: sooty from forty years of a plant that vented indoors,
          // blotched, and weeping down every construction joint.
          var gc = M.saturate(0.28 + 0.32 * (noise.fbm3(x * 0.22, y * 0.5, z * 0.22, 4) * 0.5 + 0.5));
          gc += M.smoothstep(2.4, 4.0, y) * 0.14;
          var wc = M.saturate(0.06 + M.smoothstep(0.58, 0.94,
            noise.fbm2(x * 0.85 + 7, z * 0.85 - 4, 3) * 0.5 + 0.5) * 0.34 * W);
          var ec = M.smoothstep(0.72, 0.97, noise.fbm3(x * 1.0, y * 0.9, z * 1.0, 2) * 0.5 + 0.5) * 0.24;
          r = 1 - M.saturate(gc) * 0.74; g = 1 - wc; b = 1 - ec;
        } else if (mode === 'grate') {
          var gg = M.saturate(0.26 + 0.26 * (noise.fbm3(x * 0.8, y * 0.8, z * 0.8, 2) * 0.5 + 0.5));
          r = 1 - gg * 0.66;
          g = 1 - M.saturate(0.06 + W * 0.30 + sub * 0.70);
          b = 1 - M.saturate(M.smoothstep(0.42, 0.92, noise.fbm2(x * 2.0, z * 2.0, 2) * 0.5 + 0.5) * 0.30
            + M.saturate(ny) * 0.24);
        } else if (mode === 'line') {
          // Worn paint. It stands 13 mm proud of the slab, so it is the
          // brightest thing the markers have to find down there.
          var wn = noise.fbm2(x * 1.4 + 3, z * 1.4 - 6, 3) * 0.5 + 0.5;
          var worn = M.saturate(M.smoothstep(0.30, 0.88, wn) * 1.10);
          r = 1 - worn * 0.76;
          g = 1 - M.saturate(0.10 + W * 0.2 + sub * 0.7);
          b = 1 - M.saturate(worn * 0.20 + 0.18);
        } else if (mode === 'rub') {
          var gb = M.saturate(0.30 + 0.30 * (noise.fbm2(x * 0.55, z * 0.55, 3) * 0.5 + 0.5));
          r = 1 - gb * 0.72;
          g = 1 - M.saturate(0.06 + W * 0.2 + sub * 0.7);
          b = 1 - M.saturate(0.30 + M.saturate(ny) * 0.30);
        } else if (mode === 'flat') {
          r = 1; g = 1; b = 1;
        } else if (mode === 'glassm') {
          var gl = 0.86 + (noise.fbm2(x * 1.4, y * 1.4, 2) * 0.5 + 0.5) * 0.22;
          r = gl; g = gl * 1.01; b = gl * 1.04;
        } else if (mode === 'cablem') {
          var cbv = 0.82 + (noise.fbm3(x * 0.9, y * 0.9, z * 0.9, 2) * 0.5 + 0.5) * 0.28;
          cbv *= 1 - M.smoothstep(0.9, 0.02, y) * 0.20;
          r = cbv; g = cbv * 0.98; b = cbv * 0.97;
        } else if (mode === 'paintm') {
          // Red oxide primer: brushed on unevenly, chalked by dust, and
          // scuffed through to the concrete at every corner and skirting.
          var pv = 0.80 + (noise.fbm3(x * 0.7, y * 0.9, z * 0.7, 3) * 0.5 + 0.5) * 0.36;
          var chip = M.smoothstep(0.60, 0.93, noise.fbm2(x * 2.6 + 4, y * 2.6 - 2, 3) * 0.5 + 0.5);
          var scuff = M.smoothstep(0.35, 0.02, y - DECK_Y) * 0.40;
          r = pv * (1 + chip * 0.30 + scuff * 0.55);
          g = pv * (1 - chip * 0.12 + scuff * 0.62);
          b = pv * (1 - chip * 0.20 + scuff * 0.66);
        } else if (mode === 'hull') {
          // Painted plant. lime_wash is a pale wash, so the enamel's colour is
          // made here: a desaturated grey-green, streaked below every fixing,
          // dirty in the first metre off the floor and dusty on top.
          var f5 = 0.92 + (noise.fbm3(x * 1.0, y * 0.8, z * 1.0, 3) * 0.5 + 0.5) * 0.16;
          var s5 = M.smoothstep(0.58, 0.94, noise.fbm2((Math.abs(nx) > Math.abs(nz) ? z : x) * 2.3,
            y * 0.12, 3) * 0.5 + 0.5) * M.saturate(1 - Math.abs(ny));
          f5 *= 1 - s5 * 0.24;
          f5 *= 1 - M.smoothstep(1.15, 0.04, y - DECK_Y) * 0.24;
          if (ny > 0.4) f5 *= 1.12;
          var wetH = M.saturate(W * 0.20 + sub * 0.45);
          r = f5 * 1.44 * (1 + s5 * 0.16) * (1 - wetH * 0.22);
          g = f5 * 1.70 * (1 - s5 * 0.02) * (1 - wetH * 0.24);
          b = f5 * 1.62 * (1 - s5 * 0.16) * (1 - wetH * 0.24);
        } else if (mode === 'clad') {
          // Painted plant: value variation, streaks below every fixing, dirt
          // thrown up off the floor, and dust on every up-facing surface.
          var f3 = 0.86 + (noise.fbm3(x * 1.05, y * 0.85, z * 1.05, 3) * 0.5 + 0.5) * 0.22;
          var s3 = M.smoothstep(0.58, 0.94, noise.fbm2((Math.abs(nx) > Math.abs(nz) ? z : x) * 2.2,
            y * 0.11, 3) * 0.5 + 0.5) * M.saturate(1 - Math.abs(ny));
          f3 *= 1 - s3 * 0.30;
          f3 *= 1 - M.smoothstep(1.3, 0.05, y - DECK_Y) * 0.26;
          if (ny > 0.4) f3 *= 1.10;                    // dust catches the light
          var wetC = M.saturate(W * 0.22 + sub * 0.50);
          r = f3 * (1 + s3 * 0.24) * (1 - wetC * 0.24);
          g = f3 * (1 - s3 * 0.04) * (1 - wetC * 0.26);
          b = f3 * (1 - s3 * 0.20) * (1 - wetC * 0.26);
        } else {
          // 'metal': tray, conduit, handrail, pipework, the door's ironmongery.
          // Rust blooms out of every joint, and the first metre off the floor is
          // filthy - and anything below the deck has been standing in water.
          var f4 = 0.76 + (noise.fbm3(x * 0.28, y * 0.26, z * 0.28, 3) * 0.5 + 0.5) * 0.38;
          var rs = M.smoothstep(0.46, 0.90, noise.fbm3(x * 0.80 + 3, y * 0.66, z * 0.80 - 4, 3) * 0.5 + 0.5);
          rs = M.saturate(rs + sub * 0.34);
          f4 *= 1 - M.smoothstep(0.9, 0.02, y - DECK_Y) * 0.24;
          if (ny > 0.4) f4 *= 1.08;
          var wetM = M.saturate(W * 0.24 + sub * (0.30 + 0.24 * M.saturate(ny)));
          r = f4 * (1 + rs * 0.44) * (1 - wetM * 0.30);
          g = f4 * (1 - rs * 0.10) * (1 - wetM * 0.32);
          b = f4 * (1 - rs * 0.42) * (1 - wetM * 0.32);
        }

        if (isWear) {
          col[j] = M.saturate(r); col[j + 1] = M.saturate(g); col[j + 2] = M.saturate(b);
        } else {
          col[j] = r * tr * dk; col[j + 1] = g * tg * dk; col[j + 2] = b * tb * dk;
        }
      }
      vi += cnt;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  };

  // ---- the emissive fittings ---------------------------------------------------
  LevelBunker.prototype._buildEmitters = function () {
    var n = this.emitters.length;
    if (!n || !THREE.InstancedMesh) return;
    var geo = new THREE.BoxGeometry(1, 1, 1);
    var mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, toneMapped: false, fog: true
    });
    var mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.name = 'bunker_emitters';
    mesh.castShadow = false; mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    var c = new THREE.Color();
    for (var i = 0; i < n; i++) {
      var e = this.emitters[i];
      mesh.setMatrixAt(i, e.m);
      c.copy(e.col).multiplyScalar(e.gain);
      mesh.setColorAt(i, c);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.root.add(mesh);
    this._emitMesh = mesh;
  };

  // ---- the sweeps ---------------------------------------------------------------
  // A pair of opposed additive wedges on a pivot, per beacon, spun in update().
  // Two wedges rather than one because that is what a rotating-mirror beacon
  // actually projects, and because a single arm leaves half the revolution with
  // nothing in frame at all.
  function beamGeometry(len, h0, h1, w0, w1) {
    var x0 = 0.16, x1 = len;
    var pos = [], uv = [], nor = [];
    function push(ax, ay, az, u, v) { pos.push(ax, ay, az); uv.push(u, v); nor.push(0, 0, 1); }
    function q(p0, p1, p2, p3) {
      push(p0[0], p0[1], p0[2], 0, 0); push(p1[0], p1[1], p1[2], 1, 0);
      push(p2[0], p2[1], p2[2], 1, 1);
      push(p0[0], p0[1], p0[2], 0, 0); push(p2[0], p2[1], p2[2], 1, 1);
      push(p3[0], p3[1], p3[2], 0, 1);
    }
    for (var s = -1; s <= 1; s += 2) {
      // the vertical blade
      q([x0 * s, -h0, 0], [x1 * s, -h1, 0], [x1 * s, h1, 0], [x0 * s, h0, 0]);
      // the horizontal blade
      q([x0 * s, 0, -w0], [x1 * s, 0, -w1], [x1 * s, 0, w1], [x0 * s, 0, w0]);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    return g;
  }

  LevelBunker.prototype._buildSweeps = function () {
    var tex = null;
    try { tex = beamTexture(); } catch (e) { tex = null; }
    if (!tex) return;
    for (var i = 0; i < this.sweeps.length; i++) {
      var d = this.sweeps[i];
      var geo = beamGeometry(d.len, 0.13, d.len * 0.105, 0.11, d.len * 0.130);
      var mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        toneMapped: false, fog: true
      });
      mat.color.setRGB(0.150 * d.gain, 0.0180 * d.gain, 0.0105 * d.gain);
      var mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'bunker_sweep_' + i;
      mesh.position.set(d.x, d.y, d.z);
      mesh.renderOrder = 4;
      mesh.frustumCulled = false;
      this.root.add(mesh);
      this._sweepMeshes.push({ mesh: mesh, def: d, base: mat.color.clone() });

      // The two `key` beacons also get a real rotating SpotLight. These are the
      // only lights this file owns rather than publishes; without them the
      // sweep is haze crossing an unlit wall, which reads as a decal.
      if (d.key && THREE.SpotLight) {
        var lt = new THREE.SpotLight(0xffffff, 0, d.len * 1.15, 0.30, 0.55, 2);
        lt.color.setRGB(1.0, 0.16, 0.09);
        lt.castShadow = false;
        lt.position.set(d.x, d.y, d.z);
        lt.target.position.set(d.x + d.len, d.y - 0.35, d.z);
        lt.name = 'bunker_beacon_' + i;
        this.root.add(lt);
        this.root.add(lt.target);
        this._beaconLights.push({ light: lt, def: d, intensity: 26 * d.gain });
      }
    }
  };

  // ---- walkable surfaces --------------------------------------------------------
  LevelBunker.prototype.sampleGround = function (x, z) {
    var N = this.noise;
    // the control room and its link
    if (x >= CTL_X0 && x <= CTL_X1 && z >= CTL_Z0 && z <= CTL_Z1) {
      return inCtlVoid(x, z) ? DECK_Y : ctlY(x, z);
    }
    if (x >= LINK_X0 && x <= LINK_X1 && z > LINK_Z0 - 0.4 && z < CTL_Z0) {
      return linkY(z);
    }
    // the reactor gallery
    if (x >= RG_X0 - 0.4) {
      if (inWell(x, z)) {
        if (x >= STAIR_X0 - 0.15 && x <= STAIR_X1 + 0.15 &&
            z >= STAIR_Z0 - 0.05 && z <= STAIR_Z1 + 0.05) return stairY(z);
        if (onBridge(x, z)) return DECK_Y;
        var d = reacDist(x, z);
        if (d >= PLAT_R0 - 0.1 && d <= PLAT_R1 + 0.1) return DECK_Y;
        return pitY(x, z, N);
      }
      return deckY(x, z, N);
    }
    return deckY(x, z, N);
  };

  LevelBunker.prototype._walkRects = function () {
    var R = [];
    // the spine, the vestibule, the approach and the plant room
    R.push({ x0: SPN_X0 + 0.4, x1: SPN_X1 - 0.4, z0: -SPN_HZ + 0.35, z1: SPN_HZ - 0.35, ground: true });
    R.push({ x0: VEST_X0 + 0.5, x1: VEST_X1 - 0.3, z0: -VEST_HZ + 0.5, z1: VEST_HZ - 0.5, ground: true });
    R.push({ x0: APPR_X0 + 7.4, x1: VEST_X0 - 0.4, z0: -APPR_HZ + 0.4, z1: APPR_HZ - 0.4, ground: true });
    R.push({ x0: PLT_X0 + 0.5, x1: PLT_X1 - 0.5, z0: PLT_Z0 + 0.5, z1: PLT_Z1 - 0.2, ground: true });
    // the link and the control room
    R.push({ x0: LINK_X0 + 0.3, x1: LINK_X1 - 0.3, z0: LINK_Z0 - 0.2, z1: CTL_Z0, ground: true });
    R.push({ x0: CTL_X0 + 0.5, x1: CTL_X1 - 0.5, z0: CTL_Z0 + 0.4, z1: CTL_Z1 - 0.5, ground: true });
    // the guard cabin
    R.push({ x0: VEST_X0 + 2.7, x1: VEST_X0 + 7.3, z0: VEST_HZ - 3.0, z1: VEST_HZ - 0.15, y: 2.95 });
    // the reactor gallery's four deck bands
    R.push({ x0: RG_X0 + 0.4, x1: RG_X1 - 0.4, z0: -RG_HZ + 0.5, z1: WELL_Z0 - 0.5, ground: true });
    R.push({ x0: RG_X0 + 0.4, x1: RG_X1 - 0.4, z0: WELL_Z1 + 0.5, z1: RG_HZ - 0.5, ground: true });
    R.push({ x0: RG_X0 + 0.4, x1: WELL_X0 - 0.5, z0: WELL_Z0, z1: WELL_Z1, ground: true });
    R.push({ x0: WELL_X1 + 0.5, x1: RG_X1 - 0.4, z0: WELL_Z0, z1: WELL_Z1, ground: true });
    // the bridges and the operating platform
    R.push({ x0: WELL_X0 - 0.2, x1: REAC_CX - PLAT_R1 + 0.4, z0: -BRIDGE_HW_W + 0.2, z1: 0.5, y: DECK_Y });
    R.push({ x0: REAC_CX - BRIDGE_HW_N + 0.2, x1: REAC_CX + BRIDGE_HW_N - 0.2,
      z0: WELL_Z0 - 0.2, z1: REAC_CZ - PLAT_R1 + 0.4, y: DECK_Y });
    R.push({ x0: REAC_CX - PLAT_R1, x1: REAC_CX + PLAT_R1, z0: REAC_CZ - PLAT_R1,
      z1: REAC_CZ + PLAT_R1, y: DECK_Y, ring: [PLAT_R0 + 0.25, PLAT_R1 - 0.25] });
    // the pit ring, in the water
    R.push({ x0: WELL_X0 + 0.5, x1: WELL_X1 - 0.5, z0: WELL_Z0 + 0.5, z1: WELL_Z1 - 0.5, ground: true });
    // the pit stair
    R.push({ x0: STAIR_X0 + 0.1, x1: STAIR_X1 - 0.1, z0: STAIR_Z0, z1: STAIR_Z1, ground: true });
    // the gantry ring and its bridge
    R.push({ x0: REAC_CX - GANT_R1, x1: REAC_CX + GANT_R1, z0: REAC_CZ - GANT_R1,
      z1: REAC_CZ + GANT_R1, y: GANT_Y, ring: [GANT_R0 + 0.25, GANT_R1 - 0.25] });
    R.push({ x0: REAC_CX + 7.0, x1: RG_X1 - 1.5, z0: -4.2, z1: -3.0, y: GANT_Y });
    return R;
  };

  LevelBunker.prototype._buildNav = function () {
    var cell = 0.60;
    var ox = APPR_X0 - 2, oz = -RG_HZ - 2;
    var w = Math.ceil((RG_X1 + 4 - ox) / cell);
    var h = Math.ceil((RG_HZ + 4 - oz) / cell);
    var walkable = new Uint8Array(w * h);
    var height = new Float32Array(w * h);
    var R = this._walkRects();
    var obst = [], i;
    for (i = 0; i < this.colliders.length; i++) {
      var c = this.colliders[i];
      if (c.floor) continue;
      var he = c.halfExtents, ce = c.center;
      obst.push([ce.x - he.x - 0.28, ce.x + he.x + 0.28, ce.z - he.z - 0.28, ce.z + he.z + 0.28,
        ce.y - he.y, ce.y + he.y]);
    }
    for (var iz = 0; iz < h; iz++) {
      var z = oz + (iz + 0.5) * cell;
      for (var ix = 0; ix < w; ix++) {
        var x = ox + (ix + 0.5) * cell;
        var y = -1e9;
        for (var r = 0; r < R.length; r++) {
          var q = R[r];
          if (x < q.x0 || x > q.x1 || z < q.z0 || z > q.z1) continue;
          if (q.ring) {
            var dr = reacDist(x, z);
            if (dr < q.ring[0] || dr > q.ring[1]) continue;
          }
          var ry = q.ground ? this.sampleGround(x, z) : q.y;
          if (ry > y) y = ry;
        }
        if (y < -1e8) continue;
        var ok = 1;
        for (i = 0; i < obst.length; i++) {
          var o = obst[i];
          if (x < o[0] || x > o[1] || z < o[2] || z > o[3]) continue;
          if (o[5] > y + 0.35 && o[4] < y + 1.75) { ok = 0; break; }
        }
        var idx = iz * w + ix;
        walkable[idx] = ok;
        height[idx] = y;
      }
    }
    this.navGrid = {
      origin: new THREE.Vector3(ox, 0, oz),
      cellSize: cell, w: w, h: h,
      walkable: walkable, height: height,
      at: function (px, pz) {
        var gx = Math.floor((px - ox) / cell), gz = Math.floor((pz - oz) / cell);
        if (gx < 0 || gz < 0 || gx >= w || gz >= h) return 0;
        return walkable[gz * w + gx];
      },
      heightAt: function (px, pz) {
        var gx = Math.floor((px - ox) / cell), gz = Math.floor((pz - oz) / cell);
        if (gx < 0 || gz < 0 || gx >= w || gz >= h) return 0;
        return height[gz * w + gx];
      }
    };
  };

  // ---- spawns and framings ------------------------------------------------------
  LevelBunker.prototype._buildSpawns = function () {
    var self = this;
    function sp(x, z, yaw, yOff) {
      self.spawnPoints.push({
        position: new THREE.Vector3(x, self.sampleGround(x, z) + (yOff || 0.02), z), yaw: yaw
      });
    }
    // [0] is the player: the west end of the spine, looking the full length of
    // it east toward the reactor gallery. Everything the level is about is
    // somewhere down that view.
    sp(SPN_X0 + 3.0, 0.30, -Math.PI * 0.5);
    sp(-24.0, -0.6, -Math.PI * 0.5);   sp(-8.0, 0.8, Math.PI * 0.5);
    sp(11.6, -3.4, -Math.PI * 0.5);    sp(11.6, 4.2, -Math.PI * 0.5);
    sp(24.0, -11.4, 0);                sp(24.0, 11.4, Math.PI);
    sp(35.0, 0.0, Math.PI * 0.5);      sp(RG_X0 + 2.4, -7.0, -Math.PI * 0.5);
    sp(-22.0, 7.4, 0);                 sp(-18.0, 13.0, Math.PI);
    sp(VEST_X0 + 4.0, -2.0, -Math.PI * 0.5);
    sp(VEST_X0 + 9.0, 3.0, Math.PI * 0.5);
    sp(PLT_X0 + 4.0, PLT_Z0 + 3.0, 0);
    sp(17.0, 5.0, Math.PI);            sp(30.5, -5.0, 0);

    // ---------------------------------------------------------------- framings --
    // Every pose is a position plus a look-at target that is an actual object in
    // the facility, so the composition survives the geometry moving. Eye heights
    // are MEASURED off the deck, never assumed: the slab settles up to 9 cm and
    // a hard-coded 1.68 would float.
    var V = THREE.Vector3;
    function pose(px, py, pz, tx, ty, tz) {
      var dx = tx - px, dy = ty - py, dz = tz - pz;
      var horiz = Math.sqrt(dx * dx + dz * dz);
      return {
        position: new V(px, py, pz),
        yaw: Math.atan2(-dx, -dz),
        pitch: Math.atan2(dy, Math.max(1e-4, horiz))
      };
    }

    // ---- OVERVIEW ----------------------------------------------------------
    // From the gantry bridge at the east end of the reactor hall, 7.3 m up,
    // looking west across the vessel. There is no "wide open" in a buried
    // facility and pretending otherwise photographs a wall, so the establishing
    // frame is the one room with any volume in it, seen from its own high level:
    // the vessel and its drive stalks centre frame, the crane girder crossing
    // above, the operating platform and the flooded well below, the west wall
    // and the spine portal closing it 25 m away.
    var overview = pose(32.60, GANT_Y + 1.62, -3.60, 18.60, 4.35, 1.60);

    // ---- HERO1 - the signature ---------------------------------------------
    // Standing on the west deck band where you come out of the spine. Reading
    // outward:
    //   * the well kerb and its red strip run across the bottom of frame
    //   * the WEST BRIDGE runs dead ahead - grating walkway left, a four-line
    //     pipe rack right, both converging on the bioshield
    //   * six coolant lines overhead do the same thing 3 m up
    //   * the vessel fills the middle third: bioshield, welded courses, girth
    //     seams, the head dome and twenty-six drive stalks
    //   * the flooded well drops away either side with the emergency strips
    //     doubled in the water
    //   * a beacon on the wall behind the left shoulder lays a red bar across
    //     the vessel flank, and the rigged worklight on the deck is the only
    //     warm thing in the frame
    var h1x = 11.60, h1z = 0.10;
    var hero1 = pose(h1x, this.sampleGround(h1x, h1z) + 1.68, h1z,
      REAC_CX - 1.20, 3.30, -0.30);

    // ---- HERO2 - the spine -------------------------------------------------
    // 21 m of corridor at 3.9 m wide and 2.86 m high, which is the level's
    // claustrophobic argument stated once. The mid blast door frame stands 9 m
    // ahead as the subject with its leaf dogged back and a beacon over it; the
    // cable trays, the downstand beams and the two escape-marker lines all
    // converge on the lit reactor portal beyond.
    var h2x = -12.60, h2z = 0.42;
    var hero2 = pose(h2x, this.sampleGround(h2x, h2z) + 1.66, h2z,
      2.00, 1.30, -0.25);

    // ---- HERO3 - the blast door --------------------------------------------
    // The landmark. The plug is stopped 2.9 m into its pocket with the rams
    // still extended; the rigged flood on the vestibule wall rakes across its
    // chevrons and throws the ram shadows the length of the floor. The rails run
    // out of the bottom of frame to the aperture, and the guard cabin's lit
    // window sits high on the right.
    var h3x = -36.20, h3z = 2.60;
    var hero3 = pose(h3x, this.sampleGround(h3x, h3z) + 1.68, h3z,
      DOOR_X, 1.95, DOOR_OPEN * 0.5);

    // ---- HERO4 - the flooded lower level -----------------------------------
    // Wading the west leg of the pit ring: 4 m wide, 4.6 m below the deck, 58 cm
    // of standing water. The bioshield curves away on the right, the pit wall
    // runs out on the left with the stair descending toward the eye, the west
    // bridge crosses overhead, and every emergency strip is doubled in the
    // water. Pitched slightly UP, because the whole point of being down here is
    // that the facility is above you.
    var h4x = 17.20, h4z = 6.60;
    var hero4 = pose(h4x, this.sampleGround(h4x, h4z) + 1.66, h4z,
      17.00, -2.20, -8.40);

    // ---- INTERIOR - the control room ---------------------------------------
    // The enclosed space. Across two rows of dead CRT consoles to the status
    // wall, with three of its eight bays still backlit; the suspended ceiling
    // has come down over the near half so the frame has a torn edge across its
    // top, and one live tube burns amber on the left.
    var icx = -27.90, icz = 9.30;
    var interior = pose(icx, this.sampleGround(icx, icz) + 1.66, icz,
      -21.50, 2.05, CTL_Z1 - 0.50);

    this.cameraPoses = {
      overview: overview, hero1: hero1, hero2: hero2, hero3: hero3, hero4: hero4,
      interior: interior,
      // aliases so the shared market/harbor scenario names still resolve to
      // something sensible if anyone points one at this level
      street: hero2, containers: hero1, quay: hero1, crane: overview,
      warehouse: interior, gangway: hero4, alley: hero2, rooftop: overview
    };
  };

  // ---- broadphase + raycast -----------------------------------------------------
  LevelBunker.prototype._buildBroadphase = function () {
    var min = new THREE.Vector3(), max = new THREE.Vector3();
    this._hash.clear();
    for (var i = 0; i < this.colliders.length; i++) {
      var c = this.colliders[i];
      c._id = i;
      c._stamp = -1;
      GAME.Collision.boxBounds(c, min, max);
      this._hash.insert(c, min, max);
    }
  };

  var _rcDir = new THREE.Vector3();
  var _rcHit = { point: new THREE.Vector3(), normal: new THREE.Vector3() };

  LevelBunker.prototype.raycast = function (origin, dir, maxDist) {
    var out = {
      hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
      material: null, distance: maxDist === undefined ? Infinity : maxDist, collider: null
    };
    if (!origin || !dir) return out;
    maxDist = (maxDist === undefined || maxDist <= 0) ? 400 : maxDist;
    out.distance = maxDist;
    var d = _rcDir.copy(dir);
    var dl = d.length();
    if (dl < 1e-9) return out;
    d.multiplyScalar(1 / dl);

    var cell = this._hash.cell;
    var stamp = ++this._stamp;
    var ix = Math.floor(origin.x / cell), iy = Math.floor(origin.y / cell), iz = Math.floor(origin.z / cell);
    var sx = d.x > 0 ? 1 : -1, sy = d.y > 0 ? 1 : -1, sz = d.z > 0 ? 1 : -1;
    var ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
    var tdx = ax > 1e-9 ? cell / ax : Infinity;
    var tdy = ay > 1e-9 ? cell / ay : Infinity;
    var tdz = az > 1e-9 ? cell / az : Infinity;
    var tmx = ax > 1e-9 ? ((d.x > 0 ? (ix + 1) * cell - origin.x : origin.x - ix * cell) / ax) : Infinity;
    var tmy = ay > 1e-9 ? ((d.y > 0 ? (iy + 1) * cell - origin.y : origin.y - iy * cell) / ay) : Infinity;
    var tmz = az > 1e-9 ? ((d.z > 0 ? (iz + 1) * cell - origin.z : origin.z - iz * cell) / az) : Infinity;

    var best = maxDist, bestC = null;
    var map = this._hash.map, keyOf = this._hash._key;
    var guard = 0;
    var t = 0;
    while (t <= maxDist && guard++ < 1400) {
      var bucket = map.get(keyOf.call(this._hash, ix, iy, iz));
      if (bucket) {
        for (var i = 0; i < bucket.length; i++) {
          var c = bucket[i];
          if (c._stamp === stamp) continue;
          c._stamp = stamp;
          var hitT = GAME.Collision.raycastBox(origin, d, c, _rcHit);
          if (hitT >= 0 && hitT < best) {
            best = hitT; bestC = c;
            out.point.copy(_rcHit.point);
            out.normal.copy(_rcHit.normal);
          }
        }
      }
      var tNext = Math.min(tmx, Math.min(tmy, tmz));
      if (bestC && best <= tNext) break;
      t = tNext;
      if (tmx <= tmy && tmx <= tmz) { ix += sx; tmx += tdx; }
      else if (tmy <= tmz) { iy += sy; tmy += tdy; }
      else { iz += sz; tmz += tdz; }
      if (!isFinite(t)) break;
    }
    if (bestC) {
      out.hit = true;
      out.distance = best;
      out.collider = bestC;
      out.material = bestC.material;
    }
    return out;
  };

  // ---- per frame ------------------------------------------------------------------
  // The facility is static. Its LIGHT is not, and that is the whole difference
  // between an abandoned building and a dressed set. Every driver here is noise,
  // never a sine - a sine reads as an animation curve within about two cycles,
  // which is exactly how a flickering light in a game gives itself away - except
  // the beacons, whose rotation IS periodic and has to be.
  var _tmpCol = new THREE.Color();

  LevelBunker.prototype.update = function (dt, ctx) {
    this._t += (dt || 0);
    var t = this._t;
    var N = this.noise;
    var i;

    var mesh = this._emitMesh;
    if (mesh && mesh.instanceColor) {
      var c = _tmpCol;
      var n = this.emitters.length;
      for (i = 0; i < n; i++) {
        var e = this.emitters[i];
        var mul = 1;
        if (e.kind === 'fluoro') {
          // a working tube on a failing supply: a fast shallow ripple over a
          // slow sag
          mul = 1 + N.perlin2(t * 6.4 + e.phase, 7.7) * 0.050 +
            N.perlin2(t * 0.19 + e.phase, 29.5) * 0.080;
        } else if (e.kind === 'dying') {
          // strike, run, go unstable, drop out. Two decorrelated fields: the
          // slow one is the duty cycle, the fast one is the arc fighting for it.
          var s1 = N.perlin2(t * 0.44 + e.phase, 13.1);
          var s2 = N.fbm2(t * 4.9 + e.phase, 41.0, 3, 2, 0.55);
          var duty = M.smoothstep(-0.18, 0.16, s1);
          mul = M.clamp(duty * 0.60 + M.smoothstep(0.22, 0.85, duty) * (0.45 + 0.45 * s2) + s2 * 0.08,
            0.012, 1.30);
        } else if (e.kind === 'emerg') {
          // battery-backed gear is rock steady, with a mains ripple on the few
          // still fed off the ring main
          mul = 1 + N.perlin2(t * 1.6 + e.phase, 23.0) * 0.028;
        } else if (e.kind === 'work') {
          mul = 1 + N.perlin2(t * 0.52 + e.phase, 61.0) * 0.05;
        } else if (e.kind === 'beacon') {
          // the lens is a drum, so what the eye sees pulse is the mirror passing
          // behind it - twice per revolution, softened by the diffuser
          mul = 0.72 + 0.36 * Math.abs(Math.sin(t * 2.35 + e.phase));
        } else if (e.kind === 'crt') {
          // raster roll plus the occasional frame the flyback loses
          var roll = 0.86 + 0.16 * N.perlin2(t * 3.1 + e.phase, 5.5);
          mul = roll * (N.perlin2(t * 0.7 + e.phase, 17.0) > 0.42 ? 0.35 : 1.0);
        }
        c.copy(e.col).multiplyScalar(e.gain * mul);
        mesh.setColorAt(i, c);
      }
      mesh.instanceColor.needsUpdate = true;
    }

    // ---- the sweeps --------------------------------------------------------
    for (i = 0; i < this._sweepMeshes.length; i++) {
      var sm = this._sweepMeshes[i];
      var a = sm.def.phase + t * sm.def.speed;
      sm.mesh.rotation.y = a;
      // The wedge brightens as it swings past the eye and dims edge-on. Cheap,
      // and it is most of what makes a rotating beacon read as rotating in a
      // still frame rather than as a red triangle stuck to a wall.
      var puls = 0.80 + 0.30 * Math.abs(Math.sin(a));
      sm.mesh.material.color.copy(sm.base).multiplyScalar(puls);
    }
    for (i = 0; i < this._beaconLights.length; i++) {
      var bl = this._beaconLights[i];
      var ba = bl.def.phase + t * bl.def.speed;
      // local +X under a Y rotation of `a` maps to (cos a, 0, -sin a)
      bl.light.target.position.set(
        bl.def.x + Math.cos(ba) * bl.def.len,
        bl.def.y - bl.def.len * 0.26,
        bl.def.z - Math.sin(ba) * bl.def.len);
      bl.light.target.updateMatrixWorld();
      bl.light.intensity = bl.intensity;
    }
  };

  GAME.LevelBunker = LevelBunker;
})(window.GAME, window.THREE);
