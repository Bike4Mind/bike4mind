import { describe, it, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@server/utils/invokeMcpHandler', () => ({ invokeMcpHandler: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@server/utils/mcpEnv', () => ({ buildMcpEnvVariables: vi.fn(async () => [{ key: 'K', value: 'V' }]) }));

import { getMcpClientAdapter } from './getMcpClientAdapter';

const server = { id: 's1', name: 'atlassian', userId: 'u1' } as any;

describe('getMcpClientAdapter', () => {
  beforeEach(() => invokeMock.mockReset());

  it('exposes the server name', async () => {
    const client = await getMcpClientAdapter(server);
    expect(client.serverName).toBe('atlassian');
  });

  it('callTool invokes the handler with a callTool payload', async () => {
    invokeMock.mockResolvedValue({ ok: true });
    const client = await getMcpClientAdapter(server);
    await client.callTool('jira_list_projects', { max: 5 });
    expect(invokeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 's1',
        name: 'atlassian',
        action: 'callTool',
        toolName: 'jira_list_projects',
        toolArgs: { max: 5 },
      })
    );
  });
});
