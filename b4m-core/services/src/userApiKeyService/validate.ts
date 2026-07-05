import { Logger } from '@bike4mind/observability';
import { ApiKeyScope, ApiKeyStatus, IUserApiKeyRepository } from '@bike4mind/common';
import bcrypt from 'bcryptjs';
import { KEY_PREFIX_LENGTH, LEGACY_KEY_PREFIX_LENGTH } from './constants';

interface ValidateUserApiKeyAdapters {
  db: {
    userApiKeys: IUserApiKeyRepository;
  };
}

export interface ValidationResult {
  isValid: boolean;
  userId?: string;
  keyId?: string;
  scopes?: ApiKeyScope[];
  rateLimit?: {
    requestsPerMinute: number;
    requestsPerDay: number;
  };
  productId?: string;
  reason?: 'not_found' | 'invalid_hash' | 'expired' | 'disabled' | 'rate_limited';
}

export const validateUserApiKey = async (
  key: string,
  adapters: ValidateUserApiKeyAdapters
): Promise<ValidationResult> => {
  const { db } = adapters;

  // Extract key prefix for lookup
  if (!key.startsWith('b4m_live_')) {
    return { isValid: false, reason: 'not_found' };
  }

  const keyPrefix = key.substring(0, KEY_PREFIX_LENGTH);

  // Find the API key by prefix. Keys minted before Jun 2026 are stored with a
  // 12-char prefix, so fall back to the legacy length on a miss.
  let apiKey = await db.userApiKeys.findActiveByKeyPrefix(keyPrefix);
  let foundViaLegacyPrefix = false;
  if (!apiKey) {
    apiKey = await db.userApiKeys.findActiveByKeyPrefix(key.substring(0, LEGACY_KEY_PREFIX_LENGTH));
    foundViaLegacyPrefix = apiKey !== null;
  }
  if (!apiKey) {
    return { isValid: false, reason: 'not_found' };
  }

  // Verify the hash
  const isHashValid = await bcrypt.compare(key, apiKey.keyHash);
  if (!isHashValid) {
    return { isValid: false, reason: 'invalid_hash' };
  }

  // Check if expired
  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    return { isValid: false, reason: 'expired' };
  }

  // Check if disabled
  if (apiKey.status !== ApiKeyStatus.ACTIVE) {
    return { isValid: false, reason: 'disabled' };
  }

  // Self-heal legacy records: now that the full key is in hand, upgrade the
  // stored prefix to the current length so future lookups hit directly
  // (fire and forget)
  if (foundViaLegacyPrefix) {
    apiKey.keyPrefix = keyPrefix;
    db.userApiKeys.update(apiKey).catch(err => {
      Logger.globalInstance.warn('Failed to self-heal legacy API key prefix:', err);
    });
  }

  // Update last used timestamp (fire and forget)
  db.userApiKeys.updateLastUsed(apiKey.id).catch(err => {
    Logger.globalInstance.warn('Failed to update API key last used timestamp:', err);
  });

  return {
    isValid: true,
    userId: apiKey.userId,
    keyId: apiKey.id,
    scopes: apiKey.scopes,
    rateLimit: apiKey.rateLimit,
    productId: apiKey.productId,
  };
};
