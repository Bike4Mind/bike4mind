import { PROMPT_TEXT_MAX } from '@bike4mind/common';

export type SystemContextResolution =
  { kind: 'absent' } | { kind: 'ok'; systemContext: string } | { kind: 'tooLong'; length: number };

/**
 * Normalizes a send's per-send system context: whitespace-only counts as absent, and the cap
 * is measured after trimming. Enforced at the send boundary so every caller refuses the same
 * way - past it, the agent route's start schema would reject an over-cap value with no reply
 * reaching the user, and the chat route has no cap at all.
 */
export function resolveSystemContext(raw: string | undefined): SystemContextResolution {
  const systemContext = raw?.trim();
  if (!systemContext) return { kind: 'absent' };
  if (systemContext.length > PROMPT_TEXT_MAX) return { kind: 'tooLong', length: systemContext.length };
  return { kind: 'ok', systemContext };
}
