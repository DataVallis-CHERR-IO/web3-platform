# Use of generative AI in this repository

This disclosure follows the [NLnet policy on generative AI](https://nlnet.nl/foundation/policies/generativeAI/).

## Where the ideas and rules come from
- **Concept and economics:** the CHERR.IO whitepaper (2018), written by the founding team. The current rules are in `docs/01-PRODUCT-SPEC.md`.
- **Decisions:** every architecture and product decision is an ADR in [`docs/03-DECISIONS.md`](docs/03-DECISIONS.md), approved by the owner, David Tacer (Data Vallis d.o.o.). ADRs override every other document.

## How code is produced
1. **The spec is the prompt.** David writes or approves every task spec in `docs/tasks/TASK-*.md`. The spec is what the AI implementer receives.
2. **Generation:** the code, tests and documentation are generated with **Anthropic Claude** (Claude Code).
3. **Checks before a merge:** every change must pass the automated tests and CI:
   - lint and typecheck;
   - unit, integration and end-to-end tests with accessibility checks;
   - Foundry tests for the contracts (unit, fuzz and invariant);
   - an indexer scenario on a local chain.
4. **Review and merge:**
   - In the autonomous mode David set up on 2026-10-02, the AI merges into `dev` only when every check is green. `dev` is the test environment on the Polygon Amoy testnet, with no real money.
   - David reviews the result on dev.
   - Promotion to `uat` and to production (`main`) is done only by David.
   - Contracts are never deployed by AI or CI.
5. **Evidence:** every task has a feedback file `docs/tasks/TASK-*.feedback.md`. It contains the real test output, the deliberate breaks that prove the tests can fail, and any deviations from the spec.

## How AI-generated commits are marked
- Every commit that contains generated code carries a `Co-Authored-By: Claude … <noreply@anthropic.com>` trailer that names the model.
- **From 2026-10-03:** the commit message body must also say which instruction produced the change:
  - `Prompt: docs/tasks/TASK-013-….md` (the task spec), or
  - for ad-hoc work, `Prompt: <one-line summary of the instruction>`.

## Licence
All generated output is reviewed and published under the [MIT licence](LICENSE). No third-party code is copied into the repository. Third-party libraries are used as dependencies under their own licences ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
