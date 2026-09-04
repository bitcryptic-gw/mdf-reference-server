# Stage 1: install production dependencies
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

# Stage 2: production image
FROM oven/bun:1-alpine

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
