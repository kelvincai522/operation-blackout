"""Verify the INTERACTIVE boot path, not just the headless capture path.

Every check so far has run with ?scenario=..., which takes a different code
path: it freezes the player, drives the camera itself and steps a fixed
timestep. None of that exercises the thing the user actually double-clicks.
This harness boots index.html with no query string, drives real input events
(pointer lock, WASD, mouse look, fire, reload, crouch, sprint, jump), runs the
live rAF loop, and reports errors plus measured frame timings.
"""
import argparse
import json
import pathlib
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import serving  # noqa: E402
from shoot import find_chrome  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent

# Injected after load: fakes a play session and reports what happened.
DRIVER = r"""
(function () {
  var out = { phase: 'init', errors: [], frames: 0, warnings: [] };
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
      if (waited > 90000) { out.phase = 'never-booted'; finish(); }
      return;
    }
    var ctx = G.engine.ctx;
    if (!G.engine.running) {
      if (waited > 90000) { out.phase = 'booted-but-not-running'; finish(); }
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

    var states = {}, maxSpeed = 0, fired = false, minAmmo = 99;
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
      }
      var w = ctx.weapons && ctx.weapons.current;
      if (w) {
        if (w.ammo < minAmmo) minAmmo = w.ammo;
        if (w.ammo < 30) fired = true;
      }
      out.frames = i + 1;
    }

    out.simSeconds = r(t);
    out.statesSeen = states;
    out.maxSpeed = r(maxSpeed);
    out.didFire = fired;
    out.minAmmo = minAmmo;
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
    out.elapsedMs = Date.now() - t0;
    finish();
  }

  function G_fps(ctx) { return (window.GAME.engine && window.GAME.engine.fps) || 0; }
  function r(v) { return Math.round(v * 100) / 100; }
  function finish() {
    // Always surface engine-side errors, including on the failure paths -
    // "it never started" is useless without knowing what threw.
    if (window.GAME && window.GAME.errors && !out.gameErrors) {
      out.gameErrors = window.GAME.errors.slice(0, 25);
    }
    document.title = 'PLAYTEST ' + JSON.stringify(out).slice(0, 1800);
  }
})();
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--w", type=int, default=1280)
    ap.add_argument("--h", type=int, default=720)
    ap.add_argument("--timeout", type=int, default=420)
    ap.add_argument("--shot", default=str(ROOT / "shots" / "playtest.png"))
    args = ap.parse_args()

    # A tiny page that loads the real index.html in an iframe would sandbox the
    # driver away from GAME, so instead inject by appending a script tag to a
    # copy of index.html.
    src = (ROOT / "index.html").read_text(encoding="utf-8")
    injected = src.replace("</body>", "<script>%s</script>\n</body>" % DRIVER)
    tmp = ROOT / "._playtest.html"
    tmp.write_text(injected, encoding="utf-8")

    chrome = find_chrome()
    profile = pathlib.Path(tempfile.gettempdir()) / "blackout-playtest-prof"
    out_png = pathlib.Path(args.shot)
    if out_png.exists():
        out_png.unlink()

    try:
        with serving.serve() as base:
            proc = subprocess.run(
                [chrome, "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
                 "--enable-unsafe-swiftshader", "--hide-scrollbars",
                 "--window-size=%d,%d" % (args.w, args.h),
                 "--user-data-dir=%s" % profile,
                 "--screenshot=%s" % out_png,
                 "--virtual-time-budget=180000",
                 "--dump-dom", "%s/%s" % (base, tmp.name)],
                capture_output=True, text=True, timeout=args.timeout, errors="replace")
    except subprocess.TimeoutExpired:
        print("FAIL: timed out after %ss" % args.timeout)
        return 1
    finally:
        tmp.unlink(missing_ok=True)

    m = re.search(r"<title>PLAYTEST (.*?)</title>", proc.stdout or "", re.S)
    if not m:
        print("FAIL: interactive session never reported.")
        print("      The page probably threw before the rAF loop started.")
        tail = (proc.stdout or "")[:1500]
        if "FATAL" in tail:
            print(tail[:800])
        return 1

    raw = m.group(1)
    for a, b in (("&quot;", '"'), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">")):
        raw = raw.replace(a, b)
    try:
        d = json.loads(raw)
    except json.JSONDecodeError:
        print("PARTIAL: %s" % raw[:600])
        return 1

    print("phase        : %s" % d.get("phase"))
    print("systems built: %d" % len(d.get("built") or []))
    print("frames run   : %s (%.1fs simulated) in %sms wall"
          % (d.get("frames"), d.get("simSeconds") or 0, d.get("elapsedMs")))
    print("draw calls   : %s" % d.get("drawCalls"))
    print("player       : %s" % json.dumps(d.get("player")))
    print("states seen  : %s" % json.dumps(d.get("statesSeen")))
    print("max speed    : %s m/s" % d.get("maxSpeed"))
    print("weapon       : %s  (fired=%s minAmmo=%s)"
          % (json.dumps(d.get("weapon")), d.get("didFire"), d.get("minAmmo")))
    print("enemies      : %s" % d.get("enemies"))
    errs = (d.get("errors") or []) + (d.get("gameErrors") or [])
    if errs:
        print("ERRORS (%d):" % len(errs))
        for e in errs[:15]:
            print("   %s" % str(e)[:200])
    else:
        print("errors       : none")

    ok = (d.get("phase") == "running" and (d.get("frames") or 0) >= 590 and not errs)
    p = d.get("player") or {}
    if (p.get("moved") or 0) < 3.0:
        print("WARN: player only moved %.2fm - input may not be reaching the controller"
              % (p.get("moved") or 0))
        ok = False
    if not d.get("didFire"):
        print("WARN: weapon never consumed ammo - firing may not be wired up")
        ok = False
    seen = d.get("statesSeen") or {}
    for want in ("sprint", "crouch", "air"):
        if want not in seen:
            print("WARN: player never entered '%s' state" % want)
    print("\n%s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
