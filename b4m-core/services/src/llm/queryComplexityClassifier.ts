/**
 * Back-compat re-export. The implementation now lives in `@bike4mind/common`
 * (browser-safe, single source of truth) so the client can import the
 * same classifier/router without pulling server-only deps into the Next bundle.
 * Existing server import sites (`./queryComplexityClassifier`, the `llm` barrel)
 * keep working through this shim.
 */
export {
  classifyQueryComplexity,
  routeQuery,
  hasExplicitAgentLiteral,
  type AgentRoutingContext,
  type QueryRouteTarget,
} from '@bike4mind/common';
