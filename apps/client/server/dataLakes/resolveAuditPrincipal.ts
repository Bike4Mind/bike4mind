import type { LakeAccessPrincipalKind } from '@bike4mind/common';

export interface AuditPrincipal {
  principalKind: LakeAccessPrincipalKind;
  principalId: string;
  onBehalfOfUserId?: string;
}

/**
 * Who actually performed a lake-content read, for the access-audit trail. `baseApi()` accepts
 * both a session and a `b4m_live_` API key on these routes, so `req.user` alone conflates two
 * different principals: a human in the app, or a caller authenticated by a key (equivalent to
 * `isApiKeyAuth(req)`, checked directly on `apiKeyInfo` here). Takes the two fields directly
 * rather than a whole `Request`, so a caller passing `req.user`/`req.apiKeyInfo` gets whatever
 * non-optional narrowing that route's own `Request<...>` generic already gives `req.user`, instead
 * of re-widening it through a fresh `Request` import. An API-key read is recorded under the KEY's
 * identity (`principalId`), with the human owner preserved separately (`onBehalfOfUserId`) rather
 * than folded into `principalId` - the split `LakeAccessEventTypes.ts` already documents for
 * exactly this case. Rows are immutable and floor-retained for 450 days, so this has to be right
 * the first time: it cannot be corrected after the fact.
 */
export function resolveAuditPrincipal(
  user: { id: string },
  // Pick<Express.ApiKeyInfo, 'keyId'> rather than a fresh structural type, so a future rename of
  // `keyId` on the real type (declared globally in global.d.ts) is a compile error here too,
  // instead of this silently continuing to type-check against a field that no longer exists.
  apiKeyInfo: Pick<Express.ApiKeyInfo, 'keyId'> | undefined
): AuditPrincipal {
  if (apiKeyInfo) {
    return { principalKind: 'apiKey', principalId: apiKeyInfo.keyId, onBehalfOfUserId: user.id };
  }
  return { principalKind: 'user', principalId: user.id };
}
