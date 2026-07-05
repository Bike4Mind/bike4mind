import { baseApi } from '@server/middlewares/baseApi';
import { userRepository } from '@bike4mind/database';
import { getAtlassianOAuthConfig } from '@server/integrations/jira/atlassianConfig';
import { Config } from '@server/utils/config';
import crypto from 'crypto';
import { IntegrationAuditLogger } from '@server/integrations/integrationAuditLogger';
import { encryptToken } from '@server/security/tokenEncryption';

const OAUTH_TIMEOUT = 30000;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

interface ResourceResponse {
  id: string;
  name: string;
  url?: string;
  scopes: string[];
  avatarUrl: string;
  resourceType?: string;
  productType?: string;
}

/**
 * OAuth callback handler for Atlassian.
 *
 * This handler is designed to be FAST and IDEMPOTENT:
 * 1. Exchange authorization code for tokens
 * 2. Store tokens in User model with appropriate status
 * 3. Redirect immediately
 *
 * MCP server setup is handled separately in finalize.ts to avoid:
 * - Long-running requests that may timeout/retry
 * - Duplicate code usage from browser retries
 */
const handler = baseApi({ auth: false }).get(async (req, res) => {
  const { code, state } = req.query;

  const auditLogger = IntegrationAuditLogger.create(
    {
      entityType: 'oauth',
      integrationName: 'atlassian',
      action: 'oauth_callback',
      requestId: crypto.randomUUID().split('-')[0],
    },
    req
  );

  if (!code || typeof code !== 'string') {
    console.error('❌ Missing authorization code');
    auditLogger.failure('missing_code');
    return res.redirect('/profile?tab=integrations&atlassian=error');
  }

  if (!state || typeof state !== 'string') {
    console.error('❌ Missing state parameter');
    auditLogger.failure('missing_state');
    return res.redirect('/profile?tab=integrations&atlassian=error');
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
    console.error('❌ Failed to parse state parameter:', parseError);
    auditLogger.failure('invalid_state');
    return res.redirect('/profile?tab=integrations&atlassian=error');
  }

  auditLogger.setUserId(userId);

  // Validate HMAC signature to prevent tampering
  const secret = Config.JWT_SECRET;
  if (!secret) {
    console.error('❌ JWT_SECRET environment variable is required');
    auditLogger.failure('missing_jwt_secret');
    return res.redirect('/profile?tab=integrations&atlassian=error');
  }
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${userId}:${csrfToken}:${timestamp}`);
  const expectedSignature = hmac.digest('hex');

  if (signature !== expectedSignature) {
    console.error('❌ CSRF signature validation failed');
    auditLogger.failure('csrf_signature_invalid');
    return res.redirect('/profile?tab=integrations&atlassian=error');
  }

  // Check token age (expire after 10 minutes)
  const tokenAge = Date.now() - timestamp;
  if (tokenAge > 10 * 60 * 1000) {
    console.error('❌ CSRF token expired (age: ' + Math.round(tokenAge / 1000) + 's)');
    auditLogger.failure('csrf_token_expired');
    return res.redirect('/profile?tab=integrations&atlassian=error');
  }

  if (tokenAge < 0) {
    console.error('❌ CSRF token timestamp is in the future');
    auditLogger.failure('csrf_token_future');
    return res.redirect('/profile?tab=integrations&atlassian=error');
  }

  // Idempotency check: avoid re-running token exchange if the callback fires more than once
  const existingUser = await userRepository.findById(userId);
  if (existingUser?.atlassianConnect?.status === 'connected') {
    console.log('✅ User already has valid Atlassian connection, skipping token exchange');
    auditLogger.success({ isDuplicate: true });
    return res.redirect('/profile?tab=integrations&atlassian=connected');
  }

  const { clientId, clientSecret, redirectUri } = await getAtlassianOAuthConfig();

  if (!clientId || !clientSecret || !redirectUri) {
    console.error('❌ Atlassian OAuth credentials not configured');
    auditLogger.failure('oauth_not_configured');
    return res.redirect('/profile?tab=integrations&atlassian=error');
  }

  // Step 1: Exchange code for tokens
  const tokenRequestBody = {
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  };

  console.log('🔄 Exchanging authorization code for tokens...');

  // Add timeout protection for OAuth token exchange
  const tokenController = new AbortController();
  const tokenTimeoutId = setTimeout(() => tokenController.abort(), OAUTH_TIMEOUT);

  let tokenResponse: Response;
  try {
    tokenResponse = await fetch('https://auth.atlassian.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(tokenRequestBody),
      signal: tokenController.signal,
    });
    clearTimeout(tokenTimeoutId);
  } catch (fetchError) {
    clearTimeout(tokenTimeoutId);
    if (fetchError instanceof Error && fetchError.name === 'AbortError') {
      console.error('❌ Atlassian token exchange timed out after 30s');
      return res.redirect('/profile?tab=integrations&atlassian=error');
    }
    throw fetchError;
  }

  console.log('📥 Token response status:', tokenResponse.status, tokenResponse.statusText);

  if (!tokenResponse.ok) {
    const error = await tokenResponse.text();
    console.error('❌ Token exchange error response:', error);
    console.error('❌ Possible causes:');
    console.error('   1. Authorization code already used (codes are single-use only)');
    console.error('   2. Authorization code expired (typically 10 min expiry)');
    console.error('   3. redirect_uri mismatch between authorize and token exchange');
    console.error('   4. Client ID/Secret mismatch');
    console.error('   Current redirect_uri:', redirectUri);
    auditLogger.failure('token_exchange_failed', { statusCode: tokenResponse.status });
    return res.redirect('/profile?tab=integrations&atlassian=error');
  }

  const tokenData: TokenResponse = await tokenResponse.json();
  const refreshToken = tokenData.refresh_token;

  if (!refreshToken) {
    console.error('❌ No refresh token returned from Atlassian');
    auditLogger.failure('no_refresh_token');
    return res.redirect('/profile?tab=integrations&atlassian=error');
  }

  // Step 2: Get accessible resources
  console.log('🔄 Fetching accessible Atlassian resources...');

  const resourcesController = new AbortController();
  const resourcesTimeoutId = setTimeout(() => resourcesController.abort(), 15000);

  let resourcesResponse: Response;
  try {
    resourcesResponse = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/json',
      },
      signal: resourcesController.signal,
    });
    clearTimeout(resourcesTimeoutId);
  } catch (fetchError) {
    clearTimeout(resourcesTimeoutId);
    if (fetchError instanceof Error && fetchError.name === 'AbortError') {
      console.error('❌ Atlassian resources fetch timed out after 15s');
      return res.redirect('/profile?tab=integrations&atlassian=error');
    }
    throw fetchError;
  }

  if (!resourcesResponse.ok) {
    const error = await resourcesResponse.text();
    console.error('❌ Resources fetch failed:', error);
    auditLogger.failure('resources_fetch_failed', { statusCode: resourcesResponse.status });
    return res.redirect('/profile?tab=integrations&atlassian=error');
  }

  const resources: ResourceResponse[] = await resourcesResponse.json();

  if (!resources.length) {
    console.error('❌ No accessible Atlassian resources found');
    auditLogger.failure('no_resources');
    return res.redirect('/profile?tab=integrations&atlassian=error');
  }

  console.log(`✅ Found ${resources.length} Atlassian resource(s)`);

  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

  // Step 3: Store tokens with appropriate status based on resource count
  // Both single-site and multi-site users go through the same flow now
  const isSingleSite = resources.length === 1;
  const pendingSelectionExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

  const atlassianConnect = {
    accessToken: encryptToken(tokenData.access_token)!,
    refreshToken: encryptToken(refreshToken)!,
    expiresAt,
    siteName: '', // Will be set after finalization
    resources: resources.map(r => ({
      id: r.id,
      name: r.name,
      url: r.url ?? '',
      scopes: r.scopes,
      resourceType: r.resourceType,
      productType: r.productType,
    })),
    connectedAt: new Date(),
    status: 'pending_site_selection' as const,
    pendingSelectionExpiresAt,
    // For single-site users, pre-select the resource so finalize can auto-complete
    selectedResourceId: isSingleSite ? resources[0].id : undefined,
  };

  await userRepository.update({
    id: userId,
    atlassianConnect,
  });

  console.log(`✅ Tokens stored for user ${userId}, status: pending_site_selection`);

  auditLogger.success({ resourceCount: resources.length, isSingleSite });

  // Step 4: Redirect based on resource count
  if (isSingleSite) {
    console.log('🔀 Single site detected, redirecting to auto-finalize...');
    return res.redirect(`/api/mcp-servers/atlassian/finalize?auto=true`);
  } else {
    console.log(`🔀 Multiple sites (${resources.length}) detected, redirecting to site selection...`);
    return res.redirect('/integrations/atlassian/select-site');
  }
});

export default handler;
