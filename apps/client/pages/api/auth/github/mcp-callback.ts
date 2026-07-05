import { baseApi } from '@server/middlewares/baseApi';
import { mcpServerRepository, userRepository } from '@bike4mind/database';
import { Config } from '@server/utils/config';
import { InternalServerError } from '@server/utils/errors';
import { McpServerName } from '@bike4mind/common';
import type { Response as ExpressResponse } from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { adminSettingsRepository } from '@bike4mind/database';
import { IntegrationAuditLogger } from '@server/integrations/integrationAuditLogger';
import { encryptEnvVariables } from '@server/security/tokenEncryption';

function getJwtSecret(): string {
  // Never fall back to a hardcoded secret. Fail closed.
  if (!Config.JWT_SECRET) {
    throw new InternalServerError('JWT_SECRET is not configured');
  }
  return Config.JWT_SECRET;
}

/** Parse the Cookie header into a key-value map. */
function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    cookies[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return cookies;
}

/**
 * Clear the session-binding cookie on every exit path. Called unconditionally
 * so success AND failure branches both leave the browser in a clean state.
 * Idempotent - safe to call multiple times.
 */
function clearOAuthCookie(res: ExpressResponse): void {
  res.setHeader(
    'Set-Cookie',
    'gh_oauth_uid=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/api/auth/github/mcp-callback'
  );
}

// Treat OAuth callbacks within this window as duplicates (prevents browser back/refresh issues)
const OAUTH_IDEMPOTENCY_WINDOW_SECONDS = 30;

const handler = baseApi({ auth: false }).get(async (req, res) => {
  // Prevent browser caching of callback responses
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  // Clear the session-binding cookie unconditionally so every exit path
  // (success or failure) is covered, not just the branches present today.
  clearOAuthCookie(res);

  const requestId = randomUUID().split('-')[0]; // Use first segment for shorter, secure ID
  const auditLogger = IntegrationAuditLogger.create(
    {
      entityType: 'oauth',
      integrationName: 'github',
      action: 'oauth_callback',
      requestId,
    },
    req
  );

  try {
    const { code, state } = req.query;

    if (!code || typeof code !== 'string') {
      req.logger.error('Missing or invalid code parameter');
      auditLogger.failure('missing_code');
      return res.redirect('/profile?tab=integrations&github_oauth=error&error=missing_code#github-integration');
    }

    if (!state || typeof state !== 'string') {
      req.logger.error('Missing or invalid state parameter');
      auditLogger.failure('missing_state');
      return res.redirect('/profile?tab=integrations&github_oauth=error&error=missing_state#github-integration');
    }

    // Verify state token (contains userId)
    let userId: string;
    try {
      const decoded = jwt.verify(state, getJwtSecret(), { algorithms: ['HS256'] }) as { userId: string };
      userId = decoded.userId;
    } catch (error) {
      req.logger.error('Invalid state token', error);
      auditLogger.failure('invalid_state');
      return res.redirect('/profile?tab=integrations&github_oauth=error&error=invalid_state#github-integration');
    }

    // Cross-check the session-binding cookie set by authorize.ts. The gh_oauth_uid
    // cookie proves the same browser that initiated the OAuth flow is completing it.
    // Without this check, the state token is the sole identity source: if it leaks,
    // an attacker can link their GitHub to the victim's account from a different browser.
    const cookies = parseCookies(req.headers.cookie);
    const cookieUid = cookies['gh_oauth_uid'];
    if (!cookieUid) {
      req.logger.error('Missing gh_oauth_uid session cookie — session expired or different browser', { userId });
      auditLogger.failure('session_missing');
      return res.redirect('/profile?tab=integrations&github_oauth=error&error=session_expired#github-integration');
    }
    if (cookieUid !== userId) {
      req.logger.error('Session mismatch — cookie userId does not match state token', {
        cookieUid,
        stateUserId: userId,
      });
      auditLogger.failure('session_mismatch');
      return res.redirect('/profile?tab=integrations&github_oauth=error&error=session_mismatch#github-integration');
    }

    // Cookie already cleared at the top of the handler (unconditional).
    auditLogger.setUserId(userId);

    const user = await userRepository.findById(userId);
    if (!user) {
      req.logger.error('User not found', { userId });
      auditLogger.failure('user_not_found');
      return res.redirect('/profile?tab=integrations&github_oauth=error&error=user_not_found#github-integration');
    }

    // Idempotency check: Prevent duplicate OAuth callback processing
    // If GitHub was connected in the last 30 seconds, assume this is a duplicate request
    const recentConnection = await mcpServerRepository.findOne({
      userId,
      name: McpServerName.Github,
    });

    if (recentConnection?.enabled && recentConnection.metadata?.connectedAt) {
      const connectedAt = new Date(recentConnection.metadata.connectedAt);
      const now = new Date();
      const secondsSinceConnection = (now.getTime() - connectedAt.getTime()) / 1000;

      if (secondsSinceConnection < OAUTH_IDEMPOTENCY_WINDOW_SECONDS) {
        req.logger.warn('[OAuth Callback] Duplicate callback detected - already connected recently', {
          requestId,
          userId,
          secondsSinceConnection,
          githubLogin: recentConnection.metadata.githubLogin,
        });
        // Redirect to success since the connection was already established
        return res.redirect('/profile?tab=integrations&github_oauth=success#github-integration');
      }
    }

    // Exchange code for access token - get credentials from admin settings
    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
    const clientId = getSettingsValue('githubMcpClientId', settings);
    const clientSecret = getSettingsValue('githubMcpClientSecret', settings);

    if (!clientId || !clientSecret) {
      req.logger.error('GitHub MCP OAuth credentials not configured');
      auditLogger.failure('oauth_not_configured');
      return res.redirect('/profile?tab=integrations&github_oauth=error&error=oauth_not_configured#github-integration');
    }

    // Add timeout protection for OAuth token exchange
    const tokenController = new AbortController();
    const tokenTimeoutId = setTimeout(() => tokenController.abort(), 30000); // 30s timeout

    let tokenResponse: Response;
    try {
      tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
        }),
        signal: tokenController.signal,
      });
      clearTimeout(tokenTimeoutId);
    } catch (fetchError) {
      clearTimeout(tokenTimeoutId);
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        req.logger.error('GitHub token exchange timed out after 30s');
        return res.redirect('/profile?tab=integrations&github_oauth=error&error=timeout#github-integration');
      }
      throw fetchError;
    }

    const tokenData = await tokenResponse.json();

    if (tokenData.error) {
      req.logger.error('[OAuth Callback] GitHub OAuth error', {
        userId,
        error: tokenData.error,
        errorDescription: tokenData.error_description,
      });

      // Handle common duplicate request case with user-friendly error
      if (tokenData.error === 'bad_verification_code') {
        req.logger.warn('[OAuth Callback] Duplicate code detected', { userId });
        auditLogger.failure('auth_code_reused');
        return res.redirect('/profile?tab=integrations&github_oauth=error&error=auth_code_reused#github-integration');
      }

      auditLogger.failure(tokenData.error);
      return res.redirect(
        `/profile?tab=integrations&github_oauth=error&error=${encodeURIComponent(tokenData.error)}#github-integration`
      );
    }

    const { access_token } = tokenData;

    if (!access_token) {
      req.logger.error('No access token received from GitHub');
      auditLogger.failure('no_token');
      return res.redirect('/profile?tab=integrations&github_oauth=error&error=no_token#github-integration');
    }

    // Get GitHub user info with timeout protection
    const userController = new AbortController();
    const userTimeoutId = setTimeout(() => userController.abort(), 15000); // 15s timeout

    let userResponse: Response;
    try {
      userResponse = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${access_token}`,
          Accept: 'application/vnd.github.v3+json',
        },
        signal: userController.signal,
      });
      clearTimeout(userTimeoutId);
    } catch (fetchError) {
      clearTimeout(userTimeoutId);
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        req.logger.error('GitHub user info fetch timed out after 15s');
        return res.redirect('/profile?tab=integrations&github_oauth=error&error=timeout#github-integration');
      }
      throw fetchError;
    }

    const githubUser = await userResponse.json();

    // Get granted scopes from the token response (logged for debugging)
    const grantedScopes = tokenData.scope?.split(',') || [];

    req.logger.info('[GitHub OAuth] GitHub user authenticated', {
      userId,
      githubLogin: githubUser.login,
      scopes: grantedScopes,
    });

    // Prepare environment variables for MCP server
    const plaintextEnvVariables = [{ key: 'GITHUB_ACCESS_TOKEN', value: access_token }];
    const encryptedEnvVariables = encryptEnvVariables(plaintextEnvVariables);

    // Store or update MCP server configuration (reuse recentConnection from idempotency check)
    // Initially save with empty tools array - we'll discover tools dynamically next
    let githubServer;
    if (recentConnection) {
      githubServer = await mcpServerRepository.update({
        id: recentConnection.id,
        enabled: true,
        envVariables: encryptedEnvVariables,
        tools: [], // Will be populated by dynamic discovery
        metadata: {
          githubLogin: githubUser.login,
          connectedAt: new Date().toISOString(),
          scope: grantedScopes.join(','),
        },
      });
      req.logger.info('[GitHub OAuth] Updated GitHub MCP server config', {
        userId,
        githubLogin: githubUser.login,
        serverId: recentConnection.id,
      });
    } else {
      githubServer = await mcpServerRepository.create({
        userId,
        name: McpServerName.Github,
        enabled: true,
        envVariables: encryptedEnvVariables,
        tools: [], // Will be populated by dynamic discovery
        metadata: {
          githubLogin: githubUser.login,
          connectedAt: new Date().toISOString(),
          scope: grantedScopes.join(','),
        },
      });
      req.logger.info('[GitHub OAuth] Created GitHub MCP server config', {
        userId,
        githubLogin: githubUser.login,
        serverId: githubServer.id,
      });
    }

    // Dynamically discover tools from the GitHub MCP server so the tools list
    // matches what the server actually provides.
    try {
      const { invokeMcpHandler } = await import('@server/utils/invokeMcpHandler');
      const result = await invokeMcpHandler<any>({
        envVariables: plaintextEnvVariables,
        name: 'github',
        action: 'getTools',
        userId: userId,
      });

      const tools = Array.isArray(result) ? result : [result].flat();
      const toolNames = tools.map((tool: any) => tool.name);

      if (githubServer) {
        await mcpServerRepository.update({
          id: githubServer.id,
          tools: toolNames,
          toolSchemas: tools,
        });
      }

      req.logger.info('[GitHub OAuth] GitHub MCP server configured', {
        userId,
        githubLogin: githubUser.login,
        toolCount: toolNames.length,
      });
    } catch (mcpError) {
      // Don't fail the whole OAuth flow if MCP tool discovery fails
      // The connection is still valid, tools can be discovered later via /connect
      req.logger.warn('[GitHub OAuth] Failed to discover GitHub MCP tools, connection saved', {
        userId,
        error: mcpError instanceof Error ? mcpError.message : String(mcpError),
      });
    }

    // Redirect back to profile/settings with success
    auditLogger.success({ githubLogin: githubUser.login, scopes: grantedScopes });
    return res.redirect('/profile?tab=integrations&github_oauth=success#github-integration');
  } catch (error) {
    req.logger.error('GitHub OAuth callback error', error);
    auditLogger.failure('callback_failed');
    return res.redirect('/profile?tab=integrations&github_oauth=error&error=callback_failed#github-integration');
  }
});

export default handler;
