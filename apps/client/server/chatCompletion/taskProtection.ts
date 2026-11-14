import { z } from 'zod';

/**
 * ECS task scale-in protection for the ChatCompletion service, driven by the drain set in
 * server.ts. While the task has in-flight work it asks the ECS agent to protect it, so
 * Service Auto Scaling scale-in (and a deployment) picks an idle task instead of SIGTERMing
 * one whose quests would outlive the drain window. Protection is cleared when the task goes idle.
 *
 * Protection is set with an expiry and refreshed every PROTECTION_REFRESH_MS while busy, so it
 * also holds through a long quest or a long busy stretch. Deployments wait on protected tasks
 * too, so refreshing stops once a task has been continuously busy for MAX_REFRESHED_BUSY_MS:
 * one task can hold off a scale-in or a deploy for at most that plus the expiry. A task busy for
 * longer than that is unprotected until it next goes idle, and falls back on the SIGTERM drain.
 *
 * Outside ECS (local dev, self-host) there is no agent endpoint and this is a no-op. Requires
 * `ecs:UpdateTaskProtection` on the task role (infra/chatCompletion.ts).
 */

export const PROTECTION_EXPIRES_IN_MINUTES = 15;
// Leaves at least 10 min of protection ahead, above the longest single research step (600s).
export const PROTECTION_REFRESH_MS = 5 * 60_000;
export const MAX_REFRESHED_BUSY_MS = 30 * 60_000;
export const AGENT_REQUEST_TIMEOUT_MS = 5_000;
// `armedAt` is stamped when the agent call returns, after the refresh timer's phase. Without
// this slack every tick finds the refresh just short of due and only every other tick refreshes.
export const REFRESH_TOLERANCE_MS = 30_000;
// One retry of a transient failure (timeout, network, throttling, 5xx) before giving up until
// the next update() or timer tick.
export const MAX_TRANSIENT_ATTEMPTS = 2;
export const TRANSIENT_RETRY_DELAY_MS = 1_000;

// The agent's reason when the task is already being stopped: protection can no longer be set and
// the SIGTERM drain covers in-flight work, so this is expected rather than a fault.
const TASK_STOPPING_REASON = 'TASK_STOPPING_OR_STOPPED';
const TRANSIENT_REASONS = new Set(['ThrottlingException', 'ServerException']);

type FailureKind = 'stopping' | 'transient' | 'fatal';

class ProtectionCallError extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind
  ) {
    super(message);
  }
}

const classifyAgentFailure = (reason: string | undefined, status: number): FailureKind => {
  if (reason === TASK_STOPPING_REASON) return 'stopping';
  if ((reason && TRANSIENT_REASONS.has(reason)) || status === 429 || status >= 500) return 'transient';
  return 'fatal';
};

// The agent answers 200 with either `protection` or `failure`; a non-2xx carries `error`.
const AgentResponseSchema = z.object({
  failure: z.object({ Reason: z.string().optional(), Detail: z.string().nullish() }).optional(),
  error: z.object({ Code: z.string().optional(), Message: z.string().optional() }).optional(),
});

type ProtectionLogger = {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
};

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export type TaskProtection = {
  /** Report the current in-flight count; protection follows `count > 0`. */
  update(inFlightCount: number): void;
  /** Resolves once every queued agent call has finished. For tests. */
  idle(): Promise<void>;
};

const noopProtection: TaskProtection = { update: () => undefined, idle: async () => undefined };

export function createTaskProtection({
  agentUri,
  logger,
  fetchFn = fetch,
  retryDelayMs = TRANSIENT_RETRY_DELAY_MS,
}: {
  agentUri: string | undefined;
  logger: ProtectionLogger;
  fetchFn?: FetchFn;
  retryDelayMs?: number;
}): TaskProtection {
  if (!agentUri) return noopProtection;

  const endpoint = `${agentUri}/task-protection/v1/state`;
  let desired = false;
  let applied = false;
  // A timed-out or 5xx call may still have taken effect, so `applied` can't be trusted until a call succeeds.
  let appliedKnown = true;
  let armedAt = 0;
  let busySince = 0;
  let lastCallFailed = false;
  // Kinds already logged in the current failure streak, so a later fatal or stopping failure
  // still surfaces after an earlier transient warn.
  const loggedKinds = new Set<FailureKind>();
  // Set once the agent reports the task is stopping; no later call can succeed.
  let taskStopping = false;
  let pump: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const refreshDue = (now: number) =>
    desired &&
    applied &&
    now - armedAt >= PROTECTION_REFRESH_MS - REFRESH_TOLERANCE_MS &&
    now - busySince < MAX_REFRESHED_BUSY_MS;
  const callNeeded = () => !taskStopping && (!appliedKnown || desired !== applied || refreshDue(Date.now()));

  const setProtection = async (enabled: boolean): Promise<void> => {
    const body = enabled
      ? { ProtectionEnabled: true, ExpiresInMinutes: PROTECTION_EXPIRES_IN_MINUTES }
      : { ProtectionEnabled: false };
    let response: Response;
    try {
      response = await fetchFn(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        // A hung call would otherwise pin `pump` and freeze protection in its last state.
        signal: AbortSignal.timeout(AGENT_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Timeout or network error reaching the agent.
      throw new ProtectionCallError(err instanceof Error ? err.message : String(err), 'transient');
    }
    const parsed = AgentResponseSchema.safeParse(await response.json().catch(() => ({})));
    const payload = parsed.success ? parsed.data : {};
    if (!response.ok || payload.failure || payload.error) {
      const reason = payload.failure?.Reason ?? payload.error?.Code ?? `HTTP ${response.status}`;
      const detail = payload.failure?.Detail ?? payload.error?.Message;
      const kind = classifyAgentFailure(payload.failure?.Reason ?? payload.error?.Code, response.status);
      throw new ProtectionCallError(detail ? `${reason}: ${detail}` : reason, kind);
    }
  };

  // One agent call at a time, always converging on the latest desired state, so a quick
  // busy -> idle -> busy flip can never land as an out-of-order "disable" last.
  const reportFailure = (target: boolean, err: unknown) => {
    const kind = err instanceof ProtectionCallError ? err.kind : 'fatal';
    if (kind === 'stopping') taskStopping = true;
    // Logged once per kind per failure streak so a missing IAM grant doesn't log on every quest.
    if (loggedKinds.has(kind)) return;
    loggedKinds.add(kind);
    const metadata = { enabled: target, error: err instanceof Error ? err.message : String(err) };
    if (kind === 'stopping') {
      logger.warn(
        'Task is stopping - scale-in protection not applied, the SIGTERM drain covers in-flight work',
        metadata
      );
    } else if (kind === 'transient') {
      // Expected now and then from the agent; retried on the next update() or timer tick.
      logger.warn('Task scale-in protection call failed after retry - this task can be scaled in mid-quest', metadata);
    } else {
      logger.error('Failed to update task scale-in protection - this task can be scaled in mid-quest', metadata);
    }
  };

  const drive = async (): Promise<'converged' | 'failed'> => {
    let transientAttempts = 0;
    while (callNeeded()) {
      const target = desired;
      try {
        await setProtection(target);
        applied = target;
        appliedKnown = true;
        transientAttempts = 0;
        if (target) armedAt = Date.now();
        if (lastCallFailed) logger.info('Task scale-in protection calls recovered', { enabled: target });
        lastCallFailed = false;
        loggedKinds.clear();
      } catch (err) {
        appliedKnown = false;
        const transient = err instanceof ProtectionCallError && err.kind === 'transient';
        if (transient && ++transientAttempts < MAX_TRANSIENT_ATTEMPTS) {
          await new Promise(resolve => setTimeout(resolve, retryDelayMs));
          continue;
        }
        reportFailure(target, err);
        lastCallFailed = true;
        // Retried on the next update() or timer tick, never in a loop against a failing agent.
        return 'failed';
      }
    }
    return 'converged';
  };

  // The timer refreshes protection through a long busy stretch and retries a failed call
  // (including a failed disable, which would otherwise leave an idle task protected).
  const syncTimer = () => {
    const active = !taskStopping && (desired || applied || !appliedKnown);
    if (active && !timer) {
      timer = setInterval(kick, PROTECTION_REFRESH_MS);
      timer.unref?.();
    } else if (!active && timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  function kick() {
    if (pump) return;
    pump = drive()
      .catch(() => 'failed' as const)
      .then(outcome => {
        pump = null;
        syncTimer();
        // An update() that landed after the loop's last check was swallowed by `if (pump)`.
        if (outcome === 'converged' && callNeeded()) kick();
      });
  }

  return {
    update(inFlightCount) {
      const busy = inFlightCount > 0;
      if (busy && !desired) busySince = Date.now();
      desired = busy;
      syncTimer();
      kick();
    },
    async idle() {
      while (pump) await pump;
    },
  };
}
