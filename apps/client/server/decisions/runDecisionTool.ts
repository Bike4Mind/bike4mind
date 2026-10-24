import { ApiKeyStatus, assertAuthOriginMatchesApiKey, type CompletionSource } from '@bike4mind/common';
import { userApiKeyRepository } from '@bike4mind/database';
import type { DecideToolFn } from '@bike4mind/services/llm';
import { resolveActiveOrg } from '@bike4mind/server-utils/utils/resolveActiveOrg';
import { ForbiddenError } from '@bike4mind/utils';
import { runDecision } from './runDecision';

/** Restore the trusted turn's policy before entering the shared billing and file-access path. */
export async function runDecisionTool({
  userId,
  user,
  logger,
  authOrigin,
  apiKeyId,
  organizationId,
  request,
  source,
}: Parameters<DecideToolFn>[0] & { source: CompletionSource }) {
  assertAuthOriginMatchesApiKey(authOrigin, apiKeyId);
  const key =
    authOrigin === 'apiKey' && apiKeyId ? await userApiKeyRepository.findByUserIdAndId(userId, apiKeyId) : null;
  if (
    authOrigin === 'apiKey' &&
    (!key || key.status !== ApiKeyStatus.ACTIVE || (key.expiresAt && key.expiresAt.getTime() <= Date.now()))
  ) {
    throw new ForbiddenError('The API key for this decision turn is no longer usable.');
  }
  const apiKeyInfo = key
    ? {
        keyId: apiKeyId!,
        scopes: key.scopes,
        billingOwnerType: key.billingOwnerType,
        organizationId: key.organizationId?.toString(),
      }
    : undefined;
  const billingOrganizationId = key ? undefined : ((await resolveActiveOrg({ user }, organizationId)) ?? null);
  return runDecision({
    caller: { userId, user, logger, source, apiKeyId, apiKeyInfo, billingOrganizationId },
    body: request,
  });
}
