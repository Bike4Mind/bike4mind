import type { CreditLedgerEntry } from '@bike4mind/services/creditService';

/**
 * Attribute a request-bound charge to the UserApiKey that authenticated the request, so per-key spend
 * rollups (CreditTransaction.apiKeyId) see it. An entry that already names a key keeps it.
 */
export function attributeToRequestApiKey(
  entry: CreditLedgerEntry,
  // Structural slice of Express.ApiKeyInfo, whose augmentation lives in apps/client/global.d.ts.
  req: { apiKeyInfo?: { keyId?: string } }
): CreditLedgerEntry {
  const apiKeyId = entry.apiKeyId ?? req.apiKeyInfo?.keyId;
  return apiKeyId ? { ...entry, apiKeyId } : entry;
}
