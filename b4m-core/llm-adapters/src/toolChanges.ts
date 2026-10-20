/** Beta that lets a `system` message carry tool_addition / tool_removal blocks between turns. */
export const TOOL_CHANGES_BETA = 'mid-conversation-tool-changes-2026-07-01';
export const PROMPT_CACHING_BETA = 'prompt-caching-2024-07-31';

/** The `anthropic-beta` header value for the requested betas, or undefined when none is. */
export function anthropicBetaHeader(betas: ReadonlyArray<string | false>): string | undefined {
  const present = betas.filter((beta): beta is string => beta !== false);
  return present.length > 0 ? present.join(',') : undefined;
}
