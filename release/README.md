# Release candidate validation

Local preparation writes draft versions, internal dependencies, changelogs,
and the root lock. Record its full `sourceCommit` from the preparation preview.
After preparing, use that immutable commit as the validation base:

```sh
node tools/prepare-release-validation.mjs --base <full-source-commit> --package @uirouter/core
node tools/prepare-release-validation.mjs --base <full-source-commit> --package @uirouter/core --write
```

The first command previews `release/version-plan.json`; the second writes it.
Review and commit this file with the prepared manifests and release notes.
Generating a plan does not approve a release, refresh proofs, or publish.
No candidate version plan is checked in with the tooling implementation.

Pass the selected package from the preparation preview with `--package`; repeat
the option for multiple selections. Changed packages and exact dependents are
included automatically. Explicit selection also records a release whose version
is already assigned and whose dependencies did not change, such as React Hybrid
3.0.0 prepared with `--bump none`. A selected version must not already have a
release tag and must be newer than its latest ancestral release. Imported release
records still count if a tag is missing locally; fetch the complete release tags
before preparing a candidate.

The plan lists package versions and exact internal dependency changes. It binds
the unchanged migration classification and path map to an ancestor commit.
Current manifest, internal-dependency, lock, and package-artifact validators
automatically use this plan when present. Without it, the existing accepted
version checks still apply.

Validation checks every classified manifest and the entire root lock against
the base plus the listed changes. It permits compatible ranges to remain
unchanged and exact internal versions to advance within the same major.
Dependent published packages must be listed, including an already assigned
unreleased version. Angular and Angular Hybrid must advance together and
retain their supported Angular major. Changes to compatibility ranges, external
dependencies, scripts, engines, package names, or isolated fixtures require
separate engineering review before preparation; this plan cannot authorize them.

Keep the same base when revising a draft plan. Every published package's starting
version must match the commit named by `release/version-baseline.json`, including
packages with no incoming workspace edges. Workspace ranges must still match
`migration/package-classification.json`. The preparation base may include later
engineering work, but cannot be an already versioned candidate. The plan binds
the release baseline and source/tag mapping as well as the migration inputs.
Subsequent release cycles require a separately reviewed baseline update; the
generator never advances it or repurposes the immutable migration contracts.

Historical N02/N03 evidence and isolated registry baselines remain unchanged.
The effective workspace versions exist only in memory during validation.
Refreshing current validation bindings is still necessary for a candidate,
but old package and consumer evidence must fail until regenerated from that
candidate. Commit implementation before recording clean consumer evidence.
Package proofs also bind the exact version-plan digest, so selecting an already
assigned version cannot reuse old proof just because the manifests stayed equal.

The adversarial suites retain Git history when testing a candidate. Manifest and
lock mutations may be rejected first by the version plan; the suites check that
specific failure instead of bypassing the plan to reach a later validator.

Next, regenerate the package and isolated-consumer proofs and rehearse the
registry sequence, including both `@uirouter/angularjs` and `angular-ui-router`.
Merging, registry publishing, tags/releases, and repository transitions still
require the maintainer's separate approval.


## Local registry rehearsal prepared after PR #41

PR #41 merged at `760513abef094c79840fb24d3cf6bb5dfc8ba70b`.
The completed disposable candidate is retained on local branch
`codex/post-merge-candidate-proof` at `6dee99d39`. Package inputs were proven
at `3847d6a48315ef791867b04e26b6fcb15ca9270c`; all thirteen isolated consumers,
including nine browser projects, passed. This is not a production selection.

The next bounded execution is a disposable Verdaccio 6.10.4 registry on
`http://127.0.0.1:4873/`, with `uplinks: {}` and no package proxy rules.
[Verdaccio configuration](https://www.verdaccio.org/docs/configuration/)
documents the listener, storage, and uplink settings. Keep its installation,
lockfile, storage, npm configuration, and credentials outside the repository.
The prepared local directory is `/tmp/ui-router-registry-lab`; its exact registry
installation is recorded in `package-lock.json`. These temporary files are
conveniences, not durable dependencies of the repository.

Prepared publication inputs (publish Core and scoped AngularJS before React Hybrid):

| Name | Rehearsal version | SHA-256 |
| --- | --- | --- |
| `@uirouter/core` | 6.1.3 | `dbbf71a3fe4a438b718e0e7ebaa9244534d3cd63f3d82b5feb1765af94b3b638` |
| `@uirouter/react` | 1.0.9 | `c5ffa71c8517e58e27a6b8e7acc0d8cc60e544e3d1ebaffb565d0222d316b602` |
| `@uirouter/react-hybrid` | 3.0.1 | `f20abb1be6af2e69960407d7113087261652416ff56f98442ec4b3b82b46526f` |
| `@uirouter/angularjs` | 1.1.2 | `889f8455798145c70edc6c899e3e33c3d100b7af5f59eed10aafbcb6a8050b23` |
| `angular-ui-router` | 1.1.2 | `aa93f5e8c83325e5e71ed305558eedbbfbd07b476b33602f02fa1efa1468910d` |

The AngularJS pair exercises the existing accepted 1.1.2 artifact only in the
empty test registry; it does not propose republishing that version to npm.
Create the alternate-name tarball by extracting the accepted scoped artifact
into a disposable directory, changing only `package.json.name`, and running
`npm pack --ignore-scripts`. Assert identical member inventories, byte-identical
non-manifest files, and manifest semantic equality after restoring the name.
The prepared pair passed this comparison for all 122 files. Do not invoke the
legacy script: it edits the source manifest, assumes `master`, and publishes
without an explicit registry argument.

### Execution after maintainer approval

1. Recheck the registry listener, disabled uplinks, empty package storage, and
   every input digest. Run npm from the disposable directory with an isolated
   user config, global config `/dev/null`, empty dedicated cache, and an explicit
   loopback registry. Remove inherited npm/auth environment configuration.
   Reject tarballs with a non-loopback `publishConfig.registry`. Use disposable
   local credentials only. Lifecycle scripts and provenance are disabled.
2. Publish each exact tarball under the `rehearsal` dist-tag. Download each
   registry tarball and compare its bytes and integrity with the approved input;
   verify its name, version, dependency metadata, and tag. Reject any returned
   tarball URL outside the local registry before downloading it.
3. Pause after the scoped AngularJS upload to simulate partial completion.
   Confirm the legacy name is absent and no package has a `latest` tag. Resume
   by verifying the scoped artifact and uploading only the missing legacy name.
   Refuse to skip an existing version if its downloaded bytes differ. Confirm a
   repeat publication cannot replace an existing version.
4. Seed the exact external dependency closure from the proven consumer lock
   into the test registry, recording original integrities and read-only source
   downloads. Keep upstream forwarding disabled. Install the published packages
   into fresh consumer directories with empty caches. Exercise both AngularJS
   names separately with the same Angular/browser smoke checks and Core version;
   check the React dependency chain too. Do not weaken peer ranges or use
   `--legacy-peer-deps` to get an install to pass.
5. Only after readback and consumers pass, rehearse promotion to a local
   `candidate` tag. Simulate a stop by removing that tag, retain immutable
   versions, then restore it after verification. Do not depend on unpublishing.
   Record partial-failure state, resume decisions, commands, tarball digests,
   registry metadata, consumer outcomes, and tag transitions.
6. Stop the registry after recording results. Preserve diagnostics and lockfiles.
   This proves registry mechanics; integration into the normal local release
   command, real npm login/2FA, production provenance, and R01 production gates
   remain later work. No Git release tags, GitHub releases, or production writes
   are part of this rehearsal.

Preparation includes a registry health check, artifact parity checks, and five
`npm publish --dry-run --ignore-scripts --tag rehearsal` previews directed to
loopback. It does not upload packages or change registry tags. The maintainer's
standing instruction requires separate approval for the actual uploads and tag
changes, including this local rehearsal.


### Completed local rehearsal

The maintainer approved localhost execution after reviewing this plan.
[`local-registry-rehearsal.json`](local-registry-rehearsal.json) records the
results, exact input/readback hashes, external seed integrities, consumer locks,
and tag transitions. All five tarballs read back byte-for-byte. A deliberately
unavailable loopback endpoint interrupted the legacy AngularJS upload; retry
verified the scoped package and filled the missing legacy package. Duplicate
publication failed, and the readback guard rejected a changed-byte input.

Ten external dependency tarballs were fetched read-only from their proven lock
URLs, integrity-checked, and seeded locally. Three empty-cache consumers installed
entirely from localhost with peer resolution enabled. Both AngularJS names and
React Hybrid passed browser route rendering, navigation away and back, and an
uncaught-error check. Browser bundles used only each consumer's installed inputs.
All five `candidate` tags were added, removed, and restored with artifact hashes
unchanged. The registry was then stopped; diagnostics remain outside the repo.

**Limitation:** this Verdaccio version synthesizes `latest` for a first version,
even after removing that tag. The planned absence-of-`latest` check therefore
failed and is not an accepted result. The separate `candidate` tag recovery
passed. A production-like existing-version/tag fixture and subsequent real npm
verification are still needed before claiming production promotion parity.

Next, adapt the existing local release entry point to consume verified artifacts
and use explicit registry/dependency ordering, resumable readback, and the tested
AngularJS name conversion. Resolve the promotion limitation before completing
P04. Real npm authentication/2FA, provenance and corrective-release behavior
remain untested. This manual rehearsal is not a complete automated publish path.

## Rehearse through the existing release command

From a clean committed checkout with fresh package proof and staged artifacts:

```sh
npm run release --workspace=@uirouter/react-hybrid -- --rehearse \
  --artifacts .ci-artifacts/release-rehearsal \
  --registry http://127.0.0.1:4873/ --legacy-angularjs --dry-run
```

Remove `--dry-run` after reviewing the package list to upload to the explicitly
selected local registry. The command includes staged internal dependencies and
peers in dependency order. `--legacy-angularjs` also creates and verifies the
alternate AngularJS tarball. All inputs must match the current committed package
proof and staging manifest; stale or dirty inputs stop before publication.

The dry run reads local evidence only. Execution copies the verified inputs to
a temporary directory, isolates npm configuration/cache, disables lifecycle
scripts and provenance, and publishes under `rehearsal`. It accepts only an HTTP
registry at the literal address `127.0.0.1` with an explicit port. Registry
redirects and tarball downloads to another origin are rejected. This mode uses
disposable local-registry access, not maintainer credentials.

On retry, identical existing versions are verified and skipped; different bytes
or metadata stop the operation. A failure may leave earlier packages published:
rerun the same command after resolving it. Progress is written to stderr and a
successful result is JSON on stdout. No tag promotion, version preparation,
Git commits/tags/pushes, or production publication is performed. External
consumer dependencies must be separately seeded into an offline test registry.
The manual rehearsal's Verdaccio `latest` limitation still applies.
