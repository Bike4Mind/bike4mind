import { BadGatewayError, BadRequestError, NotFoundError, type IMcpConnectionPublic } from '@bike4mind/common';
import { mcpConnectionRepository, mcpOAuthPendingRepository } from '@bike4mind/database';
import { RemoteMcpError, RemoteMcpOAuthError, exchangeRemoteMcpCode } from '@bike4mind/mcp/remote';
import { decryptToken, encryptToken } from '@bike4mind/server-utils/security/tokenEncryption';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { assertPolicyAllows, audit, toPublicView, userOwner, type ConnectionActor } from '../connectionService';
import type { CustomMcpContext } from '../customMcpAccess';
import { discoverConnectionTools } from '../discovery';
import type { InvokeRemoteMcpOptions } from '../invokeRemoteMcp';
import { dropRejectedRegistration, loadConnectionClient } from './clientIdentity';
import { withOAuthFetch } from './oauthFetch';
import { sha256Hex } from './startOAuth';

export interface CompleteOAuthParams {
  code: string;
  state: string;
  /** RFC 9207 issuer identifier from the authorization response, when the server sent one. */
  iss?: string;
}

/** Every state failure answers the same way, so a probe cannot tell unknown from used, expired or foreign. */
const invalidState = () => new BadRequestError('This sign-in link is no longer valid', { code: 'invalid_state' });

/**
 * Finishes sign-in for the session's user: consumes the single-use state, checks the issuer, exchanges
 * the code with the stored PKCE verifier, stores the encrypted tokens, then discovers the tools (which
 * marks the connection connected, tools pending review).
 */
export async function completeUserConnectionOAuth(
  actor: ConnectionActor,
  context: CustomMcpContext,
  params: CompleteOAuthParams,
  options: { fetchFn?: FetchLike; discovery?: InvokeRemoteMcpOptions } = {}
): Promise<IMcpConnectionPublic> {
  const pending = await mcpOAuthPendingRepository.consume(sha256Hex(params.state), actor.id);
  if (!pending) throw invalidState();

  const owner = userOwner(actor.id);
  const connection = await mcpConnectionRepository.findByIdWithCredentials(pending.connectionId, owner);
  const oauth = connection?.auth.kind === 'oauth' ? connection.auth.oauth : undefined;
  if (!connection || !oauth || oauth.issuer !== pending.issuer) throw invalidState();

  assertPolicyAllows(actor, context, connection, 'oauth', connection.displayUrl, 'oauth_completed');
  const auditEntry = audit(actor, 'oauth_completed', connection);

  // RFC 9207: an `iss` that is present must match, and one the server promised must be present.
  if ((params.iss !== undefined && params.iss !== oauth.issuer) || (oauth.issParameterSupported && !params.iss)) {
    auditEntry.failure('issuer_mismatch');
    throw invalidState();
  }

  try {
    const client = await loadConnectionClient(connection);
    const codeVerifier = decryptToken(pending.codeVerifierEnc);
    if (!client || !codeVerifier || !oauth.tokenEndpoint) {
      auditEntry.failure('client_unavailable');
      throw invalidState();
    }
    const tokens = await withOAuthFetch(context.network, options.fetchFn, fetchFn =>
      exchangeRemoteMcpCode(
        { ...oauth, tokenEndpoint: oauth.tokenEndpoint ?? '', resource: pending.resource },
        { client, code: params.code, codeVerifier, redirectUri: pending.redirectUri, fetchFn }
      )
    );

    const accessTokenEnc = encryptToken(tokens.accessToken);
    if (!accessTokenEnc) throw new Error('Access token encryption returned nothing');
    const stored = await mcpConnectionRepository.setInitialOAuthTokens(connection.id, owner, {
      accessTokenEnc,
      ...(tokens.refreshToken ? { refreshTokenEnc: encryptToken(tokens.refreshToken) ?? undefined } : {}),
      ...(tokens.expiresInSeconds ? { expiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000) } : {}),
      ...(tokens.scope ? { grantedScope: tokens.scope.slice(0, 1024) } : {}),
      tokenIssuer: oauth.issuer,
    });
    if (!stored) throw new NotFoundError('Connection not found');

    try {
      await discoverConnectionTools(connection.id, actor.id, { ...options.discovery, context });
    } catch (error) {
      // Recorded on the connection already; the user lands on it and sees the status.
      if (!(error instanceof RemoteMcpError)) throw error;
    }
    auditEntry.success();
    const reloaded = await mcpConnectionRepository.findByIdForOwner(connection.id, owner);
    if (!reloaded) throw new NotFoundError('Connection not found');
    return toPublicView(context, reloaded);
  } catch (error) {
    if (error instanceof RemoteMcpOAuthError) {
      await dropRejectedRegistration(connection, error);
      auditEntry.failure(error.code);
      throw new BadGatewayError('The server did not accept the sign-in', {
        code: error.code === 'token_unavailable' ? 'oauth_token_unavailable' : 'oauth_exchange_failed',
      });
    }
    if (!(error instanceof BadRequestError)) auditEntry.failure('internal_error');
    throw error;
  }
}
