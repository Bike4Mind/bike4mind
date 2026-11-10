import { z } from 'zod';

/**
 * ECS task scale-in protection for the ChatCompletion service, driven by the drain set in
 * server.ts. While the task has in-flight work it asks the ECS agent to protect it, so
 * Service Auto Scaling scale-in (and a deployment) picks an idle task instead of SIGTERMing
 * one whose quests would outlive the drain window. Protection is cleared when the task goes idle.
 *
 * Protection is armed once per idle -> busy transition and expires on its own after
 * PROTECTION_EXPIRES_IN_MINUTES. It is deliberately not re-armed while busy: deployments also
 * wait on protected tasks, and a task under continuous traffic would otherwise hold a deploy
 * open indefinitely. The expiry is the upper bound on how long one task can delay a deploy.
 *
 * Outside ECS (local dev, self-host) there is no agent endpoint and this is a no-op. Requires
 * `ecs:UpdateTaskProtection` on the task role (infra/chatCompletion.ts).
 */

export const PROTECTION_EXPIRES_IN_MINUTES = 15;
const AGENT_REQUEST_TIMEOUT_MS = 5_000;

// The agent answers 200 with either `protection` or `failure`; a non-2xx carries `error`.
const AgentResponseSchema = z.object({
  failure: z.object({ Reason: z.string().optional(), Detail: z.string().nullish() }).optional(),
  error: z.object({ Code: z.string().optional(), Message: z.string().optional() }).optional(),
});

type ProtectionLogger = {
  info(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
};

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export type TaskProtection = {
  /** Report the current in-flight count; protection follows `count > 0`. */
  update(inFlightCount: number): void;
  /** Resolves once every queued agent call has finished. For tests and shutdown. */
  idle(): Promise<void>;
};

const noopProtection: TaskProtection = { update: () => undefined, idle: async () => undefined };

export function createTaskProtection({
  agentUri,
  logger,
  fetchFn = fetch,
}: {
  agentUri: string | undefined;
  logger: ProtectionLogger;
  fetchFn?: FetchFn;
}): TaskProtection {
  if (!agentUri) return noopProtection;

  const endpoint = `${agentUri}/task-protection/v1/state`;
  let desired = false;
  let applied = false;
  let lastCallFailed = false;
  let pump: Promise<void> | null = null;

  const setProtection = async (enabled: boolean): Promise<void> => {
    const body = enabled
      ? { ProtectionEnabled: true, ExpiresInMinutes: PROTECTION_EXPIRES_IN_MINUTES }
      : { ProtectionEnabled: false };
    const response = await fetchFn(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AGENT_REQUEST_TIMEOUT_MS),
    });
    const parsed = AgentResponseSchema.safeParse(await response.json().catch(() => ({})));
    const payload = parsed.success ? parsed.data : {};
    if (!response.ok || payload.failure || payload.error) {
      const reason = payload.failure?.Reason ?? payload.error?.Code ?? `HTTP ${response.status}`;
      const detail = payload.failure?.Detail ?? payload.error?.Message;
      throw new Error(detail ? `${reason}: ${detail}` : reason);
    }
  };

  // One agent call at a time, always converging on the latest desired state, so a quick
  // busy -> idle -> busy flip can never land as an out-of-order "disable" last.
  const drive = async (): Promise<'converged' | 'failed'> => {
    while (desired !== applied) {
      const target = desired;
      try {
        await setProtection(target);
        applied = target;
        if (lastCallFailed) logger.info('Task scale-in protection calls recovered', { enabled: target });
        lastCallFailed = false;
      } catch (err) {
        // Logged once per failure streak so a missing IAM grant doesn't log on every quest.
        if (!lastCallFailed) {
          logger.error('Failed to update task scale-in protection - this task can be scaled in mid-quest', {
            enabled: target,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        lastCallFailed = true;
        // Retried on the next update() rather than in a loop against a failing agent.
        return 'failed';
      }
    }
    return 'converged';
  };

  const kick = () => {
    if (pump) return;
    pump = drive().then(outcome => {
      pump = null;
      // An update() that landed after the loop's last check was swallowed by `if (pump)`.
      if (outcome === 'converged' && desired !== applied) kick();
    });
  };

  return {
    update(inFlightCount) {
      desired = inFlightCount > 0;
      kick();
    },
    async idle() {
      while (pump) await pump;
    },
  };
}
