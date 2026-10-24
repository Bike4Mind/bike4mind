import { describe, it, expect, vi } from 'vitest';

const serverExecute = vi.hoisted(() => vi.fn());
vi.mock('./ServerToolExecutor', () => ({
  ServerToolExecutor: class {
    executeTool(...args: unknown[]) {
      return serverExecute(...args);
    }
  },
}));

import { executeTool } from './ToolRouter';
import type { ApiClient } from '../auth/ApiClient';

// Local tools never touch the ApiClient, so a bare stub is sufficient here.
const apiClient = {} as ApiClient;

// math_evaluate is a registered LOCAL tool - executeTool invokes the provided
// localToolFn without any network.
const LOCAL_TOOL = 'math_evaluate';

describe('executeTool output', () => {
  // Redaction and the output cap belong to the gateway's output stage, which wraps every call.
  it('returns the local result verbatim', async () => {
    const secret = 'ghp_' + 'b'.repeat(36);
    const result = await executeTool(LOCAL_TOOL, {}, apiClient, async () => `token is ${secret}`);
    expect(result).toBe(`token is ${secret}`);
  });
});

describe('executeTool routing', () => {
  it.each(['mcp__demo__ping', 'skill', 'find_definition', 'get_file_structure', 'some_plugin_tool'])(
    'runs %s through its local implementation',
    async toolName => {
      expect(await executeTool(toolName, { q: 1 }, apiClient, async args => `ran with ${JSON.stringify(args)}`)).toBe(
        'ran with {"q":1}'
      );
    }
  );

  it('routes decide to the server and never reaches the local implementation', async () => {
    serverExecute.mockResolvedValue('{"id":"dec_1","model":"gpt-6-luna","answers":[]}');
    const local = vi.fn(async () => 'ran locally');

    const result = await executeTool('decide', { input: 'x', questions: [] }, apiClient, local);

    expect(result).toBe('{"id":"dec_1","model":"gpt-6-luna","answers":[]}');
    expect(serverExecute).toHaveBeenCalledWith('decide', { input: 'x', questions: [] });
    expect(local).not.toHaveBeenCalled();
  });

  it('rejects a non-server tool with no implementation', async () => {
    await expect(executeTool('mcp__demo__ping', {}, apiClient)).rejects.toThrow('Unknown tool: mcp__demo__ping');
  });
});
