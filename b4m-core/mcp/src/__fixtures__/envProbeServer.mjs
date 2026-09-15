// Test fixture: a stdio MCP server whose only tool reports its own process environment.
// Used by client.test.ts to prove what MCPClient actually hands a spawned child.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'env-probe', version: '1.0.0' });

server.registerTool('dumpEnv', { description: 'Returns this process environment as JSON' }, async () => ({
  content: [{ type: 'text', text: JSON.stringify(process.env) }],
}));

await server.connect(new StdioServerTransport());
