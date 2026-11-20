import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { importHistoryService } from '@bike4mind/services';
import type { IUser } from '@bike4mind/common';
import {
  buildClaudeExport,
  buildStoredZip,
  evaluateReadback,
  runSelfhostHistoryImportCheck,
  type HistoryImportCheckConfig,
} from './selfhostHistoryImportCheck';

const NONCE = 'nonce-test-123';
const API_KEY = 'b4m_live_secretvalue';
const BASE = 'http://app.test';

const tmp = mkdtempSync(join(tmpdir(), 'history-import-check-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface FakeSession {
  id: string;
  name: string;
  quests: { prompt: string; replies: string[] }[];
}

/**
 * Runs the real importer over the uploaded zip with in-memory adapters, so the fake app
 * parses exactly what the self-host worker would, and the check's verdict comes from that.
 */
async function importUpload(zip: Buffer, sessions: FakeSession[]): Promise<void> {
  const file = join(tmp, `${sessions.length}-${Math.random()}.zip`);
  writeFileSync(file, zip);
  await importHistoryService.importHistory(
    { userId: 'user-1', source: importHistoryService.ImportSource.CLAUDE, zipFile: file },
    {
      db: {
        withTransaction: fn => fn(),
        sessions: {
          upsertByOpenaiConversationId: async () => {
            throw new Error('unexpected OpenAI import');
          },
          upsertByClaudeConversationId: async (claudeId, update) => {
            const session: FakeSession = { id: `sess-${claudeId}`, name: String(update.name), quests: [] };
            sessions.push(session);
            return { id: session.id } as never;
          },
        },
        chatHistoryItems: {
          bulkCreate: async items => {
            for (const item of items) {
              sessions
                .find(s => s.id === item.sessionId)!
                .quests.push({ prompt: item.prompt ?? '', replies: (item.replies ?? []) as string[] });
            }
          },
        },
        users: { findById: async () => ({ id: 'user-1' }) as IUser },
      },
    }
  );
}

interface Recorded {
  method?: string;
  url: string;
  headers: Record<string, string>;
}

function setup(
  opts: {
    config?: Partial<HistoryImportCheckConfig>;
    existingJobs?: Record<string, unknown>[];
    presignedUrl?: string;
    /** The MinIO webhook never reaches the app: the upload lands but no job appears. */
    noWebhook?: boolean;
    /** HTTP statuses the first job polls after the upload answer with. */
    pollStatuses?: number[];
    /** HTTP statuses the job list answers with before the upload, ahead of the first real answer. */
    preUploadStatuses?: number[];
    /** Tamper with what the app holds after the import, to prove the content compare bites. */
    afterImport?: (sessions: FakeSession[]) => void;
  } = {}
) {
  const requests: Recorded[] = [];
  const jobs: Record<string, unknown>[] = [...(opts.existingJobs ?? [])];
  const sessions: FakeSession[] = [];
  const pollStatuses = [...(opts.pollStatuses ?? [])];
  const preUploadStatuses = [...(opts.preUploadStatuses ?? [])];
  let uploaded: Buffer | undefined;
  let clock = 0;
  let calls = 0;

  const fakeFetch = (async (url: string, init?: RequestInit) => {
    // A loop that loses its sleep would spin on microtasks; aborting ends the run so the test fails by name.
    if (++calls > 100) throw new DOMException('stub: too many requests', 'TimeoutError');
    requests.push({ method: init?.method, url, headers: init?.headers as Record<string, string> });
    const u = new URL(url);
    const path = u.pathname;

    if (path === '/api/import-history-jobs') {
      if (!uploaded && preUploadStatuses.length) return json(preUploadStatuses.shift()!, { error: 'busy' });
      if (uploaded && pollStatuses.length) return json(pollStatuses.shift()!, { error: 'busy' });
      const pending = jobs.find(j => j.status === 'processing');
      if (pending) {
        try {
          await importUpload(uploaded!, sessions);
          pending.status = 'completed';
          opts.afterImport?.(sessions);
        } catch (err) {
          pending.status = 'failed';
          pending.errorMessage = (err as Error).message;
        }
        return json(200, { success: true, data: [{ ...pending, status: 'processing' }, ...jobs.slice(1)] });
      }
      return json(200, { success: true, data: [...jobs] });
    }
    if (path === '/api/import-history/upload' && init?.method === 'GET') {
      return json(200, { success: true, url: opts.presignedUrl ?? `${path}${u.search}` });
    }
    if (path === '/api/import-history/upload' && init?.method === 'PUT') {
      const body = init.body as Buffer;
      if (body.length !== Number(u.searchParams.get('size'))) return json(403, { error: 'size mismatch' });
      uploaded = body;
      if (!opts.noWebhook) jobs.unshift({ id: 'job-new', source: 'Claude', status: 'processing' });
      return json(200, { success: true });
    }
    if (path === '/api/v1/sessions') {
      const search = u.searchParams.get('search') ?? '';
      return json(200, {
        data: sessions.filter(s => s.name.includes(search)).map(s => ({ id: s.id, name: s.name })),
        next_cursor: null,
      });
    }
    const questsMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/quests$/);
    if (questsMatch) {
      const session = sessions.find(s => s.id === decodeURIComponent(questsMatch[1]));
      if (!session) return json(404, { error: 'not found' });
      return json(200, {
        data: session.quests.map(q => ({ prompt: q.prompt, reply: q.replies.join('') })),
        next_cursor: null,
      });
    }
    return json(404, { error: `unexpected ${path}` });
  }) as unknown as typeof fetch;

  const run = () =>
    runSelfhostHistoryImportCheck(
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
  return { run, requests, sessions, getUploaded: () => uploaded };
}

describe('buildStoredZip', () => {
  it('writes an archive the importer reads conversations.json back out of', async () => {
    const body = JSON.stringify(buildClaudeExport(NONCE).conversations);
    const file = join(tmp, 'roundtrip.zip');
    writeFileSync(
      file,
      buildStoredZip([
        { name: 'README.txt', data: Buffer.from('other entry') },
        { name: 'conversations.json', data: Buffer.from(body) },
      ])
    );

    await expect(importHistoryService.extractFileFromZip(file, 'conversations.json')).resolves.toBe(body);
  });
});

describe('evaluateReadback', () => {
  const { expected } = buildClaudeExport(NONCE);
  const asImported = expected.map(c => ({
    name: c.name,
    quests: c.exchanges.map(e => ({ prompt: e.prompt, reply: e.reply })),
  }));

  it('passes the exported conversations whatever order the quests come back in', () => {
    const shuffled = asImported.map(s => ({ ...s, quests: [...s.quests].reverse() }));
    expect(evaluateReadback(expected, shuffled)).toEqual({ ok: true, exchanges: 4 });
  });

  it('fails when an extra session matches the nonce', () => {
    expect(evaluateReadback(expected, [...asImported, asImported[0]])).toMatchObject({
      ok: false,
      reason: 'imported 3 of 2 conversations',
    });
  });

  it('fails when an exchange lost its reply', () => {
    const lossy = asImported.map((s, i) =>
      i === 0 ? { ...s, quests: [{ ...s.quests[0], reply: '' }, s.quests[1]] } : s
    );
    expect(evaluateReadback(expected, lossy)).toMatchObject({ ok: false });
  });
});

describe('runSelfhostHistoryImportCheck', () => {
  it('passes when the upload imports both conversations with their content', async () => {
    const { run, requests, getUploaded } = setup();

    const result = await run();

    expect(result).toEqual({ ok: true, jobId: 'job-new', conversations: 2, exchanges: 4 });
    const put = requests.find(r => r.method === 'PUT')!;
    expect(put.url).toBe(`${BASE}/api/import-history/upload?source=Claude&size=${getUploaded()!.length}`);
    expect(requests.every(r => r.headers.Authorization === `Bearer ${API_KEY}`)).toBe(true);
  });

  it('fails a broken export whose conversations.json does not parse: the job ends failed', async () => {
    const { run } = setup({ config: { broken: 'bad-json' } });

    const result = await run();

    expect(result).toMatchObject({ ok: false, jobId: 'job-new' });
    expect(!result.ok && result.reason).toMatch(/^import job ended failed: /);
  });

  it('fails a broken export the importer silently skips, though the job completes', async () => {
    const { run } = setup({ config: { broken: 'invalid-conversation' } });

    expect(await run()).toEqual({
      ok: false,
      jobId: 'job-new',
      reason: 'job completed but imported 0 of 2 conversations',
    });
  });

  it('fails when the imported content differs from the export', async () => {
    const { run } = setup({ afterImport: sessions => (sessions[1].quests[0].replies = ['changed']) });

    const result = await run();

    expect(result).toMatchObject({ ok: false, jobId: 'job-new' });
    expect(!result.ok && result.reason).toMatch(/do not match the 2 exported/);
  });

  it('refuses to upload while another import is active, since the webhook would drop it', async () => {
    const { run, requests } = setup({ existingJobs: [{ id: 'job-old', source: 'OpenAI', status: 'processing' }] });

    expect(await run()).toEqual({
      ok: false,
      reason: 'import job job-old is still processing; wait for it',
    });
    expect(requests.some(r => r.method === 'PUT')).toBe(false);
  });

  it('ignores an earlier finished job and waits for the one this upload created', async () => {
    const { run } = setup({ existingJobs: [{ id: 'job-old', source: 'Claude', status: 'completed' }] });

    expect(await run()).toMatchObject({ ok: true, jobId: 'job-new' });
  });

  it('fails when the app hands back a presigned URL instead of the self-host proxy', async () => {
    const { run, requests } = setup({ presignedUrl: 'https://bucket.s3.amazonaws.com/key?X-Amz-Signature=x' });

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

  it('retries a transient error on the job list taken before the upload', async () => {
    const { run } = setup({ preUploadStatuses: [429, 503] });

    expect(await run()).toMatchObject({ ok: true, jobId: 'job-new' });
  });

  it('gives up on the pre-upload job list once the run timeout passes', async () => {
    const { run, getUploaded } = setup({ preUploadStatuses: Array(100).fill(503), config: { timeoutMs: 5_000 } });

    expect(await run()).toEqual({ ok: false, reason: 'HTTP 503' });
    expect(getUploaded()).toBeUndefined();
  });

  it('stops on a non-retryable poll error', async () => {
    const { run } = setup({ pollStatuses: [401] });

    expect(await run()).toEqual({ ok: false, reason: 'job list HTTP 401: busy' });
  });
});
