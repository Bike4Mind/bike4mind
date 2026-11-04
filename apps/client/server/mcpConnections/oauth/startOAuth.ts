import { createHash, randomBytes } from 'crypto';
import { BadGatewayError, ConflictError, MCP_CONNECTION_LIMITS, NotFoundError } from '@bike4mind/common';
import { mcpConnectionRepository, mcpOAuthPendingRepository } from '@bike4mind/database';
import {
  RemoteMcpError,
  RemoteMcpOAuthError,
  buildRemoteMcpAuthorizationUrl,
  discoverRemoteMcpOAuth,
} from '@bike4mind/mcp/remote';
import { decryptToken, encryptToken } from '@bike4mind/server-utils/security/tokenEncryption';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { assertPolicyAllows, audit, userOwner, type ConnectionActor } from '../connectionService';
import type { CustomMcpContext } from '../customMcpAccess';
import { cleanScope } from '../invokeRemoteMcp';
import { loadConnectionClient, resolveOAuthClient, type ManualOAuthClient } from './clientIdentity';
import { withOAuthFetch } from './oauthFetch';
import { redirectUri } from './redirectUri';
import { revokeConnectionGrant } from './revoke';

export const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

export interface StartOAuthOptions {
  /** A client the user supplied for a server with no registration; write-only, stored encrypted. */
  manual?: ManualOAuthClient;
  /** Tests pass the loopback fetch; production uses the SSRF-pinned one. */
  fetchFn?: FetchLike;
}

/** Scopes from the 401 challenge, else what the server advertises, each cleaned and capped. */
function chooseScopes(challengeScope: string | undefined, supported: string[]): string[] {
  const requested = challengeScope?.split(/\s+/).filter(Boolean) ?? supported;
  const cleaned = requested.map(scope => cleanScope(scope)).filter((scope): scope is string => Boolean(scope));
  return [...new Set(cleaned)].slice(0, MCP_CONNECTION_LIMITS.maxScopes);
}

/**
 * Begins sign-in: discovers the server's authorization server, picks a client, records the OAuth
 * configuration on the connection, stores the single-use PKCE state, and returns the URL to send the
 * user to. Only the hash of `state` and the encrypted verifier are stored.
 */
export async function startUserConnectionOAuth(
  actor: ConnectionActor,
  context: CustomMcpContext,
  id: string,
  options: StartOAuthOptions = {}
): Promise<{ authorizationUrl: string }> {
  const owner = userOwner(actor.id);
  const connection = await mcpConnectionRepository.findByIdWithCredentials(id, owner);
  if (!connection) throw new NotFoundError('Connection not found');
  if (connection.auth.kind !== 'none' && connection.auth.kind !== 'oauth') {
    throw new ConflictError('This connection uses an API key', { code: 'not_oauth' });
  }
  assertPolicyAllows(actor, context, connection, 'oauth', connection.displayUrl, 'oauth_started');
  const auditEntry = audit(actor, 'oauth_started', connection);

  try {
    const serverUrl = decryptToken(connection.urlEnc) ?? '';
    const callback = redirectUri();
    const stored = connection.auth.oauth;
    const hadGrant = Boolean(stored?.accessTokenEnc || stored?.refreshTokenEnc);
    const previous = stored ? await loadConnectionClient(connection) : undefined;
    const storedManual = !options.manual && stored?.clientMode === 'manual' ? previous : undefined;

    const { discovery, resolved, scopes, authorization } = await withOAuthFetch(
      context.network,
      options.fetchFn,
      async fetchFn => {
        const found = await discoverRemoteMcpOAuth(serverUrl, {
          resourceMetadataUrl: connection.authChallenge?.resourceMetadataUrl,
          fetchFn,
          network: context.network,
        });
        const chosen = chooseScopes(connection.authChallenge?.scope, found.scopesSupported);
        const client = await resolveOAuthClient({
          connection,
          discovery: found,
          redirectUri: callback,
          clientName: 'Bike4Mind',
          scope: chosen.join(' ') || undefined,
          manual:
            options.manual ??
            (storedManual && { clientId: storedManual.clientId, clientSecret: storedManual.clientSecret }),
          fetchFn,
        });
        const state = randomBytes(32).toString('base64url');
        const built = await buildRemoteMcpAuthorizationUrl(found, {
          client: client.client,
          redirectUri: callback,
          state,
          scopes: chosen,
        });
        return { discovery: found, resolved: client, scopes: chosen, authorization: { ...built, state } };
      }
    );

    if (
      hadGrant &&
      (stored?.issuer !== discovery.issuer ||
        stored?.clientMode !== resolved.mode ||
        stored?.clientRegistrationId !== resolved.clientRegistrationId ||
        previous?.clientId !== resolved.client.clientId)
    ) {
      // The stored grant belongs to another server or client, and the new configuration would pair it with
      // the wrong one on the next refresh or revoke. End it now rather than leave that for an abandoned sign-in.
      await revokeConnectionGrant(connection, context.network, options.fetchFn);
      await mcpConnectionRepository.clearOAuthTokens(id, owner);
    }

    const configured = await mcpConnectionRepository.setOAuthConfig(id, owner, {
      resource: discovery.resource,
      resourceMetadataUrl: discovery.resourceMetadataUrl,
      issuer: discovery.issuer,
      authorizationServerUrl: discovery.authorizationServerUrl,
      tokenEndpoint: discovery.tokenEndpoint,
      revocationEndpoint: discovery.revocationEndpoint,
      registrationEndpoint: discovery.registrationEndpoint,
      tokenEndpointAuthMethod: resolved.client.tokenEndpointAuthMethod,
      issParameterSupported: discovery.issParameterSupported,
      scopes,
      clientMode: resolved.mode,
      clientRegistrationId: resolved.clientRegistrationId,
      manualClientIdEnc: resolved.manualClientIdEnc,
      manualClientSecretEnc: resolved.manualClientSecretEnc,
    });
    if (!configured) throw new NotFoundError('Connection not found');

    const codeVerifierEnc = encryptToken(authorization.codeVerifier);
    if (!codeVerifierEnc) throw new Error('Code verifier encryption returned nothing');
    await mcpOAuthPendingRepository.create({
      stateHash: sha256Hex(authorization.state),
      userId: actor.id,
      connectionId: id,
      codeVerifierEnc,
      redirectUri: callback,
      issuer: discovery.issuer,
      resource: discovery.resource,
      scopes,
    });
    auditEntry.success({ clientMode: resolved.mode });
    return { authorizationUrl: authorization.authorizationUrl };
  } catch (error) {
    if (error instanceof RemoteMcpOAuthError || error instanceof RemoteMcpError) {
      auditEntry.failure(error.code);
      throw new BadGatewayError('The server could not start sign-in', { code: 'oauth_discovery_failed' });
    }
    auditEntry.failure(error instanceof Error && 'additionalInfo' in error ? 'refused' : 'internal_error');
    throw error;
  }
}
