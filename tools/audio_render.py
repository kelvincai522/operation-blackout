"""Render the game's SYNTHESIZED audio to .wav files, offline.

*** KNOWN LIMITATION: THIS DOES NOT CURRENTLY WORK HEADLESS. ***

Every sound in this project is generated at runtime by src/audio/audio.js -
there are no audio files anywhere - so the audio cannot be shown to anyone who
is not running the game. The approach here is sound: swap an
OfflineAudioContext in before the module is constructed, trigger a sound,
render faster than real time, encode a WAV and POST it back.

Two obstacles were found and one was solved:

  SOLVED: audio.js refuses to arm unless actx.state === 'running', which is a
  correct guard so a machine with no output device stays silent rather than
  throwing. An OfflineAudioContext reports 'suspended' until rendering starts,
  so the guard muted everything. Presenting a 'running' state and a no-op
  resume() satisfies it.

  UNSOLVED: OfflineAudioContext.startRendering() does not appear to advance
  under Chrome's --virtual-time-budget clock. The promise never settles, the
  page never finishes, and no frames are posted. Virtual time fast-forwards
  timers, but offline audio rendering is driven elsewhere.

To finish this, run it against a real (non-virtual-time) Chrome with a wall
clock and a generous timeout, or drive the render over CDP instead of
--dump-dom. Left in the tree because the diagnosis is most of the work.

    python tools/audio_render.py
    python tools/audio_render.py --only gunshot_market
"""
import argparse
import base64
import functools
import http.server
import json
import pathlib
import re
import socketserver
import subprocess
import sys
import tempfile
import threading

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from shoot import find_chrome  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
RESULTS = {}
_LOCK = threading.Lock()

# Each entry: (id, seconds, JS that triggers the sound on `a` = GAME.Audio)
SOUNDS = [
    ("gunshot_market", 3.0,
     "a.setReverb && a.setReverb('outdoor');"
     "a.playGunshot ? a.playGunshot({name:'M4A1',rpm:800}, null) : a.play('gunshot');"),
    ("gunshot_harbor", 4.0,
     "a.setReverb && a.setReverb('harbor');"
     "a.playGunshot ? a.playGunshot({name:'M4A1',rpm:800}, null) : a.play('gunshot');"),
    ("explosion", 5.0,
     "a.play && a.play('explosion', {volume:1});"),
    ("thunder", 6.0,
     "a.play && a.play('thunder', {volume:1});"),
    ("footstep", 1.2,
     "a.play && a.play('footstep', {volume:1});"),
    ("reload", 3.0,
     "a.play && a.play('reload', {volume:1});"),
]

PAGE = r"""<!doctype html><meta charset="utf-8"><body>
<script src="/vendor/three.global.js"></script>
<script src="/src/core/util.js"></script>
<script src="/src/audio/audio.js"></script>
<script>
// Encode Float32 channel data as a 16-bit PCM WAV.
function toWav(buf) {
  var n = buf.length, ch = Math.min(2, buf.numberOfChannels), rate = buf.sampleRate;
  var data = new DataView(new ArrayBuffer(44 + n * ch * 2));
  function s(o, str) { for (var i = 0; i < str.length; i++) data.setUint8(o + i, str.charCodeAt(i)); }
  s(0, 'RIFF'); data.setUint32(4, 36 + n * ch * 2, true); s(8, 'WAVE');
  s(12, 'fmt '); data.setUint32(16, 16, true); data.setUint16(20, 1, true);
  data.setUint16(22, ch, true); data.setUint32(24, rate, true);
  data.setUint32(28, rate * ch * 2, true); data.setUint16(32, ch * 2, true);
  data.setUint16(34, 16, true); s(36, 'data'); data.setUint32(40, n * ch * 2, true);
  var off = 44;
  var chans = [];
  for (var c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
  for (var i = 0; i < n; i++) {
    for (var c2 = 0; c2 < ch; c2++) {
      var v = Math.max(-1, Math.min(1, chans[c2][i]));
      data.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
      off += 2;
    }
  }
  var bytes = new Uint8Array(data.buffer), bin = '';
  for (var k = 0; k < bytes.length; k++) bin += String.fromCharCode(bytes[k]);
  return btoa(bin);
}

async function renderOne(id, secs, trigger) {
  var rate = 44100;
  var off = new OfflineAudioContext(2, Math.ceil(rate * secs), rate);
  // The module constructs its own AudioContext; hand it the offline one so it
  // schedules into a buffer we can read instead of a sound card that is not
  // present in headless Chrome.
  //
  // audio.js deliberately refuses to arm unless actx.state === 'running' (so a
  // machine with no output device stays silent instead of throwing). An
  // OfflineAudioContext reports 'suspended' until startRendering, so that
  // correct guard would keep every sound muted here. Present it as running and
  // give it a no-op resume(); rendering is what actually advances the graph.
  try {
    Object.defineProperty(off, 'state', { get: function () { return 'running'; }, configurable: true });
  } catch (e) {}
  if (!off.resume) off.resume = function () { return Promise.resolve(); };
  var RealAC = window.AudioContext;
  window.AudioContext = function () { return off; };
  window.webkitAudioContext = window.AudioContext;
  var note = '';
  try {
    var a = new window.GAME.Audio({ camera: null, levelId: 'market', rng: new window.GAME.RNG(7) });
    if (a.build) await a.build({ camera: null });
    if (a.unlock) try { a.unlock(); } catch (e) {}
    // Point any internal destination at the offline graph if the module exposes one.
    eval(trigger);
    if (a.update) for (var f = 0; f < Math.ceil(secs * 60); f++) a.update(1 / 60, { camera: null });
  } catch (e) {
    note = String(e && e.message || e);
  }
  window.AudioContext = RealAC;
  var buf = await off.startRendering();
  var peak = 0, chan = buf.getChannelData(0);
  for (var i = 0; i < chan.length; i++) peak = Math.max(peak, Math.abs(chan[i]));
  return { wav: toWav(buf), peak: peak, note: note };
}

(async function () {
  var jobs = __JOBS__;
  var log = [];
  for (var i = 0; i < jobs.length; i++) {
    var j = jobs[i];
    try {
      var r = await renderOne(j[0], j[1], j[2]);
      await fetch('/_wav?id=' + j[0] + '&peak=' + r.peak.toFixed(4), { method: 'POST', body: r.wav });
      log.push(j[0] + ':' + r.peak.toFixed(4) + (r.note ? ' (' + r.note + ')' : ''));
    } catch (e) {
      log.push(j[0] + ':ERR ' + e);
    }
  }
  document.title = 'AUDIO ' + log.join(' | ');
})();
</script></body>"""


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *a):
        pass

    def do_POST(self):
        if not self.path.startswith("/_wav"):
            self.send_error(404)
            return
        sid = re.search(r"id=([\w-]+)", self.path)
        peak = re.search(r"peak=([\d.]+)", self.path)
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        with _LOCK:
            RESULTS[sid.group(1) if sid else "unknown"] = (
                base64.b64decode(body), float(peak.group(1)) if peak else 0.0)
        self.send_response(204)
        self.end_headers()


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default=None)
    ap.add_argument("--outdir", default=str(ROOT / "docs" / "audio"))
    ap.add_argument("--timeout", type=int, default=600)
    args = ap.parse_args()

    jobs = [s for s in SOUNDS if not args.only or s[0] == args.only]
    outdir = pathlib.Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    # json.dumps, NOT repr().replace("'", '"') - the trigger snippets contain
    # single quotes (a.setReverb('outdoor')) and that naive swap corrupts them
    # into broken JS, which fails at parse time with no error to show for it.
    page = PAGE.replace("__JOBS__", json.dumps([[a, b, c] for a, b, c in jobs]))
    tmp = ROOT / "._audio.html"
    tmp.write_text(page, encoding="utf-8")

    handler = functools.partial(Handler, directory=str(ROOT))
    httpd = Server(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        proc = subprocess.run(
            [find_chrome(), "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
             "--enable-unsafe-swiftshader", "--mute-audio",
             "--user-data-dir=%s" % (pathlib.Path(tempfile.gettempdir()) / "blackout-audio"),
             "--virtual-time-budget=180000", "--dump-dom",
             "http://127.0.0.1:%d/%s" % (port, tmp.name)],
            capture_output=True, text=True, timeout=args.timeout, errors="replace")
    except subprocess.TimeoutExpired:
        proc = None
        print("chrome timed out")
    finally:
        httpd.shutdown()
        httpd.server_close()
        tmp.unlink(missing_ok=True)

    if proc:
        out = proc.stdout or ""
        m = re.search(r"<title>(.*?)</title>", out, re.S)
        print("page report: %s" % (m.group(1)[:600] if m else "(no title - the page threw before finishing)"))
        if not m or "AUDIO" not in m.group(1):
            # Surface whatever the page did manage to say, so a failure here is
            # diagnosable instead of just silent.
            err = re.findall(r"(Uncaught[^<]{0,200}|ReferenceError[^<]{0,200}|TypeError[^<]{0,200})", out)
            for e in err[:5]:
                print("   %s" % e.strip())
            tail = (proc.stderr or "")[-400:]
            if tail.strip():
                print("   stderr: %s" % tail.strip()[:400])

    if not RESULTS:
        print("no audio rendered - see the page report above")
        return 1
    for sid, (raw, peak) in sorted(RESULTS.items()):
        p = outdir / ("%s.wav" % sid)
        p.write_bytes(raw)
        status = "OK  " if peak > 0.001 else "SILENT"
        print("%s %-18s %7.1f KB  peak=%.4f" % (status, p.name, len(raw) / 1024, peak))
    return 0


if __name__ == "__main__":
    sys.exit(main())
