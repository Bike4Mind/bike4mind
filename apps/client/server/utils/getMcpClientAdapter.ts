import type { IMcpServerDocument } from '@bike4mind/common';
import type { MCPClient } from '@bike4mind/mcp';
import { buildMcpEnvVariables } from '@server/utils/mcpEnv';
import { invokeMcpHandler } from '@server/utils/invokeMcpHandler';

// Shared MCP client adapter: lazily invokes the mcpHandler Lambda per action.
// Used by the chat queue (questProcessor), the Slack queue (slackQuestProcessor),
// and Agent Mode (agentExecutor) so every path builds MCP clients identically.
// Keep in sync with the structurally-different raw-LambdaClient copy in
// chatCompletionDefaults.ts (pre-existing drift; de-dup is a separate task).
export const getMcpClientAdapter = async (
  mcpServer: IMcpServerDocument
): Promise<{
  serverName: string;
  getTools: () => Promise<MCPClient['tools']>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool args/results are provider-shaped, validated by the MCP server
  callTool: (toolName: string, toolArgs: any) => Promise<any>;
}> => {
  const buildPayload = async (action: string, toolName?: string, toolArgs?: unknown) => ({
    id: mcpServer.id,
    envVariables: await buildMcpEnvVariables(mcpServer),
    name: mcpServer.name,
    action,
    toolName,
    toolArgs,
    // Attribute the mcpHandler call to the server's owner so IntegrationAuditLogger
    // records a real userId (invokeMcpHandler feeds payload.userId into the audit log).
    userId: mcpServer.userId,
  });

  return {
    serverName: mcpServer.name,
    getTools: async () => invokeMcpHandler<MCPClient['tools']>(await buildPayload('getTools')),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    callTool: async (toolName: string, toolArgs: any) =>
      invokeMcpHandler(await buildPayload('callTool', toolName, toolArgs)),
  };
};
