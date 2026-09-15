/**
 * Side-effecting companion to the (pure) entitlement resolver: wakes a user's
 * client entitlement cache after a server-side change that can flip a
 * derive-on-read grant.
 *
 * Lives in its own file (not `./index.ts`) so the websocket / AWS / sst deps
 * stay out of the resolver module that queue-handler Lambdas import for the
 * pure `getUserEntitlements` path.
 */
import { sendToClient } from '@server/websocket/utils';
import { emitMetric } from '@server/utils/cloudwatch';
import { Resource } from 'sst';
import type { Logger } from '@bike4mind/observability';

/**
 * Push `invalidate_query ['entitlements']` to the user's socket and emit the
 * same `Lumina5/Entitlements` reconcile metric the Stripe path uses
 * (`customerSubscriptionUpdated.ts`), so domain-grant activations are
 * observable alongside subscription ones.
 *
 * The grant itself is derived on the next `/api/entitlements` read - this only
 * refreshes the client cache ahead of `useEntitlements`' staleTime / window-
 * focus backstop. Callers invoke this AFTER their state change has committed,
 * so it is **best-effort**: a websocket/metric failure is logged and swallowed,
 * never propagated (it must not turn a committed verification into an error).
 *
 * The send is intentionally `await`ed rather than fire-and-forget: these run in
 * request/response API-route Lambdas, which can freeze the moment the response
 * is returned - a dangling promise would risk being dropped before delivery.
 * The cost is bounded (one connection lookup + fan-out) and only paid on the
 * narrow path that actually crosses a grant boundary.
 */
export async function pushEntitlementInvalidation(userId: string, logger: Logger): Promise<void> {
  try {
    await Promise.all([
      sendToClient(userId, Resource.websocket.managementEndpoint, {
        action: 'invalidate_query',
        queryKey: ['entitlements'],
      }),
      emitMetric('Lumina5/Entitlements', 'EntitlementReconciled', 1, { source: 'email_verification' }),
    ]);
  } catch (error) {
    logger.warn('Failed to push entitlement invalidation:', error);
  }
}
