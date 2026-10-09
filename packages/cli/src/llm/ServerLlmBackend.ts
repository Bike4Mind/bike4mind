import { IMessage, ModelInfo, ChatModels, MessageContentObject } from '@bike4mind/common';
import { ICompletionBackend, ICompletionOptions, CompletionInfo } from '@bike4mind/llm-adapters';
import { B4mApiError, createClient, type B4mClient, type JsonBody } from '@bike4mind/sdk';
import { ApiClient } from '../auth/ApiClient';
import { isAxiosError } from 'axios';
import { htmlErrorTitle, htmlFirstH1 } from '../utils/htmlErrorTitle';
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
  private readonly sdk: B4mClient;
  public currentModel: string;
  private readonly completionsEndpoint: string;

  constructor(options: { apiClient: ApiClient; model: string; sseCompletionsUrl?: string }) {
    this.apiClient = options.apiClient;
    // The ApiClient's fetch carries its auth, refresh-on-401 and timeout, so the SDK stream inherits them.
    this.sdk = createClient({ baseUrl: options.apiClient.baseURL, fetch: options.apiClient.fetch });
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

    const isVerbose = process.env.B4M_VERBOSE === '1';
    const isUltraVerbose = process.env.B4M_DEBUG_STREAM === '1';
    const streamLogger = new StreamLogger(logger, 'ServerLlmBackend', isVerbose, isUltraVerbose);

    // A running copy of the text purely so the verbose StreamLogger can report
    // accumulated length / preview; the core owns the real accumulation.
    let loggedText = '';
    let eventCount = 0;
    streamLogger.streamStart();
    try {
      for await (const event of this.sdk.completions(this.requestBody(req), {
        signal,
        url: this.completionsEndpoint,
      })) {
        eventCount++;
        streamLogger.onEvent(eventCount, JSON.stringify(event));

        const parsed = parseStreamEvent(event);
        // Unknown event shape - silently skip, preserving prior fall-through.
        if (!parsed) continue;

        if (parsed.type === 'error') {
          streamLogger.onCriticalEvent(eventCount, 'ERROR', parsed.message || 'Server error');
          throw new Error(parsed.message || 'Server error');
        }

        if (parsed.type === 'content') {
          loggedText += parsed.text ?? '';
          streamLogger.onContent(eventCount, parsed.text || '', loggedText);
        } else if (parsed.type === 'tool_use') {
          streamLogger.onCriticalEvent(eventCount, 'TOOL_USE', `tools: ${parsed.tools?.length}`);
          if (parsed.text) loggedText += parsed.text;
        }

        yield parsed;
      }
      // Stream closed. If we never saw [DONE] and accumulated nothing, the core's
      // empty-completion handling retries; if we accumulated content, it delivers.
      streamLogger.streamComplete(loggedText);
    } catch (error) {
      // Abort / cancel is graceful - end the stream, don't surface an error; the core
      // sees the aborted signal and settles without the callback.
      if (signal?.aborted || (isAxiosError(error) && error.code === 'ERR_CANCELED')) {
        logger.debug('[ServerLlmBackend] Request was aborted, resolving gracefully');
        return;
      }
      // An HTTP status or a connect failure happened before the stream; map it. A server
      // `error` event and a mid-stream socket drop pass through raw, so the retry policy
      // can classify the drop.
      if (error instanceof B4mApiError || isAxiosError(error)) throw this.toStreamingRequestError(error);
      throw error;
    }
  }

  /**
   * Map a streaming-request (pre-stream) failure to a clear Error: the axios
   * 403-with-HTML-error-page case, other HTTP statuses, and common network / auth
   * errors. Abort and ERR_CANCELED are handled by the caller, not here.
   */
  private toStreamingRequestError(error: unknown): Error {
    logger.error('LLM completion failed', error);

    if (error instanceof B4mApiError) {
      logger.debug(
        `[ServerLlmBackend] HTTP error details: ${JSON.stringify({
          status: error.status,
          requestId: error.requestId,
          url: this.completionsEndpoint,
        })}`
      );

      if (error.status === 403 && error.body) {
        const responseText = typeof error.body === 'string' ? error.body : JSON.stringify(error.body);
        logger.debug(`[ServerLlmBackend] Response preview: ${responseText.substring(0, 200)}`);

        let errorDetails = '';
        // If it's HTML (a WAF / edge block page), try to extract a meaningful error message
        if (responseText.includes('<!DOCTYPE') || responseText.includes('<html')) {
          const title = htmlErrorTitle(responseText);
          const h1 = htmlFirstH1(responseText);
          if (title !== null) {
            errorDetails = title;
          } else if (h1 !== null) {
            errorDetails = h1.trim();
          }
        } else if (responseText) {
          errorDetails = responseText.substring(0, 100).trim();
        }

        return new Error(
          errorDetails
            ? `403 Forbidden: ${errorDetails}`
            : '403 Forbidden - Request blocked by server. Check debug logs at ~/.bike4mind/debug/'
        );
      }

      // Keep this wording: utils/handoff.ts isLlmUnavailableError matches on it.
      return new Error(`Request failed with status ${error.status}: ${error.message}`);
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

  private requestBody(req: CompletionRequest): JsonBody<'createCompletion'> {
    const requestBody = {
      model: req.model,
      messages: req.messages,
      options: {
        temperature: req.options.temperature,
        maxTokens: req.options.maxTokens,
        stream: true, // Always use streaming for SSE
        tools: req.options.tools || [],
      },
    };

    // Log HTTP request
    const bodyStr = JSON.stringify(requestBody);
    const bodySize = Buffer.byteLength(bodyStr, 'utf-8');
    logger.debug(`\u2192 POST ${this.completionsEndpoint}`);
    logger.debug(`  Body: ${logger.formatBytes(bodySize)}`);
    logger.debug(`  Preview: ${bodyStr.substring(0, 200)}`);

    // IMessage / ICompletionOptions are the CLI's own types; the server accepts this shape as-is.
    return requestBody as unknown as JsonBody<'createCompletion'>;
  }
}
