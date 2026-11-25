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

The manifest starts at the twelve versions already published on npm. Each version
has a matching namespaced tag. Release Please uses those tags as its release
boundaries, with no shared `last-release-sha` or `bootstrap-sha` override.
`commit-search-depth` is 5,000 because the oldest baseline tags are about 4,000
commits back in the combined repository history, beyond the default 500.
The initial history scan can require thousands of read requests. The job has a
55-minute limit, within the App token's one-hour lifetime. Hosted execution time
still needs validation when proposals are enabled; credential setup does not
enable the workflow.

The late upstream React Hybrid 3.0.0 history is restored separately in
[PR #49](https://github.com/ui-router/ui-router/pull/49), which includes its tag
provenance and validation. Merge #49 with a normal merge commit before #48 so
`react-hybrid@3.0.0` is reachable from `main`. PR #48 contains release tooling;
the imported commits and ancestry merge belong only to #49.

Before the tag restoration, a read-only run of the exact library bundled in our
pinned action (Release Please 17.3.0) against GitHub main at `d1d9d5422` generated
eight separate draft proposals:
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
compare the proposed notes with genuine unpublished changes and already published
packages, preserving authored breaking-change notes. Change the
setup-only draft/header settings as part of that reviewed activation.

With #49's restored ancestry, Release Please 17.3.0 resolves all twelve baseline
tags, including the restored 3.0.0 tag. A local full-history simulation builds
twelve draft proposals without the shared cutoff. A 500-commit simulation
produces different notes and versions, so it is not a substitute for the full
search. These remain unapproved proposals.
The read-only GitHub-backed full-history preview hit a gateway timeout; hosted
generation and actual App authentication still need validation while publishing
remains disabled. None of these checks enabled the bot or created release PRs.

### Imported empty commits and package attribution

The first hosted run on November 24 succeeded in 28 minutes and opened twelve
draft PRs (#50–#61). App authentication, branch writes, labels and PR-triggered CI
worked. The proposals exposed an attribution issue: some imported commits have
the same tree as their parent, so GitHub correctly reports no changed files.
Release Please 17.3.0 intentionally applies empty commits to every package. For
example, the empty imported Angular 9–10 commit `8a2d6500` appeared in React's
notes and incorrectly caused a major bump. Empty DSR and Visualizer commits also
appeared in unrelated proposals.

The explicit top-level `"exclude-paths": []` enables Release Please 17.3.0's
per-package path filter. With no exclusion patterns it retains every commit that
touches a file in that package, while discarding commits with no matching files.
Filtering runs after release-tag boundary detection, so empty tagged commits
still serve as boundaries. No commits or tags are rewritten, and no shared
history cutoff or forced release version is added.

This is version-specific behavior of the pinned library, rather than a dedicated
`include-empty` configuration option. CI exercises the actual 17.3.0 manifest
implementation with empty imported commits, empty `Release-As` commits, genuine
breaking changes, multi-package changes and distinct empty tag boundaries. Keep
those tests passing when changing the runner/library version. An intentional
release instruction must change a file in its package; empty commits no longer
request releases for every package.

A full 5,000-commit simulation with this filter proposes Core 6.1.3, Angular
22.0.1, AngularJS 1.2.0, React 1.0.9, React Hybrid 3.1.0, DSR 1.3.0, Redux 1.1.0,
Sticky States 1.6.0 and Publish Scripts 2.9.0. Angular Hybrid, Rx and Visualizer
have no remaining release candidates. These versions and notes still need
maintainer review, especially React Hybrid's React 16 retirement. Other notes
reflect real changes to package tooling or examples rather than routing APIs;
this filter addresses incorrect package attribution, not editorial release-note
selection.

Keep all existing release PRs as drafts while reviewing this correction. Once it
lands on `main`, the bot can refresh the nine remaining proposals. Release Please
does not automatically close old proposals that no longer have a candidate, so
the Angular Hybrid, Rx and Visualizer drafts require separate cleanup.

To run the library regression checks locally without changing workspace
dependencies (use the repository's pinned Node/npm versions):

```sh
npm ci --prefix .github/release-please --ignore-scripts --no-audit --no-fund
NODE_PATH="$PWD/.github/release-please/node_modules" node --test tools/test-release-please.mjs tools/test-release-please-history.mjs tools/test-release-please-http.mjs
```

### GitHub API failures during the initial history scan

After #62 merged, the first scan failed on a GitHub REST commit request after
about three minutes. That same request succeeded when checked directly. One job
retry passed that commit and failed on another commit read after seven minutes,
with an empty error message. Thousands of file-list requests make a full job
restart an unreliable recovery strategy; the 55-minute job limit was not the
failure in either attempt.

The workflow now runs the same Release Please 17.3.0 library through
`.github/release-please/run.mjs`, using its supported custom-fetch hook. The
isolated package and lockfile pin the runtime dependencies without adding them
to the public workspaces. Installation finishes before minting the App token.

The fetch wrapper retries transient GitHub GET and GraphQL query failures at the
failed request, with at most three retries and exponential backoff. HTTP 408,
500, 502, 503 and 504 and recognized connection errors are retryable. GitHub also
returns HTTP 422 for a commit-generation timeout: only a GET commit response with
the exact `The request is taking too long to generate.` message gets that
exception; ordinary 422 validation errors are not retried. Rate-limit
responses respect `Retry-After` and primary quota reset headers; waits beyond one
minute fail visibly so a long pause does not consume the App token's lifetime.
Authentication/validation failures, mutations and other write requests are not
retried. Logs include the HTTP status and endpoint path without request headers,
query strings or response bodies, including when GitHub returns an empty error.

The runner validates separate draft proposals for every package and calls only
`createPullRequests()`. It has no release-creation call. The main-branch/enable
guard, App permissions, full 5,000-commit search, attribution filter, 55-minute
limit and disabled publication policy remain in place. Tests exercise actual
library pagination through a failed commit page, retry exhaustion, rate limits,
connection resets, GraphQL queries versus mutations, and draft-only execution.

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
