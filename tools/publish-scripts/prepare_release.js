'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const conventionalChangelog = require('conventional-changelog');

const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const json = (value) => JSON.stringify(value, null, 2) + '\n';

function preparationPlan(root, preview, semver) {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
  const inventory = read('migration/package-artifacts.json').packages;
  const sources = read('migration/sources.json').sources;
  const publications = require('../release-version-plan.mjs').releasePublications(root);
  const lock = read('package-lock.json');
  if (lock.lockfileVersion !== 3 || !lock.packages)
    throw new Error('Preparation requires a version 3 root package-lock.json.');
  const workspaces = new Map();
  for (const [directory, locked] of Object.entries(lock.packages)) {
    if (!directory || directory.split('/').includes('node_modules') || locked.link) continue;
    if (path.isAbsolute(directory) || directory.split('/').includes('..'))
      throw new Error('Invalid workspace path in root lock.');
    if (fs.realpathSync(path.join(root, directory)) !== path.resolve(root, directory))
      throw new Error(`Refusing a symlinked workspace: ${directory}`);
    const file = `${directory}/package.json`;
    const manifest = read(file);
    if (manifest.name !== locked.name || manifest.version !== locked.version)
      throw new Error(`Stale root lock entry: ${directory}`);
    for (const section of sections) {
      if (
        [...new Set([...Object.keys(manifest[section] || {}), ...Object.keys(locked[section] || {})])].some(
          (name) => manifest[section]?.[name] !== locked[section]?.[name]
        )
      ) {
        throw new Error(`Stale root lock ${section}: ${directory}`);
      }
    }
    const link = lock.packages[`node_modules/${manifest.name}`];
    if (!link || !link.link || link.resolved !== directory) throw new Error(`Missing workspace link: ${manifest.name}`);
    workspaces.set(manifest.name, { directory, file, before: manifest, after: JSON.parse(JSON.stringify(manifest)) });
  }
  const records = new Map(inventory.map((record) => [record.package, record]));
  if (!workspaces.has(preview.package) || !records.has(preview.package))
    throw new Error('Selected package is not a locked release workspace.');
  const allTags = new Set(git('tag', '--list').split('\n'));
  function dependentVersion(name) {
    const current = workspaces.get(name).before.version;
    const source = sources.find((item) => item.name === records.get(name).id);
    if (!source) throw new Error(`Missing release history mapping for ${name}`);
    const released = publications.some((record) => record.name === name && record.version === current) ||
      [...allTags, ...source.releaseTags.map((record) => record.targetName)].some(
      (tag) => tag.startsWith(source.tagNamespace) && semver.valid(tag.slice(source.tagNamespace.length)) === current
    );
    return released ? semver.inc(current, 'patch') : current;
  }
  const versions = new Map([[preview.package, preview.proposedVersion]]);
  const reasons = new Map([[preview.package, 'selected']]);
  const angular = ['@uirouter/angular', '@uirouter/angular-hybrid'];
  function schedule(name, version, reason) {
    if (versions.has(name)) {
      if (versions.get(name) !== version) throw new Error(`Conflicting proposed versions for ${name}`);
      return false;
    }
    versions.set(name, version);
    reasons.set(name, reason);
    return true;
  }
  let changed;
  do {
    changed = false;
    for (const name of angular) {
      if (!versions.has(name)) continue;
      const sibling = angular.find((item) => item !== name);
      if (!workspaces.has(sibling) || !records.has(sibling))
        throw new Error('Both Angular release packages are required.');
      if (workspaces.get(name).before.version !== workspaces.get(sibling).before.version)
        throw new Error('Angular package versions must be aligned before preparation.');
      changed = schedule(sibling, versions.get(name), 'Angular coordinated release') || changed;
    }
    for (const workspace of workspaces.values()) {
      for (const section of sections) {
        for (const [dependency, spec] of Object.entries(workspace.before[section] || {})) {
          if (!versions.has(dependency)) continue;
          const next = versions.get(dependency);
          if (semver.satisfies(next, spec)) continue;
          const previous = workspaces.get(dependency).before.version;
          const exact = spec.replace(/^=/, '');
          if (semver.valid(exact) !== previous || semver.major(next) !== semver.major(previous)) {
            throw new Error(
              `${workspace.before.name} ${section}.${dependency} (${spec}) excludes ${next}; review compatibility explicitly before preparation.`
            );
          }
          workspace.after[section][dependency] = spec.startsWith('=') ? `=${next}` : next;
          if (records.has(workspace.before.name) && !versions.has(workspace.before.name)) {
            changed =
              schedule(workspace.before.name, dependentVersion(workspace.before.name), 'internal dependency update') ||
              changed;
          }
        }
      }
    }
  } while (changed);

  const packages = [];
  for (const [name, version] of versions) {
    const workspace = workspaces.get(name);
    const record = records.get(name);
    const source = sources.find((item) => item.name === record.id);
    if (!source || record.manifest !== workspace.file) throw new Error(`Missing release history mapping for ${name}`);
    if (!semver.valid(version) || semver.lt(version, workspace.before.version))
      throw new Error(`Invalid release version for ${name}`);
    if (
      angular.includes(name) &&
      !semver.satisfies(`${semver.major(version)}.0.0`, workspace.before.peerDependencies?.['@angular/core'] || '')
    ) {
      throw new Error('The Angular package major must match its supported Angular peer range.');
    }
    for (const publication of publications.filter((record) => record.name === name)) {
      if (!semver.valid(publication.version) || !semver.gt(version, publication.version))
        throw new Error(`${name}: choose a version newer than published ${publication.version}.`);
    }
    const tag = `${source.tagNamespace}${version}`;
    if ([...allTags, ...source.releaseTags.map((record) => record.targetName)].some(
      (known) => known.startsWith(source.tagNamespace) && semver.valid(known.slice(source.tagNamespace.length)) === version
    )) throw new Error(`Release tag already exists: ${tag}; choose a new version.`);
    const tags = git('tag', '--merged', 'HEAD', '--list', `${source.tagNamespace}*`)
      .split('\n')
      .map((value) => ({ tag: value, version: semver.valid(value.slice(source.tagNamespace.length)) }))
      .filter((item) => item.version)
      .sort((a, b) => semver.rcompare(a.version, b.version));
    const previous = tags[0];
    if (previous && !semver.gt(version, previous.version))
      throw new Error(`${tag} must be newer than ${previous.tag}.`);
    const historical = previous && source.releaseTags.some((item) => item.targetName === previous.tag);
    const previousManifest = previous
      ? `${historical ? source.destinationPrefix : workspace.directory}/package.json`
      : null;
    const previousPackage = previous ? JSON.parse(git('show', `refs/tags/${previous.tag}:${previousManifest}`)) : {};
    const requested = name === preview.package ? preview.changelogDependencies : [];
    const declared = (manifest, dependency) =>
      ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']
        .map((section) => manifest[section]?.[dependency])
        .find(Boolean);
    const dependencyNotes = requested
      .map((dependency) => {
        const to = declared(workspace.after, dependency);
        if (!to) throw new Error(`${name} has no declared dependency ${dependency}.`);
        return { package: dependency, from: declared(previousPackage, dependency) || 'not declared', to };
      })
      .filter((item) => item.from !== item.to);
    const historyPaths = [...new Set([workspace.directory, source.destinationPrefix])];
    const hashes = git(
      'log',
      '--format=%H',
      previous ? `refs/tags/${previous.tag}..HEAD` : 'HEAD',
      '--',
      ...historyPaths
    )
      .split('\n')
      .filter(Boolean);
    workspace.after.version = version;
    packages.push({
      name,
      from: workspace.before.version,
      version,
      reason: reasons.get(name),
      manifest: workspace.file,
      tag,
      tagPrefix: source.tagNamespace,
      previousTag: previous?.tag || null,
      dependencyNotes,
      commits: hashes,
      changelog: `${workspace.directory}/CHANGELOG.md`,
      npmPackages: name === '@uirouter/angularjs' ? [name, 'angular-ui-router'] : [name],
    });
  }
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  function visit(item) {
    if (visiting.has(item.name))
      throw new Error('Selected releases have a dependency cycle; review publishing order explicitly.');
    if (visited.has(item.name)) return;
    visiting.add(item.name);
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const dependency of Object.keys(workspaces.get(item.name).after[section] || {})) {
        const selected = packages.find((candidate) => candidate.name === dependency);
        if (selected) visit(selected);
      }
    }
    visiting.delete(item.name);
    visited.add(item.name);
    ordered.push(item);
  }
  for (const item of packages) visit(item);
  packages.splice(0, packages.length, ...ordered);
  const dependencyUpdates = [];
  const files = new Map();
  for (const workspace of workspaces.values()) {
    if (json(workspace.before) === json(workspace.after)) continue;
    files.set(workspace.file, json(workspace.after));
    const entry = lock.packages[workspace.directory];
    entry.version = workspace.after.version;
    for (const section of sections) {
      for (const [name, spec] of Object.entries(workspace.after[section] || {})) {
        if (spec === workspace.before[section][name]) continue;
        dependencyUpdates.push({
          manifest: workspace.file,
          section,
          package: name,
          from: workspace.before[section][name],
          to: spec,
        });
        entry[section][name] = spec;
      }
    }
  }
  files.set('package-lock.json', json(lock));
  return {
    root,
    git,
    files,
    plan: {
      mode: 'release-preparation',
      draft: true,
      sourceCommit: git('rev-parse', 'HEAD'),
      packages,
      dependencyUpdates,
      files: [...files.keys(), ...packages.map((item) => item.changelog)],
      remaining: [
        'review generated changelogs and dependency changes',
        'review current version-bound validation contracts and regenerate package/consumer evidence',
        'rehearse publication, registry readback, and recovery before live publishing',
      ],
    },
  };
}

async function prepareRelease(preparation, dryRun) {
  const { root, git, files, plan } = preparation;
  if (dryRun) return { ...plan, mode: 'read-only-preparation-preview' };
  if (!git('branch', '--show-current')) throw new Error('Prepare on a branch, not a detached checkout.');
  if (git('status', '--porcelain', '--untracked-files=all'))
    throw new Error('Release preparation requires a clean checkout.');
  const originalCwd = process.cwd();
  try {
    // The installed preset reads package metadata from cwd. Keep generation
    // sequential, and filter commits across both current and imported paths.
    for (const item of plan.packages) {
      process.chdir(path.join(root, path.posix.dirname(item.manifest)));
      const allowed = new Set(item.commits);
      const stream = conventionalChangelog(
        {
          preset: 'ui-router-core',
          tagPrefix: item.tagPrefix,
          transform(commit, callback) {
            const include = allowed.delete(commit.hash);
            callback(null, include ? commit : undefined);
          },
        },
        {
          version: item.version,
          currentTag: item.tag,
          previousTag: item.previousTag,
          gitSemverTags: item.previousTag ? [item.previousTag] : [],
        },
        { from: item.previousTag ? `refs/tags/${item.previousTag}` : '', to: plan.sourceCommit, merges: null },
        undefined,
        { doFlush: true, generateOn: () => false, headerPartial: '' }
      );
      let notes = '';
      for await (const chunk of stream) notes += chunk.toString();
      const updates = plan.dependencyUpdates.filter((update) => update.manifest === item.manifest);
      for (const note of item.dependencyNotes) {
        if (!updates.some((update) => update.package === note.package))
          updates.push({ ...note, section: 'declared range since previous release' });
      }
      if (updates.length)
        notes +=
          '\n### Dependencies\n\n' +
          updates.map((update) => `- ${update.package}: ${update.from} → ${update.to} (${update.section})`).join('\n') +
          '\n';
      const absolute = path.join(root, item.changelog);
      const existing = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : '';
      if (item.name === '@uirouter/angularjs' && !existing.includes('New Bower releases have ended.'))
        notes +=
          '\n### Distribution\n\nNew Bower releases have ended. Use npm; historical Bower releases remain available. Both `@uirouter/angularjs` and `angular-ui-router` continue to be published to npm.\n';
      const headings = [...existing.matchAll(/^#{1,6}\s+\[?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\]|\s|$).*$/gm)];
      const authored = headings.findIndex((match) => match[1] === item.version);
      const manifest = JSON.parse(fs.readFileSync(path.join(root, item.manifest), 'utf8'));
      const repository = manifest.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, '');
      const comparison =
        item.previousTag && repository?.startsWith('https://')
          ? `[Compare releases](${repository}/compare/${encodeURIComponent(item.previousTag)}...${encodeURIComponent(
              item.tag
            )})`
          : '';
      if (authored >= 0) {
        // Keep authored breaking-change notes and the existing release heading.
        const start = headings[authored].index;
        const end = headings[authored + 1]?.index ?? existing.length;
        let section = existing.slice(start, end);
        if (comparison) section = section.replace(/^\[Compare[^\n]*\]\([^\n]*\)$/m, comparison);
        files.set(
          item.changelog,
          existing.slice(0, start) + section.trimEnd() + '\n\n' + notes.trim() + '\n\n' + existing.slice(end)
        );
      } else {
        const header =
          `# ${item.version} (${new Date().toISOString().slice(0, 10)})\n` + (comparison ? comparison + '\n' : '');
        files.set(item.changelog, header + '\n' + notes.trim() + '\n\n' + existing);
      }
    }
  } finally {
    process.chdir(originalCwd);
  }
  if (git('rev-parse', 'HEAD') !== plan.sourceCommit || git('status', '--porcelain', '--untracked-files=all')) {
    throw new Error('Checkout changed while generating release notes; preparation aborted.');
  }
  const originals = new Map();
  for (const [file] of files) {
    const absolute = path.join(root, file);
    if (fs.existsSync(absolute) && !fs.lstatSync(absolute).isFile())
      throw new Error(`Refusing non-file release target: ${file}`);
    originals.set(file, fs.existsSync(absolute) ? fs.readFileSync(absolute) : null);
  }
  try {
    for (const [file, contents] of files) fs.writeFileSync(path.join(root, file), contents);
  } catch (error) {
    for (const [file, contents] of originals) {
      if (contents === null) fs.rmSync(path.join(root, file), { force: true });
      else fs.writeFileSync(path.join(root, file), contents);
    }
    throw error;
  }
  return plan;
}

module.exports = { preparationPlan, prepareRelease };
