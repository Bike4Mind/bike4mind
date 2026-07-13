import { baseApi } from '@server/middlewares/baseApi';
import { userRepository } from '@bike4mind/database';
import {
  getNotionOAuthConfig,
  NOTION_OAUTH_TOKEN_URL,
  NOTION_API_BASE_URL,
  NOTION_VERSION,
} from '@server/integrations/notion';
import { NotionTokenManager } from '@server/integrations/notion/notionTokenManager';
import { Config } from '@server/utils/config';
import crypto from 'crypto';
import { IntegrationAuditLogger } from '@server/integrations/integrationAuditLogger';
import { encryptToken } from '@server/security/tokenEncryption';

const OAUTH_TIMEOUT = 30000;
const NOTION_API_TIMEOUT = 10000;

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

  const auditLogger = IntegrationAuditLogger.create(
    {
      entityType: 'oauth',
      integrationName: 'notion',
      action: 'oauth_callback',
      requestId: crypto.randomUUID().split('-')[0],
    },
    req
  );

  if (error) {
    console.error('[Notion Callback] OAuth error:', error);
    auditLogger.failure('oauth_error');
    const errorMsg = typeof error === 'string' ? error : 'OAuth authorization failed';
    res.setHeader('Set-Cookie', [
      `notion_error=${encodeURIComponent(errorMsg)}; Path=/; Max-Age=60; SameSite=Lax; Secure`,
    ]);
    return res.redirect('/profile?tab=integrations&notion=error');
  }

  if (!code || typeof code !== 'string') {
    console.error('[Notion Callback] Missing authorization code');
    auditLogger.failure('missing_code');
    return res.redirect('/profile?tab=integrations&notion=error');
  }

  if (!state || typeof state !== 'string') {
    console.error('[Notion Callback] Missing state parameter');
    auditLogger.failure('missing_state');
    return res.redirect('/profile?tab=integrations&notion=error');
  }

  // Extract and validate state parameter
  let userId: string;
  let csrfToken: string;
  let timestamp: number;
  let signature: string;

  try {
    const stateData = JSON.parse(decodeURIComponent(state));
    userId = stateData.userId;
    csrfToken = stateData.csrfToken;
    timestamp = stateData.timestamp;
    signature = stateData.signature;

    if (!userId || !csrfToken || !timestamp || !signature) {
      throw new Error('Missing required state parameters');
    }
  } catch (parseError) {
    console.error('[Notion Callback] Failed to parse state parameter:', parseError);
    auditLogger.failure('invalid_state');
    return res.redirect('/profile?tab=integrations&notion=error');
  }

  auditLogger.setUserId(userId);

  // Validate HMAC signature to prevent tampering
  const secret = Config.JWT_SECRET;
  if (!secret) {
    console.error('[Notion Callback] JWT_SECRET environment variable is required');
    auditLogger.failure('missing_jwt_secret');
    return res.redirect('/profile?tab=integrations&notion=error');
  }
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${userId}:${csrfToken}:${timestamp}`);
  const expectedSignature = hmac.digest('hex');

  if (signature !== expectedSignature) {
    console.error('[Notion Callback] CSRF signature validation failed');
    auditLogger.failure('csrf_signature_invalid');
    return res.redirect('/profile?tab=integrations&notion=error');
  }

  // Check token age (expire after 10 minutes)
  const tokenAge = Date.now() - timestamp;
  if (tokenAge > 10 * 60 * 1000) {
    console.error('[Notion Callback] CSRF token expired (age: ' + Math.round(tokenAge / 1000) + 's)');
    auditLogger.failure('csrf_token_expired');
    return res.redirect('/profile?tab=integrations&notion=error');
  }

  if (tokenAge < 0) {
    console.error('[Notion Callback] CSRF token timestamp is in the future');
    auditLogger.failure('csrf_token_future');
    return res.redirect('/profile?tab=integrations&notion=error');
  }

  // Idempotency check: avoid re-running token exchange if the callback fires more than once
  const existingUser = await userRepository.findById(userId);
  if (existingUser?.notionConnect?.status === 'connected') {
    console.log('[Notion Callback] User already has valid Notion connection, skipping token exchange');
    auditLogger.success({ isDuplicate: true });
    return res.redirect('/profile?tab=integrations&notion=connected');
  }

  const { clientId, clientSecret, redirectUri } = await getNotionOAuthConfig();

  if (!clientId || !clientSecret || !redirectUri) {
    console.error('[Notion Callback] Notion OAuth credentials not configured');
    auditLogger.failure('oauth_not_configured');
    return res.redirect('/profile?tab=integrations&notion=error');
  }

  // Step 1: Exchange code for tokens
  // Notion uses Basic authentication for the token exchange
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  console.log('[Notion Callback] Exchanging authorization code for tokens...');

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
      console.error('[Notion Callback] Token exchange timed out after 30s');
      auditLogger.failure('token_exchange_timeout');
      return res.redirect('/profile?tab=integrations&notion=error');
    }
    throw fetchError;
  }

  console.log('[Notion Callback] Token response status:', tokenResponse.status, tokenResponse.statusText);

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error('[Notion Callback] Token exchange error response:', errorText);
    console.error('[Notion Callback] Possible causes:');
    console.error('   1. Authorization code already used (codes are single-use only)');
    console.error('   2. Authorization code expired');
    console.error('   3. redirect_uri mismatch between authorize and token exchange');
    console.error('   4. Client ID/Secret mismatch');
    console.error('   Current redirect_uri:', redirectUri);
    auditLogger.failure('token_exchange_failed', { statusCode: tokenResponse.status });
    return res.redirect('/profile?tab=integrations&notion=error');
  }

  const tokenData: NotionTokenResponse = await tokenResponse.json();

  if (!tokenData.access_token) {
    console.error('[Notion Callback] No access token returned from Notion');
    auditLogger.failure('no_access_token');
    return res.redirect('/profile?tab=integrations&notion=error');
  }

  console.log(
    `[Notion Callback] Successfully obtained access token for workspace: ${tokenData.workspace_name || tokenData.workspace_id}`
  );

  // Step 2: Auto-detect a root page ID from pages the integration can access
  let rootPageId: string | undefined;
  try {
    rootPageId = await detectRootPageId(tokenData.access_token);
    if (rootPageId) {
      console.log(`[Notion Callback] Auto-detected root page ID: ${rootPageId}`);
    } else {
      console.log('[Notion Callback] No root page auto-detected (user can set one manually)');
    }
  } catch (detectError) {
    console.warn('[Notion Callback] Root page detection failed, skipping:', detectError);
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
    writeEnabled: true,
    ...(rootPageId && { rootPageId }),
  };

  await userRepository.update({
    id: userId,
    notionConnect,
  });

  console.log(`[Notion Callback] Tokens stored for user ${userId}, status: connected`);

  // Step 4: Set up MCP server
  try {
    await NotionTokenManager.syncMcpServer(userId, tokenData.access_token, tokenData.workspace_id);
  } catch (mcpError) {
    console.error('[Notion Callback] MCP server setup failed, but OAuth succeeded:', mcpError);
  }

  auditLogger.success({ workspaceName: tokenData.workspace_name });

  // Step 5: Set cookie and redirect to profile page with success status
  res.setHeader('Set-Cookie', [`notion_connected=true; Path=/; Max-Age=60; SameSite=Lax; Secure`]);
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
