#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const projects = [
  {
    id: "core",
    package: "@uirouter/core",
    directory: "core",
  },
  {
    id: "angular",
    package: "@uirouter/angular",
    directory: "frameworks/angular/uirouter-angular",
  },
  {
    id: "angularjs",
    package: "@uirouter/angularjs",
    directory: "frameworks/angularjs/uirouter-angularjs",
  },
  {
    id: "react",
    package: "@uirouter/react",
    directory: "frameworks/react/uirouter-react",
  },
];

function fail(message) {
  throw new Error(`API_DOCS_FAILED: ${message}`);
}
function value(name) {
  const indexes = process.argv
    .map((argument, index) => (argument === name ? index : -1))
    .filter((index) => index !== -1);
  if (indexes.length > 1) fail(`${name} may appear only once`);
  return indexes.length ? process.argv[indexes[0] + 1] : null;
}
const known = new Set(["--all", "--project", "--output-root"]);
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (!known.has(argument)) fail(`unknown argument ${argument}`);
  if (argument !== "--all") {
    if (!process.argv[index + 1] || process.argv[index + 1].startsWith("--"))
      fail(`${argument} requires a value`);
    index += 1;
  }
}
const all = process.argv.includes("--all");
const projectId = value("--project");
if (all === Boolean(projectId))
  fail("select exactly one of --all or --project");
const selected = all
  ? projects
  : projects.filter((project) => project.id === projectId);
if (!selected.length) fail(`unknown project ${projectId}`);

function safeDocsPath(argument, label) {
  const root = path.join(repository, ".ci-results", "docs");
  const resolved = path.resolve(repository, argument);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    fail(`${label} must remain under .ci-results/docs`);
  return resolved;
}
const outputRootArgument = value("--output-root");
const outputRoot = outputRootArgument
  ? safeDocsPath(outputRootArgument, "output root")
  : null;
const typedoc = path.join(repository, "node_modules", "typedoc", "bin", "typedoc");
if (!existsSync(typedoc)) fail("TypeDoc executable is not installed");

function digestDirectory(directory) {
  const files = [];
  function walk(current, relative = "") {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name)
    )) {
      const absolute = path.join(current, entry.name);
      const name = path.posix.join(relative, entry.name);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) fail(`generated output contains symlink ${name}`);
      if (info.isDirectory()) walk(absolute, name);
      else if (info.isFile()) {
        files.push({ path: name, size: info.size });
      } else fail(`generated output contains unsupported entry ${name}`);
    }
  }
  walk(directory);
  return {
    fileCount: files.length,
    bytes: files.reduce((total, file) => total + file.size, 0),
  };
}

const results = [];
for (const project of selected) {
  const directory = path.join(repository, project.directory);
  const config = path.join(directory, "typedoc.json");
  const configValue = JSON.parse(readFileSync(config, "utf8"));
  const tsconfig = path.resolve(directory, configValue.tsconfig);
  if (!existsSync(tsconfig)) fail(`${project.id} TypeScript config is missing`);
  const output = outputRoot
    ? path.join(outputRoot, project.id)
    : path.join(directory, "_doc");
  rmSync(output, { recursive: true, force: true });
  mkdirSync(path.dirname(output), { recursive: true });
  const result = spawnSync(
    process.execPath,
    [typedoc, "--options", config, "--out", output],
    {
      cwd: directory,
      env: { ...process.env, NO_COLOR: "1" },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.status !== 0)
    fail(`${project.id} TypeDoc exited ${result.status ?? result.signal}`);
  if (!existsSync(path.join(output, "index.html")))
    fail(`${project.id} did not generate index.html`);
  const digest = digestDirectory(output);
  if (digest.fileCount < 5 || digest.bytes < 1_000)
    fail(`${project.id} generated output is unexpectedly small`);
  results.push(digest);
}
console.log(`API_DOCS_OK projects=${results.length}`);
