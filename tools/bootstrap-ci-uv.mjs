#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const contract = JSON.parse(
  readFileSync(path.join(repository, "migration/ci-gates.json"), "utf8")
);
const { uv } = contract.runtime;

function fail(message) {
  throw new Error(`CI_UV_BOOTSTRAP_FAILED: ${message}`);
}

function download(url, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error("too many redirects"));
  const target = new URL(url);
  if (target.protocol !== "https:")
    return Promise.reject(new Error("download URL must use HTTPS"));
  return new Promise((resolve, reject) => {
    const request = https.get(target, { timeout: 60_000 }, (response) => {
      const location = response.headers.location;
      if (response.statusCode >= 300 && response.statusCode < 400 && location) {
        response.resume();
        resolve(download(new URL(location, target).href, redirects + 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`download returned HTTP ${response.statusCode}`));
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("download timed out")));
    request.on("error", reject);
  });
}

const workspace = mkdtempSync(path.join(os.tmpdir(), "uirouter-ci-uv-"));
try {
  const archive = await download(uv.archiveUrl);
  const actualSha256 = createHash("sha256").update(archive).digest("hex");
  if (actualSha256 !== uv.archiveSha256)
    fail("downloaded archive digest differs");
  const archivePath = path.join(workspace, "uv.tar.gz");
  const bin = path.join(workspace, "bin");
  writeFileSync(archivePath, archive);
  mkdirSync(bin);
  const extracted = spawnSync(
    "tar",
    ["-xzf", archivePath, "--strip-components=1", "-C", bin],
    { encoding: "utf8" }
  );
  if (extracted.status !== 0)
    fail(`could not extract archive: ${extracted.stderr.trim()}`);
  const executable = path.join(bin, "uv");
  chmodSync(executable, 0o755);
  const version = spawnSync(executable, ["--version"], { encoding: "utf8" });
  if (version.status !== 0)
    fail(`uv version probe failed: ${version.stderr.trim()}`);
  if (version.stdout.trim() !== uv.versionOutput)
    fail(`uv version differs: ${version.stdout.trim()}`);
  if (!process.env.GITHUB_PATH)
    fail("GITHUB_PATH is required to expose uv to the gate step");
  appendFileSync(process.env.GITHUB_PATH, `${bin}\n`);
  console.log(`CI_UV_BOOTSTRAP_OK version=${uv.version} sha256=${actualSha256}`);
} catch (error) {
  rmSync(workspace, { recursive: true, force: true });
  throw error;
}
