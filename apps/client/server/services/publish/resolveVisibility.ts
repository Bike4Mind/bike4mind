import { SCOPE_POLICY, type PublishScopeTier, type PublishVisibility } from '@bike4mind/common';

/**
 * Compute the visibility to persist on a freshly-published artifact. If the
 * publisher specified an override, validate it against the tier's allowlist;
 * otherwise return the tier default. Pure. Ported from Polaris computeDefaults
 * via the artifact-publishing blueprint; the policy table lives in
 * `@bike4mind/common` (SCOPE_POLICY) so schema + service agree.
 */
export function resolveVisibility(
  tier: PublishScopeTier,
  requestedOverride: PublishVisibility | undefined
): { ok: true; visibility: PublishVisibility } | { ok: false; error: string; code: 'invalid_override' } {
  const policy = SCOPE_POLICY[tier];
  if (requestedOverride === undefined) {
    return { ok: true, visibility: policy.defaultVisibility };
  }
  if (!policy.allowedOverrides.includes(requestedOverride)) {
    return {
      ok: false,
      code: 'invalid_override',
      error: `Visibility "${requestedOverride}" is not allowed for scope "${tier}". Allowed: ${policy.allowedOverrides.join(', ')}`,
    };
  }
  return { ok: true, visibility: requestedOverride };
}
