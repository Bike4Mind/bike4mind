import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@server/utils/errors';
import { userRepository, mcpServerRepository } from '@bike4mind/database';
import { McpServerName } from '@bike4mind/common';
import { z } from 'zod';
import { decryptToken, encryptEnvVariables } from '@server/security/tokenEncryption';

/**
 * /api/mcp-servers/atlassian/finalize
 *
 * Finalizes the Atlassian connection by setting up the MCP server.
 *
 * Supports two modes:
 * 1. GET ?auto=true - Auto-finalize for single-site users (redirected from callback)
 * 2. POST { resourceId } - Manual selection for multi-site users
 *
 * Prerequisites:
 * - User must be authenticated
 * - User must have atlassianConnect with status 'pending_site_selection'
 * - For POST: The selected resourceId must exist in the user's resources list
 * - For GET auto: User must have selectedResourceId pre-set by callback
 */

const FinalizeRequestSchema = z.object({
  resourceId: z.string().min(1, 'Resource ID is required'),
});

const buildConfluenceSiteUrl = (url: string | undefined): string => {
  if (!url) {
    throw new BadRequestError(
      'Atlassian did not return a site URL for the selected resource. Please ensure Confluence is enabled for your site and try again.'
    );
  }

  return url.endsWith('/wiki') ? url : `${url}/wiki`;
};

/**
 * Shared logic for finalizing Atlassian connection
 */
const finalizeConnection = async (userId: string, resourceId: string) => {
  const user = await userRepository.findById(userId);

  if (!user) {
    throw new BadRequestError('User not found');
  }

  if (!user.atlassianConnect) {
    throw new BadRequestError(
      'No Atlassian connection found. Please start the connection process again from the integrations page.'
    );
  }

  if (user.atlassianConnect.status !== 'pending_site_selection') {
    // Already connected - this is fine for idempotency
    if (user.atlassianConnect.status === 'connected') {
      console.log(`[Atlassian Finalize] User ${userId} already connected, skipping`);
      return {
        success: true,
        siteName: user.atlassianConnect.siteName,
        siteUrl: '',
        message: 'Already connected',
        alreadyConnected: true,
      };
    }
    throw new BadRequestError(
      'Atlassian connection is not pending site selection. Current status: ' +
        (user.atlassianConnect.status || 'unknown')
    );
  }

  const selectedResource = user.atlassianConnect.resources?.find(r => r.id === resourceId);

  if (!selectedResource) {
    throw new BadRequestError(
      'Selected site not found in your Atlassian account. Please reconnect your Atlassian account.'
    );
  }

  const siteUrl = buildConfluenceSiteUrl(selectedResource.url);

  const updatedAtlassianConnect = {
    ...user.atlassianConnect,
    siteName: selectedResource.name,
    status: 'connected' as const,
    selectedResourceId: resourceId,
    // Clear pending selection expiry
    pendingSelectionExpiresAt: undefined,
  };

  await userRepository.update({
    id: userId,
    atlassianConnect: updatedAtlassianConnect,
  });

  console.log(`[Atlassian Finalize] User ${userId} selected site: ${selectedResource.name} (${resourceId})`);

  // Create or update MCP server with selected resource
  try {
    let atlassianServer = await mcpServerRepository.findOne({
      name: McpServerName.Atlassian,
      userId: userId,
    });

    // Decrypt the stored access token for use in envVariables and MCP invocation
    const plaintextAccessToken = decryptToken(user.atlassianConnect.accessToken)!;

    const plaintextEnvVariables = [
      { key: 'ATLASSIAN_ACCESS_TOKEN', value: plaintextAccessToken },
      { key: 'ATLASSIAN_CLOUD_ID', value: resourceId },
      { key: 'ATLASSIAN_SITE_URL', value: siteUrl },
    ];
    const encryptedEnvVariables = encryptEnvVariables(plaintextEnvVariables);

    if (atlassianServer) {
      atlassianServer = await mcpServerRepository.update({
        id: atlassianServer.id,
        envVariables: encryptedEnvVariables,
        enabled: true,
      });
      console.log('[Atlassian Finalize] Updated existing MCP server');
    } else {
      atlassianServer = await mcpServerRepository.create({
        userId: userId,
        name: McpServerName.Atlassian,
        envVariables: encryptedEnvVariables,
        enabled: true,
        tools: [],
      });
      console.log('[Atlassian Finalize] Created new MCP server');
    }

    // Try to get and store available tools (non-blocking)
    try {
      const { invokeMcpHandler } = await import('@server/utils/invokeMcpHandler');
      const result = await invokeMcpHandler<any>({
        envVariables: plaintextEnvVariables,
        name: 'atlassian',
        action: 'getTools',
        userId: userId,
      });

      const tools = Array.isArray(result) ? result : [result].flat();
      if (atlassianServer) {
        await mcpServerRepository.update({
          id: atlassianServer.id,
          tools: tools.map((tool: any) => tool.name),
          toolSchemas: tools,
        });
      }
      console.log(`[Atlassian Finalize] MCP server configured with ${tools.length} tools`);
    } catch (toolsError) {
      console.warn('[Atlassian Finalize] Failed to get MCP tools, but connection saved:', toolsError);
    }
  } catch (mcpError) {
    // Don't fail the finalize if MCP setup fails
    console.error('[Atlassian Finalize] MCP server setup failed, but site selection succeeded:', mcpError);
  }

  return {
    success: true,
    siteName: selectedResource.name,
    siteUrl: siteUrl,
    message: `Successfully connected to ${selectedResource.name}`,
    alreadyConnected: false,
  };
};

const handler = baseApi()
  // GET handler for auto-finalize (single-site users redirected from callback)
  .get(async (req, res) => {
    try {
      const isAuto = req.query.auto === 'true';

      if (!isAuto) {
        return res.status(400).json({ error: 'Invalid request. Use POST for manual finalization.' });
      }

      const userId = req.user.id;

      const user = await userRepository.findById(userId);

      if (!user?.atlassianConnect?.selectedResourceId) {
        console.error('[Atlassian Finalize] Auto-finalize called but no selectedResourceId found');
        return res.redirect('/profile?tab=integrations&atlassian=error');
      }

      const resourceId = user.atlassianConnect.selectedResourceId;
      console.log(`[Atlassian Finalize] Auto-finalizing for user ${userId} with resource ${resourceId}`);

      await finalizeConnection(userId, resourceId);

      return res.redirect('/profile?tab=integrations&atlassian=connected');
    } catch (error) {
      console.error('[Atlassian Finalize] Auto-finalize error:', error);
      return res.redirect('/profile?tab=integrations&atlassian=error');
    }
  })
  // POST handler for manual finalization (multi-site users)
  .post(async (req, res) => {
    try {
      const parseResult = FinalizeRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw new BadRequestError(parseResult.error.issues[0]?.message || 'Invalid request body');
      }

      const { resourceId } = parseResult.data;
      const userId = req.user.id;

      console.log(`[Atlassian Finalize] Manual finalize for user ${userId} with resource ${resourceId}`);

      const result = await finalizeConnection(userId, resourceId);

      res.status(200).json(result);
    } catch (error) {
      console.error('[Atlassian Finalize] Error:', error);

      if (error instanceof BadRequestError) {
        return res.status(400).json({
          error: error.message,
        });
      }

      res.status(500).json({
        error: 'Failed to finalize Atlassian site selection',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

export default handler;
