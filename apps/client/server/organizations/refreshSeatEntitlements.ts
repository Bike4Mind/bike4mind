import { sendToClient } from '@bike4mind/server-utils/websocket/utils';
import { Resource } from 'sst';

// Keys the SPA derives from the plan; must stay in sync with useEntitlements and MODEL_CATALOG_QUERY_KEY.
const SEAT_PLAN_QUERY_KEYS = [['entitlements'], ['llm', 'models']];

/**
 * Tells a user's open clients to refetch what an org seat grants, after they leave or are removed
 * from an org. Call after the removal commits. Best-effort: it never throws.
 */
export async function refreshSeatEntitlements(userId: string): Promise<void> {
  await Promise.allSettled(
    SEAT_PLAN_QUERY_KEYS.map(queryKey =>
      sendToClient(userId, Resource.websocket.managementEndpoint, { action: 'invalidate_query', queryKey })
    )
  );
}
