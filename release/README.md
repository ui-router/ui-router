# Release candidate validation

Local preparation writes draft versions, internal dependencies, changelogs,
and the root lock. Record its full `sourceCommit` from the preparation preview.
After preparing, use that immutable commit as the validation base:

```sh
node tools/prepare-release-validation.mjs --base <full-source-commit>
node tools/prepare-release-validation.mjs --base <full-source-commit> --write
```

The first command previews `release/version-plan.json`; the second writes it.
Review and commit this file with the prepared manifests and release notes.
Generating a plan does not approve a release, refresh proofs, or publish.
No candidate version plan is checked in with the tooling implementation.

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

Keep the same base when revising a draft plan. It must describe the accepted
workspace versions/ranges from `migration/package-classification.json`, not an
already versioned candidate. Subsequent release cycles will need a separately
reviewed current baseline; do not repurpose the immutable migration contracts.

Historical N02/N03 evidence and isolated registry baselines remain unchanged.
The effective workspace versions exist only in memory during validation.
Refreshing current validation bindings is still necessary for a candidate,
but old package and consumer evidence must fail until regenerated from that
candidate. Commit implementation before recording clean consumer evidence.

Next, regenerate the package and isolated-consumer proofs and rehearse the
registry sequence, including both `@uirouter/angularjs` and `angular-ui-router`.
Merging, registry publishing, tags/releases, and repository transitions still
require the maintainer's separate approval.
