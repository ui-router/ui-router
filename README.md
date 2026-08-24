# UI-Router Monorepo

This repository contains the consolidated UI-Router packages, framework adapters, plugins, examples, compatibility tests, and shared tooling.

- [`SPEC.md`](SPEC.md) is the executable migration specification.
- [`migration/sources.json`](migration/sources.json) pins source history, tags, and layout moves.
- [`migration/validation.md`](migration/validation.md) records the tooling rehearsal evidence and remaining official-run gates.
- [`migration/work-graph.json`](migration/work-graph.json) mirrors the task dependency graph for machine validation; [`migration/schemas`](migration/schemas) defines every generated migration contract.
- [`tools/lock-history-inputs.mjs`](tools/lock-history-inputs.mjs) refreshes and locks the official source snapshot, retained mirrors, offline bundles, tool artifacts, and immutable target base. [`tools/import-history.mjs`](tools/import-history.mjs), [`tools/verify-history.mjs`](tools/verify-history.mjs), and [`tools/test-history-migration.mjs`](tools/test-history-migration.mjs) implement and exercise that locked history boundary.
- [`tools/validate-migration-contract.mjs`](tools/validate-migration-contract.mjs) validates generated contracts against the pinned schemas, [`tools/verify-contract-schemas.mjs`](tools/verify-contract-schemas.mjs) checks schema/ref integrity, and [`tools/verify-work-graph.mjs`](tools/verify-work-graph.mjs) rejects dependency cycles and spec/graph drift.
- [`archive/original`](archive/original) preserves the original migration draft and scripts for comparison only.

Published package roots live under [`core`](core), [`frameworks`](frameworks), [`plugins`](plugins), and [`tools`](tools). Ordinary examples are private root workspaces; compatibility projects under `integration-tests` remain isolated from the root workspace.
