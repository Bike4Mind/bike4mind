import type { ReconcileResult } from './reconcilePurchaseStamps';

type SendToClient = (
  userId: string,
  endpoint: string,
  action: { action: 'invalidate_query'; queryKey: string[] }
) => Promise<unknown>;

// Same keys purchaseReversal.ts (apps/client/server/billing) invalidates on a revocation.
export const INVALIDATED_QUERY_KEYS = [['llm', 'models'], ['entitlements']];

export const createNotify = (endpoint: string, send: SendToClient) => (userId: string) =>
  Promise.allSettled(
    INVALIDATED_QUERY_KEYS.map(queryKey => send(userId, endpoint, { action: 'invalidate_query', queryKey }))
  );

/** '' when not applying, the endpoint when applying, null when applying without a usable endpoint. */
export function requireWebsocketEndpoint(apply: boolean, read: () => string): string | null {
  if (!apply) return '';
  try {
    return read() || null;
  } catch {
    return null;
  }
}

export const exitCodeFor = (result: Pick<ReconcileResult, 'blocking' | 'errors'>): 0 | 1 | 2 =>
  result.blocking > 0 ? 2 : result.errors.length > 0 ? 1 : 0;

export function summaryMessage(stage: string, result: Pick<ReconcileResult, 'cleared' | 'reversals'>): string {
  return `Paid standing reconcile (${stage}): cleared ${result.cleared} stamp(s), reversed ${result.reversals.length} purchase(s)`;
}
