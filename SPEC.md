# UI-Router Monorepo Migration Specification

- **Status:** executable migration plan; source history is not imported yet
- **Target:** `ui-router/ui-router`
- **Source lock:** [`migration/sources.json`](migration/sources.json)
- **Original inputs:** [`archive/original`](archive/original)

## 1. Goal

Combine the 16 UI-Router source repositories into one npm/Turborepo monorepo while:

- preserving the selected source history, authors, dates, messages, and package-release tags
- preserving each tagged repository's tag-era relative paths and file contents beneath one unavoidable monorepo prefix
- providing deterministic root install, build, source-linked tests, packed-consumer tests, and isolated integration tests
- keeping published package names, versions, dependency semantics, and `engines` unchanged unless a later reviewed compatibility change requires otherwise
- producing enough machine-readable evidence to rerun, verify, diagnose, or abandon the migration safely

Milestone 1 ends at a deterministic, tested development monorepo. Publishing, versioning redesign, source-repository archival, and release cutover are later milestones.

## 2. Non-goals for milestone 1

Do not:

- publish packages
- adopt Changesets or redesign releases
- archive, redirect, or make source repositories read-only
- modernize published `engines`
- silently widen peer dependency ranges
- add remote Turbo caching
- make ordinary examples root npm workspaces
- preserve rewritten Git object IDs or claim that rewritten signatures remain valid
- execute package scripts until their commands and lifecycle hooks have been statically reviewed

## 3. Fixed decisions

### 3.1 Package manager and toolchain

- Use npm only. Remove Yarn/pnpm assumptions from the current development tree.
- At execution start, resolve the then-current latest Node LTS and the npm bundled with it. Record the decision date and exact versions.
- Pin Node in `.nvmrc` and npm in root `packageManager`; CI must reject different versions.
- Generate the root lock with that pinned npm and use `npm ci` for clean installs.
- Keep existing published package `engines` unchanged. Track modernization as follow-up work.
- Use `git-filter-repo` package `2.47.0`, whose expected `--version` output is pinned in the source manifest.

### 3.2 Git scope and tag policy

Import:

- every commit reachable from each pinned default-branch head
- every commit needed by an accepted package-release tag, including accepted tags outside default-branch ancestry

Do not import other branch heads or rejected tags.

A tag is accepted when the root `package.json` at its peeled commit contains a `version` exactly equal to the original tag after removing one optional leading `v`. Do not use loose semver coercion or npm publication data for this decision.

Rename accepted tags as `<source-name>@<original-tag>`, preserving original spelling after `@`.

### 3.3 Tag-era paths

Each source is rewritten beneath exactly one namespace prefix. The rewrite does not rearrange paths inside that prefix.

For every imported tag:

1. peel the source and imported tags to commits
2. strip the source's namespace prefix from the imported tree
3. compare path, mode, object type, blob/object ID, and file contents exactly

Current-layout changes occur afterward in dedicated deterministic `git mv` commits on the assembled branch. Imported tags remain on pre-move commits.

### 3.4 Workspaces and locks

Root npm workspaces are exactly:

```json
[
  "core",
  "plugins/*",
  "framework/*/router",
  "tools/*"
]
```

- `integration/` projects are private, excluded from root workspaces, and own npm locks.
- Ordinary `examples/` are private and excluded from root workspaces in milestone 1. They run as separate locked projects.
- The repository has one root npm lock. No Yarn or pnpm lock remains on current `main` after npm conversion.
- Historical commits and imported tags retain their original lockfiles and contents.

### 3.5 Internal dependencies

- Published manifests retain ordinary semver dependency and peer ranges. Do not publish `file:` or workspace-only specs.
- When a local package version satisfies an internal range, root installation must resolve that edge to the workspace package.
- When it does not satisfy—currently including Angular Hybrid's Angular 21 peer range versus the local Angular 22 package—do not hide the mismatch with `--legacy-peer-deps`, a global override, or an untested range change.
- Test declared incompatible versions in isolated integration projects. A separate source-linked lane may test a prospective local version.
- Development/test aliases may map package names to live TypeScript source. Packed-package tests disable all such aliases.
- `tools/verify-internal-deps.mjs` is separate from layout verification and classifies every internal edge as local-compatible, intentionally external compatibility, or erroneous.

### 3.6 Integration test modes

One small integration runner provides:

- **Clean gate (`--clean`):** CI/final acceptance builds and packs all intended internal packages, installs content-hashed tarballs into a fresh fixture through a temporary lock and one `npm ci`, proves internal packages came from those tarballs, and preserves a compact failure repro bundle.
- **Persistent development loop (`--reuse`, local default):** retains `.integration-cache/<fixture>` and its installed tree, records fixture/toolchain/revision/tarball state, rebuilds and repacks the affected internal graph, force-installs changed content-hashed tarballs without changing the committed fixture lock, and reruns the selected test.

A clean packed run is always required for acceptance. A later source-linked integration mode may shorten diagnosis but cannot replace it.

## 4. Source and layout map

[`migration/sources.json`](migration/sources.json) is authoritative for immutable object IDs, tag classification, import order, destination prefixes, and current-head moves.

| Source | Destination prefix | Current-head move after import |
|---|---|---|
| `core` | `core/` | TypeScript compatibility fixtures from `core/test/` to `core/integration/` |
| `dsr` | `plugins/dsr/` | none |
| `rx` | `plugins/rx/` | none |
| `redux` | `plugins/redux/` | none |
| `sticky-states` | `plugins/sticky-states/` | none |
| `visualizer` | `plugins/visualizer/` | `example/` to `examples/example/` |
| `angular-ui/ui-router` (`angularjs`) | `framework/angularjs/router/` | `test/typescript/` to `framework/angularjs/integration/typescript-versions/` |
| `sample-app-angularjs` | `framework/angularjs/examples/sample-app/` | none |
| `angular` | `framework/angular/router/` | version/type fixtures to `framework/angular/integration/` |
| `sample-app-angular` | `framework/angular/examples/sample-app/` | none |
| `angular-hybrid` | `framework/angular-hybrid/router/` | `example/` to `framework/angular-hybrid/examples/example/` |
| `sample-app-angular-hybrid` | `framework/angular-hybrid/examples/sample-app/` | none |
| `react` | `framework/react/router/` | embedded examples/integrations to framework siblings |
| `sample-app-react` | `framework/react/examples/sample-app/` | none |
| `react-hybrid` | `framework/react-hybrid/router/` | embedded integrations to framework sibling |
| `publish-scripts` | `tools/publish-scripts/` | none in milestone 1 |

Move commits contain path changes only. Reference/path repairs are separate commits so rename evidence remains reviewable.

## 5. History import tooling

### 5.1 Inputs

`migration/sources.json` records, per source:

- URL, default branch, pinned head and tree
- default-branch commit count
- destination/tag namespace
- every observed tag object, peeled commit/tree, historical root package version, reachability, and signature presence
- 474 accepted release tags and 27 excluded tags
- current-head move operations

New upstream refs never silently enter a locked run. If a pinned default ref/tag object moves, or any source tag name is added or removed before the official run, stop and review a manifest refresh.

### 5.2 Importer behavior

`tools/import-history.mjs` must:

1. require a full immutable target `--base`; never resolve floating target `HEAD`
2. refuse existing output/work directories
3. verify the exact `git-filter-repo` pin and manifest schema
4. sanitize Git environment overrides; disable system/global Git config, hooks, signing, and global attributes/excludes
5. fresh-clone every source as a mirror
6. validate pinned heads, trees, commit counts, the complete tag-name set, tag objects/types/targets/trees, package versions, reachability, and signature presence
7. delete unselected refs in the temporary mirror
8. rewrite only remaining refs beneath one destination prefix and namespace tags
9. retain old-to-new commit maps
10. fresh-clone the target and prove `--base` is an exact commit on target `main`
11. merge rewritten default histories in manifest order with deterministic two-parent merge commits
12. apply manifest moves in deterministic path-only commits
13. add import lock, commit maps, and ref evidence in one final deterministic evidence commit
14. preserve the work/output directory on failure and print exact locations

The importer never runs source package code, modifies global Git configuration, publishes, pushes, or merges a PR.

### 5.3 Signature semantics

Path rewriting changes commit IDs; tag renaming can change annotated tag objects. Existing commit/tag signatures therefore cannot remain valid.

- Record original object IDs and signature presence.
- Strip invalid signature claims from rewritten objects.
- Preserve authors, committers, dates, messages, parent topology, taggers, and unsigned annotation messages.
- Keep old-to-new maps so original signatures remain independently inspectable in the source repositories.

### 5.4 Verification

`tools/verify-history.mjs` independently fresh-clones the sources and fails unless it proves:

- commit-map coverage is exactly the history reachable from the pinned default head and accepted tag tips
- mappings are one-to-one and preserve parent topology, authors, committers, dates, encodings, and messages
- rewritten objects do not claim invalid source signatures
- default-head and all accepted tagged trees match after prefix stripping
- annotated tag type, target, tagger, and message are preserved
- generated merge commits are deterministic and their tree is exactly the collision-free union of their parents
- layout commits are deterministic and their tree is exactly the manifest path transform with unchanged objects
- the final tag set exactly matches the manifest
- no import branch refs, replace refs, nested `.git`, uncommitted changes, or unexpected evidence-commit paths remain

Run the importer twice from the same target base and manifest. Final `HEAD`, tag refs, commit maps, and evidence must be byte-identical.

## 6. Current-tree package contract

### 6.1 Published packages

Published packages are:

- `@uirouter/core`
- `@uirouter/{dsr,rx,redux,sticky-states,visualizer}`
- `@uirouter/{angularjs,angular,angular-hybrid,react,react-hybrid}`
- `@uirouter/publish-scripts` until release-tool replacement is designed

During migration:

- retain package name and current version
- retain `engines`
- retain versioned runtime/peer dependency intent
- update repository/homepage/bugs/directory metadata to the monorepo
- do not publish

### 6.2 Non-published manifests

Before parallel package edits, the coordinator creates `migration/package-classification.json`. It assigns every current `package.json` a class, published/private intent, workspace membership, lock owner, final unique name, owning lane, and allowed internal-resolution mode. Global validators consume this file; package lanes do not independently invent classifications.

Every example, integration, scaffold, and test fixture must have:

- a unique deterministic package name
- `private: true`
- a classification (`example`, `integration`, `fixture`, or nested tool)
- an explicit lock owner: root lock or local npm lock
- no accidental match in the root workspace set

Duplicate current names such as `angular-cli` and `angularjs-webpack` must be made unique without changing application/test logic.

### 6.3 Layout verifier

Keep `tools/verify-layout.mjs` narrow. It must:

- recursively classify every `package.json`
- ask npm for the resolved workspace set and compare it with the path contract
- reject any workspace path containing `/integration/` or milestone-1 `/examples/`
- require unique workspace names
- require `private: true` for non-published projects
- enforce root-versus-local npm lock placement
- reject current-tree Yarn/pnpm locks
- print exact offending paths and exit nonzero

It does not validate dependency ranges.

## 7. Build, source, and package integrity

### 7.1 Source-linked development lane

Framework/plugin source and tests continue importing internal packages by package name. Development/test-only resolver configuration maps approved internal names—especially `@uirouter/core`—to TypeScript source entrypoints.

Acceptance:

- changing a Core source file retriggers affected framework/plugin tests without building Core first
- watch mode observes upstream source and does not read stale `lib/` or `dist/`
- production builds and packed tests do not use source aliases
- aliases are centralized and documented, not copied ad hoc into every test

### 7.2 Production build lane

- Build in topological dependency order.
- Each package declares explicit inputs and outputs.
- Delete stale outputs before build.
- Verify runtime exports, type declarations, source maps, and package entrypoints from built artifacts.
- Building twice from the same clean lock and source must produce the same file list; characterize any unavoidable byte differences.

### 7.3 Packed-consumer lane

For every publishable package:

1. build its own and required upstream packages
2. run `npm pack --json`
3. inspect the tarball allowlist and reject repository-only files
4. install all intended local internal tarballs together into a clean temporary consumer
5. verify exact installed source/integrity for every internal package
6. test CJS/ESM entrypoints as applicable, types, peer behavior, and a minimal consumer flow

No internal package in this lane may resolve from the public registry unless the manifest explicitly classifies that edge as an external compatibility case.

## 8. Turbo task graph

Turbo orchestrates commands; package scripts remain independently runnable and define correctness.

Required task families:

| Task | Dependency/caching contract |
|---|---|
| `lint` | deterministic; cache after baseline parity |
| `typecheck` | includes upstream source hash/dependency where aliases cross packages |
| `test` | source-linked; dependency hashes must invalidate downstream tests |
| `test:watch` | persistent, interruptible, never cached |
| `build` | depends on `^build`; declares package-specific outputs |
| `pack` | depends on same-package `build` and required `^build`; emits content-addressed tarball metadata |
| `docs` | depends on required builds; explicit outputs |
| `integration` / browser / e2e | never cached initially |
| release/publish | never cached; disabled in milestone 1 |

Do not enable remote cache in milestone 1. Cache only tasks shown deterministic by clean reruns. Do not cache secrets, browser state, timestamps, temporary locks, persistent integration sandboxes, or release side effects.

## 9. CI gates

CI uses the pinned Node/npm and starts from a clean checkout unless a lane explicitly tests the persistent local integration loop.

Required gates:

1. **History (migration PR only):** independent verifier and second-run identity comparison.
2. **Layout:** manifest classification, workspace resolution, lock placement, unique/private package metadata.
3. **Install:** root `npm ci` from the committed lock; no lock diff.
4. **Dependency policy:** every internal edge classified; no accidental registry fallback or forced incompatible peer.
5. **Static quality:** format/lint/typecheck, preserving package-specific tools where convergence is unsafe.
6. **Source-linked tests:** package/unit/cross-package lanes with upstream-source invalidation evidence.
7. **Production builds:** topological clean builds and output checks.
8. **Packed consumers:** tarball contents, entrypoints, types, internal tarball provenance, and peer behavior.
9. **Isolated matrix:** compatibility/version/downstream/browser/e2e projects with local locks.
10. **Docs:** every source docs lane that was green at its pinned baseline.

No required source-repository lane may disappear. A pre-existing failure needs a checked-in waiver with source commit, command, failure evidence, owner, reason, tracking issue, and review/expiry date.

## 10. Execution work graph

### 10.1 Agent/worktree rules

- One coordinator owns sequencing, acceptance, and final integration.
- One writer owns a given branch/worktree at a time.
- Read-only inventory, baseline analysis, and review may run in parallel.
- Parallel package writers use isolated worktrees and non-overlapping path ownership.
- Every task returns changed files, commands with exit status, evidence paths, residual risks, and any decision requiring maintainer input.
- Stop on an unapproved public compatibility, release, naming, or scope decision.
- Never run source-provided lifecycle/package scripts before task `B01` approves the exact command.

### 10.2 Tasks and dependencies

| ID | Task | Depends on | Output / acceptance |
|---|---|---|---|
| `H00` | Merge migration spec/tooling | — | reviewed `SPEC.md`, manifest, importer, verifier on target `main` |
| `H01` | Lock official inputs | `H00` | exact target base, source-ref revalidation, Node/npm decision date and pins, clean working state |
| `H02` | Rehearse history import twice and inject failures | `H01` | identical heads/tags/maps/evidence; independent verifier passes both; stale-tag and path-collision probes fail nonzero and preserve the documented diagnostic state |
| `H03` | Execute official history import | `H02` | `migration/history-import` branch from exact base; no push by tool |
| `H04` | Review history/layout PR | `H03` | tag/tree evidence reviewed; generated commits and moves isolated; draft PR green |
| `H05` | Maintainer merge gate for imported history | `H04` | maintainer approves the exact verified head; imported history lands on target `main` |
| `B01` | Review baseline commands | `H00` | lifecycle hooks and CI commands classified safe/unsafe before execution |
| `B02` | Run pinned source baselines | `B01` | exact per-source install/build/test/docs commands, environment, result, logs |
| `B03` | Check in baseline manifest | `B02` | all existing green lanes represented; evidence-backed waivers for failures |
| `N00` | Lock the package-classification contract | `H05` | coordinator-owned `migration/package-classification.json` covers every manifest, unique name, workspace/lock owner, lane, and internal-resolution mode |
| `N01` | Pin root Node/npm and npm workspaces | `H05` | exact pins, positive workspace globs, root scripts, initial root lock |
| `N02` | Normalize manifests in owned lanes | `N00` | published metadata preserved; private unique non-published projects; repo metadata updated without cross-lane classification drift |
| `N03` | Convert lock and resolution policy | `N01`,`N02`,`B03` | root/local npm locks; reviewed Yarn `resolutions` translated only where intentional; no current Yarn/pnpm locks |
| `N04` | Implement layout/dependency validators | `N02`,`N03` | `verify-layout` and `verify-internal-deps` fail with exact paths/edges |
| `S01` | Standardize package build/test interfaces | `N03`,`B03` | package scripts independently reproduce required baseline lanes |
| `S02` | Add centralized source aliases/watch | `S01`,`N04` | Core edit retriggers affected tests without Core build; production lane alias-free |
| `S03` | Add Turbo graph | `S01`,`S02` | topological tasks, explicit inputs/outputs, safe cache boundaries |
| `I01` | Move/repair isolated projects | `N03`,`B03` | path-reference repairs separate from pure move commits; local locks and private names |
| `I02` | Implement integration runner | `S03`,`I01` | clean and persistent modes; state validation; exact rerun/reset commands |
| `P01` | Implement pack/consumer checks | `S03`,`N04` | content-hashed tarballs, contents/exports/types/provenance checks |
| `C01` | Build CI gates/matrices | `S03`,`I02`,`P01`,`B03` | all required gates represented with compact failure artifacts |
| `C02` | Prove clean reproducibility | `C01` | repeated `npm ci`, build, test, pack runs; no source/lock diff |
| `A01` | Milestone-1 acceptance | `C02` | all Section 11 criteria pass; maintainer reviews remaining waivers/risks |
| `R01` | Design release/cutover milestone | `A01` | separate approved plan for versioning, publishing, archive/redirect, rollback |

### 10.3 Safe parallel lanes

After maintainer gate `H05`:

- `B01`–`B03` may already be complete from source clones.
- `N00` has one coordinator writer and lands the complete classification/ownership contract first.
- `N01` root tooling has one writer.
- `N02` may then split into isolated Core, plugins, frameworks, examples/integrations, and tools worktrees whose path ownership is recorded by `N00`.
- Read-only CI/task inventory can proceed while `N01`/`N02` write.
- `S02`, `I01`, and `P01` start only after their shared manifest/dependency contracts land.
- A single integration writer resolves cross-lane root lock, Turbo, and CI changes.

## 11. Milestone-1 acceptance

All must be true:

### History and layout

- [ ] 16 pinned sources imported in manifest order.
- [ ] Exactly 474 accepted tags exist under their expected names; no rejected source tag is imported.
- [ ] Default and selected tag-only history have complete one-to-one commit maps.
- [ ] Tag trees match source paths/contents after prefix stripping.
- [ ] Current embedded projects are moved only in explicit path-only commits.
- [ ] Import rerun identity and independent verification pass.

### npm and metadata

- [ ] Exact Node/npm pins are documented and CI-enforced.
- [ ] Clean root `npm ci` succeeds without lock changes.
- [ ] Workspace membership equals the positive path contract.
- [ ] Every non-published project is private, uniquely named, and has the correct lock owner.
- [ ] Current tree contains no Yarn/pnpm locks or unexplained translated resolution.
- [ ] Published package names, versions, `engines`, and dependency intent remain unchanged except separately approved fixes.

### Development, build, and packaging

- [ ] Source-linked Core changes invalidate/retrigger affected framework/plugin tests without a Core build.
- [ ] Production builds are topological, clean, and alias-free.
- [ ] Packed tarballs pass contents, exports, runtime, type, peer, and local-provenance tests.
- [ ] Persistent integration reruns avoid clean reinstall and retain failed sandboxes.
- [ ] Clean integration mode passes from fresh local tarballs and produces a usable failure bundle when forced to fail.

### CI parity

- [ ] Every previously green required source lane exists and passes from pinned baseline evidence.
- [ ] Every remaining failure has an approved, owned, expiring waiver.
- [ ] Required clean install, static, source test, build, pack, integration/browser/e2e, and docs gates pass.
- [ ] No remote-cache dependency, release, publish, archive, or source-repository mutation occurred.

## 12. Stop and rollback rules

Stop immediately when:

- a pinned source branch/tag object differs
- tag classification becomes ambiguous
- a path collision or unmapped current move appears
- import verification finds missing/extra refs, topology/metadata drift, or tag-tree drift
- npm requires `--force`/`--legacy-peer-deps` to install
- a required source baseline cannot be reproduced and lacks an approved waiver
- a clean packed test resolves an intended local package from the registry
- migration requires an unapproved public compatibility or release-policy change

Rollback before cutover is branch deletion: no import tool pushes, publishes, archives, or mutates source repositories. Preserve the manifest, import lock, verification report, compact logs, and failed work/output directories until the failure is understood.

## 13. Official history-import command shape

After `H00` is merged, from a clean clone:

```bash
# Create an isolated pinned git-filter-repo wrapper; do not alter the repository.
mkdir -p .migration-work/bin
cat > .migration-work/bin/git-filter-repo <<'EOF'
#!/bin/sh
exec uvx --from git-filter-repo==2.47.0 git-filter-repo "$@"
EOF
chmod +x .migration-work/bin/git-filter-repo

BASE="$(git rev-parse origin/main)"
PATH="$PWD/.migration-work/bin:$PATH" \
  node tools/import-history.mjs \
  --base "$BASE" \
  --output ../ui-router-import \
  --workdir "$PWD/.migration-work/import" \
  --keep-workdir

node tools/verify-history.mjs \
  --repo ../ui-router-import \
  --manifest migration/sources.json \
  --report .migration-work/verification.json
```

Repeat into a different output/work directory and compare:

```bash
test "$(git -C ../ui-router-import rev-parse HEAD)" = \
     "$(git -C ../ui-router-import-2 rev-parse HEAD)"
diff -u \
  <(git -C ../ui-router-import show-ref --tags) \
  <(git -C ../ui-router-import-2 show-ref --tags)
diff -ru \
  ../ui-router-import/migration/evidence \
  ../ui-router-import-2/migration/evidence
```

Review the output and verification report before any push. Open all migration PRs as drafts.

## 14. Deferred follow-up backlog

After milestone 1:

- modernize and honestly test published Node `engines`
- decide whether examples should become root workspaces
- replace/decompose `@uirouter/publish-scripts`
- choose versioning/changelog/release tooling
- design package publishing provenance and dry-run promotion
- decide remote Turbo cache after deterministic local evidence
- define old-repository archive/read-only/redirect policy
- execute release cutover and rollback rehearsal
