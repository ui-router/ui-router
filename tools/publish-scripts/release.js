#!/usr/bin/env node

require('./util').packageDir();
require('shelljs/global');
const open = require('open');

const readlineSync = require('readline-sync');
const shelljs = require('shelljs');
const fs = require('fs');
const path = require('path');
const semver = require('semver');
const packageJson = JSON.parse(fs.readFileSync('package.json'));
const modifiedFiles = [];

const yargs = require('yargs')
  .option('dryrun', {
    alias: ['dry-run', 'd'],
    description: 'Print a read-only release preview; do not prepare or publish a release.',
    boolean: true,
  })
  .option('bump', {
    description: 'Version bump for the read-only preview',
    choices: ['patch', 'minor', 'major', 'none'],
    default: 'none',
  })
  .option('legacy-angularjs', {
    description: 'Also publish the legacy angular-ui-router npm package after a live release',
    boolean: true,
    default: false,
  })
  .option('deps', {
    description: 'Deps to include in changelog',
    array: true,
  })
  .option('manual-publish', {
    alias: ['m'],
    description: 'Skip npm publish and print instructions for manual publishing',
    boolean: true,
    default: false,
  })
  .check((argv) => {
    if (Object.prototype.hasOwnProperty.call(argv, 'bower')) {
      throw new Error('Bower publishing is retired. Use the npm release path.');
    }
    return true;
  });

const util = require('./util');
const _exec = util._exec;
const _execInteractive = util._execInteractive;
const pkgMgrCmd = util.pkgMgrCommands();

// Dispatch previews before any interactive, writing, authentication, or publish path.
const { execFileSync } = require('child_process');
const repositoryRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const git = (...args) =>
  execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
const artifactsPath = path.join(repositoryRoot, 'migration/package-artifacts.json');
const isMonorepo = fs.existsSync(artifactsPath);

if (yargs.argv.dryrun) {
  try {
    console.log(JSON.stringify(releasePreview(), null, 2));
    process.exit(0);
  } catch (error) {
    console.error(`Release preview failed: ${error.message}`);
    process.exit(1);
  }
}

if (isMonorepo) {
  console.error(
    'Live monorepo releases are not implemented yet. Use npm run release -- --dry-run for a read-only preview.'
  );
  process.exit(1);
}
util.ensureCleanMaster('master');

function releasePreview() {
  if (packageJson.private) throw new Error('Select a public package directory.');
  const packageDirectory = path.relative(repositoryRoot, process.cwd()).split(path.sep).join('/');
  const artifacts = isMonorepo ? JSON.parse(fs.readFileSync(artifactsPath)) : null;
  const record = artifacts && artifacts.packages.find((item) => item.manifest === `${packageDirectory}/package.json`);
  if (isMonorepo && (!record || record.package !== packageJson.name)) {
    throw new Error('The current package is not in the release package inventory.');
  }
  const sources = isMonorepo
    ? JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'migration/sources.json'))).sources
    : [];
  const source = record && sources.find((item) => item.name === record.id);
  if (isMonorepo && !source) throw new Error('Missing imported history mapping.');
  const namespace = source ? source.tagNamespace : '';
  const tags = git('tag', '--merged', 'HEAD', '--list', `${namespace}*`)
    .split('\n')
    .map((tag) => ({ tag, version: semver.valid(tag.slice(namespace.length)) }))
    .filter((item) => item.version)
    .sort((left, right) => semver.rcompare(left.version, right.version) || left.tag.localeCompare(right.tag));
  const previous = tags[0];
  let previousManifest = null;
  let previousVersion = null;
  if (previous) {
    const historical = source && source.releaseTags.some((item) => item.targetName === previous.tag);
    previousManifest = historical
      ? `${source.destinationPrefix}/package.json`
      : packageDirectory
      ? `${packageDirectory}/package.json`
      : 'package.json';
    const manifest = JSON.parse(git('show', `refs/tags/${previous.tag}:${previousManifest}`));
    previousVersion = manifest.version;
  }
  const version = yargs.argv.bump === 'none' ? packageJson.version : semver.inc(packageJson.version, yargs.argv.bump);
  if (!semver.valid(version)) throw new Error('Invalid proposed package version.');
  const tag = `${namespace}${version}`;
  const existingTags = git('tag', '--list', tag);
  const historyPaths = [...new Set([packageDirectory || '.', source && source.destinationPrefix].filter(Boolean))];
  const commits = git(
    'log',
    '--format=%H %s',
    previous ? `refs/tags/${previous.tag}..HEAD` : 'HEAD',
    '--',
    ...historyPaths
  );
  return {
    mode: 'read-only-preview',
    package: packageJson.name,
    packageDirectory: packageDirectory || '.',
    currentVersion: packageJson.version,
    proposedVersion: version,
    proposedTag: tag,
    tagAlreadyExists: Boolean(existingTags),
    previousTag: previous ? previous.tag : null,
    previousVersion,
    previousManifest,
    historyPaths,
    commits: commits ? commits.split('\n') : [],
    changelogDependencies: yargs.argv.deps || [],
    publishDirectory:
      path.posix.join(packageDirectory, record ? record.pack.directory : packageJson.distDir || '.') || '.',
    branch: git('branch', '--show-current') || null,
    dirty: Boolean(git('status', '--porcelain')),
    authentication: 'individual maintainer npm login/2FA (not contacted by preview)',
    npmPackages: yargs.argv['legacy-angularjs'] ? [packageJson.name, 'angular-ui-router'] : [packageJson.name],
    legacyAngularjsFollowOns: yargs.argv['legacy-angularjs']
      ? 'angular-ui-router npm dual publish retained; skipped during preview'
      : null,
    remaining: [
      'version/changelog/shared-lock preparation',
      'package and consumer rehearsal',
      'authenticated publication and registry readback',
    ],
  };
}

// Bump version
const currentVersion = JSON.parse(fs.readFileSync('./package.json')).version;
const versionBumps = ['patch', 'minor', 'major', 'none'];

const versionBump =
  versionBumps[readlineSync.keyInSelect(versionBumps, `Current version: ${currentVersion} ; bump version?`)];
if (!versionBump) {
  process.exit(1);
}

let version = currentVersion;
if (versionBump !== 'none') {
  version = semver.inc(currentVersion, versionBump);

  console.log(`Bumping version: ${version}`);

  packageJson.version = version;
  fs.writeFileSync('package.json', JSON.stringify(packageJson, null, 2) + '\n');
  modifiedFiles.push('package.json');
}

// Generate changelog
let changelog;
if (readlineSync.keyInYN('\n\nUpdate CHANGELOG?')) {
  const depsArg = yargs.argv.deps ? `--deps ${yargs.argv.deps.join(' ')}` : '';
  const show_changelog = path.resolve(__dirname, 'show_changelog.js');

  changelog = _exec(`node ${show_changelog} ${depsArg}`, true).stdout;

  console.log('CHANGELOG:\n\n');
  console.log(changelog);

  const tempChangelogFile = `CHANGELOG.md.${version}`;
  fs.writeFileSync(tempChangelogFile, changelog);

  console.log(`Wrote changelog to temp file: ${tempChangelogFile}`);
  if (!readlineSync.keyInYN('Does the CHANGELOG look OK?')) {
    process.exit(1);
  }

  let existingChangelog = fs.readFileSync('CHANGELOG.md');
  changelog = fs.readFileSync(tempChangelogFile);
  fs.writeFileSync('CHANGELOG.md', changelog + '\n' + existingChangelog);
  fs.unlinkSync(tempChangelogFile);
  modifiedFiles.push('CHANGELOG.md');
}

// Run tests
if (readlineSync.keyInYN('Run tests?')) {
  _exec(pkgMgrCmd.test());
}

// Commit and push changes
if (!readlineSync.keyInYN('Ready to publish?')) {
  console.log(`\n\nRun this command to undo changes:\n\ngit checkout ${modifiedFiles.join(' ')}\n\n`);
  process.exit(1);
}

if (!yargs.argv.dryrun) {
  _exec(`git commit -m ${version} ${modifiedFiles.join(' ')}`);
  _exec(`git add ${modifiedFiles.join(' ')}`); // in case prettier reformatted these files
}

if (!yargs.argv.dryrun) {
  util.ensureCleanMaster('master');
}

// Build, tag, push to github, and publish to NPM
if (!yargs.argv.dryrun) {
  const distDir = packageJson.distDir || '.';
  const publishDir = path.resolve(distDir);

  // Build if needed
  if (distDir !== '.' && packageJson.scripts && packageJson.scripts.build) {
    _exec(pkgMgrCmd.run('build'));
  }

  // Git tag and push first (before npm publish, so if npm publish fails, you can retry)
  _exec(`git tag ${version}`);
  _exec(`git push origin master`);
  _exec(`git push origin ${version}`);

  // Publish to NPM
  if (yargs.argv['manual-publish']) {
    console.log('\n\n=======================================================');
    console.log('MANUAL NPM PUBLISH REQUIRED');
    console.log('=======================================================');
    console.log('\nGit tag and push completed successfully.');
    console.log('\nTo publish to npm, run the following commands:\n');
    console.log(`  cd ${publishDir}`);
    console.log(`  npm publish`);
    console.log('\nAfter publishing, you can continue with the release process below.');
    console.log('=======================================================\n');
  } else {
    console.log('\nPublishing to npm (you may be prompted for 2FA)...\n');
    try {
      shelljs.pushd(distDir);
      _execInteractive(`npm login`);
      _execInteractive(`npm publish`);
      shelljs.popd();
    } catch (error) {
      console.error(error);
      console.error('*** publish failed ***');
      console.error();
      console.error('To publish manually:');
      console.error(`cd ${distDir}`);
      console.error('npm login');
      console.error('npm publish');
    }
  }
}

// Help with manual steps
let githuburl = packageJson.repository && packageJson.repository.url;
githuburl = githuburl && githuburl.replace(/^git\+/, '').replace(/\.git$/, '');

if (githuburl) {
  if (changelog) {
    const haspbcopy = shelljs.exec(`which pbcopy`, true).code === 0;
    console.log(`\n\n1) Update the GitHub release with the release notes/CHANGELOG`);
    console.log(`\n   (Make sure you see "\u2714 Existing tag")`);

    if (haspbcopy) {
      fs.writeFileSync('CHANGELOG.tmp', changelog);
      _exec('pbcopy < CHANGELOG.tmp', true);
      fs.unlinkSync('CHANGELOG.tmp');
      console.log(`(The CHANGELOG has been copied to your clipboard)`);
    } else {
      console.log('CHANGELOG:\n\n');
      console.log(changelog);
    }
    console.log(`\n${githuburl}/releases/edit/${version}`);
    open(`${githuburl}/releases/edit/${version}`);
  }

  console.log(`\n\n2) Check for milestones`);
  console.log(`\n${githuburl}/milestones`);

  console.log(`\n\n\n`);
} else {
  console.log('Could not determine github URL from package.json');
}

// Generate docs
util.packageDir();
if (fs.existsSync('typedoc.json') && readlineSync.keyInYN('Generate docs?')) {
  _exec('generate_docs');
  _exec('publish_docs');
}

// Keep the legacy npm dual publish inside the live path so npm forwards preview
// flags to one process instead of only the last command in a shell chain.
if (yargs.argv['legacy-angularjs']) {
  _exec('node ./scripts/npm_angular_ui_router_release.js');
}
