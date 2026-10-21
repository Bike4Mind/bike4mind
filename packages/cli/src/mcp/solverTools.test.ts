import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { B4mApiClient } from './b4mApiClient';
import { buildMcpServer, buildStdioMcpServer } from './server';

const options = { baseURL: 'http://localhost:3000', apiKey: 'b4m_live_key', version: '0.0.0' };

const catalog = {
  family: { familyIds: ['maxcut', 'knapsack'], solverIds: ['greedy', 'tabu'] },
  scheduling: { solverIds: ['greedy', 'ant-colony'] },
  defaultSolverIds: ['greedy', 'tabu'],
  limits: { maxSolversPerRequest: 4, defaultTimeoutMs: 5000, maxTimeoutMs: 15000, maxTotalBudgetMs: 20000 },
};

async function connect(server: Awaited<ReturnType<typeof buildStdioMcpServer>>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const toolNames = async (client: Client) => (await client.listTools()).tools.map(t => t.name);

const BOTH_SCOPES = ['notebooks:read', 'optihashi:read', 'optihashi:compute'];

describe('stdio solver tools', () => {
  beforeEach(() => {
    vi.spyOn(B4mApiClient.prototype, 'getOwnKeyScopes').mockResolvedValue(BOTH_SCOPES);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists the solver tools for an entitled, scoped caller', async () => {
    vi.spyOn(B4mApiClient.prototype, 'getSolverCatalog').mockResolvedValue(catalog);

    const client = await connect(await buildStdioMcpServer(options));
    const names = await toolNames(client);

    expect(names).toEqual(expect.arrayContaining(['optihashi_solvers', 'optihashi_solve', 'list_notebooks']));
  });

  it('builds the solve schema from the server roster and limits', async () => {
    vi.spyOn(B4mApiClient.prototype, 'getSolverCatalog').mockResolvedValue(catalog);

    const client = await connect(await buildStdioMcpServer(options));
    const solve = (await client.listTools()).tools.find(t => t.name === 'optihashi_solve')!;
    const props = solve.inputSchema.properties as Record<string, Record<string, unknown>>;

    expect(props.familyId.enum).toEqual(['maxcut', 'knapsack']);
    expect((props.solverIds.items as { enum: string[] }).enum).toEqual(['greedy', 'tabu', 'ant-colony']);
    expect(props.solverIds.maxItems).toBe(4);
    expect(props.timeoutMs.maximum).toBe(15000);
    expect(solve.inputSchema.required).toEqual(['problem']);
  });

  it('forwards a solve call to the race route and returns its result', async () => {
    vi.spyOn(B4mApiClient.prototype, 'getSolverCatalog').mockResolvedValue(catalog);
    const race = vi.spyOn(B4mApiClient.prototype, 'runSolverRace').mockResolvedValue({ winner: { solverId: 'tabu' } });

    const client = await connect(await buildStdioMcpServer(options));
    const result = await client.callTool({
      name: 'optihashi_solve',
      arguments: { familyId: 'maxcut', problem: { family: 'maxcut' }, solverIds: ['tabu'] },
    });

    expect(race).toHaveBeenCalledWith({ familyId: 'maxcut', problem: { family: 'maxcut' }, solverIds: ['tabu'] });
    expect(result.structuredContent).toEqual({ winner: { solverId: 'tabu' } });
  });

  it('serves the roster tool from the startup catalog', async () => {
    vi.spyOn(B4mApiClient.prototype, 'getSolverCatalog').mockResolvedValue(catalog);

    const client = await connect(await buildStdioMcpServer(options));
    const result = await client.callTool({ name: 'optihashi_solvers', arguments: {} });

    expect(result.structuredContent).toEqual(catalog);
  });

  it('surfaces a server refusal of the problem as a tool error', async () => {
    vi.spyOn(B4mApiClient.prototype, 'getSolverCatalog').mockResolvedValue(catalog);
    vi.spyOn(B4mApiClient.prototype, 'runSolverRace').mockRejectedValue(new Error('Invalid problem'));

    const client = await connect(await buildStdioMcpServer(options));
    const result = await client.callTool({ name: 'optihashi_solve', arguments: { problem: {} } });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'Invalid problem' }]);
  });

  it.each([
    [
      'a key without the compute scope (403)',
      Object.assign(new Error('forbidden'), { isAxiosError: true, response: { status: 403, data: {} } }),
    ],
    [
      'an instance without the feature (404)',
      Object.assign(new Error('not found'), { isAxiosError: true, response: { status: 404, data: {} } }),
    ],
    ['an unreachable server', new Error('connect ECONNREFUSED')],
  ])('offers no solver tools and keeps the rest for %s', async (_label, failure) => {
    vi.spyOn(B4mApiClient.prototype, 'getSolverCatalog').mockRejectedValue(failure);

    const client = await connect(await buildStdioMcpServer(options));
    const names = await toolNames(client);

    expect(names).toContain('list_notebooks');
    expect(names.filter(n => n.startsWith('optihashi_'))).toEqual([]);
  });

  it.each([
    ['read only', ['optihashi:read']],
    ['compute only', ['optihashi:compute']],
    ['neither', ['notebooks:read']],
    ['a key that could not be identified', []],
  ])('offers no solver tools to a key holding %s, even though the route answers', async (_label, scopes) => {
    vi.spyOn(B4mApiClient.prototype, 'getOwnKeyScopes').mockResolvedValue(scopes);
    vi.spyOn(B4mApiClient.prototype, 'getSolverCatalog').mockResolvedValue(catalog);

    const client = await connect(await buildStdioMcpServer(options));
    const names = await toolNames(client);

    expect(names).toContain('list_notebooks');
    expect(names.filter(n => n.startsWith('optihashi_'))).toEqual([]);
  });

  it('offers the tools to a login (non API key) caller, which has no scopes to check', async () => {
    vi.spyOn(B4mApiClient.prototype, 'getOwnKeyScopes').mockResolvedValue(undefined);
    vi.spyOn(B4mApiClient.prototype, 'getSolverCatalog').mockResolvedValue(catalog);

    const client = await connect(await buildStdioMcpServer(options));

    expect(await toolNames(client)).toContain('optihashi_solve');
  });

  it('offers no solver tools when the key scope lookup fails', async () => {
    vi.spyOn(B4mApiClient.prototype, 'getOwnKeyScopes').mockRejectedValue(new Error('boom'));
    vi.spyOn(B4mApiClient.prototype, 'getSolverCatalog').mockResolvedValue(catalog);

    const client = await connect(await buildStdioMcpServer(options));

    expect((await toolNames(client)).filter(n => n.startsWith('optihashi_'))).toEqual([]);
  });

  it('offers no solver tools when the catalog is malformed', async () => {
    vi.spyOn(B4mApiClient.prototype, 'getSolverCatalog').mockResolvedValue({ family: {} });

    const client = await connect(await buildStdioMcpServer(options));

    expect((await toolNames(client)).filter(n => n.startsWith('optihashi_'))).toEqual([]);
  });

  it('keeps private overlay and engine packages out of the published MCP sources', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const sources = readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const importing = sources.filter(f =>
      /from\s+['"]@bike4mind\/(premium-|optihashi-engine)/.test(readFileSync(join(dir, f), 'utf8'))
    );

    expect(sources).toContain('solverTools.ts');
    expect(importing).toEqual([]);
  });

  it('never offers or fetches them on the plain (HTTP) builder', async () => {
    const fetchCatalog = vi.spyOn(B4mApiClient.prototype, 'getSolverCatalog').mockResolvedValue(catalog);

    const client = await connect(buildMcpServer(options));

    expect((await toolNames(client)).filter(n => n.startsWith('optihashi_'))).toEqual([]);
    expect(fetchCatalog).not.toHaveBeenCalled();
  });
});
