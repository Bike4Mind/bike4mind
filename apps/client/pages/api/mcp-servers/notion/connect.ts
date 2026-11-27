import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { getNotionOAuthConfig, NOTION_OAUTH_AUTHORIZE_URL } from '@server/integrations/notion';
import { userRepository } from '@bike4mind/database';
import crypto from 'crypto';
import { Config } from '@bike4mind/server-utils/utils/config';
import { issueStateNonce, NONCE_SLOT } from '@bike4mind/server-utils/auth/oauthFlowCookie';

/**
 * Initiates the Notion OAuth flow.
 *
 * GET /api/mcp-servers/notion/connect
 *
 * Returns the authorization URL that the frontend should redirect to.
 * Uses HMAC-signed state parameter for CSRF protection.
 */
const handler = baseApi().get(async (req, res) => {
  const userId = req.user.id;

  const user = await userRepository.findById(userId);
  if (user?.notionConnect?.status === 'connected') {
    return res.json({
      alreadyConnected: true,
      workspaceName: user.notionConnect.workspaceName,
    });
  }

  const { clientId, redirectUri } = await getNotionOAuthConfig();

  if (!clientId || !redirectUri) {
    throw new BadRequestError('Notion OAuth credentials not configured');
  }

  // Generate cryptographically secure CSRF token and include timestamp
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const timestamp = Date.now();

  const secret = Config.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }

  // Bind the flow to this browser (see oauthFlowCookie.ts). The nonce hash is signed so a
  // captured state cannot be re-pointed at another browser's cookie.
  const nonceHash = issueStateNonce(res, NONCE_SLOT.notionConnect);

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${userId}:${csrfToken}:${timestamp}:${nonceHash}`);
  const signature = hmac.digest('hex');

  const referrer = req.headers.referer || '/profile?tab=integrations';
  const state = encodeURIComponent(
    JSON.stringify({
      userId,
      referrer,
      csrfToken,
      timestamp,
      nonceHash,
      signature,
    })
  );

  // Persist the nonce so the callback can verify it is single-use
  await userRepository.update({ id: userId, pendingNotionOAuthNonce: csrfToken });

  // Notion uses the 'owner' parameter to specify who the integration is for
  const authUrl = new URL(NOTION_OAUTH_AUTHORIZE_URL);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('owner', 'user'); // Request access to user's workspaces
  authUrl.searchParams.set('state', state);

  return res.json({ authUrl: authUrl.toString(), state });
});

export default handler;
