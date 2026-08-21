# UI-Router Monorepo

This repository is the migration target for the UI-Router projects.

- [`SPEC.md`](SPEC.md) is the executable migration specification.
- [`migration/sources.json`](migration/sources.json) pins source history, tags, and layout moves.
- [`migration/validation.md`](migration/validation.md) records the tooling rehearsal evidence and remaining official-run gates.
- [`migration/work-graph.json`](migration/work-graph.json) mirrors the task dependency graph for machine validation; [`migration/schemas`](migration/schemas) defines every generated migration contract.
- [`tools/import-history.mjs`](tools/import-history.mjs), [`tools/verify-history.mjs`](tools/verify-history.mjs), and [`tools/test-history-migration.mjs`](tools/test-history-migration.mjs) implement and exercise the history migration gate; [`tools/verify-contract-schemas.mjs`](tools/verify-contract-schemas.mjs) checks schema/ref integrity, and [`tools/verify-work-graph.mjs`](tools/verify-work-graph.mjs) rejects dependency cycles and spec/graph drift.
- [`archive/original`](archive/original) preserves the original draft and scripts for comparison only.

The repository does not contain imported project history yet. The importer and verifier must be reviewed and merged before the official history-import branch is created.
