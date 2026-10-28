import type { MessageContentObject } from '@bike4mind/common';

/**
 * The thinking entries a CLI backend may splice into a replayed assistant
 * tool_use message. Only structured blocks (Anthropic `thinking` /
 * `redacted_thinking`) qualify. OpenAI-compatible backends such as Kimi report
 * raw `reasoning_content` as a bare string, and spliced into `content` the
 * server normalizes it to a `text` block, so the private monologue would be
 * replayed to the provider as text the model said out loud.
 */
export function replayableThinkingBlocks(thinkingBlocks: unknown[] | undefined): MessageContentObject[] {
  return (thinkingBlocks ?? []).filter(
    (block): block is MessageContentObject => typeof block === 'object' && block !== null && 'type' in block
  );
}
