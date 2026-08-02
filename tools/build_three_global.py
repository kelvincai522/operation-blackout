"""Convert three.js r180 (ESM: three.core.js + three.module.js) into a single
classic-script global build exposing window.THREE.

There is no Node.js on this machine, so the game ships as plain <script> tags
and runs straight from file:// with no bundler and no server.

Each source file keeps its own function scope (they declare colliding
top-level helper names, so a naive concatenation is a SyntaxError). The
module's ESM imports are re-injected as local bindings taken from the core
module's returned export object.
"""
import re
import sys
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor"
CORE = VENDOR / "three.core.js"
MODULE = VENDOR / "three.module.js"
OUT = VENDOR / "three.global.js"

IDENT = r"[A-Za-z_$][\w$]*"


def parse_spec_list(body):
    """`a, b as c` -> [(outerName, innerName), ...].

    For exports: outer = exported name, inner = local binding.
    For imports: outer = name in source module, inner = local alias.
    """
    out = []
    for raw in body.split(","):
        raw = raw.strip()
        if not raw:
            continue
        if " as " in raw:
            first, second = [p.strip() for p in raw.split(" as ")]
        else:
            first = second = raw
        for n in (first, second):
            if not re.fullmatch(IDENT, n):
                sys.exit("unparsable specifier %r" % raw)
        out.append((first, second))
    return out


def find_statements(src, keyword):
    """Top-level `export {...}` / `import {...}` statements.

    Returns [(start, end_exclusive, brace_body, from_target_or_None)].
    """
    found = []
    for m in re.finditer(r"^%s\s*\{" % keyword, src, flags=re.M):
        open_brace = src.index("{", m.start())
        close_brace = src.index("}", open_brace)
        body = src[open_brace + 1:close_brace]
        rest = src[close_brace + 1:]
        fm = re.match(r"\s*from\s*['\"]([^'\"]+)['\"]\s*;", rest)
        if fm:
            found.append((m.start(), close_brace + 1 + fm.end(), body, fm.group(1)))
            continue
        sm = re.match(r"\s*;", rest)
        if not sm:
            sys.exit("malformed %s statement at %d" % (keyword, m.start()))
        found.append((m.start(), close_brace + 1 + sm.end(), body, None))
    return found


def check_no_stray(src, label):
    for m in re.finditer(r"^export\b(?!\s*\{)", src, flags=re.M):
        sys.exit("%s: unsupported top-level export: %r"
                 % (label, src[m.start():m.start() + 60]))
    for m in re.finditer(r"^import\b(?!\s*[\{(])", src, flags=re.M):
        sys.exit("%s: unsupported top-level import: %r"
                 % (label, src[m.start():m.start() + 60]))


def strip(src, statements):
    out, prev = [], 0
    for start, end, _b, _t in sorted(statements):
        out.append(src[prev:start])
        prev = end
    out.append(src[prev:])
    return "".join(out)


core_src = CORE.read_text(encoding="utf-8")
mod_src = MODULE.read_text(encoding="utf-8")

# --- core -------------------------------------------------------------------
core_exports = find_statements(core_src, "export")
if find_statements(core_src, "import"):
    sys.exit("three.core.js unexpectedly has imports")
if len(core_exports) != 1 or core_exports[0][3] is not None:
    sys.exit("unexpected export shape in three.core.js")

core_pairs = parse_spec_list(core_exports[0][2])       # exported -> local
core_body = strip(core_src, core_exports)
check_no_stray(core_body, "three.core.js")

# --- module -----------------------------------------------------------------
mod_exports = find_statements(mod_src, "export")
mod_imports = find_statements(mod_src, "import")
for _s, _e, _b, target in mod_imports:
    if target != "./three.core.js":
        sys.exit("module imports from unexpected target: %r" % target)

core_export_names = set(e for e, _l in core_pairs)
inject = []                                            # local alias <- core name
for _s, _e, body, _t in mod_imports:
    for source_name, local in parse_spec_list(body):
        if source_name not in core_export_names:
            sys.exit("module imports unknown core name: %r" % source_name)
        inject.append((local, source_name))

from_core = {}   # public name -> core export name
from_mod = {}    # public name -> module local binding
for _s, _e, body, target in mod_exports:
    for exported, local in parse_spec_list(body):
        if target == "./three.core.js":
            if exported not in core_export_names:
                sys.exit("re-export not found in core: %r" % exported)
            from_core[local] = exported
        elif target is None:
            from_mod[exported] = local
        else:
            sys.exit("export from unexpected target: %r" % target)

mod_body = strip(mod_src, mod_exports + mod_imports)
check_no_stray(mod_body, "three.module.js")

total = len(from_core) + len(from_mod)
if total < 400:
    sys.exit("suspiciously few exports (%d)" % total)
overlap = set(from_core) & set(from_mod)
if overlap:
    sys.exit("name exported by both core and module: %s" % sorted(overlap)[:5])

core_ret = ",\n    ".join("%s: %s" % (e, l) for e, l in core_pairs)
inject_src = "\n  ".join("var %s = __core.%s;" % (l, c) for l, c in inject)
mod_ret = ",\n    ".join("%s: %s" % (e, l) for e, l in sorted(from_mod.items()))
public_src = ",\n  ".join(
    ["%s: __core.%s" % (p, c) for p, c in sorted(from_core.items())]
    + ["%s: __mod.%s" % (p, p) for p in sorted(from_mod)]
)

OUT.write_text(
    "// Generated by tools/build_three_global.py - DO NOT EDIT.\n"
    "// three.js r180 (three.core.js + three.module.js) as a classic script.\n"
    "// Exposes window.THREE so the game runs from file:// with no bundler.\n"
    "(function () {\n"
    "'use strict';\n"
    "var __core = (function () {\n"
    + core_body
    + "\n  return {\n    " + core_ret + "\n  };\n})();\n"
    "var __mod = (function (__core) {\n  "
    + inject_src + "\n"
    + mod_body
    + "\n  return {\n    " + mod_ret + "\n  };\n})(__core);\n"
    "window.THREE = {\n  " + public_src + "\n};\n"
    "})();\n",
    encoding="utf-8",
)
print("core exports:", len(core_pairs), " injected:", len(inject))
print("public exports:", total)
print("wrote:", OUT.name, OUT.stat().st_size, "bytes")
