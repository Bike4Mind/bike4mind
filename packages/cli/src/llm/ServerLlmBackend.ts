import { IMessage, ModelInfo, ChatModels, MessageContentObject } from '@bike4mind/common';
import { ICompletionBackend, ICompletionOptions, CompletionInfo } from '@bike4mind/llm-adapters';
import { ApiClient } from '../auth/ApiClient';
import { createParser } from 'eventsource-parser';
import type { AxiosResponse } from 'axios';
import { isAxiosError } from 'axios';
import { htmlErrorTitle, htmlFirstH1 } from '../utils/htmlErrorTitle';
import { logger } from '../utils/Logger';
import { StreamLogger } from '../utils/StreamLogger';
import { parseStreamEvent, type StreamEvent } from './streamEvents';
import { runCompletion } from './runCompletion';
import { createTransientRetryPolicy } from './retryPolicy';
import { bridgeToAsyncIterable } from './streamBridge';
import type { CompletionRequest, StreamTransport } from './streamTransport';

const MAX_ERROR_BODY_BYTES = 64 * 1024;
const ERROR_BODY_READ_TIMEOUT_MS = 5000;

/**
 * With responseType 'stream', axios hands an error response back with its body still unread.
 * The read is bounded by size and time; past either limit the stream is destroyed and the
 * partial body returned.
 */
async function readResponseBody(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf-8');
  if (typeof data !== 'object' || data === null) return '';
  if (!(Symbol.asyncIterator in data)) return JSON.stringify(data);

  const chunks: Buffer[] = [];
  let total = 0;
  const read = (async () => {
    try {
      for await (const chunk of data as AsyncIterable<Buffer | string>) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        chunks.push(buf);
        total += buf.length;
        if (total >= MAX_ERROR_BODY_BYTES) return;
      }
    } catch (readError) {
      logger.debug(`[ServerLlmBackend] Could not read error body: ${String(readError)}`);
    }
  })();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<void>(resolve => {
    timer = setTimeout(resolve, ERROR_BODY_READ_TIMEOUT_MS);
  });
  await Promise.race([read, timedOut]);
  clearTimeout(timer);
  (data as { destroy?: () => void }).destroy?.();
  return Buffer.concat(chunks).subarray(0, MAX_ERROR_BODY_BYTES).toString('utf-8');
}

/** The server's JSON error envelope, when the body is one. */
function parseApiError(text: string): { error: string; errorCode?: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { error, errorCode } = parsed as { error?: unknown; errorCode?: unknown };
    if (typeof error !== 'string') return undefined;
    return typeof errorCode === 'string' ? { error, errorCode } : { error };
  } catch {
    return undefined;
  }
}

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

  constructor(options: { apiClient: ApiClient; model: string; sseCompletionsUrl?: string }) {
    this.apiClient = options.apiClient;
    this.currentModel = options.model;
    if (options.sseCompletionsUrl) {
      this.completionsEndpoint = options.sseCompletionsUrl;
    } else if (process.env.B4M_COMPLETIONS_URL) {
      // Escape hatch for stacks whose app origin doesn't route /api/ai/v1/* to the
      // ChatCompletion service (e.g. a self-host compose stack, where the service is
      // published on its own port). Point this at the full completions endpoint,
      // e.g. http://localhost:8788/api/ai/v1/completions.
      this.completionsEndpoint = process.env.B4M_COMPLETIONS_URL;
      logger.debug(`[ServerLlmBackend] Using B4M_COMPLETIONS_URL override: ${this.completionsEndpoint}`);
    } else {
      logger.debug('[ServerLlmBackend] No sseCompletionsUrl from server - is sst dev running?');
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
      throw await this.toStreamingRequestError(error);
    }

    logger.debug('[ServerLlmBackend] Got response, setting up SSE parser');
    yield* this.readSseStream(response, signal);
  }

  /**
   * Bridge the push-based eventsource-parser + Node response stream into a
   * pull-based iterable of {@link StreamEvent}s. `[DONE]` / stream `end` ends
   * iteration, a server `error` event or stream `error` throws. The abort
   * listener and socket teardown run in the bridge's teardown, so an early
   * `break` by the core (on cancel) also destroys the socket.
   */
  private readSseStream(response: AxiosResponse, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const isVerbose = process.env.B4M_VERBOSE === '1';
    const isUltraVerbose = process.env.B4M_DEBUG_STREAM === '1';
    const streamLogger = new StreamLogger(logger, 'ServerLlmBackend', isVerbose, isUltraVerbose);
    streamLogger.streamStart();

    // A running copy of the text purely so the verbose StreamLogger can report
    // accumulated length / preview; the core owns the real accumulation.
    let loggedText = '';
    let eventCount = 0;

    return bridgeToAsyncIterable<StreamEvent>(sink => {
      const parser = createParser({
        onEvent: event => {
          eventCount++;
          const data = event.data;
          streamLogger.onEvent(eventCount, data || '');

          if (data === '[DONE]') {
            streamLogger.streamComplete(loggedText);
            sink.end();
            return;
          }

          try {
            const parsed = parseStreamEvent(JSON.parse(data));
            // Unknown event shape - silently skip, preserving prior fall-through.
            if (!parsed) return;

            if (parsed.type === 'error') {
              streamLogger.onCriticalEvent(eventCount, 'ERROR', parsed.message || 'Server error');
              sink.fail(new Error(parsed.message || 'Server error'));
              return;
            }

            if (parsed.type === 'content') {
              loggedText += parsed.text ?? '';
              streamLogger.onContent(eventCount, parsed.text || '', loggedText);
            } else if (parsed.type === 'tool_use') {
              streamLogger.onCriticalEvent(eventCount, 'TOOL_USE', `tools: ${parsed.tools?.length}`);
              if (parsed.text) loggedText += parsed.text;
            }

            sink.push(parsed);
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
      // Stream closed. If we never saw [DONE] and accumulated nothing, the core's
      // empty-completion handling retries; if we accumulated content, it delivers.
      const onEnd = () => sink.end();
      // An abort-caused stream error is benign - end gracefully; the core sees the
      // aborted signal and settles without the callback. Otherwise surface it.
      const onError = (error: Error) => (signal?.aborted ? sink.end() : sink.fail(error));
      const onAbort = () => {
        logger.debug('[ServerLlmBackend] Abort signal received, destroying stream');
        response.data.destroy();
        sink.end();
      };

      response.data.on('data', onData);
      response.data.on('end', onEnd);
      response.data.on('error', onError);
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      return () => {
        signal?.removeEventListener('abort', onAbort);
        response.data.off?.('data', onData);
        response.data.off?.('end', onEnd);
        response.data.off?.('error', onError);
        response.data.destroy?.();
      };
    });
  }

  /**
   * Map a streaming-request (pre-stream) failure to a clear Error: the server's JSON error
   * envelope (message plus errorCode), an HTML error page on a 403, other HTTP statuses, and
   * common network / auth errors. Abort and ERR_CANCELED are handled by the caller, not here.
   */
  private async toStreamingRequestError(error: unknown): Promise<Error> {
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

      const response = error.response;
      if (response) {
        const responseText = await readResponseBody(response.data);
        logger.debug(`[ServerLlmBackend] Response preview: ${responseText.substring(0, 200)}`);

        const apiError = parseApiError(responseText);
        if (apiError) {
          const detail = apiError.errorCode ? `${apiError.error} (${apiError.errorCode})` : apiError.error;
          // isLlmUnavailableError (utils/handoff.ts) matches this prefix to trigger fallback on 5xx.
          return new Error(
            response.status >= 500 ? `Request failed with status ${response.status}: ${detail}` : detail
          );
        }

        if (response.status === 403) {
          let errorDetails = '';
          if (responseText.includes('<!DOCTYPE') || responseText.includes('<html')) {
            errorDetails = htmlErrorTitle(responseText) ?? htmlFirstH1(responseText)?.trim() ?? '';
          } else if (responseText) {
            errorDetails = responseText.substring(0, 100).trim();
          }
          return new Error(
            errorDetails
              ? `403 Forbidden: ${errorDetails}`
              : '403 Forbidden - Request blocked by server. Check debug logs at ~/.bike4mind/debug/'
          );
        }

        return new Error(`Request failed with status ${response.status}: ${response.statusText || 'Unknown error'}`);
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
        name: 'Claude Sonnet 4.6',
      },
      {
        id: ChatModels.CLAUDE_4_5_SONNET,
        name: 'Claude Sonnet 4.5',
      },
      {
        id: ChatModels.CLAUDE_4_5_HAIKU,
        name: 'Claude Haiku 4.5',
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
