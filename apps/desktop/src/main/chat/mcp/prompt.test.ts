import { describe, expect, it } from 'vitest';
import type { McpServerState } from '@shared/mcp';
import { desktopAppGuidance, mcpServerLines } from './prompt';

function server(overrides: Partial<McpServerState>): McpServerState {
  return {
    id: 'id',
    name: 'srv',
    transport: 'stdio',
    enabled: true,
    status: 'idle',
    envKeys: [],
    headerKeys: [],
    tools: [],
    ...overrides,
  };
}

describe('mcpServerLines', () => {
  it('says none configured when there are no servers', () => {
    expect(mcpServerLines([])).toEqual(['MCP servers configured in this app: none configured.']);
  });

  it('lists every server with its state', () => {
    const text = mcpServerLines([
      server({ name: 'a', status: 'connected', tools: [{ name: 'mcp__a_x', remoteName: 'x' }] }),
      server({ name: 'b', status: 'connecting' }),
      server({ name: 'c', status: 'failed', error: 'Could not run "uvx".\nsecond line' }),
      server({ name: 'd', status: 'disabled', enabled: false }),
      server({ name: 'e', status: 'idle' }),
    ]).join('\n');

    expect(text).toContain('- a: connected, 1 tool');
    expect(text).toContain('- b: connecting');
    expect(text).toContain('- c: failed: Could not run "uvx". second line');
    expect(text).toContain('- d: disabled');
    expect(text).toContain('- e: not connected');
  });

  it('caps the list and truncates a long error to one line', () => {
    const many = Array.from({ length: 25 }, (_, index) => server({ name: `s${index}` }));
    const lines = mcpServerLines(many);
    expect(lines).toHaveLength(22);
    expect(lines[21]).toContain('and 5 more');

    const [, line] = mcpServerLines([server({ status: 'failed', error: 'x'.repeat(500) })]);
    expect(line.length).toBeLessThan(200);
  });

  it('is the same text for the same settled state, so the cached prefix holds', () => {
    const state = [server({ name: 'a', status: 'connected', stderr: 'pid 123', tools: [] })];
    const again = [server({ name: 'a', status: 'connected', stderr: 'pid 456', tools: [] })];
    expect(mcpServerLines(state)).toEqual(mcpServerLines(again));
  });
});

describe('desktopAppGuidance', () => {
  it('names this app and never sends the user to another app for settings', () => {
    for (const mode of ['manage', 'read', null] as const) {
      const text = desktopAppGuidance(mode).join('\n');
      expect(text).toContain('Bike4Mind desktop app');
      expect(text).not.toMatch(/Settings\s*->\s*Computer use/i);
      expect(text).not.toMatch(/\+\s*->\s*Devices/);
    }
  });

  it('promises the add tools only where a user can approve them', () => {
    expect(desktopAppGuidance('manage').join('\n')).toContain('mcp_add_server');
    expect(desktopAppGuidance('read').join('\n')).not.toContain('mcp_add_server');
    expect(desktopAppGuidance(null).join('\n')).not.toContain('mcp__');
  });
});
