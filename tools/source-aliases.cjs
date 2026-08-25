'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const repositoryRoot = path.resolve(__dirname, '..');
const contract = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'migration/source-aliases.json'), 'utf8'));

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function specifier(edge) {
  return `${edge.package}${edge.export === '.' ? '' : edge.export.slice(1)}`;
}

function consumerPackage(edge) {
  return JSON.parse(fs.readFileSync(path.join(repositoryRoot, edge.consumer), 'utf8')).name;
}

function edgesForConsumer(packageName) {
  const edges = contract.edges.filter((edge) => consumerPackage(edge) === packageName);
  if (edges.length === 0) throw new Error(`No source-alias edges for ${packageName}`);
  return edges.sort((left, right) => left.precedence - right.precedence || specifier(left).localeCompare(specifier(right)));
}

function sourcePath(edge) {
  return path.join(repositoryRoot, edge.sourceEntrypoint);
}

function viteAliasesFor(packageName) {
  return edgesForConsumer(packageName).map((edge) => ({
    find: new RegExp(`^${escapeRegExp(specifier(edge))}$`),
    replacement: sourcePath(edge),
  }));
}

function watchRootsFor(packageName) {
  return [...new Set(edgesForConsumer(packageName).flatMap((edge) => edge.watchRoots).map((root) => path.join(repositoryRoot, root)))].sort();
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function sourceTypescriptPluginFor(packageName) {
  const roots = watchRootsFor(packageName);
  return {
    name: `uirouter-source-typescript:${packageName}`,
    enforce: 'pre',
    transform(code, id) {
      const filename = id.split('?', 1)[0];
      if (!/\.[cm]?tsx?$/.test(filename) || filename.endsWith('.d.ts')) return null;
      if (!roots.some((root) => isWithin(root, filename))) return null;

      const output = ts.transpileModule(code, {
        fileName: filename,
        compilerOptions: {
          // Source tests require TypeScript's downleveled enumerable methods and parameter-property initialization order.
          target: ts.ScriptTarget.ES5,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.NodeJs,
          jsx: ts.JsxEmit.React,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          useDefineForClassFields: false,
          sourceMap: true,
          inlineSources: true,
          importHelpers: false,
        },
        reportDiagnostics: false,
      });

      return {
        code: output.outputText,
        map: output.sourceMapText ? JSON.parse(output.sourceMapText) : null,
      };
    },
  };
}

function sourceWatchPluginFor(packageName) {
  const roots = watchRootsFor(packageName);
  return {
    name: `uirouter-source-watch:${packageName}`,
    configureServer(server) {
      server.watcher.add(roots);
    },
  };
}

function vitestConfigFor(packageName) {
  const typescriptPlugin = sourceTypescriptPluginFor(packageName);
  const watchPlugin = sourceWatchPluginFor(packageName);
  return {
    aliases: viteAliasesFor(packageName),
    watchRoots: watchRootsFor(packageName),
    typescriptPlugin,
    watchPlugin,
    plugins: [typescriptPlugin, watchPlugin],
    repositoryRoot,
  };
}

function jestModuleNameMapperFor(packageName) {
  const consumer = edgesForConsumer(packageName)[0].consumer;
  const consumerRoot = path.dirname(path.join(repositoryRoot, consumer));
  return Object.fromEntries(edgesForConsumer(packageName).map((edge) => [
    `^${escapeRegExp(specifier(edge))}$`,
    `<rootDir>/${path.relative(consumerRoot, sourcePath(edge)).split(path.sep).join('/')}`,
  ]));
}

function jestWatchRootsFor(packageName) {
  const consumer = edgesForConsumer(packageName)[0].consumer;
  const consumerRoot = path.dirname(path.join(repositoryRoot, consumer));
  return watchRootsFor(packageName).map((root) => `<rootDir>/${path.relative(consumerRoot, root).split(path.sep).join('/')}`);
}

function typescriptPathsFor(packageName) {
  return Object.fromEntries(edgesForConsumer(packageName).map((edge) => [specifier(edge), [edge.sourceEntrypoint]]));
}

function resolveSpecifierForConsumer(consumerManifest, requestedSpecifier) {
  const consumerName = JSON.parse(fs.readFileSync(path.join(repositoryRoot, consumerManifest), 'utf8')).name;
  const edge = edgesForConsumer(consumerName).find((candidate) => specifier(candidate) === requestedSpecifier);
  if (!edge) throw new Error(`No source alias for ${consumerName} -> ${requestedSpecifier}`);
  return sourcePath(edge);
}

module.exports = {
  contract,
  edgesForConsumer,
  jestModuleNameMapperFor,
  jestWatchRootsFor,
  repositoryRoot,
  resolveSpecifierForConsumer,
  sourceTypescriptPluginFor,
  typescriptPathsFor,
  viteAliasesFor,
  vitestConfigFor,
  watchRootsFor,
};
