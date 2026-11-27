import type { Response as ExpressResponse } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { userRepository } from '@bike4mind/database';
import {
  getNotionOAuthConfig,
  NOTION_OAUTH_TOKEN_URL,
  NOTION_API_BASE_URL,
  NOTION_VERSION,
} from '@server/integrations/notion';
import { NotionTokenManager } from '@server/integrations/notion/notionTokenManager';
import { Config } from '@bike4mind/server-utils/utils/config';
import crypto from 'crypto';
import { IntegrationAuditLogger } from '@bike4mind/server-utils/integrations/integrationAuditLogger';
import { encryptToken } from '@bike4mind/server-utils/security/tokenEncryption';
import { oauthProviderErrorCode } from '@server/utils/auth/oauthProviderErrorCode';
import { clearStateNonce, NONCE_SLOT, readStateNonceHash } from '@bike4mind/server-utils/auth/oauthFlowCookie';
import { appendSetCookie } from '@bike4mind/server-utils/auth/refreshCookie';

const OAUTH_TIMEOUT = 30000;
const NOTION_API_TIMEOUT = 10000;

/** Redirect to the integrations page with a specific error message shown as a toast. */
function redirectWithError(res: ExpressResponse, message: string) {
  appendSetCookie(res, `notion_error=${encodeURIComponent(message)}; Path=/; Max-Age=60; SameSite=Lax; Secure`);
  return res.redirect('/profile?tab=integrations&notion=error');
}

/**
 * Fixed messages for the RFC 6749 4.1.2.1 error codes. This route is unauthenticated, so the
 * `error` query param is attacker-controllable via a crafted link: never echo it to the user,
 * or an arbitrary string (e.g. a fake support phone number) can be phished into a toast.
 */
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  access_denied: 'Notion authorization was declined. Please try connecting again and approve access.',
  invalid_request: 'Notion rejected the authorization request. Please try connecting again.',
  unauthorized_client: 'This app is not authorized to connect to Notion. Please contact your administrator.',
  unsupported_response_type: 'Notion rejected the authorization request. Please contact your administrator.',
  invalid_scope: 'Notion rejected the requested permissions. Please contact your administrator.',
  server_error: 'Notion reported a server error during authorization. Please try again shortly.',
  temporarily_unavailable: 'Notion is temporarily unavailable. Please try connecting again shortly.',
};

interface NotionTokenResponse {
  access_token: string;
  token_type: 'bearer';
  bot_id: string;
  workspace_id: string;
  workspace_name?: string;
  workspace_icon?: string;
  owner?: {
    type: 'user' | 'workspace';
    user?: {
      object: 'user';
      id: string;
      name?: string;
      avatar_url?: string;
      type?: string;
      person?: {
        email?: string;
      };
    };
  };
  duplicated_template_id?: string;
}

/**
 * OAuth callback handler for Notion.
 *
 * GET /api/mcp-servers/notion/callback
 *
 * This handler is designed to be FAST and IDEMPOTENT:
 * 1. Exchange authorization code for tokens
 * 2. Store tokens in User model with appropriate status
 * 3. Set up MCP server
 * 4. Redirect immediately
 */
const handler = baseApi({ auth: false }).get(async (req, res) => {
  const { code, state, error } = req.query;

  // Burn the browser-binding nonce cookie on every exit path.
  clearStateNonce(res, NONCE_SLOT.notionConnect);

  const auditLogger = IntegrationAuditLogger.create(
    {
      entityType: 'oauth',
      integrationName: 'notion',
      action: 'oauth_callback',
      requestId: crypto.randomUUID().split('-')[0],
    },
    req
  );

  // warn, not error: a provider error (the user declined consent) or a code-less hit on this public
  // URL is an expected outcome, and error-level lines raise production alerts.
  if (error) {
    req.logger.warn('Notion authorization not completed', { error: oauthProviderErrorCode(error) });
    auditLogger.failure('oauth_error');
    const message =
      (typeof error === 'string' && OAUTH_ERROR_MESSAGES[error]) ||
      'Notion authorization failed. Please try connecting again.';
    return redirectWithError(res, message);
  }

  if (!code || typeof code !== 'string') {
    req.logger.warn('Notion callback missing authorization code');
    auditLogger.failure('missing_code');
    return redirectWithError(
      res,
      'Notion authorization failed: no authorization code received. Please try connecting again.'
    );
  }

  if (!state || typeof state !== 'string') {
    req.logger.warn('Notion callback missing state parameter');
    auditLogger.failure('missing_state');
    return redirectWithError(res, 'Notion authorization failed: invalid callback state. Please try connecting again.');
  }

  // Extract and validate state parameter
  let userId: string;
  let csrfToken: string;
  let timestamp: number;
  let signature: string;
  let nonceHash: string;

  try {
    const stateData = JSON.parse(decodeURIComponent(state));
    userId = stateData.userId;
    csrfToken = stateData.csrfToken;
    timestamp = stateData.timestamp;
    signature = stateData.signature;
    nonceHash = stateData.nonceHash;

    if (!userId || !csrfToken || !timestamp || !signature || !nonceHash) {
      throw new Error('Missing required state parameters');
    }
  } catch (parseError) {
    // warn, not error: a junk state is caller input (scanners, hand-edited URLs), not a server fault,
    // and error-level lines raise production alerts. The audit row still records it.
    req.logger.warn('Notion callback state parameter could not be parsed', { error: parseError });
    auditLogger.failure('invalid_state');
    return redirectWithError(res, 'Notion authorization failed: corrupted callback data. Please try connecting again.');
  }

  auditLogger.setUserId(userId);

  // Validate HMAC signature to prevent tampering
  const secret = Config.JWT_SECRET;
  if (!secret) {
    req.logger.error('Notion callback missing JWT secret');
    auditLogger.failure('missing_jwt_secret');
    return redirectWithError(res, 'Notion connection failed: server configuration error. Please contact support.');
  }
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${userId}:${csrfToken}:${timestamp}:${nonceHash}`);
  const expectedSignature = hmac.digest('hex');

  if (signature !== expectedSignature) {
    req.logger.error('Notion callback CSRF signature validation failed', { userId });
    auditLogger.failure('csrf_signature_invalid');
    return redirectWithError(
      res,
      'Notion authorization failed: security validation error. Please try connecting again.'
    );
  }

  // The nonce cookie set at connect time must match the signed hash in the state, so only the
  // browser that started the flow can complete it. Fails closed on a missing cookie.
  if (readStateNonceHash(req, NONCE_SLOT.notionConnect) !== nonceHash) {
    // A refresh or Back after success arrives with the cookie already burned: restate the existing
    // connection rather than report a failure. This exchanges and grants nothing.
    const existingUser = await userRepository.findById(userId);
    if (existingUser?.notionConnect?.status === 'connected') {
      auditLogger.success({ isDuplicate: true });
      return res.redirect('/profile?tab=integrations&notion=connected');
    }
    req.logger.error('Notion callback browser-binding nonce validation failed', { userId });
    auditLogger.failure('session_mismatch');
    return redirectWithError(
      res,
      'Notion authorization failed: please finish connecting in the same browser you started from.'
    );
  }

  // Check token age (expire after 10 minutes)
  const tokenAge = Date.now() - timestamp;
  if (tokenAge > 10 * 60 * 1000) {
    req.logger.error('Notion callback CSRF token expired', { userId, ageSeconds: Math.round(tokenAge / 1000) });
    auditLogger.failure('csrf_token_expired');
    return redirectWithError(
      res,
      'Notion authorization timed out (took longer than 10 minutes). Please try connecting again.'
    );
  }

  if (tokenAge < 0) {
    req.logger.error('Notion callback CSRF token timestamp is in the future', { userId });
    auditLogger.failure('csrf_token_future');
    return redirectWithError(
      res,
      'Notion authorization failed: clock synchronization error. Please try connecting again.'
    );
  }

  // Atomic nonce consume: a single updateMany with the nonce in the filter
  // guarantees exactly-once consumption. If a concurrent replay or a second
  // tab races, one of them gets modifiedCount 0 and fails cleanly.
  const nonceConsumed = await userRepository.updateMany({ _id: userId, pendingNotionOAuthNonce: csrfToken }, {
    pendingNotionOAuthNonce: null,
  } as Record<string, unknown>);

  if (nonceConsumed.modifiedCount !== 1) {
    // Check whether they're already connected (benign duplicate)
    const existingUser = await userRepository.findById(userId);
    if (existingUser?.notionConnect?.status === 'connected') {
      auditLogger.success({ isDuplicate: true });
      return res.redirect('/profile?tab=integrations&notion=connected');
    }
    req.logger.error('Notion callback OAuth nonce mismatch or already consumed', { userId });
    auditLogger.failure('nonce_mismatch');
    return redirectWithError(
      res,
      'Notion authorization failed: this link has already been used. Please try connecting again.'
    );
  }

  const { clientId, clientSecret, redirectUri } = await getNotionOAuthConfig();

  if (!clientId || !clientSecret || !redirectUri) {
    req.logger.error('Notion OAuth credentials not configured');
    auditLogger.failure('oauth_not_configured');
    return redirectWithError(
      res,
      'Notion integration is not configured on this server. Please contact your administrator.'
    );
  }

  // Step 1: Exchange code for tokens
  // Notion uses Basic authentication for the token exchange
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  // Add timeout protection for OAuth token exchange
  const tokenController = new AbortController();
  const tokenTimeoutId = setTimeout(() => tokenController.abort(), OAUTH_TIMEOUT);

  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(NOTION_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${credentials}`,
        Accept: 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
      signal: tokenController.signal,
    });
    clearTimeout(tokenTimeoutId);
  } catch (fetchError) {
    clearTimeout(tokenTimeoutId);
    if (fetchError instanceof Error && fetchError.name === 'AbortError') {
      req.logger.error('Notion token exchange timed out', { userId });
      auditLogger.failure('token_exchange_timeout');
      return redirectWithError(
        res,
        'Notion connection timed out while exchanging credentials. Notion may be slow -- please try again.'
      );
    }
    throw fetchError;
  }

  if (!tokenResponse.ok) {
    // The response body and redirect_uri are deliberately not logged.
    req.logger.error('Notion token exchange failed', { userId, status: tokenResponse.status });
    auditLogger.failure('token_exchange_failed', { statusCode: tokenResponse.status });
    return redirectWithError(
      res,
      `Notion rejected the authorization (HTTP ${tokenResponse.status}). This can happen if the link expired or was already used. Please try connecting again.`
    );
  }

  const tokenData: NotionTokenResponse = await tokenResponse.json();

  if (!tokenData.access_token) {
    req.logger.error('Notion token response had no access token', { userId });
    auditLogger.failure('no_access_token');
    return redirectWithError(res, 'Notion did not return an access token. Please try connecting again.');
  }

  // Step 2: Auto-detect a root page ID from pages the integration can access
  let rootPageId: string | undefined;
  try {
    rootPageId = await detectRootPageId(tokenData.access_token);
  } catch (detectError) {
    req.logger.warn('Notion root page detection failed; skipping', { userId, error: detectError });
  }

  // Step 3: Store tokens in User model
  const notionConnect = {
    accessToken: encryptToken(tokenData.access_token)!,
    workspaceId: tokenData.workspace_id,
    workspaceName: tokenData.workspace_name || tokenData.workspace_id,
    workspaceIcon: tokenData.workspace_icon,
    botId: tokenData.bot_id,
    owner: tokenData.owner
      ? {
          type: tokenData.owner.type,
          user: tokenData.owner.user
            ? {
                id: tokenData.owner.user.id,
                name: tokenData.owner.user.name,
                avatarUrl: tokenData.owner.user.avatar_url,
                email: tokenData.owner.user.person?.email,
              }
            : undefined,
        }
      : undefined,
    connectedAt: new Date(),
    status: 'connected' as const,
    // New connections default to read-only. This only applies here (connect
    // time); existing connections retain whatever writeEnabled value they had
    // before -- there is no retroactive migration.
    writeEnabled: false,
    ...(rootPageId && { rootPageId }),
  };

  // Store connection details. The nonce was already consumed atomically above.
  await userRepository.update({
    id: userId,
    notionConnect,
  });

  req.logger.info('Notion tokens stored', { userId, status: 'connected' });

  // Step 4: Set up MCP server
  try {
    await NotionTokenManager.syncMcpServer(userId, tokenData.access_token, tokenData.workspace_id);
  } catch (mcpError) {
    req.logger.error('Notion MCP server setup failed; OAuth succeeded', { userId, error: mcpError });
  }

  auditLogger.success({ workspaceName: tokenData.workspace_name });

  // Step 5: Set cookie and redirect to profile page with success status
  appendSetCookie(res, `notion_connected=true; Path=/; Max-Age=60; SameSite=Lax; Secure`);
  return res.redirect('/profile?tab=integrations&notion=connected');
});

/**
 * Queries the Notion search API for top-level pages accessible to the integration
 * and returns the first one as a default root page. This gives new connections a
 * working write target without manual configuration.
 */
async function detectRootPageId(accessToken: string): Promise<string | undefined> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NOTION_API_TIMEOUT);

  try {
    const response = await fetch(`${NOTION_API_BASE_URL}/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filter: { value: 'page', property: 'object' },
        // Ascending = oldest-edited first, so we pick the longest-lived root page
        sort: { direction: 'ascending', timestamp: 'last_edited_time' },
        page_size: 10,
      }),
      signal: controller.signal,
    });

    if (!response.ok) return undefined;

    const data = (await response.json()) as {
      results: Array<{
        id: string;
        parent?: { type: string; workspace?: boolean };
      }>;
    };

    // Prefer a workspace-level page (top of the tree)
    const workspacePage = data.results.find(p => p.parent?.type === 'workspace');
    if (workspacePage) return workspacePage.id;

    // Fall back to the first accessible page
    return data.results[0]?.id;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeoutId);
  }
}

export default handler;
