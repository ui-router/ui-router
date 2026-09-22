import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  createReleaseVersionPlan,
  currentReleaseClassification,
  releaseVersionPlanPath,
  releaseVersionBaselinePath,
  validateReleaseVersionPlan,
} from './release-version-plan.mjs';
import {
  artifactStem,
  validatePackageArtifactsContract,
  validatePackageArtifactsEvidence,
} from './package-artifacts-lib.mjs';
import { cloneValidationFixture } from './validation-test-fixture.mjs';

const repository = path.resolve(import.meta.dirname, '..');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (root, file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const save = (root, file, value) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), JSON.stringify(value, null, 2) + '\n');
};
function run(root, script, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
  });
}
function succeeds(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}
const git = (root, ...args) =>
  execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', root, ...args], { encoding: 'utf8' }).trim();
const commit = (root) => {
  git(root, 'add', '.');
  git(
    root,
    '-c',
    'user.name=Release test',
    '-c',
    'user.email=release-test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'Disposable release fixture',
  );
};
function releaseFixture(root) {
  // These preparation cases start with the accepted versions, even when the
  // suite itself is run on a committed candidate with a version plan.
  const revision = existsSync(path.join(repository, releaseVersionPlanPath))
    ? read(repository, releaseVersionPlanPath).baseCommit
    : 'HEAD';
  return cloneValidationFixture(repository, root, revision);
}
function copyValidationTools(root) {
  for (const file of [
    'release-version-plan.mjs',
    'prepare-release-validation.mjs',
    'validation-test-fixture.mjs',
    'verify-manifest-normalization.mjs',
    'verify-internal-deps.mjs',
    'verify-npm-locks.mjs',
    'test-n04-validators.mjs',
    'test-package-artifacts.mjs',
    'package-artifacts-lib.mjs',
    'prove-package-artifacts.mjs',
  ])
    cpSync(path.join(repository, 'tools', file), path.join(root, 'tools', file));
  mkdirSync(path.join(root, 'release'), { recursive: true });
  cpSync(path.join(repository, releaseVersionBaselinePath), path.join(root, releaseVersionBaselinePath));
}

test('validation fixtures use the exact detached source commit and create a preparation branch', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'uirouter-detached-fixture-'));
  const source = path.join(temporary, 'source');
  const target = path.join(temporary, 'target');
  try {
    mkdirSync(source);
    git(source, 'init', '--quiet', '--initial-branch=main');
    save(source, 'marker.json', { version: 1 });
    commit(source);
    git(source, 'checkout', '--quiet', '--detach');
    save(source, 'marker.json', { version: 2 });
    commit(source);
    const head = git(source, 'rev-parse', 'HEAD');
    assert.equal(cloneValidationFixture(source, target), head);
    assert.equal(git(target, 'rev-parse', 'HEAD'), head);
    assert.equal(git(target, 'branch', '--show-current'), 'validation-fixture');
    assert.equal(read(target, 'marker.json').version, 2);
    assert.equal(git(target, 'status', '--porcelain'), '');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('Angular version plans coordinate majors and preserve exact-range spelling', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'uirouter-angular-version-plan-'));
  try {
    const manifests = ['angular', 'angular-hybrid'].map((id) => ({
      name: `@uirouter/${id}`,
      version: '22.0.0',
      peerDependencies: { '@angular/core': '^22.0.0' },
    }));
    manifests[1].dependencies = { '@uirouter/angular': '=22.0.0' };
    const files = ['angular/package.json', 'angular-hybrid/package.json'];
    const classification = {
      manifests: manifests.map((m, index) => ({
        finalName: m.name,
        path: files[index],
        published: true,
        lockOwner: 'root',
      })),
      edges: [
        {
          id: 'hybrid-angular',
          package: '@uirouter/angular',
          consumerManifest: files[1],
          manifestSection: 'dependencies',
          declaredSpec: '=22.0.0',
          finalSpec: '=22.0.0',
          expectedVersion: '22.0.0',
          resolutionMode: 'workspace',
        },
      ],
    };
    const lock = { lockfileVersion: 3, packages: {} };
    manifests.forEach((manifest, index) => {
      save(root, files[index], manifest);
      lock.packages[path.posix.dirname(files[index])] = structuredClone(manifest);
    });
    save(root, 'package.json', { name: 'plan-fixture', private: true });
    save(root, 'package-lock.json', lock);
    save(root, 'migration/package-classification.json', classification);
    save(root, 'migration/path-repairs.json', { moves: [] });
    save(root, 'migration/sources.json', {
      sources: ['angular', 'angular-hybrid'].map((name) => ({
        destinationPrefix: name,
        tagNamespace: `${name}@`,
        releaseTags: [],
      })),
    });
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Release test',
        '-c',
        'user.email=release-test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '-m',
        'baseline',
      ],
      { cwd: root },
    );
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    save(root, releaseVersionBaselinePath, { schemaVersion: 1, sourceCommit: base });
    for (const [index, manifest] of manifests.entries()) {
      manifest.version = '22.0.1';
      if (manifest.dependencies) manifest.dependencies['@uirouter/angular'] = '=22.0.1';
      save(root, files[index], manifest);
      lock.packages[path.posix.dirname(files[index])] = structuredClone(manifest);
    }
    save(root, 'package-lock.json', lock);
    const plan = createReleaseVersionPlan(root, base);
    assert.equal(plan.dependencyUpdates[0].to, '=22.0.1');
    const mismatched = structuredClone(plan);
    mismatched.packages[1].to = '22.0.2';
    assert.throws(() => validateReleaseVersionPlan(root, mismatched), /same version/);
    const unsupported = structuredClone(plan);
    unsupported.packages.forEach((p) => {
      p.to = '23.0.0';
    });
    // Remove the exact dependency update so the coordinated-major guard is reached.
    unsupported.dependencyUpdates = [];
    assert.throws(() => validateReleaseVersionPlan(root, unsupported), /supported peer range/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepared Core candidate passes current version gates without rewriting migration evidence or reusing old package proof', async (t) => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'uirouter-release-validation-'));
  const root = path.join(temporary, 'candidate');
  try {
    const base = releaseFixture(root);
    // Use the implementation under test with an independent, clean source tree.
    succeeds(
      run(path.join(root, 'core'), path.join(repository, 'tools/publish-scripts/release.js'), [
        '--prepare',
        '--bump',
        'patch',
      ]),
    );
    const historicalPaths = [
      'migration/package-classification.json',
      'migration/path-repairs.json',
      'migration/evidence/n02/manifest-normalization.json',
      'migration/evidence/n03/lock-conversion.json',
    ];
    for (const file of historicalPaths) {
      assert.deepEqual(
        readFileSync(path.join(root, file)),
        execFileSync('git', ['show', `${base}:${file}`], { cwd: root, maxBuffer: 32 * 1024 * 1024 }),
      );
    }
    copyValidationTools(root);
    for (const validator of ['verify-manifest-normalization.mjs', 'verify-internal-deps.mjs', 'verify-npm-locks.mjs'])
      assert.notEqual(run(root, `tools/${validator}`).status, 0, `${validator} accepted an unplanned candidate`);
    const preview = run(root, 'tools/prepare-release-validation.mjs', ['--base', base]);
    succeeds(preview);
    const plan = JSON.parse(preview.stdout);
    assert.deepEqual(plan.packages.map((item) => [item.name, item.from, item.to]).sort(), [
      ['@uirouter/core', '6.1.2', '6.1.3'],
      ['@uirouter/react', '1.0.8', '1.0.9'],
      ['@uirouter/react-hybrid', '3.0.0', '3.0.0'],
    ]);
    assert.equal(plan.dependencyUpdates.length, 3);
    succeeds(run(root, 'tools/prepare-release-validation.mjs', ['--base', base, '--write']));
    assert.deepEqual(read(root, releaseVersionPlanPath), plan);
    const classification = read(root, 'migration/package-classification.json');
    const projected = currentReleaseClassification(root, classification);
    assert.deepEqual(
      projected.edges.filter((edge) => edge.resolutionMode === 'local-tarball'),
      classification.edges.filter((edge) => edge.resolutionMode === 'local-tarball'),
    );
    for (const validator of ['verify-manifest-normalization.mjs', 'verify-internal-deps.mjs', 'verify-npm-locks.mjs'])
      succeeds(run(root, `tools/${validator}`));

    async function rejects(name, mutate, expected) {
      await t.test(name, () => {
        const candidate = structuredClone(plan);
        mutate(candidate);
        assert.throws(() => validateReleaseVersionPlan(root, candidate), expected);
      });
    }
    await rejects(
      'unknown schema fields',
      (p) => {
        p.approved = true;
      },
      /plan fields/,
    );
    await rejects(
      'floating base',
      (p) => {
        p.baseCommit = 'HEAD';
      },
      /immutable commit/,
    );
    await rejects(
      'unavailable base',
      (p) => {
        p.baseCommit = '0'.repeat(40);
      },
      /ancestral/,
    );
    await rejects(
      'stale historical binding',
      (p) => {
        p.classificationSha256 = '0'.repeat(64);
      },
      /classificationSha256/,
    );
    await rejects(
      'stale current baseline binding',
      (p) => {
        p.versionBaselineSha256 = '0'.repeat(64);
      },
      /versionBaselineSha256/,
    );
    await rejects(
      'stale release history binding',
      (p) => {
        p.sourcesSha256 = '0'.repeat(64);
      },
      /sourcesSha256/,
    );
    await rejects(
      'duplicate package',
      (p) => {
        p.packages.push(p.packages[0]);
      },
      /duplicate release package/,
    );
    await rejects(
      'renamed package',
      (p) => {
        p.packages[0].name = 'angular-ui-router';
      },
      /unknown or duplicate/,
    );
    await rejects(
      'manifest traversal',
      (p) => {
        p.packages[0].manifest = '../package.json';
      },
      /unknown or duplicate/,
    );
    await rejects(
      'wrong before version',
      (p) => {
        p.packages[0].from = '0.0.0';
      },
      /previous version/,
    );
    await rejects(
      'downgrade',
      (p) => {
        p.packages[0].to = '0.0.0';
      },
      /non-decreasing/,
    );
    await rejects(
      'missing dependent release',
      (p) => {
        p.packages = p.packages.filter((item) => item.name !== '@uirouter/react-hybrid');
      },
      /dependent release package is missing/,
    );
    await rejects(
      'unlisted version',
      (p) => {
        p.packages[0].to = '6.1.4';
      },
      /only exact internal updates|manifest differs/,
    );
    await rejects(
      'duplicate dependency update',
      (p) => {
        p.dependencyUpdates.push(p.dependencyUpdates[0]);
      },
      /duplicate/,
    );
    await rejects(
      'widened range',
      (p) => {
        p.dependencyUpdates[0].to = '*';
      },
      /only exact internal updates/,
    );
    await rejects(
      'file dependency',
      (p) => {
        p.dependencyUpdates[0].to = 'file:../core';
      },
      /only exact internal updates/,
    );
    await rejects(
      'historical integration rewrite',
      (p) => {
        p.dependencyUpdates[0].edgeId = classification.edges.find((edge) => edge.resolutionMode === 'local-tarball').id;
      },
      /non-workspace/,
    );
    await rejects(
      'missing dependency update',
      (p) => {
        p.dependencyUpdates.pop();
      },
      /manifest differs|unchanged package/,
    );

    async function rejectsFile(name, file, mutate, expected) {
      await t.test(name, () => {
        const bytes = readFileSync(path.join(root, file));
        try {
          const value = JSON.parse(bytes);
          mutate(value);
          save(root, file, value);
          assert.throws(() => validateReleaseVersionPlan(root, plan), expected);
        } finally {
          writeFileSync(path.join(root, file), bytes);
        }
      });
    }
    await rejectsFile(
      'stale lock version',
      'package-lock.json',
      (v) => {
        v.packages.core.version = '6.1.2';
      },
      /root lock/,
    );
    await rejectsFile(
      'registry fallback',
      'package-lock.json',
      (v) => {
        v.packages['node_modules/@uirouter/core'] = {
          version: '6.1.3',
          resolved: 'https://registry.npmjs.org/@uirouter/core/-/core-6.1.3.tgz',
        };
      },
      /root lock/,
    );
    await rejectsFile(
      'external lock drift',
      'package-lock.json',
      (v) => {
        v.packages['node_modules/typescript'].version = '99.0.0';
      },
      /root lock/,
    );
    await rejectsFile(
      'unplanned package with no incoming workspace edges',
      'plugins/redux/package.json',
      (v) => {
        v.version = '99.0.0';
      },
      /manifest differs/,
    );
    await rejectsFile(
      'public engines drift',
      'core/package.json',
      (v) => {
        v.engines = { node: '>=24' };
      },
      /manifest differs/,
    );
    await rejectsFile(
      'historical contract drift',
      'migration/package-classification.json',
      (v) => {
        v.edges[0].expectedVersion = '99.0.0';
      },
      /historical binding/,
    );

    await t.test('a coherent dependency update cannot retain an already tagged dependent version', () => {
      const files = [
        'frameworks/react/uirouter-react/package.json',
        'frameworks/react-hybrid/uirouter-react-hybrid/package.json',
        'package-lock.json',
      ];
      const originals = files.map((file) => readFileSync(path.join(root, file)));
      try {
        const react = read(root, files[0]);
        react.version = '1.0.8';
        save(root, files[0], react);
        const hybrid = read(root, files[1]);
        hybrid.dependencies['@uirouter/react'] = '1.0.8';
        save(root, files[1], hybrid);
        const lock = read(root, files[2]);
        lock.packages['frameworks/react/uirouter-react'].version = '1.0.8';
        lock.packages['frameworks/react-hybrid/uirouter-react-hybrid'].dependencies['@uirouter/react'] = '1.0.8';
        save(root, files[2], lock);
        assert.throws(
          () => createReleaseVersionPlan(root, base),
          /@uirouter\/react: release version 1.0.8 is already tagged/,
        );
      } finally {
        files.forEach((file, index) => writeFileSync(path.join(root, file), originals[index]));
      }
    });
    for (const [tag, expected] of [
      ['core@v6.1.3', /already tagged/],
      ['core@6.1.99', /must be newer/],
    ]) {
      await t.test(`release eligibility checks ${tag}`, () => {
        git(root, 'tag', tag);
        try {
          assert.throws(() => validateReleaseVersionPlan(root, plan), expected);
        } finally {
          git(root, 'tag', '-d', tag);
        }
      });
    }

    await t.test('refreshed package metadata accepts the plan but historical artifact proof still fails', async () => {
      const contract = read(root, 'migration/package-artifacts.json');
      contract.rootLockSha256 = digest(readFileSync(path.join(root, 'package-lock.json')));
      for (const record of contract.packages) {
        record.version = read(root, record.manifest).version;
        record.manifestSha256 = digest(readFileSync(path.join(root, record.manifest)));
      }
      save(root, 'migration/package-artifacts.json', contract);
      await validatePackageArtifactsContract({ root });
      await assert.rejects(validatePackageArtifactsEvidence({ root }), /package proof contract digest differs/);
    });

    await t.test('candidate N04 fixtures retain Git history and reject mutations at the applicable gate', () => {
      commit(root);
      succeeds(run(root, 'tools/test-n04-validators.mjs'));
    });
    await t.test('candidate artifact fixtures exercise all checks with synthetic evidence', () => {
      // Only this disposable test tree gets synthetic proof metadata. The real
      // historical proof was rejected above; no build/consumer proof is claimed.
      const contract = read(root, 'migration/package-artifacts.json');
      const proof = read(root, 'migration/evidence/p01/package-proof.json');
      const consumer = read(root, 'migration/evidence/p01/consumer-package-lock.json');
      for (const artifact of proof.packages) {
        artifact.version = contract.packages.find((record) => record.package === artifact.package).version;
        artifact.filename = `${artifactStem(artifact.package, artifact.version, artifact.sha256)}.tgz`;
        const installed = consumer.packages[`node_modules/${artifact.package}`];
        installed.version = artifact.version;
        installed.resolved = `file:../artifacts/${artifact.filename}`;
      }
      save(root, 'migration/evidence/p01/consumer-package-lock.json', consumer);
      proof.contractSha256 = digest(readFileSync(path.join(root, 'migration/package-artifacts.json')));
      proof.releaseVersionPlanSha256 = digest(readFileSync(path.join(root, releaseVersionPlanPath)));
      proof.rootLockSha256 = contract.rootLockSha256;
      proof.consumer.lockSha256 = digest(
        readFileSync(path.join(root, 'migration/evidence/p01/consumer-package-lock.json')),
      );
      save(root, 'migration/evidence/p01/package-proof.json', proof);
      succeeds(run(root, 'tools/test-package-artifacts.mjs'));
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('an explicitly selected unreleased version can be prepared without a version or dependency change', async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'uirouter-assigned-release-'));
  const root = path.join(temporary, 'candidate');
  try {
    const base = releaseFixture(root);
    succeeds(
      run(
        path.join(root, 'frameworks/react-hybrid/uirouter-react-hybrid'),
        path.join(repository, 'tools/publish-scripts/release.js'),
        ['--prepare', '--bump', 'none'],
      ),
    );
    copyValidationTools(root);
    const args = ['--base', base, '--package', '@uirouter/react-hybrid'];
    const preview = run(root, 'tools/prepare-release-validation.mjs', args);
    succeeds(preview);
    const plan = JSON.parse(preview.stdout);
    assert.deepEqual(plan.packages, [
      {
        name: '@uirouter/react-hybrid',
        manifest: 'frameworks/react-hybrid/uirouter-react-hybrid/package.json',
        from: '3.0.0',
        to: '3.0.0',
      },
    ]);
    assert.deepEqual(plan.dependencyUpdates, []);
    succeeds(run(root, 'tools/prepare-release-validation.mjs', [...args, '--write']));
    assert.deepEqual(read(root, releaseVersionPlanPath), plan);
    await validatePackageArtifactsContract({ root });
    await assert.rejects(validatePackageArtifactsEvidence({ root }), /release version plan digest differs/);
    for (const validator of ['verify-manifest-normalization.mjs', 'verify-internal-deps.mjs', 'verify-npm-locks.mjs'])
      succeeds(run(root, `tools/${validator}`));
    assert.throws(() => createReleaseVersionPlan(root, base, ['@uirouter/core']), /already tagged/);
    // Deleting an imported tag locally must not make that version eligible.
    git(root, 'tag', '-d', 'core@6.1.2');
    assert.throws(() => createReleaseVersionPlan(root, base, ['@uirouter/core']), /already tagged/);
    assert.throws(() => createReleaseVersionPlan(root, base, ['@uirouter/unknown']), /unknown selected/);
    assert.throws(
      () => createReleaseVersionPlan(root, base, ['@uirouter/react-hybrid', '@uirouter/react-hybrid']),
      /without duplicates/,
    );
    const invalid = run(root, 'tools/prepare-release-validation.mjs', [...args, '--unexpected']);
    assert.notEqual(invalid.status, 0);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('packages without incoming workspace edges cannot certify a new version baseline', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'uirouter-version-base-'));
  try {
    for (const [name, directory] of [
      ['redux', 'plugins/redux'],
      ['react-hybrid', 'frameworks/react-hybrid/uirouter-react-hybrid'],
    ]) {
      const root = path.join(temporary, name);
      releaseFixture(root);
      copyValidationTools(root);
      const manifest = read(root, `${directory}/package.json`);
      manifest.version = '99.0.0';
      save(root, `${directory}/package.json`, manifest);
      const lock = read(root, 'package-lock.json');
      lock.packages[directory].version = manifest.version;
      save(root, 'package-lock.json', lock);
      commit(root);
      const candidateBase = git(root, 'rev-parse', 'HEAD');
      assert.throws(
        () => createReleaseVersionPlan(root, candidateBase, ['@uirouter/react-hybrid']),
        /baseline version differs/,
      );
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
