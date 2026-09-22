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
