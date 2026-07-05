import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@server/utils/errors';
import { getAtlassianOAuthConfig, ATLASSIAN_OAUTH_SCOPES } from '@server/integrations/jira/atlassianConfig';
import { userRepository } from '@bike4mind/database';
import crypto from 'crypto';
import { Config } from '@server/utils/config';

const handler = baseApi().get(async (req, res) => {
  const userId = req.user.id;

  // Check for expired pending site selection and clear it before initiating new OAuth
  const user = await userRepository.findById(userId);
  if (user?.atlassianConnect?.status === 'pending_site_selection') {
    const expiresAt = user.atlassianConnect.pendingSelectionExpiresAt
      ? new Date(user.atlassianConnect.pendingSelectionExpiresAt)
      : null;

    // If expired OR no expiration set (legacy), clear the pending state
    if (!expiresAt || expiresAt < new Date()) {
      console.log(`[Atlassian Connect] Clearing expired pending site selection for user ${userId}`);
      await userRepository.update({
        id: userId,
        atlassianConnect: null,
      });
    } else {
      // Pending selection is still valid - return redirect URL for frontend to handle
      console.log(`[Atlassian Connect] User ${userId} has active pending site selection, returning redirect URL`);
      return res.json({ redirectTo: '/integrations/atlassian/select-site' });
    }
  }

  const { clientId, redirectUri } = await getAtlassianOAuthConfig();

  if (!clientId || !redirectUri) {
    throw new BadRequestError('Atlassian OAuth credentials not configured');
  }

  const scopes = ATLASSIAN_OAUTH_SCOPES;

  // Generate cryptographically secure CSRF token and include timestamp
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const timestamp = Date.now();

  // HMAC-sign the state to detect tampering with userId or timestamp
  const secret = Config.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${req.user.id}:${csrfToken}:${timestamp}`);
  const signature = hmac.digest('hex');

  const referrer = req.headers.referer || '/profile?tab=integrations'; // Default to Integrations tab if no referrer
  const state = encodeURIComponent(
    JSON.stringify({
      userId: req.user.id,
      referrer,
      csrfToken,
      timestamp,
      signature,
    })
  );

  const authUrl = new URL('https://auth.atlassian.com/authorize');
  authUrl.searchParams.set('audience', 'api.atlassian.com');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('scope', scopes);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('prompt', 'consent');

  console.log('🔗 Atlassian OAuth Authorization URL Generated');
  console.log('clientId:', clientId);
  console.log('redirectUri:', redirectUri);
  console.log('baseUrl:', process.env.APP_URL);
  console.log('scopes:', scopes.split(' ').length, 'scopes');
  console.log('Full authUrl:', authUrl.toString());

  return res.json({ authUrl: authUrl.toString(), state });
});

export default handler;
