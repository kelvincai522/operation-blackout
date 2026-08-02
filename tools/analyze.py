"""Objective image-quality metrics for the visual-critic loop.

A critic agent looking at a PNG can tell you "it looks flat". These numbers tell
you *why*, and they make the loop's progress measurable instead of a matter of
taste. Each metric maps to a specific instant-fail item in ART_DIRECTION.md.

    python tools/analyze.py shots/street.png
    python tools/analyze.py --all
    python tools/analyze.py --all --json
"""
import argparse
import json
import pathlib
import sys

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOTS = ROOT / "shots"


def srgb_to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def load(path):
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(np.float32) / 255.0
    return im, a


def luminance(rgb):
    return rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def sobel(gray):
    kx = np.array([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]], dtype=np.float32)
    ky = kx.T
    g = np.pad(gray, 1, mode="edge")
    w = np.lib.stride_tricks.sliding_window_view(g, (3, 3))
    gx = np.einsum("ijkl,kl->ij", w, kx)
    gy = np.einsum("ijkl,kl->ij", w, ky)
    return np.hypot(gx, gy)


def local_stat(gray, k=9):
    """Mean and std in a k x k neighbourhood, via integral images."""
    pad = k // 2
    g = np.pad(gray, pad, mode="edge").astype(np.float64)
    ii = g.cumsum(0).cumsum(1)
    ii = np.pad(ii, ((1, 0), (1, 0)))
    ii2 = (g * g).cumsum(0).cumsum(1)
    ii2 = np.pad(ii2, ((1, 0), (1, 0)))
    h, w = gray.shape

    def box(integral):
        return (integral[k:k + h, k:k + w] - integral[0:h, k:k + w]
                - integral[k:k + h, 0:w] + integral[0:h, 0:w])

    n = k * k
    mean = box(ii) / n
    var = np.maximum(box(ii2) / n - mean * mean, 0)
    return mean.astype(np.float32), np.sqrt(var).astype(np.float32)


def dead_regions(gray, grid=8, thresh=0.045):
    """Fraction of the frame that carries no legible content.

    Mean luminance hides this completely: a frame whose bottom half is an empty
    void and whose top half is bright fog averages out to a perfectly healthy
    number. This splits the image into a grid and asks, per cell, whether even
    its 95th percentile is below a visibility floor -- i.e. whether there is
    anything in that cell a player could actually see.

    Also reports the vertical split, because "the ground is missing" is the
    specific failure this exists to catch.
    """
    h, w = gray.shape
    ch, cw = h // grid, w // grid
    dead = 0
    for r in range(grid):
        for c in range(grid):
            cell = gray[r * ch:(r + 1) * ch, c * cw:(c + 1) * cw]
            if cell.size and np.percentile(cell, 95) < thresh:
                dead += 1
    top = gray[: h // 2]
    bottom = gray[h // 2:]
    return {
        "dead_cell_pct": round(100.0 * dead / (grid * grid), 2),
        "top_half_mean": round(float(top.mean()), 4),
        "bottom_half_mean": round(float(bottom.mean()), 4),
        # >1 means the lower half is much darker than the upper half, which for
        # a ground-level camera almost always means the floor is unlit or absent
        "vertical_imbalance": round(float(top.mean() / max(bottom.mean(), 1e-4)), 3),
    }


def tiling_score(gray):
    """Detect repeating structure via horizontal/vertical autocorrelation.

    Obvious texture tiling shows up as a periodic correlation *peak* at a lag
    well short of the image width. Two things must be handled or this metric
    lies: a smooth luminance gradient autocorrelates strongly at every lag
    (so the profile is linearly detrended first), and a decaying correlation
    curve is not periodicity (so we score only genuine local maxima).
    """
    out = {}
    for axis, name in ((1, "h"), (0, "v")):
        prof = gray.mean(axis=axis).astype(np.float64)
        n = len(prof)
        if n < 32 or prof.std() < 1e-6:
            out[name] = 0.0
            continue
        # remove the linear trend (a ramp is not a repeat)
        x = np.arange(n)
        prof = prof - np.polyval(np.polyfit(x, prof, 1), x)
        prof -= prof.mean()
        if prof.std() < 1e-6:
            out[name] = 0.0
            continue
        f = np.fft.rfft(prof, n * 2)
        ac = np.fft.irfft(f * np.conj(f))[:n]
        ac /= ac[0] + 1e-9
        lo, hi = max(8, n // 64), n // 3
        if hi - lo < 3:
            out[name] = 0.0
            continue
        seg = ac[lo:hi]
        # a true repeat is a local maximum, not just a high plateau value
        peaks = (seg[1:-1] > seg[:-2]) & (seg[1:-1] > seg[2:])
        out[name] = float(np.max(seg[1:-1][peaks])) if peaks.any() else 0.0
    return out


def analyze(path):
    im, rgb = load(path)
    h, w, _ = rgb.shape
    lum = luminance(rgb)
    lin = srgb_to_linear(rgb)
    linlum = luminance(lin)

    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    sat = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0)

    # -- exposure -----------------------------------------------------------
    crushed = float((lum < 2 / 255).mean())
    near_black = float((lum < 8 / 255).mean())
    blown = float((lum > 253 / 255).mean())
    near_white = float((lum > 247 / 255).mean())

    # -- detail -------------------------------------------------------------
    edges = sobel(lum)
    edge_energy = float(edges.mean())
    edge_p95 = float(np.percentile(edges, 95))

    _, lstd = local_stat(lum, 9)
    # "flat" = a neighbourhood with essentially no texture variation at all
    flat_frac = float((lstd < 0.008).mean())
    detail_frac = float((lstd > 0.05).mean())

    # -- grade --------------------------------------------------------------
    # Is there an intentional colour grade? Shadows should skew cool/teal and
    # highlights warm. A flat sRGB dump has near-identical hue in both.
    shadow_mask = linlum < np.percentile(linlum, 25)
    high_mask = linlum > np.percentile(linlum, 85)

    def tint(mask):
        if mask.sum() < 64:
            return [0.0, 0.0, 0.0]
        m = rgb[mask].mean(axis=0)
        return (m - m.mean()).tolist()

    sh, hi = tint(shadow_mask), tint(high_mask)
    # positive => highlights warmer than shadows (R-B separation), the target look
    grade_split = float((hi[0] - hi[2]) - (sh[0] - sh[2]))

    # -- tone distribution --------------------------------------------------
    hist, _ = np.histogram(lum, bins=32, range=(0, 1))
    hist = (hist / hist.sum()).round(4).tolist()

    return {
        "file": str(pathlib.Path(path).name),
        "size": [w, h],
        "exposure": {
            "mean_luma": round(float(lum.mean()), 4),
            "median_luma": round(float(np.median(lum)), 4),
            "p01": round(float(np.percentile(lum, 1)), 4),
            "p99": round(float(np.percentile(lum, 99)), 4),
            "dynamic_range": round(float(np.percentile(lum, 99) - np.percentile(lum, 1)), 4),
            "crushed_black_pct": round(crushed * 100, 3),
            "near_black_pct": round(near_black * 100, 3),
            "blown_white_pct": round(blown * 100, 3),
            "near_white_pct": round(near_white * 100, 3),
        },
        "detail": {
            "edge_energy": round(edge_energy, 5),
            "edge_p95": round(edge_p95, 5),
            "flat_area_pct": round(flat_frac * 100, 2),
            "textured_area_pct": round(detail_frac * 100, 2),
        },
        "colour": {
            "mean_saturation": round(float(sat.mean()), 4),
            "sat_p90": round(float(np.percentile(sat, 90)), 4),
            "shadow_tint_rgb": [round(v, 4) for v in sh],
            "highlight_tint_rgb": [round(v, 4) for v in hi],
            "grade_split": round(grade_split, 4),
        },
        "repetition": {k: round(v, 4) for k, v in tiling_score(lum).items()},
        "coverage": dead_regions(lum),
        "histogram_32": hist,
    }


VERDICTS = [
    # (key path, comparison, threshold, message)
    ("exposure.crushed_black_pct", ">", 3.0, "shadows are crushed to pure black (fill light / AO too strong)"),
    ("exposure.blown_white_pct", ">", 1.5, "highlights clipping to flat white (exposure or tonemap roll-off)"),
    ("exposure.dynamic_range", "<", 0.45, "very low dynamic range - image reads flat/washed"),
    ("exposure.mean_luma", "<", 0.10, "image is far too dark"),
    ("exposure.mean_luma", ">", 0.72, "image is far too bright"),
    ("detail.flat_area_pct", ">", 45.0, "huge untextured areas - missing detail/normal/roughness variation"),
    ("detail.edge_energy", "<", 0.020, "very little edge detail - geometry and textures are too simple"),
    ("colour.grade_split", "<", 0.004, "no meaningful colour grade (shadows/highlights share a tint)"),
    ("coverage.dead_cell_pct", ">", 18.0, "large areas of the frame contain nothing visible (unlit or missing geometry)"),
    ("coverage.vertical_imbalance", ">", 3.0, "lower half far darker than upper - ground plane likely unlit or absent"),
    ("colour.mean_saturation", "<", 0.04, "nearly monochrome"),
    ("colour.mean_saturation", ">", 0.55, "oversaturated - breaks the photographic look"),
    # NOTE: the repetition metric collapses each image row to a single mean, so
    # on a 3D perspective scene it largely measures how smooth that 1D profile
    # is, not whether a texture repeats. It was shown to report the same peak
    # for two frame halves containing different walls at different depths,
    # while other captures using identical materials scored ~0. Kept as a weak
    # advisory signal only; judge tiling by eye, not by this number.
    ("repetition.h", ">", 0.90, "ADVISORY ONLY (unreliable on 3D scenes): possible horizontal repetition"),
    ("repetition.v", ">", 0.90, "ADVISORY ONLY (unreliable on 3D scenes): possible vertical repetition"),
]


def dig(d, path):
    for p in path.split("."):
        d = d[p]
    return d


def verdict(m):
    out = []
    for key, op, thr, msg in VERDICTS:
        v = dig(m, key)
        if (op == ">" and v > thr) or (op == "<" and v < thr):
            out.append("%s (%s = %.4f, limit %s %.4f)" % (msg, key, v, op, thr))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("images", nargs="*")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--dir", default=str(SHOTS))
    args = ap.parse_args()

    paths = [pathlib.Path(p) for p in args.images]
    if args.all or not paths:
        paths = sorted(pathlib.Path(args.dir).glob("*.png"))
    paths = [p for p in paths if p.exists()]
    if not paths:
        sys.exit("no images found")

    results = []
    for p in paths:
        m = analyze(p)
        m["flags"] = verdict(m)
        results.append(m)

    if args.json:
        print(json.dumps(results, indent=1))
        return 0

    for m in results:
        e, d, c = m["exposure"], m["detail"], m["colour"]
        print("=" * 78)
        print("%s   %dx%d" % (m["file"], m["size"][0], m["size"][1]))
        print("  exposure  mean=%.3f  range=%.3f  black=%.2f%%  blown=%.2f%%"
              % (e["mean_luma"], e["dynamic_range"], e["crushed_black_pct"], e["blown_white_pct"]))
        print("  detail    edges=%.4f  flat=%.1f%%  textured=%.1f%%"
              % (d["edge_energy"], d["flat_area_pct"], d["textured_area_pct"]))
        print("  colour    sat=%.3f  grade_split=%+.4f  (shadow %s / highlight %s)"
              % (c["mean_saturation"], c["grade_split"],
                 [round(v, 3) for v in c["shadow_tint_rgb"]],
                 [round(v, 3) for v in c["highlight_tint_rgb"]]))
        print("  repeat    h=%.3f  v=%.3f" % (m["repetition"]["h"], m["repetition"]["v"]))
        if m["flags"]:
            for f in m["flags"]:
                print("  !! %s" % f)
        else:
            print("  -- no objective red flags")
    return 0


if __name__ == "__main__":
    sys.exit(main())
