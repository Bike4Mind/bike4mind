import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from './document';

/**
 * Build-time entry: emit the OpenAPI 3.1 spec to apps/client/public/openapi.json.
 * Run via `pnpm --filter @bike4mind/common openapi:generate` (or the root
 * `pnpm turbo:openapi:generate`). CI regenerates and diffs the committed file to
 * fail on drift.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const outputPath = resolve(repoRoot, 'apps/client/public/openapi.json');

// API version tracks this package's semver (single source; bumped on release).
const pkg = JSON.parse(readFileSync(resolve(here, '../../package.json'), 'utf8')) as { version: string };

const document = buildOpenApiDocument(pkg.version);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(document, null, 2) + '\n', 'utf8');

console.log(`[openapi] wrote ${outputPath} (v${pkg.version})`);
