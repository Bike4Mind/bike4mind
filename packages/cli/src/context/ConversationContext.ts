import { v4 as uuidv4 } from 'uuid';
import type {
  IMessage,
  MessageContent,
  MessageContentObject,
  MessageContentToolUse,
  MessageContentToolResult,
} from '@bike4mind/common';
import type { AgentResult, AgentStep } from '@bike4mind/agents';
import type { Message, Session } from '../storage/types.js';
import { getTokenCounter, TokenCounter } from '../utils/tokenCounter.js';

/**
 * Tokens held back from the context window for things this module does not own:
 * the system prompt and headroom for the model's response. Callers that know
 * their real system-prompt size should pass `reservedTokens` to be precise.
 */
export const DEFAULT_RESERVED_TOKENS = 8_000;

/**
 * Per-turn cap on how much of a past turn's tool trace is replayed as text.
 * Bounds recall so fixing "the CLI forgets tool results" does not silently
 * re-bloat context and re-trigger compaction.
 */
export const DEFAULT_TOOL_TRACE_REPLAY_TOKENS = 1_500;

/** Max characters of a single tool input/result rendered into a replay line. */
const TOOL_TRACE_FIELD_CHARS = 400;

/** User input for a turn: plain text, or structured blocks (e.g. multimodal). */
export type UserInput = string | MessageContentObject[];

/** A finished turn: what the user sent, and what the agent returned. */
export interface CompletedTurn {
  userInput: UserInput;
  result: AgentResult;
}

export interface BuildOptions {
  model: string;
  contextWindow: number;
  /** Override the system-prompt + response reserve. Defaults to DEFAULT_RESERVED_TOKENS. */
  reservedTokens?: number;
  /** Override the per-turn tool-trace replay budget. Defaults to DEFAULT_TOOL_TRACE_REPLAY_TOKENS. */
  toolTraceReplayTokens?: number;
}

/**
 * Owns the whole "session messages -> LLM messages" transformation behind a
 * narrow interface. It is the single place that decides how much history a turn
 * gets, maps the persisted model to the agent's IMessage type without losing the
 * tool trace, bounds tool-trace replay, and serializes back for persistence.
 *
 * Persistence keeps the rich form (tool_use / tool_result blocks) losslessly on
 * `Message.richContent`. Replay renders each past turn's tool trace into a
 * bounded text appendix rather than emitting raw provider-native tool blocks,
 * which would need exact assistant/user pairing and could re-bloat context.
 */
export class ConversationContext {
  private readonly base: Session;
  private messages: Message[];
  private readonly counter: TokenCounter;

  private constructor(session: Session, counter: TokenCounter) {
    this.base = session;
    this.messages = [...session.messages];
    this.counter = counter;
  }

  /**
   * Back-compat read: loads a session as-is. Legacy string-only messages need no
   * upgrade - they are read through `content` and only wrapped into blocks lazily
   * when a turn actually carries a `richContent` trace.
   */
  static fromSession(session: Session, counter: TokenCounter = getTokenCounter()): ConversationContext {
    return new ConversationContext(session, counter);
  }

  /**
   * Append a completed turn. Persists the RICH form: the user message (text, or
   * multimodal blocks preserved on `richContent`) and the assistant message with
   * its tool_use / tool_result trace on `richContent`, plus the final answer as
   * the display `content`.
   */
  recordTurn(turn: CompletedTurn): void {
    this.messages.push(this.buildUserMessage(turn.userInput));
    this.messages.push(this.buildAssistantMessage(turn.result));
  }

  /**
   * The one place that builds the IMessage[] for the next turn. Returns the
   * windowed history followed by the current input as the final user message.
   * Windowing is token-aware: it reserves room for the system prompt, the
   * response, and the current input, then fills from the most recent turn
   * backward, dropping the oldest turns first. The current input is never
   * dropped (the protected suffix).
   */
  buildTurnMessages(newInput: UserInput, opts: BuildOptions): IMessage[] {
    return [...this.windowedHistory(newInput, opts), this.inputToIMessage(newInput)];
  }

  /**
   * The windowed history only, WITHOUT the current input appended. Convenience
   * for hosts whose agent API takes the current input as a separate query and
   * the history as `previousMessages` (e.g. the CLI's `agent.run`). Budgeting
   * still reserves room for `newInput`, so the two together fit the window.
   */
  buildPreviousMessages(newInput: UserInput, opts: BuildOptions): IMessage[] {
    return this.windowedHistory(newInput, opts);
  }

  /**
   * Whether the session should be compacted before the next turn. Measures the
   * FULL session (not the windowed subset) as it would actually be sent -
   * rendering each turn's bounded tool trace - plus the system prompt, and
   * compares against `thresholdRatio` of the context window. Rich-content aware:
   * replaces the old string-only `content` sum so a session whose weight lives
   * in tool traces still triggers compaction.
   */
  needsCompaction(systemPromptTokens: number, opts: BuildOptions, thresholdRatio = 0.8): boolean {
    return this.estimateSessionTokens(systemPromptTokens, opts) >= opts.contextWindow * thresholdRatio;
  }

  /**
   * Rich-aware token estimate for the whole session as it would be replayed:
   * every user/assistant turn rendered (bounded tool traces included) plus the
   * system prompt. Used by `needsCompaction`.
   */
  estimateSessionTokens(systemPromptTokens: number, opts: BuildOptions): number {
    const rendered = this.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .reduce((sum, m) => sum + this.estimateTokens(this.renderHistoryMessage(m, opts)), 0);
    return systemPromptTokens + rendered;
  }

  /** Serialize back to a Session for on-disk persistence (rich content preserved). */
  toSession(): Session {
    return {
      ...this.base,
      messages: this.messages,
      updatedAt: new Date().toISOString(),
    };
  }

  // --- internals -----------------------------------------------------------

  /**
   * The most-recent contiguous window of history that fits the token budget
   * after reserving room for the system prompt, the response, and the current
   * input. Fills newest-first and stops at the first turn that no longer fits,
   * so the oldest turns are dropped first and the current input is never
   * crowded out.
   */
  private windowedHistory(newInput: UserInput, opts: BuildOptions): IMessage[] {
    const reserved = opts.reservedTokens ?? DEFAULT_RESERVED_TOKENS;
    const currentTokens = this.estimateTokens(this.inputToIMessage(newInput));

    const history = this.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => this.renderHistoryMessage(m, opts));

    let remaining = opts.contextWindow - reserved - currentTokens;
    const kept: IMessage[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
      const cost = this.estimateTokens(history[i]);
      if (cost > remaining) break;
      remaining -= cost;
      kept.unshift(history[i]);
    }
    return kept;
  }

  private buildUserMessage(input: UserInput): Message {
    const base = {
      id: uuidv4(),
      role: 'user' as const,
      timestamp: new Date().toISOString(),
    };
    if (typeof input === 'string') {
      return { ...base, content: input };
    }
    // Multimodal: keep the blocks losslessly, derive a display string from text.
    const text = input
      .filter(b => b.type === 'text')
      .map(b => b.text ?? '')
      .join('\n');
    return { ...base, content: text, richContent: input };
  }

  private buildAssistantMessage(result: AgentResult): Message {
    const richContent = reconstructTurnBlocks(result.steps, result.finalAnswer);
    return {
      id: uuidv4(),
      role: 'assistant',
      content: result.finalAnswer,
      timestamp: new Date().toISOString(),
      // Only attach richContent when there is a real tool trace; a plain answer
      // stays string-only so it round-trips identically to a legacy message.
      ...(richContent ? { richContent } : {}),
    };
  }

  /** Map a persisted message to the IMessage the agent replays as history. */
  private renderHistoryMessage(message: Message, opts: BuildOptions): IMessage {
    const role = message.role === 'assistant' ? 'assistant' : 'user';

    if (!message.richContent) {
      return { role, content: message.content };
    }

    if (role === 'user') {
      // User blocks (text / image) are provider-safe to replay as-is.
      return { role, content: message.richContent };
    }

    // Assistant: render the tool trace to a bounded text appendix.
    return { role, content: this.renderAssistantTrace(message, opts) };
  }

  private renderAssistantTrace(message: Message, opts: BuildOptions): string {
    const blocks = message.richContent ?? [];
    const budget = opts.toolTraceReplayTokens ?? DEFAULT_TOOL_TRACE_REPLAY_TOKENS;

    const textBlocks = blocks.filter(b => b.type === 'text').map(b => b.text ?? '');
    const finalText = textBlocks.length > 0 ? textBlocks.join('\n') : message.content;

    const results = new Map<string, string>();
    for (const b of blocks) {
      if (b.type === 'tool_result' && b.tool_use_id) {
        results.set(b.tool_use_id, b.content ?? '');
      }
    }

    const lines: string[] = [];
    let used = 0;
    let omitted = 0;
    for (const b of blocks) {
      if (b.type !== 'tool_use') continue;
      const resultText = (b.id && results.get(b.id)) || '';
      const line = `[tool ${b.name}] ${this.brief(JSON.stringify(b.input ?? {}))} -> ${this.brief(resultText)}`;
      const cost = this.counter.countTokens(line);
      if (used + cost > budget) {
        omitted++;
        continue;
      }
      used += cost;
      lines.push(line);
    }
    if (omitted > 0) {
      lines.push(`[... ${omitted} more tool call${omitted === 1 ? '' : 's'} omitted]`);
    }

    if (lines.length === 0) return finalText;
    return `${finalText}\n\n<tool-trace>\n${lines.join('\n')}\n</tool-trace>`;
  }

  private brief(text: string): string {
    if (text.length <= TOOL_TRACE_FIELD_CHARS) return text;
    return `${text.slice(0, TOOL_TRACE_FIELD_CHARS)}... (+${text.length - TOOL_TRACE_FIELD_CHARS} chars)`;
  }

  private inputToIMessage(input: UserInput): IMessage {
    return { role: 'user', content: input };
  }

  private estimateTokens(message: IMessage): number {
    return this.counter.countMessageContent(message.content as MessageContent);
  }
}

/**
 * Reconstruct tool_use / tool_result blocks from the agent's steps, pairing
 * each observation to the earliest still-unmatched action (FIFO). This is exact
 * for sequential tool use; with parallel execution the pairing is best-effort by
 * order, which is fine for context replay. Returns undefined when the turn used
 * no tools (so the message stays string-only and round-trips like a legacy one).
 *
 * Exported so hosts that manage their own message store (e.g. the CLI's live
 * pending-message UI) can attach the rich trace to their assistant message
 * without going through `recordTurn`.
 */
export function reconstructTurnBlocks(steps: AgentStep[], finalAnswer: string): MessageContentObject[] | undefined {
  const blocks: MessageContentObject[] = [];
  const pendingIds: string[] = [];
  let toolCounter = 0;

  for (const step of steps) {
    if (step.type === 'action') {
      const id = `tu_${toolCounter++}`;
      pendingIds.push(id);
      const toolUse: MessageContentToolUse = {
        type: 'tool_use',
        id,
        name: step.metadata?.toolName ?? 'unknown',
        input: normalizeToolInput(step.metadata?.toolInput),
      };
      blocks.push(toolUse);
    } else if (step.type === 'observation') {
      const id = pendingIds.shift() ?? `tu_${toolCounter++}`;
      const toolResult: MessageContentToolResult = {
        type: 'tool_result',
        tool_use_id: id,
        content: typeof step.content === 'string' ? step.content : String(step.content ?? ''),
      };
      blocks.push(toolResult);
    }
  }

  if (blocks.length === 0) return undefined;

  blocks.push({ type: 'text', text: finalAnswer });
  return blocks;
}

function normalizeToolInput(input: unknown): { [key: string]: unknown } {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as { [key: string]: unknown };
  }
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as { [key: string]: unknown };
      }
    } catch {
      // fall through to wrapping the raw string
    }
    return { value: input };
  }
  return {};
}
