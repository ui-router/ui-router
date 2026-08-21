# UI-Router Monorepo Migration

## Context

The UI-Router project is an OSS project.  
At its core, it's a framework-agnostic front end SPA router.
The project started as an AngularJS (1.x) router, and has since expanded to support Angular (2+), React, Vue, and other frameworks.

The project consists of:
- a core router library
    - git@github.com:ui-router/core.git
- a handful of plugins
  - git@github.com:ui-router/dsr.git
  - git@github.com:ui-router/rx.git
  - git@github.com:ui-router/redux.git
  - git@github.com:ui-router/sticky-states.git
  - git@github.com:ui-router/visualizer.git
- framework specific adapter packages
  - git@github.com:ui-router/angular.git
  - git@github.com:ui-router/angular-hybrid.git
  - git@github.com:ui-router/react.git
  - git@github.com:ui-router/react-hybrid.git
- framework specific sample apps
  - git@github.com:ui-router/sample-app-angular.git
  - git@github.com:ui-router/sample-app-angular-hybrid.git
  - git@github.com:ui-router/sample-app-angularjs.git
  - git@github.com:ui-router/sample-app-react.git
- Repo helpers
  - git@github.com:ui-router/publish-scripts.git

- Each of these repos has its own commit history, authors, and tags.
- These repos have interdependencies; for example, the framework specific packages depend on the core router library.
- The sample apps depend on the framework specific packages.
- The sample apps are used both as examples as well as integration tests for the framework specific packages.
- Some of the packages have separate integration tests embedded in the repo, which have their own package.json and dependencies on core or framework packages.

By migrating to a monorepo, we will unlock:
- unified and simplified development and release process
- convergence on a common tool set
- the ability to make changes across packages including core, framework, and sample apps
- release of multiple packages at the same time

## Goal

The goal of this migration is to combine all of the above repositories into a single monorepo.
The monorepo must preserve commit history, authors, and tags of each repository. 

The monorepo will be structured as follows:

```
- core
- publish-scripts
- plugins # framework agnostic
+- dsr
+- rx
+- redux
+- sticky-states
+- visualizer
- framework
+- angularjs
   +- angularjs-router # @uirouter/angularjs
   +- angularjs-sample-app
+- angular
   +- angular-router
   +- angular-sample-app
   +- integration-test-A
   +- integration-test-B
+- angular-hybrid
   +- angular-hybrid-router
   +- angular-hybrid-sample-app
+- react
   +- react-router
   +- react-sample-app
   +- integration-test-A
   +- integration-test-B
+- react-hybrid
   +- react-hybrid-router
   +- react-hybrid-sample-app
```

## Constraints

- Migrate to NPM package manager
- Use NPM workspaces to link packages together
  - Monorepo packages should be linked to respective monorepo dependencies
    - Framework packages should use the live 'core/src' for test and compile, instead of the published npm package
  - Published packages should use versioned npm dependencies, and should not depend on monorepo structure.
- Use Turborepo 
  - work avoidance
  - ability to run dependency topographic builds and tests for all packages in the monorepo
- Converge on common package versions and tooling, as much as possible
  - Angular has tighter requirements for things such as Typescript
  - Each framework ecosystem may require specific tools such as ng-packagr, eslint, etc.
- Common tooling should be placed at /tools/foo-bar 
  - foo-bar is the name of the tool
  - each tool has a package.json
  - deprecate publish-scripts npm package in favor of monorepo tool packages
- git tags should be renamed to include the package name, such as `core-v1.0.0` instead of `v1.0.0`
- framework specific code should be isolated to framework subdirectories
- package names, code content, and test logic should be unchanged

## Tasks

- Run the ./monorepo.sh script to create the monorepo
  - Create a monorepo directory
  - Fetch all the repositories
  - Import all repositories, history, tags into the monorepo
- Move the packages into their respective directories, given the structure above
- Write the NPM workspaces config
- Update package.json files to use monorepo dependencies instead of npm dependencies (maybe? does npm workspaces do this automagically?)
- Untangle the downstream tests
  - Downstream tests should be moved to integration-test-A style directories
  - Can keep the test:downtream package.json script, but these should be driven using turbo package dependencies somehow?
- More TBD
