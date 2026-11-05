import { ACTIVE_AGENT_EXECUTION_STATUSES, type AgentExecutionStatus } from '@bike4mind/common';

const COMPLETED: AgentExecutionStatus = 'completed';

export interface AgentRunCheckDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Abort signal firing after `ms`; injectable so tests need no wall-clock time. */
  timeoutSignal?: (ms: number) => AbortSignal;
}

export interface AgentRunCheckConfig {
  baseUrl: string;
  apiKey: string;
  nonce: string;
  model?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export type AgentRunCheckResult =
  { ok: true; executionId: string; iterations: number | null } | { ok: false; executionId?: string; reason: string };

interface PolledExecution {
  id?: unknown;
  status?: unknown;
  answer?: unknown;
  error?: unknown;
  total_iterations?: unknown;
}

/**
 * Pure verdict on one polled execution. Passes only when the polled id is the started id,
 * the status is `completed`, and the answer echoes the nonce. A failed run also saves an
 * error reply into the session, so only this execution resource can tell it apart.
 */
export function evaluateExecution(executionId: string, polled: PolledExecution, nonce: string): AgentRunCheckResult {
  if (polled.id !== executionId) {
    return {
      ok: false,
      executionId,
      reason: `polled execution id ${String(polled.id)} does not match started ${executionId}`,
    };
  }
  if (polled.status !== COMPLETED) {
    const detail = typeof polled.error === 'string' && polled.error ? `: ${polled.error}` : '';
    return { ok: false, executionId, reason: `run ${executionId} ended ${String(polled.status)}${detail}` };
  }
  if (typeof polled.answer !== 'string' || !polled.answer.includes(nonce)) {
    return { ok: false, executionId, reason: `run ${executionId} completed but answer lacks expected token` };
  }
  const iterations = typeof polled.total_iterations === 'number' ? polled.total_iterations : null;
  return { ok: true, executionId, iterations };
}

const isActive = (status: unknown): boolean => ACTIVE_AGENT_EXECUTION_STATUSES.includes(status as AgentExecutionStatus);

/** Server error text from the shared envelope; never echoes headers. */
async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    const text = body.error ?? body.message;
    if (typeof text === 'string') return text;
  } catch {
    // non-JSON body
  }
  return res.statusText || 'no detail';
}

/** Polls that hit these are retried until the deadline, like a transient proxy or network fault. */
const RETRYABLE_POLL_STATUSES = new Set([429, 502, 503, 504]);

const isAbort = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Starts an agent run, polls it by execution ID, and asserts it completed with the nonce.
 * `timeoutMs` bounds the whole check, including every request. Every failure after the start
 * carries the execution ID, because the run keeps executing on the server.
 */
export async function runSelfhostAgentCheck(
  deps: AgentRunCheckDeps,
  config: AgentRunCheckConfig
): Promise<AgentRunCheckResult> {
  const { baseUrl, apiKey, nonce, model, timeoutMs = 300_000, pollIntervalMs = 3_000 } = config;
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const timeoutSignal = deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));
  const deadline = deps.now() + timeoutMs;

  const call = async (method: string, path: string, body?: unknown): Promise<Response> =>
    deps.fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeoutSignal(Math.max(1, deadline - deps.now())),
    });

  let executionId: string | undefined;
  let lastStatus: unknown;
  let lastError: string | undefined;
  const timedOut = (): AgentRunCheckResult => {
    const seen = lastStatus === undefined ? 'no status observed' : `last status ${String(lastStatus)}`;
    const err = lastError ? `; last error ${lastError}` : '';
    return {
      ok: false,
      executionId,
      reason: `timed out after ${Math.round(timeoutMs / 1000)}s; ${seen}${err}`,
    };
  };

  try {
    const sessionRes = await call('POST', '/api/v1/sessions', { name: `selfhost agent-run check ${nonce}` });
    if (!sessionRes.ok)
      return { ok: false, reason: `session create HTTP ${sessionRes.status}: ${await errorText(sessionRes)}` };
    const sessionId = ((await sessionRes.json()) as { id?: unknown }).id;
    if (typeof sessionId !== 'string') return { ok: false, reason: 'session create returned no id' };

    const startRes = await call('POST', '/api/v1/agent-executions', {
      session_id: sessionId,
      message: `Reply with exactly this token and nothing else, and do not call any tools: ${nonce}`,
      ...(model ? { model } : {}),
      max_iterations: 3,
      enable_artifacts: false,
    });
    if (startRes.status !== 202)
      return { ok: false, reason: `start HTTP ${startRes.status}: ${await errorText(startRes)}` };
    const startedId = ((await startRes.json()) as { id?: unknown }).id;
    if (typeof startedId !== 'string') return { ok: false, reason: 'start returned no execution id' };
    executionId = startedId;

    while (deps.now() < deadline) {
      let polled: PolledExecution;
      try {
        const res = await call('GET', `/api/v1/agent-executions/${encodeURIComponent(startedId)}`);
        if (RETRYABLE_POLL_STATUSES.has(res.status)) {
          lastError = `HTTP ${res.status}`;
          await deps.sleep(pollIntervalMs);
          continue;
        }
        if (!res.ok) return { ok: false, executionId, reason: `poll HTTP ${res.status}: ${await errorText(res)}` };
        polled = (await res.json()) as PolledExecution;
      } catch (err) {
        if (isAbort(err)) break;
        lastError = messageOf(err);
        await deps.sleep(pollIntervalMs);
        continue;
      }
      if (!isActive(polled.status)) return evaluateExecution(startedId, polled, nonce);
      lastStatus = polled.status;
      await deps.sleep(pollIntervalMs);
    }
    return timedOut();
  } catch (err) {
    if (isAbort(err)) return timedOut();
    return { ok: false, executionId, reason: `request failed: ${messageOf(err)}` };
  }
}
