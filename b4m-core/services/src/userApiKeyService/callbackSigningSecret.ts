import { ApiKeyScope, IUserApiKeyRepository } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { assertNoScopeEscalation } from './assertNoScopeEscalation';

const CALLBACK_SIGNING_SECRET_PREFIX = 'whsec_';

/** A fresh HMAC key for generation completion callbacks: 32 random bytes, base64url. */
export function generateCallbackSigningSecret(): string {
  return `${CALLBACK_SIGNING_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

const rotateCallbackSigningSecretSchema = z.object({
  keyId: z.string(),
});

export type RotateCallbackSigningSecretParameters = z.infer<typeof rotateCallbackSigningSecretSchema>;

interface RotateCallbackSigningSecretAdapters {
  db: {
    userApiKeys: IUserApiKeyRepository;
  };
  /** Scopes of the calling API key; undefined for a browser/JWT caller. See rotateUserApiKey. */
  callerScopes?: ApiKeyScope[];
}

export interface RotateCallbackSigningSecretResult {
  id: string;
  name: string;
  callbackSigningSecret: string; // Only returned once
  callbackSigningSecretCreatedAt: Date;
}

/**
 * Mint (or replace) a key's callback signing secret. Minter-only, like rateLimit.ts/spendCap.ts,
 * plus the literal no-escalation rule in assertNoScopeEscalation, because it hands back a secret
 * the minter's receiver will trust. No org-admin fallback: rotate.ts re-owns the key before
 * minting a secret so holder and owner never split, and minting here without re-owning would split
 * them. Replacing it takes effect on the next delivery attempt, including retries of callbacks
 * already queued.
 */
export const rotateCallbackSigningSecret = async (
  userId: string,
  parameters: RotateCallbackSigningSecretParameters,
  adapters: RotateCallbackSigningSecretAdapters
): Promise<RotateCallbackSigningSecretResult> => {
  const { db } = adapters;
  const params = secureParameters(parameters, rotateCallbackSigningSecretSchema);

  const apiKey = await db.userApiKeys.findByUserIdAndId(userId, params.keyId);
  if (!apiKey) {
    throw new NotFoundError('API key not found');
  }

  assertNoScopeEscalation(
    adapters.callerScopes,
    apiKey.scopes ?? [],
    'Cannot rotate the signing secret of a key holding scopes the calling key does not have'
  );

  const callbackSigningSecret = generateCallbackSigningSecret();
  const callbackSigningSecretCreatedAt = new Date();
  await db.userApiKeys.setCallbackSigningSecret(apiKey.id, callbackSigningSecret, callbackSigningSecretCreatedAt);

  return { id: apiKey.id, name: apiKey.name, callbackSigningSecret, callbackSigningSecretCreatedAt };
};
