import { describe, it, expect, vi } from 'vitest';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BRIEFCASE_CATALOG_QUERIES } from '@bike4mind/common';
import type { B4mApiClient, RawBriefcasePrompt } from './b4mApiClient';
import { registerPrompts } from './prompts';
import { logger } from '../utils/Logger';

const NOW = new Date('2026-10-08T12:34:56.000Z');
const GENERAL_ID = 'a'.repeat(24);
const PERSONAL_ID = 'b'.repeat(24);

const mockClient = (overrides: Partial<Record<keyof B4mApiClient, unknown>>): B4mApiClient =>
  ({ baseURL: 'http://localhost:3000', ...overrides }) as unknown as B4mApiClient;

const featureDisabled = () =>
  new AxiosError('forbidden', undefined, {} as InternalAxiosRequestConfig, {}, {
    status: 403,
    statusText: '',
    data: { code: 'FEATURE_DISABLED' },
    headers: {},
    config: {} as InternalAxiosRequestConfig,
  } as AxiosResponse);

/** Drive the prompts surface over the real MCP protocol, as a client would. */
const connect = async (client: B4mApiClient) => {
  const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { prompts: {} } });
  registerPrompts(server, client, () => NOW);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  return mcpClient;
};

const general: RawBriefcasePrompt = { id: GENERAL_ID, name: 'Summarize', description: 'Summarize a doc' };
const personal: RawBriefcasePrompt = { id: PERSONAL_ID, name: 'My standup' };

describe('registerPrompts', () => {
  it('advertises the prompts capability', async () => {
    const mcpClient = await connect(mockClient({}));
    expect(mcpClient.getServerCapabilities()?.prompts).toBeDefined();
  });

  describe('prompts/list', () => {
    it('lists the catalog in category order, named by id and titled by name', async () => {
      const getBriefcaseCatalog = vi.fn().mockResolvedValue({ general: [general], personal: [personal] });
      const mcpClient = await connect(mockClient({ getBriefcaseCatalog }));

      const { prompts } = await mcpClient.listPrompts();

      expect(getBriefcaseCatalog).toHaveBeenCalledWith(BRIEFCASE_CATALOG_QUERIES);
      expect(prompts.map(p => [p.name, p.title, p.description])).toEqual([
        [GENERAL_ID, 'Summarize', 'Summarize a doc'],
        [PERSONAL_ID, 'My standup', undefined],
      ]);
    });

    it('offers the caller-supplied context keys as optional arguments, never the clock keys', async () => {
      const mcpClient = await connect(
        mockClient({ getBriefcaseCatalog: vi.fn().mockResolvedValue({ general: [general] }) })
      );

      const [prompt] = (await mcpClient.listPrompts()).prompts;

      expect(prompt.arguments?.map(a => a.name)).toEqual(['userName', 'userEmail', 'userRole', 'organization']);
      expect(prompt.arguments?.every(a => a.required === false)).toBe(true);
    });

    it('lists a prompt returned under two category keys once', async () => {
      const mcpClient = await connect(
        mockClient({ getBriefcaseCatalog: vi.fn().mockResolvedValue({ general: [general], writing: [general] }) })
      );

      expect((await mcpClient.listPrompts()).prompts).toHaveLength(1);
    });

    it('degrades to an empty list and logs the mapped error when the catalog fails', async () => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const mcpClient = await connect(
        mockClient({ getBriefcaseCatalog: vi.fn().mockRejectedValue(featureDisabled()) })
      );

      expect((await mcpClient.listPrompts()).prompts).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('feature disabled on this Bike4Mind instance'));
    });
  });

  describe('prompts/get', () => {
    const withText = (promptText: string) =>
      mockClient({ getBriefcasePrompt: vi.fn().mockResolvedValue({ ...general, promptText }) });

    it('substitutes supplied arguments and fills the clock keys server-side', async () => {
      const mcpClient = await connect(withText('Hi {{userName}}, today is {{currentDate}} ({{currentYear}}).'));

      const result = await mcpClient.getPrompt({ name: GENERAL_ID, arguments: { userName: 'Ada' } });

      expect(result.description).toBe('Summarize a doc');
      expect(result.messages).toEqual([
        { role: 'user', content: { type: 'text', text: 'Hi Ada, today is 2026-10-08 (2026).' } },
      ]);
    });

    it('leaves unsupplied and unknown placeholders in place', async () => {
      const mcpClient = await connect(withText('{{userName}} at {{organization}}: {{topic}}'));

      const result = await mcpClient.getPrompt({ name: GENERAL_ID, arguments: { topic: 'ignored' } });

      expect(result.messages[0].content).toEqual({ type: 'text', text: '{{userName}} at {{organization}}: {{topic}}' });
    });

    it('does not let an argument override a clock key', async () => {
      const mcpClient = await connect(withText('{{currentDate}}'));

      const result = await mcpClient.getPrompt({ name: GENERAL_ID, arguments: { currentDate: '1999-01-01' } });

      expect(result.messages[0].content).toEqual({ type: 'text', text: '2026-10-08' });
    });

    it('rejects a name that is not a prompt id without calling the API', async () => {
      const getBriefcasePrompt = vi.fn();
      const mcpClient = await connect(mockClient({ getBriefcasePrompt }));

      await expect(mcpClient.getPrompt({ name: '../catalog' })).rejects.toThrow('Prompt ../catalog not found');
      expect(getBriefcasePrompt).not.toHaveBeenCalled();
    });

    it('surfaces a mapped API error', async () => {
      const mcpClient = await connect(mockClient({ getBriefcasePrompt: vi.fn().mockRejectedValue(featureDisabled()) }));

      await expect(mcpClient.getPrompt({ name: GENERAL_ID })).rejects.toThrow(
        'feature disabled on this Bike4Mind instance'
      );
    });
  });
});
