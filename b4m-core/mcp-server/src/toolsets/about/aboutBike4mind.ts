import { z } from 'zod';
import { envelope, ok } from '../../results';
import { defineTool } from '../../tool';

export const aboutBike4mind = defineTool({
  name: 'about_bike4mind',
  title: 'About Bike4Mind',
  description:
    'Explains what Bike4Mind is, how to get an MCP key, and how to connect this server from Claude Code or over stdio. ' +
    'Static text; needs no key.',
  toolset: 'about',
  scope: null,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {},
  outputSchema: envelope(
    z.object({
      summary: z.string(),
      app_url: z.string(),
      get_a_key: z.string(),
      install: z.object({ claude_code_http: z.string(), stdio: z.string() }),
    })
  ),
  async handler(_args, ctx) {
    const base = ctx.baseUrl.replace(/\/+$/, '');
    return ok({
      summary:
        'Bike4Mind is an AI workspace: chat with models from several providers, keep notebooks and files, run ' +
        'agents, and publish pages. Everything is also reachable through an API and through this MCP server.',
      app_url: base,
      get_a_key: `Sign in at ${base}, open Profile > API Keys and create a key. Some tools need a key with specific scopes and will say what is missing when called.`,
      install: {
        claude_code_http: `claude mcp add --transport http bike4mind ${base}/mcp --header "Authorization: Bearer <your key>"`,
        stdio: 'b4m mcp serve',
      },
    });
  },
});
