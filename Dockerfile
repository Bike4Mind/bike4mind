# syntax=docker/dockerfile:1
#
# Bike4Mind self-host image: run anywhere, no AWS account required.
# Builds the Next.js app with B4M_SELF_HOST=true so `sst` is aliased to the
# env-backed @bike4mind/resource shim and Next emits a standalone server.
# Runs against the Docker Compose stack (Mongo + MinIO + ElasticMQ + Mailpit);
# see compose.selfhost.yaml and .env.selfhost.example.

ARG NODE_VERSION=24

# ── Base: pnpm via corepack, self-host flag on for every stage ──────────────
FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    B4M_SELF_HOST=true
RUN corepack enable
WORKDIR /app

# ── Deps: install the full workspace (cached on the lockfile) ────────────────
FROM base AS deps
# Native-addon build toolchain (node-gyp deps: some transitive packages need it)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
# Copy the workspace manifests + sources needed to resolve the graph. The
# .dockerignore keeps node_modules/dist/.next/.env* out of the build context.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY apps ./apps
COPY b4m-core ./b4m-core
COPY packages ./packages
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# ── Builder: build all @bike4mind/* packages, then the Next app (shim active) ─
FROM deps AS builder
# Build every workspace package except the client (incl. @bike4mind/resource).
RUN pnpm turbo:build
# Build the Next.js client in standalone mode; B4M_SELF_HOST (base ENV) turns on
# both the sst→shim turbopack alias and `output: 'standalone'`.
RUN NODE_OPTIONS='--max-old-space-size=12288' pnpm --filter @bike4mind/client build
# Strip compiled test routes: pages/__tests__ files build into routable entries
# and the standalone server preloads them at boot, running test-only module
# side effects in production (see the script header for the S3 stub failure).
RUN node apps/client/scripts/pruneTestRoutes.mjs apps/client/.next/standalone/apps/client/.next

# ── Runner: minimal image, standalone output only ───────────────────────────
FROM node:${NODE_VERSION}-slim AS runner
ENV NODE_ENV=production \
    B4M_SELF_HOST=true \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
RUN groupadd -r nodejs && useradd -r -g nodejs nextjs

# Next standalone output is rooted at the monorepo root (outputFileTracingRoot),
# so it contains apps/client/server.js + traced node_modules + b4m-core/*.
COPY --from=builder --chown=nextjs:nodejs /app/apps/client/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/client/.next/static ./apps/client/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/client/public ./apps/client/public

USER nextjs
EXPOSE 3000
CMD ["node", "apps/client/server.js"]
