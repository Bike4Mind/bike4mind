import { get_encoding, Tiktoken } from 'tiktoken';
import type { Session } from '../storage/types.js';
import { tokenEstimateMultiplier } from '@bike4mind/common';
import type { ModelInfo, MessageContent } from '@bike4mind/common';
// Subpath, not the utils barrel: the barrel re-exports llm-adapters and fab-pipeline, which
// rolldown would then pull into the CLI bundle. Same pattern as @bike4mind/utils/globMatches.
import { scaleTokenEstimate } from '@bike4mind/utils/calibratedTokenizer';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';

const DEFAULT_CONTEXT_WINDOW = 200_000;

// Flat per-image cost used when a message carries inline/url image blocks.
// tiktoken cannot see image bytes, so we bill a fixed, deliberately generous
// estimate to keep windowing on the safe side.
const IMAGE_BLOCK_TOKEN_ESTIMATE = 1_600;

// Count cache bounds. Shorter text encodes about as fast as it hashes, so it is not cached. The
// character cap bounds the text the cache keeps alive (~2 bytes a char), several context windows'
// worth, so a whole session's history stays cached.
const TOKEN_CACHE_MIN_CHARS = 256;
const DEFAULT_TOKEN_CACHE_MAX_CHARS = 4_000_000;

/**
 * Token counting utility for context window management.
 * Uses tiktoken (cl100k_base encoding), the encoding GPT-4 reports. Claude's tokenizers spend more
 * tokens on the same text, so call `forModel(modelId)` before comparing a count against a model's
 * context window (see tokenEstimateMultiplier in @bike4mind/common).
 */
export class TokenCounter {
  private encoder: Tiktoken | null = null;
  // Raw cl100k_base counts keyed by the text itself, least recently used first. Every turn re-counts
  // the same history, system prompt and tool schemas (compaction check, history window, /context);
  // re-encoding them costs ~0.6 ms per 1k tokens on the main thread, hashing the key a fraction of that.
  private readonly countCache = new Map<string, number>();
  private cachedChars = 0;

  constructor(private readonly cacheMaxChars: number = DEFAULT_TOKEN_CACHE_MAX_CHARS) {}

  private getEncoder(): Tiktoken {
    if (!this.encoder) {
      // cl100k_base is the base encoding; forModel scales its counts for Claude.
      this.encoder = get_encoding('cl100k_base');
    }
    return this.encoder;
  }

  /**
   * A view of this counter whose counts are scaled to `modelId`'s own tokenizer, or `this` when the
   * model needs no scaling (non-Claude, or a Claude version tokenEstimateMultiplier leaves at 1). Use
   * it wherever a count is compared against a model's context window, so a Claude session compacts
   * and reports against real token usage rather than a cl100k_base undercount.
   */
  forModel(modelId: string | undefined): TokenCounter {
    const multiplier = tokenEstimateMultiplier(modelId);
    return multiplier === 1 ? this : new CalibratedTokenCounter(this, multiplier);
  }

  /**
   * Count tokens in a text string
   */
  countTokens(text: string): number {
    if (text.length < TOKEN_CACHE_MIN_CHARS || text.length > this.cacheMaxChars) {
      return this.encode(text);
    }

    const cached = this.countCache.get(text);
    if (cached !== undefined) {
      // Re-insert so Map order stays least-recently-used first.
      this.countCache.delete(text);
      this.countCache.set(text, cached);
      return cached;
    }

    const count = this.encode(text);
    this.countCache.set(text, count);
    this.cachedChars += text.length;
    for (const [oldest] of this.countCache) {
      if (this.cachedChars <= this.cacheMaxChars) break;
      this.countCache.delete(oldest);
      this.cachedChars -= oldest.length;
    }
    return count;
  }

  private encode(text: string): number {
    // encode_ordinary, not encode: pasted text, file content and tool output can all contain a
    // special-token literal ("<|endoftext|>"), which makes encode reject. Callers here do not guard
    // it (turnController, ConversationContext, /context), so that throw breaks the turn or command.
    // See TiktokenTokenizer in @bike4mind/utils for the why.
    return this.getEncoder().encode_ordinary(text).length;
  }

  /**
   * Count tokens in a message's content, whether it is a plain string or an
   * array of structured blocks (text / tool_use / tool_result / image). Text is
   * tiktoken-counted; images are billed a flat estimate since their bytes are
   * opaque to the tokenizer.
   */
  countMessageContent(content: MessageContent): number {
    if (typeof content === 'string') {
      return this.countTokens(content);
    }

    return content.reduce((sum, block) => {
      switch (block.type) {
        case 'text':
          return sum + this.countTokens(block.text ?? '');
        case 'thinking':
          return sum + this.countTokens(block.thinking ?? '');
        case 'tool_use':
          return sum + this.countTokens(`${block.name ?? ''} ${JSON.stringify(block.input ?? {})}`);
        case 'tool_result':
          return sum + this.countTokens(block.content ?? '');
        case 'image':
        case 'image_url':
          return sum + IMAGE_BLOCK_TOKEN_ESTIMATE;
        default:
          return sum;
      }
    }, 0);
  }

  /**
   * Count tokens used in a session including system prompt
   */
  countSessionTokens(
    session: Session,
    systemPrompt: string
  ): {
    systemPromptTokens: number;
    messageTokens: number;
    totalTokens: number;
  } {
    const systemPromptTokens = this.countTokens(systemPrompt);
    const messageTokens = session.messages.reduce((sum, msg) => sum + this.countTokens(msg.content), 0);

    return {
      systemPromptTokens,
      messageTokens,
      totalTokens: systemPromptTokens + messageTokens,
    };
  }

  /**
   * Get context window size for a model
   * Falls back to DEFAULT_CONTEXT_WINDOW if model info not available
   */
  getContextWindow(modelId: string, availableModels?: ModelInfo[]): number {
    const model = availableModels?.find(m => m.id === modelId);
    return model?.contextWindow || DEFAULT_CONTEXT_WINDOW;
  }

  /**
   * Count tokens in tool schemas.
   * Tool schemas are sent as part of the API call and consume context.
   */
  countToolSchemaTokens(tools: ICompletionOptionTools[]): number {
    if (tools.length === 0) return 0;

    const schemaText = tools
      .map(
        ({ toolSchema }) =>
          `Tool: ${toolSchema.name}\nDescription: ${toolSchema.description}\nParameters: ${JSON.stringify(toolSchema.parameters)}`
      )
      .join('\n\n');

    return this.countTokens(schemaText);
  }

  /**
   * Free encoder resources when done
   */
  dispose(): void {
    this.countCache.clear();
    this.cachedChars = 0;
    if (this.encoder) {
      this.encoder.free();
      this.encoder = null;
    }
  }
}

/**
 * A calibrated view over a raw `TokenCounter`. `countTokens` is the one primitive every other count
 * routes through, so overriding it calibrates message, session and tool-schema counts at once. The
 * flat image estimate stays unscaled because it is not a tiktoken count. The view holds no encoder of
 * its own - it reads through `raw` - so `dispose` is a no-op and disposing the view never frees the
 * shared encoder.
 */
class CalibratedTokenCounter extends TokenCounter {
  constructor(
    private readonly raw: TokenCounter,
    private readonly multiplier: number
  ) {
    super();
  }

  override countTokens(text: string): number {
    return scaleTokenEstimate(this.raw.countTokens(text), this.multiplier);
  }

  override dispose(): void {
    // Shares `raw`'s encoder; only its owner disposes it.
  }
}

// Singleton instance
let tokenCounter: TokenCounter | null = null;

/**
 * Get the singleton TokenCounter instance
 */
export function getTokenCounter(): TokenCounter {
  if (!tokenCounter) {
    tokenCounter = new TokenCounter();
  }
  return tokenCounter;
}
