#!/usr/bin/env python3
"""Scenario harness for mdf-drift-checker + manifest.sh.

Proves (do not assert):
  1. two hosts with IDENTICAL inputs (incl. different mdf.yaml pubkey
     placeholder forms) produce byte-identical manifest digests;
  2. the checker state matrix: ok / diff(1) / diff(2 alarm) / stale-public /
     stale-local / invalid-public / endpoint-unreachable / repo-fetch-failed /
     maintenance, plus HOLD TTL expiry and hysteresis reset.

Run:  python3 run-scenarios.py [path/to/manifest.sh] [path/to/run-check.py dir]
"""
import datetime as dt
import http.server
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(HERE), "manifest.sh")
CHECK_DIR = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(HERE)
_spec = importlib.util.spec_from_file_location("run_check", os.path.join(CHECK_DIR, "run-check.py"))
run_check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(run_check)

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("PASS  " if cond else "FAIL  ") + name + (f"  [{detail}]" if detail and not cond else ""))


def sh(*a):
    return subprocess.run(a, capture_output=True, text=True)


def now_iso():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def old_iso(age_s):
    return (dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=age_s)).strftime("%Y-%m-%dT%H:%M:%SZ")


def mktree(root, pubkey_line, marker=""):
    """Create an appdata-shaped dir. Returns nothing; writes files."""
    content = os.path.join(root, "content")
    os.makedirs(os.path.join(content, "docs"))
    os.makedirs(os.path.join(content, "micropayment"))
    os.makedirs(os.path.join(content, "premium"))
    os.makedirs(os.path.join(content, "private"))
    os.makedirs(os.path.join(root, "secrets"))
    with open(os.path.join(content, "index.md"), "w") as f:
        f.write("# Welcome" + marker + "\n- [x] thing\n")
    with open(os.path.join(content, "docs", "getting-started.md"), "w") as f:
        f.write("# Getting Started\nbody\n")
    with open(os.path.join(content, "micropayment", "intro.md"), "w") as f:
        f.write("# Micropayment\none sat\n")
    with open(os.path.join(content, "premium", "deep-dive.md"), "w") as f:
        f.write("# Premium\npay me\n")
    with open(os.path.join(content, "private", "internals.md"), "w") as f:
        f.write("# Private\ntoken gated\n")
    mdf = (
        "site:\n  url: https://mdf-demo.bitcryptic.com\npricing:\n"
        "  default:\n    amount: \"0.0001\"\n"
        "  sections:\n    /docs/**:\n      amount: \"0.0000\"\n"
        "oracle:\n  pubkey: " + pubkey_line + "\n"
    )
    with open(os.path.join(root, "mdf.yaml"), "w") as f:
        f.write(mdf)
    sec = {"wallet_address": "0xa7D9" + "11" * 19, "alby_api_token": "tokA" + "x" * 40,
           "lightning_token_secret": "ls_" + "y" * 60, "oracle_pubkey": "0x" + "a" * 66}
    for name, val in sec.items():
        with open(os.path.join(root, "secrets", name), "w") as f:
            f.write(val)


def gen_manifest(appdata, out, salt, host):
    r = sh("/bin/sh", MANIFEST, "gen", appdata, out, salt, host)
    if r.returncode != 0:
        raise RuntimeError(r.stderr)
    with open(out) as f:
        return json.load(f)


class Server:
    def __init__(self):
        self.body = b"{}"
        handler = self._make_handler()
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.port = self.httpd.server_address[1]

    def _make_handler(self):
        srv = self

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(srv.body)

            def log_message(self, *a):
                pass

        return H

    def set(self, text):
        self.body = text if isinstance(text, bytes) else text.encode()


def cfg_for(state_dir, public_url, syd_manifest, repo_dir, **kw):
    c = {
        "host_label": "syd", "public_manifest_url": public_url,
        "syd_manifest_path": syd_manifest, "repo_url": "unused",
        "repo_local_dir": repo_dir, "manifest_script": MANIFEST,
        "interval_s": 5, "stale_grace_s": 5, "alarm_after": 2,
        "hold_ttl_s": 60, "state_dir": state_dir, "request_timeout_s": 3,
    }
    c.update(kw)
    return c


def main():
    tmp = tempfile.mkdtemp(prefix="mdf-drift-test-")
    try:
        salt = os.path.join(tmp, "salt")
        with open(salt, "w") as f:
            f.write("ab" * 32)

        appA = os.path.join(tmp, "appA"); os.makedirs(appA)
        appB = os.path.join(tmp, "appB"); os.makedirs(appB)
        mktree(appA, "[]                        # operator fills in")
        mktree(appB, '""')

        mA = os.path.join(tmp, "mA.json"); mB = os.path.join(tmp, "mB.json")
        gen_manifest(appA, mA, salt, "public")
        gen_manifest(appB, mB, salt, "syd")

        # --- Proof 1: identical digests across hosts despite placeholder forms
        a, b = json.load(open(mA)), json.load(open(mB))
        check("byte-identical mdf digest payload (pubkey [] vs \"\")",
              a["mdf"] == b["mdf"], json.dumps({"a": a["mdf"], "b": b["mdf"]})[:200])

        # fakerepo matching host A (like origin/main)
        repo = os.path.join(tmp, "repo"); os.makedirs(repo)
        shutil.copytree(os.path.join(appA, "content"), os.path.join(repo, "content"))
        shutil.copy(os.path.join(appA, "mdf.yaml"), os.path.join(repo, "mdf.yaml"))
        # repo content identical to A already; ensure index equals appA (markerless)

        # syd = mutated copy (differs in index.md + alby token)
        appBmut = os.path.join(tmp, "appBmut"); os.makedirs(appBmut)
        mktree(appBmut, '""', marker="\n# CHANGED")
        with open(os.path.join(appBmut, "secrets", "alby_api_token"), "w") as f:
            f.write("tokA" + "z" * 40)
        mBmut = os.path.join(tmp, "mBmut.json")
        gen_manifest(appBmut, mBmut, salt, "syd")

        srv = Server()
        # --- ok
        srv.set(open(mA).read())
        st = os.path.join(tmp, "st-ok"); os.makedirs(st)
        v = run_check.run_check(cfg_for(st, f"http://127.0.0.1:{srv.port}/manifest.json", mB, repo))
        check("ok: status ok, alarm false", v["status"] == "ok" and not v["alarm"], str(v))
        check("ok: consecutive reset to 0", v["consecutive_diffs"] == 0)

        # --- diff single (no alarm), then second run alarm (hysteresis)
        st2 = os.path.join(tmp, "st-diff"); os.makedirs(st2)
        cfg = cfg_for(st2, f"http://127.0.0.1:{srv.port}/manifest.json", mBmut, repo)
        v1 = run_check.run_check(cfg)
        check("diff first run: consecutive 1, alarm false", v1["status"] == "diff" and v1["consecutive_diffs"] == 1 and not v1["alarm"], str(v1))
        v2 = run_check.run_check(cfg)
        check("diff second run: consecutive 2, alarm true", v2["status"] == "diff" and v2["consecutive_diffs"] == 2 and v2["alarm"], str(v2))
        v3 = run_check.run_check(cfg_for(st2, f"http://127.0.0.1:{srv.port}/manifest.json", mB, repo))
        check("ok resets hysteresis", v3["status"] == "ok" and v3["consecutive_diffs"] == 0)

        # --- stale-public (serve an old manifest)
        old = json.loads(open(mA).read()); old["generated_at"] = old_iso(999)
        srv.set(json.dumps(old))
        st3 = os.path.join(tmp, "st-stalepub"); os.makedirs(st3)
        v = run_check.run_check(cfg_for(st3, f"http://127.0.0.1:{srv.port}/manifest.json", mB, repo))
        check("stale-public: distinct state, alarm true", v["status"] == "stale-public" and v["alarm"], str(v))

        # --- stale-local
        srv.set(open(mA).read())
        oldl = json.loads(open(mB).read()); oldl["generated_at"] = old_iso(999)
        with open(mB + ".old", "w") as f:
            json.dump(oldl, f)
        st4 = os.path.join(tmp, "st-stalelocal"); os.makedirs(st4)
        v = run_check.run_check(cfg_for(st4, f"http://127.0.0.1:{srv.port}/manifest.json", mB + ".old", repo))
        check("stale-local: distinct state, alarm true", v["status"] == "stale-local" and v["alarm"], str(v))

        # --- invalid-public
        srv.set(b"this is not json")
        st5 = os.path.join(tmp, "st-invpub"); os.makedirs(st5)
        v = run_check.run_check(cfg_for(st5, f"http://127.0.0.1:{srv.port}/manifest.json", mB, repo))
        check("invalid-public: distinct, alarm true", v["status"] == "invalid-public" and v["alarm"], str(v))

        # --- endpoint-unreachable
        srv.set(open(mA).read())
        st6 = os.path.join(tmp, "st-epu"); os.makedirs(st6)
        v = run_check.run_check(cfg_for(st6, "http://127.0.0.1:1/manifest.json", mB, repo))
        check("endpoint-unreachable: distinct, alarm false", v["status"] == "endpoint-unreachable" and not v["alarm"], str(v))

        # --- repo-fetch-failed (repo local dir missing; hosts agree)
        st7 = os.path.join(tmp, "st-repo"); os.makedirs(st7)
        v = run_check.run_check(cfg_for(st7, f"http://127.0.0.1:{srv.port}/manifest.json", mB, os.path.join(tmp, "nope-repo")))
        check("repo-fetch-failed: distinct, alarm false", v["status"] == "repo-fetch-failed" and not v["alarm"], str(v))

        # --- maintenance HOLD + TTL expiry
        st8 = os.path.join(tmp, "st-hold"); os.makedirs(st8)
        hold = os.path.join(st8, "HOLD")
        open(hold, "w").write("x")
        v = run_check.run_check(cfg_for(st8, f"http://127.0.0.1:{srv.port}/manifest.json", mBmut, repo))
        check("maintenance: HOLD suppresses, no alarm", v["status"] == "maintenance" and not v["alarm"], str(v))
        past = time.time() - 3600
        os.utime(hold, (past, past))
        v = run_check.run_check(cfg_for(st8, f"http://127.0.0.1:{srv.port}/manifest.json", mBmut, repo))
        check("HOLD expires on its own (not maintenance)", v["status"] != "maintenance", str(v))

        # --- salt missing => generator refuses to write
        r = sh("/bin/sh", MANIFEST, "gen", appA, os.path.join(tmp, "x.json"), os.path.join(tmp, "nosalt"), "public")
        check("generator refuses to write when salt missing", r.returncode != 0 and not os.path.exists(os.path.join(tmp, "x.json")), r.stderr)

        print(f"\n{PASS and 'RESULT: ' or ''}{len(PASS)} passed, {len(FAIL)} failed")
        if FAIL:
            print("FAILED:", FAIL)
            sys.exit(1)
        sys.exit(0)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
