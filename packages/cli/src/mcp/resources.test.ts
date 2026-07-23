import { describe, it, expect, vi } from 'vitest';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import type { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ListResourcesResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { B4mApiClient } from './b4mApiClient';
import { registerResources } from './resources';
import { logger } from '../utils/Logger';

type ReadCallback = (uri: URL, variables: Record<string, string | string[]>) => Promise<ReadResourceResult>;

interface Registered {
  template: ResourceTemplate;
  metadata: Record<string, unknown>;
  read: ReadCallback;
}

const mockClient = (overrides: Partial<Record<keyof B4mApiClient, unknown>>): B4mApiClient =>
  ({ baseURL: 'http://localhost:3000', ...overrides }) as unknown as B4mApiClient;

const forbidden = () =>
  new AxiosError('forbidden', undefined, {} as InternalAxiosRequestConfig, {}, {
    status: 403,
    statusText: '',
    data: {},
    headers: {},
    config: {} as InternalAxiosRequestConfig,
  } as AxiosResponse);

/** Mirrors `collectTools` in tools.test.ts: capture registrations off a stub server. */
const collectResources = (client: B4mApiClient) => {
  const registered = new Map<string, Registered>();
  const server = {
    registerResource: (
      name: string,
      template: ResourceTemplate,
      metadata: Record<string, unknown>,
      read: ReadCallback
    ) => {
      registered.set(name, { template, metadata, read });
    },
  } as unknown as McpServer;
  registerResources(server, client);
  return registered;
};

const listOf = (entry: Registered): Promise<ListResourcesResult> => {
  const list = entry.template.listCallback;
  if (!list) throw new Error('template registered without a list callback');
  return Promise.resolve(list({} as Parameters<typeof list>[0]));
};

describe('registerResources', () => {
  it('registers exactly the four resource templates', () => {
    expect([...collectResources(mockClient({})).keys()]).toEqual(['notebook', 'file', 'project', 'artifact']);
  });

  it('registers the notebook template as application/json', () => {
    const entry = collectResources(mockClient({})).get('notebook')!;

    expect(entry).toBeDefined();
    expect(entry.template.uriTemplate.toString()).toBe('b4m://notebook/{id}');
    expect(entry.metadata).toMatchObject({ mimeType: 'application/json' });
  });

  it('lists notebooks as resources, falling back to the id when unnamed', async () => {
    const client = mockClient({
      listNotebooks: vi.fn().mockResolvedValue({ data: [{ id: 'n1', name: 'NB' }, { id: 'n2' }], hasMore: false }),
    });

    const result = await listOf(collectResources(client).get('notebook')!);

    // `title` is asserted alongside `name`: the SDK spreads the template metadata
    // under each entry, so an entry without its own title renders as 'Notebook'.
    expect(result.resources).toEqual([
      { uri: 'b4m://notebook/n1', name: 'NB', title: 'NB', mimeType: 'application/json' },
      { uri: 'b4m://notebook/n2', name: 'n2', title: 'n2', mimeType: 'application/json' },
    ]);
  });

  it('caps notebook listing at 100 and takes no caller paging', async () => {
    const listNotebooks = vi.fn().mockResolvedValue({ data: [], hasMore: false });

    await listOf(collectResources(mockClient({ listNotebooks })).get('notebook')!);

    expect(listNotebooks).toHaveBeenCalledWith({ limit: 100 });
  });

  it('degrades a failing notebook list to an empty result and logs the mapped error', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const client = mockClient({ listNotebooks: vi.fn().mockRejectedValue(forbidden()) });

    const result = await listOf(collectResources(client).get('notebook')!);

    expect(result.resources).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "API key forbidden: check the key's scopes and account access (recommended scope: notebooks:read)"
      )
    );
  });

  it('reads one notebook as pretty-printed JSON contents', async () => {
    const notebook = { id: 'n1', name: 'NB' };
    const entry = collectResources(mockClient({ getNotebook: vi.fn().mockResolvedValue(notebook) })).get('notebook')!;

    const result = await entry.read(new URL('b4m://notebook/n1'), { id: 'n1' });

    expect(result.contents).toEqual([
      { uri: 'b4m://notebook/n1', mimeType: 'application/json', text: JSON.stringify(notebook, null, 2) },
    ]);
  });

  it('throws a scoped, mapped error when a notebook read fails', async () => {
    const entry = collectResources(mockClient({ getNotebook: vi.fn().mockRejectedValue(forbidden()) })).get(
      'notebook'
    )!;

    await expect(entry.read(new URL('b4m://notebook/n1'), { id: 'n1' })).rejects.toThrow(
      "API key forbidden: check the key's scopes and account access (recommended scope: notebooks:read)"
    );
  });

  it('registers the file template as application/json', () => {
    const entry = collectResources(mockClient({})).get('file')!;

    expect(entry).toBeDefined();
    expect(entry.template.uriTemplate.toString()).toBe('b4m://file/{id}');
    expect(entry.metadata).toMatchObject({ mimeType: 'application/json' });
  });

  it('lists files as resources keyed on fileName, falling back to the id', async () => {
    const listFiles = vi.fn().mockResolvedValue({
      data: [{ id: 'f1', fileName: 'notes.md' }, { id: 'f2' }],
      hasMore: false,
    });

    const result = await listOf(collectResources(mockClient({ listFiles })).get('file')!);

    expect(listFiles).toHaveBeenCalledWith({ limit: 100 });
    expect(result.resources).toEqual([
      { uri: 'b4m://file/f1', name: 'notes.md', title: 'notes.md', mimeType: 'application/json' },
      { uri: 'b4m://file/f2', name: 'f2', title: 'f2', mimeType: 'application/json' },
    ]);
  });

  it('degrades a failing file list to an empty result without throwing', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const client = mockClient({ listFiles: vi.fn().mockRejectedValue(forbidden()) });

    await expect(listOf(collectResources(client).get('file')!)).resolves.toEqual({ resources: [] });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('recommended scope: files:read'));
  });

  it('reads one file record as JSON contents', async () => {
    const record = { id: 'f1', fileName: 'notes.md', fileUrl: 'https://signed.example/notes.md' };
    const entry = collectResources(mockClient({ getFile: vi.fn().mockResolvedValue(record) })).get('file')!;

    const result = await entry.read(new URL('b4m://file/f1'), { id: 'f1' });

    expect(result.contents).toEqual([
      { uri: 'b4m://file/f1', mimeType: 'application/json', text: JSON.stringify(record, null, 2) },
    ]);
  });

  it('throws a files:read-scoped error when a file read fails', async () => {
    const entry = collectResources(mockClient({ getFile: vi.fn().mockRejectedValue(forbidden()) })).get('file')!;

    await expect(entry.read(new URL('b4m://file/f1'), { id: 'f1' })).rejects.toThrow('recommended scope: files:read');
  });

  it('registers the project template as application/json', () => {
    const entry = collectResources(mockClient({})).get('project')!;

    expect(entry).toBeDefined();
    expect(entry.template.uriTemplate.toString()).toBe('b4m://project/{id}');
    expect(entry.metadata).toMatchObject({ mimeType: 'application/json' });
  });

  it('lists projects as resources keyed on name, falling back to the id', async () => {
    const listProjects = vi.fn().mockResolvedValue({
      data: [{ id: 'p1', name: 'Apollo' }, { id: 'p2' }],
      hasMore: false,
    });

    const result = await listOf(collectResources(mockClient({ listProjects })).get('project')!);

    expect(listProjects).toHaveBeenCalledWith({ limit: 100 });
    expect(result.resources).toEqual([
      { uri: 'b4m://project/p1', name: 'Apollo', title: 'Apollo', mimeType: 'application/json' },
      { uri: 'b4m://project/p2', name: 'p2', title: 'p2', mimeType: 'application/json' },
    ]);
  });

  it('degrades a failing project list to an empty result without throwing', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const client = mockClient({ listProjects: vi.fn().mockRejectedValue(forbidden()) });

    await expect(listOf(collectResources(client).get('project')!)).resolves.toEqual({ resources: [] });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('recommended scope: projects:read'));
  });

  it('reads one project record as JSON contents', async () => {
    const record = { id: 'p1', name: 'Apollo' };
    const entry = collectResources(mockClient({ getProject: vi.fn().mockResolvedValue(record) })).get('project')!;

    const result = await entry.read(new URL('b4m://project/p1'), { id: 'p1' });

    expect(result.contents).toEqual([
      { uri: 'b4m://project/p1', mimeType: 'application/json', text: JSON.stringify(record, null, 2) },
    ]);
  });

  it('throws a projects:read-scoped error when a project read fails', async () => {
    const entry = collectResources(mockClient({ getProject: vi.fn().mockRejectedValue(forbidden()) })).get('project')!;

    await expect(entry.read(new URL('b4m://project/p1'), { id: 'p1' })).rejects.toThrow(
      'recommended scope: projects:read'
    );
  });

  it('registers the artifact template as application/json', () => {
    const entry = collectResources(mockClient({})).get('artifact')!;

    expect(entry).toBeDefined();
    expect(entry.template.uriTemplate.toString()).toBe('b4m://artifact/{id}');
    expect(entry.metadata).toMatchObject({ mimeType: 'application/json' });
  });

  it('lists artifacts as resources keyed on title, falling back to the id', async () => {
    const listArtifacts = vi.fn().mockResolvedValue({
      data: [{ id: 'artifact_a_1', title: 'Chart' }, { id: 'artifact_a_2' }],
      hasMore: false,
    });

    const result = await listOf(collectResources(mockClient({ listArtifacts })).get('artifact')!);

    expect(listArtifacts).toHaveBeenCalledWith({ limit: 100 });
    expect(result.resources).toEqual([
      { uri: 'b4m://artifact/artifact_a_1', name: 'Chart', title: 'Chart', mimeType: 'application/json' },
      {
        uri: 'b4m://artifact/artifact_a_2',
        name: 'artifact_a_2',
        title: 'artifact_a_2',
        mimeType: 'application/json',
      },
    ]);
  });

  it('degrades a failing artifact list to an empty result without throwing', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const client = mockClient({ listArtifacts: vi.fn().mockRejectedValue(forbidden()) });

    await expect(listOf(collectResources(client).get('artifact')!)).resolves.toEqual({ resources: [] });
    // No artifacts:* scope exists, so the hint must stay absent rather than name a proxy.
    expect(errorSpy.mock.calls[0][0]).not.toContain('recommended scope');
  });

  it('reads an artifact with its content as JSON contents', async () => {
    const record = { artifact: { id: 'artifact_a_1', title: 'Chart' }, content: { content: '<svg/>' } };
    const getArtifact = vi.fn().mockResolvedValue(record);
    const entry = collectResources(mockClient({ getArtifact })).get('artifact')!;

    const result = await entry.read(new URL('b4m://artifact/artifact_a_1'), { id: 'artifact_a_1' });

    expect(getArtifact).toHaveBeenCalledWith('artifact_a_1');
    expect(result.contents).toEqual([
      { uri: 'b4m://artifact/artifact_a_1', mimeType: 'application/json', text: JSON.stringify(record, null, 2) },
    ]);
  });

  it('omits a scope hint from an artifact read failure - no artifacts scope exists', async () => {
    const entry = collectResources(mockClient({ getArtifact: vi.fn().mockRejectedValue(forbidden()) })).get(
      'artifact'
    )!;

    await expect(entry.read(new URL('b4m://artifact/artifact_a_1'), { id: 'artifact_a_1' })).rejects.toThrow(
      "API key forbidden: check the key's scopes and account access"
    );
    await expect(entry.read(new URL('b4m://artifact/artifact_a_1'), { id: 'artifact_a_1' })).rejects.toThrow(
      /^(?!.*recommended scope).*$/
    );
  });

  it('isolates a failing list so sibling templates still enumerate', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    const registered = collectResources(
      mockClient({
        listNotebooks: vi.fn().mockResolvedValue({ data: [{ id: 'n1', name: 'NB' }], hasMore: false }),
        listFiles: vi.fn().mockResolvedValue({ data: [{ id: 'f1', fileName: 'notes.md' }], hasMore: false }),
        listProjects: vi.fn().mockRejectedValue(forbidden()),
        listArtifacts: vi.fn().mockResolvedValue({ data: [{ id: 'artifact_a_1', title: 'Chart' }], hasMore: false }),
      })
    );

    // Mirrors the SDK's resources/list loop, which awaits every template in
    // registration order with no try/catch of its own.
    const all: ListResourcesResult['resources'] = [];
    for (const entry of registered.values()) {
      all.push(...(await listOf(entry)).resources);
    }

    expect(all.map(r => r.uri)).toEqual(['b4m://notebook/n1', 'b4m://file/f1', 'b4m://artifact/artifact_a_1']);
  });

  it('round-trips a listed URI through the read callback with the id unmodified', async () => {
    const id = 'artifact_react_chart_1759_0';
    const getArtifact = vi.fn().mockResolvedValue({ artifact: { id } });
    const registered = collectResources(
      mockClient({
        listArtifacts: vi.fn().mockResolvedValue({ data: [{ id, title: 'Chart' }], hasMore: false }),
        getArtifact,
      })
    );
    const entry = registered.get('artifact')!;

    const [listed] = (await listOf(entry)).resources;
    // Exactly what the SDK does on resources/read: normalize, then template-match.
    const variables = entry.template.uriTemplate.match(new URL(listed.uri).toString())!;

    expect(variables).not.toBeNull();
    await entry.read(new URL(listed.uri), variables);

    expect(getArtifact).toHaveBeenCalledWith(id);
  });
});
