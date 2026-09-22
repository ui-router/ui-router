# Post-migration engineering program

This is the proposed program after the migration acceptance work.  It is a
planning document: it does not authorize publishing to npm, tagging a release,
changing GitHub or npm settings, or changing the original repositories.

The order is intentional.  We should make ordinary development reliable before
we automate releases, and prove a stable release before pointing users away
from the original repositories.

## Checkpoint: 2026-09-22

The repository migration (milestone A01) is accepted. The post-migration
program below is still in progress. Current main is
`cc12c449a17ba4487dc7ae312ff3626126b45c2e` after PR #37.

- **P01 partial:** PR #31 introduced syncpack and aligned Vitest; PR #35 added
  ESLint to Redux while retaining Oxc; PR #36 migrated AngularJS to ESLint 9
  and typescript-eslint 8. Remaining ESLint declarations, Playwright
  convergence, and explicit policy
  groups/exceptions for other compatible tools remain.
- **P02 pending:** the Angular Hybrid example still needs its Cypress-to-
  Playwright migration and removal of active Cypress tooling.
- **P03 complete:** React 16 retirement (#32), restored AngularJS lint (#33),
  and deterministic local TypeDoc builds (#34) are merged. These are normal
  checks rather than active migration waivers.
- **P04 partial:** PR #37 added a safe release preview. Draft PR #40 implements
  local version/changelog/root-lock preparation; its twelve CI checks passed
  at `2c3ce221acbedfff78f30c54fb14c0cbf80a1bad`. It is not merged. Release-aware
  validation is next, followed by publishing rehearsal, authentication, and
  live publishing.
- **P05 specification only:** `DOCUMENTATION_SPEC.md` exists; content inventory,
  generator comparison, prototype, and site implementation remain.
- **P06/P07 pending:** production release and source-repository transitions
  remain separately authorized future work.

A01 retains its recorded historical-input exception: the sixteen source
checkouts were verified when the original import archives/tooling inputs were
unavailable. This does not claim byte-identical reproduction of the original
history import; see `migration/milestone-acceptance.json` on main.

### Engineering handoff: release preparation

The pushed branch is `codex/local-release-preparation` in
[PR #40](https://github.com/ui-router/ui-router/pull/40). Implementation commit
`addfd53ea4e5bd9b66db67f35eb66a7a4b37487d` is followed by clean consumer evidence
at `2c3ce221acbedfff78f30c54fb14c0cbf80a1bad`. This handoff only updates the plan;
it does not change release code, package versions, or recorded proofs.

Completed validation for that implementation:

- `node --test tools/test-local-release.mjs`: eight tests passed, including
  dependency/version planning, offline lock installation, refusal before writes,
  rollback after a write failure, Angular coordination, and AngularJS dual names.
- All twelve package-directory commands
  `npm run --silent release -- --prepare --dry-run --bump patch` passed.
- A disposable real-monorepo preparation advanced Core to 6.1.3 and React to
  1.0.9, retained the already assigned React Hybrid 3.0.0 and its breaking-change
  notes, and produced a lock accepted unchanged by
  `npm install --package-lock-only --ignore-scripts --no-audit --no-fund --offline`.
  Those candidate versions were not applied to this implementation branch.
- `node tools/test-ci-gates.mjs`: 74 cases passed.
- `npm run prove:package-artifacts -- --write`: twelve packages, 1,062 built
  files, fifteen edges, 443 consumer records, 46 entry points, two repetitions.
- `node tools/verify-npm-locks.mjs` passed in a clean checkout.
- `node tools/stage-ci-package-artifacts.mjs --output .ci-artifacts/local-release-preparation`,
  then `node tools/run-integration-matrix.mjs --mode clean --retain --write --artifacts .ci-artifacts/local-release-preparation --output .migration-work/i02/local-release-preparation`:
  thirteen projects passed, zero waivers, 32 edges, nine browser projects.
- After `npm run clean --workspace=@uirouter/angular --workspace=@uirouter/angular-hybrid`,
  `npm run check:static:installed` passed. Cleaning removes build-generated
  manifests that would otherwise affect static manifest enumeration.
- [CI](https://github.com/ui-router/ui-router/actions/runs/35552595181) and
  [clean reproducibility](https://github.com/ui-router/ui-router/actions/runs/35552595183)
  passed at the evidence commit above. Recheck the latest PR head before merging.

The next release task is to make current validation accept a reviewed version
plan while preserving immutable migration evidence. Inspect
`tools/verify-manifest-normalization.mjs`, `tools/verify-internal-deps.mjs`, and
their use of `migration/package-classification.json`. Refreshing validation
bindings alone does not resolve their accepted-version/range checks. Do not
rewrite historical contracts or reuse old artifact proofs for a new candidate.
Then regenerate candidate proofs and rehearse both AngularJS npm names against
a non-production registry. Individual npm authentication and the live publish
path follow; production publishing remains separately authorized under R01.

Use a normal merge for PR #40 so its recorded implementation commit remains in
ancestry. Preserve the local checkout's work when resuming, fetch current refs,
and check whether PR #40 has merged before choosing a branch. Do not rerun the
entire proof suite solely because the work moved to another machine.

### Maintainer direction: eventual Oxlint migration

The agreed final lint target is **Oxlint across the monorepo**. Finish the
bounded ESLint alignment of existing lint lanes first, then migrate them
coherently to Oxlint. Avoid adding extensive new ESLint coverage to packages
that currently have no lint task merely to replace it in the next phase.

The Oxlint follow-up must inventory existing rules and file coverage, prove
which rules have equivalents, and document any temporary ESLint exceptions
for remaining gaps. Expand lint coverage as part of that coordinated work.
Keep equivalent checks and failure behavior throughout; do not silently drop
rules to make the migration pass. This follow-up is additional work, not a
claim that P01 makes ESLint the permanent target.

## Outcomes

1. One maintainable toolchain for tests, browser tests, linting, and shared
   development dependencies.
2. No remaining migration waivers for documentation or AngularJS linting, and
   no unsupported React 16 compatibility claim.
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
- Local releases use the individual maintainer's npm authentication. Keep
  credentials outside the repository. Future GitHub Actions publishing is a
  separate workstream; live registry work remains gated by the approved
  release-execution plan.

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

At program drafting, the repository had several Playwright ranges, Vitest 3
and 4, ESLint 7, 8, and 9, plus a separate Oxc lint command. The interim target
is (see the checkpoint above for completed work):

- Use one tested Playwright line throughout active browser projects.  Update
  the pinned Playwright CI image and browser path in the same pull request, so
  the package and browser are known to match.
- Move packages already using Vitest to one tested Vitest 4 line.  Do not
  replace AngularJS's legacy Jest lane as collateral work; make that a later,
  separately tested modernization decision.
- Make ESLint 9 plus `typescript-eslint` 8 the interim baseline for existing
  lint lanes, before the coordinated Oxlint follow-up.
  Angular continues to use the Angular ESLint packages on that baseline.
  Migrate the Redux Oxc-only check to the shared ESLint command or document it
  as an additional fast check; it must not be the only lint policy.

P01 passes only when every existing applicable lint/test workspace runs the
policy through Turbo, `syncpack lint` has no unexplained mismatch, and the
normal CI matrix passes. New lint coverage belongs to the coordinated Oxlint
follow-up rather than an expansion of this interim ESLint scope.

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
| React 16 peer range (expires 2026-10-31) | Retire React 16 support.  Require React 17--19 in `@uirouter/react-hybrid`, keep the legacy entry point for React 17 only, and remove React 16 from the active downstream matrix.  Preserve the old fixture and failure proof only as historical migration evidence.  This is a breaking package change and must receive the appropriate release entry. | Clean tarball installs and browser/type/runtime coverage for React 17, 18, and 19; no active manifest, documentation, or peer range claims React 16 support. |
| AngularJS ESLint root resolution (expires 2026-10-31) | Make the AngularJS lint lane resolve its declared tooling locally and consistently, then modernize its configuration only as far as the test proves safe. | The AngularJS lint command works from an isolated clean workspace without relying on a hoisted root copy. |

Each successful item removes its waiver, updates the appropriate migration
contract/evidence, and adds the passing command to the regular CI gate.

## P04: release and publish system

### First workstream: existing local scripts

Maintainer direction on 2026-09-21 is to adapt the existing publish scripts to
this monorepo, step by step. Preserve the local `npm run release` entry point
and individual maintainer npm authentication. Start with the existing
package-directory commands; a root package selector is a separate convenience.
Changesets is no longer the proposed prerequisite for this work.

The implementation sequence is:

1. Make a read-only release preview that identifies the selected package,
   proposed version, namespaced tag, history range, and publish directory.
   `--dry-run` must not edit manifests or changelogs, prompt for authentication,
   create commits/tags, push, publish packages/docs, or invoke legacy follow-ons.
   This preview is not yet the complete package/consumer rehearsal below.
2. Adapt version preparation and changelogs to package-scoped history, including
   imported tags at their historical paths. Update the shared root lock and
   affected internal dependencies deliberately. Preserve public compatibility
   ranges and coordinate Angular/Angular Hybrid majors with the supported
   Angular major. Keep release notes for breaking changes such as React Hybrid 3.
3. Build and pack the selected packages, prove clean tarball consumers, and
   rehearse the publishing sequence against a non-production registry.
   Retain AngularJS npm dual publishing as `@uirouter/angularjs` and
   `angular-ui-router`. Both names need artifact/readback proof; the legacy npm
   publish must not run during a preview.
4. Restore the live local path with individual npm login/2FA, explicit package
   selection and dependency order, failure recovery, and registry readback.
   Publish the approved artifact, verify it and its consumers, then promote the
   agreed dist-tag and create matching Git tags/releases, as R01 requires.

The remaining live scripts assume `master`, bare version tags, manifests at
Git root, and package-local dependency resolution. They push tags before npm
publication. Live monorepo execution remains disabled while these gaps are
resolved.

P04 is complete when a non-production rehearsal produces the exact version
plan, package changelogs, reproducible artifacts, dependency order, and clean
consumer evidence. Authentication, provenance, prerelease/stable promotion,
and recovery decisions must be documented before the separately authorized
P06 production release. No production publication is authorized by this plan.

From a package directory, inspect the existing preview with
`npm run release -- --dry-run --bump patch`. To preview the complete preparation
plan, use `npm run release -- --prepare --dry-run --bump patch`. From a clean
branch, remove `--dry-run` to write the planned manifests, changelogs, and root
lockfile. Root invocation also works with `--workspace=@uirouter/core` before
the `--` separator.

Preparation includes dependent packages when an exact internal version must
advance. It keeps an already assigned unreleased version; otherwise it proposes
a patch. Compatible ranges remain unchanged, and incompatible ranges stop the
operation for explicit compatibility review. Angular and Angular Hybrid are
prepared together on their supported Angular major. Requested `--deps` produce
range-change summaries without cloning repositories. Authored release notes
are retained, including existing breaking-change text. No registry request,
lifecycle script, commit, tag, or push is part of preparation.

Prepared files are drafts for review, not an approved release candidate. The
current migration checks still pin accepted versions and internal ranges.
Before the first versioned candidate can pass all gates, make a reviewed update
to the current version checks while preserving the historical migration audit,
then regenerate package and isolated-consumer proofs. Preparation deliberately
does not rewrite those historical contracts or label old proof as current.
Publishing rehearsal and individual npm authentication follow that work.

The local continuation adds a separate candidate version plan; see
[`release/README.md`](../release/README.md). After preparation,
`node tools/prepare-release-validation.mjs --base <full-source-commit> --write`
records the draft version/dependency changes for review. Current workspace
validation consumes that plan without changing the migration classification,
historical N02/N03 evidence, or isolated registry baselines. Candidate package
and consumer proofs still need to be regenerated; the plan does not approve
publication or certify old artifacts for new versions.

Local validation on Node 24.19.0 / npm 11.17.0 covers the existing release
tests plus a real disposable Core preparation, adversarial version-plan
checks, and Angular coordination. The disposable Core candidate passes
manifest, internal-dependency, and root-lock verification. Its refreshed
package contract passes while its old artifact proof is rejected. The
implementation checkout also passes `npm run check:static:installed`, the
39-case N04 validator suite, and the 45-case package-artifact suite. No
candidate versions or regenerated candidate proofs are retained in this
implementation checkpoint. The next focused task is candidate package and
consumer proof regeneration; registry rehearsal remains approval-gated.

### Next AngularJS release notes

Before the next AngularJS publish, add a release-note warning that new Bower
releases have ended. Tell users to use npm; historical Bower releases remain
available. Clarify that npm dual publishing as `@uirouter/angularjs` and
`angular-ui-router` continues for now.

### Later workstream: GitHub Actions publishing

Address Actions publishing only after the local process works. It should reuse
the tested preparation, packing, and verification logic. Decide protected
execution, npm trusted publishing/OIDC, provenance, and maintainer access in
that workstream. It is not an acceptance requirement for the first local
release implementation. Changesets or another versioning system can be
considered separately if the existing scripts prove insufficient.

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

1. Finish P01's remaining existing ESLint declarations and record
   compatible declaration groups and explicit exceptions.
2. Finish the tested Playwright baseline and its syncpack policy.
3. Port the single remaining Cypress lane and remove active Cypress tooling.
4. Carry out the coordinated Oxlint migration described above after the
   interim lint alignment, with explicit rule/coverage parity evidence.
5. Continue P04 with the existing local release scripts and individual npm
   authentication, starting with the read-only preview. Keep future Actions
   publishing separate. This work can begin alongside tooling convergence;
   production release still waits for P01--P03 and P06 approval.
6. Continue the P05 inventory/prototype and later site implementation in the
   order described above; production release and repository transitions stay
   behind their separate approvals.
