/**
 * Map a raw execution error to a user-facing failure message. We must not leak internal details,
 * but a blanket "Agent execution failed" leaves users stuck on actionable causes like
 * billing or timeouts (e.g. an OpenAI 402 or a slow gpt-image-2 render). Only recognized,
 * non-sensitive categories get a specific message; anything else stays generic.
 *
 * Numeric HTTP status codes are matched on word boundaries so an unrelated error whose text merely
 * contains the digits (a port number, a byte count, a model id) is not misclassified.
 */
export function toUserFacingFailureMessage(errorMessage: string): string {
  const lower = errorMessage.toLowerCase();
  if (/\b402\b/.test(lower) || lower.includes('payment required') || lower.includes('insufficient credit')) {
    return 'Agent execution failed: the provider reported a billing/quota issue (402). Check that the account behind this model has active billing and is verified for it, or try a different model.';
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('etimedout')) {
    return 'Agent execution failed: the task took too long and timed out. Try a faster model or a smaller request.';
  }
  if (/\b429\b/.test(lower) || lower.includes('rate limit')) {
    return 'Agent execution failed: the provider rate limit was exceeded (429). Please wait a moment and try again.';
  }
  if (
    /\b401\b/.test(lower) ||
    /\b403\b/.test(lower) ||
    lower.includes('access denied') ||
    lower.includes('unauthorized')
  ) {
    return 'Agent execution failed: the provider denied access (auth error). The API key may be missing, invalid, or lack access to this model.';
  }
  return 'Agent execution failed';
}
