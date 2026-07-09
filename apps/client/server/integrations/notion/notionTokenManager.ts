import { userRepository, mcpServerRepository } from '@bike4mind/database';
import { McpServerName } from '@bike4mind/common';
import { decryptToken, encryptEnvVariables } from '@server/security/tokenEncryption';
import { NOTION_API_BASE_URL } from './notionConfig';

const TOKEN_VALIDATION_TIMEOUT = 10000;

/**
 * Signals expected token revocation, distinct from unexpected errors.
 */
export class NotionReconnectRequiredError extends Error {
  constructor(message = 'Your Notion connection has been revoked. Please reconnect your account.') {
    super(message);
    this.name = 'NotionReconnectRequiredError';
  }
}

interface NotionTokenResult {
  accessToken: string;
  workspaceId: string;
  workspaceName: string;
}

export class NotionTokenManager {
  /**
   * Notion tokens don't expire, so validity only means "not revoked" - checked via a test API call.
   */
  private static async validateToken(accessToken: string): Promise<boolean> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TOKEN_VALIDATION_TIMEOUT);
    try {
      const response = await fetch(`${NOTION_API_BASE_URL}/users/me`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return response.ok;
    } catch {
      clearTimeout(timeoutId);
      return false;
    }
  }

  /**
   * Returns the access token string, or throws if invalid/revoked.
   */
  static async ensureValidToken(userId: string): Promise<string> {
    const result = await this.getValidTokens(userId);
    if (!result) {
      throw new Error('Failed to get valid Notion tokens');
    }
    return result.accessToken;
  }

  /**
   * Gets tokens with workspace metadata after confirming the token is still active.
   * Returns null on error instead of throwing.
   */
  static async getValidTokens(userId: string): Promise<NotionTokenResult | null> {
    try {
      const user = await userRepository.findByIdWithNotionToken(userId);

      if (!user || !user.notionConnect) {
        console.error('Notion connection not found for user:', userId);
        return null;
      }

      const { notionConnect } = user;

      // Check if the connection needs to be re-established
      if (notionConnect.status === 'needs_reconnect') {
        throw new NotionReconnectRequiredError();
      }

      const accessToken = decryptToken(notionConnect.accessToken);
      if (!accessToken) {
        console.error('Failed to decrypt Notion access token for user:', userId);
        return null;
      }

      const isValid = await this.validateToken(accessToken);

      if (!isValid) {
        console.log('Notion token is invalid/revoked. Marking for reconnection.');

        await userRepository.update({
          id: userId,
          notionConnect: {
            ...notionConnect,
            status: 'needs_reconnect',
            disconnectReason: 'Your Notion connection has been revoked. Please reconnect your account.',
          },
        });

        throw new NotionReconnectRequiredError();
      }

      console.log('Using valid Notion token');
      return {
        accessToken,
        workspaceId: notionConnect.workspaceId,
        workspaceName: notionConnect.workspaceName,
      };
    } catch (error) {
      if (error instanceof NotionReconnectRequiredError) {
        throw error;
      }
      console.error('Error in getValidTokens:', error);
      return null;
    }
  }

  /**
   * Updates the MCP server with the current Notion credentials.
   * Called after initial OAuth or when tokens need to be synced.
   */
  static async syncMcpServer(userId: string, accessToken: string, workspaceId: string): Promise<void> {
    // Read user's Notion settings for write access and root page (no token needed here)
    const user = await userRepository.findById(userId);
    const notionConnect = user?.notionConnect;

    const envVars: Array<{ key: string; value: string }> = [
      { key: 'NOTION_ACCESS_TOKEN', value: accessToken },
      { key: 'NOTION_WORKSPACE_ID', value: workspaceId },
      { key: 'NOTION_WRITE_ENABLED', value: notionConnect?.writeEnabled ? 'true' : 'false' },
    ];

    if (notionConnect?.rootPageId) {
      envVars.push({ key: 'NOTION_ROOT_PAGE_ID', value: notionConnect.rootPageId });
    }

    // Page-level access control
    const accessMode = notionConnect?.accessMode ?? 'all';
    envVars.push({ key: 'NOTION_ACCESS_MODE', value: accessMode });

    if (accessMode === 'selected' && notionConnect?.allowedPages?.length) {
      // Pass only id + access to the MCP server (title/type not needed at runtime)
      const compactPages = notionConnect.allowedPages.map(p => ({ id: p.id, access: p.access }));
      envVars.push({ key: 'NOTION_ALLOWED_PAGES', value: JSON.stringify(compactPages) });
    }

    if (notionConnect?.excludedPageIds?.length) {
      envVars.push({ key: 'NOTION_EXCLUDED_PAGE_IDS', value: notionConnect.excludedPageIds.join(',') });
    }

    const envVariables = encryptEnvVariables(envVars);

    let notionServer = await mcpServerRepository.findOne({
      name: McpServerName.Notion,
      userId,
    });

    if (notionServer) {
      await mcpServerRepository.update({
        id: notionServer.id,
        envVariables,
        enabled: true,
      });
      console.log('Updated existing Notion MCP server');
    } else {
      notionServer = await mcpServerRepository.create({
        userId,
        name: McpServerName.Notion,
        envVariables,
        enabled: true,
        tools: [],
      });
      console.log('Created new Notion MCP server');
    }

    // Try to get and store available tools (non-blocking)
    try {
      const { invokeMcpHandler } = await import('@server/utils/invokeMcpHandler');
      const result = await invokeMcpHandler<unknown>({
        envVariables: envVars,
        name: 'notion',
        action: 'getTools',
        userId,
      });

      const tools = Array.isArray(result) ? result : [result].flat();
      if (notionServer) {
        await mcpServerRepository.update({
          id: notionServer.id,
          tools: tools.map((tool: { name: string }) => tool.name),
          toolSchemas: tools as Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>,
        });
      }
      console.log(`Notion MCP server configured with ${tools.length} tools`);
    } catch (toolsError) {
      console.warn('Failed to get Notion MCP tools, but connection saved:', toolsError);
    }
  }
}
