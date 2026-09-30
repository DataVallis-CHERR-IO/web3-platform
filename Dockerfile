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
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/

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

# Build @cherrio/db so the migration runner ships in the image
RUN pnpm --filter @cherrio/db build

# ── Stage 4: runner ──────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Next.js standalone server (includes only traced node_modules)
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

# Migration runner: packages/db compiled output + SQL files + its deps
COPY --from=builder --chown=nextjs:nodejs /app/packages/db/dist ./packages/db/dist
COPY --from=builder --chown=nextjs:nodejs /app/packages/db/drizzle ./packages/db/drizzle
COPY --from=builder --chown=nextjs:nodejs /app/packages/db/package.json ./packages/db/
COPY --from=builder --chown=nextjs:nodejs /app/packages/db/node_modules ./packages/db/node_modules

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

EXPOSE 3000
USER nextjs

CMD ["node", "apps/web/server.js"]
