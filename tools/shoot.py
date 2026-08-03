"""Headless screenshot harness for the visual-critic loop.

Renders a scenario in headless Chrome (SwiftShader WebGL) and writes a PNG,
plus the page's diagnostic report (draw calls, triangles, JS errors).

    python tools/shoot.py street
    python tools/shoot.py street interior ads --w 1600 --h 900 --t 3
    python tools/shoot.py --all

Exit code is non-zero if any capture failed or the page reported JS errors,
so an agent can tell "it rendered" from "it silently broke".
"""
import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import serving  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOTS = ROOT / "shots"

# Scenario sets per level. --all renders the set matching --level, because a
# market framing pointed at the harbor (or vice versa) just photographs a wall.
GENERIC = [
    "lv_overview", "lv_hero1", "lv_hero2", "lv_hero3", "lv_interior",
    "lv_ads", "lv_muzzleflash", "lv_firefight", "lv_explosion",
    "weapon_closeup", "enemy_closeup",
]

SCENARIOS_BY_LEVEL = {
    # Levels 1 and 2 predate the generic framing keys and keep bespoke names.
    "market": [
        "overview", "street", "interior", "alley", "rooftop",
        "ads", "weapon_closeup", "muzzleflash", "firefight",
        "enemy_closeup", "explosion", "dusk", "night", "materials",
    ],
    "harbor": [
        "harbor_overview", "quay", "containers", "warehouse", "crane",
        "gangway", "lightning", "rain_closeup",
        "ads", "weapon_closeup", "muzzleflash", "firefight",
        "enemy_closeup", "explosion",
    ],
}
# Levels 3-10 publish the standard pose keys, so they all share one set and a
# new level becomes capturable without touching this file.
for _lv in ("snowbound", "metro", "highrise", "boneyard",
            "bunker", "jungle", "refinery", "ruins"):
    SCENARIOS_BY_LEVEL[_lv] = list(GENERIC)

SCENARIOS = SCENARIOS_BY_LEVEL["market"]

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]


def find_chrome():
    for c in CHROME_CANDIDATES:
        if os.path.exists(c):
            return c
    for name in ("chrome", "msedge"):
        p = shutil.which(name)
        if p:
            return p
    sys.exit("No Chrome/Edge found for headless capture.")


def capture(chrome, base, scenario, out_path, w, h, t, seed, hud, quality, extra,
            timeout, level="market"):
    url = (
        base + "/index.html"
        + "?scenario=%s&level=%s&t=%s&w=%d&h=%d&seed=%d&hud=%d&quality=%s"
        % (scenario, level, t, w, h, seed, 1 if hud else 0, quality)
    )
    if extra:
        url += "&" + extra
    # The profile directory must be unique per concurrent capture. Keying it on
    # scenario alone collided once levels 3-10 started sharing generic scenario
    # names: two agents capturing lv_hero1 on different levels fought over the
    # same Chrome profile lock and the page never signalled READY. Include the
    # level and the pid so parallel agents never contend.
    profile = pathlib.Path(tempfile.gettempdir()) / (
        "blackout-prof-%s-%s-%d" % (level, scenario, os.getpid()))
    if out_path.exists():
        out_path.unlink()

    args = [
        chrome,
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--enable-unsafe-swiftshader",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        "--disable-extensions",
        "--disable-background-timer-throttling",
        "--window-size=%d,%d" % (w, h),
        "--user-data-dir=%s" % profile,
        "--screenshot=%s" % out_path,
        # Virtual time lets the deterministic warm-up loop finish instantly
        # instead of us guessing a wall-clock sleep.
        "--virtual-time-budget=%d" % int(t * 1000 + 45000),
        "--dump-dom",
        url,
    ]
    try:
        proc = subprocess.run(
            args, capture_output=True, text=True, timeout=timeout,
            errors="replace",
        )
    except subprocess.TimeoutExpired:
        return {"scenario": scenario, "ok": False, "error": "timeout after %ss" % timeout}

    dom = proc.stdout or ""
    report = None
    m = re.search(r"<title>READY (.*?)</title>", dom, re.S)
    if m:
        raw = m.group(1)
        raw = raw.replace("&quot;", '"').replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
        try:
            report = json.loads(raw)
        except json.JSONDecodeError:
            # title is truncated to keep it manageable; recover what we can
            report = {"raw": raw[:300], "truncated": True}

    ok = out_path.exists() and out_path.stat().st_size > 2000
    result = {
        "scenario": scenario,
        "ok": ok,
        "png": str(out_path),
        "bytes": out_path.stat().st_size if out_path.exists() else 0,
        "report": report,
    }
    if "FATAL" in dom[:4000] and "<title>FATAL" in dom:
        result["ok"] = False
        result["error"] = "page reported FATAL"
    if report is None:
        result["error"] = "page never signalled READY (check for a JS error)"
        result["ok"] = False
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("scenarios", nargs="*", default=[])
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--w", type=int, default=1600)
    ap.add_argument("--h", type=int, default=900)
    ap.add_argument("--t", type=float, default=2.5)
    ap.add_argument("--seed", type=int, default=20260801)
    ap.add_argument("--hud", type=int, default=1)
    ap.add_argument("--quality", default="ultra")
    ap.add_argument("--tag", default="", help="suffix for output filenames")
    ap.add_argument("--extra", default="", help="extra URL query params")
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--outdir", default=str(SHOTS))
    ap.add_argument("--level", default="market", choices=sorted(SCENARIOS_BY_LEVEL))
    args = ap.parse_args()

    default_set = SCENARIOS_BY_LEVEL[args.level]
    names = default_set if args.all or not args.scenarios else args.scenarios
    outdir = pathlib.Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    chrome = find_chrome()

    results = []
    failed = 0
    with serving.serve() as base:
        for name in names:
            fname = "%s%s.png" % (name, ("_" + args.tag) if args.tag else "")
            out = outdir / fname
            r = capture(chrome, base, name, out, args.w, args.h, args.t, args.seed,
                        args.hud, args.quality, args.extra, args.timeout, args.level)
            results.append(r)

            rep = r.get("report") or {}
            errs = rep.get("errors") or []
            status = "OK " if r["ok"] else "FAIL"
            detail = ""
            if rep.get("drawCalls") is not None:
                detail = " draws=%s tris=%s" % (rep.get("drawCalls"), rep.get("triangles"))
            if r.get("error"):
                detail += "  !! " + r["error"]
            print("%s %-16s %-40s%s" % (status, name, out.name, detail))
            for e in errs[:6]:
                print("       ERROR: %s" % str(e)[:200])
            if not r["ok"] or errs:
                failed += 1

    (outdir / "report.json").write_text(json.dumps(results, indent=1), encoding="utf-8")
    print("\n%d/%d clean  ->  %s" % (len(names) - failed, len(names), outdir))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
