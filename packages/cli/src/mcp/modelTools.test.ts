import { describe, it, expect, vi } from 'vitest';
import type { HubGgufBuild, HubModelDetail, InstalledModel, LocalRuntime } from '@bike4mind/local-models';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitRequestSchema, type ElicitRequest, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { OllamaManifestInfo } from '../commands/ollamaRegistry';
import type { HubClient, RuntimeTarget } from '../models/localModels';
import { MODEL_TOOL_NAMES, registerModelTools, type ModelToolsDeps } from './modelTools';

const REPO = 'Qwen/Qwen2.5-0.5B-Instruct-GGUF';
const ENDPOINT = 'https://huggingface.co';
const HOST = 'http://127.0.0.1:11500';

function build(quant: string, sizeBytes: number): HubGgufBuild {
  const path = `qwen2.5-0.5b-instruct-${quant.toLowerCase()}.gguf`;
  return {
    id: path.replace(/\.gguf$/, ''),
    quant,
    label: quant,
    files: [{ path, sizeBytes, sha256: 'a'.repeat(64), url: `${ENDPOINT}/${REPO}/resolve/main/${path}` }],
    sizeBytes,
    split: false,
    complete: true,
    ollamaRef: `hf.co/${REPO}:${quant}`,
    ollamaRefIssue: null,
  };
}

function detail(overrides: Partial<HubModelDetail> = {}): HubModelDetail {
  return {
    id: REPO,
    author: 'Qwen',
    downloads: 1,
    likes: 1,
    updatedAt: null,
    pipelineTag: 'text-generation',
    gated: false,
    private: false,
    licenses: ['apache-2.0'],
    baseModels: [],
    tags: [],
    revision: 'b'.repeat(40),
    licenseName: null,
    licenseLink: null,
    gguf: null,
    builds: [build('Q4_K_M', 491_400_032), build('Q8_0', 675_710_816)],
    projectors: [],
    canDownload: true,
    ollamaNeedsSshKey: false,
    ...overrides,
  };
}

function installed(name: string): InstalledModel {
  return {
    name,
    sizeBytes: 397_821_319,
    quantization: 'Q4_K_M',
    family: 'qwen2',
    parameterSize: '494M',
    modifiedAt: '2026-10-01T00:00:00Z',
    capabilities: { tools: true, vision: false, thinking: false, embeddings: false, completion: true },
  };
}

function fakeRuntime(): LocalRuntime {
  return {
    id: 'ollama:127.0.0.1:11500',
    kind: 'ollama',
    baseUrl: HOST,
    capabilities: { canPull: true, canRemove: true, canInspect: true, reportsLoaded: true },
    health: vi.fn().mockResolvedValue({ ok: true, version: '0.40.11', error: null }),
    list: vi.fn().mockResolvedValue([installed('qwen2.5:0.5b'), installed('smollm2:135m')]),
    inspect: vi.fn(),
    pull: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    loaded: vi
      .fn()
      .mockResolvedValue([{ name: 'qwen2.5:0.5b', sizeBytes: 1, vramBytes: 0, contextLength: 4096, expiresAt: null }]),
  };
}

function fakeHub(model: HubModelDetail = detail()): HubClient {
  return {
    endpoint: ENDPOINT,
    search: vi.fn().mockResolvedValue({
      models: [
        { ...model, id: 'someone/Qwen2.5-0.5B-abliterated-GGUF' },
        { ...model, licenses: ['apache-2.0'] },
        { ...model, id: 'someone/plain-GGUF', tags: ['uncensored'] },
      ],
      nextCursor: null,
    }),
    getModel: vi.fn().mockResolvedValue(model),
    verifyOllamaRef: vi.fn(async (d: Pick<HubModelDetail, 'id'>, b: HubGgufBuild) => `hf.co/${d.id}:${b.quant}`),
  };
}

type Answer = (request: ElicitRequest) => ElicitResult;

function manifest(licenses = ['Gemma Terms of Use'], model = 'e'): OllamaManifestInfo {
  return {
    digest: `sha256:${model.repeat(12)}${'0'.repeat(52)}`,
    layers: [`sha256:${model.repeat(64)}`],
    sizeBytes: 270_800_000,
    licenses,
  };
}

async function setup(
  options: {
    hub?: HubClient;
    elicit?: Answer;
    source?: RuntimeTarget['source'];
    registry?: ModelToolsDeps['ollamaRegistry'];
    defaultModel?: string;
  } = {}
) {
  const runtime = fakeRuntime();
  const hub = options.hub ?? fakeHub();
  const deps: ModelToolsDeps = {
    hub: () => hub,
    ollamaRegistry: options.registry ?? (async () => manifest()),
    resolveRuntime: async () => ({ runtime, source: options.source ?? 'env' }),
    defaultModel: async () => options.defaultModel ?? 'qwen2.5:0.5b',
  };
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerModelTools(server, deps);
  const client = new Client(
    { name: 'test-client', version: '0.0.0' },
    { capabilities: options.elicit ? { elicitation: { form: {} } } : {} }
  );
  const prompts: ElicitRequest[] = [];
  if (options.elicit) {
    const answer = options.elicit;
    client.setRequestHandler(ElicitRequestSchema, async request => {
      prompts.push(request);
      return answer(request);
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    return { isError: Boolean(result.isError), text, data: result.structuredContent as Record<string, unknown> };
  };
  return { call, client, runtime, hub, prompts };
}

const accept: Answer = () => ({ action: 'accept', content: { download: true, acceptLicense: true } });

describe('model tools', () => {
  it('lists the four tools, with no argument that approves a change', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...MODEL_TOOL_NAMES]);
    const pull = tools.find(tool => tool.name === 'models_pull')!;
    expect(Object.keys(pull.inputSchema.properties ?? {})).toEqual(['ref']);
    expect(pull.description).toContain('No argument of this tool approves a download');
    const remove = tools.find(tool => tool.name === 'models_remove')!;
    expect(Object.keys(remove.inputSchema.properties ?? {})).toEqual(['name']);
    expect(remove.annotations?.destructiveHint).toBe(true);
  });

  it('lists installed models with loaded and default marks', async () => {
    const { call } = await setup();
    const { data } = await call('models_list');
    expect(data.runtime).toEqual({ kind: 'ollama', baseUrl: HOST, source: 'env' });
    expect(data.models).toEqual([
      expect.objectContaining({ name: 'qwen2.5:0.5b', loaded: true, default: true }),
      expect.objectContaining({ name: 'smollm2:135m', loaded: false, default: false }),
    ]);
  });

  it('reports a loaded-model lookup failure instead of marking every model unloaded', async () => {
    const { call, runtime } = await setup();
    vi.mocked(runtime.loaded).mockRejectedValue(new Error('Ollama /api/ps returned 503'));
    const result = await call('models_list');
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Ollama /api/ps returned 503');
  });

  it('leaves abliterated and uncensored builds out of search hits by default', async () => {
    const { call } = await setup();
    const { data } = await call('models_search', { query: 'qwen2.5 0.5b' });
    expect(data.models).toEqual([expect.objectContaining({ id: REPO, licenses: ['apache-2.0'] })]);
    expect(data.models).toEqual([expect.not.objectContaining({ notRecommended: expect.anything() })]);
    expect(data.hidden).toBe('2 abliterated or uncensored builds were left out.');
  });

  it('lists them last and labelled with includeAbliterated', async () => {
    const { call } = await setup();
    const { data } = await call('models_search', { query: 'qwen2.5 0.5b', includeAbliterated: true });
    const models = data.models as Array<Record<string, unknown>>;
    expect(models.map(model => model.id)).toEqual([
      REPO,
      'someone/Qwen2.5-0.5B-abliterated-GGUF',
      'someone/plain-GGUF',
    ]);
    expect(models[0]).not.toHaveProperty('notRecommended');
    expect(models[1].notRecommended).toBe('abliterated or uncensored build');
    expect(models[2].notRecommended).toBe('abliterated or uncensored build');
    expect(data).not.toHaveProperty('hidden');
  });

  it('also catches heretic and decensored builds and base models, but not heretical', async () => {
    const base = detail();
    const hub: HubClient = {
      ...fakeHub(),
      search: vi.fn().mockResolvedValue({
        models: [
          { ...base, id: 'someone/gemma-heretic-GGUF' },
          { ...base, id: 'someone/Heretical-Poems-GGUF' },
          { ...base, id: 'someone/Plain-GGUF', baseModels: ['x/Qwen3-decensored'] },
        ],
        nextCursor: null,
      }),
    };
    const { call } = await setup({ hub });
    const { data } = await call('models_search', { query: 'gemma' });
    expect((data.models as Array<{ id: string }>).map(model => model.id)).toEqual(['someone/Heretical-Poems-GGUF']);
    expect(data.hidden).toBe('2 abliterated or uncensored builds were left out.');
  });

  describe('models_pull without elicitation', () => {
    it('downloads nothing and returns the preview and the terminal command', async () => {
      const { call, runtime, hub } = await setup();
      const { data } = await call('models_pull', { ref: REPO, confirmationToken: 'x', acceptLicense: true });
      expect(data).toEqual(
        expect.objectContaining({
          status: 'confirm-in-terminal',
          downloaded: false,
          model: REPO,
          label: 'Q4_K_M',
          sizeBytes: 491_400_032,
          size: '491 MB',
          revision: 'b'.repeat(40),
          licenses: ['apache-2.0'],
          gated: false,
          acknowledgementRequired: false,
          command: `B4M_OLLAMA_HOST=${HOST} b4m models pull ${REPO}:Q4_K_M`,
        })
      );
      expect(data.userApproval).toContain('Nothing was downloaded');
      expect(hub.verifyOllamaRef).not.toHaveBeenCalled();
      expect(runtime.pull).not.toHaveBeenCalled();
    });

    it('names every license and says the CLI asks for the license separately', async () => {
      const { call, runtime } = await setup({
        hub: fakeHub(detail({ licenses: ['apache-2.0', 'gemma'] })),
        source: 'config',
      });
      const { data } = await call('models_pull', { ref: `${REPO}:q8_0` });
      expect(data).toEqual(
        expect.objectContaining({
          licenses: ['apache-2.0', 'gemma'],
          acknowledgementRequired: true,
          license: { label: 'apache-2.0, gemma', link: `${ENDPOINT}/${REPO}`, permissive: false },
          command: `b4m models pull ${REPO}:Q8_0`,
        })
      );
      expect(data.userApproval).toContain('asks them separately to accept the license');
      expect(runtime.pull).not.toHaveBeenCalled();
    });

    it('shows the size and license texts of an Ollama registry model', async () => {
      const { call } = await setup({ source: 'detected' });
      const { data } = await call('models_pull', { ref: 'gemma3:270m' });
      expect(data).toEqual(
        expect.objectContaining({
          source: 'ollama',
          model: 'gemma3:270m',
          size: '271 MB',
          digest: 'eeeeeeeeeeee',
          licenses: ['Gemma Terms of Use'],
          acknowledgementRequired: true,
          command: 'b4m models pull gemma3:270m',
        })
      );
    });
  });

  describe('models_pull prompt contents', () => {
    it('names the vision projector, gated access and the SSH key step', async () => {
      const vision = detail({
        gated: 'auto',
        canDownload: true,
        ollamaNeedsSshKey: true,
        projectors: [{ path: 'mmproj-f16.gguf', sizeBytes: 851_000_000, sha256: null, url: 'x', quant: 'F16' }],
      });
      const { call, prompts, runtime } = await setup({ hub: fakeHub(vision), elicit: () => ({ action: 'decline' }) });
      const { data } = await call('models_pull', { ref: REPO });
      expect(data).toEqual(expect.objectContaining({ visionProjectorUpToBytes: 851_000_000, downloaded: false }));
      const { message, requestedSchema } = prompts[0].params as {
        message: string;
        requestedSchema: { properties: Record<string, { title: string }> };
      };
      expect(message).toContain('(491 MB plus a vision projector of up to 851 MB)');
      expect(message).toContain('Gated: yes (automatic approval), access granted.');
      expect(message).toContain(
        'add ~/.ollama/id_ed25519.pub of the Ollama host at https://huggingface.co/settings/keys'
      );
      expect(requestedSchema.properties.download.title).toBe('Download 491 MB plus a vision projector of up to 851 MB');
      expect(runtime.pull).not.toHaveBeenCalled();
    });

    it('shows the manifest digest for an Ollama registry model', async () => {
      const { call, prompts } = await setup({ elicit: () => ({ action: 'decline' }) });
      await call('models_pull', { ref: 'gemma3:270m' });
      expect(prompts[0].params.message).toContain('Digest: eeeeeeeeeeee');
    });
  });

  describe('models_pull re-checks after the user accepts', () => {
    it('refuses when the Ollama tag now serves other layers', async () => {
      const registry = vi
        .fn<ModelToolsDeps['ollamaRegistry']>()
        .mockResolvedValueOnce(manifest())
        .mockResolvedValueOnce(manifest(['Gemma Terms of Use'], 'f'));
      const { call, runtime } = await setup({ registry, elicit: accept });
      const result = await call('models_pull', { ref: 'gemma3:270m' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('gemma3:270m changed since you reviewed it (the registry now serves ffffffffffff)');
      expect(registry).toHaveBeenCalledTimes(2);
      expect(runtime.pull).not.toHaveBeenCalled();
    });

    it('refuses when the Ollama license text changed', async () => {
      const registry = vi
        .fn<ModelToolsDeps['ollamaRegistry']>()
        .mockResolvedValueOnce(manifest())
        .mockResolvedValueOnce(manifest(['Proprietary terms']));
      const { call, runtime } = await setup({ registry, elicit: accept });
      const result = await call('models_pull', { ref: 'gemma3:270m' });
      expect(result.text).toContain('changed since you reviewed it (its license text changed)');
      expect(runtime.pull).not.toHaveBeenCalled();
    });

    it('refuses when the Hugging Face licenses changed', async () => {
      const hub = fakeHub();
      vi.mocked(hub.getModel)
        .mockResolvedValueOnce(detail())
        .mockResolvedValueOnce(detail({ licenses: ['llama3.1'] }));
      const { call, runtime } = await setup({ hub, elicit: accept });
      const result = await call('models_pull', { ref: REPO });
      expect(result.isError).toBe(true);
      expect(result.text).toContain(`${REPO} changed since you reviewed it (its license is now llama3.1)`);
      expect(hub.verifyOllamaRef).not.toHaveBeenCalled();
      expect(runtime.pull).not.toHaveBeenCalled();
    });
  });

  describe('models_pull with elicitation', () => {
    it('asks the user with the size and licenses and pulls the verified ref on accept', async () => {
      const { call, runtime, hub, prompts } = await setup({
        hub: fakeHub(detail({ licenses: ['apache-2.0', 'gemma'] })),
        elicit: accept,
      });
      const result = await call('models_pull', { ref: REPO });
      expect(result.data).toEqual(
        expect.objectContaining({ status: 'pulled', downloaded: true, installedAs: `hf.co/${REPO}:Q4_K_M` })
      );
      expect(prompts[0].params.message).toContain('(491 MB)');
      expect(prompts[0].params.message).toContain('apache-2.0, gemma');
      const schema = (prompts[0].params as { requestedSchema: { required: string[] } }).requestedSchema;
      expect(schema.required).toEqual(['download', 'acceptLicense']);
      const verifyOrder = vi.mocked(hub.verifyOllamaRef).mock.invocationCallOrder[0];
      expect(verifyOrder).toBeLessThan(vi.mocked(runtime.pull).mock.invocationCallOrder[0]);
      expect(runtime.pull).toHaveBeenCalledWith(`hf.co/${REPO}:Q4_K_M`, expect.anything());
    });

    it('asks only for the download when every license is permissive', async () => {
      const { call, prompts } = await setup({ elicit: () => ({ action: 'accept', content: { download: true } }) });
      expect((await call('models_pull', { ref: REPO })).data.status).toBe('pulled');
      const schema = (prompts[0].params as { requestedSchema: { required: string[] } }).requestedSchema;
      expect(schema.required).toEqual(['download']);
    });

    it.each<[string, ElicitResult]>([
      ['decline', { action: 'decline' }],
      ['cancel', { action: 'cancel' }],
      ['an unticked download', { action: 'accept', content: { download: false, acceptLicense: true } }],
      ['an unaccepted license', { action: 'accept', content: { download: true, acceptLicense: false } }],
    ])('downloads nothing on %s', async (_label, answer) => {
      const { call, runtime, hub } = await setup({
        hub: fakeHub(detail({ licenses: ['apache-2.0', 'gemma'] })),
        elicit: () => answer,
      });
      const result = await call('models_pull', { ref: REPO, acceptLicense: true });
      expect(result.data.downloaded).toBe(false);
      expect(hub.verifyOllamaRef).not.toHaveBeenCalled();
      expect(runtime.pull).not.toHaveBeenCalled();
    });

    it('does not pull when the registry does not serve the exact file', async () => {
      const hub = fakeHub();
      vi.mocked(hub.verifyOllamaRef).mockResolvedValue(null);
      const { call, runtime } = await setup({ hub, elicit: accept });
      const result = await call('models_pull', { ref: REPO });
      expect(result.text).toContain('does not serve this exact');
      expect(runtime.pull).not.toHaveBeenCalled();
    });

    it('explains gated repos instead of asking', async () => {
      const { call, runtime, prompts } = await setup({
        hub: fakeHub(detail({ gated: 'manual', canDownload: false })),
        elicit: accept,
      });
      const result = await call('models_pull', { ref: REPO });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('is gated');
      expect(result.text).toContain('Request access at');
      expect(prompts).toEqual([]);
      expect(runtime.pull).not.toHaveBeenCalled();
    });
  });

  it('refuses a build with an unsupported quant tag without asking', async () => {
    const unsupported: HubGgufBuild = {
      ...build('Q4_K_L', 500_000_000),
      ollamaRef: null,
      ollamaRefIssue: 'unsupported-quant',
    };
    const hub = fakeHub(detail({ builds: [unsupported] }));
    const { call, runtime, prompts } = await setup({ hub, elicit: accept });
    const result = await call('models_pull', { ref: `${REPO}:Q4_K_L` });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Ollama cannot pull this quant from Hugging Face');
    expect(prompts).toEqual([]);
    expect(hub.verifyOllamaRef).not.toHaveBeenCalled();
    expect(runtime.pull).not.toHaveBeenCalled();
  });

  it('refuses refs naming another host', async () => {
    const { call, runtime } = await setup({ elicit: accept });
    const result = await call('models_pull', { ref: `example.com/${REPO}` });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Unsupported registry example.com');
    expect(runtime.pull).not.toHaveBeenCalled();
  });

  describe('models_remove', () => {
    it('removes nothing without elicitation and returns the terminal command', async () => {
      const { call, runtime } = await setup({ source: 'config' });
      const { data } = await call('models_remove', { name: 'smollm2:135m', confirmationToken: 'x' });
      expect(data).toEqual(
        expect.objectContaining({
          status: 'confirm-in-terminal',
          removed: false,
          model: 'smollm2:135m',
          command: 'b4m models rm smollm2:135m',
        })
      );
      expect(runtime.remove).not.toHaveBeenCalled();
    });

    it('asks through elicitation, keeps the model on decline and removes it on accept', async () => {
      const answers: ElicitResult[] = [{ action: 'decline' }, { action: 'accept', content: { remove: true } }];
      const { call, runtime, prompts } = await setup({ elicit: () => answers.shift()! });
      expect((await call('models_remove', { name: 'smollm2:135m' })).data.removed).toBe(false);
      expect(prompts[0].params.message).toContain('Remove smollm2:135m');
      expect(runtime.remove).not.toHaveBeenCalled();
      const removed = await call('models_remove', { name: 'smollm2:135m' });
      expect(removed.data).toEqual(expect.objectContaining({ status: 'removed', removed: true, wasDefault: false }));
      expect(runtime.remove).toHaveBeenCalledWith('smollm2:135m');
    });

    it('reports the default model as removed when the saved name is an alias', async () => {
      const { call } = await setup({
        defaultModel: 'library/smollm2:135m',
        elicit: () => ({ action: 'accept', content: { remove: true } }),
      });
      const removed = await call('models_remove', { name: 'smollm2:135m' });
      expect(removed.data).toEqual(expect.objectContaining({ status: 'removed', wasDefault: true }));
    });

    it('names a missing model', async () => {
      const { call } = await setup();
      const result = await call('models_remove', { name: 'nope:1b' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('No model named nope:1b');
    });
  });
});
