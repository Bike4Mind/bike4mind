import openapiSpec from '@public/openapi.json';
import { applyOpenApiPatch } from '@bike4mind/common';
import { deploymentOpenApiPatch } from '@server/premium-generated/deploymentOpenApi.generated';
import { createOpenApiSpecHandler } from '@server/utils/openApiSpecHandler';

/**
 * GET /api/v1/openapi.deployment.json - this deployment's full API contract: the
 * core contract plus the contracts of any add-on packages it mounts
 * (b4mContributions.contractsExport). With none mounted it is the committed core spec,
 * so a client can always use this URL.
 *
 * A separate route because the committed openapi.json is built and drift-gated
 * without add-ons, and add-on API shape does not belong in that public file. The
 * add-on part is generated at build time (openapi:generate:deployment, run by the
 * client prebuild) as a patch over the committed core spec, which the bundle already
 * holds for openapi.json: a second full document added ~1.6 MB (bundled) to the
 * server function. The generator diffs against that committed file, so the patch is
 * relative to the exact bytes applied here.
 *
 * Public like openapi.json: it describes routes this deployment already serves to
 * anyone who can reach it, and agents discover it through /llms.txt before they
 * hold a key.
 */
export default createOpenApiSpecHandler(
  deploymentOpenApiPatch ? applyOpenApiPatch(openapiSpec, deploymentOpenApiPatch) : openapiSpec
);
