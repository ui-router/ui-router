# Set up draft release PRs

This step lets Release Please open and update a separate **draft** PR for each
package. It does not create tags, GitHub releases, or npm publications. The
workflow stays off until `RELEASE_PLEASE_ENABLED` is set to `true`.

## Create the GitHub App

Create a GitHub App from your account or the ui-router organization's developer
settings. Give it a recognizable name, such as UI-Router Releases (names must be
available), and use the repository URL as its homepage. Disable webhooks; this
app only needs to act when our GitHub workflow requests a token.

Grant these repository permissions:

| Permission | Access | Purpose |
| --- | --- | --- |
| Contents | Read and write | Update the bot's release branches |
| Pull requests | Read and write | Open and update release PRs |
| Issues | Read and write | Apply the release labels |
| Metadata | Read | GitHub's required default |

No organization permissions or event subscriptions are needed. Install the app
on **only `ui-router/ui-router`**. Generate a private key, then add these values
under the repository's Settings → Secrets and variables → Actions:

- Variable `RELEASE_PLEASE_APP_ID`: the app's numeric App ID, not its installation ID.
- Secret `RELEASE_PLEASE_APP_PRIVATE_KEY`: the complete downloaded PEM private key.

Do not put the private key in Git or paste it into a PR or chat. No npm token is
needed for this step.

After this workflow PR is merged and the app is installed, set the repository
variable `RELEASE_PLEASE_ENABLED` to `true` and manually run **Release proposals**
on `main`. Future pushes to main will update the proposals automatically.
Creating the app and enabling the bot are maintainer setup actions; this PR does
not change external settings.

## Review the first proposals

The manifest starts at the twelve versions already published on npm, including
React Hybrid 3.0.0 despite its missing imported tag. The temporary
`last-release-sha` is the history-import merge
`cb80720b8f0ceff309913f00a9dac147fa03752f`. This deliberately includes subsequent
migration changes for review; it is not a claim that all of them belong in the
next release notes. Using `bootstrap-sha` alone would not reliably limit packages
whose old release tags can already be found.

A read-only run of the exact library bundled in our pinned action (Release Please
17.3.0) against GitHub main at `d1d9d5422` generated eight separate draft proposals:
Core 6.1.3, Angular 22.0.1, AngularJS 1.2.0, React 1.0.9, React Hybrid 3.1.0,
DSR 1.3.0, Sticky States 1.6.0, and Publish Scripts 2.9.0. These are automatic
suggestions, **not approved release versions**. They include old tooling changes
and a React 16 retirement note that need comparison with what was already
published. We have not edited existing authored changelogs.

Check the proposed versions and notes, then confirm:

- Each PR changes only its package release files plus the shared manifest/lock.
- Each PR updates its package version in the root lock, without changing other packages' versions.
- The app's PR updates trigger CI, and the final PR head passes the checks.

Keep these draft proposals unmerged during setup. Before enabling real releases,
review genuine unpublished changes, preserve authored breaking-change notes, and
resolve the initial history boundary and notes. Remove the temporary
`last-release-sha` once the first real release establishes the normal history
boundary; leaving it indefinitely would eventually truncate valid history.
Change the setup-only draft/header settings as part of that reviewed activation.

## How the shared lock is updated

Each package's `extra-files` setting tells Release Please to update that package's
version field in the root `package-lock.json`. This is a built-in JSON updater:
there is no follow-up script, npm install, or extra bot commit. Independent PRs
change independent version fields. The workspace plugin is not enabled, so a
compatible dependency release does not automatically bump its consumers.

Dependency changes still need npm lock regeneration in the ordinary code PR
that changes them. The release PR then updates only the package version. Keep
internal workspace dependencies on compatible ranges, including private examples;
an exact pin could cause npm to resolve an older registry copy after a local bump.
A major release outside an existing range needs explicit dependency review and
lock regeneration before merging the release PR.

The configuration was tested with Release Please 17.3.0 by generating independent
patch releases for all twelve packages, then comparing each lock with npm's own
regeneration. The Angular Hybrid example's remaining exact Rx pin was changed to
`^1.0.0` so an Rx patch does not change dependency resolution. Separate React and
Angular proposals also kept their lock updates independent.

## What remains before publishing

The npm publisher and optional previews come in the next change. npm trust is
configured separately for each package when we are ready to test a real publish.
The first live publication still needs explicit approval.

At setup inspection, the repository's UIRouter ruleset was disabled and main had
no classic branch protection. Before live publishing, agree on and enable the
intended maintainer/CI merge rules; this change does not modify them.

Local checks cover the package configuration, built-in JSON lock updates compared
with npm regeneration, action syntax, and read-only RP proposals from actual
GitHub history. Creating app-authored PRs and confirming their CI requires the app
setup above and remains to be tested.

References: [Release Please action](https://github.com/googleapis/release-please-action),
[GitHub App tokens](https://github.com/actions/create-github-app-token),
[manifest configuration](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md).
