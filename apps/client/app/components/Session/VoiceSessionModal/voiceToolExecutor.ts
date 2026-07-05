/**
 * Voice Session Tool Executor
 *
 * Executes tools called by the AI during voice sessions.
 * Reuses existing tool implementations from the LLM services.
 */

import { api } from '@client/app/contexts/ApiContext';
import type { IMessageDataToClient } from '@bike4mind/common';

interface ToolExecutionResult {
  success: boolean;
  result?: string;
  error?: string;
}

export type DebugLogger = (message: string) => void;

/**
 * Function signature for subscribing to WebSocket actions.
 * Mirrors the WebsocketContext signature but standalone so no React import needed.
 * Returns an unsubscribe function.
 */
export type SubscribeToActionFn = (
  action: IMessageDataToClient['action'],
  callback: (message: IMessageDataToClient) => Promise<void>
) => () => void;

// No-op logger when none is provided
const noopLogger: DebugLogger = () => {};

// Track active agent_request calls to warn about concurrency
let activeAgentRequests = 0;

/**
 * Execute a tool function called by the AI during a voice session
 */
export async function executeVoiceTool(
  toolName: string,
  args: Record<string, unknown>,
  sessionId?: string,
  debugLog: DebugLogger = noopLogger,
  subscribeToAction?: SubscribeToActionFn
): Promise<ToolExecutionResult> {
  const startTime = Date.now();
  debugLog(`[TOOL] Executing ${toolName} with args: ${JSON.stringify(args)}`);
  console.log(`[Voice Tool] Executing ${toolName}:`, args);

  try {
    let result: string;

    switch (toolName) {
      case 'web_search': {
        const { query, num_results } = args as { query: string; num_results?: number };
        result = await executeWebSearch(query, num_results);
        break;
      }

      case 'web_fetch': {
        const { url } = args as { url: string };
        result = await executeWebFetch(url);
        break;
      }

      case 'weather_info': {
        const { lat, lon, units } = args as { lat: number; lon: number; units?: 'imperial' | 'metric' };
        result = await executeWeather(lat, lon, units);
        break;
      }

      case 'current_datetime':
        result = await executeCurrentDateTime();
        break;

      case 'agent_request': {
        const { message } = args as { message: string };
        result = await executeAgentRequest(message, sessionId, debugLog, subscribeToAction);
        break;
      }

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }

    const elapsed = Date.now() - startTime;
    const resultPreview = result.length > 200 ? result.substring(0, 200) + '...' : result;
    debugLog(`[TOOL] ${toolName} completed in ${elapsed}ms. Result: ${resultPreview}`);
    console.log(`[Voice Tool] ${toolName} result (${elapsed}ms):`, resultPreview);
    return { success: true, result };
  } catch (error) {
    const elapsed = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    debugLog(`[TOOL] ${toolName} FAILED after ${elapsed}ms: ${errorMessage}`);
    console.error(`[Voice Tool] ${toolName} error (${elapsed}ms):`, errorMessage);
    return { success: false, error: errorMessage };
  }
}

/**
 * Execute web fetch via server API
 */
async function executeWebFetch(url: string): Promise<string> {
  const { data } = await api.post('/api/tools/web-fetch', { url });

  return data.result || 'No content could be fetched from the URL.';
}

/**
 * Execute web search via server API
 */
async function executeWebSearch(query: string, num_results: number = 3): Promise<string> {
  const { data } = await api.post('/api/tools/web-search', {
    query,
    num_results,
  });

  return data.result || 'No search results found.';
}

/**
 * Execute weather lookup via server API
 */
async function executeWeather(lat: number, lon: number, units: 'imperial' | 'metric' = 'imperial'): Promise<string> {
  const { data } = await api.post('/api/tools/weather', {
    lat,
    lon,
    units,
  });

  return data.result || 'Weather information unavailable.';
}

/**
 * Get current date and time (client-side, no API needed)
 */
async function executeCurrentDateTime(): Promise<string> {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });

  return `Current date and time: ${dateStr} at ${timeStr}`;
}

/**
 * Route request through the full ChatCompletionService agent loop, giving voice
 * users access to the same tools, RAG, QuestMaster, and MCP integrations as text chat.
 *
 * Uses wait=false to dispatch through the normal async pipeline, then awaits the
 * reply via WebSocket + poll fallback. wait=true is unsafe: process() dispatches via
 * event bus and the reply isn't reliably written to the DB before the HTTP response returns.
 */
async function executeAgentRequest(
  message: string,
  sessionId?: string,
  debugLog: DebugLogger = noopLogger,
  subscribeToAction?: SubscribeToActionFn
): Promise<string> {
  if (!sessionId) {
    debugLog(
      '[AGENT_REQ] WARNING: sessionId is undefined — request may route to a different session than the active voice session'
    );
  }

  if (activeAgentRequests > 0) {
    debugLog(
      `[AGENT_REQ] WARNING: ${activeAgentRequests} agent_request call(s) already in progress — running concurrently`
    );
  }

  activeAgentRequests++;
  debugLog(`[AGENT_REQ] Posting to /api/chat — sessionId=${sessionId}, message="${message}"`);

  try {
    debugLog('[AGENT_REQ] Dispatching quest (wait=false, enableTools=true, enableQuestMaster=false)...');
    const response = await api.post('/api/chat', {
      sessionId,
      message,
      wait: false,
      stream: false,
      enableTools: true,
      enableQuestMaster: false,
    });

    const { data } = response;
    debugLog(`[AGENT_REQ] Response status: ${response.status}`);
    debugLog(`[AGENT_REQ] Response data keys: ${Object.keys(data || {}).join(', ')}`);

    const questId = data.id || data.tracking_info?.quest_id;
    if (!questId) {
      debugLog('[AGENT_REQ] WARNING: No quest ID in response');
      return 'Failed to submit request to the AI system.';
    }

    debugLog(`[AGENT_REQ] Quest created: ${questId}, status=${data.status} — waiting for reply...`);
    return await awaitQuestCompletion(questId, debugLog, subscribeToAction);
  } catch (error: unknown) {
    const axiosError = error as { response?: { status?: number; data?: unknown }; code?: string; message?: string };
    if (axiosError.response) {
      debugLog(
        `[AGENT_REQ] HTTP Error: status=${axiosError.response.status}` +
          ` data=${JSON.stringify(axiosError.response.data).substring(0, 500)}`
      );
    } else if (axiosError.code) {
      debugLog(`[AGENT_REQ] Network error: code=${axiosError.code} message=${axiosError.message}`);
    } else {
      debugLog(`[AGENT_REQ] Unknown error: ${String(error)}`);
    }

    // Return voice-friendly error messages instead of raw Axios errors
    const status = axiosError.response?.status;
    if (status === 401 || status === 403) {
      return "I couldn't authenticate with the AI system. Please try signing in again.";
    } else if (status === 429) {
      return 'The AI system is currently busy. Please try again in a moment.';
    } else if (status && status >= 500) {
      return "I couldn't connect to the AI system right now. Please try again.";
    } else if (axiosError.code === 'ECONNABORTED' || axiosError.code === 'ERR_NETWORK') {
      return 'I lost connection to the server. Please check your internet and try again.';
    }
    return 'Something went wrong with that request. Please try again.';
  } finally {
    activeAgentRequests--;
  }
}

/**
 * Wait for quest completion using WebSocket-primary + slow poll fallback.
 *
 * When subscribeToAction is available:
 *   - Subscribes to 'streamed_chat_completion' WS events, filtered by questId
 *   - Polls GET /api/quests/{id} every 10s as a safety net
 *   - When WS detects done-without-reply, switches poll to rapid 2s mode
 *   - First mechanism to get a reply wins; cleanup runs for both
 *   - Overall timeout: 120 seconds
 *
 * When subscribeToAction is NOT available (backward compat):
 *   - Falls back to 2s polling (original behavior)
 */
async function awaitQuestCompletion(
  questId: string,
  debugLog: DebugLogger = noopLogger,
  subscribeToAction?: SubscribeToActionFn
): Promise<string> {
  // Fallback: if no WS subscription available, use classic 2s polling
  if (!subscribeToAction) {
    debugLog('[QUEST_WAIT] No subscribeToAction — falling back to 2s HTTP polling');
    return pollQuestCompletionFallback(questId, debugLog);
  }

  debugLog('[QUEST_WAIT] Using WebSocket-primary + 10s poll fallback');

  return new Promise<string>(resolve => {
    let resolved = false;
    let unsubscribeWs: (() => void) | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let overallTimeout: ReturnType<typeof setTimeout> | null = null;
    let initialPollDelay: ReturnType<typeof setTimeout> | null = null;
    let doneWithoutReplyCount = 0;
    let consecutiveErrors = 0;
    let pollAttempt = 0;
    let inRapidPollMode = false;

    function cleanup() {
      if (unsubscribeWs) {
        unsubscribeWs();
        unsubscribeWs = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (overallTimeout) {
        clearTimeout(overallTimeout);
        overallTimeout = null;
      }
      if (initialPollDelay) {
        clearTimeout(initialPollDelay);
        initialPollDelay = null;
      }
    }

    function resolveOnce(result: string, source: string) {
      if (resolved) return;
      resolved = true;
      debugLog(`[QUEST_WAIT] Resolved via ${source} (${result.length} chars)`);
      cleanup();
      resolve(result);
    }

    /** Switch from 10s slow poll to 2s rapid poll to catch reply write quickly */
    function switchToRapidPoll() {
      if (inRapidPollMode || resolved) return;
      inRapidPollMode = true;
      debugLog('[QUEST_WAIT] Quest done without reply — switching to rapid 2s polling');

      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (initialPollDelay) {
        clearTimeout(initialPollDelay);
        initialPollDelay = null;
      }

      doPoll();
      pollTimer = setInterval(doPoll, 2000);
    }

    // --- WebSocket listener ---
    unsubscribeWs = subscribeToAction('streamed_chat_completion', async message => {
      if (message.action !== 'streamed_chat_completion') return;

      // Type-narrow to access quest fields (reply is singular, replies is the streaming array)
      const quest = (
        message as {
          quest?: {
            id?: string;
            status?: string;
            reply?: string | null;
            replies?: string[];
          };
        }
      ).quest;
      if (!quest || quest.id !== questId) return;

      const status = quest.status;
      // The LLM pipeline writes content to `replies` (plural array), not `reply` (singular).
      // `reply` is only set on error paths. Check both, preferring replies[0].
      const replyText = quest.replies?.[0] || quest.reply || null;

      debugLog(`[WS] Quest ${questId}: status=${status}, hasReply=${!!replyText}`);

      if (status === 'running') {
        // Quest still processing - just log, don't resolve
        return;
      }

      if (status === 'stopped') {
        resolveOnce('The request was stopped. Please try again.', 'ws:stopped');
        return;
      }

      if (status === 'done') {
        if (replyText) {
          resolveOnce(replyText, 'ws:done');
        } else {
          // done but no reply yet - switch to rapid poll to catch the DB write
          switchToRapidPoll();
        }
      }
    });

    // --- Poll fallback (10s slow, switches to 2s rapid on done-without-reply) ---
    async function doPoll() {
      if (resolved) return;
      pollAttempt++;

      try {
        const { data } = await api.get(`/api/quests/${questId}`);
        const status = data.status;
        // Check replies (plural) first - that's where the LLM pipeline writes content
        const replyText = data.replies?.[0] || data.reply || null;
        debugLog(`[POLL] Attempt ${pollAttempt}: status=${status}, hasReply=${!!replyText}`);

        consecutiveErrors = 0;

        if (replyText) {
          resolveOnce(replyText, 'poll:reply');
          return;
        }

        if (status === 'failed' || status === 'error') {
          resolveOnce('The request failed to process. Please try again.', `poll:${status}`);
          return;
        }

        if (status === 'done' || status === 'completed') {
          // Switch to rapid poll if not already (poll detected done before WS did)
          switchToRapidPoll();

          doneWithoutReplyCount++;
          if (doneWithoutReplyCount >= 10) {
            resolveOnce(
              'The system completed processing but no response text was generated. Check your notebook.',
              'poll:done-no-reply'
            );
          }
        } else {
          doneWithoutReplyCount = 0;
        }
      } catch (error) {
        consecutiveErrors++;
        debugLog(
          `[POLL] Error on attempt ${pollAttempt} (${consecutiveErrors} consecutive): ${error instanceof Error ? error.message : String(error)}`
        );

        if (consecutiveErrors >= 5) {
          resolveOnce(
            'Lost connection to the server while waiting for a response. Please check your notebook.',
            'poll:errors'
          );
        }
      }
    }

    // Delay first poll by 3s when WS is active to avoid an unnecessary early HTTP request
    initialPollDelay = setTimeout(() => {
      if (resolved) return;
      doPoll();
      pollTimer = setInterval(doPoll, 10000);
    }, 3000);

    // --- Overall timeout: 120s ---
    overallTimeout = setTimeout(() => {
      resolveOnce('The request is still processing. Check your notebook for the response.', 'timeout');
    }, 120000);
  });
}

/**
 * Legacy poll-only fallback. Used when subscribeToAction is not available.
 * Polls every 2s for up to 60 attempts (120s total).
 */
async function pollQuestCompletionFallback(questId: string, debugLog: DebugLogger = noopLogger): Promise<string> {
  const maxAttempts = 60;
  const pollInterval = 2000;
  let doneWithoutReplyCount = 0;
  let consecutiveErrors = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, pollInterval));

    try {
      const { data } = await api.get(`/api/quests/${questId}`);
      const status = data.status;
      // Check replies (plural) first - that's where the LLM pipeline writes content
      const replyText = data.replies?.[0] || data.reply || null;
      debugLog(`[POLL] Attempt ${attempt}/${maxAttempts}: status=${status}, hasReply=${!!replyText}`);

      consecutiveErrors = 0;

      if (replyText) {
        debugLog(`[POLL] Got reply (${replyText.length} chars)`);
        return replyText;
      }

      if (status === 'failed' || status === 'error') {
        debugLog(`[POLL] Quest ${status}`);
        return 'The request failed to process. Please try again.';
      }

      if (status === 'done' || status === 'completed') {
        doneWithoutReplyCount++;
        if (doneWithoutReplyCount >= 10) {
          debugLog('[POLL] Quest completed but no reply text after 20s of extra polling');
          return 'The system completed processing but no response text was generated. Check your notebook.';
        }
      } else {
        doneWithoutReplyCount = 0;
      }
    } catch (error) {
      consecutiveErrors++;
      debugLog(
        `[POLL] Error on attempt ${attempt} (${consecutiveErrors} consecutive): ${error instanceof Error ? error.message : String(error)}`
      );

      if (consecutiveErrors >= 5) {
        debugLog(`[POLL] Aborting after ${consecutiveErrors} consecutive API errors`);
        return 'Lost connection to the server while waiting for a response. Please check your notebook.';
      }
    }
  }

  debugLog(`[POLL] Timed out after ${maxAttempts} attempts`);
  return 'The request is still processing. Check your notebook for the response.';
}

/**
 * Format tool execution for display in transcript
 */
export function formatToolExecution(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'web_search': {
      const { query } = args as { query: string };
      return `Searching the web for "${query}"...`;
    }
    case 'web_fetch': {
      const { url } = args as { url: string };
      return `Fetching content from ${url}...`;
    }
    case 'weather_info':
      return `Checking weather...`;
    case 'current_datetime':
      return `Getting current date and time...`;
    case 'agent_request':
      return `Processing with full AI system...`;
    default:
      return `Using ${toolName}...`;
  }
}
