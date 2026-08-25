const sourceAliases = require('../../../tools/source-aliases.cjs');
const sourcePackage = '@uirouter/angularjs';
const NG = process.env.NG || '1.7';

console.log(`Testing with AngularJS ${NG}`);

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  roots: ['src', 'test', ...sourceAliases.jestWatchRootsFor(sourcePackage)],
  // Jest transpiles the source-linked lane; the separate typecheck script owns diagnostics.
  globals: {
    'ts-jest': {
      diagnostics: false,
      isolatedModules: true,
      tsconfig: './tsconfig.source.json',
    },
  },
  testMatch: ['**/__tests__/**/*.[jt]s?(x)', '**/?(*.)+(spec|test).[jt]s?(x)', '**/?*Spec.[jt]s'],
  setupFilesAfterEnv: ['./test/jest.init.ts'],
  moduleNameMapper: {
    ...sourceAliases.jestModuleNameMapperFor(sourcePackage),
    '^angular$': '<rootDir>/test/angular/jest-angular.js',
    '^jest-angular-import$': `<rootDir>/test/angular/${NG}/angular.js`,
    '^angular-animate$': `<rootDir>/test/angular/${NG}/angular-animate.js`,
    '^angular-mocks$': `<rootDir>/test/angular/${NG}/angular-mocks.js`,
  },
};
