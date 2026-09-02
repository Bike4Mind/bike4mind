/**
 * Resolve the Agent Executor Lambda's function name from whichever SST link the
 * calling runtime actually has.
 *
 * The two links are NOT interchangeable, and which one exists depends on the caller:
 *   - The WebSocket `agent_execute` route links the function itself
 *     (`infra/agentExecutor.ts`), so `Resource.AgentExecutor` resolves there.
 *   - The frontend server links only the executor's NAME, via the
 *     `lambdaFunctionNames` Linkable (`infra/web.ts`). Linking the whole function
 *     into the web app would add a per-resource IAM statement to a policy that is
 *     already close to the 10KB limit, so that was a deliberate choice - see the
 *     comment on `lambdaFunctionNames`. `Resource.AgentExecutor` THROWS there.
 *
 * `startAgentExecution` runs in both, so it cannot hard-code either one. Reading
 * the wrong one is not a type error and not a test failure - it is a 502 at
 * runtime in one transport only, which is exactly how it was found.
 *
 * The `lambdaFunctionNames` read goes through a Record view rather than a
 * compile-time property access: the generated `sst-env.d.ts` is committed and only
 * learns a new key on the next successful deploy, so a direct access breaks a fresh
 * checkout's build and CI's typecheck. Same bridge `modelDiscovery/runNow.ts` uses.
 *
 * Returns undefined when neither link is present, which callers report as a
 * deployment gap rather than a bad request.
 */

import { Resource } from 'sst';

export function resolveAgentExecutorFunctionName(): string | undefined {
  // Direct function link (WebSocket route, queue handlers). Throws when absent.
  try {
    const linked = (Resource as unknown as { AgentExecutor?: { name?: string } }).AgentExecutor?.name;
    if (linked) return linked;
  } catch {
    // Not linked in this runtime - fall through to the name-only bridge.
  }

  // Name-only bridge (frontend server).
  try {
    return (Resource as unknown as { lambdaFunctionNames?: Record<string, string | undefined> }).lambdaFunctionNames
      ?.agentExecutor;
  } catch {
    return undefined;
  }
}
