# Migration tooling validation

This records validation of the importer/verifier implementation in draft PR #2. It is not the official history import; the official run must use the eventual merged tooling commit as its target base.

## Inputs

- Target base: `068ec1c76fd7f17202d3eaf5557505ee066b009b`
- Source-manifest SHA-256: `ebc93801a5c59b88cc282a253a524d15bb5a5baab0bf3ce7abed6d1533ef6272`
- `git-filter-repo`: package `2.47.0`, reported version `a40bce548d2c`
- Node: `v22.23.2`
- npm: `10.9.8`
- Git: `2.54.0`

## Checks

- Node syntax checks passed for all three migration-tool modules.
- Manifest validation passed for 16 unique sources, 474 accepted tags, and 27 excluded tags.
- Current-head path transformation produced 1,382 unique paths with no collisions.
- A controlled fixture covered:
  - lightweight and annotated release tags
  - an accepted tag-only history outside the default branch
  - a rejected non-release tag
  - an explicit post-import layout move
  - exact verifier checks
  - two deterministic runs
  - an unreviewed added tag failing closed before target assembly while preserving its workdir
  - an injected layout collision failing closed after target assembly while preserving both workdir and partial output
- A full local import and independent verification passed:
  - 16 sources
  - 15,346 commits in selected default/tag history
  - 15,214 default-branch commits
  - 474 release tags
  - 5,987 signature-bearing default-branch commits recorded as provenance
- A second full import from the same base and manifest produced identical:
  - final HEAD: `258727f3ac863cb9b4747d65d3de36af95afa7db`
  - tag refs
  - commit maps
  - evidence files

## Defect found during validation

The first full verifier run found that `git-filter-repo` rewrote old commit IDs mentioned inside commit messages. The importer now passes `--preserve-commit-hashes`.

Fresh review then found missing environment isolation, complete tag-set enforcement, direct annotated-tag target/signature checks, and exact ref-evidence validation. The tools now sanitize Git configuration/environment and disable hooks, stop on added/removed tags, validate source tag facts independently, verify exact evidence files/content, require the exact reviewed source/tag scope, and distinguish a commit base from an annotated tag object.

The controlled fixture, full import, independent verification, and full repeatability run were rerun successfully after these fixes.

## Remaining execution gates

- Revalidate every pinned source ref immediately before the official run.
- Resolve and record the then-current latest Node LTS and bundled npm.
- Use the merged tooling commit—not the validation base above—as the explicit official target base.
- Repeat the two-run identity check and independent verification before pushing any imported history.

No source package scripts ran. No imported history was pushed or published.
