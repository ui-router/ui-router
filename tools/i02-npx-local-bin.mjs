#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const [command, ...args] = process.argv.slice(2);
if (command !== "serve") {
  console.error(
    `I02 local npx adapter only permits serve, got ${command ?? "<missing>"}`
  );
  process.exit(64);
}
const executable = path.join(process.cwd(), "node_modules", ".bin", "serve");
if (!existsSync(executable)) {
  console.error(`I02 local npx adapter cannot find ${executable}`);
  process.exit(69);
}
const result = spawnSync(executable, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});
if (result.error) {
  console.error(result.error.message);
  process.exit(70);
}
process.exit(result.status ?? 70);
