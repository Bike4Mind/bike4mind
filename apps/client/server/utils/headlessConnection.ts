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
 * If the product UI later opens the same session, the `reconnect` command overwrites
 * this with the live connection and the run starts streaming.
 *
 * Lives in its own module so the executor Lambda can import the constant without
 * pulling in the dispatcher's AWS/Mongo module graph.
 */
export const HEADLESS_CONNECTION_ID = 'headless';

/** True when this execution has no WebSocket peer to stream events to. */
export function isHeadlessConnection(connectionId: string): boolean {
  return connectionId === HEADLESS_CONNECTION_ID;
}
