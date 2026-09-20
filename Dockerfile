# Pinned to the host toolchain (Bun 1.3.14) by exact tag AND index digest, so
# the image cannot float to a newer Bun whose lockfile format the host cannot
# read (0.2.4: oven/bun:1-alpine resolved to 1.4.2 while the host is 1.3.14,
# forcing the lockfile-version override to be dropped). The digest is the
# multi-arch manifest-list digest, so linux/amd64 and linux/arm64 stay pinned
# together. 1.3.14-alpine matches the previous base variant and provides
# su-exec via apk.
FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

# Stage 2: production image
FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0

RUN apk add --no-cache su-exec
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
RUN mkdir -p /app/data && chown -R bun:bun /app
EXPOSE 3000
# /health checks real dependencies (content dir readable, data dir writable)
# and returns 503 when they are not — /mdf.json answers 200 whenever the
# process is up. HEAD on /health is handled like GET (body suppressed, correct
# Content-Length) per the RFC 9110 fix.
HEALTHCHECK --interval=10s --timeout=5s --retries=3 --start-period=15s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1
# Runs as root so Unraid's Tailscale-in-container hook (which requires uid 0)
# can run; su-exec drops to the bun user for the app itself.
CMD ["su-exec", "bun:bun", "/usr/local/bin/bun", "run", "src/index.ts"]
