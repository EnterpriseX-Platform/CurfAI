# syntax=docker/dockerfile:1.7
#
# Production image for Curf Community.
#
#   1. `deps`    - install node_modules, generate the Prisma client, rebuild
#                  the native better-sqlite3 binary (used by the file lake).
#   2. `build`   - `next build`.
#   3. `runner`  - a slim image with the runtime artefacts and system
#                  Chromium for PDF export.
#
# Build:   docker build -t curf .
# Run:     docker run -p 3100:3100 --env-file .env.production curf
# Health:  curl http://localhost:3100/api/health
#
# The base image is pinned to a digest so a rebuild cannot silently pull
# different upstream content. Re-resolve deliberately with
# `docker pull node:20-slim && docker inspect --format='{{index .RepoDigests 0}}' node:20-slim`.

# -----------------------------------------------------------------------------
# 1. deps
# -----------------------------------------------------------------------------
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS deps
WORKDIR /app

# Build tools for better-sqlite3. Dropped in the runner stage.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential python3 libssl-dev pkg-config openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci
RUN npx prisma generate \
 && npm rebuild better-sqlite3


# -----------------------------------------------------------------------------
# 2. build
# -----------------------------------------------------------------------------
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate \
 && npm run build


# -----------------------------------------------------------------------------
# 3. runner
# -----------------------------------------------------------------------------
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS runner
WORKDIR /app

# Chromium for PDF export, plus fonts for Latin, CJK and Thai output.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation fonts-noto fonts-noto-cjk fonts-thai-tlwg \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
      libcairo2 libasound2 ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN useradd --system --create-home --shell /usr/sbin/nologin --uid 1001 curf
USER curf

COPY --chown=curf:curf --from=build /app/package.json ./package.json
COPY --chown=curf:curf --from=build /app/node_modules ./node_modules
COPY --chown=curf:curf --from=build /app/.next ./.next
COPY --chown=curf:curf --from=build /app/public ./public
COPY --chown=curf:curf --from=build /app/prisma ./prisma
COPY --chown=curf:curf --from=build /app/next.config.mjs ./next.config.mjs

EXPOSE 3100
ENV PORT=3100

# tini reaps Chromium sub-processes that would otherwise linger as zombies.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npx", "next", "start", "-p", "3100"]

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3100/api/health || exit 1
