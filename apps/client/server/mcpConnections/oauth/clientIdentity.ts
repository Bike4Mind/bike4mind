import {
  BadRequestError,
  parseCustomMcpPresetClients,
  type IMcpConnectionDocument,
  type McpOAuthClientMode,
} from '@bike4mind/common';
import { adminSettingsRepository, mcpOAuthClientRegistrationRepository } from '@bike4mind/database';
import {
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

const confidential = (clientId: string, clientSecret?: string): RemoteMcpOAuthClient => ({
  clientId,
  clientSecret,
  tokenEndpointAuthMethod: clientSecret ? 'client_secret_post' : 'none',
});

/** The admin-registered client for a catalog preset, if any. A malformed setting is logged, never silent. */
export async function presetClientFor(presetId: string | undefined): Promise<ManualOAuthClient | undefined> {
  if (!presetId) return undefined;
  const raw = getSettingsValue(
    'customMcpPresetClients',
    await getSettingsMap({ adminSettings: adminSettingsRepository }),
    ''
  );
  const parsed = parseCustomMcpPresetClients(raw);
  if (!parsed.ok) console.warn(`[mcpOAuth] customMcpPresetClients is unusable: ${parsed.error}`);
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
  if (preset) return { mode: 'preregistered', client: confidential(preset.clientId, preset.clientSecret) };

  if (options.manual) {
    const manualClientIdEnc = encryptToken(options.manual.clientId);
    if (!manualClientIdEnc) throw new Error('Client id encryption returned nothing');
    return {
      mode: 'manual',
      client: confidential(options.manual.clientId, options.manual.clientSecret),
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
  const row = await mcpOAuthClientRegistrationRepository.upsert({
    issuer: discovery.issuer,
    redirectUri: options.redirectUri,
    clientId: registered.clientId,
    ...(registered.clientSecret ? { clientSecretEnc: encryptToken(registered.clientSecret) ?? undefined } : {}),
    ...(registered.clientSecretExpiresAt ? { clientSecretExpiresAt: registered.clientSecretExpiresAt } : {}),
    tokenEndpointAuthMethod: registered.tokenEndpointAuthMethod,
  });
  return {
    mode: 'dcr',
    client: { ...registered, clientSecret: registered.clientSecret },
    clientRegistrationId: row.id,
  };
}

/** The client a connection signed in with, rebuilt from what it stored, for exchange, refresh and revoke. */
export async function loadConnectionClient(
  connection: Pick<IMcpConnectionDocument, 'presetId' | 'auth'>,
  redirect: string
): Promise<RemoteMcpOAuthClient | undefined> {
  const oauth = connection.auth.oauth;
  if (!oauth) return undefined;
  switch (oauth.clientMode) {
    case 'preregistered': {
      const preset = await presetClientFor(connection.presetId);
      return preset && confidential(preset.clientId, preset.clientSecret);
    }
    case 'manual': {
      const clientId = decryptToken(oauth.manualClientIdEnc);
      return clientId ? confidential(clientId, decryptToken(oauth.manualClientSecretEnc) ?? undefined) : undefined;
    }
    case 'cimd':
      return { clientId: clientMetadataUrl(), tokenEndpointAuthMethod: 'none' };
    case 'dcr': {
      const row = await mcpOAuthClientRegistrationRepository.findByIssuerAndRedirect(oauth.issuer, redirect);
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
