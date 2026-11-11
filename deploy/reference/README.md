# Reference Unraid templates (redacted)

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
- `Repository` is digest-pinned — currently the **0.2.9** digest
  `sha256:38571c38532f97f304533b2a9214a569986e589462ccd1f30294e2e23ca3423b`. `<Registry>` still
  names the old repo (`bitcryptic/mdf-server`); cosmetic only, the pull uses `Repository`.

## Not to be changed without checking

- The tailnet state-dir element: changing it silently re-registers the node under a new identity
  and IP, which breaks any Caddy upstream pinned to an IP. Keep the running shape unless the
  state is confirmed present at the explicit path.
- `Name` / `TailscaleHostname` / `ORG_ENTRYPOINT` / `ORG_CMD` / the four mount targets.
