import { generateDeploymentOpenApiModule } from './writeDeploymentModule';

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

const { outputPath, contractCount } = await generateDeploymentOpenApiModule();

console.log(`[openapi] wrote ${outputPath} (${contractCount} add-on contract(s))`);
