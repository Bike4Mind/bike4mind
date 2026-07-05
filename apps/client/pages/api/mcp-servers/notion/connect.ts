import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@server/utils/errors';
import { getNotionOAuthConfig, NOTION_OAUTH_AUTHORIZE_URL } from '@server/integrations/notion';
import { userRepository } from '@bike4mind/database';
import crypto from 'crypto';
import { Config } from '@server/utils/config';

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
    console.log(`[Notion Connect] User ${userId} already connected`);
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

  // HMAC-sign the state to detect tampering with userId or timestamp
  const secret = Config.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${userId}:${csrfToken}:${timestamp}`);
  const signature = hmac.digest('hex');

  const referrer = req.headers.referer || '/profile?tab=integrations';
  const state = encodeURIComponent(
    JSON.stringify({
      userId,
      referrer,
      csrfToken,
      timestamp,
      signature,
    })
  );

  // Notion uses the 'owner' parameter to specify who the integration is for
  const authUrl = new URL(NOTION_OAUTH_AUTHORIZE_URL);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('owner', 'user'); // Request access to user's workspaces
  authUrl.searchParams.set('state', state);

  console.log('[Notion Connect] OAuth Authorization URL Generated');
  console.log('clientId:', clientId);
  console.log('redirectUri:', redirectUri);
  console.log('Full authUrl:', authUrl.toString());

  return res.json({ authUrl: authUrl.toString(), state });
});

export default handler;
