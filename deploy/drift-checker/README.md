# MDF drift checker

Detects divergence between the two MDF demo hosts and the `mdf-reference-server`
repo — content tree, `mdf.yaml`, and secret parity — compared three ways
(public↔repo, syd↔repo, public↔syd). Both prior incidents (the retired wallet
surviving on syd; the `index.md` micropayment fix reaching neither host) were
found by chance; this makes divergence visible instead.

Scope: **content tree, `mdf.yaml`, secret hashes**. `data/` is per-instance
runtime state and is deliberately excluded.

## Layout

| file | role |
|---|---|
| `manifest.sh` | Single canonical generator, shared by every role so canonicalisation cannot drift. Modes: `gen <appdata> <out> <salt> <host>` and `repo-digests <repo_dir>`. Normalises the `oracle.pubkey` placeholder (`""`/`[]` → sentinel) before hashing `mdf.yaml`; content = plain SHA-256 per `.md`; secrets = HMAC-SHA256 keyed by the shared salt, hex, truncated to 16 bytes. Refuses to write when the salt or any secret is missing. |
| `Dockerfile.manifest-public` / `nginx-manifest.conf` / `manifest-entrypoint.sh` | `mdf-manifest-public`: nginx serving exactly `/manifest.json` (nothing else, no listing) + busybox crond regenerating it every 5 min from the mounted appdata. **No docker socket.** |
| `Dockerfile.checker` | `mdf-drift-checker`: serves `verdict.json` on :8080 (see `serve.py`); the check itself runs via `docker exec mdf-drift-checker python3 /opt/mdf-drift/run-check.py`. |
| `run-check.py` | State machine. Fresh shallow clone of `mdf-reference-server` **per run** (never a persistent checkout). All digest comparisons are timing-safe (`hmac.compare_digest`). Remote manifest parsed defensively. |
| `serve.py` | Serves exactly `/verdict.json`; everything else 404. |
| `syd-manifest-wrapper.sh` | unraid-syd user.scripts "mdf-drift-manifest" (every 5 min) — generates the LOCAL syd manifest. |
| `syd-check-wrapper.sh` | unraid-syd user.scripts "mdf-drift-check" (every 5 min) — runs the checker and pings Healthchecks before/after (dead-man's switch). Ping URL is a credential held in a file. |
| `checker-config.example.json` | Config mounted at `/config/config.json` in the checker. |
| `test/run-scenarios.py` | Verification harness. |

## Verdict states (distinct, never collapsed into `diff`)

`ok` · `diff` · `stale-local` · `stale-public` · `invalid-local` ·
`invalid-public` · `endpoint-unreachable` · `repo-fetch-failed` ·
`maintenance`.

Alarm rules: `diff` alarms only after **two consecutive** differing runs
(hysteresis). `stale-*` and `invalid-*` alarm immediately.
`endpoint-unreachable`, `repo-fetch-failed`, `ok` and `maintenance` never alarm.
A TTL'd `HOLD` file suppresses alerting for planned divergence and expires on
its own.

`verdict.json` fields: `status`, `alarm`, `consecutive_diffs`, `generated_at`,
`last_clean_ts`, `details`.

## Host-side steps for Gary (in order)

Steps 1–8 are host actions. ACLs and container creation are Gary's; the
images build on each host (Unraid UI templates reference local images).

1. **Salt (manual first copy — itself an instance of the propagation gap this
   system exists to detect; deliberately documented).** Generate once, write
   the identical bytes to both hosts:
   ```bash
   # on either host
   openssl rand -hex 32
   # public
   printf '%s' '<hex>' > /mnt/cache/appdata/MDF-Server-Prod/drift-salt
   chmod 600 /mnt/cache/appdata/MDF-Server-Prod/drift-salt
   # syd
   printf '%s' '<hex>' > /mnt/cache/appdata/mdf-reference-server/drift-salt
   chmod 600 /mnt/cache/appdata/mdf-reference-server/drift-salt
   ```
   Never inside the served directory. Salt drift afterwards surfaces as an
   all-secrets mismatch (loud, recoverable: recopy).

2. **syd scratch dirs + shared generator:**
   ```bash
   mkdir -p /mnt/cache/appdata/mdf-drift /mnt/cache/appdata/mdf-drift-serve
   # copy deploy/drift-checker/manifest.sh from the repo:
   install -m 0755 <repo>/deploy/drift-checker/manifest.sh /mnt/cache/appdata/mdf-drift/manifest.sh
   ```

3. **Build images on each host** (from the repo root):
   ```bash
   # public
   docker build --platform linux/amd64 -f deploy/drift-checker/Dockerfile.manifest-public \
     -t mdf-manifest-public:latest deploy/drift-checker
   # syd
   docker build --platform linux/amd64 -f deploy/drift-checker/Dockerfile.checker \
     -t mdf-drift-checker:latest deploy/drift-checker
   ```

4. **unraid-public: create `mdf-manifest-public`** via the Docker UI template:
   Repository `mdf-manifest-public:latest`, Tailscale hostname
   `mdf-manifest-public` (placeholder authkey → set real one in UI), tag
   `tag:mdf-manifest` (Gary applies in ACL step 8). Mounts:
   - `/mnt/cache/appdata/MDF-Server-Prod` → `/mdf-appdata` (ro)
   - `/mnt/cache/appdata/mdf-drift-serve` → `/srv` (rw)
   No host port needed (tailnet-only). Container runs root (Tailscale hook),
   then the entrypoint starts crond + nginx.

5. **unraid-syd: create `mdf-drift-checker`** via UI:
   Repository `mdf-drift-checker:latest`, Tailscale hostname `mdf-drift-checker`,
   tag `tag:mdf-checker`. Mounts:
   - `/mnt/cache/appdata/mdf-drift-checker` → `/state` (rw; verdict, state, HOLD)
   - `/mnt/cache/appdata/mdf-reference-server/manifest.json` → `/syd/manifest.json` (ro)
   - `/mnt/cache/appdata/mdf-drift-checker/config.json` → `/config/config.json` (ro)
   Create `config.json` from `checker-config.example.json` first.

6. **unraid-syd user.scripts** — two jobs, each `*/5 * * * *`:
   - "mdf-drift-manifest": paste `syd-manifest-wrapper.sh` (writes the local
     syd manifest; no HTTP).
   - "mdf-drift-check": paste `syd-check-wrapper.sh` (runs the checker,
     pings Healthchecks).

7. **Healthchecks** (deploy per the monitoring-stack plan; then): create a
   check "MDF drift checker", period 5 min, grace 15 min; put its ping URL in
   a file (credential — never an env var or script text):
   ```bash
   printf '%s' 'https://hc.example/ping/<uuid>' > /mnt/cache/appdata/mdf-drift-checker/hc-ping.url
   chmod 600 /mnt/cache/appdata/mdf-drift-checker/hc-ping.url
   ```
   The wrapper pings `/start` before the run and `/success` or `/fail` after
   (fail = run error OR `verdict.alarm == true`). A silent stop is caught by
   Healthchecks' missed-run alert.

8. **ACL grants (admin console)** — three narrow HTTP grants, no SSH:
   - `tag:mdf-checker → tag:mdf-manifest` (one HTTP GET)
   - `tag:monitoring → tag:mdf-manifest`
   - `tag:monitoring → tag:mdf-checker`

9. **Kuma monitor (unraid-private)** — new monitor, not grouped with the MDF
   Demo service monitors, wired to a **distinct** ntfy notification
   (topic `MDF-Drift`, separate from `MDF-Demo`):
   - Type HTTP(s) - JSON Query, URL
     `http://mdf-drift-checker.pygmy-bramble.ts.net:8080/verdict.json`,
     JSON path `.alarm`, expected value `false`, interval 60 s.
   A drift alert then never looks like an outage. Optionally add a plain HTTP
   200 monitor on `http://mdf-manifest-public.pygmy-bramble.ts.net/manifest.json`
   (public manifest endpoint liveness); generator staleness is already caught
   by the checker's `stale-public`.

## Operational notes

- Maintenance window: `touch /mnt/cache/appdata/mdf-drift-checker/HOLD` (auto
  expires after 3600 s). Removes it by hand early if desired.
- Logs: syd generator/check logs in `/mnt/cache/appdata/mdf-drift/generator.log`
  and `/mnt/cache/appdata/mdf-drift-checker/run.log`.
- Changing the shared generator must be rolled to: public image (rebuild),
  syd `/mnt/cache/appdata/mdf-drift/manifest.sh`, and syd paste-copies in
  user.scripts if the wrapper embedded logic changed (it only calls the file).

## Verification performed

`test/run-scenarios.py` (14 checks), run on the host AND inside the built
`mdf-drift-checker` image against its baked `/opt/mdf-drift` files:

- two appdata trees with identical inputs but different `pubkey` placeholder
  forms produce **byte-identical** digest payloads;
- `ok` / `diff`(1, no alarm) / `diff`(2, alarm) / `stale-public` /
  `stale-local` / `invalid-public` / `endpoint-unreachable` /
  `repo-fetch-failed` / `maintenance` each produce their own distinct state;
- hysteresis: one differing run does not alarm, two consecutive do; an `ok`
  run resets the counter;
- `HOLD` suppresses and expires on its own;
- generator refuses to write when the salt is missing.

Known gaps not verifiable without a host change: Unraid template creation,
per-container Tailscale identity/authkey, the ACL grants, Healthchecks
deployment, actual crond timing inside `mdf-manifest-public`, and the Kuma
monitor.
