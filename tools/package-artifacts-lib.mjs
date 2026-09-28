import path from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
export const repository = path.resolve(import.meta.dirname, '..');
export function fail(message) { throw new Error(message); }
export function artifactStem(name, version) { return `${name.replace('@', '').replace('/', '-')}-${version}`; }
function assertUnique(records, selector, label) { if (new Set(records.map(selector)).size !== records.length) fail(`Duplicate ${label}`); }
function validateRelativeSourceMapPath(
  packageId,
  filename,
  label,
  value,
  { allowEmpty = false } = {}
) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    fail(
      `${packageId} source map ${filename} has non-string or empty ${label}`
    );
  }
  if (value === "" && allowEmpty) return;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    fail(`${packageId} source map ${filename} has URI ${label} ${value}`);
  }
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    fail(`${packageId} source map ${filename} has absolute ${label} ${value}`);
  }
  if (value.includes("\\") || path.posix.normalize(value) !== value) {
    fail(
      `${packageId} source map ${filename} has non-normalized ${label} ${value}`
    );
  }
}

export function validateSourceMapReferences(packageId, filename, sourceMap) {
  if (!Array.isArray(sourceMap.sources)) {
    fail(`${packageId} source map ${filename} has non-array sources`);
  }
  const sourceRoot = Object.hasOwn(sourceMap, "sourceRoot")
    ? sourceMap.sourceRoot
    : "";
  validateRelativeSourceMapPath(packageId, filename, "sourceRoot", sourceRoot, {
    allowEmpty: true,
  });
  for (const source of sourceMap.sources) {
    validateRelativeSourceMapPath(packageId, filename, "source", source);
    const combined = path.posix.normalize(path.posix.join(sourceRoot, source));
    const checkoutRelative = combined.replace(/^(?:\.\.\/)+/, "");
    if (/^(?:core|frameworks|plugins|tools)\//.test(checkoutRelative)) {
      fail(
        `${packageId} source map ${filename} has checkout-relative source ${source}`
      );
    }
  }
}

export function normalizeSourceMapReferences(packageId, filename, sourceMap) {
  if (!Array.isArray(sourceMap.sources)) {
    fail(`${packageId} source map ${filename} has non-array sources`);
  }
  const sourceRoot = Object.hasOwn(sourceMap, "sourceRoot")
    ? sourceMap.sourceRoot
    : "";
  validateRelativeSourceMapPath(packageId, filename, "sourceRoot", sourceRoot, {
    allowEmpty: true,
  });
  sourceMap.sources = sourceMap.sources.map((source) => {
    if (typeof source !== "string" || source.length === 0) {
      fail(
        `${packageId} source map ${filename} has non-string or empty source`
      );
    }
    let reference = source;
    const scheme = source.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
    if (scheme) {
      if (sourceRoot !== "" || scheme[1].toLowerCase() !== "webpack") {
        fail(`${packageId} source map ${filename} has URI source ${source}`);
      }
      const parts = source
        .slice(scheme[0].length)
        .replace(/^\/+/, "")
        .split("/");
      if (parts.length > 1 && parts[1] === ".") parts.shift();
      reference = parts.join("/").replace(/^\.\//, "");
    } else {
      validateRelativeSourceMapPath(packageId, filename, "source", source);
      reference = path.posix.join(sourceRoot, source);
    }
    const mapDirectory = path.posix.dirname(filename);
    const resolved = path.posix.normalize(
      path.posix.join(mapDirectory, reference)
    );
    const checkoutRelative = reference.replace(/^(?:\.\.\/)+/, "");
    if (
      resolved === ".." ||
      resolved.startsWith("../") ||
      /^(?:core|frameworks|plugins|tools|node_modules)\//.test(checkoutRelative)
    ) {
      let portable = checkoutRelative
        .replace(/^node_modules\//, "dependencies/")
        .replace(/^core\/lib-esm\//, "dependencies/uirouter-core/");
      if (!portable.startsWith("dependencies/"))
        portable = `sources/${portable}`;
      reference = portable;
    } else {
      reference =
        path.posix.relative(mapDirectory, resolved) ||
        path.posix.basename(resolved);
    }
    return reference;
  });
  sourceMap.sourceRoot = "";
  validateSourceMapReferences(packageId, filename, sourceMap);
  return sourceMap;
}

export function matchesPackPattern(pattern, filename) {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return filename === prefix || filename.startsWith(`${prefix}/`);
  }
  return filename === pattern;
}

export function validatePackedFileList(contract, packageRecord, filenames) {
  assertUnique(
    filenames,
    (filename) => filename,
    `${packageRecord.id} packed files`
  );
  const forbidden = contract.artifactPolicy.forbiddenPatterns.map(
    (pattern) => new RegExp(pattern)
  );
  for (const filename of filenames) {
    if (
      path.posix.isAbsolute(filename) ||
      filename === ".." ||
      filename.startsWith("../") ||
      filename.includes("/../")
    ) {
      fail(`${packageRecord.id} packed path escapes package: ${filename}`);
    }
    if (
      !packageRecord.pack.allowed.some((pattern) =>
        matchesPackPattern(pattern, filename)
      )
    ) {
      fail(`${packageRecord.id} packs undeclared file ${filename}`);
    }
    const rejectedBy = forbidden.find((pattern) => pattern.test(filename));
    if (rejectedBy)
      fail(
        `${packageRecord.id} packs forbidden file ${filename} (${rejectedBy})`
      );
  }
  for (const required of packageRecord.pack.required) {
    if (!filenames.includes(required))
      fail(`${packageRecord.id} is missing required packed file ${required}`);
  }
}

export async function packageRecordForCwd(cwd, root = repository) {
  const contract = JSON.parse(await readFile(path.join(root, 'tools/packages.json'), 'utf8'));
  for (const record of contract.packages) {
    const packageRoot = path.join(root, path.dirname(record.manifest));
    if (await realpath(packageRoot) !== await realpath(cwd)) continue;
    const manifest = JSON.parse(await readFile(path.join(root, record.manifest), 'utf8'));
    if (manifest.name !== record.package) fail(`Package name differs: ${record.manifest}`);
    return { contract, packageRecord: { ...record, version: manifest.version }, packageRoot };
  }
  fail(`Unknown package directory: ${cwd}`);
}
