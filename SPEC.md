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
- preserve rewritten Git object IDs or claim that rewritten signatures remain valid
- execute package scripts until their commands and lifecycle hooks have been statically reviewed

## 3. Fixed decisions

### 3.1 Package manager and toolchain

- Use npm only. Remove Yarn/pnpm assumptions from the current development tree.
- At execution start, resolve the then-current latest Node LTS and the npm bundled with it. Record the decision date and exact versions.
- Pin Node in `.nvmrc` and npm in root `packageManager`; CI must reject different versions.
- Before the official history rehearsal, pin exact Node, npm, Git, Python, uv, `git-filter-repo` package/reported version, and executable-wrapper SHA-256 in the source manifest. The currently recorded values are rehearsal pins; `H01` refreshes them in a reviewed commit if the execution environment changes.
- Generate the root lock with the pinned npm only after the internal-edge classification contract lands. Root and isolated dependency installation use `npm ci --ignore-scripts`; reviewed lifecycle effects, Git-hook setup, browser downloads, and generated setup run later as explicit named tasks with pinned inputs rather than implicit install hooks.
- “npm only” describes the final current tree. Immutable source baselines run from retained source mirrors with each source's original lock and exact source-native npm/Yarn package-manager version and command recorded by `B01`/`migration/baselines.json`; those tools never become active monorepo configuration. Final npm-converted lanes are separate evidence after `N03`/`N05`.
- Keep existing published package `engines` unchanged. Track modernization as follow-up work; source baseline/runtime support is recorded separately from published engine declarations.

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
  "plugins/*/examples/*",
  "framework/*/router",
  "framework/*/examples/*",
  "tools/*"
]
```

- All final `/examples/` projects and sample apps are private root workspaces. After their pinned source baseline, `N02` updates stale private example toolchains and every internal dependency—including exact and `latest` specs—to explicit ranges compatible with the current local workspace packages; local published package versions do not change for this normalization. These projects use the root lock and linked local packages for normal development and are behavioral/developer tests, not consumer-install evidence.
- `integration/` compatibility/version-matrix projects are private, excluded from root workspaces, and own npm locks. Only projects mapped under `/integration/` by H01's locked source/path contract may retain an older incompatible combination. N00 validates this before H02; any newly discovered relocation invalidates H01 and restarts the lock/rehearsal sequence. H03R never silently reclassifies an `/examples/` path.
- The repository has one root npm lock plus one local npm lock per classified integration project. No workspace has a nested lock. No Yarn or pnpm lock remains on current `main` after npm conversion.
- Historical commits and imported tags retain their original lockfiles and contents.

### 3.5 Internal dependencies

- Published manifests retain ordinary semver dependency and peer ranges. Do not publish `file:` or workspace-only specs.
- When a local package version satisfies an internal range, root installation must resolve that edge to the workspace package.
- When a local version does not satisfy a declared range, do not hide the mismatch with `--legacy-peer-deps`, a global override, or an untested range change.
- `migration/package-classification.json` inventories every dependency/devDependency/peerDependency/optionalDependency edge across all imported and generated manifests, including exact versions, tags such as `latest`, and legacy downstream-injected edges. It records declared and final specs, manifest section, expected package/version, allowed resolution mode, expected physical install path/origin, owning lane, and packed-lane tarball/registry expectation. The root lock cannot land until `npm ls --all`, consumer-context resolution, and filesystem checks prove those expectations with the pinned Node/npm.
- The pinned Angular Hybrid source baseline remains `21.0.0` and is tested unchanged by `B02`. Chris approved one milestone-1 compatibility/version exception after that baseline: bump `@uirouter/angular-hybrid` to `22.0.0`, change its `@uirouter/angular` peer/dev dependency to `^22.0.0`, narrow its `@angular/core`/`@angular/upgrade` peers to `^22.0.0`, and align its Angular dev packages, ng-packagr, TypeScript, and Zone.js with the Angular 22 workspace toolchain. Earlier Angular combinations remain supported by their matching earlier Hybrid majors.
- After this alignment, `@uirouter/angular` and `@uirouter/angular-hybrid` release majors stay in lockstep. The root/packed lanes must resolve the Hybrid-to-Angular edge locally with no registry fallback; isolated projects remain responsible for testing older published major combinations.
- Test any other declared incompatible versions in isolated integration projects. A separate source-linked lane may test a prospective local version. Private workspace dev/tool edges such as exact older `@uirouter/publish-scripts` versions are normalized to the current local workspace version after their source baselines unless the classification contract records and justifies an isolated external-compatibility edge.
- Development/test aliases may map package names to live TypeScript source. Packed-package tests disable all such aliases.
- `tools/verify-internal-deps.mjs` is separate from layout verification and classifies every internal edge as local-compatible, intentionally external compatibility, or erroneous.

### 3.6 Integration test modes

One small integration runner replaces the active Yalc/downstream helper for every retained downstream lane.

**Clean gate (`--clean`):**

1. A producer job builds and packs the complete classified internal package graph, names tarballs with their content hash, and uploads them with a hash manifest. The checked-in matrix names stable artifact IDs; the per-run `integration-run-lock.json` binds those IDs to actual package/version/path/hash values and the repository/toolchain state.
2. A separate clean consumer job copies the complete fixture tree, committed fixture manifest/lock, and downloaded tarballs into a fresh sandbox whose realpath is outside checkout/repository ancestry. It unsets `NODE_PATH` and uses no source/node_modules symlink or mutable hard link back into the checkout.
3. `migration/integration-matrix.json` explicitly lists every internal edge to rewrite or inject, its source legacy downstream key, target manifest section, expected package/version/origin, and stable tarball artifact ID. The runner resolves actual hashes only through the run lock, then generates a staged manifest by changing exactly the matrix's rewrite-edge IDs to relative content-addressed `file:` tarballs; undeclared legacy/Yalc-injected edges are added only when the matrix names them.
4. Starting from the migrated committed fixture lock, pinned npm runs `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`. The runner rejects any undeclared external-graph change, internal registry fallback, unexpected peer insertion, or manifest/lock edit outside the external sandbox.
5. The runner validates staged root specs, every internal lock `resolved`/integrity/version, the unchanged or explicitly allowed external graph, and the complete run lock/tarball hash manifest; it records original/staged manifest and lock hashes before running exactly one `npm ci --ignore-scripts`, then invokes only reviewed lifecycle/browser/setup tasks explicitly.
6. Consumer-context CJS/ESM resolution and `npm ls --all` must keep every non-builtin module inside the sandbox and match its classified registry or local-tarball origin. A controlled sentinel package created only under the checkout root must not resolve from sandbox code.
7. The committed fixture manifest and lock remain byte-unchanged. The failure bundle includes the original and staged manifests/locks, matrix entry, tarballs/hash manifest, npm config/toolchain, filtered dependency graph, exact command, and logs.

**Persistent development loop (`--reuse`, opt-in local debugging):** use a configurable cache root whose realpath is outside repository ancestry. Populate an independent fixture tree with copy-on-write copies when available and incremental ordinary copies otherwise; source, manifests, locks, snapshots, generated output, and `node_modules` are never hard-linked or symlinked to the repository. State records the complete fixture-tree/lock/matrix hash, repository revision, platform/architecture, Node/npm versions and configuration, internal tarball hashes, installed dependency graph, and last command. Any dependency/peer/lock/toolchain mismatch resets the sandbox; otherwise the runner rebuilds and repacks the affected internal graph, installs only changed tarballs with pinned npm `--no-save --ignore-scripts`, revalidates graph/origin/hash state, and reruns the selected test without changing the committed fixture lock.

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

Move commits contain path changes only. Reference/path repairs are separate commits so rename evidence remains reviewable. H03R first creates the complete deterministic repair commit chain without `path-repairs.json`; after those object IDs are fixed, it adds one metadata-only contract commit whose parent is the final repair. That final commit contains versioned `migration/path-repairs.json`, excludes itself from `repairCommit` records, and changes no repaired file. The contract enumerates every moved path plus each affected owning package, expected process cwd, script/config/doc field, old and new reference, interpretation mode, already-created repair commit, owning task, exact command/environment, expected status, semantic smoke assertion, and evidence hash. A validator independently inventories moved paths, enforces the exact parent/allowed-commit chain, searches the current tree for undeclared stale references, and runs the reviewed final-tree smoke for every moved package/downstream group so valid-looking relative paths cannot silently resolve from the wrong cwd. The repair chain and final contract commit land before `H05`.

## 5. History import tooling

### 5.1 Inputs

`migration/sources.json` records, per source:

- URL, default branch, pinned head and tree
- default-branch commit count
- destination/tag namespace
- every observed tag object, peeled commit/tree, historical root package version, reachability, and signature presence
- 474 accepted release tags and 27 excluded tags
- current-head move operations

New upstream refs never silently enter a locked run. If a pinned default ref/tag object moves, or any source tag name is added or removed before the official run, stop and review a manifest refresh. `H01` creates versioned `migration/execution-lock.json` on a single-owner control branch rooted at the exact target base; it contains that base object, source-manifest digest, all source ref/object inputs, complete toolchain, and retained-artifact hashes. B03/N00 contracts bind the execution-lock digest without being inputs to that digest. H02/H03 consume the reviewed control-tree files rather than recomputing a floating ref, and the importer copies their exact bytes into the final evidence commit. Any target `main`, source, manifest, or toolchain change invalidates the control branch and requires reviewed regeneration of dependent contracts plus a new H02 rehearsal.

`H01` also creates one retained local mirror and one complete Git bundle per source. The execution lock records each bundle's SHA-256, object format, included refs, and retention path/owner. It vendors the exact resolved `git-filter-repo` artifact with SHA-256 and execution path in addition to package/reported version and wrapper digest; the official wrapper executes only that local artifact and never resolves through `uvx`, a package registry, or a mutable cache. Remote, retained-mirror, and offline-bundle importer/verifier modes must be identical. Keep these artifacts through milestone acceptance and later source-repository archival.

The control root has an exact allowlist: `migration/{sources,execution-lock,baselines,package-classification}.json` plus only contract-referenced compact files under `migration/control-evidence/`. The importer copies the four contracts to the same paths and maps declared compact files to `migration/evidence/control/`. `migration/import-lock.json` records every source/destination/hash pair. The verifier derives the complete control/evidence allowlist from that lock, rehashes every file, rejects undeclared files in either control-evidence tree, and requires the summary to bind the same control-file hashes.

### 5.2 Importer behavior

`tools/import-history.mjs` must:

1. require `--execution-lock` plus its full immutable target `--base`; never resolve floating target `HEAD`, and fail unless the supplied base equals both the execution lock and the freshly cloned target `main` tip
2. refuse existing output/work directories
3. verify the execution-lock/manifest digests, exact Node/npm/Git/Python/uv/filter-repo toolchain, vendored filter-repo artifact and executable-wrapper digests
4. sanitize Git environment overrides; disable system/global Git config, hooks, signing, and global attributes/excludes
5. fresh-clone every source as a mirror
6. disable replacement-object traversal and reject source replace refs, grafts, or alternates before validating pinned heads, trees, commit counts, the complete tag-name set, tag objects/types/targets/trees, package versions, reachability, and signature presence
7. delete unselected refs in the temporary mirror
8. rewrite only remaining refs beneath one destination prefix and namespace tags
9. retain old-to-new commit maps
10. fresh-clone the target and prove `--base` equals target `main`; require the exact main-only ref set; verify base `migration/sources.json` bytes against the execution lock's separate `targetBaseSourceManifestSha256` before replacing them with the reviewed H01 source manifest; fail on target tags/other refs/output branch or any pre-existing `migration/{execution-lock,baselines,package-classification,import-lock}.json` or `migration/evidence/` path
11. merge rewritten default histories in manifest order with deterministic two-parent merge commits; never force-update a target tag
12. apply manifest moves in deterministic path-only commits
13. validate the reviewed control-tree contract set against `import-lock.schema.json`, copy its exact allowlisted contracts/evidence to their declared destinations, and add them together with import lock, commit maps, and ref evidence in one final deterministic evidence commit; reject missing, extra, stale-digest, or tampered control inputs
14. preserve the work/output directory on failure and print exact locations

The importer never runs source package code, modifies global Git configuration, publishes, pushes, or merges a PR.

### 5.3 Signature semantics

Path rewriting changes commit IDs; tag renaming can change annotated tag objects. Existing commit/tag signatures therefore cannot remain valid.

- Record original object IDs and signature presence.
- Strip invalid signature claims from rewritten objects.
- Preserve authors, committers, dates, messages, parent topology, taggers, and unsigned annotation messages.
- Keep old-to-new maps so original signatures remain independently inspectable in the source repositories.

### 5.4 Verification

`tools/verify-history.mjs` requires explicit assembled-tree manifest/execution-lock paths, independently validates `import-lock.schema.json` plus the complete digest-linked control/evidence allowlist, fresh-clones the sources, and fails unless it proves:

- commit-map coverage is exactly the history reachable from the pinned default head and accepted tag tips
- mappings are one-to-one and, for every selected commit, preserve the complete prefixed tree object and all headers/messages except explicitly stripped invalid signature headers
- rewritten objects do not claim invalid source signatures
- default-head and all accepted tagged trees match after prefix stripping
- annotated tag type, target, ordered non-signature headers (including tagger/encoding), and unsigned message are preserved; only invalid signature material is omitted
- generated merge commits are deterministic and their tree is exactly the collision-free union of their parents
- layout commits are deterministic and their tree is exactly the manifest path transform with unchanged objects
- the final ref namespace exactly equals the locked target refs plus the output branch and accepted imported tags
- no extra heads/remotes/notes/stashes, import refs, replace refs, nested `.git`, uncommitted changes, or unexpected evidence-commit paths remain

Run the importer three times from the same target base, manifest, and exact toolchain—once from remote sources, once from retained local mirrors, and once from fresh bare repositories restored only from hashed offline bundles. Final `HEAD`, all refs, imported control contracts, import lock, commit maps, and evidence must be byte-identical. Preserve that verified import output unchanged. If current-head path-repair commits are added for the review branch, its first parent must be the exact verified evidence commit; run history verification against the preserved import output and the repair validator against the descendant review head.

## 6. Current-tree package contract

### 6.1 Published packages

Published packages are:

- `@uirouter/core`
- `@uirouter/{dsr,rx,redux,sticky-states,visualizer}`
- `@uirouter/{angularjs,angular,angular-hybrid,react,react-hybrid}`
- `@uirouter/publish-scripts` until release-tool replacement is designed

During migration:

- retain package name and current version, except for the approved Angular Hybrid `21.0.0` → `22.0.0` lockstep alignment
- retain `engines`
- retain versioned runtime/peer dependency intent
- update repository/homepage/bugs/directory metadata to the monorepo
- do not publish

### 6.2 Non-published manifests

Before parallel package edits, the coordinator creates `migration/package-classification.json`. It independently reconciles the 44 imported source manifests from the locked inventory with the generated root manifest and any generated tool manifests; every manifest is accounted for exactly once, so “44 source manifests” is not confused with the larger final count. It assigns each manifest a class, published/private intent, workspace membership, lock owner, final unique name, owning lane/file set, lifecycle policy, and allowed internal-resolution mode. Global validators consume this file; package lanes do not independently invent classifications.

Every example, integration, scaffold, and test fixture must have:

- a unique deterministic package name
- `private: true`
- a classification (`example`, `integration`, `fixture`, or nested tool)
- an explicit lock owner: root lock or local npm lock
- workspace membership that exactly matches its classification: ordinary examples use the root workspace/lock; integrations and non-installed fixtures must not match a positive workspace glob

Duplicate current names such as `angular-cli` and `angularjs-webpack` must be made unique without changing application/test logic. The classification file also owns the exhaustive internal-edge table and one record per package-local Yarn `resolutions`/npm `overrides` decision: original owner/scope, selector and affected dependency paths, direct/transitive status, final npm equivalent or removal, whether root scope broadens, approval/evidence, and expected root/local lock entries, versions, physical origins, and packed-lane behavior. Workspace-package overrides are never assumed to apply at the root.

### 6.3 Layout verifier

Keep `tools/verify-layout.mjs` narrow. It must:

- recursively classify every `package.json`
- ask npm for the resolved workspace set and compare it with the path contract
- reject any workspace path containing `/integration/`; require every classified ordinary `/examples/` project to resolve as a workspace
- require unique workspace names
- require `private: true` for non-published projects
- enforce root-versus-local npm lock placement
- reject current-tree Yarn/pnpm locks
- print exact offending paths and exit nonzero

It does not validate dependency ranges.

### 6.4 Current-tree package-manager migration

`tools/verify-package-manager.mjs` rejects active Yarn/pnpm behavior outside the retained-source-baseline evidence and an explicit reviewed historical-code allowlist. Milestone 1 migrates current CI/workflow commands, contributor docs, package-manager declarations, lifecycle scripts, and dependency automation to npm. Root and isolated install commands must include `--ignore-scripts`; lifecycle hooks are individually classified and replaced by explicit Turbo/setup tasks or disabled. Browser installation is a separate pinned matrix step. Historical commits/tags remain untouched.

The new npm/tarball integration runner and matrix replace every active `test_downstream_projects`/Yalc invocation before CI parity is accepted. The imported helper may remain only as non-executable historical compatibility code. Existing dependency-update actions are migrated to reviewed npm-compatible local automation or explicitly disabled with an owned waiver; no current workflow executes Yarn-aware publish-scripts behavior.

## 7. Build, source, and package integrity

### 7.1 Source-linked development lane

Framework/plugin source and tests continue importing internal packages by package name. Versioned `migration/source-aliases.json` is the single package-name-to-source contract. Every edge records package/export name, source entrypoint, consumer and lane, resolver precedence, TypeScript config/paths adapter, Jest/Vitest mapping, Karma/Webpack alias/watch adapter, Rollup/Rolldown/Vite adapter, ng-packagr policy, watch roots/ignored paths, invalidation command, expected resolved realpath, and production-disable rule; unsupported adapters are explicit `not-applicable`, never omitted. Development/test-only resolver configuration is generated or validated from this contract rather than independently inventing aliases.

Acceptance:

- changing any approved upstream source—not only Core—retriggers every declared downstream source-linked lane without building the upstream package first
- watch mode observes upstream source and does not read stale `lib/` or `dist/`
- production builds, declarations, source maps, bundles, and packed tests contain no source-alias path or unpublished source entrypoint
- aliases are centralized and documented, not copied ad hoc into every test
- each adapter has a positive consumer-resolution/watch test, while production build/pack checks are negative tests proving no checkout-relative source entrypoint or alias survives

### 7.2 Production build lane

- Build in topological dependency order.
- Each package declares explicit inputs and outputs.
- Delete stale outputs before build.
- Verify runtime exports, type declarations, source maps, and package entrypoints from built artifacts.
- Building and packing twice from the same clean lock, source, toolchain, and normalized environment must produce identical file lists and SHA-256 hashes. Any unavoidable byte difference requires a named normalization rule or checked-in waiver that identifies the file/field, cause, owner, and release risk; source-map paths are normalized and must not expose checkout-specific roots.

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

CI uses the pinned Node/npm and starts from a clean checkout unless a lane explicitly tests the persistent local integration loop. The runtime contract includes OS image/digest, architecture, timezone/locale, exact browser package/revision and checksum, browser installer version, and relevant npm/Node environment; CI asserts these values before running a lane.

Required gates:

1. **History (migration PR only):** independent verifier and second-run identity comparison.
2. **Layout:** manifest classification, workspace resolution, lock placement, unique/private package metadata.
3. **Install:** root `npm ci --ignore-scripts` from the committed lock, followed by classified explicit setup/lifecycle tasks; no lock diff.
4. **Dependency policy:** every internal edge classified; no accidental registry fallback or forced incompatible peer.
5. **Static quality:** format/lint/typecheck, preserving package-specific tools where convergence is unsafe.
6. **Source-linked tests:** package/unit/cross-package lanes with upstream-source invalidation evidence.
7. **Production builds:** topological clean builds and output checks.
8. **Packed consumers:** tarball contents, entrypoints, types, internal tarball provenance, and peer behavior.
9. **Isolated matrix:** classified compatibility/version/packed-downstream projects with local locks, external-sandbox resolution audits, and the root-only sentinel probe; ordinary workspace browser/e2e lanes remain in their owning source/test gates.
10. **Docs:** every source docs lane that was green at its pinned baseline.

No required source-repository lane may disappear. A pre-existing failure needs a checked-in waiver with source commit, command, failure evidence, owner, reason, tracking issue, and review/expiry date.

Gate coverage is machine-readable. Checked-in JSON Schemas under `migration/schemas/` define execution/import locks, baseline, package-classification, path-repair, source-alias, integration-matrix/run-lock, and work-graph formats. H01 pins the exact schema-validator version/artifact/digest in the execution lock; every producing task validates before commit, and each consuming task revalidates before use. Every contract has a `schemaVersion` and canonical paths; operational source/lane/manifest/edge/repair/alias/fixture records additionally require IDs, owners, and hashed evidence, while derived import/work-graph records bind their authoritative source contract. Schemas constrain record shape and array uniqueness, and domain validators enforce uniqueness by ID/path plus complete ownership and evidence coverage. Digest links form an acyclic chain from execution lock → baselines → package classification → path repairs/source aliases/integration matrix; no contract hashes a dependent contract. Validators derive complete manifests, dependency edges, moved paths, source lanes, and downstream groups independently instead of trusting each contract's own list; omitted/duplicate/unowned records fail. Contract and package edits land atomically in the owning task before another lane may consume them.

- `migration/baselines.json` records the final H01 execution-lock/manifest digests, repository/source commit, source path/config, workflow matrix or recursively expanded `downstream_projects.json` group/project key, legacy injected edge, lane and exact command, reviewed lifecycle/source-native package manager and version, Node/browser/tool versions/checksums, environment, result, evidence artifact/hash, and waiver. A validator recursively inventories workflow matrices, package scripts, downstream project trees/URLs, docs commands, browser/e2e configs, integration manifests, and Yalc injection behavior; it compares that independent inventory with H01 artifacts and fails on stale inputs or omissions.
- `migration/integration-matrix.json` records fixture, package graph, stable tarball artifact IDs, expected local/external edges, lock owner, exact runtime/browser, staged-manifest/temporary-lock policy, clean/reuse commands, external cache/sandbox policy, sentinel probe, and exact reset inputs. A per-run schema-valid integration run lock binds repository/toolchain/command state, actual tarball hashes, original/staged manifest and lock hashes, and dependency graphs. Validators reject duplicate/omitted fixture or edge IDs, rewrite-edge/artifact mismatches, non-exact lock/install commands, incomplete reset inputs, repository-ancestor sandboxes, source/node_modules symlinks or mutable hard links, unexpected registry fallback, out-of-sandbox module resolution, stale reuse state, or a changed committed fixture lock.
- `migration/path-repairs.json` and `migration/source-aliases.json` cover moved references and resolver adapters as defined above. Their validators fail on undeclared stale paths or unowned aliases.
- `migration/package-classification.json` is the authority for workspace/lock ownership, internal-edge physical resolution, and scoped npm override decisions.

## 10. Execution work graph

### 10.1 Agent/worktree rules

- One coordinator owns sequencing, acceptance, and final integration.
- One writer owns a given branch/worktree at a time.
- Read-only inventory, baseline analysis, and review may run in parallel.
- Parallel package writers use isolated worktrees and non-overlapping path ownership.
- Every task returns changed files, commands with exit status, evidence paths, residual risks, and any decision requiring maintainer input.
- Stop on an unapproved public compatibility, release, naming, or scope decision.
- `migration/work-graph.json` is the machine-readable dependency mirror of the task table. `tools/verify-work-graph.mjs` rejects unknown/duplicate dependencies, cycles, dependency-column drift, or missing explicit safety edges before any swarm task launches; task output/ownership authority remains the table plus domain contracts, not the DAG file.
- H01–N00 contract generation has one control-branch writer. Those reviewed commits are never merged ahead of their own locked target base; H03 stages the exact contract bytes in its deterministic evidence commit, avoiding a self-referential target-base lock.
- Never run source-provided lifecycle/package scripts before task `B01` approves the exact command.

### 10.2 Tasks and dependencies

| ID | Task | Depends on | Output / acceptance |
|---|---|---|---|
| `H00` | Merge migration spec/tooling | — | reviewed `SPEC.md`, manifest, importer, verifier, contract schemas/schema-ref check, work graph, and DAG validator on target `main` |
| `H01` | Lock official inputs and mirrors | `H00` | execution-lock/import-lock schemas plus independent unique-source/artifact/control validator and importer/verifier assertions; exact target/base-source-manifest/source/path/tool artifacts/digests; no mutable resolver; clean state |
| `H02` | Rehearse history import three ways and inject failures | `H01`,`N00` | path/control contracts final and exact; three modes identical and independently verified; probes cover missing/extra/tampered/stale control, base-source-manifest mismatch, every reserved control destination, artifact/network/cache substitution, lock/target drift, signatures/topology/modes/symlinks, replacement metadata, ref/tag/tree/layout collisions, and evidence tampering |
| `H03` | Execute official history import | `H02` | `migration/history-import` branch from the exact execution lock/base with reviewed source/baseline/classification/control inputs in its evidence commit; no floating-ref recomputation and no push by tool |
| `H03R` | Lock and apply current-head path repairs | `H03`,`B03`,`N00` | branch from exact evidence commit; N00 confirms no late reclassification; deterministic repair-only chain followed by one metadata-only schema-valid contract commit referencing prior repair IDs; exact-chain/cwd/semantic validator passes; preserve original import output unchanged |
| `H04` | Review history/layout/repair PR | `H03R` | preserved H03 output passes exact history/ref/evidence checks; review head contains exactly the declared repair parent chain followed by one metadata-only `path-repairs.json` contract commit whose parent is the final repair and which changes no repaired file; no other descendant commit; draft PR green |
| `H05` | Maintainer merge gate for imported history | `H04` | maintainer approves the exact verified head; imported history lands on target `main` |
| `B01` | Review baseline commands | `H00` | every lifecycle/CI command classified safe/unsafe; exact source-native npm/Yarn version, lock policy, runtime/browser, and command selected before execution |
| `B02` | Run pinned source baselines | `B01`,`H01` | run only from H01 retained mirrors with original locks and pinned source-native package managers; exact per-source/downstream install/build/test/docs commands, environment, result, logs |
| `B03` | Check in baseline/runtime manifest | `B02` | schema plus independent validator enforce unique IDs, workflow/group/project ownership, complete discovered lane coverage, exact source/package-manager/runtime/browser, evidence hashes, and conditional waiver semantics |
| `N00` | Lock the package-classification contract | `H01`,`B03` | pre-merge schema plus independent validator enforce unique IDs/paths/names, complete manifests/edges/injections/hooks/resolutions, non-overlapping file ownership, evidence hashes, final paths/spec/version/origin/lock/mode decisions |
| `N01` | Pin root Node/npm and npm workspaces | `H05`,`N00` | exact pins, positive workspace globs including ordinary examples, root scripts, explicit lifecycle/setup policy; no root lock until classified edge behavior is proven |
| `N02` | Normalize manifests in owned lanes | `H05`,`N00` | published metadata preserved except approved Angular Hybrid 22; every ordinary example/tool edge updated to explicit current local-compatible ranges and tested; private unique names; integration paths remain isolated; repo metadata updated without cross-lane classification drift |
| `N03` | Convert lock and resolution policy | `N01`,`N02`,`B03` | root/local npm locks generated with scripts disabled; `npm ls` plus consumer-context version/path/origin assertions match every classified edge; each resolution/override scope explicitly translated/removed; no current Yarn/pnpm locks |
| `N04` | Implement layout/dependency validators | `N02`,`N03` | `verify-layout` and `verify-internal-deps` independently rederive coverage and fail with exact duplicate/omitted/unowned paths/edges |
| `N05` | Remove active Yarn/pnpm assumptions | `N02`,`B03` | current CI, docs, metadata, lifecycle/install scripts, and dependency automation are npm-only; only source-baseline evidence and explicitly non-executable legacy code remain allowlisted pending I02 replacement |
| `S01` | Standardize package build/test interfaces | `N03`,`N05`,`B03` | package scripts and explicit setup/lifecycle tasks independently reproduce required baseline lanes without overlapping N05 ownership |
| `S02` | Add centralized source aliases/watch | `S01`,`N04` | schema plus independent unique-edge/ownership validator drives every adapter; explicit resolution and watch-observation tests retrigger consumers; production/pack outputs alias-free |
| `S03` | Add Turbo graph | `S01`,`S02` | topological tasks, explicit inputs/outputs, safe cache boundaries |
| `I01` | Finalize isolated projects after `H03R` | `H05`,`N03`,`B03` | only classified compatibility/integration projects have local locks; ordinary examples are current-version private root workspaces; all hidden legacy/Yalc-injected edges are explicit and all projects retain baseline-parity commands without further silent path moves |
| `I02` | Implement integration runner and matrix | `S03`,`I01` | matrix/run-lock schemas and independent inventory validator; clean external sandbox and opt-in reuse; exact staged-manifest/temporary-lock/run-lock algorithm; resolution/sentinel probes, full state invalidation, failure bundle, rerun/reset commands |
| `P01` | Implement pack/consumer checks | `S03`,`N04` | content-hashed tarballs, contents/exports/types/provenance checks |
| `C01` | Build CI gates/matrices | `S03`,`I02`,`P01`,`B03`,`N05` | machine-readable contracts prove every required gate/lane is represented with compact failure artifacts |
| `C02` | Prove clean reproducibility | `C01` | repeated `npm ci --ignore-scripts`, explicit setup, build, test, and pack runs; identical hashes/waivers; no source/lock diff |
| `A01` | Milestone-1 acceptance | `C02` | all Section 11 criteria pass; maintainer reviews remaining waivers/risks |
| `R01` | Design release/cutover milestone | `A01` | separate approved plan for versioning, publishing, archive/redirect, rollback |

### 10.3 Safe parallel lanes

Before `H03R`, `B01`–`B03` and the single-writer `N00` classification/ownership contract are complete from locked source inputs; N00 determines final example/integration path classes consumed by the repair plan. After maintainer gate `H05`:

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
- [ ] Default and selected tag-only history have complete one-to-one commit maps; every mapped commit preserves the full prefixed tree and all non-signature headers/messages.
- [ ] Tag trees match source paths/contents after prefix stripping.
- [ ] Current embedded projects are moved only in explicit path-only commits, and every moved reference is covered by the validated repair contract before merge.
- [ ] The final ref namespace equals the locked target refs plus the output branch and accepted tags—no extra branch, remote, note, stash, replace, or import ref remains.
- [ ] Remote, retained-mirror, and offline-bundle rerun identity plus independent verification pass under the exact locked history toolchain.

### npm and metadata

- [ ] Exact final Node/npm and per-source baseline package-manager/runtime/browser pins and artifact checksums are documented and CI-enforced in their respective lanes.
- [ ] Clean root `npm ci --ignore-scripts` succeeds without lock changes; reviewed lifecycle/setup/browser tasks run only through explicit commands; every internal edge resolves from its consumer to the classified version, physical origin, and local-tarball/registry source without force flags.
- [ ] Workspace membership equals the positive path contract: every ordinary example has explicit current local-compatible internal ranges and is a private root workspace; no integration project is a workspace and no `latest`/obsolete exact internal spec is left for npm to resolve implicitly.
- [ ] Every non-published project is private, uniquely named, and has the correct lock owner; no workspace has a nested lock.
- [ ] Current active CI, docs, metadata, scripts, dependency automation, and locks contain no unapproved Yarn/pnpm assumption or unexplained translated resolution.
- [ ] Published package names, versions, `engines`, and dependency intent remain unchanged except the approved Angular Hybrid 22 lockstep alignment and any later separately approved fix.

### Development, build, and packaging

- [ ] Every declared source-linked upstream change invalidates/retriggers its consumer matrix without an upstream build across all required resolver adapters.
- [ ] Production builds are topological and clean; repeated normalized builds/packs have identical file lists and SHA-256 hashes or an approved field-level nondeterminism waiver; bundles, declarations, source maps, and packs are alias-free and checkout-path-free.
- [ ] Packed tarballs pass contents, exports, runtime, type, peer, and local-provenance tests.
- [ ] Opt-in persistent integration reruns use an external cache, reject stale state, avoid clean reinstall when state matches, and retain failed sandboxes.
- [ ] Clean integration mode passes from fresh local tarballs in a clean consumer job or sandbox outside repository ancestry; all non-builtin resolutions remain inside it, the root-only sentinel cannot resolve, and a usable failure bundle is produced when forced to fail.

### CI parity

- [ ] The validated baseline/runtime manifest independently covers every workflow matrix, package/docs/browser command, recursively expanded downstream project/group, integration manifest, and legacy injected edge; every previously green lane exists and passes in its declared source-native environment and final npm equivalent.
- [ ] Every remaining failure has an approved, owned, expiring waiver.
- [ ] Required clean install, static, source test, build, pack, integration/browser/e2e, and docs gates pass.
- [ ] No remote-cache dependency, release, publish, archive, or source-repository mutation occurred.

## 12. Stop and rollback rules

Stop immediately when:

- the exact history toolchain/wrapper digest differs
- a pinned source branch/tag object differs
- tag classification becomes ambiguous
- a target tag/output ref, reserved control/evidence destination, or base source-manifest byte mismatch exists
- a path collision, unmapped current move, or undeclared stale moved-path reference appears
- import verification finds missing/extra refs, topology/metadata drift, or tag-tree drift
- npm requires `--force`/`--legacy-peer-deps`, or an internal edge resolves to a version/path/provenance different from its classification
- a required source baseline cannot be reproduced and lacks an approved waiver
- a clean packed test resolves an intended local package from the registry
- migration requires an unapproved public compatibility or release-policy change

Rollback before cutover is branch deletion: no import tool pushes, publishes, archives, or mutates source repositories. Preserve the manifest, import lock, verification report, compact logs, and failed work/output directories until the failure is understood.

## 13. Official history-import command shape

After `H02` passes, from a clean checkout of the reviewed control branch rooted at the locked target base:

```bash
# H01 has already vendored the exact artifact and generated a wrapper that
# executes that local artifact without network/cache resolution.
EXECUTION_LOCK="$PWD/migration/execution-lock.json"
# Read this from the reviewed H01 handoff/commit evidence; do not derive it from
# the file in the command that the digest is intended to authenticate.
EXECUTION_LOCK_SHA256="<reviewed-execution-lock-sha256>"
IFS=$'\t' read -r FILTER_REPO_ARTIFACT FILTER_REPO_ARTIFACT_SHA FILTER_REPO_WRAPPER FILTER_REPO_WRAPPER_SHA < <(
  node -e 'const x=require(process.argv[1]).toolchain.gitFilterRepo; console.log([x.artifactPath,x.artifactSha256,x.wrapperPath,x.wrapperSha256].join("\t"))' "$EXECUTION_LOCK"
)
test "$(sha256sum "$FILTER_REPO_ARTIFACT" | cut -d' ' -f1)" = "$FILTER_REPO_ARTIFACT_SHA"
test "$(sha256sum "$FILTER_REPO_WRAPPER" | cut -d' ' -f1)" = "$FILTER_REPO_WRAPPER_SHA"

# H01 has already created and retained validated mirrors and bundles. The
# fixture proves that explicit remote, retained-mirror, and locked-bundle modes
# are identical and that only the locked wrapper is executed.
PATH="$(dirname "$FILTER_REPO_WRAPPER"):$PATH" node tools/test-history-migration.mjs

BASE="$(node -e "const x=require(process.argv[1]); process.stdout.write(x.targetBase)" "$EXECUTION_LOCK")"
PATH="$(dirname "$FILTER_REPO_WRAPPER"):$PATH" \
  node tools/import-history.mjs \
  --control-root "$PWD" \
  --manifest "$PWD/migration/sources.json" \
  --execution-lock "$EXECUTION_LOCK" \
  --execution-lock-sha256 "$EXECUTION_LOCK_SHA256" \
  --source-mode remote \
  --base "$BASE" \
  --output ../ui-router-import \
  --workdir "$PWD/.migration-work/import" \
  --keep-workdir

PATH="$(dirname "$FILTER_REPO_WRAPPER"):$PATH" \
  node tools/verify-history.mjs \
  --repo ../ui-router-import \
  --manifest ../ui-router-import/migration/sources.json \
  --execution-lock ../ui-router-import/migration/execution-lock.json \
  --execution-lock-sha256 "$EXECUTION_LOCK_SHA256" \
  --control-root "$PWD" \
  --source-mode remote \
  --report .migration-work/verification.json
```

Repeat into different output/work directories with `--source-mode mirror` and `--source-mode bundle`; the execution lock supplies the exact retained mirror and bundle paths and hashes. Verify each output with the matching mode. All three runs consume the same execution lock and compare identically:

```bash
for candidate in ../ui-router-import-2 ../ui-router-import-3; do
  test "$(git -C ../ui-router-import rev-parse HEAD)" = \
       "$(git -C "$candidate" rev-parse HEAD)"
  diff -u \
    <(git -C ../ui-router-import for-each-ref --format='%(refname) %(objectname)') \
    <(git -C "$candidate" for-each-ref --format='%(refname) %(objectname)')
  for file in sources.json execution-lock.json baselines.json package-classification.json import-lock.json; do
    cmp "../ui-router-import/migration/$file" "$candidate/migration/$file"
  done
  diff -ru ../ui-router-import/migration/evidence "$candidate/migration/evidence"
done
```

Review the output and verification report before any push. Open all migration PRs as drafts.

## 14. Deferred follow-up backlog

After milestone 1:

- modernize and honestly test published Node `engines`
- replace/decompose `@uirouter/publish-scripts`
- choose versioning/changelog/release tooling
- design package publishing provenance and dry-run promotion
- decide remote Turbo cache after deterministic local evidence
- define old-repository archive/read-only/redirect policy
- execute release cutover and rollback rehearsal
