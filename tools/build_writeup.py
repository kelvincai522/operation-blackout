"""Build the self-contained technical write-up.

docs/writeup.src.html is the editable source: prose plus {{FIG:file|caption}}
tokens. This inlines every referenced image and animation as a base64 data URI
and emits docs/technical-writeup.html, which is a single file that opens
anywhere with no external requests -- the same property the game itself has.

    python tools/build_writeup.py
"""
import base64
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "docs" / "writeup.src.html"
OUT = ROOT / "docs" / "technical-writeup.html"
ASSETS = ROOT / "docs" / "embed"

MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".png": "image/png", ".gif": "image/gif",
        ".wav": "audio/wav", ".mp4": "video/mp4"}

CSS = """
body { max-width: 900px; margin: 0 auto; padding: 48px 28px 96px;
       font: 16px/1.65 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
       color: #1c1f23; background: #fff; }
h1 { font-size: 30px; line-height: 1.25; margin: 52px 0 14px; padding-bottom: 8px;
     border-bottom: 2px solid #1c1f23; }
h1:first-of-type { margin-top: 0; }
h2 { font-size: 21px; margin: 34px 0 10px; color: #16202b; }
p { margin: 12px 0; }
hr { border: 0; border-top: 1px solid #d6dbe0; margin: 44px 0; }
table { border-collapse: collapse; width: 100%; margin: 18px 0; font-size: 14.5px; }
th, td { border: 1px solid #d6dbe0; padding: 8px 11px; text-align: left; vertical-align: top; }
th { background: #f2f5f8; font-weight: 600; }
code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
       font-size: 13.5px; background: #f2f5f8; padding: 1px 5px; border-radius: 3px; }
pre { background: #12171d; color: #dfe7ef; padding: 16px 18px; border-radius: 6px;
      overflow-x: auto; font-size: 13px; line-height: 1.55; }
pre code { background: none; color: inherit; padding: 0; font-size: 13px; }
figure { margin: 28px 0; }
figure img { width: 100%; height: auto; display: block; border-radius: 5px;
             border: 1px solid #d6dbe0; }
figcaption { font-size: 13.5px; color: #4a5560; margin-top: 9px; line-height: 1.5; }
figcaption b { color: #1c1f23; }
.demo img { border-color: #2a3540; }
ul, ol { margin: 12px 0; padding-left: 26px; }
li { margin: 5px 0; }
"""


def encode(name):
    p = ASSETS / name
    if not p.exists():
        return None
    mime = MIME.get(p.suffix.lower())
    if not mime:
        return None
    return "data:%s;base64,%s" % (mime, base64.b64encode(p.read_bytes()).decode("ascii"))


def main():
    if not SRC.exists():
        sys.exit("missing source: %s" % SRC)
    html = SRC.read_text(encoding="utf-8")

    missing, embedded, total = [], 0, 0

    def sub(m):
        nonlocal embedded, total
        name, caption = m.group(1).strip(), m.group(2).strip()
        uri = encode(name)
        if uri is None:
            missing.append(name)
            return ('<p><i>[figure unavailable: %s]</i></p>' % name)
        embedded += 1
        total += (ASSETS / name).stat().st_size
        cls = ' class="demo"' if name.lower().endswith(".gif") else ""
        return ('<figure%s><img alt="%s" src="%s">\n<figcaption>%s</figcaption></figure>'
                % (cls, caption[:120].replace('"', "'"), uri, caption))

    html = re.sub(r"\{\{FIG:([^|}]+)\|([^}]*)\}\}", sub, html)

    doc = ("<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">\n"
           "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n"
           "<title>Operation Blackout — Technical Write-up</title>\n"
           "<style>%s</style></head>\n<body>\n%s\n</body></html>\n" % (CSS, html))
    OUT.write_text(doc, encoding="utf-8")

    print("embedded %d assets (%.1f MB source media)" % (embedded, total / 1048576))
    for m in missing:
        print("  MISSING: %s" % m)
    print("wrote %s  (%.1f MB self-contained)" % (OUT, OUT.stat().st_size / 1048576))
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
