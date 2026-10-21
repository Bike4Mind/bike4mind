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
  // Structurally Pick<Express.ApiKeyInfo, 'keyId'>: that global lives in apps/client/global.d.ts,
  // which this package cannot see. Callers pass `req.apiKeyInfo`, so a rename of `keyId` on the
  // real type is still a compile error, at the call site.
  apiKeyInfo: { keyId: string } | undefined
): AuditPrincipal {
  if (apiKeyInfo) {
    return { principalKind: 'apiKey', principalId: apiKeyInfo.keyId, onBehalfOfUserId: user.id };
  }
  return { principalKind: 'user', principalId: user.id };
}
