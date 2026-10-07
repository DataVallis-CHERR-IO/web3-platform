# Dockerfile — CHERR.IO web app (apps/web)
# Multi-stage build producing a standalone Next.js server.
# Context: repo root (monorepo — needs workspace packages).
# Built in GitHub Actions, pushed to GHCR, pulled by Kamal on the server.
# Never built on the server.

# ── Stage 1: base ────────────────────────────────────────────────
FROM node:22-alpine AS base
RUN corepack enable pnpm

# ── Stage 2: deps ────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app

# Copy only manifests for layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm applies patches/ (patchedDependencies in package.json) during install.
COPY patches ./patches
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/contracts/package.json packages/contracts/

RUN pnpm install --frozen-lockfile --ignore-scripts

# ── Stage 3: builder ────────────────────────────────────────────
FROM deps AS builder
WORKDIR /app

COPY . .

# Build-time only — baked into the JS bundle for /api/health
ARG NEXT_PUBLIC_GIT_SHA=""
ENV NEXT_PUBLIC_GIT_SHA=$NEXT_PUBLIC_GIT_SHA

# Build @cherrio/shared and @cherrio/ui first (dependencies of web)
RUN pnpm --filter @cherrio/shared build && \
    pnpm --filter @cherrio/ui build

# Build the Next.js standalone bundle
RUN pnpm --filter web build

# Bundle the migration runner and admin scripts into single self-contained ESM files.
# esbuild inlines drizzle-orm and postgres so the runner image does NOT
# need node_modules for @cherrio/db at all.
RUN pnpm --filter @cherrio/db exec esbuild src/migrate.ts \
      --bundle --platform=node --target=node22 --format=esm \
      --outfile=dist/migrate.mjs \
      --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);" && \
    pnpm --filter @cherrio/db exec esbuild src/grant-admin.ts \
      --bundle --platform=node --target=node22 --format=esm \
      --outfile=dist/grant-admin.mjs \
      --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);" && \
    pnpm --filter @cherrio/db exec esbuild src/reset-admin-mfa.ts \
      --bundle --platform=node --target=node22 --format=esm \
      --outfile=dist/reset-admin-mfa.mjs \
      --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);" && \
    pnpm --filter @cherrio/db exec esbuild ../../apps/web/scripts/files.ts \
      --bundle --platform=node --target=node22 --format=esm \
      --outfile=../../apps/web/dist/files.mjs \
      --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"

# ── Stage 4: runner ──────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Next.js standalone server (includes only traced node_modules)
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

# Migration runner & admin scripts: single bundled files + SQL migration files only.
# No node_modules needed — esbuild inlined all dependencies.
COPY --from=builder --chown=nextjs:nodejs /app/packages/db/dist/migrate.mjs ./packages/db/dist/migrate.mjs
COPY --from=builder --chown=nextjs:nodejs /app/packages/db/dist/grant-admin.mjs ./packages/db/dist/grant-admin.mjs
COPY --from=builder --chown=nextjs:nodejs /app/packages/db/dist/reset-admin-mfa.mjs ./packages/db/dist/reset-admin-mfa.mjs
COPY --from=builder --chown=nextjs:nodejs /app/packages/db/drizzle ./packages/db/drizzle
# Private file storage commands (files:check, files:sweep), same kind of bundle.
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/dist/files.mjs ./apps/web/dist/files.mjs

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

EXPOSE 3000
USER nextjs

CMD ["node", "apps/web/server.js"]
