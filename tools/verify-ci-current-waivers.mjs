#!/usr/bin/env node

import crypto from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
function fail(message) {
  throw new Error(`CI_CURRENT_WAIVERS_FAILED: ${message}`);
}
function value(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}
for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] !== "--output" || !process.argv[index + 1])
    fail(`unknown argument ${process.argv[index]}`);
  index += 1;
}
const outputArgument = value("--output");
if (!outputArgument) fail("--output is required");
const output = path.resolve(repository, outputArgument);
const allowed = path.join(repository, ".ci-results", "source");
const relation = path.relative(allowed, output);
if (relation.startsWith("..") || path.isAbsolute(relation))
  fail("output must remain under .ci-results/source");
const sha256 = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const contractBytes = readFileSync(
  path.join(repository, "migration/ci-gates.json")
);
const contract = JSON.parse(contractBytes);
const matrix = JSON.parse(
  readFileSync(
    path.join(repository, "migration/integration-matrix.json"),
    "utf8"
  )
);
const react16 = matrix.projects.find(
  (project) => project.id === "framework/react-hybrid/integration/react16"
);
const expectedReact = {
  id: react16.waiver.baselineId,
  projectId: react16.id,
  ...react16.waiver,
};
const angular = contract.currentWaivers.find(
  (waiver) => waiver.id === "angularjs-eslint-root-resolution"
);
if (
  JSON.stringify(contract.currentWaivers[0]) !==
    JSON.stringify(expectedReact) ||
  contract.currentWaivers.length !== 2 ||
  !angular ||
  angular.projectId !== "frameworks/angularjs/uirouter-angularjs" ||
  angular.baselineId !== "angularjs.manifest.root.static" ||
  angular.owner !== "ui-router-maintainers" ||
  angular.trackingIssue !== "https://github.com/ui-router/ui-router/issues/22"
)
  fail("current waiver inventory differs");
for (const waiver of contract.currentWaivers)
  if (Date.parse(`${waiver.expires}T23:59:59Z`) <= Date.now())
    fail(`${waiver.id} is expired`);

const versions = {
  rootEslint: JSON.parse(
    readFileSync(
      path.join(repository, "node_modules/eslint/package.json"),
      "utf8"
    )
  ).version,
  angularjsEslint: JSON.parse(
    readFileSync(
      path.join(
        repository,
        "frameworks/angularjs/uirouter-angularjs/node_modules/eslint/package.json"
      ),
      "utf8"
    )
  ).version,
  angularjsTypescriptEslint: JSON.parse(
    readFileSync(
      path.join(
        repository,
        "frameworks/angularjs/uirouter-angularjs/node_modules/@typescript-eslint/eslint-plugin/package.json"
      ),
      "utf8"
    )
  ).version,
  hoistedExperimentalUtils: JSON.parse(
    readFileSync(
      path.join(
        repository,
        "node_modules/@typescript-eslint/experimental-utils/package.json"
      ),
      "utf8"
    )
  ).version,
};
if (
  JSON.stringify(versions) !==
  JSON.stringify({
    rootEslint: "8.57.1",
    angularjsEslint: "7.32.0",
    angularjsTypescriptEslint: "3.10.1",
    hoistedExperimentalUtils: "3.10.1",
  })
)
  fail(`AngularJS lint dependency graph changed: ${JSON.stringify(versions)}`);
const environment = { ...process.env };
delete environment.NODE_PATH;
for (const key of Object.keys(environment))
  if (key.toLowerCase().startsWith("npm_config_")) delete environment[key];
const lint = spawnSync(
  "npm",
  ["--workspace", "@uirouter/angularjs", "run", "lint"],
  {
    cwd: repository,
    env: environment,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }
);
const combined = `${lint.stdout ?? ""}\n${lint.stderr ?? ""}`;
if (
  lint.status !== 2 ||
  !combined.includes("Failed to load plugin '@typescript-eslint'") ||
  !combined.includes(
    "Class extends value undefined is not a constructor or null"
  ) ||
  !combined.includes("ESLint: 7.32.0")
)
  fail("AngularJS lint no longer matches its exact waived failure");
const evidence = {
  schemaVersion: 1,
  status: "waived-failure",
  waiver: angular,
  ciContractSha256: sha256(contractBytes),
  packageLockSha256: sha256(
    readFileSync(path.join(repository, "package-lock.json"))
  ),
  command: ["npm", "--workspace", "@uirouter/angularjs", "run", "lint"],
  exitStatus: lint.status,
  versions,
  signatures: [
    "Failed to load plugin '@typescript-eslint'",
    "Class extends value undefined is not a constructor or null",
    "ESLint: 7.32.0",
  ],
};
mkdirSync(path.dirname(output), { recursive: true });
const temporary = `${output}.tmp-${process.pid}`;
writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`);
renameSync(temporary, output);
console.log(
  `CI_CURRENT_WAIVERS_OK active=${contract.currentWaivers.length} angularjsLintStatus=${lint.status}`
);
