import { ChatModels, IMessage, type ModelInfo, ModelBackend } from '@bike4mind/common';
import { ChoiceEndReason, ChoiceStatus, ICompletionOptions, ICompletionResponseChunk } from '../backend';
import { BaseBedrockBackend } from './base';
import { ConverseCommand, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';

type ConverseContentBlock = { text: string } | { reasoningContent: { reasoningText?: { text?: string } } };

interface ConversePayload {
  modelId: string;
  messages: Array<{ role: 'user' | 'assistant'; content: [{ text: string }] }>;
  system?: Array<{ text: string }>;
  inferenceConfig: { maxTokens: number; temperature?: number; topP?: number; stopSequences?: string[] };
}

/**
 * Non-streaming result repackaged by invokeModel() into the bytes complete() decodes.
 * This is a private wire format between invokeModel/invokeModelStream and translateChunk/
 * translateStreamChunk below - not a real Bedrock response shape.
 */
interface ConversePseudoChunk {
  content?: ConverseContentBlock[];
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

function isReasoningBlock(
  block: ConverseContentBlock
): block is { reasoningContent: { reasoningText?: { text?: string } } } {
  return 'reasoningContent' in block;
}

export default class DeepSeekBedrockBackend extends BaseBedrockBackend {
  /** Suppresses reasoning/thinking output for summary and title generation calls. */
  private isSpecialTask = false;
  /** Tracks whether the stream is currently inside a reasoning span, to emit one <think>/</think> pair per span. */
  private isInReasoningBlock = false;

  async getModelInfo(): Promise<ModelInfo[]> {
    return [
      {
        id: ChatModels.DEEPSEEK_R1_BEDROCK,
        type: 'text',
        name: 'DeepSeek R1',
        backend: ModelBackend.Bedrock,
        contextWindow: 128_000,
        supportsImageVariation: false,
        max_tokens: 32_768,
        can_stream: true,
        pricing: {
          // $0.00135 / 1,000 Input tokens, $0.0054 / 1,000 Output tokens. @see https://aws.amazon.com/bedrock/pricing/
          32_768: { input: 0.00135 / 1000, output: 0.0054 / 1000 },
        },
        supportsVision: false,
        logoFile: 'deepseek-logo.png',
        rank: 10,
        description:
          "DeepSeek's R1 model via AWS Bedrock. Large context window, strong reasoning, and high throughput.",
      },
      {
        id: ChatModels.DEEPSEEK_V3_1,
        type: 'text',
        name: 'DeepSeek v3.1',
        backend: ModelBackend.Bedrock,
        contextWindow: 128_000,
        supportsImageVariation: false,
        max_tokens: 32_768,
        can_stream: true,
        pricing: {
          // $0.00135 / 1,000 Input tokens, $0.0054 / 1,000 Output tokens. @see https://aws.amazon.com/bedrock/pricing/
          32_768: { input: 0.00135 / 1000, output: 0.0054 / 1000 },
        },
        supportsVision: false,
        logoFile: 'deepseek-logo.png',
        rank: 10,
        description:
          "DeepSeek's latest model via AWS Bedrock. Large context window, strong reasoning, and high throughput.",
      },
    ];
  }

  getPayload(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>
  ): { modelId: string; contentType: string; accept: string; body: string } {
    // Both DeepSeek-R1 and V3.1 support the Converse API (unlike the raw Invoke API used
    // previously, which never reports token usage - see the class-level comment on
    // invokeModel below), so both models share this single Converse-shaped payload.
    this.isSpecialTask = messages.some(
      m =>
        typeof m.content === 'string' &&
        (m.content.toLowerCase().includes('generate an abstract summary of this session') ||
          m.content.toLowerCase().includes('give a title to this session'))
    );

    const systemText = messages
      .filter(m => m.role === 'system' && m.content)
      .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');

    const converseMessages = this.toConverseMessages(messages);

    // Converse requires at least one message. A payload of only system messages
    // (e.g. some title/summary tasks) would 400, so demote the system text to the
    // sole user turn and drop the now-redundant system field.
    let systemDemotedToUser = false;
    if (converseMessages.length === 0 && systemText) {
      converseMessages.push({ role: 'user', content: [{ text: systemText }] });
      systemDemotedToUser = true;
    }

    const inferenceConfig: ConversePayload['inferenceConfig'] = {
      maxTokens: typeof options.maxTokens === 'number' ? options.maxTokens : 512,
    };
    if (typeof options.temperature === 'number') inferenceConfig.temperature = options.temperature;
    if (typeof options.topP === 'number') inferenceConfig.topP = options.topP;
    if (options.stop && Array.isArray(options.stop) && options.stop.length > 0) {
      inferenceConfig.stopSequences = options.stop;
    }

    const payload: ConversePayload = {
      modelId: model,
      messages: converseMessages,
      inferenceConfig,
      ...(systemText && !systemDemotedToUser ? { system: [{ text: systemText }] } : {}),
    };

    return {
      modelId: model,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(payload),
    };
  }

  formatMessages(messages: IMessage[]): IMessage[] {
    return messages;
  }

  /**
   * Map user/assistant messages to Converse text blocks, dropping empties and merging
   * consecutive same-role turns. Bedrock Converse rejects a message list whose roles don't
   * strictly alternate - the b4m pipeline can emit same-role runs (the AnthropicBedrockBackend
   * merges them for the same reason), and dropping empty turns can itself expose a same-role
   * pair, so the merge runs last. DeepSeek is text-only, so joining with blank lines is lossless.
   */
  private toConverseMessages(messages: IMessage[]): Array<{ role: 'user' | 'assistant'; content: [{ text: string }] }> {
    return messages
      .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content !== null && m.content !== undefined)
      .map(m => ({
        role: m.role as 'user' | 'assistant',
        text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      }))
      .filter(m => m.text.trim() !== '')
      .reduce<Array<{ role: 'user' | 'assistant'; content: [{ text: string }] }>>((acc, m) => {
        const prev = acc[acc.length - 1];
        if (prev && prev.role === m.role) {
          prev.content[0].text += `\n\n${m.text}`;
        } else {
          acc.push({ role: m.role, content: [{ text: m.text }] });
        }
        return acc;
      }, []);
  }

  // --- Converse transport ---
  // DeepSeek's raw Invoke API response is documented as just `{ choices: [{ text, stop_reason }] }`
  // with no usage field at all (confirmed against AWS's published response schema) - there is no
  // wire-level fix that makes it report tokens. Converse is the only Bedrock API that returns usage
  // for this model, so these two overrides swap the transport while BaseBedrockBackend's tool loop,
  // context pruning, and multi-turn token accumulation stay shared.

  protected override async invokeModel(
    input: { modelId: string; contentType: string; accept: string; body: string },
    abortSignal?: AbortSignal
  ): Promise<{ body?: Uint8Array }> {
    const payload = JSON.parse(input.body) as ConversePayload;
    const response = await this._bedrockRuntime.send(new ConverseCommand(payload), { abortSignal });
    const message = (response.output as { message?: { content?: ConverseContentBlock[] } } | undefined)?.message;
    const pseudoChunk: ConversePseudoChunk = {
      content: message?.content,
      stopReason: response.stopReason,
      usage: { inputTokens: response.usage?.inputTokens, outputTokens: response.usage?.outputTokens },
    };
    return { body: new TextEncoder().encode(JSON.stringify(pseudoChunk)) };
  }

  protected override async invokeModelStream(
    input: { modelId: string; contentType: string; accept: string; body: string },
    abortSignal?: AbortSignal
  ): Promise<{ body?: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }> }> {
    const payload = JSON.parse(input.body) as ConversePayload;
    const response = await this._bedrockRuntime.send(new ConverseStreamCommand(payload), { abortSignal });
    const stream = response.stream;
    if (!stream) return { body: undefined };

    const encoder = new TextEncoder();
    async function* toChunkEvents(source: NonNullable<typeof stream>) {
      for await (const event of source) {
        yield { chunk: { bytes: encoder.encode(JSON.stringify(event)) } };
      }
    }
    return { body: toChunkEvents(stream) };
  }

  translateChunk(model: string, chunk: Record<string, unknown>): { done: boolean; chunk: ICompletionResponseChunk } {
    const response = chunk as ConversePseudoChunk;

    return {
      done: true,
      chunk: {
        model,
        choices: [
          {
            status: ChoiceStatus.END,
            statusEndReason: response.stopReason === 'end_turn' ? ChoiceEndReason.COMPLETE : ChoiceEndReason.STOP,
            index: 0,
            chunkText: this.extractText(response.content ?? []),
            usage: {
              input_tokens: response.usage?.inputTokens || 0,
              output_tokens: response.usage?.outputTokens || 0,
            },
          },
        ],
      },
    };
  }

  translateStreamChunk(
    model: string,
    chunk: Record<string, unknown>
  ): { done: boolean; chunk: ICompletionResponseChunk } {
    const event = chunk as {
      messageStart?: unknown;
      contentBlockDelta?: { delta?: { text?: string; reasoningContent?: { text?: string } } };
      contentBlockStop?: unknown;
      messageStop?: { stopReason?: string };
      metadata?: { usage?: { inputTokens?: number; outputTokens?: number } };
    };

    if (event.messageStart) {
      this.isInReasoningBlock = false;
      return { done: false, chunk: { model, choices: [{ index: 0, status: ChoiceStatus.STREAM, chunkText: '' }] } };
    }

    if (event.contentBlockDelta) {
      const delta = event.contentBlockDelta.delta;
      const chunkText = this.deltaText(delta);
      return { done: false, chunk: { model, choices: [{ index: 0, status: ChoiceStatus.STREAM, chunkText }] } };
    }

    if (event.contentBlockStop) {
      // Close a reasoning span that ends without a following text delta.
      const chunkText = this.isInReasoningBlock && !this.isSpecialTask ? '</think>' : '';
      this.isInReasoningBlock = false;
      return { done: false, chunk: { model, choices: [{ index: 0, status: ChoiceStatus.STREAM, chunkText }] } };
    }

    if (event.metadata?.usage) {
      return {
        done: false,
        chunk: {
          model,
          choices: [
            {
              index: 0,
              status: ChoiceStatus.STREAM,
              chunkText: '',
              usage: {
                input_tokens: event.metadata.usage.inputTokens || 0,
                output_tokens: event.metadata.usage.outputTokens || 0,
              },
            },
          ],
        },
      };
    }

    if (event.messageStop) {
      return {
        done: true,
        chunk: {
          model,
          choices: [
            {
              index: 0,
              status: ChoiceStatus.END,
              statusEndReason:
                event.messageStop.stopReason === 'end_turn' ? ChoiceEndReason.COMPLETE : ChoiceEndReason.STOP,
              chunkText: '',
            },
          ],
        },
      };
    }

    // contentBlockStart carries no text or usage for text/reasoning blocks - no-op passthrough.
    return { done: false, chunk: { model, choices: [{ index: 0, status: ChoiceStatus.STREAM, chunkText: '' }] } };
  }

  private deltaText(delta?: { text?: string; reasoningContent?: { text?: string } }): string {
    if (delta?.reasoningContent?.text !== undefined) {
      if (this.isSpecialTask) return ''; // Never leak chain-of-thought into a title/summary field.
      const opening = this.isInReasoningBlock ? '' : '<think>';
      this.isInReasoningBlock = true;
      return opening + delta.reasoningContent.text;
    }
    if (delta?.text !== undefined) {
      const closing = this.isInReasoningBlock ? '</think>' : '';
      this.isInReasoningBlock = false;
      return closing + delta.text;
    }
    return '';
  }

  private extractText(blocks: ConverseContentBlock[]): string {
    return blocks
      .map(block => {
        if (isReasoningBlock(block)) {
          if (this.isSpecialTask) return '';
          const text = block.reasoningContent.reasoningText?.text;
          return text ? `<think>${text}</think>` : '';
        }
        return block.text;
      })
      .join('');
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
