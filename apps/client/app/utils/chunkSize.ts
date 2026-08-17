import { settingsMap } from '@bike4mind/common';

/**
 * Applies the DefaultChunkSize setting's own scope clamp (floor + ceiling) to a chunk-size value.
 * Use this at every client-side read/prefill/submit site for a chunk size, so a legacy stored value
 * above the ceiling (settings.ts documents this as a real, reachable state) or a hand-typed number
 * can never bypass the same bound the resolver enforces server-side
 * (`settingsMap.DefaultChunkSize.scope.clamp`) - only POST /api/files/chunk's own check catches it
 * otherwise, which now hard-rejects instead of silently reprocessing.
 */
export function clampChunkSize(value: number): number {
  return settingsMap.DefaultChunkSize.scope?.clamp?.(value, {}) ?? value;
}
