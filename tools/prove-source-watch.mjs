#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const contract = JSON.parse(readFileSync(path.join(root, 'migration/source-aliases.json'), 'utf8'));
const edgeFlag = process.argv.indexOf('--edge');
const selectedEdge = edgeFlag === -1 ? null : process.argv[edgeFlag + 1];
if (edgeFlag !== -1 && !selectedEdge) throw new Error('usage: node tools/prove-source-watch.mjs [--edge <edge-id>]');

const lanes = contract.edges
  .filter((edge) => !selectedEdge || edge.id === selectedEdge)
  .map((edge) => {
    const packageName = JSON.parse(readFileSync(path.join(root, edge.consumer), 'utf8')).name;
    const usesJest = edge.adapters.jest !== 'not-applicable';
    return {
      edgeId: edge.id,
      packageName,
      probePath: path.join(root, edge.sourceEntrypoint),
      probeRelative: edge.sourceEntrypoint,
      ignoredPaths: edge.ignoredPaths,
      marker: usesJest ? /Test Suites:\s+\d+ passed/g : /Test Files\s+\d+ passed/g,
    };
  });
if (lanes.length === 0) throw new Error(`unknown source-alias edge: ${selectedEdge}`);

const stripAnsi = (value) => value.replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '');

function stopGroup(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

let activeChild = null;
let activeRestore = null;
function cleanupActive() {
  activeRestore?.();
  stopGroup(activeChild);
  activeRestore = null;
  activeChild = null;
}
process.once('SIGINT', () => { cleanupActive(); process.exit(130); });
process.once('SIGTERM', () => { cleanupActive(); process.exit(143); });
process.once('exit', cleanupActive);

async function proveLane({ edgeId, packageName, probePath, probeRelative, ignoredPaths, marker }) {
  const original = readFileSync(probePath);
  const token = `\n// source-watch-probe:${edgeId}:${process.pid}\n`;
  let output = '';
  let runs = 0;
  let changed = false;
  let settled = false;

  for (const ignored of ignoredPaths) {
    if (existsSync(path.join(root, ignored))) throw new Error(`${edgeId} requires an artifact-free source lane; remove ${ignored}`);
  }

  function restore() {
    if (changed) {
      writeFileSync(probePath, original);
      changed = false;
    }
  }
  activeRestore = restore;
  const child = spawn('npm', ['run', 'test:watch', `--workspace=${packageName}`], {
    cwd: root,
    detached: true,
    env: { ...process.env, CI: 'false', FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeChild = child;

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`${edgeId} watch proof timed out after ${runs} observed run(s)`)), 120_000);

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cleanupActive();
      if (error) {
        const tail = stripAnsi(output).split('\n').slice(-60).join('\n');
        reject(new Error(`${error.message}\n${tail}`));
      } else {
        resolve();
      }
    }

    function consume(data) {
      output += data.toString();
      const observed = [...stripAnsi(output).matchAll(marker)].length;
      if (observed <= runs) return;
      runs = observed;
      if (runs === 1) {
        changed = true;
        writeFileSync(probePath, Buffer.concat([original, Buffer.from(token)]));
      } else if (runs >= 2) {
        finish();
      }
    }

    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.on('error', finish);
    child.on('exit', (code, signal) => {
      if (!settled) finish(new Error(`${edgeId} watch process exited before rerun (code=${code}, signal=${signal})`));
    });
  });

  console.log(`SOURCE_WATCH_OK edge=${edgeId} package=${packageName} upstream=${probeRelative} runs=2`);
}

for (const lane of lanes) await proveLane(lane);
console.log(`S02_SOURCE_WATCH_PROOF_OK edges=${lanes.length} consumers=${new Set(lanes.map((lane) => lane.packageName)).size} runs=${lanes.length * 2}`);
