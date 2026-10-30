const verifiedRequests = new WeakSet<object>();

export const wasTurnstileVerified = (request: object): true | null => (verifiedRequests.has(request) ? true : null);

/** Accept only a server verification result or a claim from verified, browser-bound signed state. */
export function recordTurnstileVerification(request: object, verified: boolean): void {
  if (verified) verifiedRequests.add(request);
  else verifiedRequests.delete(request);
}
