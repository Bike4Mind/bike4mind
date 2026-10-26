import { describe, it, expect, vi } from 'vitest';
import type { HubGgufBuild, HubModelDetail, InstalledModel, LocalRuntime } from '@bike4mind/local-models';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitRequestSchema, type ElicitRequest, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { HubClient } from '../models/localModels';
import { CONFIRMATION_TTL_MS, MODEL_TOOL_NAMES, registerModelTools, type ModelToolsDeps } from './modelTools';

const REPO = 'Qwen/Qwen2.5-0.5B-Instruct-GGUF';
const ENDPOINT = 'https://huggingface.co';

function build(quant: string, sizeBytes: number): HubGgufBuild {
  const path = `qwen2.5-0.5b-instruct-${quant.toLowerCase()}.gguf`;
  return {
    id: path.replace(/\.gguf$/, ''),
    quant,
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
    baseUrl: 'http://127.0.0.1:11500',
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
        { ...model, licenses: ['apache-2.0'] },
        { ...model, id: 'someone/Qwen2.5-0.5B-abliterated-GGUF' },
        { ...model, id: 'someone/plain-GGUF', tags: ['uncensored'] },
      ],
      nextCursor: null,
    }),
    getModel: vi.fn().mockResolvedValue(model),
    verifyOllamaRef: vi.fn(async (d: Pick<HubModelDetail, 'id'>, b: HubGgufBuild) => `hf.co/${d.id}:${b.quant}`),
  };
}

type Answer = (request: ElicitRequest) => ElicitResult;

async function setup(options: { hub?: HubClient; elicit?: Answer; registry?: ModelToolsDeps['ollamaRegistry'] } = {}) {
  const runtime = fakeRuntime();
  const hub = options.hub ?? fakeHub();
  let now = 1_000_000;
  let next = 0;
  const deps: ModelToolsDeps = {
    hub: () => hub,
    ollamaRegistry:
      options.registry ??
      (async () => ({
        digest: `sha256:${'d'.repeat(64)}`,
        layers: [`sha256:${'e'.repeat(64)}`],
        sizeBytes: 270_800_000,
        licenses: ['Gemma Terms of Use'],
      })),
    resolveRuntime: async () => ({ runtime, source: 'env' }),
    defaultModel: async () => 'qwen2.5:0.5b',
    now: () => now,
    newToken: () => `token-${++next}`,
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
  return { call, client, runtime, hub, prompts, advance: (ms: number) => (now += ms) };
}

describe('model tools', () => {
  it('lists the four tools with their input schemas', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...MODEL_TOOL_NAMES]);
    const pull = tools.find(tool => tool.name === 'models_pull')!;
    expect(Object.keys(pull.inputSchema.properties ?? {})).toEqual(['ref', 'confirmationToken', 'acceptLicense']);
    expect(pull.inputSchema.required).toEqual(['ref']);
    expect(pull.description).toContain("Never approve on the user's behalf");
    expect(tools.find(tool => tool.name === 'models_remove')!.annotations?.destructiveHint).toBe(true);
  });

  it('lists installed models with loaded and default marks', async () => {
    const { call } = await setup();
    const { data } = await call('models_list');
    expect(data.runtime).toEqual({ kind: 'ollama', baseUrl: 'http://127.0.0.1:11500', source: 'env' });
    expect(data.models).toEqual([
      expect.objectContaining({ name: 'qwen2.5:0.5b', loaded: true, default: true }),
      expect.objectContaining({ name: 'smollm2:135m', loaded: false, default: false }),
    ]);
  });

  it('returns search hits with their licenses and marks abliterated or uncensored builds', async () => {
    const { call } = await setup();
    const { data } = await call('models_search', { query: 'qwen2.5 0.5b' });
    const models = data.models as Array<Record<string, unknown>>;
    expect(models[0]).toEqual(expect.objectContaining({ id: REPO, licenses: ['apache-2.0'] }));
    expect(models[0]).not.toHaveProperty('notRecommended');
    expect(models[1].notRecommended).toBe('abliterated or uncensored build');
    expect(models[2].notRecommended).toBe('abliterated or uncensored build');
  });

  describe('models_pull without elicitation', () => {
    it('previews without downloading, then pulls the verified ref with the token once', async () => {
      const { call, runtime, hub } = await setup();
      const preview = await call('models_pull', { ref: REPO });
      expect(preview.data).toEqual(
        expect.objectContaining({
          status: 'needs-user-approval',
          downloaded: false,
          model: REPO,
          quant: 'Q4_K_M',
          sizeBytes: 491_400_032,
          size: '491 MB',
          revision: 'b'.repeat(40),
          licenses: ['apache-2.0'],
          acknowledgementRequired: false,
          confirmationToken: 'token-1',
        })
      );
      expect(preview.data.userApproval).toContain('The user must approve this download');
      expect(hub.verifyOllamaRef).not.toHaveBeenCalled();
      expect(runtime.pull).not.toHaveBeenCalled();

      const pulled = await call('models_pull', { ref: REPO, confirmationToken: 'token-1' });
      expect(pulled.data).toEqual(
        expect.objectContaining({ status: 'pulled', downloaded: true, installedAs: `hf.co/${REPO}:Q4_K_M` })
      );
      const verifyOrder = vi.mocked(hub.verifyOllamaRef).mock.invocationCallOrder[0];
      expect(verifyOrder).toBeLessThan(vi.mocked(runtime.pull).mock.invocationCallOrder[0]);
      expect(runtime.pull).toHaveBeenCalledWith(`hf.co/${REPO}:Q4_K_M`, expect.anything());

      const again = await call('models_pull', { ref: REPO, confirmationToken: 'token-1' });
      expect(again.isError).toBe(true);
      expect(again.text).toContain('already used');
      expect(runtime.pull).toHaveBeenCalledTimes(1);
    });

    it('refuses a token for another ref, an expired one and one whose model changed', async () => {
      const { call, runtime, hub, advance } = await setup();
      await call('models_pull', { ref: REPO });
      const other = await call('models_pull', { ref: `${REPO}:Q8_0`, confirmationToken: 'token-1' });
      expect(other.text).toContain(`issued for ${REPO}`);

      advance(CONFIRMATION_TTL_MS);
      expect((await call('models_pull', { ref: REPO, confirmationToken: 'token-1' })).text).toContain('expired');

      await call('models_pull', { ref: REPO });
      vi.mocked(hub.getModel).mockResolvedValue(detail({ revision: 'c'.repeat(40) }));
      const changed = await call('models_pull', { ref: REPO, confirmationToken: 'token-2' });
      expect(changed.text).toContain('The model changed since the user approved it');
      expect(runtime.pull).not.toHaveBeenCalled();
    });

    it('needs acceptLicense when one of several licenses is not permissive', async () => {
      const { call, runtime } = await setup({ hub: fakeHub(detail({ licenses: ['apache-2.0', 'gemma'] })) });
      const preview = await call('models_pull', { ref: REPO });
      expect(preview.data).toEqual(
        expect.objectContaining({
          licenses: ['apache-2.0', 'gemma'],
          acknowledgementRequired: true,
          license: { label: 'apache-2.0, gemma', link: `${ENDPOINT}/${REPO}`, permissive: false },
        })
      );
      const refused = await call('models_pull', { ref: REPO, confirmationToken: 'token-1' });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("needs the user's own acceptance");
      expect(runtime.pull).not.toHaveBeenCalled();

      const pulled = await call('models_pull', { ref: REPO, confirmationToken: 'token-1', acceptLicense: true });
      expect(pulled.data.status).toBe('pulled');
    });

    it('shows the size and license texts of an Ollama registry model', async () => {
      const { call } = await setup();
      const { data } = await call('models_pull', { ref: 'gemma3:270m' });
      expect(data).toEqual(
        expect.objectContaining({
          source: 'ollama',
          model: 'gemma3:270m',
          size: '271 MB',
          licenses: ['Gemma Terms of Use'],
          acknowledgementRequired: true,
        })
      );
    });

    it('does not pull when the registry does not serve the exact file', async () => {
      const hub = fakeHub();
      vi.mocked(hub.verifyOllamaRef).mockResolvedValue(null);
      const { call, runtime } = await setup({ hub });
      await call('models_pull', { ref: REPO });
      const result = await call('models_pull', { ref: REPO, confirmationToken: 'token-1' });
      expect(result.text).toContain('does not serve this exact');
      expect(runtime.pull).not.toHaveBeenCalled();
    });
  });

  describe('models_pull with elicitation', () => {
    it('asks the user with the size and licenses and pulls on accept', async () => {
      const { call, runtime, prompts } = await setup({
        hub: fakeHub(detail({ licenses: ['apache-2.0', 'gemma'] })),
        elicit: () => ({ action: 'accept', content: { download: true, acceptLicense: true } }),
      });
      const result = await call('models_pull', { ref: REPO });
      expect(result.data.status).toBe('pulled');
      expect(prompts[0].params.message).toContain('(491 MB)');
      expect(prompts[0].params.message).toContain('apache-2.0, gemma');
      const schema = (prompts[0].params as { requestedSchema: { required: string[] } }).requestedSchema;
      expect(schema.required).toEqual(['download', 'acceptLicense']);
      expect(runtime.pull).toHaveBeenCalledTimes(1);
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
      const result = await call('models_pull', { ref: REPO, confirmationToken: 'anything', acceptLicense: true });
      expect(result.data.downloaded).toBe(false);
      expect(hub.verifyOllamaRef).not.toHaveBeenCalled();
      expect(runtime.pull).not.toHaveBeenCalled();
    });

    it('explains gated repos instead of asking', async () => {
      const { call, runtime, prompts } = await setup({
        hub: fakeHub(detail({ gated: 'manual', canDownload: false })),
        elicit: () => ({ action: 'accept', content: { download: true } }),
      });
      const result = await call('models_pull', { ref: REPO });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('is gated');
      expect(result.text).toContain('Request access at');
      expect(prompts).toEqual([]);
      expect(runtime.pull).not.toHaveBeenCalled();
    });
  });

  it('refuses refs naming another host', async () => {
    const { call, runtime } = await setup();
    const result = await call('models_pull', { ref: `example.com/${REPO}` });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Unsupported registry example.com');
    expect(runtime.pull).not.toHaveBeenCalled();
  });

  describe('models_remove', () => {
    it('removes only with the token from its preview', async () => {
      const { call, runtime } = await setup();
      const preview = await call('models_remove', { name: 'smollm2:135m' });
      expect(preview.data).toEqual(expect.objectContaining({ status: 'needs-user-approval', removed: false }));
      expect(runtime.remove).not.toHaveBeenCalled();
      expect((await call('models_remove', { name: 'qwen2.5:0.5b', confirmationToken: 'token-1' })).isError).toBe(true);

      const removed = await call('models_remove', { name: 'smollm2:135m', confirmationToken: 'token-1' });
      expect(removed.data).toEqual(expect.objectContaining({ status: 'removed', removed: true, wasDefault: false }));
      expect(runtime.remove).toHaveBeenCalledWith('smollm2:135m');
    });

    it('asks through elicitation and keeps the model on decline', async () => {
      const { call, runtime, prompts } = await setup({ elicit: () => ({ action: 'decline' }) });
      const result = await call('models_remove', { name: 'smollm2:135m' });
      expect(result.data.removed).toBe(false);
      expect(prompts[0].params.message).toContain('Remove smollm2:135m');
      expect(runtime.remove).not.toHaveBeenCalled();
    });

    it('names a missing model', async () => {
      const { call } = await setup();
      const result = await call('models_remove', { name: 'nope:1b' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('No model named nope:1b');
    });
  });
});
