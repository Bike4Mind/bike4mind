export type SettleableFunctionCall = { name?: string; creditsUsed?: number };

/**
 * Assign each tool call its own reserved credits for end-of-quest settlement.
 *
 * `toolCreditsMap` holds a per-name queue of charges in call order (see
 * ToolBuilder.reserveToolCredits): a tool invoked more than once in a turn - two
 * music_generation tracks, several image_generation renders - reserves one entry per
 * call. Walking the calls in order and shifting the next charge off the matching queue
 * bills the sum of every call. The previous behavior stamped the queue's last value onto
 * every same-named call, so two calls settled at 2x the later call's cost instead of
 * cost1 + cost2.
 *
 * When a call reserved nothing (a failed music_generation returns before onFinish, so no
 * charge is queued) the queue can be shorter than the matching calls; the leftover calls
 * simply keep their existing creditsUsed. Only the total is authoritative downstream, so
 * an in-order gap never changes what is billed.
 *
 * Per-call attribution is best-effort: charges are dequeued in reservation (completion)
 * order while functionCalls is in issue order, so under parallel tool execution two
 * same-name calls can swap which per-call creditsUsed they carry. Only the total is read
 * for billing (ChatCompletionProcess sums functionCalls[].creditsUsed), so the swap is
 * cosmetic; removing it entirely would mean keying reservations by the tool-call id,
 * which is not threaded through the onToolStart/onToolFinish surface today.
 */
export function settleToolCallCredits<T extends SettleableFunctionCall>(
  functionCalls: T[],
  toolCreditsMap: Map<string, number[]>
): T[] {
  // Copy the queues so the shared map is left intact for any later read.
  const queues = new Map(Array.from(toolCreditsMap.entries()).map(([name, charges]) => [name, [...charges]]));
  return functionCalls.map(fc => {
    const queue = queues.get(fc.name || '');
    if (queue && queue.length > 0) {
      return { ...fc, creditsUsed: queue.shift() };
    }
    return fc;
  });
}
