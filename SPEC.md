# UI-Router Monorepo Spec — Working Decisions

This is a working decision record for the eventual executable `SPEC.md`, not the final spec.

## Confirmed direction

- Use npm throughout; remove Yarn-specific assumptions. Resolve the latest Node LTS and its accompanying npm at migration start, record the decision date, pin their exact versions, and enforce them locally and in CI.
- Keep published package `engines` unchanged during migration. Modernize and verify them in a follow-up.
- Import each source repository directly into the target `core/`, `plugins/`, `framework/`, and `tools/` layout.
- Import only each source's default branch plus package-release tags. A release tag is one whose root `package.json` version equals the original tag after removing an optional leading `v`. Rename imported tags as `short-name@original-tag`. Omit other branch heads and non-release tags.
- Framework tests import internal libraries by package name, while development/test resolver configuration maps those names to TypeScript source entrypoints. Watch mode must observe upstream source so a Core edit immediately retriggers framework tests without a Core build.
- Keep a separate package-integrity lane that builds packages and tests packed tarballs in clean integration projects.
- Use positive directory conventions: normal samples live under `examples/`; isolated consumer/compatibility projects live under `integration/`. Integration projects are excluded from root npm workspaces by positive workspace globs, are private, and own their npm lockfiles.
- Whether ordinary `examples/*` projects join the root workspaces is deferred. Milestone 1 excludes them until that bounded decision is made.
- Keep `verify-layout` small: classify manifests by path; compare the resolved npm workspace set to the path contract; enforce unique names and required `private` flags; enforce root/integration lock placement; reject Yarn/pnpm locks; report exact offending paths.
- Use Turbo for explicit task orchestration. Watch, packed-integration, browser/e2e, and release tasks are uncached initially. Milestone 1 has no remote-cache dependency.

## Integration runner requirement

Provide one small integration runner with two modes:

- **Clean gate (`--clean`, required by CI and final acceptance):** build and pack all intended internal packages; install their content-hashed tarballs into a fresh fixture sandbox through a temporary lock and one `npm ci`; verify that internal dependencies resolved to those tarballs; preserve a compact reproduction bundle on failure.
- **Persistent development loop (`--reuse`, local default):** keep `.integration-cache/<fixture>` and its installed tree; record fixture/toolchain/revision/tarball state; rebuild and repack only the affected internal graph; force-install changed content-hashed tarballs without changing the committed fixture lock; rerun the target test; print exact reuse/reset commands; never delete a failed sandbox.

A later optional source-linked mode may shorten diagnosis further, but packed `--clean` success remains the acceptance gate.

## Milestone 1 acceptance direction

Milestone 1 requires verified history/tag import, deterministic target layout and root `npm ci`, live source-linked cross-package watch behavior, topological production builds, packed consumer checks, isolated integration/version/browser/downstream matrices, and preservation of every green source-repository docs/test lane captured in a pinned baseline manifest.

## Deferred

- Examples workspace participation
- Changesets and release/versioning redesign
- Package-engine modernization
- Remote caching
- Old-repository archival and release cutover
