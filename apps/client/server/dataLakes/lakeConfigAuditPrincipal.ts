import type { LakeAuditPrincipal } from '@bike4mind/common';
import { resolveAuditPrincipal } from './resolveAuditPrincipal';

/**
 * The `auditPrincipal` to attach to a config-write actor, or `undefined` to leave the existing
 * derivation alone.
 *
 * Returns a principal ONLY for an API-key caller. `baseApi()` admits either a session or a
 * `b4m_live_` key on these routes, and for a session `req.user.id` already IS the principal - which
 * is exactly what `recordLakeConfigChange` derives when nothing is attached, including its
 * blank-id-means-`system` arm. Attaching a redundant principal on the session path would put a
 * second spelling of the same fact in front of the audit for no gain, so the override is confined to
 * the case the fallback genuinely cannot see: a key acting for its owner, which would otherwise be
 * recorded as though the owner had made the change by hand.
 *
 * Uses the read side's own `resolveAuditPrincipal` rather than a config-specific twin, so an
 * API-key write and an API-key read describe the same principal the same way (the two models share
 * the principal vocabulary by aliasing it - see LakeConfigChangeEventTypes).
 */
export function lakeConfigAuditPrincipal(
  user: { id: string },
  apiKeyInfo: Pick<Express.ApiKeyInfo, 'keyId'> | undefined
): LakeAuditPrincipal | undefined {
  if (!apiKeyInfo) return undefined;
  return resolveAuditPrincipal(user, apiKeyInfo);
}
