#!/usr/bin/env python3
"""mdf-drift-checker — compare the two demo hosts' manifests and a fresh
repo baseline, emit a verdict state.

Runs on unraid-syd inside `mdf-drift-checker`, invoked every 5 minutes by a
host user.scripts wrapper (`docker exec mdf-drift-checker ...`). Also serves
verdict.json via serve.py for Kuma.

States (distinct; never collapse into each other):
  ok / diff / stale-local / stale-public / invalid-local / invalid-public /
  endpoint-unreachable / repo-fetch-failed / maintenance

Alarm semantics: alarm=True for diff once the consecutive threshold is met,
and for stale-*/invalid-* immediately. endpoint-unreachable, repo-fetch-failed,
ok and maintenance never alarm (they have their own signals).

Security:
  - remote manifest is untrusted input: parsed and shape-checked; malformed
    data becomes invalid-* , never a crash.
  - every digest comparison uses hmac.compare_digest (timing-safe).
  - no secrets enter this process: only already-published HMAC digest strings
    are compared.
"""

import datetime as _dt
import json
import os
import subprocess
import tempfile
import urllib.request
import urllib.error

DEFAULTS = {
    "host_label": "unraid-syd",
    "public_manifest_url": "http://mdf-manifest-public.pygmy-bramble.ts.net/manifest.json",
    "syd_manifest_path": "/syd/manifest.json",
    "repo_url": "https://github.com/bitcryptic-gw/mdf-reference-server",
    "repo_local_dir": None,           # test override; production clones fresh per run
    "manifest_script": "/opt/mdf-drift/manifest.sh",
    "interval_s": 300,
    "stale_grace_s": 150,
    "alarm_after": 2,
    "hold_ttl_s": 3600,
    "state_dir": "/state",
    "request_timeout_s": 20,
}


def _now():
    return _dt.datetime.now(_dt.timezone.utc)


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(s):
    try:
        return _dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def ct_eq(a, b):
    """Timing-safe equality for ascii digest strings."""
    if not isinstance(a, str) or not isinstance(b, str) or len(a) != len(b):
        return False
    return _hmac_compare(a, b)


def _hmac_compare(a, b):
    import hmac
    return hmac.compare_digest(a, b)


class Manifest:
    def __init__(self, raw, label):
        self.label = label
        self.ok = True
        self.error = ""
        self.host = ""
        self.generated_at = None
        self.mdf_yaml = ""
        self.content = {}
        self.secrets = {}
        try:
            d = json.loads(raw)
        except Exception as e:
            self.ok = False
            self.error = f"not valid JSON: {e}"
            return
        if not isinstance(d, dict) or not isinstance(d.get("mdf"), dict):
            self.ok = False
            self.error = "root/mdf not an object"
            return
        m = d["mdf"]
        y = m.get("mdf_yaml")
        c = m.get("content")
        if not isinstance(y, str) or not y or not isinstance(c, dict):
            self.ok = False
            self.error = "missing mdf_yaml or content object"
            return
        self.host = str(d.get("host", ""))
        self.generated_at = _parse_iso(str(d.get("generated_at", "")))
        if self.generated_at is None:
            self.ok = False
            self.error = "missing/invalid generated_at"
            return
        for k, v in c.items():
            if isinstance(k, str) and isinstance(v, str):
                self.content[k] = v
            else:
                self.ok = False
                self.error = "malformed content entry"
                return
        self.mdf_yaml = y
        s = m.get("secrets")
        if isinstance(s, dict):
            for k, v in s.items():
                if isinstance(k, str) and isinstance(v, str):
                    self.secrets[k] = v

    def stale(self, now, max_age_s):
        return (now - self.generated_at).total_seconds() > max_age_s


def _load_config(path):
    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    merged = dict(DEFAULTS)
    merged.update(cfg)
    return merged


def _fetch(url, timeout):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception:
        return None, ""


def _repo_digests(cfg):
    if cfg.get("repo_local_dir"):
        repo = cfg["repo_local_dir"]
    else:
        tmp = tempfile.mkdtemp(prefix="mdf-drift-repo-")
        repo = os.path.join(tmp, "ref")
        try:
            subprocess.run(["git", "clone", "--depth", "1", cfg["repo_url"], repo],
                           check=True, capture_output=True, timeout=90)
        except Exception as e:
            return None, f"git clone failed: {e}"
    try:
        out = subprocess.run(["/bin/sh", cfg["manifest_script"], "repo-digests", repo],
                             check=True, capture_output=True, text=True, timeout=30).stdout
        obj = json.loads(out)
        if not isinstance(obj.get("content"), dict) or not isinstance(obj.get("mdf_yaml"), str):
            return None, "repo-digests returned unexpected shape"
        return obj, None
    except Exception as e:
        return None, f"repo-digests failed: {e}"


def _compare(label, a_map, b_map, aname, bname):
    diffs = []
    for key in sorted(set(a_map) | set(b_map)):
        av, bv = a_map.get(key), b_map.get(key)
        if av is None and bv is None:
            continue
        if av is None:
            diffs.append(f"{label}/{key} present on {bname} but missing on {aname}")
        elif bv is None:
            diffs.append(f"{label}/{key} present on {aname} but missing on {bname}")
        elif not ct_eq(av, bv):
            diffs.append(f"{label}/{key} differs")
    return diffs


def run_check(cfg):
    now = _now()
    state_dir = cfg["state_dir"]
    os.makedirs(state_dir, exist_ok=True)
    counter_path = os.path.join(state_dir, "consecutive")
    clean_path = os.path.join(state_dir, "last_clean")

    def read_counter():
        try:
            with open(counter_path) as f:
                return int(f.read().strip())
        except Exception:
            return 0

    def read_clean():
        try:
            with open(clean_path) as f:
                return f.read().strip()
        except Exception:
            return None

    counter = read_counter()
    last_clean = read_clean()

    def finalize(status, details, extra=None):
        nonlocal last_clean
        if status == "diff":
            n = counter + 1
        else:
            n = 0
        if status == "ok":
            last_clean = _iso(now)
        verdict = {
            "status": status,
            "alarm": bool(
                (status == "diff" and n >= cfg["alarm_after"])
                or status in ("stale-local", "stale-public", "invalid-local", "invalid-public")
            ),
            "consecutive_diffs": n,
            "generated_at": _iso(now),
            "last_clean_ts": last_clean,
            "details": list(details) + (extra or []),
        }
        with open(counter_path, "w") as f:
            f.write(str(n))
        with open(clean_path, "w") as f:
            f.write(str(last_clean or ""))
        tmp = os.path.join(state_dir, "verdict.json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(verdict, f, indent=2)
        os.replace(tmp, os.path.join(state_dir, "verdict.json"))
        return verdict

    # Maintenance HOLD (TTL)
    hold = os.path.join(state_dir, "HOLD")
    if os.path.exists(hold) and (now.timestamp() - os.path.getmtime(hold)) < cfg["hold_ttl_s"]:
        return finalize("maintenance", ["maintenance hold active (TTL {:.0f}s)".format(cfg["hold_ttl_s"])])

    pub_status, pub_raw = _fetch(cfg["public_manifest_url"], cfg["request_timeout_s"])
    if pub_status is None:
        return finalize("endpoint-unreachable", ["public manifest endpoint unreachable"])
    if not (200 <= pub_status < 300) or not pub_raw:
        return finalize("invalid-public", [f"public manifest fetch HTTP {pub_status}"])

    public = Manifest(pub_raw, "public")
    if not public.ok:
        return finalize("invalid-public", [f"public manifest malformed: {public.error}"])

    try:
        with open(cfg["syd_manifest_path"], encoding="utf-8") as f:
            syd = Manifest(f.read(), "syd")
    except Exception as e:
        return finalize("invalid-local", [f"syd manifest unreadable: {e}"])
    if not syd.ok:
        return finalize("invalid-local", [f"syd manifest malformed: {syd.error}"])

    max_age = cfg["interval_s"] + cfg["stale_grace_s"]
    if public.stale(now, max_age):
        return finalize("stale-public", [f"public manifest stale ({public.host})"])
    if syd.stale(now, max_age):
        return finalize("stale-local", [f"syd manifest stale ({syd.host})"])

    # Repo baseline (fresh shallow clone per run — never a persistent checkout)
    repo, repo_err = _repo_digests(cfg)

    diffs = []
    if repo is not None:
        diffs += _compare("content(repo-vs-public)", repo["content"], public.content, "repo", "public")
        diffs += _compare("content(repo-vs-syd)", repo["content"], syd.content, "repo", "syd")
        diffs += _compare("mdf.yaml(repo-vs-public)", {"mdf": repo["mdf_yaml"]}, {"mdf": public.mdf_yaml}, "repo", "public")
        diffs += _compare("mdf.yaml(repo-vs-syd)", {"mdf": repo["mdf_yaml"]}, {"mdf": syd.mdf_yaml}, "repo", "syd")
    diffs += _compare("content(public-vs-syd)", public.content, syd.content, "public", "syd")
    diffs += _compare("mdf.yaml(public-vs-syd)", {"mdf": public.mdf_yaml}, {"mdf": syd.mdf_yaml}, "public", "syd")
    diffs += _compare("secrets(public-vs-syd)", public.secrets, syd.secrets, "public", "syd")

    extra = []
    if repo is None:
        extra = [f"repo baseline unavailable: {repo_err}"]

    if not diffs and repo is not None:
        return finalize("ok", ["all comparisons agree"])
    if not diffs and repo is None:
        # can't compare against repo, but public==syd; treat as operational gap
        return finalize("repo-fetch-failed", [f"repo fetch failed: {repo_err}", "host-to-host comparison agreed"])

    return finalize("diff", diffs, extra=extra)


def main():
    import sys
    cfg = _load_config(sys.argv[1] if len(sys.argv) > 1 else "/config/config.json")
    verdict = run_check(cfg)
    print(json.dumps(verdict))


if __name__ == "__main__":
    main()
