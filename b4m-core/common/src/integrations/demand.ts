import { INTEGRATIONS, type Integration } from './catalog';
import type { IntegrationStage } from './types';

/**
 * Response shapes of the admin integration-demand API
 * (apps/client/pages/api/admin/integrations/demand/), shared with the admin console tab.
 * Timestamps are ISO strings, as they arrive over JSON.
 */

/** One row of GET /api/admin/integrations/demand. */
export interface IntegrationDemand {
  integrationId: string;
  name: string;
  /** The entry's stage today; null once the id has left the catalog altogether. */
  stage: IntegrationStage | null;
  total: number;
  /** Distinct organizations among the requesters; requests filed without one are not counted here. */
  organizations: number;
  firstRequestedAt: string;
  latestRequestedAt: string;
}

export interface IntegrationDemandResponse {
  integrations: IntegrationDemand[];
}

/** One row of GET /api/admin/integrations/demand/{integrationId}/requesters. */
export interface IntegrationRequester {
  userId: string;
  /** True when the account no longer resolves or is soft-deleted; name and email are then null. */
  deleted: boolean;
  name: string | null;
  email: string | null;
  /** The organization the requester belongs to now, else the one stored on the request. */
  organizationId: string | null;
  organizationName: string | null;
  requestedAt: string;
}

/** Cursor-paginated like the public list convention (api-contract/CONVENTIONS.md section 8). */
export interface IntegrationRequestersResponse {
  data: IntegrationRequester[];
  next_cursor: string | null;
}

// A Map, not an INTEGRATION_CATALOG index: the id comes from stored rows, and an object lookup
// would resolve `__proto__` or `toString` to an inherited member.
const integrationsById: ReadonlyMap<string, Integration> = new Map(INTEGRATIONS.map(i => [i.id, i]));

/**
 * Display name and current stage for a requested id. Demand outlives the roadmap card, so an id
 * promoted to beta or GA keeps its history, and one dropped from the catalog shows its raw id.
 */
export function describeRequestedIntegration(integrationId: string): {
  name: string;
  stage: IntegrationStage | null;
} {
  const entry = integrationsById.get(integrationId);
  return entry ? { name: entry.name, stage: entry.stage } : { name: integrationId, stage: null };
}
