import type { RequestHandler } from 'express';
import { ACCOUNT_TRUST_REQUIRED_ERROR_CODE } from '@bike4mind/common';
import { ForbiddenError, UnauthorizedError } from '@bike4mind/server-utils/utils/errors';
import type { userApiKeyService } from '@bike4mind/services';
import { isAiAccessRevoked } from '@bike4mind/services/userService/accountState';
import type { ActiveSubscriptionsRequest } from '@server/entitlements/activeSubscriptions';
import { resolveApiKeyTrust } from '@server/utils/apiKeyTrust';

type OutboundActor = userApiKeyService.ApiKeyTrustSubject & { id: string; isModerated?: boolean | null };

export const OUTBOUND_ACTIONS_RESTRICTED_MESSAGE =
  'This action is disabled on your account by an administrator. Please contact support.';

function describeOutboundTrustRequirement(assessment: userApiKeyService.UntrustedApiKeyAssessment): string {
  if (assessment.reason === 'email_unverified') return 'Verify your email address to use this feature.';
  const unlockDate = assessment.trustedAfter.toISOString().slice(0, 10);
  return `New accounts cannot use this feature yet. To unlock it, purchase credits or a plan, wait until ${unlockDate}, or contact support.`;
}

/**
 * Route-level gate for outbound and abuse-prone actions (email send, invites, tools, agent helpers,
 * publishing): blocks moderated accounts and, while the trust gate is on, untrusted ones. Pass `req`
 * when `user` is `req.user` so the subscription read is shared with the rest of the request.
 */
export async function assertOutboundActionAllowed(
  user: OutboundActor | undefined,
  req?: ActiveSubscriptionsRequest
): Promise<void> {
  if (!user) throw new UnauthorizedError('User not found');
  if (isAiAccessRevoked(user)) throw new ForbiddenError(OUTBOUND_ACTIONS_RESTRICTED_MESSAGE);

  const { assessment } = await resolveApiKeyTrust(user, req);
  if (assessment.status !== 'untrusted') return;
  throw new ForbiddenError(describeOutboundTrustRequirement(assessment), {
    errorCode: ACCOUNT_TRUST_REQUIRED_ERROR_CODE,
    trustReason: assessment.reason,
    ...(assessment.reason === 'not_yet_trusted' && { trustedAfter: assessment.trustedAfter.toISOString() }),
  });
}

/** Middleware form; forwards the error with `next` so it does not rely on async-throw handling. */
export const outboundActionGate = (): RequestHandler => (req, _res, next) => {
  assertOutboundActionAllowed(req.user, req).then(() => next(), next);
};
