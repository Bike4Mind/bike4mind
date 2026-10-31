import type { CreditLedgerEntry } from '@bike4mind/services/creditService';

/**
 * Attribute a request-bound charge to the UserApiKey that authenticated the request, so per-key spend
 * rollups (CreditTransaction.apiKeyId) see it. An entry that already names a key keeps it.
 */
export function attributeToRequestApiKey(
  entry: CreditLedgerEntry,
  req: { apiKeyInfo?: Partial<Pick<Express.ApiKeyInfo, 'keyId'>> }
): CreditLedgerEntry {
  const apiKeyId = entry.apiKeyId ?? req.apiKeyInfo?.keyId;
  return apiKeyId ? { ...entry, apiKeyId } : entry;
}
