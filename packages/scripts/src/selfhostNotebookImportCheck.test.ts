import { describe, expect, it } from 'vitest';
import { notebookImportService } from '@bike4mind/services';
import { questReplyText, type IChatHistoryItem } from '@bike4mind/common';
import {
  buildNotebookExport,
  evaluateNotebookReadback,
  notebookFileBody,
  runSelfhostNotebookImportCheck,
  type NotebookImportCheckConfig,
} from './selfhostNotebookImportCheck';

const NONCE = 'nonce-test-123';
const API_KEY = 'b4m_live_secretvalue';
const BASE = 'http://app.test';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface FakeNotebook {
  id: string;
  name: string;
  quests: { prompt: string | null; reply: string }[];
}

const noop = () => undefined;

/**
 * Runs the real NotebookImportService over the uploaded file with in-memory adapters, and fails the
 * import the way notebookImportComplete.ts does (a parse error or any per-notebook error), so the
 * check's verdict comes from what the self-host worker would actually do with these bytes.
 */
async function importUpload(file: Buffer, notebooks: FakeNotebook[]): Promise<void> {
  const staged: FakeNotebook[] = [];
  const service = new notebookImportService.NotebookImportService({
    sessionRepository: {
      create: async data => {
        const nb: FakeNotebook = {
          id: `nb-${notebooks.length + staged.length + 1}`,
          name: String(data.name),
          quests: [],
        };
        staged.push(nb);
        return { id: nb.id };
      },
      find: async ({ name }) =>
        notebooks.filter(n => n.name === name).map(n => ({ id: n.id, userId: 'user-1' })) as never,
      updateById: async () => undefined,
    },
    chatHistoryRepository: {
      bulkCreate: async (items: IChatHistoryItem[]) => {
        for (const item of items) {
          staged
            .find(n => n.id === item.sessionId)!
            .quests.push({ prompt: item.prompt ?? null, reply: questReplyText(item) ?? '' });
        }
      },
      deleteMany: async () => undefined,
    },
    knowledgeRepository: { create: async () => ({ id: 'k' }) },
    artifactIdTaken: async () => false,
    createArtifact: async () => ({ id: 'a' }),
    toolRepository: { create: async () => ({ id: 't' }) },
    agentRepository: { create: async () => ({ id: 'g' }) },
    userRepository: { findById: async () => ({ id: 'user-1' }) },
    adminSettings: { findAll: async () => [], findBySettingNames: async () => [] },
    fileStorageService: {
      uploadFile: async () => undefined,
      deleteFile: async () => undefined,
      getFileContent: async () => null,
      getSignedUrl: async () => null,
    },
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    generateId: () => 'generated-id',
  } as unknown as notebookImportService.NotebookImportAdapters);
  const result = await service.importNotebooks('user-1', JSON.parse(file.toString('utf8')), {
    conflictResolution: 'rename',
    preserveIds: false,
    importKnowledge: true,
    importArtifacts: true,
    importTools: true,
    importAgents: true,
  });
  if (result.errors?.length) throw new Error(`Imported no notebooks: ${result.errors.join('; ')}`);
  // Committed only on success, like the transaction around the real import.
  notebooks.push(...staged);
}

interface Recorded {
  method?: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

function setup(
  opts: {
    config?: Partial<NotebookImportCheckConfig>;
    existingJobs?: Record<string, unknown>[];
    uploadUrl?: string;
    /** The MinIO webhook never reaches the app: the upload lands but no job appears. */
    noWebhook?: boolean;
    /** HTTP statuses the first job polls after the upload answer with. */
    pollStatuses?: number[];
    /** Tamper with what the app holds after the import, to prove the content compare bites. */
    afterImport?: (notebooks: FakeNotebook[]) => void;
  } = {}
) {
  const requests: Recorded[] = [];
  const jobs: Record<string, unknown>[] = [...(opts.existingJobs ?? [])];
  const notebooks: FakeNotebook[] = [];
  const pollStatuses = [...(opts.pollStatuses ?? [])];
  let uploaded: Buffer | undefined;
  let declaredSize: number | undefined;
  let clock = 0;
  let calls = 0;

  const fakeFetch = (async (url: string, init?: RequestInit) => {
    // A loop that loses its sleep would spin on microtasks; aborting ends the run so the test fails by name.
    if (++calls > 100) throw new DOMException('stub: too many requests', 'TimeoutError');
    requests.push({ method: init?.method, url, headers: init?.headers as Record<string, string>, body: init?.body });
    const u = new URL(url);
    const path = u.pathname;

    if (path === '/api/import-history-jobs') {
      if (uploaded && pollStatuses.length) return json(pollStatuses.shift()!, { error: 'busy' });
      const pending = jobs.find(j => j.status === 'processing');
      if (pending) {
        try {
          await importUpload(uploaded!, notebooks);
          pending.status = 'completed';
          opts.afterImport?.(notebooks);
        } catch (err) {
          pending.status = 'failed';
          pending.errorMessage = (err as Error).message;
        }
        return json(200, { success: true, data: [{ ...pending, status: 'processing' }, ...jobs.slice(1)] });
      }
      return json(200, { success: true, data: [...jobs] });
    }
    if (path === '/api/notebooks/import' && init?.method === 'POST') {
      declaredSize = (JSON.parse(String(init.body)) as { size: number }).size;
      return json(200, {
        success: true,
        importId: 1700000000000,
        uploadUrl: opts.uploadUrl ?? `/api/notebooks/import/upload?importId=1700000000000&size=${declaredSize}`,
      });
    }
    if (path === '/api/notebooks/import/upload' && init?.method === 'PUT') {
      const body = Buffer.from(init.body as Uint8Array);
      if (body.length !== Number(u.searchParams.get('size'))) return json(403, { error: 'size mismatch' });
      uploaded = body;
      if (!opts.noWebhook) jobs.unshift({ id: 'job-new', source: 'Notebook', status: 'processing' });
      return json(200, { success: true });
    }
    if (path === '/api/v1/sessions') {
      const search = u.searchParams.get('search') ?? '';
      return json(200, {
        data: notebooks.filter(s => s.name.includes(search)).map(s => ({ id: s.id, name: s.name })),
        next_cursor: null,
      });
    }
    const questsMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/quests$/);
    if (questsMatch) {
      const nb = notebooks.find(s => s.id === decodeURIComponent(questsMatch[1]));
      if (!nb) return json(404, { error: 'not found' });
      return json(200, { data: nb.quests, next_cursor: null });
    }
    return json(404, { error: `unexpected ${path}` });
  }) as unknown as typeof fetch;

  const run = () =>
    runSelfhostNotebookImportCheck(
      {
        fetch: fakeFetch,
        sleep: async ms => {
          clock += ms;
        },
        now: () => clock,
        timeoutSignal: () => new AbortController().signal,
      },
      { baseUrl: BASE, apiKey: API_KEY, nonce: NONCE, timeoutMs: 60_000, pollIntervalMs: 1_000, ...opts.config }
    );
  return { run, requests, notebooks, getUploaded: () => uploaded, getDeclaredSize: () => declaredSize };
}

describe('buildNotebookExport', () => {
  it('carries a non-ASCII reply, so the readback proves UTF-8 survives the upload', () => {
    const { expected } = buildNotebookExport(NONCE);
    expect(expected[0].messages[0].reply).toContain('caf\u00e9');
  });
});

describe('notebookFileBody', () => {
  const { exportData } = buildNotebookExport(NONCE);

  it('writes the good export as parseable JSON', () => {
    expect(JSON.parse(notebookFileBody(exportData))).toEqual(exportData);
  });

  it('writes bad-json as text that does not parse', () => {
    expect(() => JSON.parse(notebookFileBody(exportData, 'bad-json'))).toThrow();
  });
});

describe('evaluateNotebookReadback', () => {
  const { expected } = buildNotebookExport(NONCE);
  const asImported = expected.map(n => ({ name: n.name, quests: n.messages.map(m => ({ ...m })) }));

  it('passes the exported notebooks whatever order the messages come back in', () => {
    const shuffled = asImported.map(s => ({ ...s, quests: [...s.quests].reverse() }));
    expect(evaluateNotebookReadback(expected, shuffled)).toEqual({ ok: true, messages: 4 });
  });

  it('fails when an extra notebook matches the nonce', () => {
    expect(evaluateNotebookReadback(expected, [...asImported, asImported[0]])).toMatchObject({
      ok: false,
      reason: 'imported 3 of 2 notebooks',
    });
  });

  it('fails when a notebook is renamed', () => {
    const renamed = [{ ...asImported[0], name: `${asImported[0].name} (1)` }, asImported[1]];
    expect(evaluateNotebookReadback(expected, renamed)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/is missing$/),
    });
  });

  it('fails when a message lost its reply', () => {
    const lossy = asImported.map((s, i) =>
      i === 0 ? { ...s, quests: [{ ...s.quests[0], reply: '' }, s.quests[1]] } : s
    );
    expect(evaluateNotebookReadback(expected, lossy)).toMatchObject({ ok: false });
  });
});

describe('runSelfhostNotebookImportCheck', () => {
  it('passes when the upload imports both notebooks with their content', async () => {
    const { run, requests, getUploaded, getDeclaredSize } = setup();

    const result = await run();

    expect(result).toEqual({ ok: true, jobId: 'job-new', notebooks: 2, messages: 4 });
    expect(getDeclaredSize()).toBe(getUploaded()!.length);
    const prepare = requests.find(r => r.method === 'POST')!;
    expect(JSON.parse(String(prepare.body))).toMatchObject({ conflictResolution: 'rename' });
    const put = requests.find(r => r.method === 'PUT')!;
    expect(put.url).toBe(`${BASE}/api/notebooks/import/upload?importId=1700000000000&size=${getUploaded()!.length}`);
    expect(requests.every(r => r.headers.Authorization === `Bearer ${API_KEY}`)).toBe(true);
  });

  it.each(['bad-json', 'unsupported-version', 'invalid-notebook'] as const)(
    'fails a broken notebook (%s): the job ends failed',
    async broken => {
      const { run, notebooks } = setup({ config: { broken } });

      const result = await run();

      expect(result).toMatchObject({ ok: false, jobId: 'job-new' });
      expect(!result.ok && result.reason).toMatch(/^import job ended failed: /);
      expect(notebooks).toEqual([]);
    }
  );

  it('fails when the imported content differs from the export', async () => {
    const { run } = setup({ afterImport: nbs => (nbs[1].quests[0].reply = 'changed') });

    const result = await run();

    expect(result).toMatchObject({ ok: false, jobId: 'job-new' });
    expect(!result.ok && result.reason).toMatch(/do not match the 2 exported/);
  });

  it('refuses to upload while another import is active, since the webhook would skip it', async () => {
    const { run, requests } = setup({ existingJobs: [{ id: 'job-old', source: 'Claude', status: 'pending' }] });

    expect(await run()).toEqual({ ok: false, reason: 'import job job-old is still pending; wait for it' });
    expect(requests.some(r => r.method === 'POST' || r.method === 'PUT')).toBe(false);
  });

  it('ignores an earlier finished notebook job and waits for the one this upload created', async () => {
    const { run } = setup({ existingJobs: [{ id: 'job-old', source: 'Notebook', status: 'completed' }] });

    expect(await run()).toMatchObject({ ok: true, jobId: 'job-new' });
  });

  it('fails when the app hands back a presigned URL instead of the self-host proxy', async () => {
    const { run, requests } = setup({ uploadUrl: 'https://bucket.s3.amazonaws.com/key?X-Amz-Signature=x' });

    const result = await run();

    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toMatch(/not the self-host proxy/);
    expect(requests.some(r => r.method === 'PUT')).toBe(false);
  });

  it('times out naming the webhook when the upload never produces a job', async () => {
    const { run } = setup({ noWebhook: true });

    const result = await run();

    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toMatch(/^timed out after 60s; no import job appeared/);
  });

  it('retries transient poll errors until the job finishes', async () => {
    const { run } = setup({ pollStatuses: [503, 502] });

    expect(await run()).toMatchObject({ ok: true, jobId: 'job-new' });
  });

  it('stops on a non-retryable poll error', async () => {
    const { run } = setup({ pollStatuses: [401] });

    expect(await run()).toEqual({ ok: false, reason: 'job list HTTP 401: busy' });
  });
});
