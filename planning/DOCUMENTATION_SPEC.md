# Documentation rebuild specification

## Status

**Discovery and prototype specification.**  This document authorizes neither a
production-site replacement nor a change to the existing GitHub Pages sites.
The old documentation remains authoritative until the replacement meets the
acceptance criteria below.

## Problem

UI-Router documentation is spread across framework repositories, package
READMEs, sample applications, generated API pages, and old GitHub Pages
deployments.  It is hard to know which guide is current, how to start with a
specific framework, and where API reference belongs.  The monorepo is a chance
to give all of that one coherent home without losing the framework-specific
details users need.

## Goals

- A clear landing page that answers what UI-Router is and routes visitors to
  Angular, AngularJS, React, hybrid, and plugin documentation.
- A getting-started path, concepts, recipes, migration guide, and tutorials
  for every supported framework.
- First-class API reference generated from the packages' TypeScript sources.
- Versioned release notes and upgrade guidance that agree with the new release
  system.
- An accessible, fast static site with search, link checking, and preview
  deployments.
- One deployment mechanism that does not commit generated files or force-push
  a `gh-pages` branch from a sample application.

## Non-goals

- Rewriting all documentation before the content inventory and site prototype
  prove the chosen structure.
- Removing old sites or setting redirects before replacement content is
  complete and a stable monorepo release has been observed.
- Using API extraction as a substitute for framework guides and tutorials.

## Information architecture

```text
Home
├── Get started
│   ├── Angular
│   ├── AngularJS
│   ├── React
│   ├── Angular Hybrid
│   └── React Hybrid
├── Learn
│   ├── Concepts
│   ├── Routing patterns and recipes
│   ├── Tutorials and sample applications
│   └── Upgrading and migration
├── Reference
│   ├── Core API
│   ├── Framework APIs
│   └── Plugin APIs
├── Releases
│   ├── Package changelogs
│   └── Compatibility/support policy
└── Community
    ├── Contributing
    ├── Issue and discussion links
    └── Repository transition notice
```

Framework pages share a common conceptual outline but retain framework-native
setup, build, testing, and version-compatibility instructions.  Sample apps
are runnable examples and tutorial companions, not the only place users can
find documentation.

## Technical direction

### Content and API reference

Write human documentation in Markdown/MDX close to the monorepo, with front
matter for framework, package, supported version line, and last verified
release.  Keep TypeDoc for TypeScript API extraction, but update and isolate
it as an API-reference input rather than making it the entire documentation
site.  The site generator owns navigation, search, guides, version notices,
and API links.

Evaluate **Astro Starlight** and **Docusaurus** with the same small prototype:

1. landing page and framework selector;
2. one Angular and one React getting-started guide;
3. one TypeDoc-generated API section;
4. a versioned release-note page;
5. local full-text search, responsive navigation, and an accessible theme;
6. a preview built from a pull request.

Select the generator only after measuring authoring ergonomics, TypeDoc
integration, versioning, search, build time, accessibility, and the ability
to deploy a static artifact.  The selection record will explain why the other
candidate was not chosen.

### Hosting and deployment

GitHub Pages remains a good initial static host.  Replace imperative
`gh-pages`-branch scripts with a GitHub Actions build that uploads the static
artifact and deploys it through the protected `github-pages` environment.  The
deployment workflow must have only the permissions needed for Pages and use a
separate build job; it does not need write access to repository contents.

If the prototype shows that GitHub Pages cannot meet a required capability
(for example, redirects, search, or preview needs), record the evidence and
evaluate another static host before changing production hosting.

## Content migration plan

1. **Inventory.**  List every existing public page, README, TypeDoc output,
   tutorial, sample-app page, and inbound URL across the migrated sources.
   Classify it as retain, rewrite, merge, redirect, or retire.  No URL may
   disappear without an explicit destination or retirement decision.
2. **Foundation.**  Establish the selected site project, shared style and
   navigation, link checker, content linting, and preview build.
3. **Core journey.**  Ship the landing page, getting-started paths, concepts,
   and support/compatibility policy before migrating secondary reference
   pages.
4. **Framework and plugin reference.**  Migrate tutorials, recipes, sample
   app explanations, and TypeDoc API reference package by package.
5. **Release and transition content.**  Consume the new release metadata for
   changelogs and add the original-repository transition notice only when a
   repository's individual transition is approved.
6. **Cutover.**  Run link and content-parity checks, publish the replacement,
   monitor it, then apply approved redirects/archival wording without deleting
   historical docs.

## Quality gates

- Static build, broken-link check, spelling/content lint, and API generation
  run in pull requests.
- A preview URL is available for documentation pull requests.
- Accessibility smoke tests cover navigation, keyboard use, heading order,
  contrast, and framework selector behavior.
- Every supported package and framework has an owner, an API-reference link,
  a getting-started page, and a stated compatibility line.
- Production deployment is an artifact deployment; generated site files are
  not committed to a publishing branch.
- Before cutover, crawl old and new public URLs and preserve or redirect every
  documented entry point.

## Relation to the current docs waiver

The migration waiver concerns four old source-docs commands that use a mutable
container.  Resolve it early by making those existing commands deterministic.
That work merely proves the current baseline and prevents the waiver from
expiring; it does not select the new documentation platform or claim that the
old information architecture is good.

## Decisions required before implementation

1. Select the site generator after the common prototype.
2. Decide whether GitHub Pages meets the final hosting requirements.
3. Approve the public support/versioning policy that the docs will state.
4. Approve the cutover and redirect map only after a stable release and the
   repository-transition decisions are complete.
