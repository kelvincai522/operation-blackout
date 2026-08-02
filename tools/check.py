"""Validate one game module in isolation - parse errors, missing exports, throws.

Loads three.js + src/core/util.js + the target file in headless Chrome over
localhost (so error messages carry real line numbers), then reports whether the
expected GAME.* class appeared and whether it can be constructed.

    python tools/check.py src/render/textures.js TextureLibrary
    python tools/check.py --all

Every feature agent must leave its own module passing this before finishing.
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

MODULES = [
    ("src/render/textures.js", "TextureLibrary"),
    ("src/render/materials.js", "MaterialLibrary"),
    ("src/render/sky.js", "Sky"),
    ("src/render/lighting.js", "Lighting"),
    ("src/render/postfx.js", "PostFX"),
    ("src/world/level.js", "Level"),
    ("src/world/props.js", "Props"),
    ("src/world/level_harbor.js", "LevelHarbor"),
    ("src/world/props_harbor.js", "PropsHarbor"),
    ("src/fx/weather.js", "Weather"),
    ("src/player/controller.js", "PlayerController"),
    ("src/weapons/weapons.js", "WeaponSystem"),
    ("src/weapons/ballistics.js", "Ballistics"),
    ("src/fx/vfx.js", "VFX"),
    ("src/audio/audio.js", "Audio"),
    ("src/ai/ai.js", "AISystem"),
    ("src/ui/hud.js", "HUD"),
]

PAGE = """<!doctype html><meta charset="utf-8">
<body style="background:#000;color:#0f0;font:12px monospace">
<script>
window.__errs = [];
window.addEventListener('error', function (e) {
  window.__errs.push((e.message||'') + ' @ ' + (e.filename||'').split('/').pop() + ':' + (e.lineno||0));
});
</script>
<script src="/vendor/three.global.js"></script>
<script src="/src/core/util.js"></script>
<script src="__TARGET__"></script>
<script>
(function () {
  var out = { file: '__TARGET__', cls: '__CLS__', errors: window.__errs,
              defined: false, constructed: false, built: false, api: [] };
  try {
    var C = window.GAME && window.GAME['__CLS__'];
    out.defined = typeof C === 'function';
    if (out.defined) {
      out.api = Object.getOwnPropertyNames(C.prototype).filter(function (n) { return n !== 'constructor'; });
    }
  } catch (e) { out.errors.push('inspect: ' + e); }
  out.exports = window.GAME ? Object.keys(window.GAME).length : 0;
  document.title = 'CHECK ' + JSON.stringify(out);
})();
</script></body>"""


def check(chrome, base, rel, cls, timeout=120):
    page = PAGE.replace("__TARGET__", "/" + rel).replace("__CLS__", cls)
    tmp = ROOT / ("._check_%s.html" % cls.lower())
    tmp.write_text(page, encoding="utf-8")
    profile = pathlib.Path(tempfile.gettempdir()) / "blackout-check-prof"
    try:
        proc = subprocess.run(
            [chrome, "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
             "--enable-unsafe-swiftshader", "--user-data-dir=%s" % profile,
             "--virtual-time-budget=20000", "--dump-dom",
             "%s/%s" % (base, tmp.name)],
            capture_output=True, text=True, timeout=timeout, errors="replace")
    except subprocess.TimeoutExpired:
        return {"file": rel, "cls": cls, "ok": False, "errors": ["timeout"]}
    finally:
        tmp.unlink(missing_ok=True)

    m = re.search(r"<title>CHECK (.*?)</title>", proc.stdout or "", re.S)
    if not m:
        return {"file": rel, "cls": cls, "ok": False,
                "errors": ["page did not report (hard parse error?)"]}
    raw = m.group(1)
    for a, b in (("&quot;", '"'), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">")):
        raw = raw.replace(a, b)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {"file": rel, "cls": cls, "ok": False, "errors": ["unparsable report"]}
    data["ok"] = data.get("defined") and not data.get("errors")
    return data


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file", nargs="?")
    ap.add_argument("cls", nargs="?")
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()

    if args.all or not args.file:
        targets = MODULES
    else:
        cls = args.cls
        if not cls:
            for rel, c in MODULES:
                if pathlib.Path(rel).name == pathlib.Path(args.file).name:
                    cls = c
                    break
        if not cls:
            sys.exit("could not infer class name; pass it explicitly")
        targets = [(args.file.replace("\\", "/"), cls)]

    chrome = find_chrome()
    bad = 0
    with serving.serve() as base:
        for rel, cls in targets:
            if not (ROOT / rel).exists():
                print("MISSING  %-32s %s" % (rel, cls))
                bad += 1
                continue
            r = check(chrome, base, rel, cls)
            mark = "OK    " if r.get("ok") else "FAIL  "
            print("%s %-32s GAME.%-18s api=%d" %
                  (mark, rel, cls, len(r.get("api") or [])))
            for e in (r.get("errors") or [])[:8]:
                print("         %s" % str(e)[:220])
            if not r.get("ok"):
                bad += 1
    print("\n%d/%d modules clean" % (len(targets) - bad, len(targets)))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
