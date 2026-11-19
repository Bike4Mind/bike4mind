import {
  pythonDataOriginReservedHosts,
  resolvePythonArtifactDataOrigins,
  withPythonDataOrigins,
} from '@bike4mind/common';
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
 * The `artifactEmission` slice of the always-on system-prompt floor. Lives here, beside the gate it
 * consumes, so one test can lock gate-and-assembly together: the defect worth guarding is a refactor
 * that drops the conditional at the assembly site in `ChatCompletionProcess`, which a test of
 * `resolveArtifactsEnabled` alone cannot see.
 */
/**
 * The artifact-emission prompt as the model receives it: unchanged when no Python data origin is
 * listed, otherwise with one note naming them. The validation and the app-host check match what
 * `/api/pyodide-sandbox` applies to its CSP, so the model is told exactly the origins that work.
 * Shared by the chat path and the agent executor (server-utils `artifactGate.ts`).
 */
export function withArtifactDataOrigins(
  prompt: string,
  storedDataOrigins: unknown,
  appUrl: string | undefined = process.env.APP_URL
): string {
  const reservedHosts = pythonDataOriginReservedHosts([appUrl], host => registrableDomain(host));
  return withPythonDataOrigins(prompt, resolvePythonArtifactDataOrigins(storedDataOrigins, reservedHosts));
}

export function buildArtifactEmissionMessages(
  artifactsEnabled: boolean,
  artifactEmissionContent: string
): { role: 'system'; content: string }[] {
  return artifactsEnabled ? [{ role: 'system', content: artifactEmissionContent }] : [];
}
