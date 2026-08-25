#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = realpathSync(path.resolve(import.meta.dirname, '..'));
const contract = JSON.parse(readFileSync(path.join(root, 'migration/source-aliases.json'), 'utf8'));
const commands = new Map();
for (const edge of contract.edges) {
  for (const adapter of Object.values(edge.adapters).filter((candidate) => candidate !== 'not-applicable')) {
    for (const command of [adapter.positiveTest, adapter.negativeProductionTest]) {
      commands.set(JSON.stringify(command), command);
    }
  }
}

for (const command of commands.values()) {
  const cwd = path.resolve(root, command.cwd);
  if (cwd !== root && !cwd.startsWith(`${root}${path.sep}`)) throw new Error(`SOURCE_COMMAND_FAILED cwd escapes repository: ${command.cwd}`);
  const [executable, ...args] = command.argv;
  const result = spawnSync(executable, args, {
    cwd,
    env: { ...process.env, ...command.environment, FORCE_COLOR: '0', NO_COLOR: '1' },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== command.expectedStatus) {
    throw new Error(`SOURCE_COMMAND_FAILED cwd=${command.cwd} argv=${JSON.stringify(command.argv)} expected=${command.expectedStatus} actual=${result.status}\n${result.stdout}\n${result.stderr}`);
  }
}

console.log(`S02_SOURCE_COMMAND_PROOF_OK commands=${commands.size} positive=${contract.edges.length} production=${contract.edges.length}`);
