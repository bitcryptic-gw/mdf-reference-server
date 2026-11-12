# Reference Unraid templates (redacted) — and the 0.3.0 deliverables

Working fleet templates, committed so later sessions diff against reality instead of
reconstructing the format (`unraid-docker-template-authoring-convention`, rule 1).

Supplied by Gary on 2026-11-11, redacted with `redact-unraid-template.php`; each reported
`suspicious patterns remaining: 0`, each passes a strict parse
(`php -r 'var_dump(simplexml_load_file($argv[1]) !== false);'` → `bool(true)`), and each is
free of `tskey-`, `TailscaleParams` content, bearer tokens and masked values
(re-checked on receipt: 0 matches).

| file | source host | sha256 | what it is |
|---|---|---|---|
| `my-mdf-server-syd.redacted.xml` | `unraid-syd` | `2f6e6f5689b867a2b7ddef34c599f0ba43b242ff1bda1a906493cd0c310499b5` | live demo server container (`mdf-server-syd`), 0.2.9 digest |
| `my-mdf-server-prod.redacted.xml` | `unraid-public` | `8737489e6033f1e1d4c49a0cc3da810797691ffae1b30be32a12c48adb72075b` | live demo server container (`MDF-Server-Prod`, tailnet host `mdf-server-prod`), 0.2.9 digest |
| `my-wp-fab-syd.redacted.xml` | `unraid-syd` | `9fdfac69ce6ed38e5d70c63632abcff1c4fbb0aa317a24ad9375a6c13c258ffc` | third working fleet service template, as a formatting cross-check |

## What the two demo templates establish (0.2.9 state)

- **Per-container Tailscale is already in place**: `TailscaleEnabled true`,
  `TailscaleHostname mdf-server-syd` / `mdf-server-prod`, `TailscaleServe no`, no
  `TailscaleParams`, and **no `<Config Type="Port">`** — the containers publish no host port.
  Tailnet: `mdf-server-syd` `100.83.122.107`, `mdf-server-prod` `100.126.109.83`, both
  `tag:misc-services`.
- The app is reached over the tailnet on `:3000` (proven: the public demo serves 0.2.9 with no
  host port published) and the dashboard on `:9090`.
- `TailscaleStateDir` is **blank**, with `CA_TS_FALLBACK_DIR=/app/data` and `/app/data` a rw
  host mount — so the node identity *should* persist across a recreate. It is not proven: the
  fallback path is not the facilitator's explicit `/app/data/.tailscale_state`, and this must be
  checked on the host before either container is recreated for 0.3.0 (see the cutover checklist).
- `ORG_ENTRYPOINT` / `ORG_CMD` carry the image's entrypoint and command so the Unraid Tailscale
  hook can start as root and then `su-exec` to `bun`. Both must be preserved verbatim.
- Secrets are **per-file** mounts (the brief's open question 5 is answered): `wallet_address`,
  `alby_api_token`, `lightning_token_secret` (to be dropped in 0.3.0), and a stale
  `oracle_pubkey` mount (nothing reads it since the oracle was retired; harmless, removable).
- The container names are `mdf-server-syd` (unraid-syd) and **`MDF-Server-Prod`** (unraid-public,
  mixed case — use it exactly in commands and checklists). Their tailnet hostnames are the
  lowercase `mdf-server-syd` / `mdf-server-prod`.
- **Pre-flight confirmed by Gary (2026-11-11):** `.tailscale_state/tailscaled.state` exists under
  the mounted `/app/data` on both hosts, last written by the 0.2.9 recreate, and both nodes kept
  their identity and IP. Node identity therefore survives a recreate, and no host port is needed
  at any point.
- `Repository` is digest-pinned — currently the **0.2.9** digest
  `sha256:38571c38532f97f304533b2a9214a569986e589462ccd1f30294e2e23ca3423b`. `<Registry>` still
  names the old repo (`bitcryptic/mdf-server`); cosmetic only, the pull uses `Repository`.

## Not to be changed without checking

- The tailnet state-dir element: changing it silently re-registers the node under a new identity
  and IP, which breaks any Caddy upstream pinned to an IP. Keep the running shape unless the
  state is confirmed present at the explicit path.
- `Name` / `TailscaleHostname` / `ORG_ENTRYPOINT` / `ORG_CMD` / the four mount targets.

---

# 0.3.0 deliverables (Stage B, #64)

Not applied to any host. Each file passes a strict parse and the dockerMan harness
(`php xmlconfig.php` from `bitcryptic-gw/mdf-facilitator/tests/unraid/`), which prints the
`-v`/`-e` arguments Unraid would actually generate.

| file | what it is | sha256 |
|---|---|---|
| `my-mdf-server-syd.0.3.0.xml` | `mdf-server-syd` at `0.3.0-rc.1`, failover secondary | `c7aea06556a8341e1f142bcb1f22c599494eb57cb0cf5d70618b9741b06a1ba3` |
| `my-mdf-server-prod.0.3.0.xml` | `MDF-Server-Prod` at `0.3.0-rc.1` | `7f937cba68898ac328c723cc670d02022c1ffb6f215a9b1dad2a31c202a56ccd` |
| `my-mdf-valkey.xml` | new `mdf-valkey` shared store (tailnet node, no host port) | `142e0f7068d6f0a436e07932ba055167e288c77b1dfbf080aecb25bf70788f52` |
| `valkey.conf` | Valkey server config, mounted read-only (AOF, noeviction, ACL file) | `43d248e68647422d8f05bc82e51719b6accef769a44903feba5ffcae0dc1d6cf` |

Image pins:

- server: `bitcryptic/mdf-reference-server@sha256:90385776b7f069a645d098288d1b0814211ee563a8928aefb5cba9ffbcfab2cc`
  (multi-arch index, `0.3.0-rc.1`; trivy secret scan 0 findings, and a direct grep of an
  exported layer for the wallet address, `tskey-`, private-key headers and NWC URI fragments
  found nothing — the only `nostr+walletconnect` strings are the URI parser's own source)
- Valkey: `valkey/valkey@sha256:2602ace2be6569bc2bbb06f873776516ab9089821525be34f4305c67eb9db02a`
  (`8.1-alpine` multi-arch index)

## What changed in the two server templates

Exactly four things, verified by `diff` against the redacted 0.2.9 copies:

1. `<Repository>` → the 0.3.0-rc.1 digest.
2. `<Overview>` gains three lines naming the release, the rails and the Valkey store.
3. **Removed** the `alby_api_token` and `lightning_token_secret` mounts. 0.3.0 reads
   neither: invoicing moved to NWC (`make_invoice`) and the macaroon/HMAC token is gone.
   Leaving a spending-capable Alby token mounted for nothing is worse than a template diff.
   `oracle_pubkey` is kept (harmless, and removing it is not this release's business).
4. **Added** two file mounts next to the wallet mount:
   - `/run/secrets/nwc_uri` — the NWC URI, one dedicated connection per instance.
   - `/run/secrets/valkey_password` — the store password, identical to the Valkey ACL entry.

Every Tailscale element, every port/variable/path, `Name`, `ORG_*` and the state-dir shape are
byte-identical to the 0.2.9 copies. `TailscaleParams` stays empty: the nodes already exist and
rejoin from the persisted state.

## The Valkey template

- `valkey/valkey:8.1-alpine`, pinned by index digest, `--restart unless-stopped`.
- Tailnet node `mdf-valkey`, `TailscaleServe no`, **no host port**, state at
  `/data/.tailscale_state` (explicit, on the persistent mount — the facilitator template's
  proven shape, not the demo's blank/fallback one).
- `aclfile /run/secrets/valkey_acl`: the password lives only in that mounted file. Stock
  Valkey cannot read a password from a file any other way, so an ACL file is the mechanism.
- AOF `everysec` on `/data`; `maxmemory-policy noeviction` so a replay record can never be
  evicted into a replayable state.

### Before first start (Gary, on unraid-private)

```bash
mkdir -p /mnt/cache/appdata/mdf-valkey/{data,secrets}
cp valkey.conf /mnt/cache/appdata/mdf-valkey/valkey.conf
openssl rand -hex 32 > /mnt/cache/appdata/mdf-valkey/secrets/valkey_acl.tmp
printf 'user default on >%s ~* &* +@all\n' "$(cat /mnt/cache/appdata/mdf-valkey/secrets/valkey_acl.tmp)" \
  > /mnt/cache/appdata/mdf-valkey/secrets/valkey_acl
rm /mnt/cache/appdata/mdf-valkey/secrets/valkey_acl.tmp
chmod 600 /mnt/cache/appdata/mdf-valkey/secrets/valkey_acl
```

Put that same 64-hex value in **both** demo nodes'
`/mnt/cache/appdata/<appdata-dir>/secrets/valkey_password` (mode 600). They must match; rotate
both together.

## ACL grants (cutover)

```
"hosts": { "mdf-valkey": "<tailnet ip>/32" }
grants:
  mdf-syd, mdf-prod            → mdf-valkey                tcp:6379
  mdf-syd, mdf-prod            → mdf-fac-syd, mdf-fac-pub  tcp:8080
  tag:caddy                    → mdf-syd, mdf-prod         tcp:3000
```
