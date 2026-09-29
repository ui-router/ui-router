# Independent package releases with Release Please

Status: proposed implementation plan, 2026-09-28.
Starting point: main at `6fa0eaeaf` (migration cleanup PR #45 merged).

Progress: the [initial compatibility check](RELEASE_PLEASE_COMPATIBILITY.md) passed local independent-release and root-lock regeneration experiments. The dependency-range changes and minimum-version tests landed in PR #47. Draft release-PR automation is now prepared; see [setup instructions](RELEASE_PLEASE_SETUP.md). Initial release notes, live bot behavior, and publication remain to be verified.

## Agreed experience

Use Release Please with a separate release PR for each public package. A maintainer reviews and merges the version/changelog PR when that package is ready. That merge starts a GitHub Actions workflow, which creates the package tag and GitHub release, builds and checks the tagged source, and publishes only the selected package through npm trusted publishing (OIDC).

React can ship while Angular's release PR remains open. Versions and release timing are independent. A GitHub release/tag records the selected source; it does not by itself prove that npm publication succeeded. The workflow summary reports publication separately.

Development stays on `main`. Most releases are stable releases through RP; occasional alpha/beta previews are manually requested from a selected commit on `main`, without a separate development branch or toggling RP configuration. Preview publication shares the stable publisher’s build and package checks.

The chosen npm mode is direct trusted publishing: no npm publishing token, Wombat service, staged npm approval, or interactive npm 2FA in CI. Maintainer accounts retain 2FA. Merging the release PR is the routine approval to publish after automation is enabled.

This document does not enable workflows, change credentials/settings, create release tags, merge PRs, or publish packages. Initial production activation and the first real release still require the maintainer's approval. Subsequent routine release-PR merges intentionally authorize that package's automated publication. Once previews are enabled, an authorized maintainer explicitly dispatching a live preview authorizes that selected preview publication; dry runs never do.

## Scope and existing behavior to preserve

- Keep npm workspaces and Turbo; add Release Please for release coordination.
- Keep all normal CI and package/consumer checks introduced by PR #45.
- Preserve namespaced tags (`core@6.1.3`, for example), package changelogs, and imported history.
- Build Angular and Angular Hybrid from their workspaces and publish their generated `dist` packages. Publish other packages from their existing package roots.
- AngularJS continues publishing both `@uirouter/angularjs` and `angular-ui-router`. Configure and check the two npm identities separately; neither requires a second version bump.
- Keep private examples and isolated compatibility fixtures out of the release inventory.
- No new candidate-proof framework, release evidence snapshots, registry proxy, task runner, or repository transition work.
- Retain the manual release command during rollout as an explicitly documented fallback. Do not run manual version/tag creation and Release Please for the same release. Remove overlapping automation only once the replacement is established.

## Package inventory

Use `tools/packages.json` as the existing source for package paths and publish directories. Release Please's configuration will necessarily list its twelve managed paths; validate agreement rather than introduce another inventory.

| Component/tag prefix | Workspace path | Publish directory |
| --- | --- | --- |
| core | `core` | package root |
| angular | `frameworks/angular/uirouter-angular` | `dist` |
| angular-hybrid | `frameworks/angular-hybrid/uirouter-angular-hybrid` | `dist` |
| angularjs | `frameworks/angularjs/uirouter-angularjs` | package root; legacy-name tarball also |
| react | `frameworks/react/uirouter-react` | package root |
| react-hybrid | `frameworks/react-hybrid/uirouter-react-hybrid` | package root |
| dsr | `plugins/dsr` | package root |
| redux | `plugins/redux` | package root |
| rx | `plugins/rx` | package root |
| sticky-states | `plugins/sticky-states` | package root |
| visualizer | `plugins/visualizer` | package root |
| publish-scripts | `tools/publish-scripts` | package root |

## Release configuration and dependency policy

Use manifest mode, the Node strategy, and `separate-pull-requests: true`. Set explicit component names, `@` tag separators, and no `v` prefix to preserve existing tags. Start without `node-workspace` or linked-version plugins: automatic dependent bumps would undermine independent scheduling.

Conventional commits determine proposed bump types and notes. Maintainers should review squash-merge titles for release-relevant changes (`fix:`, `feat:`, and breaking-change markers), and inspect generated notes before merging. Changes spanning packages may legitimately appear in more than one release PR. Test how shared tooling changes are attributed; shared build-only changes must not implicitly publish every package.

Replace exact production Core dependencies in React and React Hybrid with reviewed semver ranges, preserving the current minimum initially unless testing shows a higher requirement. Audit other exact internal runtime dependencies, especially React Hybrid's React and AngularJS declarations, so they do not silently retain release coupling. Do not automatically change dependency kinds or widen major-version compatibility.

A compatible Core release does not require a framework bump when its declared range already covers that version. A framework adopting a new Core API raises its minimum and waits for that Core version to be published. Core majors require explicit compatibility work. Angular/Angular Hybrid major alignment remains a deliberate maintainer decision, not a rule forcing React to release alongside them.

Keep workspace tests against current source and add targeted consumer checks against the declared supported Core minimum. Local workspace success alone does not establish that a published dependency range is correct. The publish preflight must also reject a required internal minimum that has not reached npm.

## Workflow shape

Proposed file: `.github/workflows/release-please.yml`.

1. A push to `main` runs Release Please. Normal source merges update pending release PRs. Merging a release PR creates that package's tag/GitHub release.
2. Forward package-specific release outputs, including released path, version, tag, and SHA, to a dependent publishing job in the same workflow. Empty output means no publication. Do not scan every unpublished workspace version as a release selector.
3. Validate selected paths against the public package inventory. Check out the exact released SHA, verify manifest/tag agreement, install with the pinned runtime and lifecycle scripts disabled, and run the required build/package tests before publishing.
4. Build any necessary dependencies, but publish only selected packages. Use the existing tarball checks, generated Angular package layouts, and AngularJS legacy-name packaging behavior. Exercise consumer compatibility before the publish step; reuse existing test commands rather than duplicate their implementation.
5. Publish on GitHub-hosted runners using npm OIDC. Limit `id-token: write` to the publishing job and GitHub write permissions to release coordination. Never expose release credentials to arbitrary PR code or use an untrusted `pull_request_target` checkout.
6. Report each npm package/version and publication result in the workflow summary. Stable versions use `latest`; optional previews use an explicit `alpha` or `beta` channel and must never update `latest`.

Serialize release coordination on main without cancelling an in-progress publication. Handle multiple released outputs explicitly and order genuinely dependent selected packages before their consumers; unrelated React/Angular releases must not become a required batch. Do not assume dependent matrix jobs run in dependency order.

Use outputs within the same workflow rather than depending on a second tag-triggered workflow. Resources created with the default GitHub token do not automatically start other Actions workflows.

## Optional previews from trunk

Keep RP responsible for stable release PRs. Provide a small manual preview mode in the same workflow, sharing the existing publisher rather than introducing a second release system. Inputs identify a public package, an immutable commit reachable from `main`, the intended upcoming base version, and `alpha` or `beta`. Resolve and show the exact version/SHA before any live publication; default this mode to a dry run.

Assign a unique prerelease version in the disposable build checkout before building, for example `2.0.0-beta.123`, using a deterministic run identifier. Validate the base version and avoid registry collisions. Keep the committed package versions, root lock, changelogs, and RP stable manifest unchanged. Do not create RP-managed release tags or GitHub releases for these snapshots; record the source SHA, preview version, and package result in the workflow summary and provenance. Preview-specific version/lock adjustments stay in the disposable checkout.

Publish only the selected package, preserving Angular dist and AngularJS dual-name behavior. Dependencies must resolve to already published compatible versions; a preview needing another internal preview must declare that prerelease explicitly in its disposable package metadata. Do not silently publish dependencies or claim a stable dependency range supports unpublished APIs. Start with individually selectable previews; coordinated multi-package preview batches are outside the initial scope.

The stable release later follows the ordinary RP release PR. A preview does not consume the final stable version or advance RP's stable history. Retry a preview with its original package/version/SHA, using the same existing-version and partial-publication checks as stable publishing.

## Validation before live publication

1. Run RP's CLI in dry-run mode to inspect proposed versions, changelogs, and release changes without creating PRs or tags. Use disposable fixtures to exercise separate packages and shared-lock behavior.
2. Build and pack the selected artifacts, inspect contents, install them in existing consumer tests, and run `npm publish --dry-run`. Include stable and preview versions and the special Angular/AngularJS layouts.
3. Exercise workflow selection and failure/retry behavior with publication disabled or mocked. Validate real bot PRs and CI with release creation disabled; simulate merged-release outputs without merging a production release PR merely to test the wiring.

These checks validate release coordination and packaging without uploading an npm version. They do not prove npm will accept the workflow's OIDC identity or that a real registry write succeeds.

After those checks pass, present a useful alpha/beta or the first intended stable release for explicit approval as the first live verification. A prerelease leaves `latest` unchanged and preserves the eventual stable version, but is still a real public npm publication. Do not publish a throwaway version automatically. A live preview validates the shared publisher and that package's npm trust; it does not by itself validate RP's merged-release trigger or every other package's trust configuration.

## GitHub and npm setup

Use a repository-scoped GitHub App for release PR automation so its PR updates trigger normal CI. Confirm whether an appropriate existing app is available before creating one. Grant only the permissions required by the selected Release Please action version. Keep its private key in GitHub secrets; use short-lived installation tokens in Actions. This GitHub credential is separate from npm authentication.

For each public npm identity, configure a trusted publisher for organization `ui-router`, repository `ui-router`, and workflow filename `release-please.yml`, with direct `npm publish` allowed. Include `angular-ui-router`. Any optional environment name must match the workflow exactly. Do not add a second manual approval gate by default: merging the release PR is the chosen approval step.

Check package ownership and repository metadata, and verify the pinned npm CLI supports the selected OIDC flow. Existing accounts keep 2FA. Once the trusted path is verified, review traditional publishing-token access and retire obsolete automation secrets with maintainer approval. New npm package names, if any, need a separate bootstrap decision.

Before activation, inspect main-branch protection/rulesets and who can modify the release workflow. Release PRs must pass CI and be merged by authorized maintainers; do not enable release-PR auto-merge. Settings inspection is part of implementation; changes are presented concretely for maintainer approval.

## First implementation check: root lock and release history

The Node strategy normally updates package-local lockfiles. Our public workspaces share a root `package-lock.json`; do not assume native manifest mode updates it correctly. In a disposable checkout, generate separate React and Angular release proposals and check their diffs and clean installs.

Use RP's built-in `extra-files` JSON updater to change only the selected package's
version entry in the root lock. This replaces the initially proposed custom
lock-refresh step. Compatible patch bumps for all twelve packages were checked
against npm regeneration after loosening the private Angular Hybrid example's Rx
pin. Dependency changes still regenerate the lock in their ordinary code PR;
major releases outside existing ranges need explicit dependency/lock review.
Keep the workspace plugin disabled to avoid automatic dependent bumps.

Confirm that merging one release PR causes the other to refresh cleanly, including the shared Release Please manifest and root lock. Unexpected dependency graph drift must be reviewed before merging.

Bootstrap from actual npm publication state and existing package tags, not blindly from current package.json versions. Some current versions/notes may already be published or may describe pending work. Specifically recheck the previously observed published React Hybrid 3.0.0. Preserve authored breaking-change notes. Choose the initial history boundary deliberately so pending changes are included without replaying the entire imported history. Record the resulting per-package bootstrap choices in the implementation PR.

## Failure and retry behavior

A failed build or test prevents publication. A failed npm publish must be visible even if the GitHub release already exists; never claim the tag means the release is on npm.

Re-running only a failed publishing job should retain its original release selection. Also provide a narrowly scoped manual retry in the same workflow, selecting an existing managed release tag, deriving its package/SHA, and running the same checks. This avoids relying on Release Please emitting `release_created` again after a tag already exists. Retry must not bump versions, retag, or publish arbitrary branch heads.

Check registry state before retrying. Publish only missing package/version identities; if already present, verify their release identity and expected artifact/provenance as appropriate, and report the existing publication. Fail on a conflict rather than silently treating it as success. In an AngularJS partial failure, retry only the missing npm name. Never overwrite a published version or automatically unpublish on failure; fixes receive new versions.

## Delivery sequence and acceptance

1. **Compatibility check and bootstrap design.** Exercise native separate PRs, tag format/history, root-lock updates, and pending React versus Angular using disposable fixtures or local simulations. Resolve the lock approach before implementing production publication.
2. **Dependency ranges.** Make the reviewed Core/internal-range changes with lock regeneration and focused minimum-version consumer tests. Keep these changes separate from workflow behavior for review.
3. **Release PR automation.** Add pinned Release Please configuration, built-in root-lock version updates, and the GitHub App integration. Keep npm publication explicitly disabled while validating real bot PRs and their CI. Creating live release tags remains disabled until the bootstrap is reviewed.
4. **Publisher and recovery.** Implement same-workflow selection, builds/checks, OIDC, legacy dual publishing, retry, and optional manual previews from `main`. Reuse the same publisher. Complete the non-publishing validation above; dry runs do not prove live OIDC authentication.
5. **Activate deliberately.** Present exact npm/GitHub setup and proposed first package/version, choosing a useful preview or the first intended stable release. After maintainer approval, configure trust and enable that first real publication. Verify npm contents/provenance and install the published package. Then enable the remaining configured packages without an extra approval in their routine merge-to-publish flow.
6. **Finish documentation and retire overlaps.** Document the normal release-PR flow, optional previews from trunk, dry-run limits, range changes, failed-publish recovery, and the status of the manual fallback. Update the post-migration program to make this the active P04 release direction.

Required acceptance cases:

- Separate React and Angular release PRs exist; merging React publishes no Angular package.
- Ordinary code merges, docs-only updates, and private example changes do not accidentally publish packages.
- Release PRs have valid shared locks and passing CI at the exact reviewed head.
- Supported Core minimums work; an unpublished required Core minimum blocks a consumer release.
- Angular `dist` publishing and both AngularJS npm identities retain correct names, versions, and package contents.
- A version already published at bootstrap is not selected again as a new release.
- Build failure, publish failure, partial dual publish, existing-version conflict, and retry behave as described.
- Publishing uses the released SHA and intended package selection, without a stored npm write token.
- Preview publication leaves `latest`, committed versions/changelogs, and RP stable tracking unchanged; a later stable proposal still includes the intended changes.
- Preview retries retain the original version/SHA, and unpublished internal dependencies block publication.
- Dry runs create no release PRs/tags or registry uploads; separate bot-PR validation keeps release creation disabled.
- No live npm publish, including alpha/beta, occurs during implementation tests or before activation approval.

## Sources checked during planning

- [Release Please monorepo overview](https://github.com/googleapis/release-please#supporting-monorepos-via-manifest-configuration)
- [Release Please manifest configuration](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md)
- [Action outputs, GitHub credentials, and npm example](https://github.com/googleapis/release-please-action)
- [Node strategy: package-relative lockfile handling](https://github.com/googleapis/release-please/blob/main/src/strategies/node.ts)
- [Package-lock updater](https://github.com/googleapis/release-please/blob/main/src/updaters/node/package-lock-json.ts)
- [RP CLI and dry-run options](https://github.com/googleapis/release-please/blob/main/docs/cli.md)
- [npm publish and dry-run behavior](https://docs.npmjs.com/cli/v11/commands/npm-publish/)
- [npm trusted publishing and direct-publish permissions](https://docs.npmjs.com/trusted-publishers/)

Pin reviewed implementation versions and recheck their behavior during the first compatibility step. This plan records the selected approach; it does not claim that the remaining integration questions have already been tested.
