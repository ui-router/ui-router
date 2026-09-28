'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const conventionalChangelog = require('conventional-changelog');

const json = (value) => JSON.stringify(value, null, 2) + '\n';

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

// The normal maintainer workflow releases one package. Reuse changelog writing,
// but do not invoke candidate planning, proof generation, or dependent releases.
async function manualRelease(
  root,
  preview,
  options,
  execute = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit' })
) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  if (!preview.branch || preview.dirty) throw new Error('Manual release requires a clean checkout on a branch.');
  if (preview.tagAlreadyExists) throw new Error(`Release tag already exists: ${preview.proposedTag}`);
  const directory = path.join(root, preview.packageDirectory);
  const manifestPath = path.posix.join(preview.packageDirectory, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestPath)));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
  const locked = lock.packages?.[preview.packageDirectory];
  if (lock.lockfileVersion !== 3 || locked?.version !== manifest.version || locked?.name !== manifest.name)
    throw new Error('Selected workspace has a stale root lock entry.');
  if (options.legacyAngularjs && manifest.name !== '@uirouter/angularjs')
    throw new Error('The legacy npm name applies only to the AngularJS package.');
  manifest.version = locked.version = preview.proposedVersion;
  const item = {
    name: manifest.name,
    version: manifest.version,
    tag: preview.proposedTag,
    tagPrefix: preview.proposedTag.slice(0, -manifest.version.length),
    previousTag: preview.previousTag,
    manifest: manifestPath,
    changelog: path.posix.join(preview.packageDirectory, 'CHANGELOG.md'),
    commits: preview.commits.map((line) => line.split(' ')[0]),
    dependencyNotes: [],
  };
  const files = new Map([
    [manifestPath, json(manifest)],
    ['package-lock.json', json(lock)],
  ]);
  await prepareRelease(
    { root, git, files, plan: { sourceCommit: git('rev-parse', 'HEAD'), packages: [item], dependencyUpdates: [] } },
    false
  );
  const publishDirectory = path.resolve(root, preview.publishDirectory);
  try {
    execute('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], root);
    if (manifest.scripts?.build) execute('npm', ['run', 'build'], directory);
    const built = JSON.parse(fs.readFileSync(path.join(publishDirectory, 'package.json')));
    if (built.name !== manifest.name || built.version !== manifest.version)
      throw new Error('Publish directory name/version differs from the selected release.');
    const changed = git('diff', '--name-only').split('\n').filter(Boolean);
    if (changed.some((file) => !files.has(file)))
      throw new Error('Build changed unrelated tracked files; review before committing.');
    console.log(`Review ${item.changelog} and the version changes before continuing.`);
    if (!options.confirm(`Commit and push ${item.tag} on ${preview.branch}, then publish ${manifest.name}?`))
      return { mode: 'prepared-only', package: manifest.name, version: manifest.version };
    execute('git', ['add', '--', ...files.keys()], root);
    execute('git', ['commit', '-m', `Release ${item.tag}`], root);
    execute('git', ['tag', item.tag], root);
    execute('git', ['push', 'origin', `HEAD:refs/heads/${preview.branch}`], root);
    execute('git', ['push', 'origin', `refs/tags/${item.tag}`], root);
    if (options.manualPublish) {
      console.log(`Publish manually from ${publishDirectory}: npm publish`);
      if (options.legacyAngularjs)
        console.log(`Then run: node ${path.join(directory, 'scripts/npm_angular_ui_router_release.js')}`);
    } else {
      execute('npm', ['publish'], publishDirectory);
      if (options.legacyAngularjs)
        execute(process.execPath, [path.join(directory, 'scripts/npm_angular_ui_router_release.js')], directory);
    }
    return {
      mode: 'manual-release',
      package: manifest.name,
      version: manifest.version,
      tag: item.tag,
      publishDirectory,
    };
  } catch (error) {
    console.error(
      `Release stopped. Local changes/tags are retained for recovery. Inspect git status and remote tags before retrying. If Git steps completed, retry npm publish from ${publishDirectory}.`
    );
    throw error;
  }
}

module.exports = { manualRelease };
