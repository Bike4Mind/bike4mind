import {
  RUN_ABANDONED_FINISH_REASON,
  RUN_TIMED_OUT_FINISH_REASON,
  type AgentExecutionStatus,
  type ApiCompletionOutcome,
} from '@bike4mind/common';

/** Success and failure for a connected app's traffic. Shared by the admin board and the health alerts. */
export type SideAppOutcome = 'completed' | 'failed' | 'interrupted';

/** Accepted work is not a terminal success; keep it distinct from other 2xx responses. */
export type StatusClass = 'accepted' | '2xx' | '5xx' | 'other';

export function statusClassOf(statusCode: number): StatusClass {
  if (statusCode === 202) return 'accepted';
  if (statusCode >= 200 && statusCode < 300) return '2xx';
  if (statusCode >= 500 && statusCode < 600) return '5xx';
  return 'other';
}

/**
 * Exchange-reachable routes with inline results. A non-202 2xx means the app got its result;
 * optional asynchronous audio jobs keep their distinct accepted class until a terminal observation.
 * Deliberately short: /api/chat is queued and completions report through completionObservation.
 */
export const SYNC_SUCCESS_ENDPOINTS: readonly string[] = [
  '/api/tools/web-search',
  '/api/tools/web-fetch',
  '/api/tools/weather',
  '/api/v1/tools/web-search',
  '/api/v1/tools/web-fetch',
  '/api/v1/tools/weather',
  '/api/ai/transcribe',
  '/api/ai/music',
  '/api/ai/tts',
  '/api/ai/sound-effects',
];

export interface RequestOutcomeInput {
  endpoint: string;
  statusClass: StatusClass;
  /** completionObservation.outcome, present only on completion requests. */
  completionOutcome?: ApiCompletionOutcome | null;
}

/**
 * Outcome of one API-key request, or null when it is neither a success nor a failure (a rejected or
 * cap-stopped completion, an in-flight row, a 4xx, or a 2xx on a route whose 2xx proves nothing).
 */
export function classifyRequestOutcome({
  endpoint,
  statusClass,
  completionOutcome,
}: RequestOutcomeInput): SideAppOutcome | null {
  if (completionOutcome === 'completed') return 'completed';
  if (completionOutcome === 'failed') return 'failed';
  if (completionOutcome === 'interrupted') return 'interrupted';
  if (statusClass === '5xx') return 'failed';
  if (statusClass === '2xx' && SYNC_SUCCESS_ENDPOINTS.includes(endpoint)) return 'completed';
  return null;
}

export interface QuestOutcomeInput {
  status?: string | null;
  type?: string | null;
  errorCode?: string | null;
  finishReason?: string | null;
}

const RECOVERED_DEAD_RUN_REASONS: readonly string[] = [RUN_TIMED_OUT_FINISH_REASON, RUN_ABANDONED_FINISH_REASON];

/**
 * Outcome of a queued chat turn once it is terminal. A failed turn is still `status: 'done'`, so the
 * error type, error code and the recovery finish reasons decide; a running or user-stopped turn
 * counts as neither.
 */
export function classifyQuestOutcome({
  status,
  type,
  errorCode,
  finishReason,
}: QuestOutcomeInput): 'completed' | 'failed' | null {
  if (type === 'error' || errorCode || (finishReason && RECOVERED_DEAD_RUN_REASONS.includes(finishReason))) {
    return 'failed';
  }
  return status === 'done' ? 'completed' : null;
}

export const AGENT_EXECUTION_SUCCESS_STATUSES: readonly AgentExecutionStatus[] = ['completed'];
export const AGENT_EXECUTION_FAILURE_STATUSES: readonly AgentExecutionStatus[] = ['failed'];

/** Outcome of an agent run; paused, waiting and user-aborted runs count as neither. */
export function classifyAgentExecutionOutcome(status: string | null | undefined): 'completed' | 'failed' | null {
  if (status && AGENT_EXECUTION_SUCCESS_STATUSES.includes(status as AgentExecutionStatus)) return 'completed';
  if (status && AGENT_EXECUTION_FAILURE_STATUSES.includes(status as AgentExecutionStatus)) return 'failed';
  return null;
}

export interface OutcomeCounts {
  completed: number;
  failed: number;
  interrupted: number;
}

export const emptyOutcomeCounts = (): OutcomeCounts => ({ completed: 0, failed: 0, interrupted: 0 });

/** Failed plus interrupted over every terminal outcome; null when nothing has finished. */
export function failureRate({ completed, failed, interrupted }: OutcomeCounts): number | null {
  const total = completed + failed + interrupted;
  return total === 0 ? null : (failed + interrupted) / total;
}
