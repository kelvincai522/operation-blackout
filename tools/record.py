"""Record an animated sequence from the game and assemble it into a GIF.

Chrome's --screenshot yields one still, so nothing that MOVES -- rain, snow,
muzzle flash, weather, animation, the lightning strike -- can be reviewed from
captures alone. This serves the project over localhost with a POST endpoint,
loads the page in record mode, and collects each rendered frame as the engine
steps a fixed timestep. Deterministic, same as a still capture.

    python tools/record.py street --frames 48 --step 0.05
    python tools/record.py lv_hero1 --level snowbound --frames 60 --out docs/snow.gif
"""
import argparse
import base64
import functools
import http.server
import io
import pathlib
import re
import socketserver
import subprocess
import sys
import tempfile
import threading

from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from shoot import find_chrome  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
FRAMES = {}
_LOCK = threading.Lock()


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        if not self.path.startswith("/_frame"):
            self.send_error(404)
            return
        m = re.search(r"i=(\d+)", self.path)
        idx = int(m.group(1)) if m else len(FRAMES)
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8", "replace")
        if "," in body:
            body = body.split(",", 1)[1]
        try:
            raw = base64.b64decode(body)
            with _LOCK:
                FRAMES[idx] = Image.open(io.BytesIO(raw)).convert("RGB")
        except Exception as e:  # noqa: BLE001 - report, never kill the server
            print("  frame %d decode failed: %s" % (idx, e))
        self.send_response(204)
        self.end_headers()


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("scenario", nargs="?", default="street")
    ap.add_argument("--level", default="market")
    ap.add_argument("--frames", type=int, default=48)
    ap.add_argument("--step", type=float, default=0.05, help="simulated seconds per frame")
    ap.add_argument("--t", type=float, default=1.2, help="warm-up before recording")
    ap.add_argument("--w", type=int, default=960)
    ap.add_argument("--h", type=int, default=540)
    ap.add_argument("--seed", type=int, default=20260801)
    ap.add_argument("--quality", default="ultra")
    ap.add_argument("--fps", type=int, default=20)
    ap.add_argument("--scale", type=float, default=1.0, help="output scale")
    ap.add_argument("--out", default=None)
    ap.add_argument("--timeout", type=int, default=900)
    args = ap.parse_args()

    out = pathlib.Path(args.out or (ROOT / "docs" / ("%s_%s.gif" % (args.level, args.scenario))))
    out.parent.mkdir(parents=True, exist_ok=True)

    handler = functools.partial(Handler, directory=str(ROOT))
    httpd = Server(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    url = ("http://127.0.0.1:%d/index.html?scenario=%s&level=%s&record=%d"
           "&recordStep=%s&t=%s&w=%d&h=%d&seed=%d&quality=%s&hud=1"
           % (port, args.scenario, args.level, args.frames, args.step,
              args.t, args.w, args.h, args.seed, args.quality))

    profile = pathlib.Path(tempfile.gettempdir()) / ("blackout-rec-%s-%s" % (args.level, args.scenario))
    print("recording %d frames of %s/%s ..." % (args.frames, args.level, args.scenario))
    try:
        subprocess.run(
            [find_chrome(), "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
             "--enable-unsafe-swiftshader", "--hide-scrollbars",
             "--window-size=%d,%d" % (args.w, args.h),
             "--user-data-dir=%s" % profile,
             "--virtual-time-budget=%d" % (60000 + args.frames * 4000),
             "--dump-dom", url],
            capture_output=True, text=True, timeout=args.timeout, errors="replace")
    except subprocess.TimeoutExpired:
        print("  chrome timed out; keeping %d frames received so far" % len(FRAMES))
    finally:
        httpd.shutdown()
        httpd.server_close()

    if not FRAMES:
        sys.exit("no frames received - did the page error before recording?")

    ordered = [FRAMES[k] for k in sorted(FRAMES)]
    if args.scale != 1.0:
        w = int(ordered[0].width * args.scale)
        h = int(ordered[0].height * args.scale)
        ordered = [im.resize((w, h), Image.LANCZOS) for im in ordered]

    # Quantise to a shared adaptive palette so the animation does not flicker
    # between per-frame palettes.
    pal = ordered[0].quantize(colors=256, method=Image.MEDIANCUT)
    quant = [im.quantize(palette=pal, dither=Image.FLOYDSTEINBERG) for im in ordered]
    quant[0].save(out, save_all=True, append_images=quant[1:],
                  duration=int(1000 / args.fps), loop=0, optimize=True)
    print("wrote %s  %d frames  %dx%d  %.1f KB"
          % (out, len(quant), quant[0].width, quant[0].height, out.stat().st_size / 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main())
