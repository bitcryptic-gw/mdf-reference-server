# Stage 1: install production dependencies
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN bun install --production

# Stage 2: production image
FROM oven/bun:1-alpine

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
RUN mkdir -p /app/data && chown -R bun:bun /app
USER bun
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --retries=3 --start-period=15s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/mdf.json || exit 1
CMD ["bun", "run", "src/index.ts"]
