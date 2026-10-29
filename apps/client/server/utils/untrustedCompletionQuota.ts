import { randomUUID } from 'node:crypto';
import { Logger } from '@bike4mind/observability';
import {
  CONCURRENCY_LIMIT_EXCEEDED_ERROR_CODE,
  CreditHolderType,
  TOKEN_RATE_LIMIT_EXCEEDED_ERROR_CODE,
  TooManyRequestsError,
} from '@bike4mind/common';
import { adminSettingsRepository, cacheRepository, usageEventRepository, User } from '@bike4mind/database';
import { userApiKeyService } from '@bike4mind/services';
import type { ActiveSubscriptionsRequest } from '@server/entitlements/activeSubscriptions';
import { resolveApiKeyTrust } from '@server/utils/apiKeyTrust';

const TOKEN_WINDOW_MS = 60_000;
// Backstop only: every exit path releases its slot, so this bounds a slot whose process died first.
const COMPLETION_SLOT_LEASE_MS = 15 * 60_000;
const COMPLETION_SLOT_RENEW_MS = 5 * 60_000;

/** One lease document per account, shared by every key and every completion route. */
export const completionSlotsKey = (userId: string) => `api-quota:${userId}:inflight-completions`;

export interface CompletionQuotaGrant {
  /** Frees the concurrency slot, if one was taken. Idempotent and never throws. */
  release(): Promise<void>;
}

export const NO_COMPLETION_QUOTA: CompletionQuotaGrant = { release: () => Promise.resolve() };

type QuotaOwner = userApiKeyService.ApiKeyTrustSubject & { id: string };

/**
 * Request-time quotas for a completion made with a personal API key whose owner is untrusted
 * (the same predicate as the key-mint gate, see apiKeyTrust.ts): tokens per rolling minute and
 * completions in flight. Org-billed keys, trusted owners and quotas set to 0 pass untouched.
 *
 * Tokens are only known once a completion settles, so the check reads the account's settled
 * usage over the last minute (see UsageEventRepository.userTokensSince for what is counted) and
 * refuses the next request while it is at or over the limit. Already admitted completions can
 * overshoot; later requests wait for the window to drain.
 *
 * Throws a 429 carrying `errorCode` (and `retryAfter` for the token window). With `holdSlot`,
 * the caller must call `release()` once the work has actually ended, success or failure.
 */
export async function admitApiKeyCompletion({
  owner,
  ownerUntrusted,
  billingOwnerType,
  holdSlot,
  req,
}: {
  /** The owner document, or just its id when the caller has not loaded it. */
  owner: QuotaOwner | string;
  /** The standing auth already judged (cli/auth verifyApiKey); omitted means judge it here. */
  ownerUntrusted?: boolean;
  billingOwnerType?: string;
  holdSlot: boolean;
  req?: ActiveSubscriptionsRequest;
}): Promise<CompletionQuotaGrant> {
  if (billingOwnerType === CreditHolderType.Organization || ownerUntrusted === false) return NO_COMPLETION_QUOTA;

  const settings = await userApiKeyService.loadApiKeyTrustSettings({ adminSettings: adminSettingsRepository });
  const tokensPerMinute = settings.untrustedTokensPerMinute;
  const maxConcurrent = holdSlot ? settings.untrustedMaxConcurrent : 0;
  if (!settings.gateEnabled || (tokensPerMinute <= 0 && maxConcurrent <= 0)) return NO_COMPLETION_QUOTA;

  const ownerId = typeof owner === 'string' ? owner : owner.id;
  if (ownerUntrusted === undefined) {
    const ownerDoc = typeof owner === 'string' ? await User.findById(owner) : owner;
    if (!ownerDoc) return NO_COMPLETION_QUOTA;
    const { assessment } = await resolveApiKeyTrust(ownerDoc, req);
    if (assessment.status !== 'untrusted') return NO_COMPLETION_QUOTA;
  }

  if (tokensPerMinute > 0) {
    const now = Date.now();
    const { tokens, oldestAt } = await usageEventRepository.userTokensSince(ownerId, new Date(now - TOKEN_WINDOW_MS));
    if (tokens >= tokensPerMinute) {
      const drainsAt = (oldestAt?.getTime() ?? now) + TOKEN_WINDOW_MS;
      const retryAfter = Math.max(1, Math.ceil((drainsAt - now) / 1000));
      throw new TooManyRequestsError(
        `Token rate limit exceeded: ${tokensPerMinute} tokens per minute. Try again in ${retryAfter} seconds.`,
        { errorCode: TOKEN_RATE_LIMIT_EXCEEDED_ERROR_CODE, retryAfter }
      );
    }
  }

  if (maxConcurrent <= 0) return NO_COMPLETION_QUOTA;

  const key = completionSlotsKey(ownerId);
  const holderId = randomUUID();
  if (!(await cacheRepository.tryAcquireLease(key, holderId, maxConcurrent, COMPLETION_SLOT_LEASE_MS))) {
    throw new TooManyRequestsError(
      `Concurrency limit exceeded: ${maxConcurrent} completions in flight. Retry when one finishes.`,
      { errorCode: CONCURRENCY_LIMIT_EXCEEDED_ERROR_CODE }
    );
  }

  let released: Promise<void> | undefined;
  let closed = false;
  let renewalTimer: ReturnType<typeof setTimeout>;
  const renew = async () => {
    try {
      const renewed = await cacheRepository.renewLease(key, holderId, COMPLETION_SLOT_LEASE_MS);
      if (!renewed) {
        Logger.globalInstance.warn('API completion quota slot expired before renewal', { userId: ownerId });
        return;
      }
    } catch (error) {
      Logger.globalInstance.warn('Failed to renew API completion quota slot', { userId: ownerId, error });
    }
    if (!closed) scheduleRenewal();
  };
  const scheduleRenewal = () => {
    renewalTimer = setTimeout(() => void renew(), COMPLETION_SLOT_RENEW_MS);
    renewalTimer.unref?.();
  };
  scheduleRenewal();
  return {
    release: () => {
      if (released) return released;
      closed = true;
      clearTimeout(renewalTimer);
      released = cacheRepository.releaseLease(key, holderId).catch(error => {
        Logger.globalInstance.warn('Failed to release API completion quota slot; waiting for lease expiry', {
          userId: ownerId,
          error,
        });
      });
      return released;
    },
  };
}

/**
 * {@link admitApiKeyCompletion} for a Next API route: a no-op unless an API key authenticated the
 * request. Pass `holdSlot` only when the request itself runs the work to completion.
 */
export function admitRequestCompletion(
  req: ActiveSubscriptionsRequest & Pick<Express.Request, 'user' | 'apiKeyInfo'>,
  { holdSlot }: { holdSlot: boolean }
): Promise<CompletionQuotaGrant> {
  if (!req.apiKeyInfo || !req.user) return Promise.resolve(NO_COMPLETION_QUOTA);
  return admitApiKeyCompletion({
    owner: req.user,
    ownerUntrusted: req.apiKeyInfo.ownerUntrusted,
    billingOwnerType: req.apiKeyInfo.billingOwnerType,
    holdSlot,
    req,
  });
}
