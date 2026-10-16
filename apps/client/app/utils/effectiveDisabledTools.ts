import { resolveWorkspaceDeniedTools } from '@bike4mind/common';
import { premiumWorkspaceDeniedTools } from '@client/app/premium-generated/premiumWorkspaceDeniedTools.generated';

/** The session's `disabledTools` plus what its current surface denies; mirrors the server's denylist. */
export function effectiveDisabledTools(
  session: { disabledTools?: readonly string[] | null; surface?: string | null } | null | undefined
): string[] | undefined {
  if (!session) return undefined;
  const merged = new Set([
    ...(session.disabledTools ?? []),
    ...resolveWorkspaceDeniedTools(session.surface, premiumWorkspaceDeniedTools),
  ]);
  return merged.size > 0 ? [...merged] : undefined;
}
