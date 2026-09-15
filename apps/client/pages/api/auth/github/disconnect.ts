import { McpServer } from '@bike4mind/database/ai';
import { McpServerName } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { adminSettingsRepository } from '@bike4mind/database';
import { decryptEnvVariables } from '@server/security/tokenEncryption';

/**
 * Minimal logger shape this handler needs. Compatible with the `Logger` on
 * `req.logger` (and `@bike4mind/observability` `ILogger`), but declared locally:
 * `@bike4mind/observability` is not a direct dependency of the client app, and
 * importing `Logger` from `@bike4mind/utils` is banned by lint.
 */
interface RevokeLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Best-effort revocation of the GitHub OAuth grant. Deleting the local McpServer
 * record alone leaves the access token live and the app in the user's Authorized
 * OAuth Apps list. Mirrors the Google Drive / Atlassian disconnect handlers:
 * remote failures are logged, never thrown, so they cannot block local disconnect.
 *
 * Uses DELETE /applications/{client_id}/grant (revokes the whole authorization,
 * removing the app from Authorized OAuth Apps) - not /token, which would leave the
 * grant. This is an OAuth App (web-flow code exchange, no refresh token), so the
 * grant endpoint is correct.
 * https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-authorization
 */
async function revokeGithubGrant(
  deletedServer: { envVariables?: { key: string; value: string }[] } | null,
  logger: RevokeLogger
): Promise<void> {
  // Wrap the whole body: getSettings (DB call) and decryptEnvVariables (corrupt /
  // rotated token) can throw too, not just fetch. Catching only fetch would let
  // those bubble to asyncHandler and 500 the request after the local delete already
  // succeeded - breaking the "never blocks local disconnect" guarantee.
  try {
    const encryptedVars = deletedServer?.envVariables;
    const accessToken = encryptedVars
      ? decryptEnvVariables(encryptedVars).find(v => v.key === 'GITHUB_ACCESS_TOKEN')?.value
      : undefined;

    if (!accessToken) {
      logger.info('Skipping GitHub OAuth grant revocation — no access token on record');
      return;
    }

    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
    const clientId = getSettingsValue('githubMcpClientId', settings);
    const clientSecret = getSettingsValue('githubMcpClientSecret', settings);

    if (!clientId || !clientSecret) {
      logger.info('Skipping GitHub OAuth grant revocation — OAuth credentials not configured');
      return;
    }

    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response = await fetch(`https://api.github.com/applications/${clientId}/grant`, {
      method: 'DELETE',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ access_token: accessToken }),
    });

    if (response.ok) {
      logger.info('Revoked GitHub OAuth grant');
    } else {
      const errorText = await response.text().catch(() => '');
      logger.warn('Failed to revoke GitHub OAuth grant', { status: response.status, errorText });
    }
  } catch (error) {
    logger.error('GitHub OAuth grant revocation threw', error);
  }
}

// Was raw NextApiRequest with ZERO auth: any person on the internet could
// disconnect any user's GitHub by providing their userId. Now uses baseApi()
// for proper auth and scopes to the requesting user.
const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    const userId = req.user.id; // Use authenticated user, not req.body

    const deletedServer = await McpServer.findOneAndDelete({
      userId,
      name: McpServerName.Github,
    });

    if (deletedServer) {
      req.logger.info('Disconnected GitHub MCP server', { userId, serverId: deletedServer.id });
    }

    // Best-effort: revoke the grant at GitHub so the token dies and the app
    // leaves the user's Authorized OAuth Apps list. Never blocks local disconnect.
    await revokeGithubGrant(deletedServer, req.logger);

    return res.status(200).json({ success: true, message: 'GitHub disconnected' });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
