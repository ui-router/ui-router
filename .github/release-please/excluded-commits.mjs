import { createRequire } from 'node:module';
import exclusions from './excluded-commits.json' with { type: 'json' };

const { ManifestPlugin } = createRequire(import.meta.url)('release-please/build/src/plugin.js');

export class ExcludeHousekeeping extends ManifestPlugin {
  // Release Please has already found tag boundaries and split commits by package.
  async preconfigure(strategies, commitsByPath) {
    for (const [path, commits] of Object.entries(commitsByPath)) {
      const component = this.repositoryConfig[path].component;
      const excluded = new Set(exclusions.filter(rule => rule.components.includes(component)).flatMap(rule => rule.commits));
      commitsByPath[path] = commits.filter(commit => !excluded.has(commit.sha));
    }
    return strategies;
  }
}
