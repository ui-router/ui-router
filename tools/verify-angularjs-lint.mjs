#!/usr/bin/env node

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const repository = realpathSync(path.join(import.meta.dirname, ".."));
const workspace = "frameworks/angularjs/uirouter-angularjs";

function fail(message) {
  throw new Error(`ANGULARJS_LINT_FAILED: ${message}`);
}
function readJson(relative) {
  return JSON.parse(readFileSync(path.join(repository, relative), "utf8"));
}
function sha256(relative) {
  return crypto
    .createHash("sha256")
    .update(readFileSync(path.join(repository, relative)))
    .digest("hex");
}
function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] !== "--output" || !process.argv[index + 1])
    fail(`unknown argument ${process.argv[index]}`);
  index += 1;
}

const angularjsManifest = readJson(`${workspace}/package.json`);
const expected = {
  eslint: "^9.28.0",
  "typescript-eslint": "^8.51.0",
  "@eslint/js": "^9.28.0",
  globals: "^13.24.0",
  "eslint-config-prettier": "^6.11.0",
};
const dependencyNames = Object.keys(expected);
const declared = Object.fromEntries(
  dependencyNames.map((name) => [
    name,
    angularjsManifest.devDependencies?.[name],
  ])
);
if (JSON.stringify(declared) !== JSON.stringify(expected))
  fail(
    `AngularJS lint declarations differ from the ESLint 9 lane: ${JSON.stringify(
      declared
    )}`
  );
if (angularjsManifest.scripts.lint !== 'eslint "src/**/*.ts"')
  fail(
    "lint must cover the complete src TypeScript tree without shell glob expansion"
  );
if (existsSync(path.join(repository, workspace, ".eslintrc.js")))
  fail("legacy ESLint configuration remains");
for (const name of [
  "@typescript-eslint/parser",
  "@typescript-eslint/eslint-plugin",
])
  if (angularjsManifest.devDependencies?.[name])
    fail(`legacy direct tool declaration remains: ${name}`);

const packageLock = readJson("package-lock.json");
const workspaceRequire = createRequire(
  path.join(repository, workspace, "package.json")
);
const resolvedPaths = {};
const resolved = Object.fromEntries(
  dependencyNames.map((name) => {
    const filename = realpathSync(
      workspaceRequire.resolve(`${name}/package.json`)
    );
    const relative = path
      .relative(repository, path.dirname(filename))
      .split(path.sep)
      .join("/");
    if (relative.startsWith("../") || path.isAbsolute(relative))
      fail(`lint dependency escapes the repository: ${name}`);
    const version = JSON.parse(readFileSync(filename, "utf8")).version;
    if (
      packageLock.packages[relative]?.version !== version ||
      packageLock.packages[workspace]?.devDependencies?.[name] !==
        declared[name]
    )
      fail(`installed/declared lint dependency differs from lock: ${name}`);
    resolvedPaths[name] = relative;
    return [name, version];
  })
);
if (
  !resolved.eslint.startsWith("9.") ||
  !resolved["typescript-eslint"].startsWith("8.")
)
  fail("resolved lint toolchain must use ESLint 9 and typescript-eslint 8");
const typescriptRequire = createRequire(
  workspaceRequire.resolve("typescript-eslint/package.json")
);
for (const name of [
  "@typescript-eslint/parser",
  "@typescript-eslint/eslint-plugin",
]) {
  const dependency = typescriptRequire(`${name}/package.json`);
  if (dependency.version !== resolved["typescript-eslint"])
    fail(`typescript-eslint companion version differs: ${name}`);
}

const environment = { ...process.env };
delete environment.NODE_PATH;
for (const key of Object.keys(environment)) {
  if (key.toLowerCase().startsWith("npm_config_")) delete environment[key];
}
const lintArguments = [
  "--silent",
  "--workspace",
  "@uirouter/angularjs",
  "run",
  "lint",
  "--",
  "--format",
  "json",
];
const lint = spawnSync("npm", lintArguments, {
  cwd: repository,
  env: environment,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});
if (lint.status !== 0)
  fail(`lint exited ${lint.status}: ${(lint.stderr || lint.stdout).trim()}`);

const lintResults = JSON.parse(lint.stdout);
const sourceFiles = [];
function collectSource(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) collectSource(filename);
    else if (entry.isFile() && entry.name.endsWith(".ts"))
      sourceFiles.push(filename);
  }
}
collectSource(path.join(repository, workspace, "src"));
if (
  !sourceFiles.length ||
  JSON.stringify(lintResults.map((result) => result.filePath).sort()) !==
    JSON.stringify(sourceFiles.sort())
)
  fail(
    "lint result coverage differs from the complete TypeScript source inventory"
  );
const { ESLint } = workspaceRequire("eslint");
const eslint = new ESLint({ cwd: path.join(repository, workspace) });
for (const filePath of ["src/lint-proof.ts", "src/directives/lint-proof.ts"]) {
  const [result] = await eslint.lintText(
    "const unused = 1; debugger; export type Empty = {}; export type Boxed = String;",
    { filePath }
  );
  for (const ruleId of [
    "no-debugger",
    "@typescript-eslint/no-unused-vars",
    "@typescript-eslint/no-empty-object-type",
    "@typescript-eslint/no-wrapper-object-types",
  ])
    if (
      !result.messages.some(
        (message) => message.ruleId === ruleId && message.severity === 2
      )
    )
      fail(`${filePath}: expected error from ${ruleId}`);
}
const interfaceException = readFileSync(
  path.join(repository, workspace, "src/directives/stateDirectives.ts"),
  "utf8"
).split("\n")[0];
const [exceptionResult] = await eslint.lintText(
  `${interfaceException}\nexport interface EmptyInterface {}\nexport type EmptyObject = {};`,
  { filePath: "src/directives/stateDirectives.ts" }
);
if (
  exceptionResult.messages.length !== 1 ||
  exceptionResult.messages[0].ruleId !==
    "@typescript-eslint/no-empty-object-type" ||
  exceptionResult.messages[0].line !== 3 ||
  exceptionResult.messages[0].severity !== 2
)
  fail("empty-interface exception must still reject empty object types");
const [legacyTypes] = await eslint.lintText(
  "export type Callback = Function; export type Store = any; export function caught() { try { throw new Error(); } catch (err) { return 1; } }",
  { filePath: "src/lint-proof.ts" }
);
if (legacyTypes.errorCount)
  fail("legacy Function/any/catch-variable policy changed");
const evidence = {
  schemaVersion: 1,
  status: "passed",
  workspace,
  command: ["npm", ...lintArguments],
  declared,
  resolved,
  resolvedPaths,
  sourceFileCount: sourceFiles.length,
  negativeProbes: 9,
  configSha256: sha256(`${workspace}/eslint.config.mjs`),
  packageManifestSha256: sha256(`${workspace}/package.json`),
  packageLockSha256: sha256("package-lock.json"),
};

const outputArgument = argument("--output");
if (outputArgument) {
  const output = path.resolve(repository, outputArgument);
  const allowed = path.join(repository, ".ci-results", "source");
  const relation = path.relative(allowed, output);
  if (relation.startsWith("..") || path.isAbsolute(relation))
    fail("output must remain under .ci-results/source");
  mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`);
  renameSync(temporary, output);
}

console.log(
  `ANGULARJS_LINT_OK eslint=${resolved.eslint} typescriptEslint=${resolved["typescript-eslint"]} sourceFiles=${sourceFiles.length} negativeProbes=9`
);
