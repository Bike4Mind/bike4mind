import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { Config } from '@server/utils/config';
import { InternalServerError } from '@server/utils/errors';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { adminSettingsRepository } from '@bike4mind/database';
import jwt from 'jsonwebtoken';

function getJwtSecret(): string {
  // HYDRA-7729: never fall back to a hardcoded secret. Fail closed.
  if (!Config.JWT_SECRET) {
    throw new InternalServerError('JWT_SECRET is not configured');
  }
  return Config.JWT_SECRET;
}

// HYDRA-7719 fix: Was raw NextApiRequest with ZERO auth - any unauthenticated
// caller could initiate a GitHub OAuth flow targeting another user, enabling
// account takeover by linking their GitHub identity to someone else's account.
// Now uses baseApi() and derives userId from req.user (the authenticated user).
const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    const userId = req.user.id; // Use authenticated user, not req.body

    // Get GitHub MCP credentials from admin settings
    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
    const clientId = getSettingsValue('githubMcpClientId', settings);

    if (!clientId) {
      req.logger.error('GITHUB_MCP_CLIENT_ID not configured');
      throw new InternalServerError('GitHub OAuth not configured');
    }

    // Create state token with userId (for CSRF protection and user identification)
    const state = jwt.sign({ userId }, getJwtSecret(), {
      expiresIn: '10m',
    });

    // HYDRA-7733: Set a session-binding cookie so the callback can verify that
    // the same browser that initiated the OAuth flow is the one completing it.
    // This closes the account-linking hijack class even if the state token leaks
    // (via URL logs, browser history, etc.). HttpOnly + Secure + SameSite=Lax
    // ensures the cookie survives the GitHub redirect chain but can't be read or
    // forged by JS or cross-site requests.
    res.setHeader(
      'Set-Cookie',
      `gh_oauth_uid=${userId}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/api/auth/github/mcp-callback`
    );

    // Get the base URL for the callback
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = `${protocol}://${host}`;

    // Build GitHub OAuth authorization URL
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${baseUrl}/api/auth/github/mcp-callback`,
      scope: 'repo,read:org,read:user,project',
      state,
      allow_signup: 'false',
    });

    const authUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;

    req.logger.info('Generated GitHub OAuth URL', { userId });

    return res.status(200).json({ authUrl });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
