import { Content, GenerationConfig, GoogleGenAI, Part, Tool } from '@google/genai';
import { DEFAULT_MAX_TOOL_CALLS, ICompletionBackend, type CompletionInfo, type ICompletionOptions } from './backend';
import { executeToolsBatch } from './executeToolsBatch';
import { Logger } from '@bike4mind/observability';
import {
  ChatModels,
  ImageModels,
  MessageContentImageUrl,
  MessageContentInlineImage,
  ModelBackend,
  PermissionDeniedError,
  type CacheUsageStats,
  type IMessage,
  type MessageContentText,
  type MessageContentToolResult,
  type MessageContentToolUse,
  type ModelInfo,
} from '@bike4mind/common';
import pick from 'lodash/pick.js';
import { v4 as uuidv4 } from 'uuid';
import { handleToolResultStreaming } from './toolStreamingHelper';
import { getCachingAdapter, logCacheStats } from './caching/adapters';
import { injectJsonSchemaInstruction, isBestEffortJsonSchema } from './responseFormatHelpers';
import { withAbortListener } from './withAbortListener';

type ToolCall = {
  id: string;
  name: string;
  parameters: Record<string, unknown>;
  thought_signature?: string; // Required by Gemini for function calling
};

type GeminiPart = {
  text?: string;
  functionCall?: {
    name?: string;
    args?: Record<string, unknown>;
  };
  function_call?: {
    name?: string;
    args?: Record<string, unknown>;
  };
  name?: string;
  args?: Record<string, unknown>;
  thoughtSignature?: string;
  thought_signature?: string; // Also support snake_case variant
};

type GeminiCandidate = {
  content?: {
    parts?: GeminiPart[];
  };
  finishReason?: string;
  finishMessage?: string;
};

export class GeminiBackend implements ICompletionBackend {
  private _api: GoogleGenAI;
  private logger: Logger;
  public currentModel: string = '';

  constructor(apiKey: string, logger?: Logger) {
    this._api = new GoogleGenAI({ apiKey });
    this.logger = logger ?? new Logger();
  }

  /**
   * Helper function to register a tool call and avoid code duplication
   */
  private registerToolCall(
    toolCall: { name?: string; args?: Record<string, unknown> },
    part: GeminiPart,
    toolCalls: ToolCall[],
    toolsUsed: Array<{ name: string; arguments?: string; id?: string }>,
    checkDuplicates: boolean = false
  ): void {
    const toolName = toolCall.name ?? 'unknown_tool';
    const toolArgs = toolCall.args as Record<string, unknown>;

    // Enhanced duplicate detection that includes parameters
    if (checkDuplicates) {
      const alreadyAdded = toolCalls.some(
        tc => tc.name === toolName && JSON.stringify(tc.parameters) === JSON.stringify(toolArgs)
      );
      if (alreadyAdded) {
        return;
      }
    }

    // Capture thought_signature in both camelCase and snake_case formats
    const thoughtSignature = part.thoughtSignature || part.thought_signature;

    if (thoughtSignature) {
      this.logger.debug('[Gemini] Captured thought_signature for tool call:', { toolName, hasSignature: true });
    } else {
      this.logger.warn('[Gemini] Missing thought_signature for tool call:', { toolName });
    }

    const toolId = uuidv4();
    toolCalls.push({
      id: toolId,
      name: toolName,
      parameters: toolArgs,
      thought_signature: thoughtSignature,
    });

    toolsUsed.push({
      name: toolName,
      arguments: JSON.stringify(toolArgs),
      id: toolId,
    });
  }

  async getModelInfo(): Promise<ModelInfo[]> {
    return [
      {
        id: ImageModels.GEMINI_2_5_FLASH_IMAGE,
        type: 'image',
        name: 'Gemini 2.5 Flash Image',
        backend: ModelBackend.Gemini,
        contextWindow: 1048576, // 1M context window (same as Gemini 2.5 Flash for text input)
        supportsImageVariation: true,
        // max_tokens = input-prompt truncation threshold (see ImageGeneration/ImageEdit),
        // not per-image output tokens. Per-image output cost (~1290 tok) lives in
        // GeminiImageCostCalculator, not here.
        max_tokens: 32_768,
        can_stream: false,
        pricing: {
          1048576: { input: 0.3 / 1000000, output: 30.0 / 1000000 }, // Input: $0.30/1M tokens (text), Output: $30/1M tokens (1290 tokens per image = $0.039)
        },
        supportsSafetyTolerance: true,
        logoFile: 'Google_logo.png',
        rank: 15,
        releaseDate: '2025-08-26',
        trainingCutoff: '2025-05-01',
        description:
          "Google's Gemini 2.5 Flash image generation and editing model (Nano Banana). Supports text-to-image, image editing with natural language, multi-image composition, and character consistency.",
      },
      // Gemini 3.5
      {
        id: ChatModels.GEMINI_3_5_FLASH,
        type: 'text',
        name: 'Gemini 3.5 Flash',
        backend: ModelBackend.Gemini,
        contextWindow: 1048576, // 1M context window
        supportsImageVariation: false,
        max_tokens: 65536, // Max output tokens
        can_stream: true,
        can_think: true,
        pricing: {
          1048576: { input: 1.5 / 1000000, output: 9.0 / 1000000 }, // $1.50/1M input, $9.00/1M output
        },
        supportsVision: true,
        supportsTools: true,
        logoFile: 'Google_logo.png',
        rank: 4,
        trainingCutoff: '2025-01-31',
        releaseDate: '2026-05-19',
        description:
          "Google's most intelligent Flash model, delivering sustained frontier performance on agentic and coding tasks, built on state-of-the-art reasoning.",
      },
      // Gemini 3.1
      {
        id: ChatModels.GEMINI_3_1_PRO_PREVIEW,
        type: 'text',
        name: 'Gemini 3.1 Pro Preview',
        backend: ModelBackend.Gemini,
        contextWindow: 1048576, // 1M context window
        supportsImageVariation: false,
        max_tokens: 65536, // Max output tokens
        can_stream: true,
        can_think: true,
        pricing: {
          2097152: { input: 2 / 1000000, output: 18.0 / 1000000 }, // $1.25/1M input, $10/1M output
        },
        supportsVision: true,
        supportsTools: true,
        logoFile: 'Google_logo.png',
        rank: 5,
        trainingCutoff: '2025-01-31',
        releaseDate: '2026-02-19',
        description:
          "Google's Gemini 3.1 Pro preview for multimodal understanding, delivering richer visuals and deeper interactivity, built on a foundation of state-of-the-art reasoning.",
      },
      {
        id: ChatModels.GEMINI_3_1_FLASH_LITE,
        type: 'text',
        name: 'Gemini 3.1 Flash Lite',
        backend: ModelBackend.Gemini,
        contextWindow: 1048576, // 1M context window
        supportsImageVariation: false,
        max_tokens: 65536, // Max output tokens
        can_stream: true,
        can_think: true, // Supports minimal/low/medium/high thinking levels
        pricing: {
          1048576: { input: 0.25 / 1000000, output: 1.5 / 1000000 }, // $0.25/1M input, $1.50/1M output
        },
        supportsVision: true,
        supportsTools: true,
        logoFile: 'Google_logo.png',
        rank: 7,
        trainingCutoff: '2025-01-31',
        releaseDate: '2026-05-08',
        description:
          "Google's most cost-efficient Gemini model, optimized for low-latency, high-volume tasks while matching Gemini 2.5 Flash quality across key capabilities.",
      },
      // Gemini 3 pro preview (deprecated: migrate to Gemini 3.1 Pro Preview)
      {
        id: ChatModels.GEMINI_3_PRO_PREVIEW,
        type: 'text',
        name: 'Gemini 3 Pro Preview',
        backend: ModelBackend.Gemini,
        contextWindow: 1048576, // 1M context window
        supportsImageVariation: false,
        max_tokens: 65536, // Max output tokens
        can_stream: true,
        can_think: true,
        pricing: {
          2097152: { input: 2 / 1000000, output: 18.0 / 1000000 }, // $2.00/1M input, $8.00/1M output
        },
        supportsVision: true,
        supportsTools: true,
        logoFile: 'Google_logo.png',
        rank: 5,
        trainingCutoff: '2025-01-31',
        releaseDate: '2025-11-30',
        deprecationDate: '2026-03-09',
        description:
          "Google's Gemini 3 Pro preview for multimodal understanding, delivering richer visuals and deeper interactivity, built on a foundation of state-of-the-art reasoning. Superseded by Gemini 3.1 Pro Preview.",
      },
      // Gemini 3 Flash Preview
      {
        id: ChatModels.GEMINI_3_FLASH_PREVIEW,
        type: 'text',
        name: 'Gemini 3 Flash Preview',
        backend: ModelBackend.Gemini,
        contextWindow: 1048576, // 1M context window
        supportsImageVariation: false,
        max_tokens: 65536, // Max output tokens
        can_stream: true,
        can_think: true,
        pricing: {
          2097152: { input: 2.0 / 1000000, output: 1.0 / 1000000 }, // $2.00/1M input, $1.00/1M output
        },
        supportsVision: true,
        supportsTools: true,
        logoFile: 'Google_logo.png',
        rank: 5,
        trainingCutoff: '2025-01-31',
        releaseDate: '2025-11-30',
        description:
          "Google's Gemini 3 Flash preview for fast, low-latency multimodal understanding, delivering richer visuals and deeper interactivity, built on a foundation of state-of-the-art reasoning.",
      },
      // Gemini 3 pro image preview
      {
        id: ImageModels.GEMINI_3_PRO_IMAGE_PREVIEW,
        type: 'image',
        name: 'Gemini 3 Pro Image Preview',
        backend: ModelBackend.Gemini,
        contextWindow: 100_000, // 100K context window
        supportsImageVariation: true,
        // For image models, max_tokens is consumed as the input-prompt truncation
        // threshold (ImageGeneration/ImageEdit), not the per-image output token count.
        max_tokens: 32_768,
        can_stream: false,
        pricing: {
          1048576: { input: 0.3 / 1000000, output: 30.0 / 1000000 }, // Input: $0.30/1M tokens (text), Output: $30/1M tokens (1290 tokens per image = $0.039)
        },
        supportsSafetyTolerance: true,
        logoFile: 'Google_logo.png',
        rank: 15,
        releaseDate: '2025-11-30',
        trainingCutoff: '2025-01-31',
        description:
          "Google's Gemini 3 Pro Image preview for high-quality image generation and editing. Superseded by the stable Gemini 3 Pro Image (Nano Banana Pro).",
      },
      // Gemini 3 Pro Image (stable - Nano Banana Pro)
      {
        id: ImageModels.GEMINI_3_PRO_IMAGE,
        type: 'image',
        name: 'Gemini 3 Pro Image',
        backend: ModelBackend.Gemini,
        contextWindow: 131_072, // documented input token limit for Gemini 3.x image models
        supportsImageVariation: true,
        // max_tokens = input-prompt truncation threshold (see ImageGeneration/ImageEdit),
        // not per-image output tokens.
        max_tokens: 32_768,
        can_stream: false,
        pricing: {
          1048576: { input: 2.0 / 1000000, output: 120.0 / 1000000 }, // $2.00/1M input (text/image), $120/1M image output
        },
        supportsSafetyTolerance: true,
        logoFile: 'Google_logo.png',
        rank: 13,
        releaseDate: '2026-05-28',
        trainingCutoff: '2025-01-31',
        description:
          "Google's state-of-the-art image generation and editing model (Nano Banana Pro). Best for complex, multi-turn image generation with reasoning, high accuracy, and up to 4K resolution.",
      },
      // Gemini 3.1 Flash Image (stable - Nano Banana 2)
      {
        id: ImageModels.GEMINI_3_1_FLASH_IMAGE,
        type: 'image',
        name: 'Gemini 3.1 Flash Image',
        backend: ModelBackend.Gemini,
        contextWindow: 131_072, // documented input token limit for Gemini 3.x image models
        supportsImageVariation: true,
        // max_tokens = input-prompt truncation threshold (see ImageGeneration/ImageEdit),
        // not per-image output tokens.
        max_tokens: 32_768,
        can_stream: false,
        pricing: {
          1048576: { input: 0.5 / 1000000, output: 60.0 / 1000000 }, // $0.50/1M input (text/image), $60/1M image output
        },
        supportsSafetyTolerance: true,
        logoFile: 'Google_logo.png',
        rank: 14,
        releaseDate: '2026-05-28',
        trainingCutoff: '2025-01-31',
        description:
          "Google's high-efficiency image generation and editing model (Nano Banana 2). Balances price and performance, and adds 0.5K resolution alongside 1K/2K/4K.",
      },
      //  Gemini 2.5 Models
      {
        id: ChatModels.GEMINI_2_5_PRO,
        type: 'text',
        name: 'Gemini 2.5 Pro',
        backend: ModelBackend.Gemini,
        contextWindow: 2097152, // 2M context window
        supportsImageVariation: false,
        max_tokens: 8192,
        can_stream: true,
        can_think: true,
        pricing: {
          2097152: { input: 1.25 / 1000000, output: 10.0 / 1000000 }, // $1.25/1M input, $10/1M output
        },
        supportsVision: true,
        supportsTools: true,
        logoFile: 'Google_logo.png',
        rank: 5,
        trainingCutoff: '2025-01-31',
        releaseDate: '2025-06-01',
        deprecationDate: '2026-10-16',
        description:
          "Google's Gemini 2.5 Pro thinking model, capable of reasoning over complex problems in code, math, and STEM, as well as analyzing large datasets, codebases, and documents using long context",
      },
      {
        id: ChatModels.GEMINI_2_5_FLASH,
        type: 'text',
        name: 'Gemini 2.5 Flash',
        backend: ModelBackend.Gemini,
        contextWindow: 1048576, // 1M context window
        supportsImageVariation: false,
        max_tokens: 65_535,
        can_stream: true,
        can_think: true,
        pricing: {
          1048576: { input: 0.075 / 1000000, output: 0.6 / 1000000 }, // $0.075/1M input, $0.60/1M output
        },
        supportsVision: true,
        supportsTools: true,
        logoFile: 'Google_logo.png',
        rank: 8,
        trainingCutoff: '2025-01-31',
        releaseDate: '2025-06-01',
        deprecationDate: '2026-10-16',
        description:
          "Google's Gemini 2.5 Flash, offering well-rounded price-performance. Best for large scale processing, low-latency, high volume tasks that require thinking, and agentic use cases",
      },
      {
        id: ChatModels.GEMINI_2_5_FLASH_LITE,
        type: 'text',
        name: 'Gemini 2.5 Flash Lite',
        backend: ModelBackend.Gemini,
        contextWindow: 1048576, // 1M context window
        supportsImageVariation: false,
        max_tokens: 65_535,
        can_stream: true,
        pricing: {
          1048576: { input: 0.0375 / 1000000, output: 0.3 / 1000000 }, // $0.0375/1M input, $0.30/1M output
        },
        supportsVision: true,
        supportsTools: true,
        logoFile: 'Google_logo.png',
        rank: 12,
        trainingCutoff: '2025-01-31',
        releaseDate: '2025-07-01',
        deprecationDate: '2026-10-16',
        description: "Google's fastest flash model optimized for cost-efficiency and high throughput.",
      },
      // Preview/Experimental Models
      {
        id: ChatModels.GEMINI_2_5_PRO_PREVIEW,
        type: 'text',
        name: 'Gemini 2.5 Pro Preview',
        backend: ModelBackend.Gemini,
        contextWindow: 2097152, // 2M context window
        supportsImageVariation: false,
        max_tokens: 8192,
        can_stream: true,
        can_think: true, // Enhanced thinking and reasoning
        pricing: {
          2097152: { input: 1.25 / 1000000, output: 5.0 / 1000000 },
        },
        supportsVision: true,
        supportsTools: true,
        logoFile: 'Google_logo.png',
        rank: 20, // Lower rank since stable version is available
        trainingCutoff: '2025-05-01',
        deprecationDate: '2025-12-02',
        description:
          'Preview version of Gemini 2.5 Pro with experimental features. Consider using the stable version for production use.',
      },
      {
        id: ChatModels.GEMINI_2_5_FLASH_PREVIEW,
        type: 'text',
        name: 'Gemini 2.5 Flash Preview',
        backend: ModelBackend.Gemini,
        contextWindow: 1048576, // 1M context window
        supportsImageVariation: false,
        max_tokens: 8192,
        can_stream: true,
        can_think: true, // Adaptive thinking capabilities
        pricing: {
          1048576: { input: 0.075 / 1000000, output: 0.3 / 1000000 }, // Same as 1.5 Flash for now
        },
        supportsVision: true,
        supportsTools: true,
        logoFile: 'Google_logo.png',
        rank: 20, // Lower rank since stable version is available
        deprecationDate: '2026-02-17',
        trainingCutoff: '2025-05-01',
        description:
          'Preview version of Gemini 2.5 Flash with experimental features. Consider using the stable version for production use.',
      },
      {
        id: ChatModels.GEMINI_2_0_FLASH_EXP,
        type: 'text',
        name: 'Gemini 2.0 Flash Experimental',
        backend: ModelBackend.Gemini,
        contextWindow: 1048576,
        supportsImageVariation: false,
        max_tokens: 8192,
        can_stream: true,
        pricing: {
          4000: { input: 0.1 / 1000000, output: 0.4 / 1000000 },
        },
        supportsVision: true,
        supportsTools: true,
        logoFile: 'Google_logo.png',
        deprecationDate: '2025-11-18',
        rank: 50,
        description:
          "Google's experimental Gemini 2.0 model with strong reasoning capabilities. Good for complex reasoning, creative tasks, and detailed analysis.",
      },
      {
        id: ChatModels.GEMINI_1_5_FLASH,
        type: 'text',
        name: 'Gemini 1.5 Flash',
        backend: ModelBackend.Gemini,
        contextWindow: 1048576,
        supportsImageVariation: false,
        max_tokens: 8192,
        can_stream: true,
        pricing: {
          4000: { input: 0.075 / 1000000, output: 0.3 / 1000000 },
        },
        supportsVision: true,
        supportsTools: true,
        logoFile: 'Google_logo.png',
        deprecationDate: '2025-09-04',
        rank: 50,
        description:
          "Google's fast and versatile Gemini 1.5 model optimized for speed and efficiency. Excellent for everyday tasks and general content generation.",
      },
      {
        id: ChatModels.GEMINI_1_5_FLASH_8B,
        type: 'text',
        name: 'Gemini 1.5 Flash 8B',
        backend: ModelBackend.Gemini,
        contextWindow: 1048576,
        supportsImageVariation: false,
        max_tokens: 8192,
        can_stream: true,
        pricing: {
          4000: { input: 0.0375 / 1000000, output: 0.15 / 1000000 },
        },
        supportsVision: true,
        supportsTools: true,
        deprecationDate: '2025-09-04',
        logoFile: 'Google_logo.png',
        rank: 50,
        description:
          "Google's lightweight Gemini 1.5 model with 8B parameters. Cost-effective option for high-volume tasks and lower-intelligence requirements.",
      },
      {
        id: ChatModels.GEMINI_1_5_PRO,
        type: 'text',
        name: 'Gemini 1.5 Pro',
        backend: ModelBackend.Gemini,
        contextWindow: 2097152,
        supportsImageVariation: false,
        max_tokens: 8192,
        can_stream: true,
        pricing: {
          4000: { input: 1.25 / 1000000, output: 5.0 / 1000000 },
        },
        supportsVision: true,
        supportsTools: true,
        deprecationDate: '2025-09-04',
        logoFile: 'Google_logo.png',
        rank: 50,
        description:
          "Google's high-intelligence Gemini 1.5 model with 2M context window. Ideal for complex reasoning tasks requiring deep analysis and long-form content.",
      },
    ];
  }

  /*
   * Perform a completion with the Gemini backend
   * @param model - The model to use
   * @param messages - The messages to send to the model
   * @param options - The options to use for the completion
   * @param callback - The callback to use for the completion
   * @returns A promise that resolves when the completion is complete
   *
   * Notes on what this function needs to do to be "complete" relative
   * to the other backends:
   *
   * - Reformat `messages into Gemini's part type
   * - Incorporate tool requests into the request
   * - If streaming is enabled, stream the response
   * - If streaming is disabled, simply call for completion
   * - In either case, as we receive a response or some chunks, convert the
   *   response and call the callback with the converted chunk
   * - Accumulate inputTokens and outputTokens counts for the completionInfo
   * - Process tool execution(s) from the response, dispatching to the tool(s)
   */
  async complete(
    modelName: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>,
    callback: (text: (string | null | undefined)[], completionInfo: CompletionInfo) => Promise<void>,
    toolsUsed: Array<{ name: string; arguments?: string; id?: string }> = []
  ): Promise<void> {
    this.currentModel = modelName;
    const modelInfo = (await this.getModelInfo()).find(model => model.id === modelName);
    if (!modelInfo) {
      // Unlikely:
      throw new Error(`Model ${modelName} not found`);
    }

    // Tool chaining safeguard: Track and limit recursive tool calls
    const toolCallCount = options._internal?.toolCallCount ?? 0;

    // Multi-turn token accumulators. Each Gemini API call (every recursive
    // tool round-trip) is billed independently, so we add each turn's usage
    // and emit the running total. cliCompletions' assign-not-add wrappedOnChunk
    // means the last cb's tokens win - emitting accum+thisTurn keeps the
    // running total across recursive turns.
    const accumInputTokens = options._internal?.accumInputTokens ?? 0;
    const accumOutputTokens = options._internal?.accumOutputTokens ?? 0;

    // Check if we've exceeded the tool call limit (only when there are tools to execute).
    // Honor a per-request override (a surface-set maxToolCalls); else the default.
    const maxToolCalls = options._internal?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    if (toolCallCount >= maxToolCalls && options.tools?.length) {
      this.logger.warn(
        `[Gemini] Max tool calls limit (${maxToolCalls}) reached. Disabling tools to prevent infinite loops.`
      );
      // Remove tools when limit is hit and continue, preserving _internal settings
      await this.complete(
        modelName,
        messages,
        {
          ...options,
          tools: undefined,
          _internal: options._internal,
        },
        callback,
        toolsUsed
      );
      return;
    }

    // Best-effort response_format support: Gemini's structured-output
    // mode requires its own schema dialect, so for now we degrade by injecting
    // a system-level JSON Schema instruction and report responseFormatMode:
    // 'best-effort' so callers know to post-validate.
    const messagesWithFormat = injectJsonSchemaInstruction(messages, options.responseFormat);
    const bestEffortFormat = isBestEffortJsonSchema(options.responseFormat);

    const systemMessages = messagesWithFormat.filter(message => message.role === 'system');
    const systemInstruction = systemMessages.map(message => message.content).join('\n');

    const nonsystemMessages = messagesWithFormat.filter(message => message.role !== 'system');
    const contents = this.formatMessagesIntoGeminiContent(nonsystemMessages);
    const generationConfig = this.getGenerationConfig(modelInfo, options);

    // Zero or one tools; if one, then all the functionDefinitions are there, up to the
    // limit supported by the model.
    const tools = !options.tools?.length
      ? undefined
      : ([
          {
            functionDeclarations: options.tools!.map(tool => {
              const params = pick(tool.toolSchema.parameters, 'type', 'properties', 'required');
              return {
                name: tool.toolSchema.name,
                description: tool.toolSchema.description,
                parameters: {
                  ...params,
                  type: params.type.toUpperCase(), // "object" -> "OBJECT"
                  properties: params.properties ? this.sanitizeProperties(params.properties) : params.properties,
                },
              };
            }),
          },
        ] as Tool[]);

    const config = {
      model: modelName,
      contents,
      systemInstruction: systemInstruction || undefined,
      generationConfig,
      config: {
        tools,
      },
    };

    this.logger.debug('[Gemini] Request config:', { config });

    const toolCalls: ToolCall[] = [];

    // This turn's token counts. Populated inside the streaming and non-streaming
    // branches and read when threading accumulators through the recursive
    // complete() call further down.
    let turnInputTokens = 0;
    let turnOutputTokens = 0;

    if (options.stream) {
      try {
        const result = await this._api.models.generateContentStream(config);

        let lastChunk: any = null;
        for await (const chunk of result) {
          // Check for abort signal
          if (options.abortSignal?.aborted) {
            throw new Error('Request aborted');
          }

          lastChunk = chunk;
          const streamedText: string[] = [];
          chunk.candidates?.forEach((candidate: GeminiCandidate, i: number) => {
            if (!candidate.content?.parts?.length) {
              return;
            }

            // Iterate through ALL parts, not just parts[0]
            // A chunk can have multiple parts (text, functionCall, etc.)
            candidate.content.parts.forEach((part: GeminiPart, _partIndex: number) => {
              if (part.text) {
                // Gemini already sends incremental text deltas, not accumulated text
                // Accumulate text if multiple parts have text
                streamedText[i] = (streamedText[i] || '') + part.text;
              }

              // Check for functionCall in various possible formats
              if (part.functionCall) {
                this.registerToolCall(part.functionCall, part, toolCalls, toolsUsed);
              }

              // Also check for function_call (snake_case variant)
              if (part.function_call) {
                this.registerToolCall(part.function_call, part, toolCalls, toolsUsed);
              }

              // Check if the part itself is a function call (some APIs structure it differently)
              if (part.name && part.args && !part.text) {
                this.registerToolCall({ name: part.name, args: part.args }, part, toolCalls, toolsUsed);
              }
            });
          });

          // Only call callback if we have new text to send
          if (streamedText.some(text => text)) {
            await callback(streamedText, { toolsUsed });
          }
        }

        // At completion, send token usage info but NO text (already streamed)
        // IMPORTANT: Gemini may send function calls ONLY in the final chunk
        if (lastChunk) {
          this.logger.debug('[Gemini] Gemini final chunk structure:', {
            hasCandidates: !!lastChunk.candidates,
            candidatesCount: lastChunk.candidates?.length,
            finishReason: lastChunk.candidates?.[0]?.finishReason,
            finishMessage: lastChunk.candidates?.[0]?.finishMessage,
            usageMetadata: lastChunk.usageMetadata,
            fullChunk: JSON.stringify(lastChunk, null, 2),
          });

          // Check final chunk for function calls (they might only appear here)
          lastChunk.candidates?.forEach((candidate: GeminiCandidate, _i: number) => {
            if (candidate.content?.parts) {
              candidate.content.parts.forEach((part: GeminiPart, _partIndex: number) => {
                if (part.functionCall) {
                  // Use enhanced duplicate detection for final chunk
                  this.registerToolCall(part.functionCall, part, toolCalls, toolsUsed, true);
                }
              });
            }
          });

          // Extract cache stats if caching is enabled (Gemini caching is automatic)
          const cacheStrategy = options.cacheStrategy;
          let cacheStats: CacheUsageStats | undefined;
          if (cacheStrategy?.enableCaching && lastChunk.usageMetadata) {
            const adapter = getCachingAdapter(ModelBackend.Gemini);
            cacheStats = adapter.extractCacheStats(lastChunk as Record<string, unknown>, modelName);

            if (cacheStats) {
              logCacheStats(this.logger, cacheStats, { streaming: true });
            }
          }

          turnInputTokens = lastChunk.usageMetadata?.promptTokenCount ?? 0;
          turnOutputTokens = lastChunk.usageMetadata?.candidatesTokenCount ?? 0;
          // Emit accum + this turn's tokens. When the call recurses below,
          // the inner call's terminal emit will overwrite this with the full
          // multi-turn total via the same accum+thisTurn shape.
          await callback([], {
            inputTokens: accumInputTokens + turnInputTokens,
            outputTokens: accumOutputTokens + turnOutputTokens,
            toolsUsed,
            cacheStats,
            ...(bestEffortFormat ? { responseFormatMode: 'best-effort' as const } : {}),
          });
        }

        // Execute tools immediately if present (similar to OpenAI/XAI/Bedrock backends)
        // This ensures the tool results and final answer appear in the same stream
        if (toolCalls.length > 0 && options.tools?.length) {
          this.logger.debug('[Gemini] Executing tools immediately:', {
            tools: toolCalls.map(tc => tc.name),
          });

          // Check if we should execute tools or just report them
          if (options.executeTools !== false) {
            // Default behavior: execute tools and recurse
            // CRITICAL: For parallel tool calls, create ONE assistant message with ALL tool_use items
            // Per Gemini API docs: only the FIRST tool call gets thought_signature in parallel calls
            const assistantMessage: IMessage = {
              role: 'assistant',
              content: toolCalls.map((toolCall, index) => ({
                type: 'tool_use',
                id: toolCall.id,
                name: toolCall.name,
                input: toolCall.parameters,
                // Only first tool call gets thought_signature (Gemini 3 requirement for parallel calls)
                thought_signature: index === 0 ? toolCall.thought_signature : undefined,
              })),
            } as IMessage;

            messages.push(assistantMessage);

            // Resolve which tool calls have a registered toolFn
            const resolvedCalls = toolCalls
              .map(toolCall => ({
                toolCall,
                toolFn: options.tools!.find(t => t.toolSchema.name === toolCall.name)?.toolFn,
              }))
              .filter((entry): entry is typeof entry & { toolFn: NonNullable<typeof entry.toolFn> } => {
                if (!entry.toolFn) {
                  this.logger.warn(`[Gemini] Tool ${entry.toolCall.name} not found`);
                  return false;
                }
                return true;
              });

            // Execute tools - parallel by default, sequential when opted out
            const parallelEnabled = options.parallelToolExecution !== false;

            type ToolPayload = { toolCall: (typeof toolCalls)[number]; result: { toString(): string } };

            this.logger.debug('[Gemini] Executing tools (streaming)', {
              mode: parallelEnabled && resolvedCalls.length > 1 ? 'parallel' : 'sequential',
              tools: resolvedCalls.map(e => e.toolCall.name),
            });

            const batchOutcomes = await executeToolsBatch<ToolPayload>(
              resolvedCalls.map(({ toolCall, toolFn }) => async () => {
                const result = await toolFn(toolCall.parameters);
                return { toolCall, result };
              }),
              { parallel: parallelEnabled, maxConcurrency: options.maxParallelTools }
            );

            type ToolOutcome =
              | { ok: true; toolCall: (typeof toolCalls)[number]; result: { toString(): string } }
              | { ok: false; toolCall: (typeof toolCalls)[number]; error: unknown };

            const outcomes: ToolOutcome[] = batchOutcomes.map((outcome, i) =>
              outcome.ok
                ? { ok: true as const, ...outcome.result }
                : { ok: false as const, toolCall: resolvedCalls[i].toolCall, error: outcome.error }
            );

            // Inject results in original order (Gemini requires matching tool_use order)
            for (const outcome of outcomes) {
              if (outcome.ok) {
                // Stream tool results for artifact-generating tools (like recharts)
                await handleToolResultStreaming(outcome.toolCall.name, outcome.result, async results => {
                  await callback(results, { toolsUsed });
                });

                // Push tool result to conversation history
                messages.push({
                  role: 'tool',
                  content: [
                    {
                      type: 'tool_result',
                      content: JSON.stringify({ result: outcome.result }),
                      tool_use_id: outcome.toolCall.id,
                    },
                  ],
                } as IMessage);
              } else {
                if (outcome.error instanceof PermissionDeniedError) throw outcome.error;

                this.logger.error(`[Gemini] Error executing tool ${outcome.toolCall.name}:`, outcome.error);
                // Push error as tool result
                messages.push({
                  role: 'tool',
                  content: [
                    {
                      type: 'tool_result',
                      content: JSON.stringify({
                        error: outcome.error instanceof Error ? outcome.error.message : 'Unknown error',
                      }),
                      tool_use_id: outcome.toolCall.id,
                    },
                  ],
                } as IMessage);
              }
            }

            // Add newline separator before recursive call to ensure proper markdown rendering
            await callback(['\n\n'], { toolsUsed });

            // Recursively call complete to get the final response with tool results
            // This ensures the answer appears in the same stream.
            // Carry this turn's tokens forward so the terminal recursive call
            // emits the full multi-turn billable total to cb.
            await this.complete(
              modelName,
              messages,
              {
                ...options,
                _internal: {
                  ...options._internal,
                  toolCallCount: toolCallCount + 1,
                  accumInputTokens: accumInputTokens + turnInputTokens,
                  accumOutputTokens: accumOutputTokens + turnOutputTokens,
                },
              },
              callback,
              toolsUsed
            );
          } else {
            // New behavior: just pass tool calls through callback, don't execute.
            // The post-stream cb above already emitted accum+thisTurn tokens;
            // this leaf doesn't need to re-emit (no tokens here would be a
            // falsy no-op in wrappedOnChunk).
            this.logger.debug('[Gemini] Gemini executeTools=false, passing tool calls to callback');
            await callback([null], { toolsUsed });
          }
          return; // Exit early since we've handled everything
        }
      } catch (error) {
        // Check if error is due to abort signal
        if (options.abortSignal?.aborted || (error as Error).message.includes('aborted')) {
          throw new Error('Request aborted');
        }
        throw error;
      }
    } else {
      try {
        // Setup abort listener for non-streaming requests
        const abortListener = () => {
          // The Google Generative AI SDK doesn't directly support abort signals
          // but we can throw an error when abort is triggered
        };

        // withAbortListener guarantees the listener is removed even if the
        // request throws - removing it only on the success path leaked one
        // listener per failed call on a reused signal.
        const result = await withAbortListener(options.abortSignal, abortListener, () =>
          this._api.models.generateContent(config)
        );
        const r = result;

        // Check if aborted during request
        if (options.abortSignal?.aborted) {
          throw new Error('Request aborted');
        }

        // Extract cache stats if caching is enabled (Gemini caching is automatic)
        const cacheStrategy = options.cacheStrategy;
        let cacheStats: CacheUsageStats | undefined;
        if (cacheStrategy?.enableCaching && r.usageMetadata) {
          const adapter = getCachingAdapter(ModelBackend.Gemini);
          cacheStats = adapter.extractCacheStats(r as unknown as Record<string, unknown>, modelName);

          if (cacheStats) {
            logCacheStats(this.logger, cacheStats, { streaming: false });
          }
        }

        // Extract text and function calls from non-streaming response
        const textParts: (string | undefined)[] = [];
        r.candidates?.forEach((candidate: GeminiCandidate) => {
          candidate.content?.parts?.forEach((part: GeminiPart) => {
            if (part.text) {
              textParts.push(part.text);
            }
            if (part.functionCall) {
              this.registerToolCall(part.functionCall, part, toolCalls, toolsUsed);
            }
            if (part.function_call) {
              this.registerToolCall(part.function_call, part, toolCalls, toolsUsed);
            }
            if (part.name && part.args && !part.text) {
              this.registerToolCall({ name: part.name, args: part.args }, part, toolCalls, toolsUsed);
            }
          });
        });

        turnInputTokens = r.usageMetadata?.promptTokenCount ?? 0;
        turnOutputTokens = r.usageMetadata?.candidatesTokenCount ?? 0;
        // Emit accum + this turn's tokens. The recursive call below (if any)
        // will overwrite via the same accum+thisTurn shape, ending at the
        // full multi-turn billable total.
        await callback(textParts.length ? textParts : [], {
          inputTokens: accumInputTokens + turnInputTokens,
          outputTokens: accumOutputTokens + turnOutputTokens,
          toolsUsed,
          cacheStats,
          ...(bestEffortFormat ? { responseFormatMode: 'best-effort' as const } : {}),
        });
      } catch (error) {
        // Check if error is due to abort signal
        if (options.abortSignal?.aborted || (error as Error).message.includes('aborted')) {
          throw new Error('Request aborted');
        }
        throw error;
      }
    }

    // For non-streaming mode, handle tool execution separately
    // (Streaming mode already handles tools inline above)
    if (!options.stream && toolCalls.length > 0 && options.tools?.length) {
      this.logger.debug('[Gemini] Executing tools (non-streaming mode):', {
        tools: toolCalls.map(tc => tc.name),
      });

      // Check if we should execute tools or just report them
      if (options.executeTools !== false) {
        // Default behavior: execute tools and recurse
        // CRITICAL: For parallel tool calls, create ONE assistant message with ALL tool_use items
        // Per Gemini API docs: only the FIRST tool call gets thought_signature in parallel calls
        const assistantMessage: IMessage = {
          role: 'assistant',
          content: toolCalls.map((toolCall, index) => ({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.parameters,
            // Only first tool call gets thought_signature (Gemini 3 requirement for parallel calls)
            thought_signature: index === 0 ? toolCall.thought_signature : undefined,
          })),
        } as IMessage;

        messages.push(assistantMessage);

        // Resolve executable tools
        const resolvedCalls = toolCalls
          .map(toolCall => ({
            toolCall,
            toolFn: options.tools!.find(t => t.toolSchema.name === toolCall.name)?.toolFn,
          }))
          .filter((entry): entry is typeof entry & { toolFn: NonNullable<typeof entry.toolFn> } => {
            if (!entry.toolFn) {
              this.logger.warn(`[Gemini] Tool ${entry.toolCall.name} not found`);
              return false;
            }
            return true;
          });

        // Execute tools - parallel by default, sequential when opted out
        const parallelEnabled = options.parallelToolExecution !== false;

        type ToolPayloadNS = { toolCall: (typeof toolCalls)[number]; result: { toString(): string } };

        this.logger.debug('[Gemini] Executing tools (non-streaming)', {
          mode: parallelEnabled && resolvedCalls.length > 1 ? 'parallel' : 'sequential',
          tools: resolvedCalls.map(e => e.toolCall.name),
        });

        const batchOutcomesNS = await executeToolsBatch<ToolPayloadNS>(
          resolvedCalls.map(({ toolCall, toolFn }) => async () => {
            const result = await toolFn(toolCall.parameters);
            return { toolCall, result };
          }),
          { parallel: parallelEnabled, maxConcurrency: options.maxParallelTools }
        );

        type ToolOutcome =
          | { ok: true; toolCall: (typeof toolCalls)[number]; result: { toString(): string } }
          | { ok: false; toolCall: (typeof toolCalls)[number]; error: unknown };

        const outcomes: ToolOutcome[] = batchOutcomesNS.map((outcome, i) =>
          outcome.ok
            ? { ok: true as const, ...outcome.result }
            : { ok: false as const, toolCall: resolvedCalls[i].toolCall, error: outcome.error }
        );

        // Inject results in original order
        for (const outcome of outcomes) {
          if (outcome.ok) {
            // Stream tool results for artifact-generating tools (like recharts)
            await handleToolResultStreaming(outcome.toolCall.name, outcome.result, async results => {
              await callback(results, { toolsUsed });
            });

            // Push tool result to conversation history
            messages.push({
              role: 'tool',
              content: [
                {
                  type: 'tool_result',
                  content: JSON.stringify({ result: outcome.result }),
                  tool_use_id: outcome.toolCall.id,
                },
              ],
            } as IMessage);
          } else {
            if (outcome.error instanceof PermissionDeniedError) throw outcome.error;
            this.logger.error(`[Gemini] Error executing tool ${outcome.toolCall.name}:`, outcome.error);
            // Push error as tool result
            messages.push({
              role: 'tool',
              content: [
                {
                  type: 'tool_result',
                  content: JSON.stringify({
                    error: outcome.error instanceof Error ? outcome.error.message : 'Unknown error',
                  }),
                  tool_use_id: outcome.toolCall.id,
                },
              ],
            } as IMessage);
          }
        }

        // Add newline separator before recursive call to ensure proper markdown rendering
        await callback(['\n\n'], { toolsUsed });

        // Recursively call complete to get the final response with tool results.
        // Carry this turn's tokens forward so the terminal recursive call
        // emits the full multi-turn billable total to cb.
        await this.complete(
          modelName,
          messages,
          {
            ...options,
            _internal: {
              ...options._internal,
              toolCallCount: toolCallCount + 1,
              accumInputTokens: accumInputTokens + turnInputTokens,
              accumOutputTokens: accumOutputTokens + turnOutputTokens,
            },
          },
          callback,
          toolsUsed
        );
      } else {
        // New behavior: just pass tool calls through callback, don't execute
        this.logger.debug('[Gemini] Gemini executeTools=false, passing tool calls to callback');
        await callback([null], { toolsUsed });
      }
    }
  }

  private formatMessagesIntoGeminiContent(messages: IMessage[]): any[] {
    const toolUseIdToName = new Map<string, string>();
    void toolUseIdToName;

    return messages
      .map(message => {
        // Map roles to Gemini-compatible roles
        const mapRole = (role: string) => {
          switch (role) {
            case 'assistant':
              return 'model';
            case 'user':
              return 'user';
            case 'tool':
              return 'user'; // Tool results are treated as user messages in Gemini
            default:
              return 'user'; // Default fallback
          }
        };

        if (typeof message.content === 'string') {
          return {
            role: mapRole(message.role),
            parts: [{ text: message.content }],
          };
        }

        if (message.content?.[0].type === 'text') {
          return {
            role: mapRole(message.role),
            parts: [{ text: (message.content?.[0] as MessageContentText).text }],
          };
        }

        if (message.content?.[0].type === 'image') {
          return {
            role: mapRole(message.role),
            parts: [
              {
                inlineData: {
                  mimeType: (message.content?.[0] as MessageContentInlineImage).source.media_type,
                  data: (message.content?.[0] as MessageContentInlineImage).source.data,
                },
              },
            ],
          };
        }

        if (message.content?.[0].type === 'tool_use') {
          // CRITICAL: Handle multiple tool_use items in one message (parallel function calls)
          // Per Gemini API docs: only the FIRST part gets thought_signature in parallel calls
          const parts = message.content
            .filter((item): item is MessageContentToolUse => item.type === 'tool_use')
            .map((toolUse, index) => {
              toolUseIdToName.set(toolUse.id, toolUse.name);

              const part: any = {
                functionCall: {
                  name: toolUse.name,
                  args: toolUse.input,
                },
              };

              // Only first tool call gets thought_signature (Gemini 3 requirement for parallel calls)
              if (index === 0 && toolUse.thought_signature) {
                part.thoughtSignature = toolUse.thought_signature; // camelCase for some versions
                part.thought_signature = toolUse.thought_signature; // snake_case for other versions
                this.logger.debug('[Gemini] Including thought_signature in request (both formats):', {
                  name: toolUse.name,
                  id: toolUse.id,
                  position: 'first',
                });
              } else if (index === 0 && !toolUse.thought_signature) {
                // Only warn for the first tool call if signature is missing
                this.logger.warn('[Gemini] Missing thought_signature for first function call:', {
                  name: toolUse.name,
                  id: toolUse.id,
                  messageRole: message.role,
                });
                this.logger.warn('[Gemini] This may cause a 400 error with Gemini 3 Pro');
              }

              return part;
            });

          return {
            role: mapRole(message.role),
            parts,
          };
        }

        if (message.content?.[0].type === 'tool_result') {
          const toolResult = message.content[0] as MessageContentToolResult;
          return {
            role: mapRole(message.role),
            parts: [
              {
                functionResponse: {
                  name: toolUseIdToName.get(toolResult.tool_use_id) ?? toolResult.tool_use_id,
                  response: {
                    result: (message.content?.[0] as MessageContentToolResult).content,
                  },
                },
              },
            ],
          };
        }

        return null;
      })
      .filter(part => !!part) as Content[];
  }

  private formatResponseParts(parts: Part[]): IMessage[] {
    return [
      {
        role: 'assistant',
        content: parts
          .map(part => {
            if (part.text) {
              return {
                type: 'text' as const,
                text: part.text,
              } as MessageContentText;
            }
            if (part.fileData) {
              return {
                type: 'image_url' as const,
                image_url: {
                  url: part.fileData.fileUri,
                },
              } as MessageContentImageUrl;
            }
            if (part.functionResponse) {
              return {
                type: 'tool_result' as const,
                tool_use_id: part.functionResponse.name,
                content: JSON.stringify(part.functionResponse.response),
              } as MessageContentToolResult;
            }
            return null;
          })
          .filter(message => !!message),
      },
    ];
  }

  /**
   * Strip JSON Schema fields that Gemini's API doesn't support
   * (e.g., exclusiveMinimum, exclusiveMaximum, additionalProperties on nested objects).
   */
  private sanitizeProperties(properties: Record<string, unknown>): Record<string, unknown> {
    const unsupportedFields = [
      'exclusiveMinimum',
      'exclusiveMaximum',
      'minLength',
      'maxLength',
      'pattern',
      'minItems',
      'maxItems',
      'uniqueItems',
      'additionalProperties',
      'default',
      '$schema',
    ];

    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const prop = { ...(value as Record<string, unknown>) };
        for (const field of unsupportedFields) {
          delete prop[field];
        }
        // Recurse into nested properties
        if (prop.properties && typeof prop.properties === 'object') {
          prop.properties = this.sanitizeProperties(prop.properties as Record<string, unknown>);
        }
        if (prop.items && typeof prop.items === 'object') {
          const items = { ...(prop.items as Record<string, unknown>) };
          for (const field of unsupportedFields) {
            delete items[field];
          }
          if (items.properties && typeof items.properties === 'object') {
            items.properties = this.sanitizeProperties(items.properties as Record<string, unknown>);
          }
          prop.items = items;
        }
        sanitized[key] = prop;
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  private getGenerationConfig(model: ModelInfo, options: Partial<ICompletionOptions>): GenerationConfig {
    return {
      temperature: options.temperature ?? 0.9,
      maxOutputTokens: options.maxTokens ?? 8192,
    };
  }

  pushToolMessages(
    messages: IMessage[],
    tool: { name: string; id: string; parameters: string },
    result: string,
    _thinkingBlocks?: unknown[]
  ) {
    messages.push({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: tool.id,
          name: tool.name,
          input: JSON.parse(tool.parameters || '{}'),
        },
      ],
    } as IMessage);

    messages.push({
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          tool_use_id: tool.id,
          content: result,
        },
      ],
    } as IMessage);
  }
}
