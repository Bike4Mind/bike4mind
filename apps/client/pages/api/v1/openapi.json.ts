import openapiSpec from '@public/openapi.json';
import { createOpenApiSpecHandler } from '@server/utils/openApiSpecHandler';

/**
 * GET /api/v1/openapi.json - the public, machine-readable API contract.
 *
 * Serves the committed spec (b4m-core/common generates it into
 * apps/client/public/openapi.json; CI drift-gates that file). The spec is
 * imported, not read from disk at runtime: under SST/OpenNext, files in
 * apps/client/public/ are served from S3/CloudFront and never reach this
 * Lambda, so a runtime fs read would be unreliable. The import bundles the
 * committed bytes into the handler, guaranteeing availability - same reasoning
 * as artifact-sandbox.ts serving inline HTML.
 *
 * The committed file keeps all three placeholder env entries for reference; the
 * handler rewrites them to the request's origin (see createOpenApiSpecHandler).
 */
export default createOpenApiSpecHandler(openapiSpec);
