#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message) {
  throw new Error(message);
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const graphPath = path.join(repository, 'migration', 'work-graph.json');
const specPath = path.join(repository, 'SPEC.md');
const graph = JSON.parse(await readFile(graphPath, 'utf8'));
if (graph.schemaVersion !== 1 || !Array.isArray(graph.tasks)) fail('Unsupported work-graph schema');

const dependencies = new Map();
for (const task of graph.tasks) {
  if (!/^[A-Z][A-Z0-9]*$/.test(task.id) || !Array.isArray(task.dependsOn)) fail('Malformed work-graph task');
  if (dependencies.has(task.id)) fail(`Duplicate task ID: ${task.id}`);
  if (new Set(task.dependsOn).size !== task.dependsOn.length) fail(`${task.id} repeats a dependency`);
  dependencies.set(task.id, task.dependsOn);
}
for (const [id, taskDependencies] of dependencies) {
  for (const dependency of taskDependencies) {
    if (!dependencies.has(dependency)) fail(`${id} depends on unknown task ${dependency}`);
    if (dependency === id) fail(`${id} depends on itself`);
  }
}

const visiting = new Set();
const visited = new Set();
function visit(id, trail) {
  if (visiting.has(id)) fail(`Dependency cycle: ${[...trail, id].join(' -> ')}`);
  if (visited.has(id)) return;
  visiting.add(id);
  for (const dependency of dependencies.get(id)) visit(dependency, [...trail, id]);
  visiting.delete(id);
  visited.add(id);
}
for (const id of dependencies.keys()) visit(id, []);

const specTasks = new Map();
for (const line of (await readFile(specPath, 'utf8')).split('\n')) {
  const match = line.match(/^\| `([A-Z][A-Z0-9]*)` \|/);
  if (!match) continue;
  const columns = line.split('|');
  const id = match[1];
  const dependencyCell = columns[3]?.trim();
  const parsedDependencies = dependencyCell === '—' ? [] : [...dependencyCell.matchAll(/`([A-Z][A-Z0-9]*)`/g)].map((item) => item[1]);
  specTasks.set(id, parsedDependencies);
}
if (specTasks.size !== dependencies.size) fail('SPEC task table and work graph have different task counts');
for (const [id, taskDependencies] of dependencies) {
  const documented = specTasks.get(id);
  if (!documented || JSON.stringify(documented) !== JSON.stringify(taskDependencies)) {
    fail(`${id} dependencies differ between SPEC.md and migration/work-graph.json`);
  }
}

for (const [id, required] of Object.entries({ H02: ['N00'], H03R: ['H03', 'B03', 'N00'], N01: ['H05'], N02: ['H05'], S01: ['N05'], I01: ['H05'] })) {
  for (const dependency of required) {
    if (!dependencies.get(id).includes(dependency)) fail(`${id} must explicitly depend on ${dependency}`);
  }
}

console.log(`WORK_GRAPH_OK tasks=${dependencies.size}`);
