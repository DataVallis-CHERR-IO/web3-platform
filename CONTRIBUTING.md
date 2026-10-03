# Contributing to CHERR.IO

Thank you for contributing to CHERR.IO. This document outlines the Git branching strategy, contribution workflows, and development guidelines.

## Licence of contributions

The repository is released under the [MIT licence](LICENSE). By opening a pull request you agree that your contribution is licensed under the same MIT licence (inbound = outbound). The CHERR.IO names and logos are not part of that licence ([TRADEMARKS.md](TRADEMARKS.md)).

In short: open pull requests into `dev`; every CI check must pass before a merge.

## Branching Strategy

We follow a structured promotion flow across environments:

- `dev`: Default development branch. Integrates all new features and routine fixes. Connected to the **dev** environment (Polygon Amoy testnet).
- `uat`: User acceptance testing branch. Promoted from `dev`. Connected to the **uat** environment (Polygon Amoy testnet).
- `main`: Production branch. Promoted from `uat`. Connected to the **prod** environment (Polygon mainnet).

### Branch Naming Conventions
- Feature branches: `feat/TASK-XXX-<short-name>` (branched off `dev`)
- Routine bug fixes: `fix/<short-name>` (branched off `dev`)
- Critical production hotfixes: `hotfix/<short-name>` (branched off `main`)

## Pull Request Flow

### 1. Feature & Regular Fixes
```
feat/TASK-XXX-*  ──PR──▶  dev  ──PR──▶  uat  ──PR──▶  main (prod)
fix/*            ──PR──▶  dev
```
1. Create your branch from `dev`:
   ```bash
   git checkout dev
   git pull origin dev
   git checkout -b feat/TASK-XXX-<short-name>
   ```
2. Implement your changes within scope, ensuring all unit tests, typechecks, and linters pass.
3. Open a Pull Request targeting `dev`.
4. After validation and review on `dev`, promotion to `uat` is handled via PR from `dev` to `uat`.
5. After acceptance testing on `uat`, promotion to production is handled via PR from `uat` to `main`.

### 2. Hotfix Flow
```
hotfix/*  (from main) ──PR──▶  main (prod)
                                  │
                                  ▼ (back-merge)
                             uat ──▶ dev
```
1. Branch directly off `main`:
   ```bash
   git checkout main
   git pull origin main
   git checkout -b hotfix/<short-name>
   ```
2. Open a Pull Request into `main`.
3. Once merged and deployed to production, back-merge `main` into `uat` and `dev`.

## Commit Conventions

We follow Conventional Commits:
- `feat(...)`: A new feature
- `fix(...)`: A bug fix
- `docs(...)`: Documentation changes
- `refactor(...)`: Code change that neither fixes a bug nor adds a feature
- `test(...)`: Adding or correcting tests
- `chore(...)`: Maintenance tasks, dependencies, tooling
