import { describe, it, expect, vi } from 'vitest';
import { classifyToolPermission, parseFunctionContract } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { loadAgentMcpTools, withAutoApprovedCustomTools } from './loadAgentMcpTools';

const parsed = parseFunctionContract({
  name: 'beam_midspan_deflection',
  description: 'Midspan deflection of a simply supported beam.',
  inputs: {
    type: 'object',
    additionalProperties: false,
    required: ['load'],
    properties: { load: { type: 'number', unit: 'N/m' } },
  },
  outputs: {
    type: 'object',
    additionalProperties: false,
    required: ['deflection'],
    properties: { deflection: { type: 'number', unit: 'm' } },
  },
});
if (!parsed.ok) throw new Error('fixture contract must parse');
const CONTRACT = parsed.contract;

const fn = (slug: string, approval: string) => ({
  id: `id-${slug}`,
  slug,
  state: 'live',
  enabled: true,
  approval,
  contract: { ...CONTRACT, name: slug },
  createdAt: new Date('2026-11-01T00:00:00Z'),
  pin: { artifactId: 'artifact-1', version: 1 },
});

const h = vi.hoisted(() => ({ offered: [] as Record<string, unknown>[] }));

vi.mock('@bike4mind/server-utils/callableFunctions/access', () => ({
  resolveCallableFunctionsEnabled: vi.fn(async () => true),
}));
vi.mock('@bike4mind/server-utils/callableFunctions/registry', () => ({
  listOfferedCallableFunctions: vi.fn(async () => h.offered),
}));
vi.mock('@bike4mind/server-utils/mcpConnections/customMcpToolHost', () => ({
  customMcpToolHost: { listConnections: vi.fn(async () => []), callTool: vi.fn() },
}));
vi.mock('@bike4mind/database', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  callableFunctionRepository: {
    findBySlugForOwner: vi.fn(async (slug: string) => h.offered.find(entry => entry.slug === slug) ?? null),
  },
}));

import {
  createFunctionToolHost,
  functionAndConnectorToolHost,
} from '@bike4mind/server-utils/callableFunctions/functionToolHost';
import { customMcpToolHost } from '@bike4mind/server-utils/mcpConnections/customMcpToolHost';

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger;

describe('loadAgentMcpTools - callable functions', () => {
  it('seeds a default function so it runs without a card, and holds an always-ask one at the permission card', async () => {
    h.offered = [fn('beam_midspan_deflection', 'default'), fn('asks_first', 'always_ask')];
    const dispatch = vi.fn(async () => ({
      outcome: 'ok' as const,
      outputs: { deflection: 0.004 },
      durationMs: 5,
      callId: 'call-1',
    }));
    const loaded = await loadAgentMcpTools(
      {
        mcpServers: { find: vi.fn(async () => []), update: vi.fn() },
        getMcpClient: vi.fn(),
        customMcp: createFunctionToolHost('agent', { dispatch }),
        logger,
      },
      { userId: 'u1', enableMCPServer: true }
    );

    expect(loaded.customToolNames).toEqual(['fn__beam_midspan_deflection', 'fn__asks_first']);
    expect(loaded.autoApprovedCustomToolNames).toEqual(['fn__beam_midspan_deflection']);
    expect(loaded.approvalRequiredCustomToolNames).toEqual(['fn__asks_first']);

    const approved = withAutoApprovedCustomTools(
      ['fn__asks_first'],
      loaded.autoApprovedCustomToolNames,
      loaded.approvalRequiredCustomToolNames
    );
    expect(classifyToolPermission('fn__beam_midspan_deflection', approved, [])).toBe('allowed');
    expect(classifyToolPermission('fn__asks_first', approved, [])).toBe('needs_approval');

    const beam = loaded.mcpToolsByServer.fn!.find(tool => tool.name === 'fn__beam_midspan_deflection')!;
    const out = await beam.toolFn({ load: 1 });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ functionId: 'id-beam_midspan_deflection', surface: 'agent' })
    );
    expect(out).toContain('"output":{"deflection":0.004}');
  });

  it('offers functions with Enable MCP Server off, without the built-in servers or connectors', async () => {
    h.offered = [fn('beam_midspan_deflection', 'default')];
    const find = vi.fn(async () => []);
    const loaded = await loadAgentMcpTools(
      {
        mcpServers: { find, update: vi.fn() },
        getMcpClient: vi.fn(),
        customMcp: functionAndConnectorToolHost('agent'),
        logger,
      },
      { userId: 'u1', enableMCPServer: false }
    );

    expect(loaded.customToolNames).toEqual(['fn__beam_midspan_deflection']);
    expect(loaded.autoApprovedCustomToolNames).toEqual(['fn__beam_midspan_deflection']);
    expect(find).not.toHaveBeenCalled();
    expect(customMcpToolHost.listConnections).not.toHaveBeenCalled();
  });
});
