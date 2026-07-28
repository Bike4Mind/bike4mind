import { ChatModels, IMessage, ModelBackend, type ModelInfo } from '@bike4mind/common';
import { ChoiceEndReason, ChoiceStatus, ICompletionOptions, ICompletionResponseChunk } from '../backend';
import { BaseBedrockBackend } from './base';

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
 * @see https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-5.html
 * @see https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-thinking.html
 */
export default class MoonshotBedrockBackend extends BaseBedrockBackend {
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
          // $0.60 / 1M in, $3.00 / 1M out in us-east-1, us-east-2 and us-west-2.
          // Other regions are quoted higher (ap-south-1 and friends bill $0.72 /
          // $3.60); the catalog holds one rate, so this is the US-region rate and
          // a deployment in a pricier region will under-report until an operator
          // row corrects it. @see https://aws.amazon.com/bedrock/pricing/
          262_144: { input: 0.6 / 1_000_000, output: 3 / 1_000_000 },
        },
        can_think: true,
        supportsVision: true,
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
    const formattedMessages = messages
      .filter(m => m.content !== null && m.content !== undefined)
      .map(m => ({
        role: m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'system',
        content: typeof m.content === 'string' || Array.isArray(m.content) ? m.content : JSON.stringify(m.content),
      }))
      .filter(m => (typeof m.content === 'string' ? m.content !== '' : true));

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

    return {
      modelId: model,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    };
  }

  translateChunk(model: string, chunk: Record<string, unknown>): { done: boolean; chunk: ICompletionResponseChunk } {
    const response = chunk as {
      choices?: Array<{
        message?: { content?: string; reasoning_content?: string };
        delta?: { content?: string; reasoning_content?: string };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    // Kimi quotes OpenAI's usage names; the normalized chunk wants Anthropic's,
    // and the base class reads them off choices[0]. Mapping them here is what
    // makes a Bedrock Kimi turn actually settle against its price row.
    const usage = {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0,
    };

    return {
      done: true,
      chunk: {
        model,
        choices: (response.choices || []).map((choice, index) => {
          const reasoning = choice.message?.reasoning_content ?? choice.delta?.reasoning_content;
          const content = choice.message?.content ?? choice.delta?.content ?? '';
          return {
            status: ChoiceStatus.END,
            statusEndReason:
              choice.finish_reason === 'stop' || choice.finish_reason === 'length'
                ? ChoiceEndReason.STOP
                : ChoiceEndReason.COMPLETE,
            index,
            // Thinking arrives on its own field, so it is wrapped rather than
            // stripped - the same <think> envelope the direct Kimi and xAI
            // backends emit, which is what the client already renders.
            chunkText: reasoning ? `<think>${reasoning}</think>${content}` : content,
            // Only the first choice carries usage, matching how the base reads it.
            ...(index === 0 ? { usage } : {}),
          };
        }),
      },
    };
  }

  translateStreamChunk(
    model: string,
    chunk: Record<string, unknown>
  ): { done: boolean; chunk: ICompletionResponseChunk } {
    return this.translateChunk(model, chunk);
  }

  pushToolMessages(
    messages: IMessage[],
    _tool: { name: string; id: string; parameters: string },
    _result: string,
    _thinkingBlocks?: unknown[]
  ): unknown {
    return messages;
  }
}
