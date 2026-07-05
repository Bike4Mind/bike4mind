import type { CompletionInfo } from '@bike4mind/llm-adapters';
import type { Credits, StreamEvent, ToolUse, Usage } from './streamEvents';

/**
 * Strip <think>...</think> blocks from text.
 * Claude's extended thinking should not be shown in final output.
 */
export function stripThinkingBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/**
 * Extract usage and credit information into CompletionInfo shape.
 */
function extractUsageInfo(parsed: { usage?: Usage; credits?: Credits }): CompletionInfo {
  return {
    inputTokens: parsed.usage?.inputTokens,
    outputTokens: parsed.usage?.outputTokens,
    cacheReadInputTokens: parsed.usage?.cacheReadInputTokens,
    cacheCreationInputTokens: parsed.usage?.cacheCreationInputTokens,
    creditsUsed: parsed.credits?.used,
    usdCost: parsed.credits?.usdCost,
  };
}

/**
 * Reduces a stream of {@link StreamEvent}s (text, tool calls, thinking blocks,
 * usage) into a single accumulated assistant turn, then fires the completion
 * callback once at the end.
 *
 * Both backends - `ServerLlmBackend` (SSE) and `WebSocketLlmBackend` (WebSocket
 * frames) - decode their wire payloads into the shared event union and feed
 * each event to {@link apply}, so accumulation logic lives in exactly one
 * place and is transport-agnostic.
 */
export class StreamAccumulator {
  private accumulatedText = '';
  private toolsUsed: ToolUse[] = [];
  private thinkingBlocks: unknown[] = [];
  private lastUsageInfo: CompletionInfo = {};

  /**
   * Fold one streaming event into the accumulated turn. `error` events carry no
   * accumulable content - backends surface them by rejecting - so they are a
   * no-op here.
   */
  apply(event: StreamEvent): void {
    switch (event.type) {
      case 'content':
        this.accumulatedText += event.text ?? '';
        if (event.usage || event.credits) {
          this.lastUsageInfo = extractUsageInfo(event);
        }
        break;
      case 'tool_use':
        if (event.text) this.accumulatedText += event.text;
        if (event.tools && event.tools.length > 0) this.toolsUsed = event.tools;
        if (event.thinking && event.thinking.length > 0) this.thinkingBlocks = event.thinking;
        if (event.usage || event.credits) {
          this.lastUsageInfo = extractUsageInfo(event);
        }
        break;
      case 'error':
        break;
    }
  }

  /** True when neither text nor tools have been accumulated (stream produced nothing useful). */
  isEmpty(): boolean {
    return this.accumulatedText.trim().length === 0 && this.toolsUsed.length === 0;
  }

  get accumulatedLength(): number {
    return this.accumulatedText.length;
  }

  get toolCount(): number {
    return this.toolsUsed.length;
  }

  /** Raw accumulated text before thinking-block stripping (for debug logging). */
  get rawText(): string {
    return this.accumulatedText;
  }

  /**
   * Calls the completion callback with all accumulated content.
   * Strips thinking blocks from text before delivering.
   */
  async finalize(
    callback: (text: (string | null | undefined)[], info?: CompletionInfo) => Promise<void>
  ): Promise<void> {
    const cleanedText = stripThinkingBlocks(this.accumulatedText);

    if (this.toolsUsed.length > 0) {
      const info: CompletionInfo = {
        toolsUsed: this.toolsUsed,
        thinking: this.thinkingBlocks.length > 0 ? this.thinkingBlocks : undefined,
        ...this.lastUsageInfo,
      };
      await callback([cleanedText], info);
    } else if (cleanedText) {
      await callback([cleanedText], this.lastUsageInfo);
    }
  }
}
