/**
 * Stand-in `connectionId` for an agent execution with no WebSocket peer - i.e. one
 * started over REST (`POST /api/v1/agent-executions`) rather than from the product UI.
 *
 * The executor threads a connectionId through every step emitter, checkpoint handoff
 * and subagent dispatch, so making it optional would ripple through all of them for no
 * behavioural gain. A sentinel keeps those signatures unchanged and gives the emitter
 * one place to short-circuit (`createWsSender` in `queueHandlers/agentExecutor.ts`)
 * instead of failing - and swallowing - a PostToConnection call on every step.
 *
 * Not a valid API Gateway connection id, so it can never collide with a real peer.
 *
 * A UI `reconnect` on the same session DOES find a headless run and replays its
 * persisted trace, but it does not make the run start streaming: the executor captures
 * `connectionId` per invocation and re-stamps the doc with it on every continuation
 * (`processExecution`), so the reconnect's write is overwritten. That is the same
 * limitation a browser reconnect already has mid-run, not one this sentinel adds - but
 * do not read the sentinel as something a later reconnect promotes.
 *
 * Lives in its own module so the executor Lambda can import the constant without
 * pulling in the dispatcher's AWS/Mongo module graph.
 */
export const HEADLESS_CONNECTION_ID = 'headless';

/** True when this execution has no WebSocket peer to stream events to. */
export function isHeadlessConnection(connectionId: string): boolean {
  return connectionId === HEADLESS_CONNECTION_ID;
}
