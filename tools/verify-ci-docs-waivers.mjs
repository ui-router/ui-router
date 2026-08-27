#!/usr/bin/env node

import crypto from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
function value(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}
for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] !== "--output" || !process.argv[index + 1])
    throw new Error(
      `DOCS_WAIVER_FAILED: unknown argument ${process.argv[index]}`
    );
  index += 1;
}
const outputArgument = value("--output");
if (!outputArgument)
  throw new Error("DOCS_WAIVER_FAILED: --output is required");
const output = path.resolve(repository, outputArgument);
const allowed = path.join(repository, ".ci-results", "docs");
const relative = path.relative(allowed, output);
if (relative.startsWith("..") || path.isAbsolute(relative))
  throw new Error(
    "DOCS_WAIVER_FAILED: output must remain under .ci-results/docs"
  );
const sha256 = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const contractBytes = readFileSync(
  path.join(repository, "migration/ci-gates.json")
);
const contract = JSON.parse(contractBytes);
const baselineBytes = readFileSync(
  path.join(repository, "migration/baselines.json")
);
const baselines = JSON.parse(baselineBytes);
if (sha256(baselineBytes) !== contract.bindings.baselinesSha256)
  throw new Error("DOCS_WAIVER_FAILED: baseline binding differs");
const docs = baselines.entries.filter((entry) => entry.lane === "docs");
if (docs.length !== 4 || contract.docsWaivers.length !== 4)
  throw new Error("DOCS_WAIVER_FAILED: expected exactly four docs waivers");
const byId = new Map(docs.map((entry) => [entry.id, entry]));
const records = contract.docsWaivers.map((record) => {
  const source = byId.get(record.baselineId);
  if (!source || source.result !== "waived-failure")
    throw new Error(
      `DOCS_WAIVER_FAILED: ${record.baselineId} is not a waived docs baseline`
    );
  if (
    JSON.stringify(record.evidence) !== JSON.stringify(source.evidence) ||
    JSON.stringify(record.waiver) !== JSON.stringify(source.waiver)
  )
    throw new Error(`DOCS_WAIVER_FAILED: ${record.baselineId} waiver differs`);
  if (Date.parse(`${record.waiver.expires}T23:59:59Z`) <= Date.now())
    throw new Error(`DOCS_WAIVER_FAILED: ${record.baselineId} waiver expired`);
  return {
    baselineId: record.baselineId,
    status: "waived-failure",
    owner: record.waiver.owner,
    reason: record.waiver.reason,
    trackingIssue: record.waiver.trackingIssue,
    expires: record.waiver.expires,
    evidenceSha256: record.evidence.sha256,
  };
});
mkdirSync(path.dirname(output), { recursive: true });
const temporary = `${output}.tmp-${process.pid}`;
writeFileSync(
  temporary,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      status: "ok",
      baselinesSha256: sha256(baselineBytes),
      contractSha256: sha256(contractBytes),
      records,
    },
    null,
    2
  )}\n`
);
renameSync(temporary, output);
console.log(
  `CI_DOCS_WAIVERS_OK count=${records.length} output=${outputArgument}`
);
