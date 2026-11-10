import type { EndpointContract } from '@bike4mind/common';
import { defineLambdaRoute } from '@workers/cli/defineLambdaRoute';

/**
 * Turborepo analytics events endpoint. Turbo sends build telemetry here;
 * the server accepts but does not store them. Routed through defineLambdaRoute
 * so the Function URL satisfies the contract gate (scan 4), while the artifact
 * cache endpoints (GET/PUT/HEAD) stay on the custom protocol handler because
 * they serve binary redirects and multiple methods on a single path.
 */
const turboCacheEventsContract: EndpointContract = {
  method: 'post',
  path: '/v8/artifacts/events',
  operationId: 'turboCacheEvents',
  summary: 'Accept Turborepo build analytics events',
  auth: 'public',
};

export const handleEvents = defineLambdaRoute(turboCacheEventsContract, async () => {
  return { statusCode: 200, body: {} };
});
