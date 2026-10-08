import { z } from 'zod';
import { ApiKeyScope, type IUserDocument } from '@bike4mind/common';
import { oauthClientRepository, userRepository, type IOAuthClientDocument } from '@bike4mind/database/auth';
import { assertAccountStateUsable } from '@server/cli/auth';
import { hasAcceptedPolicy } from '@server/auth/consentGate';
import { checkFederatedGrant } from '@server/auth/federatedGrantGate';
import { verifyFederatedIdToken, FederatedIdTokenError } from '@server/auth/verifyFederatedIdToken';

/**
 * Identified embed mode: the host site has already signed its user in, and its backend
 * hands that identity to the embed instead of the widget minting an anonymous session.
 *
 * The handoff reuses the federated user-pays trust model of the AI-token exchange
 * (pages/api/oauth/ai-token.ts) rather than growing a second one: the host authenticates
 * as an OAuth client with `federatedIdp` configured, presents an ID token for its user,
 * and the same client-scope, grant and consent gates apply. The scope checked is
 * `ai:generate`, because an identified session spends the user's own credits.
 *
 * Two things are stricter than ai-token, because this surface is new and has no legacy
 * callers: the embed key must list the client in `identifiedClientIds` (the key owner's
 * opt-in, which binds the client to the key's tenant), and the grant gate is always
 * enforced rather than graced.
 */

export const IdentifiedEmbedMintSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  id_token: z.string().min(1),
});

export type IdentifiedEmbedMint = z.infer<typeof IdentifiedEmbedMintSchema>;

export interface IdentifiedEmbedRejection {
  status: 401 | 403 | 503;
  error: string;
  error_description: string;
}

type Rejected = { rejection: IdentifiedEmbedRejection };

const IDENTIFIED_EMBED_SCOPES = [ApiKeyScope.AI_GENERATE] as const;

interface EmbedLogger {
  warn: (message: string) => void;
}

function clientNotEnabled(): Rejected {
  return {
    rejection: {
      status: 403,
      error: 'access_denied',
      error_description: 'Client is not enabled for identified sessions on this embed key',
    },
  };
}

function clientNotFederated(): Rejected {
  return {
    rejection: {
      status: 403,
      error: 'access_denied',
      error_description: 'Client is not configured for federated identity',
    },
  };
}

/** Client-side gates shared by the mint and the per-turn re-check. */
async function checkClientAuthorizesUser(args: {
  client: Pick<IOAuthClientDocument, 'clientType' | 'federatedIdp' | 'allowedScopes'>;
  clientId: string;
  userId: string;
  logger: EmbedLogger;
}): Promise<Rejected | null> {
  const { client, clientId, userId, logger } = args;
  if (!client.federatedIdp) return clientNotFederated();
  const missingScopes = IDENTIFIED_EMBED_SCOPES.filter(s => !(client.allowedScopes ?? []).includes(s));
  if (missingScopes.length > 0) {
    return {
      rejection: {
        status: 403,
        error: 'invalid_scope',
        error_description: `Scopes not registered for this client: ${missingScopes.join(' ')}`,
      },
    };
  }
  const grantRejection = await checkFederatedGrant({
    client,
    clientId,
    userId,
    scopes: IDENTIFIED_EMBED_SCOPES,
    logger,
    logTag: 'EMBED_SESSION',
    enforce: true,
  });
  return grantRejection ? { rejection: grantRejection } : null;
}

/**
 * Resolve the B4M user an identified embed session runs as, at mint time.
 * @param allowedClientIds the embed key's `identifiedClientIds`.
 * @returns the user id, or the rejection to send (never throws for a bad credential).
 */
export async function resolveIdentifiedEmbedUser(
  mint: IdentifiedEmbedMint,
  allowedClientIds: readonly string[] | undefined,
  logger: EmbedLogger
): Promise<{ userId: string } | Rejected> {
  const { client_id, client_secret, id_token } = mint;
  // Before the secret check, so a client the key never opted into costs no bcrypt.
  if (!allowedClientIds?.includes(client_id)) return clientNotEnabled();

  const client = await oauthClientRepository.verifyClientSecret(client_id, client_secret);
  if (!client) {
    return {
      rejection: { status: 401, error: 'invalid_client', error_description: 'Unknown client or invalid client_secret' },
    };
  }
  if (!client.federatedIdp) return clientNotFederated();

  let userId: string;
  try {
    ({ b4mUserId: userId } = await verifyFederatedIdToken(id_token, client.federatedIdp));
  } catch (err) {
    if (err instanceof FederatedIdTokenError) {
      logger.warn(`[EMBED_SESSION] ID token rejected for client ${client_id}: ${err.message}`);
      return { rejection: { status: 401, error: 'invalid_grant', error_description: 'Invalid ID token' } };
    }
    throw err;
  }
  if (client.federatedIdp.subjectSource !== 'sub') {
    logger.warn(
      `[EMBED_SESSION] would-reject: client ${client_id} uses the self-asserted ` +
        "'identities' subject source; set OAUTH_AI_TOKEN_REQUIRE_SUB=true to enforce subjectSource='sub'"
    );
  }

  const clientRejection = await checkClientAuthorizesUser({ client, clientId: client_id, userId, logger });
  if (clientRejection) return clientRejection;

  const usable = await loadIdentifiedEmbedUser(userId);
  if ('rejection' in usable) return usable;
  return { userId };
}

/**
 * Re-authorize an identified session on every use (chat turn, history read/erase), so a
 * revoked grant, a deactivated or de-federated client, the key owner dropping the client,
 * a ban, or a withdrawn policy acceptance takes effect within the session rather than at
 * token expiry.
 */
export async function reauthorizeIdentifiedSession(args: {
  userId: string;
  clientId: string;
  allowedClientIds: readonly string[] | undefined;
  logger: EmbedLogger;
}): Promise<{ user: IUserDocument } | Rejected> {
  const { userId, clientId, allowedClientIds, logger } = args;
  if (!allowedClientIds?.includes(clientId)) return clientNotEnabled();

  const client = await oauthClientRepository.findByClientId(clientId);
  if (!client) {
    return { rejection: { status: 401, error: 'invalid_client', error_description: 'Client is no longer active' } };
  }
  const clientRejection = await checkClientAuthorizesUser({ client, clientId, userId, logger });
  if (clientRejection) return clientRejection;

  return loadIdentifiedEmbedUser(userId);
}

/** Load an identified embed user and apply the account and consent gates. */
export async function loadIdentifiedEmbedUser(userId: string): Promise<{ user: IUserDocument } | Rejected> {
  const user = await userRepository.findById(userId);
  if (!user) {
    return {
      rejection: {
        status: 401,
        error: 'invalid_grant',
        error_description: 'Token subject does not resolve to a B4M user',
      },
    };
  }
  try {
    assertAccountStateUsable(user);
  } catch (err) {
    return {
      rejection: {
        status: 403,
        error: 'access_denied',
        error_description: err instanceof Error ? err.message : 'Account is not usable',
      },
    };
  }
  // The identified user's own acceptance is the consent of record: they have a B4M
  // account, so the embed owner's acceptance cannot stand in for theirs.
  if (!hasAcceptedPolicy(user)) {
    return { rejection: { status: 403, error: 'access_denied', error_description: 'Policy acceptance required' } };
  }
  return { user };
}
