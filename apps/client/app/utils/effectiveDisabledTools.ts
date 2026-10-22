import { resolveWorkspaceDeniedTools } from '@bike4mind/common';
import { premiumWorkspaceDeniedTools } from '@server/premium-generated/premiumWorkspaceDeniedTools.generated';

/** The session's `disabledTools` plus what its current surface denies; mirrors the server's denylist. */
export function effectiveDisabledTools(
  session: { disabledTools?: readonly string[] | null; surface?: string | null } | null | undefined
): readonly string[] | undefined {
  if (!session) return undefined;
  const surfaceDenied = resolveWorkspaceDeniedTools(session.surface, premiumWorkspaceDeniedTools);
  // Hand the stored array back untouched when the surface denies nothing, so its identity is stable
  // across renders and the `new Set(disabledTools)` memos downstream do not recompute every time.
  if (surfaceDenied.length === 0) return session.disabledTools ?? undefined;
  return [...new Set([...(session.disabledTools ?? []), ...surfaceDenied])];
}
