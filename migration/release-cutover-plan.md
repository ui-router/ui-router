# Release and cutover plan (R01)

This is the plan for the release milestone after the monorepo migration. It is deliberately **not** permission to publish packages, create tags or releases, change the old repositories, or alter their permissions. R01 only records what must be decided, checked, and rehearsed before a later execution PR can ask for those permissions.

The exact machine-checked input set is in `migration/release-cutover.json`:

- 12 packages selected by `migration/package-artifacts.json`.
- All 16 migrated source repositories selected by `migration/sources.json`.
- The accepted A01 merge commit and its tree.

## 1. Freeze the candidate and make the release decisions

A later release PR must start from one named, immutable commit. That commit must pass the full Milestone 1 validation, including reproducible package artifacts and the accepted waivers. It must produce a release manifest that says exactly which packages will be released and what version each one will receive.

Before any registry action, maintainers must approve these decisions:

1. The versioning, changelog, and release tooling. R01 does not choose a tool for you.
2. The first-release versions, release notes, stable-versus-prerelease policy, and compatibility statement for every selected package.
3. The Angular/Angular Hybrid lockstep policy. Their relationship is real and must not be left to an accidental publish order.
4. The npm organization, maintainers, 2FA, recovery access, least-privilege publishing credential, and provenance/signing policy.

If any of those is undecided, the release stops. The temporary A01 waivers remain visible release risks; they do not become permission to publish an affected package without an explicit decision.

## 2. Prove the packages before publishing

From a clean checkout of the frozen candidate, the future release process must run the normal build, test, integration, browser, docs, static, reproducibility, and package-artifact checks. It must then pack every selected package twice, verify matching package contracts and hashes, and install representative downstream consumers from those local tarballs.

The future release PR must rehearse its registry commands with dry runs and preserve the output. The rehearsal must prove the intended package name, version, files, metadata, provenance settings, and dependency order. It must not contact production npm in a way that creates a package version or moves a dist-tag.

Any clean consumer that resolves a package from the registry when the test is supposed to use the local tarball is a stop condition. So is an unexplained package-hash difference.

## 3. Publish in small, checked steps

Npm package versions are immutable and publishing many packages is not transactional. The later execution plan must therefore derive an explicit dependency order from the final package graph and publish in that order. After each approved batch it must:

1. Read the published metadata and tarball back from the registry.
2. Verify it against the locally approved package artifact.
3. Run the agreed clean consumer smoke checks.
4. Only then move the agreed dist-tag (for example, `latest`).

The exact batches, dist-tags, success criteria, stop criteria, and the person authorized to promote each batch are decisions for the later execution PR. No package is assumed safe to promote merely because it was uploaded.

Git tags and GitHub releases come after the registry proof for their matching package artifacts. The tag, release notes, published version, and artifact hashes must agree. Keep the original source release history intact; monorepo release tags are new release records, not a rewrite of that history.

## 4. Transition the old repositories last

The original repositories are not changed during R01 or the initial publish step. After the observation window for a stable release, maintainers must make and approve a per-repository choice for every one of the 16 sources: archive, make read-only without archive, or keep it writable for a stated reason.

For each repository, the later execution PR must record the exact user-facing wording and links: where new issues and pull requests belong, where package releases come from, and which historic tags, releases, issues, and source history remain available. It must separately approve any redirect mechanism, because GitHub repository redirects and documentation redirects have different consequences.

Do not delete repositories or their release history. Do not treat a blanket organization-level switch as an approved transition for individual repositories.

## 5. Rehearse rollback before cutover

Before publication, rollback is simple: stop, preserve the candidate, package artifacts, logs, and decision record, then revert or abandon the release branch. Nothing outside the monorepo should have changed.

After publication, rollback means damage control, not erasing history. Do not rely on `npm unpublish`. Stop promotion, restore or remove the affected dist-tag, deprecate the bad version if appropriate, publish a corrected version, and communicate clearly to users. If a source repository transition has already happened, restore the approved archived/read-only/write state using its recorded per-repository procedure.

The later execution plan needs named incident owners, a communications path, and a documented rehearsal of both cases. A failed rehearsal blocks cutover.

## What approval of R01 means

Approving R01 says this planning contract is complete enough to guide a later release proposal. It does **not** approve any future release decision or live action. The five pending decision gates in the contract must be approved with evidence in a separate execution plan before publishing, tagging, releasing, archiving, redirecting, or changing source-repository permissions.
