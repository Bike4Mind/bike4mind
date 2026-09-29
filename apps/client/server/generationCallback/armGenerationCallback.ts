import { questRepository, userApiKeyRepository } from '@bike4mind/database';
import type { IQuestCallback } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import type { Request } from 'express';
import { BadRequestError } from '@server/utils/errors';
import { assertUrlAllowed, SsrfError } from '@server/utils/ssrfProtection';
import { dispatchQuestCallback, getGenerationCallbackQueueUrl } from './dispatchQuestCallback';

export type GenerationCallbackTarget = Pick<IQuestCallback, 'url' | 'apiKeyId'>;

/**
 * Validate a request's `callbackUrl` before any work is queued or charged. Returns undefined
 * when the caller did not ask for a callback.
 *
 * Rejected (400) rather than ignored, because a caller that asked for a callback and silently
 * gets none waits forever:
 * - JWT/browser callers: there is no per-key secret to sign with, and they have the websocket.
 * - keys without a signing secret (minted before callbacks existed): the fix is one call.
 * - targets that resolve to a private or link-local address.
 * - a deployment with no delivery queue (optional on self-host).
 */
export async function resolveGenerationCallback(
  req: Pick<Request, 'apiKeyInfo'>,
  callbackUrl: string | undefined
): Promise<GenerationCallbackTarget | undefined> {
  if (!callbackUrl) return undefined;

  const apiKeyId = req.apiKeyInfo?.keyId;
  if (!apiKeyId) {
    throw new BadRequestError('callbackUrl requires API key authentication');
  }

  if (!getGenerationCallbackQueueUrl()) {
    throw new BadRequestError('callbackUrl is not supported on this deployment');
  }

  try {
    await assertUrlAllowed(callbackUrl);
  } catch (error) {
    if (error instanceof SsrfError) throw new BadRequestError(`callbackUrl is not allowed: ${error.message}`);
    throw error;
  }

  const signing = await userApiKeyRepository.findCallbackSigningSecret(apiKeyId);
  if (!signing) {
    throw new BadRequestError(
      `This API key has no callback signing secret. Create one with POST /api/user-api-keys/${apiKeyId}/callback-secret, then retry.`
    );
  }

  return { url: callbackUrl, apiKeyId };
}

/**
 * Arm the callback on a quest the generation service just created, then try to dispatch it
 * in case the job already settled (a fast failure, or the synchronous dev/BYPASS_QUEUE path)
 * before it was armed; the settle site's own dispatch would have found nothing to claim.
 */
export async function armGenerationCallback(
  questId: string,
  target: GenerationCallbackTarget | undefined,
  logger: Logger
): Promise<void> {
  if (!target) return;
  await questRepository.armCallback(questId, target);
  await dispatchQuestCallback(questId, logger);
}
