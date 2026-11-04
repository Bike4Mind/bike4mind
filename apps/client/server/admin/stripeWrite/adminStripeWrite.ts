import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import { BadRequestError, NotFoundError, type AuditChange } from '@bike4mind/common';
import { cacheRepository, withTransaction } from '@bike4mind/database';
import { ConflictError, ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { Config, isProduction } from '@bike4mind/server-utils/utils/config';
import { getStripe } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { stripeMirrorFields } from '@bike4mind/server-utils/lib/subscriptions/stripeMirror';
import type { ISubscription } from '@bike4mind/server-utils/lib/subscriptions/types';
import { Subscription, subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';
import { sendToClient } from '@bike4mind/server-utils/websocket/utils';
import { Resource } from 'sst';
import {
  AdminStripeWriteBodySchema,
  stripeStateOf,
  stripeStateToken,
  type AdminStripeWriteResponse,
  type AdminSubscriptionRow,
} from '@client/app/utils/adminSubscriptionDetail';
import { subscriptionPlanCatalog } from '@server/admin/subscriptionsList/adminSubscriptionsQuery';
import { toAdminSubscriptionRows, type SubscriptionDoc } from '@server/admin/subscriptionsList/listAdminSubscriptions';
import { resolveSubscriptionOwner } from '@server/admin/subscriptionDetail/resolveSubscriptionOwner';
import {
  denySelfAdminAction,
  isSelfOrImpersonator,
  parseAdminActionReason,
  recordAdminActionFromRequest,
} from '@server/utils/adminAudit';

export const STRIPE_WRITE_CHANGED_MESSAGE = 'This subscription changed. Review and try again.';
// 24h, matching how long Stripe retains an idempotency key. Set once at claim time and never extended by a rewrite,
// so a parked claim cannot outlive the key Stripe would replay it under.
const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
// Per attempt, with one network retry: the worst case (~30s plus backoff) fits the 60s server function budget.
const STRIPE_REQUEST_TIMEOUT_MS = 15_000;
const STRIPE_MAX_NETWORK_RETRIES = 1;
const LIVE_KEY_PREFIXES = ['sk_live_', 'rk_live_'];

/**
 * True when Stripe may have applied the write although the call failed: a connection error or timeout, or a 5xx.
 * A 4xx (invalid request, card, rate limit) is a definite rejection.
 */
export const isUnknownStripeOutcome = (error: unknown): boolean => {
  const { type, statusCode } = (error ?? {}) as { type?: string; statusCode?: number };
  return type === 'StripeConnectionError' || (type === 'StripeAPIError' && (statusCode ?? 500) >= 500);
};

export type AdminStripeWriteAction = 'billing.subscription.cancel_scheduled' | 'billing.subscription.resumed';

type GuardRequest = Parameters<typeof recordAdminActionFromRequest>[0] & {
  user?: { id: string; isAdmin?: boolean; impersonatedBy?: string };
  body?: unknown;
  logger: { error: (message: string, ...meta: unknown[]) => void };
};

type AdminStripeWriteArgs = {
  req: GuardRequest;
  id: string;
  action: AdminStripeWriteAction;
  summary: string;
  /** Throws a 409 when the freshly read row cannot take this write. Runs after the replay check. */
  precheck: (subscription: ISubscription) => void;
  /**
   * The Stripe update params for this row. Must be pure: the guard stores them with the claim so a recovery
   * retry replays exactly the same request under the same idempotency key.
   */
  params: (subscription: ISubscription) => Stripe.SubscriptionUpdateParams;
  changes: (before: ISubscription, after: Stripe.Subscription) => AuditChange[];
};

/**
 * A live Stripe key is only legitimate in production or on a self-hosted install, whose stage name is its own.
 * Checked per write so a misconfigured stage fails the write loudly instead of crashing every route at startup.
 */
export const assertStripeKeyMatchesStage = ({
  production,
  selfHost,
  key,
}: {
  production: boolean;
  selfHost: boolean;
  key: string | undefined;
}): void => {
  if (production || selfHost) return;
  if (key && LIVE_KEY_PREFIXES.some(prefix => key.startsWith(prefix))) {
    throw new Error('Refusing a Stripe write: a live Stripe key is configured on a non-production stage.');
  }
};

const readRow = async (id: string): Promise<{ row: AdminSubscriptionRow; doc: SubscriptionDoc }> => {
  const doc = await Subscription.findById(id).lean<SubscriptionDoc>();
  if (!doc) throw new NotFoundError('Subscription not found');
  const [row] = await toAdminSubscriptionRows([doc], subscriptionPlanCatalog());
  return { row, doc };
};

const notifyOwner = async (req: GuardRequest, ids: { notifyUserId: string | null; actingUserId: string | null }) => {
  try {
    if (ids.notifyUserId) {
      await sendToClient(ids.notifyUserId, Resource.websocket.managementEndpoint, {
        action: 'invalidate_query',
        queryKey: ['subscriptions'],
      });
    }
    if (ids.actingUserId) {
      await sendToClient(ids.actingUserId, Resource.websocket.managementEndpoint, {
        action: 'invalidate_query',
        queryKey: ['admin', 'user-subscriptions', ids.actingUserId],
      });
    }
  } catch (error) {
    req.logger.error('Failed to notify clients after a Stripe write', error);
  }
};

/**
 * The one path for an admin write to Stripe (docs/admin-subscriptions-spec.md section 7). Guards, in order: admin
 * only, no impersonation, live-key refusal off production, a required body and reason, the subscription lookup,
 * no self-target, an idempotency claim (a repeat of a finished write replays its response with no Stripe call), the
 * business-state concurrency check, then the Stripe call and, in one transaction, the mirror write plus its strict
 * critical audit entry.
 *
 * A definite failure before or at the Stripe call (a 4xx, a failed check) releases the claim. Failure after Stripe
 * applied the write, or a Stripe error whose outcome is unknown (connection, timeout, 5xx), parks the claim as
 * `stripe_done` with the request params, the audit changes (when known) and the pre-write row; a same-key retry
 * takes it over, skips the state check and precheck (our own webhook has changed the row by then), replays the
 * identical request under the same Stripe key, and writes the audit row. A recovered attempt does not write the
 * mirror: Stripe replays its snapshot from the first attempt, which may be older than the webhook state, so the
 * webhook owns the mirror. A failed recovery attempt re-parks the record. What a hard function kill still loses:
 * the claim stays `pending` until its 24h expiry (retries get "already in progress"), and the write is never audited.
 * The 10 writes/admin/minute limit is the routes' `rateLimit` middleware.
 */
export const runAdminStripeWrite = async ({
  req,
  id,
  action,
  summary,
  precheck,
  params,
  changes,
}: AdminStripeWriteArgs): Promise<AdminStripeWriteResponse> => {
  const admin = req.user;
  if (!admin?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');
  if (admin.impersonatedBy) throw new ForbiddenError('Stripe writes are not available while impersonating.');

  assertStripeKeyMatchesStage({
    production: isProduction(),
    selfHost: process.env.B4M_SELF_HOST === 'true',
    key: Config.STRIPE_SECRET_KEY,
  });

  const parsed = AdminStripeWriteBodySchema.safeParse(req.body);
  if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid request body');
  const { idempotencyKey, expectedState } = parsed.data;
  const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);

  const subscription = /^[0-9a-f]{24}$/i.test(id) ? await subscriptionRepository.findById(id) : null;
  if (!subscription) throw new NotFoundError('Subscription not found');

  const owner = await resolveSubscriptionOwner(subscription);
  if (owner.actingUserId && isSelfOrImpersonator(admin, owner.actingUserId)) {
    await denySelfAdminAction(req, {
      action: 'user.subscription.denied',
      attempted: action,
      target: owner.target,
    });
  }

  const claimKey = `admin-stripe-write:${admin.id}:${id}:${action}:${idempotencyKey}`;
  // Scoped like the claim, so one client key reused for another action or subscription is never a Stripe conflict.
  const stripeIdempotencyKey = `${id}:${action}:${idempotencyKey}`;
  const token = randomUUID();
  // `before` is the row as plain JSON: a recovery that never saw Stripe's response rebuilds the audit from it.
  type StripeSent = {
    params: Stripe.SubscriptionUpdateParams;
    changes: AuditChange[] | null;
    before: ISubscription;
  };
  // A holder, not a `let`: TS cannot see the catch block's reads of an assignment made inside the try.
  const progress: { stripeDone: AuditChange[] | null } = { stripeDone: null };
  let recovered: StripeSent | null = null;
  const requestParams = params(subscription);
  const claimData = {
    params: requestParams,
    changes: null,
    before: JSON.parse(JSON.stringify(subscription)) as ISubscription,
  };

  const claim = await cacheRepository.claimDedup(claimKey, { state: 'pending', token, ...claimData }, CLAIM_TTL_MS);
  if (!claim.claimed) {
    const existing = claim.existingData;
    if (existing?.state === 'done') return existing.response as AdminStripeWriteResponse;
    const takeover =
      existing?.state === 'stripe_done' &&
      typeof existing.token === 'string' &&
      (await cacheRepository.casUpdateDedup(claimKey, 'token', existing.token, {
        ...existing,
        state: 'pending',
        token,
      }));
    if (!takeover) throw new ConflictError('This change is already in progress.');
    recovered = {
      params: existing?.params as Stripe.SubscriptionUpdateParams,
      changes: (existing?.changes as AuditChange[] | null) ?? null,
      before: existing?.before as ISubscription,
    };
  }

  const sentParams = recovered?.params ?? requestParams;

  try {
    if (!recovered) {
      if (stripeStateToken(subscription) !== expectedState) throw new ConflictError(STRIPE_WRITE_CHANGED_MESSAGE);
      precheck(subscription);
    }

    const stripeSubscriptionId = subscription.subscriptionId;
    if (!stripeSubscriptionId) throw new ConflictError('This subscription has no Stripe id.');
    const updated = await getStripe().subscriptions.update(stripeSubscriptionId, sentParams, {
      idempotencyKey: stripeIdempotencyKey,
      timeout: STRIPE_REQUEST_TIMEOUT_MS,
      maxNetworkRetries: STRIPE_MAX_NETWORK_RETRIES,
    });
    const auditChanges = recovered?.changes ?? changes(recovered?.before ?? subscription, updated);
    progress.stripeDone = auditChanges;
    const syncedAt = new Date();

    await withTransaction(async () => {
      if (!recovered) {
        // Newer-wins: our own customer.subscription.updated webhook may already have landed with a later stamp.
        await Subscription.findOneAndUpdate(
          { _id: id, $or: [{ lastSyncedAt: { $lte: syncedAt } }, { lastSyncedAt: null }] },
          { $set: stripeMirrorFields(updated, syncedAt) }
        );
      }
      await recordAdminActionFromRequest(req, {
        action,
        target: owner.target,
        organizationId: owner.organizationId,
        summary,
        reason,
        changes: auditChanges,
        details: {
          subscriptionId: subscription.subscriptionId,
          subscriptionRecordId: id,
          stripeRequestId: updated.lastResponse?.requestId ?? null,
        },
      });
    });

    await notifyOwner(req, owner);
    const { row, doc } = await readRow(id);
    const response: AdminStripeWriteResponse = { subscription: row, stripe: stripeStateOf(doc) };
    await cacheRepository
      .casUpdateDedup(claimKey, 'token', token, { state: 'done', token, response })
      .catch((error: unknown) => req.logger.error('Failed to store an admin Stripe write for replay', error));
    return response;
  } catch (error) {
    const park = progress.stripeDone || recovered || isUnknownStripeOutcome(error);
    const settle = park
      ? cacheRepository.casUpdateDedup(claimKey, 'token', token, {
          state: 'stripe_done',
          token,
          params: sentParams,
          changes: progress.stripeDone ?? recovered?.changes ?? null,
          before: recovered?.before ?? claimData.before,
        })
      : cacheRepository.casDeleteDedup(claimKey, 'token', token);
    await settle.catch((settleError: unknown) => {
      req.logger.error('Failed to settle an admin Stripe write claim', settleError);
    });
    throw error;
  }
};
