// Interfaces and definitions for abstracting away the details of talking to an LLM.
// We break down the general tasks performed by an API into a set of interfaces.
//
// Tasks:
//  - Tokenizing/embedding
//  - Text completion
//  - Question/answer (Chat)

import {
  IMessage,
  type ModelInfo,
  type ReasoningEffort,
  type ICacheStrategy,
  type CacheUsageStats,
  type ResponseFormat,
} from '@bike4mind/common';

/** Maximum number of recursive tool calls to prevent infinite loops */
export const DEFAULT_MAX_TOOL_CALLS = 10;

export interface ITokenizingBackend {}

export enum ChoiceStatus {
  STREAM = 'stream',
  END = 'end',
}

interface IChoiceBase {
  chunkText?: string | null;
  index: number;
  status: ChoiceStatus;
  statusEndReason?: ChoiceEndReason;
  tool?: {
    name: string;
    id: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export interface IChoiceStream extends IChoiceBase {
  status: ChoiceStatus.STREAM;
  chunkText: string;
}

export enum ChoiceEndReason {
  COMPLETE = 'complete',
  STOP = 'stop',
  TOOL_USE = 'tool_use',
}

export interface IChoiceEndStop extends IChoiceBase {
  status: ChoiceStatus.END;
  statusEndReason: ChoiceEndReason.STOP;
}

export interface IChoiceEndComplete extends IChoiceBase {
  status: ChoiceStatus.END;
  statusEndReason: ChoiceEndReason.COMPLETE;
}

export interface IChoiceEndToolUse extends IChoiceBase {
  status: ChoiceStatus.END;
  statusEndReason: ChoiceEndReason.TOOL_USE;
  tool: {
    name: string;
    id: string;
    parameters: string;
  };
}

export type IChoiceEnd = IChoiceEndStop | IChoiceEndComplete | IChoiceEndToolUse;

export type IChoice = IChoiceStream | IChoiceEnd;

export interface ICompletionOptionTools {
  toolFn: (parameters?: unknown, apiKey?: string) => Promise<string>;
  toolSchema: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: {
        [key: string]: {
          type?: string;
          description: string;
          enum?: string[] | number[];
          additionalProperties?: unknown;
          items?: unknown;
          oneOf?: Array<{ type: string; items?: unknown }>;
        };
      };
      additionalProperties?: boolean;
      required?: string[];
    };
    strict?: boolean;
  };
  _isMcpTool?: boolean; // Flag to identify MCP tools (enables tool chaining for MCP only)
}

export interface ICompletionOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stop?: string | string[] | null;
  n?: number;
  logprobs?: number;
  echo?: boolean;
  stream?: boolean;
  bestOf?: number;
  logitBias?: { [key: string]: number };
  tools: ICompletionOptionTools[];
  /** If false, backend returns tool calls without executing (for CLI). Default: true */
  executeTools?: boolean;
  /**
   * Controls which tool the model should use.
   * - 'auto': Model decides whether to call a tool (default)
   * - 'required': Model must call at least one tool
   * - { type: 'function', function: { name: string } }: Forces a specific function call
   * @see https://platform.openai.com/docs/api-reference/chat/create#chat-create-tool_choice
   */
  tool_choice?: 'auto' | 'required' | { type: 'function'; function: { name: string } };
  /**
   * Whether to enable parallel function calling. Set to false for structured outputs.
   * When using tool_choice to force a specific function, set this to false.
   * @see https://platform.openai.com/docs/guides/function-calling
   */
  parallel_tool_calls?: boolean;
  thinking?: {
    enabled: boolean;
    budget_tokens: number;
  };
  stop_sequences?: string[];
  abortSignal?: AbortSignal;
  /**
   * Auto-classified query complexity used to determine reasoning effort
   * when reasoningEffort is not explicitly set
   */
  complexity?: 'simple' | 'contextual' | 'complex';
  /**
   * Explicit reasoning effort level for OpenAI reasoning models (O1, O3, GPT-5 series)
   * When set, overrides the auto-classification from complexity
   * @see https://platform.openai.com/docs/guides/reasoning
   */
  reasoningEffort?: ReasoningEffort;
  _internal?: {
    toolCallCount?: number; // Internal counter for tracking recursive tool calls (do not set manually)
    /** Per-request override for the recursive tool-call ceiling (defaults to DEFAULT_MAX_TOOL_CALLS).
     * When the count hits this, tools are stripped so the model must answer - lowered by
     * some product surfaces so an eager model can't burn round-trips re-emitting capped tool calls. */
    maxToolCalls?: number;
    enableIdleTimeout?: boolean; // Enable idle timeout detection for streaming (Anthropic only)
    enableRequestTimeout?: boolean; // Enable request-level timeout for API calls that hang before streaming (Anthropic only)
    idleTimeoutMs?: number; // Custom idle timeout in milliseconds (defaults to 90s standard, 180s thinking)
    /**
     * Multi-turn token accumulators threaded through recursive complete() calls.
     * Each provider API call (every tool round-trip) is billed independently;
     * the terminal turn emits the accumulated total to cb so credit tracking
     * sees full multi-turn usage despite cliCompletions' assign-not-add pattern.
     * Internal - do not set manually.
     */
    accumInputTokens?: number;
    accumOutputTokens?: number;
    /**
     * Multi-turn tool-call accumulator threaded through recursive complete() calls
     * (Ollama). Consumers assign rather than append functionCalls on each callback,
     * so the terminal turn must emit the full accumulated list or earlier tool
     * calls are lost. Internal - do not set manually.
     */
    accumToolsUsed?: Array<{ name: string; arguments?: string; id?: string }>;
  };
  /** Provider-agnostic caching strategy configuration */
  cacheStrategy?: ICacheStrategy;
  /**
   * Structured-output contract. When set to `{ type: 'json_schema', ... }`,
   * native-mode providers (OpenAI) pass the schema through to the API; tool-mode
   * providers (Anthropic) synthesize a single tool from the schema and force
   * `tool_choice: { type: 'tool', name }`; best-effort providers (Bedrock, Gemini,
   * xAI, Ollama) inject a "respond with JSON matching this schema" instruction.
   * The selected mode is reported back via `CompletionInfo.responseFormatMode`
   * so callers can decide whether to post-validate.
   */
  responseFormat?: ResponseFormat;
  /**
   * Execute all tool calls returned in a single LLM turn in parallel using Promise.allSettled.
   * Results are injected back in original order so the conversation history is always consistent.
   * Set to false to fall back to sequential execution (e.g., for tools with shared mutable state).
   * Default: true
   */
  parallelToolExecution?: boolean;
  /**
   * Maximum number of tools to execute concurrently in a single parallel batch.
   * Prevents resource exhaustion (DB connection pools, API rate limits, memory spikes)
   * when an LLM returns a large number of tool calls in one turn.
   * Only applies when parallelToolExecution is enabled (default: true).
   * Default: 8
   */
  maxParallelTools?: number;
}

export interface ICompletionResponse {
  vendorApiResponseId: string;
  choices: Array<{
    message: string;
    index: number;
    finishReason: 'stop' | 'length';
  }>;
  created: Date;
  model: string;
}

// Receiving a chunk of response:  We can also receive the _whole_
// response in one chunk, so this covers both.  OpenAI has the most
// extensive support (multiple choices for the same reply, streaming
// independently), and the others can cleanly map onto that structure,
// so we use that to model our API.
export interface ICompletionResponseChunk {
  model: string;
  choices: Array<IChoice>;
}

export type CompletionCallback = (done: boolean, chunk?: ICompletionResponseChunk) => Promise<void>;
export type CompletionInfo = {
  inputTokens?: number;
  outputTokens?: number;
  creditsUsed?: number;
  usdCost?: number;
  toolsUsed?: Array<{
    name: string;
    arguments?: string;
    /** Tool use ID for Anthropic API tool pairing */
    id?: string;
  }>;
  /**
   * The complete assistant message content including thinking blocks.
   * Required for Anthropic extended thinking when tools are used,
   * as subsequent API calls must include thinking blocks.
   */
  thinking?: unknown[];
  /**
   * Tool results from executed tools. Used for conversation history reconstruction.
   */
  toolResults?: Array<{
    tool_use_id: string;
    content: string;
    is_error?: boolean;
  }>;
  /** Prompt caching statistics (if caching was enabled) */
  cacheStats?: CacheUsageStats;
  /**
   * Anthropic-style cache token deltas. Surfaced separately from `inputTokens`
   * so credit accounting can apply provider-specific multipliers (read: 0.1x,
   * write: 1.25x of base input rate).
   */
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /**
   * How the backend honored `responseFormat`:
   * - 'native': provider's native structured-output API (OpenAI's response_format)
   * - 'tool_use': synthesized tool with forced tool_choice (Anthropic)
   * - 'best-effort': prompt-only instruction (Bedrock, Gemini, xAI, Ollama)
   * Surfaced to the caller via the `X-B4M-Response-Format-Mode` SSE field so
   * clients know whether to post-validate.
   */
  responseFormatMode?: 'native' | 'tool_use' | 'best-effort';
  /**
   * The provider's reason for ending generation. Anthropic emits its native vocabulary
   * directly: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | 'pause_turn'.
   * Every other backend normalizes its own native value onto this same vocabulary via
   * the helpers in stopReason.ts, which also emit the OpenAI/Gemini/Ollama-native
   * 'stop' as a first-class clean-finish value alongside Anthropic's 'end_turn'.
   * 'max_tokens' means the output was truncated against the token ceiling - used
   * downstream to flag truncated artifacts and surface a recovery UI. The client's
   * CLEAN_FINISH_REASONS (apps/client/.../PromptReplies.tsx) is the authoritative set
   * of values treated as a clean finish; anything else - including an unrecognized
   * provider value passed through unchanged - falls through to the truncation heuristic.
   */
  stopReason?: string;
};

export interface ICompletionBackend {
  /**
   * The currently selected model for this backend instance
   */
  currentModel: string;

  /**
   * function that handles the API completion request to different LLM models
   *
   * @param model LLM model being used
   * @param messages Array of messages to be sent to the LLM
   * @param options LLM API options
   * @param callback Callback function which handle the received streamed text from the LLM
   * */
  complete(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>,
    callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
  ): Promise<void>;

  /**
   * Push tool call + result messages into the conversation history.
   * Each backend formats these according to its provider's API requirements
   * (e.g., OpenAI uses role=tool, Anthropic uses tool_use/tool_result content blocks).
   */
  pushToolMessages(
    messages: IMessage[],
    tool: IChoiceEndToolUse['tool'],
    result: string,
    thinkingBlocks?: unknown[]
  ): void;

  /**
   * Surgically replace the observation content on the most recent `tool_result`
   * message (Anthropic-style) OR the most recent `role: 'tool'` message
   * (OpenAI-style) whose tool-call id matches `toolCallId`. Used by the agent
   * executor's resume-after-handoff path to inject a Lambda-dispatched
   * subagent's terminal answer into the parent's message history without
   * breaking LLM message coherence (Anthropic rejects consecutive same-role
   * messages, so we replace in place rather than appending).
   *
   * Throws if no matching message is found. Optional - backends that don't
   * yet support subagent delegation can omit; callers should detect and fail
   * with a clear error.
   */
  replaceLastToolResultObservation?(messages: IMessage[], toolCallId: string, newObservation: string): void;

  /**
   * Find the LLM-assigned id of the most recent tool call matching `toolName`.
   * Provider-specific: Anthropic scans assistant messages for `tool_use` content
   * blocks; OpenAI scans `assistant.tool_calls`. Returns `undefined` if no
   * matching call is found. Optional, paired with `replaceLastToolResultObservation`
   * - both are needed for the subagent-handoff resume path.
   */
  getLatestToolCallId?(messages: IMessage[], toolName: string): string | undefined;

  /**
   * Get the supported models' info for this backend
   */
  getModelInfo(): Promise<ModelInfo[]>;
}

/**
 * Shared implementation for backends whose `messages` array stores Anthropic-canonical
 * `tool_result` content blocks (Anthropic, Bedrock Anthropic). Mutates in place.
 */
export function replaceLastToolResultObservationCanonical(
  messages: IMessage[],
  toolCallId: string,
  newObservation: string
): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: string }).type === 'tool_result' &&
        (block as { tool_use_id?: string }).tool_use_id === toolCallId
      ) {
        (block as { content: string }).content = newObservation;
        return;
      }
    }
  }
  throw new Error(
    `replaceLastToolResultObservation: no Anthropic-style tool_result block with tool_use_id="${toolCallId}" found in messages`
  );
}

/**
 * Shared implementation for OpenAI-style backends that store separate
 * `role: 'tool'` messages with `tool_call_id`. Mutates in place.
 */
export function replaceLastToolResultObservationOpenAI(
  messages: IMessage[],
  toolCallId: string,
  newObservation: string
): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as IMessage & { tool_call_id?: string };
    if (msg.role === 'tool' && msg.tool_call_id === toolCallId) {
      (msg as { content: string }).content = newObservation;
      return;
    }
  }
  throw new Error(
    `replaceLastToolResultObservation: no role=tool message with tool_call_id="${toolCallId}" found in messages`
  );
}

/**
 * Shared implementation for `getLatestToolCallId` on Anthropic-canonical
 * backends. Scans assistant messages backwards for `tool_use` content blocks
 * with matching `name`. Returns the `id` field (LLM-assigned tool-call id).
 *
 * Tie-break: when a single assistant message contains multiple matching
 * `tool_use` blocks (parallel tool use), this returns the LAST block in array
 * order - symmetric with `getLatestToolCallIdOpenAI`. Iterates content blocks
 * in reverse for consistency.
 */
export function getLatestToolCallIdCanonical(messages: IMessage[], toolName: string): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    if (!Array.isArray(msg.content)) continue;
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j];
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: string }).type === 'tool_use' &&
        (block as { name?: string }).name === toolName
      ) {
        return (block as { id?: string }).id;
      }
    }
  }
  return undefined;
}

/**
 * Shared implementation for `getLatestToolCallId` on OpenAI-style backends.
 * Scans assistant messages backwards for a `tool_calls` array (set by
 * `pushToolMessages`) containing a function call with matching `name`.
 *
 * Tie-break: when a single assistant message contains multiple matching calls
 * (parallel tool use), this returns the LAST entry in `tool_calls` array order.
 * Callers that need to disambiguate between parallel calls must track the id
 * at dispatch time rather than recover it from history.
 */
export function getLatestToolCallIdOpenAI(messages: IMessage[], toolName: string): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as IMessage & {
      tool_calls?: Array<{ id?: string; function?: { name?: string } }>;
    };
    if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue;
    for (let j = msg.tool_calls.length - 1; j >= 0; j--) {
      const call = msg.tool_calls[j];
      if (call.function?.name === toolName && call.id) return call.id;
    }
  }
  return undefined;
}
