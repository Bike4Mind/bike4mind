/**
 * The provenance vocabulary now lives in `@bike4mind/common` so producers outside apps/client
 * (packages/scripts) can stamp a haltable message; re-exported here because the handlers and their
 * tests address it by this path.
 */
export {
  WORK_ORIGINS,
  WorkOriginSchema,
  CONVERGENCE_ORIGIN,
  provenancePayloadShape,
  shouldHaltConvergence,
  type WorkOrigin,
} from '@bike4mind/common';
