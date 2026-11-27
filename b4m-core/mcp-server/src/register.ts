import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './context';
import { jobTools } from './jobs/tools';
import { fail } from './results';
import type { Tool } from './tool';
import { aboutTools } from './toolsets/about';

/** Every tool the package ships. Add a toolset's tools here. */
export const ALL_TOOLS: readonly Tool[] = [...aboutTools, ...jobTools];

/** Tools `ctx` may see: toolset first, then scope. Pure, so listing is deterministic and needs no network. */
export function selectTools(ctx: Pick<ToolContext, 'toolsets' | 'scopes'>, tools: readonly Tool[] = ALL_TOOLS): Tool[] {
  const scopes = ctx.scopes;
  return tools
    .filter(t => ctx.toolsets.has(t.toolset))
    .filter(t => t.scope === null || scopes === 'all' || scopes.includes(t.scope))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Registers the tools `ctx` allows on `server` and returns their names. */
export function registerBike4MindTools(server: McpServer, ctx: ToolContext): string[] {
  const selected = selectTools(ctx);
  for (const tool of selected) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      async args => {
        try {
          return await tool.handler(args as Record<string, unknown>, ctx);
        } catch (error) {
          return fail(`${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    );
  }
  return selected.map(t => t.name);
}
