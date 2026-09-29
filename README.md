# UI-Router Monorepo

UI-Router packages, framework adapters, plugins, examples, compatibility tests, and shared tooling.

Published packages live under `core`, `frameworks`, `plugins`, and `tools`. Examples are private root workspaces; compatibility projects under `integration-tests` have independent installs.

Use the Node version in `.node-version` and npm version in `package.json`.

```sh
npm ci --ignore-scripts
npm run check
npm run pack
npm run test:consumers
npm run docs:verify
```

`check` runs dependency-version policy, lint, types, and unit tests. `pack` builds and checks all twelve package archives. Consumer tests install those archives outside the workspace and exercise package entrypoints plus thirteen TypeScript/framework fixtures. Pass `-- core`, `-- angular`, `-- angularjs`, `-- react`, or `-- react-hybrid` to test one compatibility group; `-- packages` runs the shared package checks. Browser tests require Chromium and its system dependencies.

The [CI workflow](.github/workflows/ci.yml) also runs the ordinary example browser tests, including the remaining Cypress lane. It is maintained directly.

## Releases

From the selected public package directory:

```sh
npm run release -- --dry-run --bump patch
npm run release -- --bump patch
```

The manual command updates that package's version and changelog, regenerates the shared lock, builds, asks for review, commits, creates and pushes its namespaced tag, and publishes from the package's root or `dist` directory using your npm authentication. `--manual-publish` stops after the Git push and prints the npm command. AngularJS retains the legacy `angular-ui-router` dual publish.

React and React Hybrid accept compatible UI-Router dependency updates using caret ranges, keeping their existing minimum versions. After packing, run `npm run test:consumers -- react --minimum` or `npm run test:consumers -- react-hybrid --minimum` to test the new package against its published minimum dependencies. CI runs these alongside the normal tests against current package archives.

Review dependent package ranges when bumping versions. Packages are released individually; coordinated Angular major updates remain a maintainer decision. See [package configuration](tools/packages.json) for publish directories and imported history paths.

## Migration history and remaining work

The monorepo migration is accepted. The migration specification, immutable snapshots, proof bundles, validators, and rehearsal machinery are preserved in [the pre-cleanup Git tree](https://github.com/ui-router/ui-router/tree/82bbde2ab). Normal CI tests current source and tarballs rather than revalidating that historical checkpoint.

The [post-migration program](planning/POST_MIGRATION_PROGRAM.md) tracks remaining tooling convergence, documentation, and eventual repository transitions. Those are follow-up work, not unfinished migration acceptance. Production publishing and repository transitions require maintainer approval.
