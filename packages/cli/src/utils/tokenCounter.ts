import { get_encoding, Tiktoken } from 'tiktoken';
import type { Session } from '../storage/types.js';
import type { ModelInfo, MessageContent } from '@bike4mind/common';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';

const DEFAULT_CONTEXT_WINDOW = 200_000;

// Flat per-image cost used when a message carries inline/url image blocks.
// tiktoken cannot see image bytes, so we bill a fixed, deliberately generous
// estimate to keep windowing on the safe side.
const IMAGE_BLOCK_TOKEN_ESTIMATE = 1_600;

/**
 * Token counting utility for context window management.
 * Uses tiktoken (cl100k_base encoding) which works for Claude and GPT-4.
 */
export class TokenCounter {
  private encoder: Tiktoken | null = null;

  private getEncoder(): Tiktoken {
    if (!this.encoder) {
      // cl100k_base is the encoding used by Claude and GPT-4
      this.encoder = get_encoding('cl100k_base');
    }
    return this.encoder;
  }

  /**
   * Count tokens in a text string
   */
  countTokens(text: string): number {
    return this.getEncoder().encode(text).length;
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
    if (this.encoder) {
      this.encoder.free();
      this.encoder = null;
    }
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
