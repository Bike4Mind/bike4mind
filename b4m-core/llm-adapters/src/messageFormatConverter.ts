/**
 * Converts B4M's standard IMessage format to OpenAI-compatible format.
 *
 * B4M's canonical message format uses:
 *   - Assistant messages with `{ type: 'tool_use', id, name, input }` content blocks
 *   - User messages with `{ type: 'tool_result', tool_use_id, content }` content blocks
 *
 * OpenAI (and OpenAI-compatible APIs like xAI, Ollama) expect:
 *   - Assistant messages with a `tool_calls` array property
 *   - Separate `role: 'tool'` messages with `tool_call_id`
 *
 * This converter is used by OpenAI, xAI, and Ollama backends in their formatMessages() methods.
 */

import type {
  IMessage,
  MessageContentObject,
  MessageContentToolUse,
  MessageContentToolResult,
  MessageContentText,
} from '@bike4mind/common';

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIAssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  /** Only DeepSeek needs this replayed; see deepseekBackend.pushToolMessages. */
  reasoning_content?: string;
}

export interface OpenAIConvertOptions {
  /**
   * Replay `reasoning_content` on an assistant tool-call message that carries it.
   * DeepSeek REQUIRES it whenever the request has tools; every other target must
   * not receive it, so it defaults to off - see convertMessageToOpenAIFormat.
   */
  preserveReasoningContent?: boolean;
}

interface OpenAIToolMessage {
  role: 'tool';
  content: string;
  tool_call_id: string;
}

export type OpenAIFormattedMessage = OpenAIAssistantMessage | OpenAIToolMessage | IMessage;

/** Type guard: does this message already carry OpenAI-style `tool_calls`? */
function hasToolCalls(msg: IMessage): msg is IMessage & { tool_calls: OpenAIToolCall[] } {
  return msg.role === 'assistant' && 'tool_calls' in msg;
}

function isToolUseBlock(block: MessageContentObject): block is MessageContentToolUse {
  return block.type === 'tool_use';
}

function isToolResultBlock(block: MessageContentObject): block is MessageContentToolResult {
  return block.type === 'tool_result';
}

function isTextBlock(block: MessageContentObject): block is MessageContentText {
  return block.type === 'text';
}

/**
 * Convert a single IMessage from B4M standard format to OpenAI-compatible format.
 * Returns an array because a single user message with multiple tool_result blocks
 * expands into multiple OpenAI 'tool' role messages.
 *
 * Messages already in OpenAI format (with `tool_calls` property) pass through unchanged.
 * Messages without tool_use/tool_result content blocks pass through unchanged.
 */
export function convertMessageToOpenAIFormat(
  msg: IMessage,
  options: OpenAIConvertOptions = {}
): OpenAIFormattedMessage[] {
  // Already in OpenAI format (has tool_calls property from OpenAI backend's pushToolMessages)
  if (hasToolCalls(msg)) {
    // reasoning_content is replayed only for DeepSeek, which requires the prior
    // turn's monologue back on this message whenever the request has tools.
    // Stripped for every other target rather than passed through: DeepSeek
    // mutates the caller's message array in place, ChatCompletionProcess builds
    // that array once and hands the same object to every backend it tries, so a
    // fallback hop off DeepSeek would otherwise post a provider-private field to
    // whoever rescues the turn.
    const reasoningContent = (msg as { reasoning_content?: unknown }).reasoning_content;
    return [
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: msg.tool_calls,
        ...(options.preserveReasoningContent && typeof reasoningContent === 'string'
          ? { reasoning_content: reasoningContent }
          : {}),
      },
    ];
  }

  // Convert assistant messages with tool_use content blocks
  if (msg.role === 'assistant' && Array.isArray(msg.content)) {
    const contentBlocks = msg.content as MessageContentObject[];
    const toolUseBlocks = contentBlocks.filter(isToolUseBlock);

    if (toolUseBlocks.length > 0) {
      const textParts = contentBlocks
        .filter(isTextBlock)
        .map(block => block.text)
        .filter(Boolean);

      return [
        {
          role: 'assistant' as const,
          content: textParts.length > 0 ? textParts.join('\n') : null,
          tool_calls: toolUseBlocks.map(block => ({
            id: block.id,
            type: 'function' as const,
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          })),
        },
      ];
    }
  }

  // Convert user messages with tool_result content blocks
  if (msg.role === 'user' && Array.isArray(msg.content)) {
    const contentBlocks = msg.content as MessageContentObject[];
    const toolResultBlocks = contentBlocks.filter(isToolResultBlock);

    if (toolResultBlocks.length > 0) {
      return toolResultBlocks.map(block => ({
        role: 'tool' as const,
        content: block.content,
        tool_call_id: block.tool_use_id,
      }));
    }
  }

  // No conversion needed. This is the one branch that hands an IMessage straight to the provider
  // rather than rebuilding it, so a control-only field has to come off here or it rides along in the
  // request body (OpenAI, xAI and Kimi all share this converter). Copied only when the field is
  // actually set, so the usual message keeps its identity and no request pays for a needless clone.
  if (msg.requiresTool !== undefined) {
    const { requiresTool: _requiresTool, ...providerSafe } = msg;
    return [providerSafe];
  }
  return [msg];
}

/**
 * Convert an array of IMessages from B4M standard format to OpenAI-compatible format.
 * Returns OpenAIFormattedMessage[] - callers targeting OpenAI SDK types should cast at the boundary.
 */
export function convertMessagesToOpenAIFormat(
  messages: IMessage[],
  options: OpenAIConvertOptions = {}
): OpenAIFormattedMessage[] {
  return messages.flatMap(msg => convertMessageToOpenAIFormat(msg, options));
}
