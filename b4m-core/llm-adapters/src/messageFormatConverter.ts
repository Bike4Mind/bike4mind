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
   * DeepSeek and Kimi REQUIRE it inside a tool-call loop; every other target must
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
    // reasoning_content is replayed only for DeepSeek and Kimi, which require the
    // prior turn's monologue back on this message inside a tool-call loop.
    // Stripped for every other target rather than passed through: those backends
    // mutate the caller's message array in place, ChatCompletionProcess builds
    // that array once and hands the same object to every backend it tries, so a
    // fallback hop off either would otherwise post a provider-private field to
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
  // request body (OpenAI, xAI, Kimi and DeepSeek all share this converter). Copied only when one of
  // the fields is actually set, so the usual message keeps its identity and no request pays for a
  // needless clone.
  if (msg.requiresTool !== undefined || msg.cache !== undefined || msg.perTurn !== undefined) {
    const { requiresTool: _requiresTool, cache: _cache, perTurn: _perTurn, ...providerSafe } = msg;
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

function isToolRoleMessage(msg: IMessage): boolean {
  return (msg.role as string) === 'tool';
}

/**
 * The tool_result blocks a `role: 'tool'` message carries: one built from an OpenAI-shape
 * `tool_call_id` message, or the blocks Gemini pushes under that role as-is.
 */
function toolResultsOf(msg: IMessage): MessageContentToolResult[] {
  const toolCallId = (msg as { tool_call_id?: unknown }).tool_call_id;
  if (typeof toolCallId === 'string') {
    return [
      {
        type: 'tool_result',
        tool_use_id: toolCallId,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      },
    ];
  }
  return Array.isArray(msg.content) ? (msg.content as MessageContentObject[]).filter(isToolResultBlock) : [];
}

function parseToolArguments(raw: string): MessageContentToolUse['input'] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as MessageContentToolUse['input'])
      : {};
  } catch {
    return {};
  }
}

function toolCallsToCanonical(msg: IMessage & { tool_calls: OpenAIToolCall[] }): IMessage {
  // reasoning_content is DeepSeek-private, and the Bedrock adapter forwards message objects
  // into its request body nearly as-is, so it must not survive the trip to another provider.
  const {
    tool_calls: toolCalls,
    content,
    reasoning_content: _reasoningContent,
    ...rest
  } = msg as typeof msg & { reasoning_content?: unknown };
  const text = typeof content === 'string' && content.trim() ? [{ type: 'text' as const, text: content }] : [];
  const toolUses: MessageContentToolUse[] = toolCalls.map(call => ({
    type: 'tool_use',
    id: call.id,
    name: call.function.name,
    input: parseToolArguments(call.function.arguments),
  }));
  return { ...rest, content: [...text, ...toolUses] } as IMessage;
}

/**
 * The inverse of convertMessagesToOpenAIFormat for tool history: rewrites OpenAI-shape
 * assistant `tool_calls` and every `role: 'tool'` message (OpenAI's, and Gemini's, which
 * already holds tool_result blocks) into canonical tool_use / tool_result blocks, folding each
 * run of consecutive tool messages into one user message.
 *
 * Backends push their tool rounds onto the caller's array in their own shape, and
 * ChatCompletionProcess hands that same array to the fallback hop. Canonical is B4M's own
 * shape: the Anthropic adapters read it directly and the OpenAI family converts it back on
 * the way out, so normalizing before a hop to another backend lets a turn cross providers
 * mid tool loop.
 *
 * Returns the input array itself when it holds no foreign tool history, and keeps
 * every untouched message by reference so per-message cache anchors survive.
 */
export function convertOpenAIToolHistoryToCanonical(messages: IMessage[]): IMessage[] {
  if (!messages.some(msg => hasToolCalls(msg) || isToolRoleMessage(msg))) return messages;

  const result: IMessage[] = [];
  let pendingResults: MessageContentToolResult[] = [];
  const flushResults = () => {
    if (pendingResults.length === 0) return;
    result.push({ role: 'user', content: pendingResults } as IMessage);
    pendingResults = [];
  };

  for (const msg of messages) {
    if (isToolRoleMessage(msg)) {
      pendingResults.push(...toolResultsOf(msg));
      continue;
    }
    flushResults();
    result.push(hasToolCalls(msg) ? toolCallsToCanonical(msg) : msg);
  }
  flushResults();
  return result;
}
