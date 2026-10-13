import type { AuthOrigin } from '@bike4mind/common';
import type { ApiKeyInfo } from '@server/cli/auth';

/** How a request-driven turn was authenticated, as handed to invoke() / process() / the tool builder. */
export type TurnAuth = { authOrigin: Extract<AuthOrigin, 'session' | 'apiKey'>; apiKeyId?: string };

/**
 * The turn auth of a request that already passed the API's auth middleware: a `b4m_live_` key when
 * it set `apiKeyInfo`, otherwise the signed-in session. Both halves come from the same field so a
 * door cannot forward one without the other (see ToolContext.authOrigin). Only for doors behind
 * that middleware - a door that runs tools any other way (queue, schedule, Slack, embed) decides
 * its origin itself.
 */
export function requestTurnAuth(req: { apiKeyInfo?: Pick<ApiKeyInfo, 'keyId'> }): TurnAuth {
  if (!req.apiKeyInfo) return { authOrigin: 'session' };
  // Keyed on the credential's presence, not its id: a key turn must never read as a session.
  if (!req.apiKeyInfo.keyId) throw new Error('API key credential has no key id');
  return { authOrigin: 'apiKey', apiKeyId: req.apiKeyInfo.keyId };
}

/**
 * A persisted agent run's turn auth, as its tools and its child/DAG-node runs see it. A run started
 * before `authOrigin` was persisted keeps a key turn when it carries a key id and is otherwise
 * failed closed to `internal`, rather than read as a session.
 */
export function executionTurnAuth(execution: { authOrigin?: AuthOrigin; apiKeyId?: string }): {
  authOrigin: AuthOrigin;
  apiKeyId?: string;
} {
  const authOrigin = execution.authOrigin ?? (execution.apiKeyId ? 'apiKey' : 'internal');
  return execution.apiKeyId ? { authOrigin, apiKeyId: execution.apiKeyId } : { authOrigin };
}
