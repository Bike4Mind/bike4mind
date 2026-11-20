/**
 * Ordered forwarding of a subagent's streaming text deltas.
 *
 * Kept in its own module so the ordering can be unit-tested without dragging in
 * the executor's Mongo/AWS/SST deps.
 */

export interface SubagentTextDeltaArgs {
  childExecutionId: string;
  agentName: string;
  iteration: number;
  delta: string;
}

export interface SubagentTextDeltaSender {
  /** The tracker `onTextDelta` handler. */
  send: (args: SubagentTextDeltaArgs) => Promise<void>;
  /** Resolves once every delta queued so far for this child has been sent (or failed). Never rejects. */
  flush: (childExecutionId: string) => Promise<void>;
}

/**
 * Each `sendWs` -> API Gateway postToConnection is its own async call, so frames fired
 * concurrently can arrive out of order and scramble the live text. Sends are chained per
 * child so each frame awaits the previous one, while parallel children do not serialize
 * against each other.
 *
 * `send` rejects if its own send fails (the orchestrator logs that), but a failed send
 * never breaks the chain for later deltas. Callers that emit a terminal event for the
 * child must `flush` first: the client clears its per-iteration text buffer on that event,
 * so a delta landing after it would resurrect stale text.
 */
export function createSubagentTextDeltaSender(
  sendFrame: (payload: SubagentTextDeltaArgs) => Promise<void>,
  maxChunkLength: number
): SubagentTextDeltaSender {
  const chains = new Map<string, Promise<unknown>>();

  const send = ({ childExecutionId, agentName, iteration, delta }: SubagentTextDeltaArgs) => {
    const tail = chains.get(childExecutionId) ?? Promise.resolve();
    const run = tail.then(async () => {
      for (let offset = 0; offset < delta.length; offset += maxChunkLength) {
        await sendFrame({
          childExecutionId,
          agentName,
          iteration,
          delta: delta.slice(offset, offset + maxChunkLength),
        });
      }
    });
    const settled = run.catch(() => {});
    chains.set(childExecutionId, settled);
    // Drop the entry once this child's chain goes idle so the map cannot grow unbounded.
    void settled.then(() => {
      if (chains.get(childExecutionId) === settled) chains.delete(childExecutionId);
    });
    return run;
  };

  const flush = async (childExecutionId: string) => {
    await chains.get(childExecutionId);
  };

  return { send, flush };
}
