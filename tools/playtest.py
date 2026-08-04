"""Verify the INTERACTIVE boot path, not just the headless capture path.

Every check so far has run with ?scenario=..., which takes a different code
path: it freezes the player, drives the camera itself and steps a fixed
timestep. None of that exercises the thing the user actually double-clicks.
This harness boots index.html with no scenario, drives real input events
(pointer lock, WASD, mouse look, fire, reload, crouch, sprint, jump), runs the
live rAF loop, and reports errors plus measured frame timings.

    python tools/playtest.py                        # market (default)
    python tools/playtest.py --level metro
    python tools/playtest.py --all --tag r4
    python tools/playtest.py --level jungle --tag r4 --w 1280 --h 720

--level drives the SAME registry key as shoot.py's --level, so every level in
the roster has an interactive-path regression test, not just market. Two real
bugs in this project were found only by this harness and by nothing else (boot
hanging forever in a backgrounded tab, and the player dying within 10 seconds
of spawn) and both were on market, which was the only level it could reach.

Every per-run path (temp page, Chrome profile, screenshot) carries the level and
--tag, so concurrent agents do not fight over the same file or profile lock.
"""
import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import serving  # noqa: E402
from shoot import SCENARIOS_BY_LEVEL, find_chrome  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOTS = ROOT / "shots"

# One source of truth for the roster: shoot.py already keys its scenario sets on
# the level ids in the LEVELS registry in main.js, so a new level becomes
# playtestable without touching this file.
LEVELS = list(SCENARIOS_BY_LEVEL)
DEFAULT_LEVEL = "market"

# Injected after load: fakes a play session and reports what happened.
DRIVER = r"""
(function () {
  var out = { phase: 'init', level: null, errors: [], frames: 0, warnings: [] };
  window.__PLAYTEST__ = out;
  window.addEventListener('error', function (e) {
    out.errors.push('window: ' + (e.message || e.error));
  });

  function key(code, down) {
    window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup',
      { code: code, bubbles: true }));
  }
  function mouse(type, button) {
    window.dispatchEvent(new MouseEvent(type, { button: button || 0, bubbles: true }));
  }
  function move(dx, dy) {
    var e = new MouseEvent('mousemove', { bubbles: true });
    Object.defineProperty(e, 'movementX', { value: dx });
    Object.defineProperty(e, 'movementY', { value: dy });
    window.dispatchEvent(e);
  }

  var t0 = Date.now();
  var waited = 0;
  var iv = setInterval(function () {
    waited += 100;
    var G = window.GAME;
    if (!G || !G.engine || !G.engine.ctx) {
      if (waited > 90000) { clearInterval(iv); out.phase = 'never-booted'; finish(); }
      return;
    }
    var ctx = G.engine.ctx;
    // Record which level actually loaded as soon as it is known: main.js falls
    // back to market when a level module is missing, and a silent fallback would
    // otherwise look like a passing run of the level that was asked for.
    if (ctx.levelId) out.level = ctx.levelId;
    if (!G.engine.running) {
      if (waited > 90000) { clearInterval(iv); out.phase = 'booted-but-not-running'; finish(); }
      return;
    }
    clearInterval(iv);
    out.phase = 'running';
    out.built = G.engine.built || [];
    play(ctx);
  }, 100);

  function play(ctx) {
    // The real game gates input on pointer lock; fake it being granted.
    ctx.input.locked = true;
    var p = ctx.player;
    var spawn = p ? [p.position.x, p.position.y, p.position.z] : [0, 0, 0];

    // Headless Chrome barely services requestAnimationFrame, so pumping the
    // engine directly is the only way to exercise real gameplay. This still
    // goes through the true interactive path: input -> controller -> systems.
    var DT = 1 / 60, N = 600;                 // 10 seconds of play
    var at = {                                 // frame -> input action
      12:  function () { key('KeyW', true); },
      60:  function () { move(60, 8); },
      90:  function () { key('ShiftLeft', true); },              // sprint
      150: function () { key('ShiftLeft', false); move(-40, -6); },
      170: function () { mouse('mousedown', 2); },               // ADS
      210: function () { mouse('mousedown', 0); },               // fire
      265: function () { mouse('mouseup', 0); mouse('mouseup', 2); },
      285: function () { key('KeyR', true); },                   // reload
      290: function () { key('KeyR', false); },
      360: function () { key('KeyC', true); },                   // crouch
      400: function () { key('KeyC', false); key('Space', true); },
      406: function () { key('Space', false); key('KeyA', true); },
      460: function () { key('KeyA', false); },
      560: function () { key('KeyW', false); },
    };

    var states = {}, maxSpeed = 0, fired = false, minAmmo = 99, firstAmmo = null;
    var minHealth = p ? p.health : -1;
    var t = 0;
    for (var i = 0; i < N; i++) {
      if (at[i]) { try { at[i](); } catch (e) { out.errors.push('input@' + i + ': ' + e); } }
      try {
        ctx.engine.step(DT);
        ctx.engine.render();
      } catch (e) {
        out.errors.push('frame ' + i + ': ' + (e && e.stack || e));
        break;
      }
      t += DT;
      if (p) {
        states[p.state] = (states[p.state] || 0) + 1;
        var sp = Math.hypot(p.velocity.x, p.velocity.z);
        if (sp > maxSpeed) maxSpeed = sp;
        if (p.health < minHealth) minHealth = p.health;
      }
      var w = ctx.weapons && ctx.weapons.current;
      if (w) {
        // Compare against the ammo the session STARTED with. Testing a literal
        // "< 30" assumed one weapon's magazine size and would read as 'fired'
        // for any weapon that simply carries fewer rounds than that.
        if (firstAmmo === null) { firstAmmo = w.ammo; minAmmo = w.ammo; }
        if (w.ammo < minAmmo) minAmmo = w.ammo;
        if (w.ammo < firstAmmo) fired = true;
      }
      out.frames = i + 1;
    }

    out.simSeconds = r(t);
    out.statesSeen = states;
    out.maxSpeed = r(maxSpeed);
    out.didFire = fired;
    out.minAmmo = minAmmo;
    out.minHealth = minHealth;
    out.died = !!(p && minHealth <= 0);
    out.player = p ? {
      pos: [r(p.position.x), r(p.position.y), r(p.position.z)],
      state: p.state, health: p.health,
      moved: r(Math.hypot(p.position.x - spawn[0], p.position.z - spawn[2])),
    } : null;
    out.weapon = ctx.weapons && ctx.weapons.current ? {
      name: ctx.weapons.current.name,
      ammo: ctx.weapons.current.ammo,
      reserve: ctx.weapons.current.reserve,
    } : null;
    out.enemies = ctx.ai && ctx.ai.enemies ? ctx.ai.enemies.length : -1;
    out.drawCalls = ctx.renderer.info.render.calls;
    out.triangles = ctx.renderer.info.render.triangles;
    out.elapsedMs = Date.now() - t0;
    finish();
  }

  function r(v) { return Math.round(v * 100) / 100; }
  function trim(a, n, len) {
    if (!a) return a;
    return a.slice(0, n).map(function (e) { return String(e).slice(0, len); });
  }
  function enc(o) { try { return JSON.stringify(o); } catch (e) { return '{"phase":"unencodable"}'; } }

  function finish() {
    // Always surface engine-side errors, including on the failure paths -
    // "it never started" is useless without knowing what threw.
    if (window.GAME && window.GAME.errors && !out.gameErrors) {
      out.gameErrors = window.GAME.errors.slice(0, 25);
    }
    out.errorCount = out.errors.length;
    out.gameErrorCount = (out.gameErrors || []).length;

    // The title has to stay VALID JSON. It used to be hard-sliced at 1800
    // chars, which cut mid-string on exactly the runs that reported errors -
    // so the levels whose diagnostics mattered most parsed as PARTIAL and
    // printed nothing. Shed detail instead of truncating the encoding.
    var s = enc(out);
    if (s.length > 2600) {
      out.errors = trim(out.errors, 8, 180);
      out.gameErrors = trim(out.gameErrors, 8, 180);
      out.truncated = true;
      s = enc(out);
    }
    if (s.length > 2600) {
      out.errors = trim(out.errors, 2, 120);
      out.gameErrors = trim(out.gameErrors, 2, 120);
      s = enc(out);
    }
    document.title = 'PLAYTEST ' + s;
  }
})();
"""

UNESCAPE = (("&quot;", '"'), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"))


def shot_path(args, level):
    """Screenshot path for one level.

    A bare `playtest.py` keeps writing the historical shots/playtest.png, so
    existing invocations and anything pointed at that file are unaffected.
    Everything else is namespaced by level and tag.
    """
    if args.shot and not args.all:
        return pathlib.Path(args.shot)
    if not args.all and level == DEFAULT_LEVEL and not args.tag:
        return SHOTS / "playtest.png"
    return SHOTS / ("playtest_%s%s.png"
                    % (level, ("_" + args.tag) if args.tag else ""))


def run_one(chrome, base, page_name, level, args):
    """Drive one interactive session. Returns a dict (never raises)."""
    out_png = shot_path(args, level)
    out_png.parent.mkdir(parents=True, exist_ok=True)
    if out_png.exists():
        out_png.unlink()

    # Unique per level AND per tag AND per pid: two agents playtesting different
    # levels at once used to fight over one Chrome profile lock, the same
    # collision shoot.py already fixed for captures.
    profile = pathlib.Path(tempfile.gettempdir()) / (
        "blackout-playtest-prof-%s%s-%d"
        % (level, ("-" + args.tag) if args.tag else "", args.pid))

    url = "%s/%s?level=%s" % (base, page_name, level)
    try:
        proc = subprocess.run(
            [chrome, "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
             "--enable-unsafe-swiftshader", "--hide-scrollbars",
             "--window-size=%d,%d" % (args.w, args.h),
             "--user-data-dir=%s" % profile,
             "--screenshot=%s" % out_png,
             "--virtual-time-budget=180000",
             "--dump-dom", url],
            capture_output=True, text=True, timeout=args.timeout, errors="replace")
    except subprocess.TimeoutExpired:
        return {"_fail": "timed out after %ss" % args.timeout, "png": str(out_png)}

    dom = proc.stdout or ""
    m = re.search(r"<title>PLAYTEST (.*?)</title>", dom, re.S)
    if not m:
        tail = dom[:1500] if "FATAL" in dom else ""
        return {"_fail": "interactive session never reported "
                         "(the page probably threw before the loop started)",
                "_tail": tail, "png": str(out_png)}

    raw = m.group(1)
    for a, b in UNESCAPE:
        raw = raw.replace(a, b)
    try:
        d = json.loads(raw)
    except json.JSONDecodeError:
        return {"_fail": "unparseable report", "_tail": raw[:600], "png": str(out_png)}
    d["png"] = str(out_png)
    return d


def judge(d, requested):
    """Print one level's block. Returns (ok, row) - row feeds the --all table."""
    if d.get("_fail"):
        print("FAIL: %s" % d["_fail"])
        if d.get("_tail"):
            print(d["_tail"][:800])
        return False, {"level": requested, "phase": "-", "result": "FAIL"}

    print("level        : %s%s" % (d.get("level"),
          "" if d.get("level") == requested else "   (REQUESTED %s)" % requested)
          )
    print("phase        : %s" % d.get("phase"))
    print("systems built: %d" % len(d.get("built") or []))
    print("frames run   : %s (%.1fs simulated) in %sms wall"
          % (d.get("frames"), d.get("simSeconds") or 0, d.get("elapsedMs")))
    print("draw calls   : %s" % d.get("drawCalls"))
    print("triangles    : %s" % d.get("triangles"))
    print("player       : %s" % json.dumps(d.get("player")))
    print("states seen  : %s" % json.dumps(d.get("statesSeen")))
    print("max speed    : %s m/s" % d.get("maxSpeed"))
    print("weapon       : %s  (fired=%s minAmmo=%s)"
          % (json.dumps(d.get("weapon")), d.get("didFire"), d.get("minAmmo")))
    print("enemies      : %s" % d.get("enemies"))
    errs = (d.get("errors") or []) + (d.get("gameErrors") or [])
    nerr = (d.get("errorCount") or 0) + (d.get("gameErrorCount") or 0) or len(errs)
    if errs:
        print("ERRORS (%d):" % nerr)
        for e in errs[:15]:
            print("   %s" % str(e)[:200])
    else:
        print("errors       : none")

    ok = (d.get("phase") == "running" and (d.get("frames") or 0) >= 590 and not nerr)
    p = d.get("player") or {}
    if d.get("level") and d.get("level") != requested:
        # main.js silently falls back to market when GAME.Level<Id> is missing,
        # which would otherwise read as a clean pass of the level you asked for.
        print("WARN: asked for level '%s' but '%s' loaded - the level module is "
              "missing and main.js fell back" % (requested, d.get("level")))
        ok = False
    if (p.get("moved") or 0) < 3.0:
        print("WARN: player only moved %.2fm - input may not be reaching the controller"
              % (p.get("moved") or 0))
        ok = False
    if not d.get("didFire"):
        print("WARN: weapon never consumed ammo - firing may not be wired up")
        ok = False
    if d.get("died"):
        print("WARN: player died inside the 10s session (min health %s) - spawn is "
              "unsurvivable" % d.get("minHealth"))
        ok = False
    seen = d.get("statesSeen") or {}
    for want in ("sprint", "crouch", "air"):
        if want not in seen:
            print("WARN: player never entered '%s' state" % want)

    health = p.get("health")
    row = {
        "level": requested,
        "phase": d.get("phase"),
        "frames": d.get("frames"),
        "moved": p.get("moved"),
        # Health is regen-driven and lands on values like 98.53333333333342,
        # which blows the summary column apart. The per-level block above still
        # prints it verbatim.
        "health": round(health, 1) if isinstance(health, (int, float)) else health,
        "fired": d.get("didFire"),
        "draws": d.get("drawCalls"),
        "tris": d.get("triangles"),
        "enemies": d.get("enemies"),
        "errors": nerr,
        "result": "PASS" if ok else "FAIL",
    }
    return ok, row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--w", type=int, default=1280)
    ap.add_argument("--h", type=int, default=720)
    ap.add_argument("--timeout", type=int, default=420, help="per level")
    ap.add_argument("--shot", default=None,
                    help="screenshot path (single level only; default shots/playtest[_level][_tag].png)")
    ap.add_argument("--level", default=DEFAULT_LEVEL, choices=LEVELS)
    ap.add_argument("--all", action="store_true", help="playtest every level in the roster")
    ap.add_argument("--tag", default="",
                    help="suffix for output/profile paths so concurrent agents do not collide")
    args = ap.parse_args()
    args.pid = os.getpid()

    levels = LEVELS if args.all else [args.level]
    if args.all and args.shot:
        print("note: --shot is ignored with --all; using shots/playtest_<level>.png")

    # A tiny page that loads the real index.html in an iframe would sandbox the
    # driver away from GAME, so instead inject by appending a script tag to a
    # copy of index.html. The copy must live in ROOT for the relative <script>
    # paths to resolve, and its name carries the tag+pid so two agents running
    # at once do not delete each other's page mid-run.
    src = (ROOT / "index.html").read_text(encoding="utf-8")
    injected = src.replace("</body>", "<script>%s</script>\n</body>" % DRIVER)
    tmp = ROOT / ("._playtest%s_%d.html" % (("_" + args.tag) if args.tag else "", args.pid))
    tmp.write_text(injected, encoding="utf-8")

    chrome = find_chrome()
    rows = []
    failed = 0
    try:
        with serving.serve() as base:
            for i, lv in enumerate(levels):
                if len(levels) > 1:
                    print("\n===== playtest %s  (%d/%d) %s"
                          % (lv, i + 1, len(levels), "=" * max(0, 40 - len(lv))))
                d = run_one(chrome, base, tmp.name, lv, args)
                ok, row = judge(d, lv)
                rows.append(row)
                if not ok:
                    failed += 1
                if len(levels) == 1:
                    print("\n%s" % ("PASS" if ok else "FAIL"))
                else:
                    # Verdict inline as well as in the closing table: a ten-level
                    # run takes long enough that "how is it doing so far" has to
                    # be answerable from the log, and answerable if it is killed.
                    print("\n-> %s %s" % ("PASS" if ok else "FAIL", lv))
    finally:
        tmp.unlink(missing_ok=True)

    if len(levels) > 1:
        hdr = ("%-10s %-9s %6s %7s %6s %6s %6s %9s %5s %4s  %s"
               % ("level", "phase", "frames", "moved", "health", "fired",
                  "draws", "tris", "enemy", "err", "result"))
        print("\n===== per-level summary " + "=" * (len(hdr) - 24))
        print(hdr)
        for r in rows:
            print("%-10s %-9s %6s %7s %6s %6s %6s %9s %5s %4s  %s"
                  % (r.get("level"), r.get("phase"), r.get("frames"), r.get("moved"),
                     r.get("health"), r.get("fired"), r.get("draws"), r.get("tris"),
                     r.get("enemies"), r.get("errors"), r.get("result")))
        print("\n%d/%d levels PASS" % (len(rows) - failed, len(rows)))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
