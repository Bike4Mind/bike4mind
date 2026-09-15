import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { Config } from '@server/utils/config';
import { InternalServerError } from '@server/utils/errors';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { adminSettingsRepository } from '@bike4mind/database';
import { issueStateNonce } from '@server/auth/oauthFlowCookie';
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

    // Bind the flow to this browser: the shared nonce cookie carries a random
    // secret, and only its hash (nh) rides the signed state token. The callback
    // requires the same browser's cookie to match, so the state token is not the
    // sole identity source even if it leaks (URL logs, browser history). This
    // replaces the previous userId-valued cookie, which carried no secret and was
    // forgeable by anyone who knew the target userId.
    const nonceHash = issueStateNonce(res);

    // Create state token with userId (identity) and the nonce hash (browser-binding).
    const state = jwt.sign({ userId, nh: nonceHash }, getJwtSecret(), {
      expiresIn: '10m',
    });

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
