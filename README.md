# CHERR.IO

CHERR.IO is a transparent charitable-donation platform on Polygon. Donors give USDC; funds sit in a per-campaign smart-contract escrow and are released to the beneficiary either at once or in three milestone tranches approved by donor vote.

## Quick links

| | |
|---|---|
| **Operator cheat sheet** (URLs, server, databases, deploys, contract addresses, faucets) | [docs/CHEATSHEET.md](docs/CHEATSHEET.md) |
| Project rules (source of truth) | [docs/00-MANIFEST.md](docs/00-MANIFEST.md) |
| Decisions (ADR log) | [docs/03-DECISIONS.md](docs/03-DECISIONS.md) |
| Task plan and status | [docs/tasks/README.md](docs/tasks/README.md) |
| Dev environment | https://dev.cherr.io |

## Prerequisites

- **Node.js**: v22 LTS (recommended: `nvm use`)
- **pnpm**: v9+ (`corepack enable` or `npm install -g pnpm`)
- **Docker**: For running local Postgres (with pgvector) and Redis
- **Foundry**: For smart contract compilation and testing (`foundryup`)

## Setup

1. **Clone and install dependencies**:
   ```bash
   pnpm install
   ```

2. **Start local infrastructure (Postgres + Redis)**:
   ```bash
   pnpm dev:infra
   ```

3. **Configure environment variables**:
   ```bash
   cp .env.example .env
   ```

4. **Run the development servers**:
   ```bash
   pnpm dev
   ```

## Available Commands

| Command | Description |
|---|---|
| `pnpm build` | Build all apps and packages in the monorepo |
| `pnpm dev` | Run development servers across apps |
| `pnpm dev:infra` | Start local Postgres (pgvector) and Redis via Docker Compose |
| `pnpm dev:infra:down` | Stop local Docker Compose infrastructure |
| `pnpm lint` | Run ESLint across all apps and packages |
| `pnpm typecheck` | Run TypeScript type checks across all apps and packages |
| `pnpm test` | Run Vitest and Foundry unit/fuzz tests |
| `pnpm clean` | Clean build outputs and cache directories |
| `pnpm --filter contracts build` | Compile Solidity smart contracts via Foundry |
| `pnpm --filter contracts test` | Run Foundry smart contract tests |
| `pnpm --filter web dev` | Run the Next.js web application |

## Repository Layout

```
apps/
  web/         Next.js app (UI, route handlers, admin panel)
  indexer/     Ponder indexer (chain events -> Postgres)
  worker/      BullMQ worker services
  mcp/         MCP server package
packages/
  config/      Shared ESLint, Prettier, and TypeScript configurations
  contracts/   Foundry project; smart contracts & ABIs
  db/          Drizzle ORM schema, migrations, seed
  shared/      Zod schemas, constants, chains, money utilities
  ui/          Shared UI components (shadcn/ui)
```
