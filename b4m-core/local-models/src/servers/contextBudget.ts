export const OUTPUT_RESERVE_TOKENS = 2_048;

/** Tokens a `numCtx` context keeps free for the reply. */
export function replyRoom(numCtx: number, maxTokens?: number): number {
  return Math.min(maxTokens ?? OUTPUT_RESERVE_TOKENS, Math.floor(numCtx / 4));
}

/** Whether a context the server fixes holds a prompt of `promptTokens` plus room for the reply. */
export function holdsPrompt(numCtx: number, promptTokens: number, maxTokens?: number): boolean {
  return promptTokens + replyRoom(numCtx, maxTokens) <= numCtx;
}
