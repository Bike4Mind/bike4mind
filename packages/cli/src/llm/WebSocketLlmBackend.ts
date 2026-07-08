import { IMessage, ModelInfo, ChatModels } from '@bike4mind/common';
import { ICompletionBackend, ICompletionOptions, CompletionInfo } from '@bike4mind/llm-adapters';
import { WebSocketConnectionManager } from '../ws/WebSocketConnectionManager';
import { ApiClient } from '../auth/ApiClient';
import { logger } from '../utils/Logger';
import { StreamLogger } from '../utils/StreamLogger';
import { parseStreamEvent, type StreamEvent } from './streamEvents';
import { runCompletion } from './runCompletion';
import { createTransientRetryPolicy } from './retryPolicy';
import type { CompletionRequest, StreamTransport } from './streamTransport';
import { v4 as uuidv4 } from 'uuid';

/**
 * Hybrid HTTP + WebSocket LLM backend for CLI completions.
 *
 * Sends the request payload via HTTP POST (no 32KB WebSocket frame limit),
 * then receives streaming response chunks via WebSocket (no CloudFront 20s timeout).
 *
 * Like `ServerLlmBackend`, this class is purely a *transport*: `open()` sends the
 * request and yields decoded {@link StreamEvent}s off the socket. The shared
 * {@link runCompletion} core owns retry / accumulate / finalize-once / empty /
 * abort - so porting onto it fixes this backend's two historical gaps for free: a
 * `cli_completion_done` with no content no longer silently produces a blank turn
 * (empty is retried, then surfaced), and a mid-stream disconnect is now retried
 * rather than rejected outright.
 */
export class WebSocketLlmBackend implements ICompletionBackend, StreamTransport {
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
   * Run a completion. Delegates the whole lifecycle to the shared core; this
   * class only supplies the WebSocket transport via `open()` and the retry policy
   * (a transient drop / mid-stream disconnect is retried).
   */
  async complete(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>,
    callback: (text: (string | null | undefined)[], info?: CompletionInfo) => Promise<void>
  ): Promise<void> {
    return runCompletion(
      this,
      { model, messages, options },
      callback,
      createTransientRetryPolicy(),
      options.abortSignal
    );
  }

  /**
   * Open a single attempt: register the response handler, POST the request, and
   * yield decoded events until `cli_completion_done` (returns) or a failure
   * (throws). A `cli_completion_error` frame, a mid-stream disconnect, or a failed
   * POST all throw; the disconnect uses a "connection closed" message so the
   * retry policy classifies it as transient. Handlers are torn down in `finally`.
   */
  open(req: CompletionRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    return this.streamCompletion(req, signal);
  }

  private async *streamCompletion(req: CompletionRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    logger.debug(`[WebSocketLlmBackend] Starting complete() with model: ${req.model}`);

    if (signal?.aborted) {
      logger.debug('[WebSocketLlmBackend] Request aborted before start');
      return;
    }
    if (!this.wsManager.isConnected) {
      throw new Error('WebSocket is not connected');
    }

    const isVerbose = process.env.B4M_VERBOSE === '1';
    const isUltraVerbose = process.env.B4M_DEBUG_STREAM === '1';
    const streamLogger = new StreamLogger(logger, 'WebSocketLlmBackend', isVerbose, isUltraVerbose);
    streamLogger.streamStart();

    const requestId = uuidv4();
    const queue: StreamEvent[] = [];
    let ended = false;
    let failure: Error | undefined;
    let wake: (() => void) | undefined;
    const signalReady = () => {
      wake?.();
      wake = undefined;
    };

    // Running text copy for the verbose StreamLogger only; the core accumulates.
    let loggedText = '';
    let eventCount = 0;

    const onMessage = (message: Record<string, unknown>) => {
      if (signal?.aborted) return;
      const action = message.action as string;

      if (action === 'cli_completion_chunk') {
        eventCount++;
        const chunk = message.chunk;
        streamLogger.onEvent(eventCount, JSON.stringify(chunk));

        // Unknown chunk shape - skip, matching the SSE fall-through. (WebSocket
        // errors arrive as a cli_completion_error action, not an error chunk.)
        const event = parseStreamEvent(chunk);
        if (!event) return;

        if (event.type === 'content') {
          loggedText += event.text ?? '';
          streamLogger.onContent(eventCount, event.text || '', loggedText);
          queue.push(event);
          signalReady();
        } else if (event.type === 'tool_use') {
          streamLogger.onCriticalEvent(eventCount, 'TOOL_USE', `tools: ${event.tools?.length}`);
          if (event.text) loggedText += event.text;
          queue.push(event);
          signalReady();
        }
      } else if (action === 'cli_completion_done') {
        streamLogger.streamComplete(loggedText);
        ended = true;
        signalReady();
      } else if (action === 'cli_completion_error') {
        const errorMsg = (message.error as string) || 'Server error';
        streamLogger.onCriticalEvent(eventCount, 'ERROR', errorMsg);
        failure = new Error(errorMsg);
        ended = true;
        signalReady();
      }
    };

    // A mid-stream disconnect is a transient wire failure - phrase it so the
    // retry policy (isTransientNetworkError) classifies it as retryable, giving
    // the WebSocket path the retries the SSE path already had.
    const onDisconnect = () => {
      logger.debug('[WebSocketLlmBackend] Connection dropped during completion');
      failure = new Error('WebSocket connection closed during completion');
      ended = true;
      signalReady();
    };
    const onAbort = () => {
      logger.debug('[WebSocketLlmBackend] Abort signal received');
      ended = true; // settle without a failure; the core drops partial content
      signalReady();
    };

    this.wsManager.onRequest(requestId, onMessage);
    this.wsManager.onDisconnect(onDisconnect);
    if (signal) {
      if (signal.aborted) {
        this.wsManager.offRequest(requestId);
        this.wsManager.offDisconnect(onDisconnect);
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    // Send the request via HTTP POST (avoids the 32KB WebSocket frame limit);
    // response chunks arrive over the socket, routed by requestId.
    this.apiClient
      .getAxiosInstance()
      .post(
        this.wsCompletionUrl,
        {
          requestId,
          model: req.model,
          messages: req.messages,
          options: {
            temperature: req.options.temperature,
            maxTokens: req.options.maxTokens,
            stream: true,
            tools: req.options.tools || [],
          },
        },
        { signal: req.options.abortSignal }
      )
      .catch(err => {
        if (signal?.aborted) return;
        failure = new Error(`HTTP request failed: ${err instanceof Error ? err.message : String(err)}`);
        ended = true;
        signalReady();
      });

    try {
      while (true) {
        while (queue.length > 0) yield queue.shift() as StreamEvent;
        if (failure) throw failure;
        if (ended) return;
        await new Promise<void>(resolve => {
          wake = resolve;
        });
      }
    } finally {
      this.wsManager.offRequest(requestId);
      this.wsManager.offDisconnect(onDisconnect);
      signal?.removeEventListener('abort', onAbort);
    }
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
