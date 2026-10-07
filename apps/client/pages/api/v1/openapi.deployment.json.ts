import openapiSpec from '@public/openapi.json';
import { deploymentOpenApiSpec } from '@server/premium-generated/deploymentOpenApi.generated';
import { createOpenApiSpecHandler } from '@server/utils/openApiSpecHandler';

/**
 * GET /api/v1/openapi.deployment.json - this deployment's full API contract: the
 * core contract plus the contracts of any add-on packages it mounts
 * (b4mContributions.contractsExport). With none mounted it is the committed core
 * spec, so a client can always use this URL.
 *
 * A separate route because the committed openapi.json is built and drift-gated
 * without add-ons, and add-on API shape does not belong in that public file. The
 * document is generated at build time (openapi:generate:deployment, run by the
 * client prebuild) and bundled via import, for the same CDN reason as openapi.json.
 *
 * Public like openapi.json: it describes routes this deployment already serves to
 * anyone who can reach it, and agents discover it through /llms.txt before they
 * hold a key.
 */
export default createOpenApiSpecHandler(deploymentOpenApiSpec ?? openapiSpec);
