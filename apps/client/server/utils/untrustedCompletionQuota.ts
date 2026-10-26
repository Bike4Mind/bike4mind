import { randomUUID } from 'node:crypto';
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
 * refuses the next request while it is at or over the limit; one completion can overshoot, the
 * ones after it wait for the window to drain.
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
  return {
    release: () =>
      (released ??= cacheRepository.releaseLease(key, holderId).catch(() => {
        // The lease lapses on its own; a failed release only holds the slot until then.
      })),
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
  return admitApiKeyCompletion({ owner: req.user, billingOwnerType: req.apiKeyInfo.billingOwnerType, holdSlot, req });
}
