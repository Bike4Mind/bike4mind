import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MONOREPO_ROOT, writeDeploymentOpenApiModule } from './writeDeploymentModule';

/**
 * Build-time entry for the deployment spec served at /api/v1/openapi.deployment.json.
 * Run via `pnpm --filter @bike4mind/common openapi:generate:deployment`; the client
 * prebuild/predev run it after the premium glue codegen, which emits the contract list
 * this reads.
 *
 * The list is loaded by path, not imported, so this package neither typechecks against
 * add-on sources nor fails when the gitignored file is missing (an install-only checkout):
 * missing means no add-on contracts. The committed apps/client/public/openapi.json is
 * never touched - generate.ts owns it.
 */

const pkg = JSON.parse(readFileSync(resolve(MONOREPO_ROOT, 'b4m-core/common/package.json'), 'utf8')) as {
  version: string;
};

const { outputPath, contractCount } = await writeDeploymentOpenApiModule({
  repoRoot: MONOREPO_ROOT,
  version: pkg.version,
});

console.log(`[openapi] wrote ${outputPath} (${contractCount} add-on contract(s))`);
