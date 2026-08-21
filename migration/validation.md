# Migration tooling validation

This records rehearsal validation of the importer/verifier implementation from merged PR #2 plus the adversarial-review hardening branch. It is not the official history import; the official run must use the eventual merged hardening commit as its target base.

## Inputs

- Target base: `d64f8a09d5f533e2ae7af243ff73d64e8f87cfe3` (merged PR #2)
- Source-manifest SHA-256: `6dc37673c8c360aed62ee0ea585042d7e1a0f7507d30832aa5b9e8fef9a06d2f`
- `git-filter-repo`: package `2.47.0`, reported version `a40bce548d2c`, wrapper SHA-256 `3058a082bdd927a6b3e64bc432b6b25e46049e52d3fd6b71ac154b4c0d8b56e7`
- Node: `v22.23.2`
- npm: `10.9.8`
- Git: `2.54.0`
- Python: `3.12.13`
- uv: `0.11.26`

## Checks

- Node syntax checks passed for the migration library, importer, verifier, and committed fixture harness.
- Manifest validation passed for 16 unique sources, 474 accepted tags, and 27 excluded tags.
- Current-head path transformation produced 1,382 unique paths with no collisions.
- `PATH="$PWD/.migration-work/bin:$PATH" node tools/test-history-migration.mjs` covered:
  - lightweight, annotated, and synthetic signature-bearing release objects
  - merge topology, a commit message containing an old object ID, executable mode, and symlink fidelity
  - an accepted tag-only history outside the default branch and a rejected non-release tag
  - an explicit post-import layout move
  - exact full-commit-header/tree, evidence, toolchain, and ref-namespace checks
  - deterministic manifest-URL and retained-local-mirror runs
  - changed annotated and added source tags failing closed before target assembly while preserving workdirs
  - rejection of nested output/work paths, an exact-toolchain mismatch, and retained-mirror replacement refs/grafts/alternates
  - pre-existing target tag/branch/reserved-evidence paths plus file-directory source-target and layout collisions failing closed with preserved diagnostic state and no generated merge/evidence commit
  - verifier rejection of replacement/extra refs and tampered evidence
- A full remote-source import, retained-local-mirror import, and independent verification of both passed:
  - 16 sources
  - 15,346 commits in selected default/tag history
  - 15,214 default-branch commits
  - 474 release tags
  - 5,987 signature-bearing default-branch commits recorded as provenance
- The remote and mirror imports from the same base, manifest, and exact toolchain produced identical:
  - final HEAD: `e928851dbf4295d345780439b1b165b1338a89da`
  - complete ref namespace
  - import lock
  - commit maps
  - evidence files

## Defect found during validation

The first full verifier run found that `git-filter-repo` rewrote old commit IDs mentioned inside commit messages. The importer now passes `--preserve-commit-hashes`.

Fresh review then found missing environment isolation, complete tag-set enforcement, direct annotated-tag target/signature checks, and exact ref-evidence validation. The tools now sanitize Git configuration/environment and disable hooks, stop on added/removed tags, validate source tag facts independently, verify exact evidence files/content, require the exact reviewed source/tag scope, and distinguish a commit base from an annotated tag object.

A separate adversarial spec/repository/original-script review then found gaps in complete commit-tree/header proof, exact final refs, target collision preflight, execution-toolchain pinning, offline/local reruns, and fixture depth. Its follow-up found nested output/work cleanup, replacement-object, npm-lock, baseline-ordering, and pre-merge tree-collision gaps. The tooling and fixture now address those history blockers. The spec also makes path-reference repairs, internal npm resolution, active Yarn removal, runtime/baseline coverage, source-alias adapters, integration coverage, and scoped overrides explicit machine-readable gates.

The expanded fixture, full remote/mirror imports, independent verification of both, and complete identity comparison were rerun successfully after these fixes.

## Remaining execution gates

- Revalidate every pinned source ref immediately before the official run.
- Resolve and record the then-current latest Node LTS and bundled npm; refresh every exact history-toolchain pin in one reviewed manifest commit if the execution environment changes.
- Build and retain validated local source mirrors through milestone acceptance.
- Use the merged tooling commit—not the validation base above—as the explicit official target base.
- Complete and validate the moved-path repair contract before the imported-history PR merges.
- Repeat the two-run identity check and independent verification before pushing any imported history.

No source package scripts ran. No imported history was pushed or published.
