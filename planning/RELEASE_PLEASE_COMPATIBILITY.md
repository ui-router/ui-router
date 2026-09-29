# Release Please compatibility check

Checked 2026-09-28 against main `6fa0eaeaf` with Release Please 17.11.2,
Node 24.19.0 and npm 11.17.0. No release PRs, tags, GitHub releases or npm
publications were created by these experiments.

Update: further testing found that built-in `extra-files` JSON updates can handle
independent compatible version bumps after the remaining exact example pin is
removed. This supersedes the custom lock-refresh recommendation below; see
[the current setup](RELEASE_PLEASE_SETUP.md#how-the-shared-lock-is-updated).

## Initial results and implementation decisions

- **Independent releases work in the local simulation.** Using the real RP
  Manifest/Node implementation with a read-only in-memory repository adapter,
  a React fix proposed 1.0.9 and an Angular feature proposed 22.1.0 as separate
  PRs. Applying the React proposal and simulating its release left only Angular
  pending. Applying the refreshed Angular proposal preserved React's manifest
  version. Explicit component names and the `@` separator produce `react@1.0.9`.
- **Test-only changes do not propose releases.** A `test:` change inside React
  and a change outside the configured package paths produced no release PRs.
- **The root lock needs npm regeneration.** Native Node updates target
  package-local lockfiles; neither proposal touched the actual root lock.
  Applying both proposals in a disposable copy of the workspace manifests and
  running `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`
  regenerated it successfully. A clean `npm ci --ignore-scripts --no-audit
  --no-fund` then installed 3,915 packages successfully.
- **Updating only lock version fields is insufficient with today's pins.**
  React Hybrid pins React 1.0.8 exactly. After the workspace moved to 1.0.9,
  npm added the published 1.0.8 beneath React Hybrid and adjusted dependency
  metadata. This is valid resolution, but defeats testing against the updated
  local dependency. Make the planned range changes before enabling releases.
  This initially motivated a lock-refresh step. Further testing with compatible
  ranges showed that RP's built-in JSON updater can handle the version-only
  release change; the custom step has been removed.

## Registry baseline

Read public npm metadata for all twelve package names. Each checked-in version
exists on npm and equals its current `latest`. These are last-published
versions, not new release candidates.

| Component | Last published version | Matching namespaced tag in clone |
| --- | --- | --- |
| core | 6.1.2 | yes |
| angular | 22.0.0 | yes |
| angular-hybrid | 22.0.0 | yes |
| angularjs | 1.1.2 | yes |
| react | 1.0.8 | yes |
| react-hybrid | 3.0.0 | missing |
| dsr | 1.2.0 | yes |
| redux | 1.0.0 | yes |
| rx | 1.0.0 | yes |
| sticky-states | 1.5.1 | yes |
| visualizer | 7.2.1 | yes |
| publish-scripts | 2.8.0 | yes |

React Hybrid 3.0.0 must seed its manifest entry even though its latest imported
release tag is 2.0.0. Do not invent a release tag at an unrelated monorepo SHA
or propose 3.0.0 again. The legacy `angular-ui-router` identity still needs its
own registry/trust check before enabling dual publication. Registry state must
be refreshed before activation.

## Initial history still needs review

A second local experiment fed first-parent main commits since history import
`cb80720b8f0ceff309913f00a9dac147fa03752f` into RP, using npm versions as the
baseline and deliberately simulating missing tags. It proposed eight releases,
including React Hybrid 3.1.0 and publish-scripts 2.9.0. Notes included docs/lint
work, React 16 retirement, and candidate tooling that has since been removed.

Those are experimental proposals, not approved next versions. Commit titles
alone cannot produce an accurate initial release summary from the migration
history. Before activating RP, choose a reviewed history boundary and explicitly
carry forward genuine unpublished changes and authored breaking-change notes.
Compare against published package contents where necessary; do not silently
skip pending changes by choosing today's main as the boundary. Verify how the
chosen boundary interacts with existing per-package tags: `bootstrap-sha` alone
is not a universal override for packages whose release tags are already found.

## Limits and next steps

The local experiments executed RP's proposal and updater code; they did not
exercise GitHub API history interpretation, actual PR creation/update, branch
protection, CI triggering, release outputs or OIDC. The disposable harnesses
and installation remain outside the repository; no migration-proof framework
is being introduced. RP action integration must pin and test the actual bundled
RP version rather than assuming it matches this independently installed CLI.

Next, change and test internal dependency ranges. Then implement release-PR
configuration and built-in lock updates with publication disabled, resolve the initial
history boundary, and verify real bot PR behavior. Follow the
[release plan](RELEASE_PLEASE_PLAN.md) for publisher, preview, dry-run and
explicitly approved first-publication work.
