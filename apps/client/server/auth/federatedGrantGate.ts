import { oauthGrantRepository } from '@bike4mind/database/auth';

export interface FederatedGrantRejection {
  status: 403 | 503;
  error: 'access_denied' | 'temporarily_unavailable';
  error_description: string;
}

interface GrantGateLogger {
  warn: (message: string) => void;
}

/**
 * Grant gate (SECURITY) for the federated user-pays surfaces - the AI-token exchange
 * (pages/api/oauth/ai-token.ts) and the identified embed session mint
 * (pages/api/embed/session.ts). Shared so both surfaces enforce one rule.
 *
 * Relying-party clients only. Requires the durable (user, client) authorization grant
 * recorded by the authorize flow (code.ts), AND that the grant covers every scope being
 * minted. Closes two holes:
 *   (a) a pool-signed token - including a forged identities[] entry from a compromised pool -
 *       for a user who never authorized this client. The pool cannot forge a B4M grant.
 *   (b) a grant that covers only identity scopes (openid/email/profile) being treated as
 *       authorization for a spend-authorizing scope.
 *
 * A first-party / pre-existing federated client is trusted (B4M controls the pool) and never
 * went through code.ts's consent flow, so it has no grant row and is exempt.
 *
 * Defaults to GRACE (log-only): a server-to-server exchange may present a token minted before
 * grants existed. Flip enforcement per stage with OAUTH_AI_TOKEN_ENFORCE_GRANT=true (plumbed
 * through deploy-contract.json + infra/web.ts). A surface with no pre-grant tokens to
 * migrate passes `enforce: true` to skip grace entirely.
 *
 * @returns null when the mint may proceed, else the rejection to send.
 */
export async function checkFederatedGrant(args: {
  client: { clientType?: string };
  clientId: string;
  userId: string;
  scopes: readonly string[];
  logger: GrantGateLogger;
  logTag: string;
  enforce?: boolean;
}): Promise<FederatedGrantRejection | null> {
  const { client, clientId, userId, scopes, logger, logTag } = args;
  if (client.clientType !== 'relying-party') return null;

  const enforce = args.enforce ?? process.env.OAUTH_AI_TOKEN_ENFORCE_GRANT === 'true';
  let grant: Awaited<ReturnType<typeof oauthGrantRepository.findGrant>> | undefined;
  let lookupFailed = false;
  try {
    grant = await oauthGrantRepository.findGrant(userId, clientId);
  } catch (err) {
    lookupFailed = true;
    logger.warn(`[${logTag}] grant lookup failed for user ${userId} via client ${clientId}: ${String(err)}`);
  }

  const uncovered = grant ? scopes.filter(s => !(grant.scopes ?? []).includes(s)) : [];

  if (enforce) {
    // Fail closed: an unreadable grant is UNKNOWN, not absent. Minting anyway would defeat the
    // gate on exactly the transient error an attacker could induce. 503 so the caller retries.
    if (lookupFailed) {
      return {
        status: 503,
        error: 'temporarily_unavailable',
        error_description: 'Grant lookup failed; cannot verify authorization',
      };
    }
    if (!grant) {
      return { status: 403, error: 'access_denied', error_description: 'User has not authorized this client' };
    }
    if (uncovered.length > 0) {
      return {
        status: 403,
        error: 'access_denied',
        error_description: `User has not authorized the following scope(s) for this client: ${uncovered.join(' ')}`,
      };
    }
    return null;
  }

  if (!lookupFailed) {
    if (!grant) {
      logger.warn(
        `[${logTag}] would-reject: no grant for user ${userId} via client ${clientId} ` +
          `(grace mode; set OAUTH_AI_TOKEN_ENFORCE_GRANT=true to enforce)`
      );
    } else if (uncovered.length > 0) {
      logger.warn(
        `[${logTag}] would-reject: grant for user ${userId} via client ${clientId} lacks ` +
          `scope(s): ${uncovered.join(' ')} (grace mode; set OAUTH_AI_TOKEN_ENFORCE_GRANT=true to enforce)`
      );
    }
  }
  return null;
}
