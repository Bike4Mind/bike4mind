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
import { hasNativeToolMarker, parseNativeToolSection, KimiNativeToolStream } from './kimiNativeTools';
import { normalizeOpenAIFinishReason } from '../stopReason';

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

  /**
   * Streaming-only: extracts Kimi's native `<|tool_call...|>` tokens out of the
   * reasoning stream into structured calls. One instance per request; reset in
   * getPayload. See kimiNativeTools.
   */
  private nativeToolStream = new KimiNativeToolStream();

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
        // This model non-deterministically emits tool calls as Kimi's native
        // <|tool_call...|> tokens inside the reasoning stream instead of structured
        // tool_calls; kimiNativeTools filters those into structured calls (translate),
        // so tools work on the Bedrock path too. (#1119)
        supportsTools: true,
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
        // Native <|tool_call...|> tokens in the reasoning stream are filtered into
        // structured calls by kimiNativeTools, so tools work here too. (#1119)
        supportsTools: true,
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
      // The default IS that ceiling, not a smaller round number: both ids reason
      // inside max_tokens, so a 4K default was spent entirely on the monologue and
      // the turn ended mid-thought with no answer after it. ChatCompletionProcess
      // sizes this the same way (see REASONS_WITHIN_OUTPUT_BUDGET in
      // thinkingParams.ts); this keeps direct backend callers out of the same trap.
      max_tokens: Math.min(options.maxTokens ?? 16_384, 16_384),
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

    // A fresh request starts outside any thinking block, with an empty native-tool
    // buffer; see translateStreamChunk.
    this.isInThinkingBlock = false;
    this.nativeToolStream = new KimiNativeToolStream();

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
      // balanced pair per streamed delta -- which we convert to the <think>
      // convention the client renders. It ALSO non-deterministically emits tool
      // calls as native <|tool_call...|> tokens INSIDE that reasoning rather than as
      // structured tool_calls (see kimiNativeTools); those are filtered into
      // structured calls so they execute and never leak as raw text.
      const endReason =
        choice.finish_reason === 'stop' || choice.finish_reason === 'length'
          ? ChoiceEndReason.STOP
          : ChoiceEndReason.COMPLETE;
      const convertTags = (t: string) => t.replace(/<reasoning>/g, '<think>').replace(/<\/reasoning>/g, '</think>');

      if (opts.streaming) {
        // `reasoning_content` fallback spelling: merge into one <think> block.
        if (reasoning) {
          const chunkText = this.isInThinkingBlock ? reasoning : `<think>${reasoning}`;
          this.isInThinkingBlock = true;
          choices.push({ status: ChoiceStatus.STREAM, index, chunkText, ...usageForIndex });
          continue;
        }

        // Real Bedrock: reasoning inlined as <reasoning> tags, tool calls possibly
        // inside it as native tokens. Filter the reasoning inner text.
        if (content.includes('<reasoning>')) {
          const inner = content.replace(/<\/?reasoning>/g, '');
          const { text: safe, toolCalls: nativeCalls } = this.nativeToolStream.push(inner);
          for (const call of nativeCalls) {
            // Same header + plain-argument-delta contract the structured path uses,
            // so base.ts accumulates the arguments (never TOOL_USE on the arg frame).
            choices.push({
              status: ChoiceStatus.STREAM,
              index: call.index,
              chunkText: '',
              tool: { id: call.id, name: call.name },
            });
            if (call.arguments) {
              choices.push({ status: ChoiceStatus.STREAM, index: call.index, chunkText: call.arguments });
            }
          }
          const think = safe + (choice.finish_reason ? this.nativeToolStream.flush() : '');
          choices.push({
            status: ChoiceStatus.END,
            statusEndReason: endReason,
            index,
            chunkText: think ? `<think>${think}</think>` : '',
            ...usageForIndex,
          });
          continue;
        }

        // Prose, or the close of an open `reasoning_content` block.
        if (this.isInThinkingBlock && content) {
          this.isInThinkingBlock = false;
          choices.push({
            status: ChoiceStatus.END,
            statusEndReason: endReason,
            index,
            chunkText: `</think>${content}`,
            ...usageForIndex,
          });
          continue;
        }
        choices.push({
          status: ChoiceStatus.END,
          statusEndReason: endReason,
          index,
          chunkText: content,
          ...usageForIndex,
        });
        continue;
      }

      // Non-streaming: the whole message is in hand. Extract a native tool section if
      // present; otherwise convert the inline <reasoning> envelope to <think>.
      if (hasNativeToolMarker(content)) {
        const inner = content.replace(/<\/?reasoning>/g, '');
        const begin = inner.indexOf('<|tool_calls_section_begin|>');
        const before = (begin >= 0 ? inner.slice(0, begin) : inner).trim();
        const nativeCalls = parseNativeToolSection(inner);
        const think = [reasoning, before].filter(Boolean).join(' ').trim();
        let usageAttached = false;
        if (think) {
          choices.push({
            status: ChoiceStatus.END,
            statusEndReason: endReason,
            index,
            chunkText: `<think>${think}</think>`,
            ...usageForIndex,
          });
          usageAttached = true;
        }
        for (const call of nativeCalls) {
          choices.push({
            status: ChoiceStatus.END,
            statusEndReason: ChoiceEndReason.TOOL_USE,
            index: call.index,
            chunkText: call.arguments,
            tool: { id: call.id, name: call.name, parameters: call.arguments },
            ...(usageAttached ? {} : usageForIndex),
          });
          usageAttached = true;
        }
        continue;
      }

      const chunkText = (reasoning ? `<think>${reasoning}</think>` : '') + convertTags(content);
      choices.push({ status: ChoiceStatus.END, statusEndReason: endReason, index, chunkText, ...usageForIndex });
    }

    // Reported separately from statusEndReason, which collapses 'stop' and 'length'
    // onto ChoiceEndReason.STOP. Without this a k2-thinking turn that spent its whole
    // output budget on the monologue reached the user as a reasoning trace ending at
    // </think>, with nothing marking it as cut off.
    const stopReason = normalizeOpenAIFinishReason(response.choices?.[0]?.finish_reason);

    return { done: true, chunk: { model, choices, ...(stopReason ? { stopReason } : {}) } };
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
