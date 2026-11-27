import { createRequire } from 'node:module';
import exclusions from './excluded-commits.json' with { type: 'json' };

const { ManifestPlugin } = createRequire(import.meta.url)('release-please/build/src/plugin.js');

export class ExcludeHousekeeping extends ManifestPlugin {
  processCommits(commits) {
    return commits.filter(commit => !Object.hasOwn(exclusions, commit.sha));
  }
}
