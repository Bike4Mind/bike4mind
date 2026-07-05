import { IMessage, ModelInfo, ChatModels, MessageContentObject } from '@bike4mind/common';
import { ICompletionBackend, ICompletionOptions, CompletionInfo } from '@bike4mind/llm-adapters';
import { ApiClient } from '../auth/ApiClient';
import { createParser } from 'eventsource-parser';
import type { AxiosResponse } from 'axios';
import { isAxiosError } from 'axios';
import { logger } from '../utils/Logger';
import { StreamLogger } from '../utils/StreamLogger';
import { StreamAccumulator } from './streamAccumulator';
import { parseStreamEvent } from './streamEvents';

/**
 * Connection-level failures that should be retried rather than surfaced to the
 * user. Mirrors the canonical retryable-error list in `@bike4mind/llm-adapters`
 * (retry.ts): the most common offender is a TLS socket
 * close mid-stream, which Node surfaces as `Error: aborted` thrown from
 * `node:_http_client` `socketCloseListener`. This happens when the SSE
 * connection sits idle during a long extended-thinking step and an intermediary
 * (or the socket itself) times out the idle connection.
 *
 * Crucially this is NOT a user cancel - those are detected separately via
 * `options.abortSignal` before this classifier is consulted. Matching is on the
 * lowercased message so we catch the various wordings undici/Node emit.
 */
const TRANSIENT_NETWORK_ERROR_PATTERNS = [
  'aborted', // TLS socket close (node:_http_client socketCloseListener)
  'socket closed',
  'socket hang up',
  'connection closed',
  'econnreset',
  'etimedout',
  'terminated',
  'network error',
  'fetch failed',
  'und_err_socket',
];

export function isTransientNetworkError(error: Error): boolean {
  const message = error.message?.toLowerCase() ?? '';
  return TRANSIENT_NETWORK_ERROR_PATTERNS.some(pattern => message.includes(pattern));
}

/**
 * Server-side LLM backend that proxies requests through Bike4Mind API
 * Uses Server-Sent Events (SSE) for streaming responses
 * API keys remain secure on server - never exposed to CLI
 */
export class ServerLlmBackend implements ICompletionBackend {
  private apiClient: ApiClient;
  public currentModel: string;
  private readonly completionsEndpoint: string;
  /** Max retries for transient stream failures (e.g. missing [DONE]) */
  private static readonly MAX_STREAM_RETRIES = 2;

  constructor(options: { apiClient: ApiClient; model: string; completionsUrl?: string }) {
    this.apiClient = options.apiClient;
    this.currentModel = options.model;
    if (options.completionsUrl) {
      this.completionsEndpoint = options.completionsUrl;
    } else {
      logger.debug('[ServerLlmBackend] No completionsUrl from server — is sst dev running?');
      this.completionsEndpoint = '/api/ai/v1/completions';
    }
  }

  /**
   * Make authenticated LLM completion request via server
   * Parses SSE stream and invokes callback for each event.
   * Automatically retries on transient stream failures (e.g. stream ending prematurely).
   */
  async complete(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>,
    callback: (text: (string | null | undefined)[], info?: CompletionInfo) => Promise<void>
  ): Promise<void> {
    let lastError: Error | undefined;

    // Track whether the current attempt delivered any content to the agent.
    // `accumulator.finalize()` invokes the callback exactly once and ONLY when
    // it has accumulated content (tools or text), so any invocation means the
    // full response was delivered. Retrying after that would duplicate the
    // assistant message and burn credits - so a delivered attempt is never
    // retried (a late stream error after [DONE], e.g. a socket abort during
    // teardown, is post-delivery noise).
    let delivered = false;
    const trackingCallback: typeof callback = (text, info) => {
      delivered = true;
      return callback(text, info);
    };

    for (let attempt = 0; attempt <= ServerLlmBackend.MAX_STREAM_RETRIES; attempt++) {
      if (attempt > 0) {
        logger.warn(
          `[ServerLlmBackend] Retrying stream (attempt ${attempt + 1}/${ServerLlmBackend.MAX_STREAM_RETRIES + 1})...`
        );
      }

      try {
        await this.completeOnce(model, messages, options, trackingCallback);
        return; // Success — exit retry loop
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // User-initiated cancel (ESC) is never retried - propagate so the
        // caller's abort path handles it gracefully.
        if (options.abortSignal?.aborted) {
          throw lastError;
        }

        // If this attempt already delivered the full response, a late error is
        // post-delivery noise: don't retry (would duplicate output + burn
        // credits) and, for a transient connection drop, don't surface it as a
        // failure either - the agent already has the complete turn.
        if (delivered) {
          if (isTransientNetworkError(lastError)) {
            logger.warn(`[ServerLlmBackend] Ignoring post-delivery transient stream error: ${lastError.message}`);
            return;
          }
          throw lastError;
        }

        // Retry transient failures on an attempt that delivered nothing:
        //   1. The server dropped the stream without [DONE] and sent no data
        //      ('Stream ended prematurely').
        //   2. The connection dropped mid-stream - e.g. a TLS socket close
        //      during a long thinking step surfaces as `Error: aborted`.
        //      Previously this leaked through and was shown to the user as a
        //      cryptic bare "aborted" error.
        const isRetryable =
          lastError.message.includes('Stream ended prematurely') || isTransientNetworkError(lastError);

        if (!isRetryable) {
          throw lastError; // Not retryable — propagate immediately
        }

        logger.warn(
          `[ServerLlmBackend] Transient stream failure (attempt ${attempt + 1}/${
            ServerLlmBackend.MAX_STREAM_RETRIES + 1
          }): ${lastError.message}`
        );

        // Brief linear backoff so we don't immediately re-hit a connection
        // that's mid-flap. Skip the wait after the final attempt.
        if (attempt < ServerLlmBackend.MAX_STREAM_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }
    }

    // All retries exhausted. For a network drop, surface a clear, actionable
    // message instead of the bare "aborted" the socket layer throws - the user
    // should understand it was the connection, not their input, and how to
    // resume.
    if (lastError && isTransientNetworkError(lastError) && !options.abortSignal?.aborted) {
      logger.error('[ServerLlmBackend] Stream failed after all retries due to a network drop', lastError);
      throw new Error(
        'The connection to the Bike4Mind server dropped mid-response (likely a network timeout during a long ' +
          'thinking step). It was retried automatically but kept failing — type "continue" to resume.'
      );
    }
    throw lastError ?? new Error('Stream failed after all retry attempts');
  }

  /**
   * Single attempt at completing a streaming request.
   */
  private async completeOnce(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>,
    callback: (text: (string | null | undefined)[], info?: CompletionInfo) => Promise<void>
  ): Promise<void> {
    logger.debug(`[ServerLlmBackend] Starting complete() with model: ${model}`);

    // Check if already aborted before starting
    if (options.abortSignal?.aborted) {
      logger.debug('[ServerLlmBackend] Request aborted before start');
      return;
    }

    // Make streaming request to server completions endpoint (outside promise executor)
    logger.debug('[ServerLlmBackend] Making streaming request...');
    let response: Awaited<ReturnType<typeof this.makeStreamingRequest>>;
    try {
      response = await this.makeStreamingRequest(model, messages, options);
    } catch (error) {
      // Handle abort/cancel gracefully - don't treat as error
      if (options.abortSignal?.aborted) {
        logger.debug('[ServerLlmBackend] Request was aborted, resolving gracefully');
        return;
      }

      // Check for axios cancel error (CanceledError)
      if (isAxiosError(error) && error.code === 'ERR_CANCELED') {
        logger.debug('[ServerLlmBackend] Request was canceled, resolving gracefully');
        return;
      }

      logger.error('LLM completion failed', error);

      // Handle axios errors specifically
      if (isAxiosError(error)) {
        logger.debug(
          `[ServerLlmBackend] Axios error details: ${JSON.stringify({
            status: error.response?.status,
            statusText: error.response?.statusText,
            url: error.config?.url,
            method: error.config?.method,
          })}`
        );

        // For 403 errors, try to extract meaningful error from response
        if (error.response?.status === 403 && error.response.data) {
          let errorDetails = '';

          try {
            let responseText = '';

            // response.data is a stream when responseType: 'stream'
            // Try to read from the stream's buffer
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

            // If it's HTML, try to extract error message
            if (responseText.includes('<!DOCTYPE') || responseText.includes('<html')) {
              const titleMatch = responseText.match(/<title>(.*?)<\/title>/i);
              const h1Match = responseText.match(/<h1>(.*?)<\/h1>/i);

              if (titleMatch && titleMatch[1] !== 'Error') {
                errorDetails = titleMatch[1].trim();
              } else if (h1Match) {
                errorDetails = h1Match[1].trim();
              }
            } else if (responseText) {
              // Not HTML, use first 100 chars as error
              errorDetails = responseText.substring(0, 100).trim();
            }
          } catch (extractError) {
            logger.error('[ServerLlmBackend] Error extracting response:', extractError);
          }

          const errorMsg = errorDetails
            ? `403 Forbidden: ${errorDetails}`
            : '403 Forbidden - Request blocked by server. Check debug logs at ~/.bike4mind/debug/';
          throw new Error(errorMsg);
        }

        // For other status codes
        if (error.response) {
          throw new Error(
            `Request failed with status ${error.response.status}: ${error.response.statusText || 'Unknown error'}`
          );
        }
      }

      // Handle other network and auth errors
      if (error instanceof Error) {
        if (error.message.includes('Authentication expired') || error.message.includes('Authentication failed')) {
          throw error; // Pass through auth errors with clear message
        } else if (error.message.includes('ECONNREFUSED')) {
          throw new Error('Cannot connect to Bike4Mind server. Please check your internet connection.');
        } else if (error.message.includes('Rate limit exceeded')) {
          throw error;
        } else {
          throw new Error(`Failed to complete LLM request: ${error.message}`);
        }
      } else {
        throw error;
      }
    }

    logger.debug('[ServerLlmBackend] Got response, setting up SSE parser');

    return new Promise((resolve, reject) => {
      // Initialize StreamLogger for intelligent batching
      const isVerbose = process.env.B4M_VERBOSE === '1';
      const isUltraVerbose = process.env.B4M_DEBUG_STREAM === '1';
      const streamLogger = new StreamLogger(logger, 'ServerLlmBackend', isVerbose, isUltraVerbose);
      streamLogger.streamStart();

      let eventCount = 0;
      const accumulator = new StreamAccumulator();
      let receivedDone = false; // Track if we received [DONE] to prevent race condition
      // Track when the server already sent an SSE `error` event so the `end`
      // handler doesn't ALSO log a noisy "Stream ended without [DONE]" warning
      // and double-reject the promise. The error is the real signal here; the
      // missing [DONE] is just the natural consequence of the server closing
      // the stream after writing the error.
      let receivedError = false;

      const parser = createParser({
        onEvent: event => {
          eventCount++;
          streamLogger.onEvent(eventCount, event.data || '');
          const data = event.data;

          if (data === '[DONE]') {
            receivedDone = true;
            streamLogger.onCriticalEvent(
              eventCount,
              '[DONE]',
              `accumulated text length: ${accumulator.accumulatedLength}`
            );

            // Log stream completion BEFORE callback (which may block on tool permissions)
            streamLogger.streamComplete(accumulator.rawText);

            accumulator
              .finalize(callback)
              .catch(err => {
                logger.error('[ServerLlmBackend] Callback error:', err);
                reject(err);
              })
              .then(() => {
                logger.debug('[ServerLlmBackend] Callback completed, resolving');
                resolve();
              });
            return;
          }

          try {
            const event = parseStreamEvent(JSON.parse(data));

            // Unrecognized event shape - preserve the prior fall-through
            // behavior where an unknown `type` was silently ignored rather
            // than treated as an error. (Malformed JSON is caught below.)
            if (!event) {
              return;
            }

            // Handle different event types
            if (event.type === 'error') {
              receivedError = true;
              streamLogger.onCriticalEvent(eventCount, 'ERROR', event.message || 'Server error');
              reject(new Error(event.message || 'Server error'));
              return;
            }

            if (event.type === 'content') {
              accumulator.apply(event);
              streamLogger.onContent(eventCount, event.text || '', accumulator.rawText);
            } else if (event.type === 'tool_use') {
              streamLogger.onCriticalEvent(eventCount, 'TOOL_USE', `tools: ${event.tools?.length}`);

              // Log tool use request
              if (event.tools && event.tools.length > 0) {
                for (const tool of event.tools) {
                  logger.debug(`TOOL REQUEST: ${tool.name}`);
                  try {
                    // `arguments` is a raw JSON string on the wire (see toolUseSchema).
                    logger.debug(`  Params: ${tool.arguments ?? '{}'}`);
                  } catch {
                    logger.debug(`  Params: [Unable to stringify]`);
                  }
                }
              }

              accumulator.apply(event);

              if (event.thinking && event.thinking.length > 0) {
                streamLogger.onCriticalEvent(eventCount, 'THINKING', `${event.thinking.length} thinking blocks`);
              }
            }
          } catch (parseError) {
            streamLogger.streamError(parseError);
            // Continue processing other events
          }
        },
      });

      // Handle abort signal - destroy the stream when aborted
      if (options.abortSignal) {
        const abortHandler = () => {
          logger.debug('[ServerLlmBackend] Abort signal received, destroying stream');
          response.data.destroy();
          resolve(); // Resolve gracefully on abort
        };

        // Check if already aborted
        if (options.abortSignal.aborted) {
          abortHandler();
          return;
        }

        // Listen for abort
        options.abortSignal.addEventListener('abort', abortHandler, { once: true });

        // Clean up listener when stream ends
        response.data.on('close', () => {
          options.abortSignal?.removeEventListener('abort', abortHandler);
        });
      }

      // Feed response stream to parser
      response.data.on('data', (chunk: Buffer) => {
        // Skip processing if aborted
        if (options.abortSignal?.aborted) {
          return;
        }
        parser.feed(chunk.toString());
      });

      response.data.on('end', () => {
        // Server already sent an explicit error event - that's the real signal.
        // The missing [DONE] is just the natural consequence of the server
        // closing the stream after writing the error; don't log a misleading
        // "stream ended without [DONE]" warning or double-reject.
        if (receivedError) {
          logger.debug('[ServerLlmBackend] Stream ended after server-sent error event');
          return;
        }

        // Only handle here if we didn't receive [DONE]
        // (handles edge case where stream ends without [DONE] signal)
        if (!receivedDone) {
          logger.warn(
            `[ServerLlmBackend] Stream ended without [DONE] signal. ` +
              `Accumulated text: ${accumulator.accumulatedLength} chars, tools: ${accumulator.toolCount}`
          );

          if (!accumulator.isEmpty()) {
            // Deliver whatever we accumulated - the server sent data but dropped the [DONE] marker
            streamLogger.streamComplete(accumulator.rawText);
            accumulator.finalize(callback).then(() => resolve(), reject);
          } else {
            // No data at all - reject so the caller knows the request failed
            reject(
              new Error('Stream ended prematurely without receiving any data. The server may be experiencing issues.')
            );
          }
        } else {
          logger.debug('[ServerLlmBackend] Stream ended, [DONE] handler will resolve');
        }
      });

      response.data.on('error', (error: Error) => {
        // Don't reject on abort-caused errors
        if (options.abortSignal?.aborted) {
          resolve();
          return;
        }
        reject(error);
      });
    });
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
