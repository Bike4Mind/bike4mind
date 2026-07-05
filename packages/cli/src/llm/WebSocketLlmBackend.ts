import { IMessage, ModelInfo, ChatModels } from '@bike4mind/common';
import { ICompletionBackend, ICompletionOptions, CompletionInfo } from '@bike4mind/llm-adapters';
import { WebSocketConnectionManager } from '../ws/WebSocketConnectionManager';
import { ApiClient } from '../auth/ApiClient';
import { logger } from '../utils/Logger';
import { StreamLogger } from '../utils/StreamLogger';
import { StreamAccumulator } from './streamAccumulator';
import { parseStreamEvent } from './streamEvents';
import { v4 as uuidv4 } from 'uuid';

/**
 * Hybrid HTTP + WebSocket LLM backend for CLI completions.
 *
 * Sends the request payload via HTTP POST (no 32KB WebSocket frame limit),
 * then receives streaming response chunks via WebSocket (no CloudFront 20s timeout).
 *
 * Implements the same ICompletionBackend interface as ServerLlmBackend.
 */
export class WebSocketLlmBackend implements ICompletionBackend {
  private wsManager: WebSocketConnectionManager;
  private apiClient: ApiClient;
  private tokenGetter: () => Promise<string | null>;
  private wsCompletionUrl: string;
  public currentModel: string;

  constructor(options: {
    wsManager: WebSocketConnectionManager;
    apiClient: ApiClient;
    model: string;
    tokenGetter: () => Promise<string | null>;
    wsCompletionUrl: string;
  }) {
    this.wsManager = options.wsManager;
    this.apiClient = options.apiClient;
    this.currentModel = options.model;
    this.tokenGetter = options.tokenGetter;
    this.wsCompletionUrl = options.wsCompletionUrl;
  }

  /**
   * Send completion request via HTTP POST, receive streaming response via WebSocket.
   * Collects all streamed chunks, then calls callback once at completion
   * with the full accumulated content.
   */
  async complete(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>,
    callback: (text: (string | null | undefined)[], info?: CompletionInfo) => Promise<void>
  ): Promise<void> {
    logger.debug(`[WebSocketLlmBackend] Starting complete() with model: ${model}`);

    if (options.abortSignal?.aborted) {
      logger.debug('[WebSocketLlmBackend] Request aborted before start');
      return;
    }

    if (!this.wsManager.isConnected) {
      throw new Error('WebSocket is not connected');
    }

    const requestId = uuidv4();

    return new Promise<void>((resolve, reject) => {
      const isVerbose = process.env.B4M_VERBOSE === '1';
      const isUltraVerbose = process.env.B4M_DEBUG_STREAM === '1';
      const streamLogger = new StreamLogger(logger, 'WebSocketLlmBackend', isVerbose, isUltraVerbose);
      streamLogger.streamStart();

      let eventCount = 0;
      const accumulator = new StreamAccumulator();
      let settled = false;

      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        this.wsManager.offRequest(requestId);
        this.wsManager.offDisconnect(onDisconnect);
        options.abortSignal?.removeEventListener('abort', abortHandler);
        action();
      };

      const settleResolve = (): void => settle(() => resolve());
      const settleReject = (err: Error): void => settle(() => reject(err));

      // Handle connection drop - reject so caller can retry or fall back
      const onDisconnect = (): void => {
        logger.debug('[WebSocketLlmBackend] Connection dropped during completion');
        settleReject(new Error('WebSocket connection lost during completion'));
      };
      this.wsManager.onDisconnect(onDisconnect);

      // Handle abort signal
      const abortHandler = (): void => {
        logger.debug('[WebSocketLlmBackend] Abort signal received');
        settleResolve();
      };
      if (options.abortSignal) {
        if (options.abortSignal.aborted) {
          settleResolve();
          return;
        }
        options.abortSignal.addEventListener('abort', abortHandler, { once: true });
      }

      // Register message handler for this requestId
      this.wsManager.onRequest(requestId, message => {
        if (options.abortSignal?.aborted) return;

        const action = message.action as string;

        if (action === 'cli_completion_chunk') {
          eventCount++;
          const chunk = message.chunk;
          streamLogger.onEvent(eventCount, JSON.stringify(chunk));

          // Unrecognized chunk shape - skip, matching the SSE backend's
          // fall-through for unknown event types. (WebSocket errors arrive as
          // a `cli_completion_error` action, not as an error chunk.)
          const event = parseStreamEvent(chunk);
          if (!event) return;

          if (event.type === 'content') {
            accumulator.apply(event);
            streamLogger.onContent(eventCount, event.text || '', accumulator.rawText);
          } else if (event.type === 'tool_use') {
            streamLogger.onCriticalEvent(eventCount, 'TOOL_USE', `tools: ${event.tools?.length}`);
            accumulator.apply(event);
          }
        } else if (action === 'cli_completion_done') {
          streamLogger.streamComplete(accumulator.rawText);

          if (accumulator.isEmpty()) {
            settleResolve();
            return;
          }

          accumulator
            .finalize(callback)
            .then(() => settleResolve())
            .catch(err => settleReject(err));
        } else if (action === 'cli_completion_error') {
          const errorMsg = (message.error as string) || 'Server error';
          streamLogger.onCriticalEvent(eventCount, 'ERROR', errorMsg);
          settleReject(new Error(errorMsg));
        }
      });

      // Send the request via HTTP POST (avoids 32KB WebSocket frame limit).
      // Response chunks arrive via WebSocket, routed by requestId.
      const axiosInstance = this.apiClient.getAxiosInstance();
      axiosInstance
        .post(
          this.wsCompletionUrl,
          {
            requestId,
            model,
            messages,
            options: {
              temperature: options.temperature,
              maxTokens: options.maxTokens,
              stream: true,
              tools: options.tools || [],
            },
          },
          { signal: options.abortSignal }
        )
        .catch(err => {
          // HTTP error - reject unless WebSocket already settled
          const msg = err instanceof Error ? err.message : String(err);
          settleReject(new Error(`HTTP request failed: ${msg}`));
        });
    });
  }

  pushToolMessages(
    messages: IMessage[],
    tool: { name: string; id: string; parameters: string },
    result: string,
    thinkingBlocks?: unknown[]
  ) {
    // When ReActAgent executes tools locally, it needs to build up the messages
    // array so the next complete() call sends the full conversation history.
    // Format as Anthropic-compatible tool_use / tool_result content blocks,
    // which the server-side backend will pass through to the LLM provider.
    if (thinkingBlocks && thinkingBlocks.length > 0) {
      messages.push({
        role: 'assistant',
        content: [
          ...(thinkingBlocks as Array<{ type: 'thinking'; thinking: string; signature: string }>),
          {
            type: 'tool_use' as const,
            id: tool.id,
            name: tool.name,
            input: JSON.parse(tool.parameters || '{}'),
          },
        ],
      });
    } else {
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'tool_use' as const,
            id: tool.id,
            name: tool.name,
            input: JSON.parse(tool.parameters || '{}'),
          },
        ],
      });
    }

    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result' as const,
          tool_use_id: tool.id,
          content: result,
        },
      ],
    });
  }

  /**
   * Get available models from server (REST call, not streaming).
   * Delegates to ApiClient -- same as ServerLlmBackend.
   */
  async getModelInfo(): Promise<ModelInfo[]> {
    try {
      logger.debug('[WebSocketLlmBackend] Fetching models from /api/models');
      const response = await this.apiClient.get<{ models: ModelInfo[] }>('/api/models');

      if (!response || typeof response !== 'object' || !Array.isArray(response.models)) {
        logger.warn('[WebSocketLlmBackend] Invalid API response format, using fallback models');
        return this.getFallbackModels();
      }

      const filteredModels = response.models.filter(
        (model: ModelInfo) => model.type === 'text' && model.supportsTools === true
      );

      if (filteredModels.length === 0) {
        logger.warn('[WebSocketLlmBackend] No CLI-compatible models found, using fallback');
        return this.getFallbackModels();
      }

      logger.debug(`[WebSocketLlmBackend] Loaded ${filteredModels.length} models`);
      return filteredModels;
    } catch (error) {
      logger.warn(
        `[WebSocketLlmBackend] Failed to fetch models: ${error instanceof Error ? error.message : String(error)}`
      );
      return this.getFallbackModels();
    }
  }

  private getFallbackModels(): ModelInfo[] {
    return [
      { id: ChatModels.CLAUDE_4_6_SONNET, name: 'Claude 4.6 Sonnet' },
      { id: ChatModels.CLAUDE_4_5_SONNET, name: 'Claude 4.5 Sonnet' },
      { id: ChatModels.CLAUDE_4_5_HAIKU, name: 'Claude 4.5 Haiku' },
      { id: ChatModels.GPT4o, name: 'GPT-4o' },
      { id: ChatModels.GPT4o_MINI, name: 'GPT-4o Mini' },
    ] as ModelInfo[];
  }
}
