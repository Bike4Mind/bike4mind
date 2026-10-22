import type { ApiKeyScope } from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/utils';

/**
 * The no-escalation rule shared by create, rotate and callback-secret rotation: an API-key caller
 * may only mint or rotate a credential whose scopes it literally holds.
 *
 * Containment is LITERAL and deliberately does not treat `admin:*` as a superset of other scopes
 * (unlike hearthWire's grant check): a caller must prove it holds every target scope, not merely a
 * wildcard that would expand to them. `callerScopes` present (even the empty array) means an API-key
 * caller, so an empty array DENIES every scoped target rather than reading as "unrestricted". Only an
 * absent `callerScopes` (a browser/JWT caller, who already holds the whole account) skips the check.
 */
export function assertNoScopeEscalation(
  callerScopes: readonly ApiKeyScope[] | undefined,
  targetScopes: readonly ApiKeyScope[],
  message: string
): void {
  if (!callerScopes) return;
  if (targetScopes.some(scope => !callerScopes.includes(scope))) {
    throw new ForbiddenError(message);
  }
}
