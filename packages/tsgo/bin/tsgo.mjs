#!/usr/bin/env node
// TypeScript 7's bin is `tsc`, and pnpm links the higher version when two `typescript` packages
// share an importer, so it lives here, away from the classic 5.9 `tsc`, and runs as `tsgo`.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const manifestPath = require.resolve('typescript-7/package.json');
const { bin } = require(manifestPath);

await import(pathToFileURL(join(dirname(manifestPath), bin.tsc)).href);
