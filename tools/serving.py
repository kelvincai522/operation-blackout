"""Ephemeral localhost static server shared by the capture/validation tools.

The shipped game runs fine from file://, but file:// gives scripts an opaque
origin, so every JS error collapses to a useless "Script error." with no line
number. Serving the same tree over http://127.0.0.1 during testing restores
real stack traces, which is what makes multi-module integration debuggable.
"""
import contextlib
import functools
import http.server
import pathlib
import socketserver
import threading

ROOT = pathlib.Path(__file__).resolve().parent.parent


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *a):
        pass

    def end_headers(self):
        # Never let Chrome serve a stale module from a previous iteration -
        # a cached file silently invalidates a whole critic round.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()


class _Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


@contextlib.contextmanager
def serve(directory=None):
    """Yield a base URL like http://127.0.0.1:54321 for the project root."""
    directory = str(directory or ROOT)
    handler = functools.partial(_Quiet, directory=directory)
    httpd = _Server(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        yield "http://127.0.0.1:%d" % port
    finally:
        httpd.shutdown()
        httpd.server_close()
