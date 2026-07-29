import { ChatModels, IMessage, ModelBackend, type ModelInfo } from '@bike4mind/common';
import {
  ChoiceEndReason,
  ChoiceStatus,
  ICompletionOptions,
  ICompletionOptionTools,
  ICompletionResponseChunk,
  IChoiceEndToolUse,
} from '../backend';
import { BaseBedrockBackend } from './base';

/** The assistant payload Moonshot returns, on `message` or streamed as `delta`. */
interface MoonshotMessage {
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

/**
 * Moonshot's Kimi models served through Bedrock's InvokeModel path.
 *
 * Bedrock takes an OpenAI-shaped body here ({ messages, max_tokens }) and returns
 * an OpenAI-shaped response, so this is much closer to DeepSeek v3.1's branch than
 * to the Anthropic backend. It is a separate class from KimiBackend rather than a
 * baseURL swap because the transport is InvokeModel with SigV4, not HTTP+bearer.
 *
 * WHAT DIFFERS FROM DIRECT MOONSHOT, and why these are separate catalog rows:
 * - Output ceiling is 16K here against 262K direct. Same context (256K).
 * - No cache_read rate: Bedrock does not bill or report Moonshot cache hits.
 * - k2-thinking is text-only on Bedrock; k2.5 takes images (3 MB payload cap).
 * - The two ids do not share a prefix. That is AWS's inconsistency, not ours.
 *
 * NO INFERENCE-PROFILE PREFIX, unlike every other Bedrock id added here since
 * 2025 (`us.deepseek.r1-v1:0`, `global.anthropic.claude-opus-4-8`). Both model
 * cards list Geo AND Global inference as "Not supported", so these models are
 * In-Region only and no `us.`/`global.` profile exists to prefix with. That makes
 * them dependent on getRegionForModel's us-east-2 default (base.ts), which is a
 * supported In-Region for both - but it is a coupling worth knowing about if that
 * default ever changes.
 *
 * @see https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-5.html
 * @see https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-thinking.html
 */
export default class MoonshotBedrockBackend extends BaseBedrockBackend {
  /** Streaming-only: whether an unclosed `<think>` tag has been emitted. */
  private isInThinkingBlock = false;

  async getModelInfo(): Promise<ModelInfo[]> {
    return [
      {
        id: ChatModels.KIMI_K2_5_BEDROCK,
        type: 'text',
        name: 'Kimi K2.5 (Bedrock)',
        backend: ModelBackend.Bedrock,
        contextWindow: 262_144,
        max_tokens: 16_384,
        can_stream: true,
        pricing: {
          // $0.60 / 1M in, $3.00 / 1M out. This is the us-east-2 rate, which is
          // the only one that can apply: getRegionForModel (base.ts) sends every
          // id outside its us-east-1 allowlist to us-east-2, and both Kimi ids
          // are In-Region only - the model cards list Geo and Global inference as
          // unsupported, so there is no cross-region profile that could route a
          // call to a pricier region. @see https://aws.amazon.com/bedrock/pricing/
          262_144: { input: 0.6 / 1_000_000, output: 3 / 1_000_000 },
        },
        can_think: true,
        supportsVision: true,
        // Tools disabled on the Bedrock path pending #1119: this model emits Kimi's
        // native <|tool_call...|> token format inside the reasoning stream instead of
        // structured tool_calls, which nothing parses (it would leak as raw text and
        // never execute). The direct-served Kimi ids keep tools. See #1119 for the
        // native-token parser that re-enables this.
        supportsTools: false,
        supportsImageVariation: false,
        releaseDate: '2026-01-27',
        rank: 10,
        description:
          "Moonshot's Kimi K2.5 via AWS Bedrock - multimodal, 256K context, no provider key required. Output is capped at 16K here against 262K on Moonshot's own API.",
      },
      {
        id: ChatModels.KIMI_K2_THINKING_BEDROCK,
        type: 'text',
        name: 'Kimi K2 Thinking (Bedrock)',
        backend: ModelBackend.Bedrock,
        contextWindow: 262_144,
        max_tokens: 16_384,
        can_stream: true,
        pricing: {
          // $0.60 / 1M in, $2.50 / 1M out in the US regions.
          262_144: { input: 0.6 / 1_000_000, output: 2.5 / 1_000_000 },
        },
        can_think: true,
        // Text-only on Bedrock, unlike the direct-served Kimi family.
        supportsVision: false,
        // Tools disabled on the Bedrock path pending #1119 (native tool-call tokens
        // are emitted in the reasoning stream, not as structured tool_calls). The
        // direct-served Kimi ids keep tools.
        supportsTools: false,
        supportsImageVariation: false,
        releaseDate: '2025-11-06',
        rank: 10,
        description:
          "Moonshot's Kimi K2 Thinking via AWS Bedrock - chain-of-thought reasoning for math, coding and logic. Text only; 256K context with a 16K output ceiling.",
      },
    ];
  }

  formatMessages(messages: IMessage[]): IMessage[] {
    return messages;
  }

  getPayload(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>
  ): { modelId: string; contentType: string; accept: string; body: string } {
    // Tool-shaped messages (the assistant turn carrying `tool_calls`, and the
    // `role: 'tool'` result) must survive intact for the tool round-trip to work on
    // recursion. The previous mapping dropped the assistant turn (its `content` is
    // null) and remapped `role: 'tool'` to `'system'`, stripping `tool_call_id`, so
    // Moonshot saw no record its tool ran and re-issued the same call in a loop.
    const formattedMessages = messages
      .map(raw => {
        const m = raw as IMessage & { tool_calls?: unknown; tool_call_id?: string; name?: string };
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
          return { role: 'assistant', content: m.content ?? null, tool_calls: m.tool_calls } as Record<string, unknown>;
        }
        if (m.role === 'tool') {
          return {
            role: 'tool',
            tool_call_id: m.tool_call_id,
            name: m.name,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          } as Record<string, unknown>;
        }
        return {
          role: m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'system',
          content: typeof m.content === 'string' || Array.isArray(m.content) ? m.content : JSON.stringify(m.content),
        } as Record<string, unknown>;
      })
      // Drop only genuinely empty plain turns; never a tool-call turn (null content
      // but `tool_calls` present) or a tool result.
      .filter(m => {
        if ('tool_calls' in m || m.role === 'tool') return true;
        return typeof m.content === 'string' ? m.content !== '' : m.content !== null && m.content !== undefined;
      });

    const body: Record<string, unknown> = {
      messages: formattedMessages,
      // Bedrock's ceiling for both ids, and the parameter is required by the
      // Invoke body. Clamped rather than passed through: a caller asking for the
      // 262K the direct API allows would otherwise get a validation error.
      max_tokens: Math.min(options.maxTokens ?? 4_096, 16_384),
    };

    // Bedrock's copies accept a temperature (models.dev reports both as
    // temperature-capable), unlike most of the direct-served family.
    if (typeof options.temperature === 'number') body.temperature = options.temperature;
    if (typeof options.topP === 'number') body.top_p = options.topP;
    if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = options.stop;

    if (options.tools?.length) {
      body.tools = this.formatTools(options.tools);
      if (options.tool_choice !== undefined) body.tool_choice = options.tool_choice;
    }

    // A fresh request starts outside any thinking block; see translateStreamChunk.
    this.isInThinkingBlock = false;

    return {
      modelId: model,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    };
  }

  /** OpenAI tool shape, which is what Moonshot takes on the Invoke path. */
  formatTools(tools: ICompletionOptionTools[] = []) {
    return tools.map(tool => ({
      type: 'function' as const,
      function: tool.toolSchema,
    }));
  }

  translateChunk(model: string, chunk: Record<string, unknown>): { done: boolean; chunk: ICompletionResponseChunk } {
    return this.translate(model, chunk, { streaming: false });
  }

  /**
   * Streaming needs its own pass for one reason: `reasoning_content` arrives as a
   * delta per chunk, so wrapping each one in its own `<think></think>` (as a
   * straight delegation to translateChunk would) renders one thinking block per
   * token. The open tag is emitted once and closed when prose starts, matching
   * kimiBackend and xaiBackend; `isInThinkingBlock` is reset in getPayload so a
   * new request never inherits the previous one's state.
   */
  translateStreamChunk(
    model: string,
    chunk: Record<string, unknown>
  ): { done: boolean; chunk: ICompletionResponseChunk } {
    return this.translate(model, chunk, { streaming: true });
  }

  private translate(
    model: string,
    chunk: Record<string, unknown>,
    opts: { streaming: boolean }
  ): { done: boolean; chunk: ICompletionResponseChunk } {
    const response = chunk as {
      choices?: Array<{
        message?: MoonshotMessage;
        delta?: MoonshotMessage;
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      'amazon-bedrock-invocationMetrics'?: { inputTokenCount?: number; outputTokenCount?: number };
    };

    // Kimi quotes OpenAI's usage names; the normalized chunk wants Anthropic's, and
    // the base reads them off choices[0]. Streaming carries NO per-frame `usage` --
    // the only counts ride the final frame's `amazon-bedrock-invocationMetrics`, so
    // fall back to that or every streamed Bedrock turn settles on a zero-token
    // provider reading (billing then falls back to the local estimate).
    const metrics = response['amazon-bedrock-invocationMetrics'];
    const usage = {
      input_tokens: response.usage?.prompt_tokens ?? metrics?.inputTokenCount ?? 0,
      output_tokens: response.usage?.completion_tokens ?? metrics?.outputTokenCount ?? 0,
    };

    const choices: ICompletionResponseChunk['choices'] = [];

    for (const [index, choice] of (response.choices || []).entries()) {
      const payload = choice.message ?? choice.delta ?? {};
      const usageForIndex = index === 0 ? { usage } : {};

      // Tool calls are checked BEFORE reasoning. A thinking model that also calls
      // a tool emits both, and handling reasoning first would return the monologue
      // as the whole answer and never run the tool.
      const toolCalls = Array.isArray(payload.tool_calls) ? payload.tool_calls : [];
      if (toolCalls.length > 0) {
        for (const [toolIndex, call] of toolCalls.entries()) {
          const idx = call.index ?? toolIndex;
          if (opts.streaming) {
            // Streaming tool calls arrive OpenAI-style: a header delta (name + id)
            // then separate argument-fragment deltas. base.ts accumulates
            // `parameters` from chunkText ONLY when the reason is not TOOL_USE, so
            // emit the header with a `tool` object and each argument fragment as a
            // PLAIN chunk. Tagging every frame TOOL_USE (the previous behavior) made
            // the base skip every argument delta and run the tool with empty `{}`.
            if (call.function?.name || call.id) {
              choices.push({
                status: ChoiceStatus.STREAM,
                index: idx,
                chunkText: '',
                tool: { id: call.id || '', name: call.function?.name || '' },
              });
            }
            if (call.function?.arguments) {
              choices.push({ status: ChoiceStatus.STREAM, index: idx, chunkText: call.function.arguments });
            }
          } else {
            // Non-streaming: the message carries complete tool calls and the base
            // reads `tool.parameters` directly, so emit the full args as a TOOL_USE
            // end (one choice per call so several parallel calls can assemble).
            choices.push({
              status: ChoiceStatus.END,
              statusEndReason: ChoiceEndReason.TOOL_USE,
              index: idx,
              chunkText: call.function?.arguments || '',
              tool: {
                id: call.id || '',
                name: call.function?.name || '',
                parameters: call.function?.arguments || '',
              },
              ...usageForIndex,
            });
          }
        }
        continue;
      }

      const reasoning = payload.reasoning_content ?? '';
      const content = payload.content ?? '';

      // Bedrock Kimi does NOT populate `reasoning_content`; it inlines the monologue
      // in `content` wrapped in <reasoning>...</reasoning> -- a self-contained,
      // balanced pair per streamed delta. Convert that envelope to the <think>
      // convention the client renders, or the raw tags show verbatim in the answer.
      // Per-delta conversion (rather than merging into one block via
      // isInThinkingBlock) is deliberate: each Bedrock delta is already balanced, and
      // a reasoning-to-tool turn would otherwise strand an open <think> the base
      // cannot close once a tool frame appears. `reasoning_content` is still honored
      // as a fallback spelling for any variant that emits it.
      const convertTags = (t: string) => t.replace(/<reasoning>/g, '<think>').replace(/<\/reasoning>/g, '</think>');

      let chunkText: string;
      if (!opts.streaming) {
        chunkText = (reasoning ? `<think>${reasoning}</think>` : '') + convertTags(content);
      } else if (reasoning) {
        chunkText = this.isInThinkingBlock ? reasoning : `<think>${reasoning}`;
        this.isInThinkingBlock = true;
      } else if (this.isInThinkingBlock && content) {
        this.isInThinkingBlock = false;
        chunkText = `</think>${convertTags(content)}`;
      } else {
        chunkText = convertTags(content);
      }

      choices.push({
        status: ChoiceStatus.END,
        statusEndReason:
          choice.finish_reason === 'stop' || choice.finish_reason === 'length'
            ? ChoiceEndReason.STOP
            : ChoiceEndReason.COMPLETE,
        index,
        chunkText,
        ...usageForIndex,
      });
    }

    return { done: true, chunk: { model, choices } };
  }

  /**
   * OpenAI-shaped tool history: an assistant turn carrying `tool_calls`, then a
   * `role: 'tool'` message keyed by `tool_call_id`. `name` is included because
   * Moonshot's tool-call guide shows it on the result message.
   */
  pushToolMessages(messages: IMessage[], tool: IChoiceEndToolUse['tool'], result: string): unknown {
    messages.push({
      content: null,
      role: 'assistant',
      tool_calls: [
        {
          id: tool.id,
          type: 'function',
          function: { name: tool.name, arguments: tool.parameters },
        },
      ],
    } as unknown as IMessage);

    messages.push({
      role: 'tool',
      tool_call_id: tool.id,
      name: tool.name,
      content: JSON.stringify({ result }),
    } as unknown as IMessage);

    return messages;
  }
}
