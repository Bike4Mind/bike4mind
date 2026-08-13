/**
 * Per-collection Mongo projection exclusions for the WS data-subscribe handler.
 *
 * quests: a quest's promptMeta.functionCalls[].returnValue can hold verbatim tool output
 * (private corpus chunks, file contents - see redactFunctionCallsForViewer in @bike4mind/common).
 * This subscription's scope is broader than the sharing-based read check elsewhere (it admits
 * any isGlobalRead session via accessibleBy), so it is stripped at the query-projection level
 * here rather than trusting every future subscriber to redact it themselves.
 */
export function resolveFieldLimits(
  collectionName: string,
  questCollectionName: string
): Record<string, boolean> | undefined {
  if (collectionName === 'users') {
    return { password: false, stripeCustomerId: false, resetPasswordToken: false };
  }
  if (collectionName === questCollectionName) {
    return { 'promptMeta.functionCalls.returnValue': false, 'promptMeta.functionCalls.error': false };
  }
  return undefined;
}
