#!/usr/bin/env python3
"""serve.py — serve exactly one file: verdict.json.

Minimal http.server handler; everything except /verdict.json is 404, no
directory listing. Bind PORT (default 8080). Directory is the state dir.
"""
import http.server
import os
import socketserver

PORT = int(os.environ.get("PORT", "8080"))
STATE = os.environ.get("STATE_DIR", "/state")
VERDICT = os.path.join(STATE, "verdict.json")


class Handler(http.server.BaseHTTPRequestHandler):
    def _respond(self, code, ctype, body=b""):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] in ("/verdict.json", "/verdict.json/"):
            try:
                with open(VERDICT, "rb") as f:
                    self._respond(200, "application/json", f.read())
            except FileNotFoundError:
                self._respond(503, "application/json", b'{"status":"not-ready"}')
            except Exception:
                self._respond(500, "application/json", b'{"status":"error"}')
            return
        self._respond(404, "text/plain", b"not found")

    do_HEAD = do_GET

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    os.makedirs(STATE, exist_ok=True)
    Server(("0.0.0.0", PORT), Handler).serve_forever()
