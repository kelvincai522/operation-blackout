"""Build a labelled contact sheet from captures, so a critic can judge the whole
build in a single glance instead of opening a dozen files.

    python tools/sheet.py                       # every png in shots/
    python tools/sheet.py --tag r2 --cols 3
    python tools/sheet.py --ab shots/street.png shots/street_r2.png --out shots/ab.png
"""
import argparse
import pathlib
import sys

from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOTS = ROOT / "shots"

BG = (16, 18, 22)
FG = (222, 232, 242)
DIM = (128, 146, 164)


def label(draw, x, y, text, fill=FG):
    # Default bitmap font only; there are no font files on this machine.
    draw.text((x, y), text, fill=fill)


def contact(paths, cols, cell_w, out):
    if not paths:
        sys.exit("no images")
    rows = (len(paths) + cols - 1) // cols
    thumbs = []
    for p in paths:
        im = Image.open(p).convert("RGB")
        ratio = im.height / im.width
        th = im.resize((cell_w, max(1, int(cell_w * ratio))), Image.LANCZOS)
        thumbs.append((p, th))
    cell_h = max(t.height for _, t in thumbs)
    pad, bar = 10, 18
    W = cols * cell_w + (cols + 1) * pad
    H = rows * (cell_h + bar) + (rows + 1) * pad
    sheet = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(sheet)
    for i, (p, th) in enumerate(thumbs):
        r, c = divmod(i, cols)
        x = pad + c * (cell_w + pad)
        y = pad + r * (cell_h + bar + pad)
        sheet.paste(th, (x, y))
        draw.rectangle([x, y, x + cell_w - 1, y + th.height - 1], outline=(48, 56, 66))
        label(draw, x + 2, y + th.height + 4, pathlib.Path(p).stem.upper())
    sheet.save(out)
    return out, sheet.size


def ab(a, b, out, labels=("A", "B")):
    """Side-by-side comparison at matched height."""
    ia, ib = Image.open(a).convert("RGB"), Image.open(b).convert("RGB")
    h = max(ia.height, ib.height)
    ia = ia.resize((int(ia.width * h / ia.height), h), Image.LANCZOS)
    ib = ib.resize((int(ib.width * h / ib.height), h), Image.LANCZOS)
    bar = 20
    sheet = Image.new("RGB", (ia.width + ib.width + 12, h + bar), BG)
    sheet.paste(ia, (0, bar))
    sheet.paste(ib, (ia.width + 12, bar))
    d = ImageDraw.Draw(sheet)
    label(d, 4, 4, labels[0])
    label(d, ia.width + 16, 4, labels[1])
    sheet.save(out)
    return out, sheet.size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("images", nargs="*")
    ap.add_argument("--dir", default=str(SHOTS))
    ap.add_argument("--tag", default="", help="only include files ending _<tag>")
    ap.add_argument("--cols", type=int, default=4)
    ap.add_argument("--cell", type=int, default=520)
    ap.add_argument("--out", default=str(SHOTS / "contact.png"))
    ap.add_argument("--ab", nargs=2, metavar=("A", "B"))
    args = ap.parse_args()

    if args.ab:
        out, size = ab(args.ab[0], args.ab[1], args.out)
        print("wrote %s  %dx%d" % (out, size[0], size[1]))
        return 0

    if args.images:
        paths = [pathlib.Path(p) for p in args.images]
    else:
        paths = sorted(pathlib.Path(args.dir).glob("*.png"))
        paths = [p for p in paths if p.stem not in ("contact", "ab", "smoke", "err")]
        if args.tag:
            paths = [p for p in paths if p.stem.endswith("_" + args.tag)]
        else:
            # bare captures only (no _tag suffix variants)
            paths = [p for p in paths if "_" not in p.stem or p.stem.count("_") == 1
                     and p.stem.split("_")[0] in ("weapon", "enemy")]
    paths = [p for p in paths if p.exists()]
    out, size = contact(paths, args.cols, args.cell, args.out)
    print("wrote %s  %dx%d  (%d images)" % (out, size[0], size[1], len(paths)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
