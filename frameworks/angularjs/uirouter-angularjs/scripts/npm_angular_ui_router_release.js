#!env node
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// Publish the alternate npm name from a disposable packed copy. Never rename
// the source manifest or require a historical branch name.
const directory = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'angular-ui-router-release-'));
try {
  const result = JSON.parse(
    execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], {
      cwd: directory,
      encoding: 'utf8',
    })
  )[0];
  execFileSync('tar', ['-xzf', path.join(temporary, result.filename), '-C', temporary]);
  const target = path.join(temporary, 'package');
  const file = path.join(target, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(file));
  if (manifest.name !== '@uirouter/angularjs') throw new Error('Expected the scoped AngularJS package.');
  manifest.name = 'angular-ui-router';
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  execFileSync('npm', ['publish', '--ignore-scripts'], { cwd: target, stdio: 'inherit' });
  fs.rmSync(temporary, { recursive: true, force: true });
} catch (error) {
  console.error(`Legacy publication failed. Packed files remain at ${temporary}; source manifests are unchanged.`);
  throw error;
}
