import { IMessage, ModelInfo, ChatModels, MessageContentObject } from '@bike4mind/common';
import { ICompletionBackend, ICompletionOptions, CompletionInfo } from '@bike4mind/llm-adapters';
import { ApiClient } from '../auth/ApiClient';
import { createParser } from 'eventsource-parser';
import type { AxiosResponse } from 'axios';
import { isAxiosError } from 'axios';
import { logger } from '../utils/Logger';
import { StreamLogger } from '../utils/StreamLogger';
import { parseStreamEvent, type StreamEvent } from './streamEvents';
import { runCompletion } from './runCompletion';
import { createTransientRetryPolicy } from './retryPolicy';
import type { CompletionRequest, StreamTransport } from './streamTransport';

/**
 * Server-side LLM backend that proxies requests through the Bike4Mind API over
 * Server-Sent Events (SSE). API keys remain secure on the server.
 *
 * This class is purely the SSE *transport*: `open()` makes the streaming request
 * and yields decoded {@link StreamEvent}s. The retry / accumulate /
 * finalize-exactly-once / empty / abort policy lives in {@link runCompletion},
 * which `complete()` delegates to - shared verbatim with `WebSocketLlmBackend`.
 */
export class ServerLlmBackend implements ICompletionBackend, StreamTransport {
  private apiClient: ApiClient;
  public currentModel: string;
  private readonly completionsEndpoint: string;

  constructor(options: { apiClient: ApiClient; model: string; completionsUrl?: string }) {
    this.apiClient = options.apiClient;
    this.currentModel = options.model;
    if (options.completionsUrl) {
      this.completionsEndpoint = options.completionsUrl;
    } else {
      logger.debug('[ServerLlmBackend] No completionsUrl from server - is sst dev running?');
      this.completionsEndpoint = '/api/ai/v1/completions';
    }
  }

  /**
   * Run a completion. Delegates the whole lifecycle (retry / accumulate /
   * deliver-once / empty / abort) to the shared core; this class only supplies
   * the SSE transport via `open()` and the retry policy (a transient network
   * drop is retried).
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
   * Open a single SSE attempt: make the streaming request, then yield decoded
   * events until `[DONE]` / stream end (returns) or a wire failure (throws). A
   * server-sent `error` event is surfaced as a throw so the core can classify
   * it; a transient socket drop throws its raw error so the retry policy sees it.
   */
  open(req: CompletionRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    return this.streamCompletion(req, signal);
  }

  private async *streamCompletion(req: CompletionRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    logger.debug(`[ServerLlmBackend] Starting complete() with model: ${req.model}`);

    if (signal?.aborted) {
      logger.debug('[ServerLlmBackend] Request aborted before start');
      return;
    }

    logger.debug('[ServerLlmBackend] Making streaming request...');
    let response: AxiosResponse;
    try {
      response = await this.makeStreamingRequest(req.model, req.messages, req.options);
    } catch (error) {
      // Abort / cancel is graceful - end the stream, don't surface an error.
      if (signal?.aborted) {
        logger.debug('[ServerLlmBackend] Request was aborted, resolving gracefully');
        return;
      }
      if (isAxiosError(error) && error.code === 'ERR_CANCELED') {
        logger.debug('[ServerLlmBackend] Request was canceled, resolving gracefully');
        return;
      }
      throw this.toStreamingRequestError(error);
    }

    logger.debug('[ServerLlmBackend] Got response, setting up SSE parser');
    yield* this.readSseStream(response, signal);
  }

  /**
   * Bridge the push-based eventsource-parser + Node response stream into a
   * pull-based async iterator of {@link StreamEvent}s. Parsed events queue up and
   * the generator drains them; `[DONE]` / stream `end` ends iteration, and a
   * server `error` event or stream `error` throws. The abort listener and socket
   * teardown are cleaned up in `finally`, so an early `break` by the core (on
   * cancel) also destroys the socket.
   */
  private async *readSseStream(response: AxiosResponse, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const isVerbose = process.env.B4M_VERBOSE === '1';
    const isUltraVerbose = process.env.B4M_DEBUG_STREAM === '1';
    const streamLogger = new StreamLogger(logger, 'ServerLlmBackend', isVerbose, isUltraVerbose);
    streamLogger.streamStart();

    const queue: StreamEvent[] = [];
    let ended = false;
    let failure: Error | undefined;
    let wake: (() => void) | undefined;
    const signalReady = () => {
      wake?.();
      wake = undefined;
    };

    // A running copy of the text purely so the verbose StreamLogger can report
    // accumulated length / preview; the core owns the real accumulation.
    let loggedText = '';
    let eventCount = 0;

    const parser = createParser({
      onEvent: event => {
        eventCount++;
        const data = event.data;
        streamLogger.onEvent(eventCount, data || '');

        if (data === '[DONE]') {
          streamLogger.streamComplete(loggedText);
          ended = true;
          signalReady();
          return;
        }

        try {
          const parsed = parseStreamEvent(JSON.parse(data));
          // Unknown event shape - silently skip, preserving prior fall-through.
          if (!parsed) return;

          if (parsed.type === 'error') {
            streamLogger.onCriticalEvent(eventCount, 'ERROR', parsed.message || 'Server error');
            failure = new Error(parsed.message || 'Server error');
            ended = true;
            signalReady();
            return;
          }

          if (parsed.type === 'content') {
            loggedText += parsed.text ?? '';
            streamLogger.onContent(eventCount, parsed.text || '', loggedText);
          } else if (parsed.type === 'tool_use') {
            streamLogger.onCriticalEvent(eventCount, 'TOOL_USE', `tools: ${parsed.tools?.length}`);
            if (parsed.text) loggedText += parsed.text;
          }

          queue.push(parsed);
          signalReady();
        } catch (parseError) {
          streamLogger.streamError(parseError);
          // Continue processing other events (matches prior behavior).
        }
      },
    });

    const onData = (chunk: Buffer) => {
      if (signal?.aborted) return;
      parser.feed(chunk.toString());
    };
    const onEnd = () => {
      // Stream closed. If we never saw [DONE] and accumulated nothing, the core's
      // empty-completion handling retries; if we accumulated content, it delivers.
      ended = true;
      signalReady();
    };
    const onError = (error: Error) => {
      // An abort-caused stream error is benign - end gracefully; the core sees the
      // aborted signal and settles without the callback. Otherwise surface it.
      if (!signal?.aborted) failure = error;
      ended = true;
      signalReady();
    };
    const onAbort = () => {
      logger.debug('[ServerLlmBackend] Abort signal received, destroying stream');
      response.data.destroy();
      ended = true;
      signalReady();
    };

    response.data.on('data', onData);
    response.data.on('end', onEnd);
    response.data.on('error', onError);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

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
      signal?.removeEventListener('abort', onAbort);
      response.data.off?.('data', onData);
      response.data.off?.('end', onEnd);
      response.data.off?.('error', onError);
      response.data.destroy?.();
    }
  }

  /**
   * Map a streaming-request (pre-stream) failure to a clear Error: the axios
   * 403-with-HTML-error-page case, other HTTP statuses, and common network / auth
   * errors. Abort and ERR_CANCELED are handled by the caller, not here.
   */
  private toStreamingRequestError(error: unknown): Error {
    logger.error('LLM completion failed', error);

    if (isAxiosError(error)) {
      logger.debug(
        `[ServerLlmBackend] Axios error details: ${JSON.stringify({
          status: error.response?.status,
          statusText: error.response?.statusText,
          url: error.config?.url,
          method: error.config?.method,
        })}`
      );

      if (error.response?.status === 403 && error.response.data) {
        let errorDetails = '';
        try {
          let responseText = '';
          // response.data is a stream when responseType: 'stream'
          const stream = error.response.data;

          if (Buffer.isBuffer(stream)) {
            responseText = stream.toString('utf-8');
          } else if (stream?._readableState?.buffer?.length > 0) {
            const chunks: Buffer[] = [];
            for (const chunk of stream._readableState.buffer) {
              if (chunk?.data) {
                chunks.push(Buffer.from(chunk.data));
              }
            }
            responseText = Buffer.concat(chunks).toString('utf-8');
          } else if (typeof stream === 'string') {
            responseText = stream;
          }

          logger.debug(`[ServerLlmBackend] Response preview: ${responseText.substring(0, 200)}`);

          // If it's HTML, try to extract a meaningful error message
          if (responseText.includes('<!DOCTYPE') || responseText.includes('<html')) {
            const titleMatch = responseText.match(/<title>(.*?)<\/title>/i);
            const h1Match = responseText.match(/<h1>(.*?)<\/h1>/i);

            if (titleMatch && titleMatch[1] !== 'Error') {
              errorDetails = titleMatch[1].trim();
            } else if (h1Match) {
              errorDetails = h1Match[1].trim();
            }
          } else if (responseText) {
            errorDetails = responseText.substring(0, 100).trim();
          }
        } catch (extractError) {
          logger.error('[ServerLlmBackend] Error extracting response:', extractError);
        }

        return new Error(
          errorDetails
            ? `403 Forbidden: ${errorDetails}`
            : '403 Forbidden - Request blocked by server. Check debug logs at ~/.bike4mind/debug/'
        );
      }

      if (error.response) {
        return new Error(
          `Request failed with status ${error.response.status}: ${error.response.statusText || 'Unknown error'}`
        );
      }
    }

    if (error instanceof Error) {
      if (error.message.includes('Authentication expired') || error.message.includes('Authentication failed')) {
        return error; // Pass through auth errors with their clear message
      } else if (error.message.includes('ECONNREFUSED')) {
        return new Error('Cannot connect to Bike4Mind server. Please check your internet connection.');
      } else if (error.message.includes('Rate limit exceeded')) {
        return error;
      }
      return new Error(`Failed to complete LLM request: ${error.message}`);
    }
    return new Error(String(error));
  }

  pushToolMessages(
    messages: IMessage[],
    tool: { name: string; id: string; parameters: string },
    result: string,
    thinkingBlocks?: unknown[]
  ) {
    const assistantContent: MessageContentObject[] = [
      ...((thinkingBlocks || []) as MessageContentObject[]),
      {
        type: 'tool_use' as const,
        id: tool.id,
        name: tool.name,
        input: JSON.parse(tool.parameters || '{}'),
      },
    ];

    messages.push({
      role: 'assistant',
      content: assistantContent,
    });

    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: tool.id,
          content: result,
        },
      ],
    });
  }

  /**
   * Get available models from server
   * Fetches from /api/models and filters for CLI-compatible models
   * Falls back to hardcoded list if API fails
   */
  async getModelInfo(): Promise<ModelInfo[]> {
    try {
      // Fetch available models from API
      logger.debug('[ServerLlmBackend] Fetching models from /api/models');
      const response = await this.apiClient.get<{ models: ModelInfo[] }>('/api/models');

      // Validate API response structure
      if (!response || typeof response !== 'object' || !Array.isArray(response.models)) {
        logger.warn('[ServerLlmBackend] Invalid API response format, using fallback models');
        logger.info('⚠️  Using fallback model list (API returned invalid format)');
        return this.getFallbackModels();
      }

      // Filter for CLI-compatible models: text models with tool support
      const filteredModels = response.models.filter(model => model.type === 'text' && model.supportsTools === true);

      logger.debug(`[ServerLlmBackend] Fetched ${filteredModels.length} CLI-compatible models`);

      if (filteredModels.length === 0) {
        logger.warn('[ServerLlmBackend] No CLI-compatible models found from API, using fallback');
        logger.info('⚠️  Using fallback model list (no CLI-compatible models available)');
        return this.getFallbackModels();
      }

      logger.debug(`📋 Loaded ${filteredModels.length} models from server`);
      return filteredModels;
    } catch (error) {
      // Log error and fall back to hardcoded list
      logger.warn(
        `[ServerLlmBackend] Failed to fetch models from API, using fallback: ${error instanceof Error ? error.message : String(error)}`
      );
      logger.info('⚠️  Using fallback model list (API unavailable)');
      return this.getFallbackModels();
    }
  }

  /**
   * Fallback models when API is unavailable
   * Returns hardcoded list of commonly supported models
   */
  private getFallbackModels(): ModelInfo[] {
    return [
      {
        id: ChatModels.CLAUDE_4_6_SONNET,
        name: 'Claude 4.6 Sonnet',
      },
      {
        id: ChatModels.CLAUDE_4_5_SONNET,
        name: 'Claude 4.5 Sonnet',
      },
      {
        id: ChatModels.CLAUDE_4_5_HAIKU,
        name: 'Claude 4.5 Haiku',
      },
      {
        id: ChatModels.GPT4o,
        name: 'GPT-4o',
      },
      {
        id: ChatModels.GPT4o_MINI,
        name: 'GPT-4o Mini',
      },
    ] as ModelInfo[];
  }

  /**
   * Make streaming HTTP request to completions endpoint
   * Uses axios with responseType 'stream' for SSE
   */
  private async makeStreamingRequest(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>
  ): Promise<AxiosResponse> {
    // Use the underlying axios client directly for streaming
    // ApiClient.post() returns response.data, but we need the raw response for streaming
    const axiosInstance = this.apiClient.getAxiosInstance();

    const requestBody = {
      model,
      messages,
      options: {
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        stream: true, // Always use streaming for SSE
        tools: options.tools || [],
      },
    };

    // Log HTTP request
    const bodyStr = JSON.stringify(requestBody);
    const bodySize = Buffer.byteLength(bodyStr, 'utf-8');
    logger.debug(`→ POST ${this.completionsEndpoint}`);
    logger.debug(`  Body: ${logger.formatBytes(bodySize)}`);
    logger.debug(`  Preview: ${bodyStr.substring(0, 200)}`);

    const response = await axiosInstance.post(this.completionsEndpoint, requestBody, {
      responseType: 'stream',
      // Auth header is automatically injected by ApiClient interceptor
      // Pass abort signal to cancel request if user presses ESC
      signal: options.abortSignal,
    });

    // Log HTTP response
    logger.debug(`← ${response.status} ${response.statusText}`);

    return response;
  }
}
