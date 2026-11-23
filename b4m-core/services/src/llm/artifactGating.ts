import {
  pythonDataOriginReservedHosts,
  resolvePythonArtifactDataOrigins,
  withPythonDataOrigins,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { registrableDomain } from '@bike4mind/utils/registrableDomain';

/**
 * Whether artifacts are live for one chat completion: the deployment-wide admin setting AND the
 * caller's per-request flag. Within ChatCompletionProcess this gates BOTH the artifact-emission
 * system prompt and the post-stream extraction, so a turn is never told to emit artifacts that
 * nothing will extract, and never has artifacts spliced into a reply whose caller asked for none.
 *
 * The agent-execution surface resolves the same way: `enableArtifacts` rides the WS `start` payload,
 * is persisted on the AgentExecution doc, and is inherited by dispatched subagent / DAG children so
 * a delegating run cannot route around an opt-out. See `agentExecutor.ts`.
 *
 * `undefined` means the caller expressed no preference and leaves the admin setting as the only
 * gate. That asymmetry is deliberate and load-bearing: most internal callers never set the flag,
 * and reading absence as "off" would silently strip artifacts from all of them. Only an explicit
 * `false` - the external /api/chat surface, the voice proxy, Slack - opts out. Clients that cannot
 * yet resolve the user's preference must therefore send nothing, not `false`.
 */
export function resolveArtifactsEnabled(adminEnabled: boolean, requestedByCaller: boolean | undefined): boolean {
  return adminEnabled && requestedByCaller !== false;
}

/**
 * Hosts a Python data origin may not name: every host this deployment serves from, each with its
 * whole site. Shared by the settings update route, `/api/pyodide-sandbox` and the prompt below.
 * Each runtime reads what it has: the web function has all four variables, the chat completion
 * service and the agent executor only `SERVER_DOMAIN` and `NEXT_PUBLIC_CDN_URL` (see infra/).
 */
export function dataOriginReservedHosts(env: Record<string, string | undefined> = process.env): string[] {
  return pythonDataOriginReservedHosts(
    [
      env.APP_URL,
      env.SERVER_DOMAIN ? `https://${env.SERVER_DOMAIN}` : undefined,
      env.CHAT_COMPLETION_PUBLIC_URL,
      env.NEXT_PUBLIC_CDN_URL,
    ],
    host => registrableDomain(host, { allowPrivateDomains: true })
  );
}

/**
 * The artifact-emission prompt as the model receives it: unchanged when no Python data origin is
 * listed, otherwise with one note naming them. Reserves hosts through `dataOriginReservedHosts`, as
 * the update route and `/api/pyodide-sandbox` do. Shared by the chat path and the agent executor
 * (server-utils `artifactGate.ts`).
 */
export function withArtifactDataOrigins(
  prompt: string,
  storedDataOrigins: unknown,
  reservedHosts: readonly string[] = dataOriginReservedHosts()
): string {
  return withPythonDataOrigins(prompt, resolvePythonArtifactDataOrigins(storedDataOrigins, reservedHosts));
}

/**
 * Whether the callable-function note joins the artifact prompt, from the host's resolver (server-utils
 * `resolveCallableFunctionsEnabled`). No resolver reads as off, and so does a failed read: the note must not fail
 * the turn. Shared by the chat path and the agent executor.
 */
export async function resolveCallableFunctionsSafely(
  resolve: (() => Promise<boolean>) | undefined,
  logger: Pick<Logger, 'warn'>
): Promise<boolean> {
  if (!resolve) return false;
  try {
    return (await resolve()) === true;
  } catch (error) {
    logger.warn('Callable functions note left out: the setting could not be read', error);
    return false;
  }
}

/**
 * The `artifactEmission` slice of the always-on system-prompt floor. Lives here, beside the gate it
 * consumes, so one test can lock gate-and-assembly together: the defect worth guarding is a refactor
 * that drops the conditional at the assembly site in `ChatCompletionProcess`, which a test of
 * `resolveArtifactsEnabled` alone cannot see.
 */
export function buildArtifactEmissionMessages(
  artifactsEnabled: boolean,
  artifactEmissionContent: string
): { role: 'system'; content: string }[] {
  return artifactsEnabled ? [{ role: 'system', content: artifactEmissionContent }] : [];
}
