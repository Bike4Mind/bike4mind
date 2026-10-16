import {
  ChatModels,
  createThinkMarkerEscaper,
  escapeThinkMarkers,
  IMessage,
  ModelBackend,
  type ModelInfo,
} from '@bike4mind/common';
import {
  ConverseCommand,
  type ConverseCommandInput,
  ConverseStreamCommand,
  type ConverseStreamCommandInput,
} from '@aws-sdk/client-bedrock-runtime';
import {
  ChoiceEndReason,
  ChoiceStatus,
  type IChoice,
  type IChoiceEndToolUse,
  type ICompletionOptionTools,
  type ICompletionOptions,
  type ICompletionResponseChunk,
} from '../backend';
import { DispatchModel } from '../dispatchModel';
import { BaseBedrockBackend } from './base';

/**
 * Models served by ConverseBedrockBackend. Adding a Converse-compatible Bedrock model is a
 * `ChatModels` entry plus a record here: routing (getLlmByModel's Bedrock branch), the
 * Bedrock listing (UndifferentiatedBedrockBackend) and request shaping all read this table.
 */
export const CONVERSE_BEDROCK_MODELS: readonly ModelInfo[] = [
  {
    id: ChatModels.NOVA_PRO_BEDROCK,
    type: 'text',
    name: 'Amazon Nova Pro',
    backend: ModelBackend.Bedrock,
    contextWindow: 300_000,
    max_tokens: 10_000,
    can_stream: true,
    pricing: {
      // $0.80 / 1M in, $3.20 / 1M out (US on-demand). @see https://aws.amazon.com/bedrock/pricing/
      300_000: { input: 0.0000008, output: 0.0000032 },
    },
    supportsVision: true,
    supportsTools: true,
    supportsImageVariation: false,
    releaseDate: '2024-12-03',
    rank: 5,
    description:
      "Amazon's Nova Pro via AWS Bedrock - multimodal (text and images), tool use, and a 300K-token context window.",
  },
];

const CONVERSE_MODEL_IDS: ReadonlySet<string> = new Set(CONVERSE_BEDROCK_MODELS.map(m => String(m.id)));

export function isConverseBedrockModel(modelId: string): boolean {
  return CONVERSE_MODEL_IDS.has(modelId);
}

const DEFAULT_MAX_TOKENS = 4096;
const DATA_URL = /^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/s;
const CONVERSE_IMAGE_FORMATS = new Set(['png', 'jpeg', 'gif', 'webp']);

/**
 * The JSON body getPayload hands to base.ts. It is the Converse request with image bytes kept
 * as base64 so it survives JSON (and base.ts's length-based context estimate); invokeModel
 * decodes them back to bytes before sending.
 */
type WireContentBlock =
  | { text: string }
  | { image: { format: string; source: { bytes: string } } }
  | { toolUse: { toolUseId: string; name: string; input: unknown } }
  | { toolResult: { toolUseId: string; content: Array<{ text: string }> } };

interface WireMessage {
  role: 'user' | 'assistant';
  content: WireContentBlock[];
}

interface WireRequest {
  modelId: string;
  messages: WireMessage[];
  system?: Array<{ text: string }>;
  inferenceConfig: { maxTokens: number; temperature?: number; topP?: number; stopSequences?: string[] };
  toolConfig?: {
    tools: Array<{ toolSpec: { name: string; description?: string; inputSchema: { json: unknown } } }>;
    toolChoice?: { auto: object } | { any: object } | { tool: { name: string } };
  };
}

type ConverseUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
};

type ConverseResponseBlock = {
  text?: string;
  reasoningContent?: { reasoningText?: { text?: string } };
  toolUse?: { toolUseId?: string; name?: string; input?: unknown };
};

/** Private wire format between invokeModel and translateChunk - not a real Bedrock response shape. */
interface ConversePseudoChunk {
  content?: ConverseResponseBlock[];
  stopReason?: string;
  usage?: ConverseUsage;
}

type ConverseStreamEvent = {
  messageStart?: unknown;
  contentBlockStart?: { contentBlockIndex?: number; start?: { toolUse?: { toolUseId?: string; name?: string } } };
  contentBlockDelta?: {
    contentBlockIndex?: number;
    delta?: { text?: string; reasoningContent?: { text?: string }; toolUse?: { input?: string } };
  };
  contentBlockStop?: { contentBlockIndex?: number };
  messageStop?: { stopReason?: string };
  metadata?: { usage?: ConverseUsage };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toUsage(usage: ConverseUsage | undefined): NonNullable<IChoice['usage']> {
  return {
    input_tokens: usage?.inputTokens || 0,
    output_tokens: usage?.outputTokens || 0,
    ...(usage?.cacheReadInputTokens ? { cache_read_input_tokens: usage.cacheReadInputTokens } : {}),
    ...(usage?.cacheWriteInputTokens ? { cache_creation_input_tokens: usage.cacheWriteInputTokens } : {}),
  };
}

function endReasonFor(stopReason: string | undefined): ChoiceEndReason.COMPLETE | ChoiceEndReason.STOP {
  return stopReason === 'end_turn' ? ChoiceEndReason.COMPLETE : ChoiceEndReason.STOP;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(block => (isRecord(block) && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return content === null || content === undefined ? '' : JSON.stringify(content);
}

function imageBlock(mediaType: string, data: string): WireContentBlock | null {
  const format = mediaType.replace(/^image\//, '').replace('jpg', 'jpeg');
  return CONVERSE_IMAGE_FORMATS.has(format) ? { image: { format, source: { bytes: data } } } : null;
}

/**
 * Generic backend for Bedrock models served through the Converse API, which gives every
 * Converse-compatible model one request/response shape (and, unlike raw Invoke for several
 * vendors, reports token usage). The tool loop, context pruning, token accumulation, region,
 * timeout and credentials all come from BaseBedrockBackend; this class only swaps the
 * transport. Tool history is kept in the canonical tool_use/tool_result block shape base.ts
 * inspects, and translated to Converse toolUse/toolResult blocks per request.
 */
export class ConverseBedrockBackend extends BaseBedrockBackend {
  /** Reports done only on messageStop, so a missing terminal event means a truncated stream. */
  protected override get signalsStreamTermination(): boolean {
    return true;
  }

  private readonly _dispatch = new DispatchModel();
  /** Suppresses reasoning output for title and summary generation calls. */
  private isSpecialTask = false;
  /** Whether the stream is inside a reasoning span, so each span gets one <think>/</think> pair. */
  private isInReasoningBlock = false;
  private reasoningEscaper = createThinkMarkerEscaper();

  /** The static table this backend serves; subclasses for a single vendor narrow it. */
  protected modelTable(): readonly ModelInfo[] {
    return CONVERSE_BEDROCK_MODELS;
  }

  async getModelInfo(): Promise<ModelInfo[]> {
    return [...this.modelTable()];
  }

  setDispatchModel(info: ModelInfo): void {
    this._dispatch.set(info);
  }

  /** A catalog-resolved record wins, so a catalog-only Converse model needs no table entry. */
  protected modelRecordFor(model: string): ModelInfo | undefined {
    return this._dispatch.for(model) ?? this.modelTable().find(m => String(m.id) === model);
  }

  protected override getModelContextWindow(model: string): number {
    return this.modelRecordFor(model)?.contextWindow ?? 0;
  }

  formatMessages(messages: IMessage[]): IMessage[] {
    return messages;
  }

  getPayload(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>
  ): { modelId: string; contentType: string; accept: string; body: string } {
    const record = this.modelRecordFor(model);
    this.isSpecialTask = messages.some(
      m =>
        m.role === 'system' &&
        typeof m.content === 'string' &&
        (m.content.toLowerCase().includes('generate an abstract summary of this session') ||
          m.content.toLowerCase().includes('give a title to this session'))
    );

    // toolConfig only for a model whose record declares tool support: Converse rejects
    // toolConfig (and any toolUse/toolResult block without it) on models that lack it.
    const sendTools = Boolean(options.tools?.length) && record?.supportsTools === true;

    const systemText = messages
      .filter(m => m.role === 'system' && m.content)
      .map(m => textOf(m.content))
      .filter(text => text.trim() !== '')
      .join('\n');

    const converseMessages = this.toConverseMessages(messages, {
      includeTools: sendTools,
      includeImages: record?.supportsVision === true,
    });

    // Converse requires at least one message, so a system-only payload (some title/summary
    // tasks) becomes the sole user turn.
    let systemDemotedToUser = false;
    if (converseMessages.length === 0 && systemText) {
      converseMessages.push({ role: 'user', content: [{ text: systemText }] });
      systemDemotedToUser = true;
    }
    if (converseMessages.length === 0) {
      throw new Error(`Converse request for ${model} has no sendable messages after filtering`);
    }

    const ceiling = record?.max_tokens;
    const requested = typeof options.maxTokens === 'number' ? options.maxTokens : DEFAULT_MAX_TOKENS;
    const inferenceConfig: WireRequest['inferenceConfig'] = {
      maxTokens: ceiling ? Math.min(requested, ceiling) : requested,
    };
    if (typeof options.temperature === 'number') inferenceConfig.temperature = options.temperature;
    if (typeof options.topP === 'number') inferenceConfig.topP = options.topP;
    if (Array.isArray(options.stop) && options.stop.length > 0) inferenceConfig.stopSequences = options.stop;

    const request: WireRequest = {
      modelId: model,
      messages: converseMessages,
      inferenceConfig,
      ...(systemText && !systemDemotedToUser ? { system: [{ text: systemText }] } : {}),
      ...(sendTools ? { toolConfig: this.formatToolConfig(options.tools ?? [], options.tool_choice) } : {}),
    };

    this.isInReasoningBlock = false;
    this.reasoningEscaper = createThinkMarkerEscaper();

    return {
      modelId: model,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(request),
    };
  }

  formatToolConfig(
    tools: ICompletionOptionTools[],
    toolChoice: ICompletionOptions['tool_choice']
  ): NonNullable<WireRequest['toolConfig']> {
    const config: NonNullable<WireRequest['toolConfig']> = {
      tools: tools.map(({ toolSchema }) => ({
        toolSpec: {
          name: toolSchema.name,
          ...(toolSchema.description ? { description: toolSchema.description } : {}),
          inputSchema: { json: toolSchema.parameters },
        },
      })),
    };
    if (toolChoice === 'required') config.toolChoice = { any: {} };
    else if (typeof toolChoice === 'object' && toolChoice.function?.name) {
      config.toolChoice = { tool: { name: toolChoice.function.name } };
    }
    return config;
  }

  /**
   * Converse rejects empty text blocks and a role sequence that does not strictly alternate, so
   * empties are dropped first and same-role runs merged last (dropping can expose a new run).
   * Adjacent text across a merge is joined with a blank line rather than kept as two blocks.
   */
  private toConverseMessages(
    messages: IMessage[],
    opts: { includeTools: boolean; includeImages: boolean }
  ): WireMessage[] {
    const merged: WireMessage[] = [];
    for (const m of messages) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const content = this.toConverseContent(m.content, opts);
      if (content.length === 0) continue;

      const prev = merged[merged.length - 1];
      if (!prev || prev.role !== m.role) {
        merged.push({ role: m.role, content });
        continue;
      }
      const last = prev.content[prev.content.length - 1];
      const [first, ...rest] = content;
      if ('text' in last && 'text' in first) {
        last.text += `\n\n${first.text}`;
        prev.content.push(...rest);
      } else {
        prev.content.push(...content);
      }
    }
    return merged;
  }

  private toConverseContent(
    content: IMessage['content'],
    opts: { includeTools: boolean; includeImages: boolean }
  ): WireContentBlock[] {
    if (!Array.isArray(content)) {
      const text = textOf(content);
      return text.trim() ? [{ text }] : [];
    }

    const blocks: WireContentBlock[] = [];
    for (const block of content as unknown[]) {
      if (!isRecord(block)) continue;
      switch (block.type) {
        case 'text':
          if (typeof block.text === 'string' && block.text.trim()) blocks.push({ text: block.text });
          break;
        case 'image_url':
        case 'image': {
          const image = opts.includeImages ? this.toImageBlock(block) : null;
          blocks.push(image ?? { text: '[image omitted: unsupported image format]' });
          break;
        }
        case 'tool_use':
          if (opts.includeTools && typeof block.id === 'string' && typeof block.name === 'string') {
            blocks.push({ toolUse: { toolUseId: block.id, name: block.name, input: block.input ?? {} } });
          }
          break;
        case 'tool_result':
          if (opts.includeTools && typeof block.tool_use_id === 'string') {
            const text = textOf(block.content);
            blocks.push({
              toolResult: {
                toolUseId: block.tool_use_id,
                content: [{ text: text.trim() ? text : '(empty result)' }],
              },
            });
          }
          break;
        default:
          // thinking/redacted_thinking and unknown blocks: Converse cannot replay another
          // provider's signed reasoning, and an unknown block would 400 the whole request.
          break;
      }
    }
    return blocks;
  }

  /** Converse takes inline bytes or S3 only, so an http(s) image URL cannot be forwarded. */
  private toImageBlock(block: Record<string, unknown>): WireContentBlock | null {
    if (block.type === 'image_url') {
      const url = isRecord(block.image_url) ? block.image_url.url : undefined;
      const match = typeof url === 'string' ? DATA_URL.exec(url) : null;
      return match ? imageBlock(match[1], match[2]) : null;
    }
    const source = isRecord(block.source) ? block.source : undefined;
    if (source?.type === 'base64' && typeof source.media_type === 'string' && typeof source.data === 'string') {
      return imageBlock(source.media_type, source.data);
    }
    return null;
  }

  /** Decode the wire body's base64 image payloads into the bytes the SDK expects. */
  private toCommandInput(body: string): ConverseCommandInput & ConverseStreamCommandInput {
    const request = JSON.parse(body) as WireRequest;
    const messages = request.messages.map(message => ({
      ...message,
      content: message.content.map(block =>
        'image' in block
          ? { image: { ...block.image, source: { bytes: Buffer.from(block.image.source.bytes, 'base64') } } }
          : block
      ),
    }));
    return { ...request, messages } as ConverseCommandInput & ConverseStreamCommandInput;
  }

  protected override async invokeModel(
    input: { modelId: string; contentType: string; accept: string; body: string },
    abortSignal?: AbortSignal
  ): Promise<{ body?: Uint8Array }> {
    const response = await this._bedrockRuntime.send(new ConverseCommand(this.toCommandInput(input.body)), {
      abortSignal,
    });
    const pseudoChunk: ConversePseudoChunk = {
      content: response.output?.message?.content as ConverseResponseBlock[] | undefined,
      stopReason: response.stopReason,
      usage: response.usage,
    };
    return { body: new TextEncoder().encode(JSON.stringify(pseudoChunk)) };
  }

  protected override async invokeModelStream(
    input: { modelId: string; contentType: string; accept: string; body: string },
    abortSignal?: AbortSignal
  ): Promise<{ body?: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }> }> {
    const response = await this._bedrockRuntime.send(new ConverseStreamCommand(this.toCommandInput(input.body)), {
      abortSignal,
    });
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

  translateChunk(model: string, chunk: unknown): { done: boolean; chunk: ICompletionResponseChunk } {
    const response = chunk as ConversePseudoChunk;
    const endReason = endReasonFor(response.stopReason);
    const choices: IChoice[] = [];
    let text = '';

    (response.content ?? []).forEach((block, index) => {
      if (block.toolUse?.name) {
        // chunkText stays empty: base.ts sends every choice's chunkText to the client as prose.
        choices.push({
          status: ChoiceStatus.END,
          statusEndReason: ChoiceEndReason.TOOL_USE,
          index: index + 1,
          chunkText: '',
          tool: {
            id: block.toolUse.toolUseId ?? '',
            name: block.toolUse.name,
            parameters: JSON.stringify(block.toolUse.input ?? {}),
          },
        });
      } else if (block.reasoningContent) {
        const reasoning = block.reasoningContent.reasoningText?.text;
        if (reasoning && !this.isSpecialTask) text += `<think>${escapeThinkMarkers(reasoning)}</think>`;
      } else if (typeof block.text === 'string') {
        text += block.text;
      }
    });

    // Text first at index 0: base.ts reads usage off choices[0].
    choices.unshift({
      status: ChoiceStatus.END,
      statusEndReason: endReason,
      index: 0,
      chunkText: text,
      usage: toUsage(response.usage),
    });

    return {
      done: true,
      chunk: { model, choices, ...(response.stopReason ? { stopReason: response.stopReason } : {}) },
    };
  }

  /**
   * Choice index is the Converse contentBlockIndex, so prose and each tool call keep separate
   * slots in base.ts's per-index tool accumulator.
   */
  translateStreamChunk(model: string, chunk: unknown): { done: boolean; chunk: ICompletionResponseChunk } {
    const event = chunk as ConverseStreamEvent;
    const plain = (index: number, chunkText: string, extra: Partial<IChoice> = {}) => ({
      done: false,
      chunk: { model, choices: [{ index, status: ChoiceStatus.STREAM, chunkText, ...extra } as IChoice] },
    });

    if (event.messageStart) {
      this.isInReasoningBlock = false;
      this.reasoningEscaper = createThinkMarkerEscaper();
      return plain(0, '');
    }

    if (event.contentBlockStart) {
      const index = event.contentBlockStart.contentBlockIndex ?? 0;
      const toolUse = event.contentBlockStart.start?.toolUse;
      // The header must carry chunkText '' and no toolArguments flag: base.ts initializes the
      // argument buffer from it before the input deltas arrive.
      if (toolUse?.name) return plain(index, '', { tool: { id: toolUse.toolUseId ?? '', name: toolUse.name } });
      return plain(index, '', { toolArguments: false });
    }

    if (event.contentBlockDelta) {
      const index = event.contentBlockDelta.contentBlockIndex ?? 0;
      const delta = event.contentBlockDelta.delta;
      if (delta?.toolUse) return plain(index, delta.toolUse.input ?? '', { toolArguments: true });
      return plain(index, this.deltaText(delta), { toolArguments: false });
    }

    if (event.contentBlockStop) {
      const index = event.contentBlockStop.contentBlockIndex ?? 0;
      const chunkText =
        this.isInReasoningBlock && !this.isSpecialTask ? this.reasoningEscaper.flush() + '</think>' : '';
      this.isInReasoningBlock = false;
      return plain(index, chunkText, { toolArguments: false });
    }

    if (event.metadata?.usage) {
      return plain(0, '', { toolArguments: false, usage: toUsage(event.metadata.usage) });
    }

    if (event.messageStop) {
      const stopReason = event.messageStop.stopReason;
      return {
        done: true,
        chunk: {
          model,
          choices: [{ index: 0, status: ChoiceStatus.END, statusEndReason: endReasonFor(stopReason), chunkText: '' }],
          ...(stopReason ? { stopReason } : {}),
        },
      };
    }

    return plain(0, '');
  }

  private deltaText(delta?: { text?: string; reasoningContent?: { text?: string } }): string {
    if (delta?.reasoningContent?.text !== undefined) {
      if (this.isSpecialTask) return '';
      const opening = this.isInReasoningBlock ? '' : '<think>';
      this.isInReasoningBlock = true;
      return opening + this.reasoningEscaper.push(delta.reasoningContent.text);
    }
    if (delta?.text !== undefined) {
      const closing = this.isInReasoningBlock ? this.reasoningEscaper.flush() + '</think>' : '';
      this.isInReasoningBlock = false;
      return closing + delta.text;
    }
    return '';
  }

  /** Canonical tool_use/tool_result pair; toConverseContent translates it on the next request. */
  pushToolMessages(messages: IMessage[], tool: IChoiceEndToolUse['tool'], result: string): unknown {
    let input: unknown = {};
    try {
      input = JSON.parse(tool.parameters || '{}');
    } catch {
      input = {};
    }
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: tool.id, name: tool.name, input }],
    } as IMessage);
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: tool.id, content: result }],
    } as IMessage);
    return messages;
  }
}

export default ConverseBedrockBackend;
