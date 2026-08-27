/**
 * Per-collection Mongo projection exclusions for the WS data-subscribe handler.
 *
 * quests: a quest's promptMeta.functionCalls[].returnValue can hold verbatim tool output
 * (private corpus chunks, file contents - see redactFunctionCallsForViewer in @bike4mind/common).
 * This subscription's scope is broader than the sharing-based read check elsewhere (it admits
 * any isGlobalRead session via accessibleBy), so it is stripped at the query-projection level
 * here rather than trusting every future subscriber to redact it themselves. `isQuestOwner` skips
 * the exclusion for the session's own owner: the client cache merges a WS quest update as a
 * top-level spread (react-query.ts), so an unconditional exclusion replaced the owner's own
 * cached returnValue with nothing the moment any live update landed, not just a sharee's.
 */
export function resolveFieldLimits(
  collectionName: string,
  questCollectionName: string,
  isQuestOwner = false
): Record<string, boolean> | undefined {
  if (collectionName === 'users') {
    return { password: false, stripeCustomerId: false, resetPasswordToken: false };
  }
  if (collectionName === questCollectionName && !isQuestOwner) {
    return { 'promptMeta.functionCalls.returnValue': false, 'promptMeta.functionCalls.error': false };
  }
  return undefined;
}
