/**
 * Faux LLM backend for e2e testing.
 *
 * Implements ICompletionBackend with a scripted sequence of "turns." Each call
 * to `complete()` consumes the next turn from the script and invokes the
 * provided callback with that turn's text and tool-use payload.
 *
 * This pattern is already used inline in several test files (e.g.
 * b4m-core/agents/src/ReActAgent.parallel.test.ts). This module formalizes
 * it as the single source of truth for e2e tests.
 *
 * Design notes:
 * - Each turn represents one LLM completion. A typical multi-turn flow:
 *     turn 0: model returns tool_use -> agent executes tool -> pushes result
 *     turn 1: model returns final answer
 * - Tools are NOT executed inside the faux; the agent loop drives execution.
 *   The faux just declares "here's what tools the model wants to call."
 * - Errors are thrown synchronously from `complete()` so callers can verify
 *   fallback / retry behavior.
 */

import type { ICompletionBackend, CompletionInfo, ICompletionOptions } from '@bike4mind/llm-adapters';
import type { IMessage, ModelInfo } from '@bike4mind/common';

export interface FauxToolCall {
  name: string;
  arguments?: string;
  id?: string;
}

export interface FauxTurn {
  /** Text the model "produced" for this turn. */
  text?: string;
  /** Tools the model wants to call this turn. Agent loop will execute them. */
  toolsUsed?: FauxToolCall[];
  /** Anthropic-style thinking blocks, passed through to completionInfo. */
  thinking?: unknown[];
  /** If set, complete() throws this error on this turn. */
  error?: Error;
  inputTokens?: number;
  outputTokens?: number;
}

export interface FauxScript {
  /** One turn per .complete() call, consumed in order. */
  turns: FauxTurn[];
  /** Models to return from getModelInfo(). Defaults to a single 'faux-model'. */
  models?: ModelInfo[];
  /** Initial currentModel value. Defaults to first model id, or 'faux-model'. */
  currentModel?: string;
  /**
   * What to do when the script runs out of turns.
   * - 'throw' (default): throw - surfaces over-run as a test failure
   * - 'echo-final': repeat the last turn's text indefinitely
   * - 'empty': return empty text with no tools (lets agent settle)
   */
  onExhausted?: 'throw' | 'echo-final' | 'empty';
}

export interface FauxBackend extends ICompletionBackend {
  /** Number of times complete() has been called. */
  readonly callCount: number;
  /** Number of turns remaining in the script. */
  readonly turnsRemaining: number;
  /** History of every (model, messages, options) tuple complete() was called with. */
  readonly callLog: ReadonlyArray<{
    model: string;
    messages: IMessage[];
    options: Partial<ICompletionOptions>;
  }>;
  /** History of tool messages pushed via pushToolMessages(). */
  readonly pushedToolMessages: ReadonlyArray<{
    tool: { name: string; id: string; parameters?: string };
    result: string;
  }>;
}

const DEFAULT_MODEL_ID = 'faux-model';

function defaultModelInfo(id: string): ModelInfo {
  return {
    id,
    name: id,
    provider: 'faux',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsImages: false,
    supportsThinking: true,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
  } as ModelInfo;
}

export function createFauxBackend(script: FauxScript): FauxBackend {
  const models = script.models?.length ? script.models : [defaultModelInfo(DEFAULT_MODEL_ID)];
  const initialModel = script.currentModel ?? models[0].id;
  const onExhausted = script.onExhausted ?? 'throw';

  let callCount = 0;
  const callLog: Array<{ model: string; messages: IMessage[]; options: Partial<ICompletionOptions> }> = [];
  const pushedToolMessages: Array<{
    tool: { name: string; id: string; parameters?: string };
    result: string;
  }> = [];

  const backend = {
    currentModel: initialModel,

    async complete(
      model: string,
      messages: IMessage[],
      options: Partial<ICompletionOptions>,
      callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
    ): Promise<void> {
      callLog.push({ model, messages: [...messages], options });

      let turn: FauxTurn;
      if (callCount < script.turns.length) {
        turn = script.turns[callCount];
      } else if (onExhausted === 'echo-final' && script.turns.length > 0) {
        turn = script.turns[script.turns.length - 1];
      } else if (onExhausted === 'empty') {
        turn = { text: '' };
      } else {
        throw new Error(
          `[faux-llm] Script exhausted after ${callCount} call(s). ` +
            `Add more turns or set onExhausted: 'echo-final' / 'empty'.`
        );
      }

      callCount++;

      if (turn.error) {
        throw turn.error;
      }

      const completionInfo: CompletionInfo = {
        inputTokens: turn.inputTokens ?? 100,
        outputTokens: turn.outputTokens ?? 50,
        toolsUsed: turn.toolsUsed ?? [],
        thinking: turn.thinking,
      };

      await callback([turn.text ?? ''], completionInfo);
    },

    pushToolMessages(
      _messages: IMessage[],
      tool: { name: string; id: string; parameters?: string },
      result: string,
      _thinkingBlocks?: unknown[]
    ): void {
      pushedToolMessages.push({ tool, result });
    },

    async getModelInfo(): Promise<ModelInfo[]> {
      return models;
    },

    get callCount() {
      return callCount;
    },
    get turnsRemaining() {
      return Math.max(0, script.turns.length - callCount);
    },
    get callLog() {
      return callLog;
    },
    get pushedToolMessages() {
      return pushedToolMessages;
    },
  };

  // Double-cast is intentional: the faux's pushToolMessages uses a narrowed
  // `tool` shape ({ name, id, parameters? }) for test readability rather than
  // the full IChoiceEndToolUse['tool'], so the literal is not directly
  // assignable to ICompletionBackend. The faux honors the runtime contract the
  // agent loop exercises; the narrowing is a deliberate test simplification.
  return backend as unknown as FauxBackend;
}
