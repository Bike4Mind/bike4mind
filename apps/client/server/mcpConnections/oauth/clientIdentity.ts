import {
  BadRequestError,
  parseCustomMcpPresetClients,
  type IMcpConnectionDocument,
  type McpOAuthClientMode,
} from '@bike4mind/common';
import { adminSettingsRepository, mcpOAuthClientRegistrationRepository } from '@bike4mind/database';
import {
  chooseClientAuthMethod,
  registerRemoteMcpClient,
  type RemoteMcpOAuthClient,
  type RemoteMcpOAuthDiscovery,
} from '@bike4mind/mcp/remote';
import { decryptToken, encryptToken } from '@bike4mind/server-utils/security/tokenEncryption';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isLocalAppUrl } from '@server/utils/validators';
import { clientMetadataUrl } from './redirectUri';

export interface ManualOAuthClient {
  clientId: string;
  clientSecret?: string;
}

/** A client plus what the connection must store to find it again. */
export interface ResolvedOAuthClient {
  mode: McpOAuthClientMode;
  client: RemoteMcpOAuthClient;
  clientRegistrationId?: string;
  manualClientIdEnc?: string;
  manualClientSecretEnc?: string;
}

/**
 * A dynamically registered client the server answered `invalid_client` for is gone there: drop the shared row so the
 * next sign-in for that issuer registers afresh instead of reusing it forever.
 */
export async function dropRejectedRegistration(
  connection: Pick<IMcpConnectionDocument, 'auth'>,
  error: unknown
): Promise<void> {
  const oauth = connection.auth.oauth;
  const code = (error as { cause?: { errorCode?: string } } | undefined)?.cause?.errorCode;
  if (oauth?.clientMode !== 'dcr' || !oauth.clientRegistrationId || code !== 'invalid_client') return;
  await mcpOAuthClientRegistrationRepository.delete(oauth.clientRegistrationId).catch(() => undefined);
}

const confidential = (clientId: string, clientSecret: string | undefined, supportedMethods: string[]) => ({
  clientId,
  clientSecret,
  tokenEndpointAuthMethod: chooseClientAuthMethod(supportedMethods, Boolean(clientSecret)),
});

/** The admin-registered client for a catalog preset, if any. A malformed setting is logged, never silent, and never quoted. */
export async function presetClientFor(presetId: string | undefined): Promise<ManualOAuthClient | undefined> {
  if (!presetId) return undefined;
  const raw = getSettingsValue(
    'customMcpPresetClients',
    await getSettingsMap({ adminSettings: adminSettingsRepository }),
    ''
  );
  const parsed = parseCustomMcpPresetClients(raw);
  // The parser message can quote the value around the error, which holds client secrets: never log it.
  if (!parsed.ok) console.warn('[mcpOAuth] customMcpPresetClients is unusable (invalid JSON or shape)');
  return parsed.clients[presetId];
}

function cimdUsable(discovery: RemoteMcpOAuthDiscovery): boolean {
  // The authorization server must fetch the client metadata URL, so a localhost app cannot use it.
  return discovery.cimdSupported && !isLocalAppUrl() && (process.env.APP_URL ?? '').startsWith('https://');
}

/**
 * Picks the client for a new authorization: the admin's preset client, then a client the user supplied,
 * then a metadata-document client, then a dynamically registered one (reused per issuer and redirect URI).
 */
export async function resolveOAuthClient(options: {
  connection: Pick<IMcpConnectionDocument, 'presetId'>;
  discovery: RemoteMcpOAuthDiscovery;
  redirectUri: string;
  clientName: string;
  scope?: string;
  manual?: ManualOAuthClient;
  fetchFn: FetchLike;
}): Promise<ResolvedOAuthClient> {
  const { discovery, connection } = options;
  const preset = await presetClientFor(connection.presetId);
  const supported = discovery.tokenEndpointAuthMethodsSupported;
  if (preset) {
    return { mode: 'preregistered', client: confidential(preset.clientId, preset.clientSecret, supported) };
  }

  if (options.manual) {
    const manualClientIdEnc = encryptToken(options.manual.clientId);
    if (!manualClientIdEnc) throw new Error('Client id encryption returned nothing');
    return {
      mode: 'manual',
      client: confidential(options.manual.clientId, options.manual.clientSecret, supported),
      manualClientIdEnc,
      manualClientSecretEnc: encryptToken(options.manual.clientSecret) ?? undefined,
    };
  }

  if (cimdUsable(discovery)) {
    return { mode: 'cimd', client: { clientId: clientMetadataUrl(), tokenEndpointAuthMethod: 'none' } };
  }

  if (!discovery.registrationEndpoint) {
    throw new BadRequestError('This server needs a client id to sign in', { code: 'client_required' });
  }
  const existing = await mcpOAuthClientRegistrationRepository.findByIssuerAndRedirect(
    discovery.issuer,
    options.redirectUri
  );
  if (existing) {
    return {
      mode: 'dcr',
      client: {
        clientId: existing.clientId,
        clientSecret: decryptToken(existing.clientSecretEnc) ?? undefined,
        tokenEndpointAuthMethod: existing.tokenEndpointAuthMethod,
      },
      clientRegistrationId: existing.id,
    };
  }
  const registered = await registerRemoteMcpClient(discovery, {
    redirectUri: options.redirectUri,
    clientName: options.clientName,
    scope: options.scope,
    fetchFn: options.fetchFn,
  });
  // Insert-if-absent: of two first starts that both registered, the stored row wins and both use it.
  const row = await mcpOAuthClientRegistrationRepository.registerIfAbsent({
    issuer: discovery.issuer,
    redirectUri: options.redirectUri,
    clientId: registered.clientId,
    ...(registered.clientSecret ? { clientSecretEnc: encryptToken(registered.clientSecret) ?? undefined } : {}),
    ...(registered.clientSecretExpiresAt ? { clientSecretExpiresAt: registered.clientSecretExpiresAt } : {}),
    tokenEndpointAuthMethod: registered.tokenEndpointAuthMethod,
  });
  if (!row) throw new Error('The client registration was not stored');
  return {
    mode: 'dcr',
    client: {
      clientId: row.clientId,
      clientSecret: decryptToken(row.clientSecretEnc) ?? undefined,
      tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
    },
    clientRegistrationId: row.id,
  };
}

/** The method chosen at sign-in and stored with the connection; derived the same way if an older row has none. */
const storedMethod = (clientId: string, clientSecret: string | undefined, method: string | undefined) => ({
  clientId,
  clientSecret,
  tokenEndpointAuthMethod: method ?? chooseClientAuthMethod([], Boolean(clientSecret)),
});

/** The client a connection signed in with, rebuilt from what it stored, for exchange, refresh and revoke. */
export async function loadConnectionClient(
  connection: Pick<IMcpConnectionDocument, 'presetId' | 'auth'>
): Promise<RemoteMcpOAuthClient | undefined> {
  const oauth = connection.auth.oauth;
  if (!oauth) return undefined;
  switch (oauth.clientMode) {
    case 'preregistered': {
      const preset = await presetClientFor(connection.presetId);
      return preset && storedMethod(preset.clientId, preset.clientSecret, oauth.tokenEndpointAuthMethod);
    }
    case 'manual': {
      const clientId = decryptToken(oauth.manualClientIdEnc);
      return clientId
        ? storedMethod(clientId, decryptToken(oauth.manualClientSecretEnc) ?? undefined, oauth.tokenEndpointAuthMethod)
        : undefined;
    }
    case 'cimd':
      return { clientId: clientMetadataUrl(), tokenEndpointAuthMethod: 'none' };
    case 'dcr': {
      // By the id this connection signed in with: a later re-registration must not swap its client.
      const row = oauth.clientRegistrationId
        ? await mcpOAuthClientRegistrationRepository.findByIdWithCredentials(oauth.clientRegistrationId)
        : null;
      return row
        ? {
            clientId: row.clientId,
            clientSecret: decryptToken(row.clientSecretEnc) ?? undefined,
            tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
          }
        : undefined;
    }
  }
}
