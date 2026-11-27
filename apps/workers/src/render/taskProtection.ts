/**
 * ECS task scale-in protection around one render, so a scale-in or deploy stops an idle render task rather than one
 * mid-encode. A slimmer sibling of apps/client/server/chatCompletion/taskProtection.ts: one render at a time and a
 * render never outlives STUDIO_RENDER_MAX_WALL_CLOCK_MS, so a single expiry above that needs no refresh timer.
 *
 * ECS_AGENT_URI is set by the agent inside an ECS task; elsewhere (local, self-host) this is a no-op. Requires
 * `ecs:UpdateTaskProtection` on the task role. Failures are logged and never fail a render.
 */
import { STUDIO_RENDER_MAX_WALL_CLOCK_MS } from '@bike4mind/common';

// The render cap plus the same 5-minute margin as the queue visibility timeout (main.ts VISIBILITY_SECONDS).
export const PROTECTION_EXPIRES_IN_MINUTES = Math.ceil(STUDIO_RENDER_MAX_WALL_CLOCK_MS / 60_000) + 5;
const AGENT_REQUEST_TIMEOUT_MS = 5_000;

type ProtectionLogger = { warn(message: string, metadata?: Record<string, unknown>): void };

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export type RenderTaskProtection = { set(enabled: boolean): Promise<void> };

export const createRenderTaskProtection = ({
  agentUri,
  logger,
  fetchFn = fetch,
}: {
  agentUri: string | undefined;
  logger: ProtectionLogger;
  fetchFn?: FetchFn;
}): RenderTaskProtection => {
  if (!agentUri) return { set: async () => undefined };
  const endpoint = `${agentUri}/task-protection/v1/state`;
  return {
    async set(enabled) {
      const body = enabled
        ? { ProtectionEnabled: true, ExpiresInMinutes: PROTECTION_EXPIRES_IN_MINUTES }
        : { ProtectionEnabled: false };
      try {
        const response = await fetchFn(endpoint, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(AGENT_REQUEST_TIMEOUT_MS),
        });
        // The agent answers 200 with a `failure` member when it refuses (e.g. the task is already stopping).
        const payload: unknown = await response.json().catch(() => null);
        const refused = typeof payload === 'object' && payload !== null && 'failure' in payload;
        if (!response.ok || refused) {
          logger.warn('Task scale-in protection call failed', { enabled, status: response.status, payload });
        }
      } catch (error) {
        logger.warn('Task scale-in protection call failed', {
          enabled,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
};
