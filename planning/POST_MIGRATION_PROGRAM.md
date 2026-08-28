# Post-migration engineering program

This is the proposed program after the migration acceptance work.  It is a
planning document: it does not authorize publishing to npm, tagging a release,
changing GitHub or npm settings, or changing the original repositories.

The order is intentional.  We should make ordinary development reliable before
we automate releases, and prove a stable release before pointing users away
from the original repositories.

## Outcomes

1. One maintainable toolchain for tests, browser tests, linting, and shared
   development dependencies.
2. No remaining migration waivers for documentation, React 16, or AngularJS
   linting.
3. A repeatable, audited npm release process with normal and pre-release
   paths.
4. A redesigned documentation site with useful framework guides, tutorials,
   and API reference.
5. A carefully staged transition of the sixteen original repositories after a
   stable monorepo release has proven itself.

## Working rules

- Keep each concern in a small pull request with its own tests.  A browser-test
  migration must not also change release tooling or dependency compatibility.
- Keep the existing source-quality, package, browser, integration, and clean
  reproducibility checks passing throughout.
- Do not widen a peer or runtime dependency merely to make an install pass.
  First prove the wider range with a clean tarball consumer test.
- `syncpack` reports drift in CI; it does not silently rewrite manifests in a
  release job.
- The Angular package may use Angular ESLint where that makes Angular tooling
  work better, but it must still satisfy the common ESLint policy.
- A release workflow does not receive a long-lived npm token.  Live registry
  work remains separately gated by the approved release-execution plan.

## Sequence

| Milestone | Scope | Exit criteria |
| --- | --- | --- |
| P01 | Tooling policy and version convergence | `syncpack` checks the intended groups; Vitest, Playwright, and ESLint policy are explicit and tested. |
| P02 | Replace the remaining Cypress lane | The Angular Hybrid example has equivalent Playwright coverage; no Cypress dependency, configuration, cache, or CI reference remains. |
| P03 | Remove the three migration waivers | Each former failure is a normal passing check with durable proof. |
| P04 | Build the release system | A clean dry run prepares, versions, packs, and installs every release package without contacting production npm. |
| P05 | Documentation specification and prototype | A selected site architecture proves a landing page, a framework guide, TypeDoc API reference, and artifact-based Pages deployment. |
| P06 | First controlled release | A separately approved execution plan passes registry, promotion, and rollback gates. |
| P07 | Transition original repositories | Each of the sixteen repositories has completed its individually approved, post-observation transition. |

P01, P03, and the P05 *specification* can proceed in parallel.  P02 should
follow P01.  P04 should not publish until P01--P03 are complete.  The P05 site
implementation comes after the release system is stable; it can use release
metadata rather than inventing a second release path.

## P01: tooling policy and version convergence

### Add `syncpack`

Add a root-owned `syncpack` configuration and a `syncpack lint` CI command.
It should check, rather than automatically change, these groups:

- Playwright and `@playwright/test`;
- Vitest and its direct companion packages;
- ESLint, `typescript-eslint`, and `@typescript-eslint/*` within each
  compatible ESLint lane;
- TypeScript, build tools, and test-library packages where a shared version is
  actually supported.

The configuration must distinguish *tool versions* from published dependency
ranges.  Peer and runtime ranges are public compatibility promises, so they
must not be forced to a single range simply because they share a package name.
An explicit exception list records framework constraints, including Angular's
Angular-ESLint integration and any legacy lane retained temporarily.

### Choose and apply supported tool lanes

The current repository has several Playwright ranges, Vitest 3 and 4, ESLint
7, 8, and 9, plus a separate Oxc lint command.  The proposed target is:

- Use one tested Playwright line throughout active browser projects.  Update
  the pinned Playwright CI image and browser path in the same pull request, so
  the package and browser are known to match.
- Move packages already using Vitest to one tested Vitest 4 line.  Do not
  replace AngularJS's legacy Jest lane as collateral work; make that a later,
  separately tested modernization decision.
- Make ESLint 9 plus `typescript-eslint` 8 the common rule-engine baseline.
  Angular continues to use the Angular ESLint packages on that baseline.
  Migrate the Redux Oxc-only check to the shared ESLint command or document it
  as an additional fast check; it must not be the only lint policy.

P01 passes only when every relevant workspace runs the policy through Turbo,
`syncpack lint` has no unexplained mismatch, and the normal CI matrix passes.

## P02: Cypress to Playwright

Only the Angular Hybrid `examples/example` lane still directly uses
`@uirouter/cypress-runner`.  Port its user-visible flows to
`@playwright/test`, using the same build and served application that Cypress
used.  Keep the Cypress test as a temporary comparison only; once Playwright
is reliable in local and CI runs, delete the Cypress test/configuration,
dependency, setup command, cache setting, failure-artifact glob, and lockfile
entries.

Acceptance requires a clean browser run, a failed-test artifact check, and no
remaining executable Cypress reference.  It does not require rewriting the
already-working Playwright projects.

## P03: remove the existing waivers

| Waiver | Work | Proof required |
| --- | --- | --- |
| Docs source container (expires 2026-09-30) | Replace the mutable source-docs container assumption with a deterministic, digest-pinned build or a checked Node-only build.  This is containment of the old docs lanes, not the full documentation redesign. | The four former source-docs commands run with a declared, immutable toolchain and no waiver. |
| React 16 peer range (expires 2026-10-31) | Exercise the React 16 Hybrid tarball consumer.  If the code is compatible, widen `@uirouter/react` only to the tested React 16.8+ range and retain the React 17--19 coverage. | A clean npm install without `--legacy-peer-deps`, plus the React 16 browser/type/runtime consumer test. |
| AngularJS ESLint root resolution (expires 2026-10-31) | Make the AngularJS lint lane resolve its declared tooling locally and consistently, then modernize its configuration only as far as the test proves safe. | The AngularJS lint command works from an isolated clean workspace without relying on a hoisted root copy. |

Each successful item removes its waiver, updates the appropriate migration
contract/evidence, and adds the passing command to the regular CI gate.

## P04: release and publish system

### Proposed release tool: Changesets

Use Changesets as the release-intent and versioning tool.  It is designed for
multi-package repositories, supports package groups and prereleases, and lets
us supply a custom changelog writer.  The recommended configuration will use a
fixed group for `@uirouter/angular` and `@uirouter/angular-hybrid`, plus a
repository validator that requires both package majors to equal the supported
Angular major.  A future Angular 23 update therefore cannot publish either
package on a mismatched major line.

Changesets is preferable here to Release Please because the immediate problem
is independently releasable packages with a small lock-step group, not a
single repository release PR.  This is still a proposed decision until the
release design review approves it.

### Changelogs and dependency ranges

Generate a per-package changelog from authored changesets.  Group internal
dependency moves in a short **Dependencies** section so users see relevant
compatibility information without a generated entry for every transitive
release.  Do not loosen top-level dependency or peer ranges merely to make the
changelog quieter.  A range changes only after its clean-consumer compatibility
matrix proves it.

### Workflows

Create two workflows, both starting with the existing full validation and
package/consumer proofs:

1. **Release preparation** validates changesets, the version plan, the
   Angular lock-step rule, package order, reproducible packs, and a local
   tarball consumer dry run.  It creates no npm or GitHub release.
2. **Release publish** is a protected `workflow_dispatch` for an immutable
   release commit.  It repeats the checks, publishes in dependency order,
   reads every tarball back from npm, runs selected consumers, then promotes
   the agreed dist-tag.  Git tags and GitHub releases happen only after that
   registry proof.

Use npm trusted publishing: the workflow receives a short-lived GitHub OIDC
identity with `id-token: write`, and npm accepts it for the configured publish
workflow.  It stores no npm automation token.  Configure an npm trusted
publisher for each public package and a protected GitHub `npm-publish`
environment.  The remaining governance decision is the exact GitHub team or
environment rule that lets any intended UI-Router organization maintainer
start a release while preserving an audit trail.

Support release candidates using a Changesets prerelease mode and the `next`
dist-tag.  Stable releases use `latest` only after consumer verification.  The
first implementation does not add unattended snapshot publishing; we can add
that later if release-candidate use proves too heavy.

P04 is complete when a non-production dry run produces the exact version plan,
changelogs, packages, dependency order, provenance configuration, and consumer
evidence.  Publishing, tag creation, and npm/GitHub configuration require the
separate P06 execution approval already required by R01.

## P05: documentation workstream

The accompanying [documentation specification](DOCUMENTATION_SPEC.md) starts
with content inventory and a small architecture prototype.  It deliberately
keeps the old sites live until their replacements have content and link parity.

## P06 and P07: release observation and repository transition

P06 satisfies all five existing R01 decision gates: release policy,
registry/provenance access, publish order and promotion, rollback rehearsal,
and source-repository transition plan.  No production action is implied by
this document.

After a stable release's agreed observation window, P07 handles the original
repositories.  For every source repository, record its final state (archive,
read-only, or retained write access), its new-issue and new-PR link, its
release/history preservation check, and its redirect wording.  Apply those
sixteen changes one by one under explicit maintainer approval; never delete
history or rely on an organization-wide blanket switch.

## Immediate implementation order

1. Land P01's inventory-backed `syncpack` policy and the version-convergence
   proposal, without upgrading tools blindly.
2. Land P03's React 16 and AngularJS fixes in separate pull requests.
3. Land the deterministic containment for the September documentation waiver.
4. Port the single remaining Cypress lane after the Playwright baseline is
   settled.
5. Turn the proposed P04 design into a release-execution specification and
   dry-run-only workflows for maintainer approval.
