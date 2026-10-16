import { B4MLLMToolsList, isToolHiddenBySurface } from '@bike4mind/common';
import { premiumLlmTools } from '@server/premium-generated/premiumLlmTools.generated';

/**
 * Tool names (core and overlay-contributed) to withhold from a turn because the user hid the
 * workspace they belong to and the session is not in it (`isToolHiddenBySurface`). Pure: the caller
 * supplies the session's surface. Shared by the chat routes (pages/api/chat.ts, pages/api/ai/llm.ts),
 * which add the result to the turn's `deniedTools`.
 */
export function hiddenSurfaceToolNames(
  hiddenSurfaces: readonly string[] | undefined | null,
  activeSurface: string | null | undefined
): Set<string> {
  if (!hiddenSurfaces?.length) return new Set();
  const names = new Set<string>([...B4MLLMToolsList, ...Object.keys(premiumLlmTools)]);
  return new Set([...names].filter(name => isToolHiddenBySurface(name, hiddenSurfaces, activeSurface)));
}
