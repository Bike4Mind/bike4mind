import { Logger } from '@bike4mind/observability';
import { adminSettingsRepository } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { decryptToken } from '../../security/tokenEncryption';

const NOTION_REVOKE_URL = 'https://api.notion.com/v1/oauth/revoke';
// The revoke endpoint is documented only under this API version; the rest of the integration pins an older one.
const NOTION_REVOKE_VERSION = '2026-03-11';
const REVOKE_TIMEOUT_MS = 10_000;

export type NotionRevokeOutcome = 'revoked' | 'no_credential' | 'not_configured' | 'failed';

/**
 * Revoke a stored (encrypted) Notion access token at Notion, BEST EFFORT. Never throws, same contract
 * as revokeAtlassianGrant (../jira/revokeAtlassianGrant.ts). The client credentials are the admin
 * settings the connect flow uses (apps/client/server/integrations/notion/notionConfig.ts).
 */
export async function revokeNotionGrant(
  encryptedToken: string | null | undefined,
  context: string
): Promise<NotionRevokeOutcome> {
  if (!encryptedToken) return 'no_credential';

  try {
    const token = decryptToken(encryptedToken);
    if (!token) {
      Logger.warn('[notion] revoke skipped: stored credential decrypted to empty', { context });
      return 'no_credential';
    }

    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
    const clientId = getSettingsValue('notionClientId', settings);
    const clientSecret = getSettingsValue('notionClientSecret', settings);
    if (!clientId || !clientSecret) {
      Logger.warn('[notion] revoke skipped: OAuth client is not configured', { context });
      return 'not_configured';
    }

    const response = await fetch(NOTION_REVOKE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
        'Notion-Version': NOTION_REVOKE_VERSION,
      },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch (error) {
        Logger.warn('[notion] failed to release revoke response', { context, error });
      }
      Logger.warn('[notion] revoke failed', { context, status: response.status });
      return 'failed';
    }

    Logger.info('[notion] revoked token at Notion', { context });
    return 'revoked';
  } catch (e) {
    Logger.error('[notion] revoke failed - the token may still be live at Notion', { context, error: e });
    return 'failed';
  }
}
