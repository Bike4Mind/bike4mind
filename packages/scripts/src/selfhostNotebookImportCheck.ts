export interface NotebookImportCheckDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Abort signal firing after `ms`; injectable so tests need no wall-clock time. */
  timeoutSignal?: (ms: number) => AbortSignal;
}

/**
 * Uploads a deliberately broken notebook export instead of the good one, so an operator can prove
 * the check fails rather than passing vacuously. `bad-json`: the file does not parse.
 * `unsupported-version`: it parses but names an export version the importer refuses.
 * `invalid-notebook`: the envelope is valid but each notebook's chatHistory is not an array, so
 * every notebook fails and the importer rolls the whole import back.
 */
export type BrokenNotebook = 'bad-json' | 'unsupported-version' | 'invalid-notebook';

export const BROKEN_NOTEBOOKS: readonly BrokenNotebook[] = ['bad-json', 'unsupported-version', 'invalid-notebook'];

export interface NotebookImportCheckConfig {
  baseUrl: string;
  apiKey: string;
  nonce: string;
  broken?: BrokenNotebook;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export type NotebookImportCheckResult =
  { ok: true; jobId: string; notebooks: number; messages: number } | { ok: false; jobId?: string; reason: string };

export interface ExpectedNotebook {
  name: string;
  messages: { prompt: string; reply: string }[];
}

const NOTEBOOK_COUNT = 2;

/** Must match SUPPORTED_IMPORT_VERSIONS in b4m-core/services/src/notebookExportService/types.ts. */
const EXPORT_VERSION = '1.0.0';

/**
 * A notebook export in the shape NotebookExportFormat describes (what the app's own export
 * writes), with every name carrying the nonce so the readback finds exactly this run's notebooks.
 * One reply carries a non-ASCII character to prove the upload and import keep UTF-8 intact.
 */
export function buildNotebookExport(nonce: string): {
  exportData: Record<string, unknown>;
  expected: ExpectedNotebook[];
} {
  const at = new Date(0).toISOString();
  const notebooks: unknown[] = [];
  const expected: ExpectedNotebook[] = [];
  for (let n = 1; n <= NOTEBOOK_COUNT; n++) {
    const name = `selfhost notebook-import check ${nonce} #${n}`;
    const messages = [1, 2].map(m => ({
      prompt: `prompt ${n}.${m} ${nonce}`,
      reply: `reply ${n}.${m} caf\u00e9 ${nonce}`,
    }));
    notebooks.push({
      id: `source-notebook-${n}`,
      name,
      firstCreated: at,
      lastUpdated: at,
      tags: [],
      isAutoNamed: false,
      chatHistory: messages.map((msg, i) => ({
        id: `source-message-${n}-${i + 1}`,
        timestamp: new Date(i * 1000).toISOString(),
        type: 'message',
        prompt: msg.prompt,
        reply: msg.reply,
        replies: [msg.reply],
        status: 'done',
        pinned: false,
      })),
      knowledge: [],
      artifacts: [],
      tools: [],
      agents: [],
    });
    expected.push({ name, messages });
  }
  return {
    exportData: { exportVersion: EXPORT_VERSION, exportedAt: at, platform: 'selfhost-check', notebooks },
    expected,
  };
}

/** The file body to upload: the good export, or one of the deliberate breakages. */
export function notebookFileBody(exportData: Record<string, unknown>, broken?: BrokenNotebook): string {
  if (broken === 'bad-json') return '{"exportVersion": "1.0.0", "notebooks": [';
  if (broken === 'unsupported-version') return JSON.stringify({ ...exportData, exportVersion: '0.0.0-unsupported' });
  if (broken === 'invalid-notebook') {
    const notebooks = (exportData.notebooks as Record<string, unknown>[]).map(nb => ({
      ...nb,
      chatHistory: 'not-an-array',
    }));
    return JSON.stringify({ ...exportData, notebooks });
  }
  return JSON.stringify(exportData);
}

export interface ReadbackNotebook {
  name: string;
  quests: { prompt: string | null; reply: string }[];
}

/**
 * Pure verdict on what the app holds after the job completed: exactly the expected notebooks,
 * each with exactly its prompt/reply pairs. Order-insensitive, since messages imported in one
 * bulk write can share a timestamp.
 */
export function evaluateNotebookReadback(
  expected: ExpectedNotebook[],
  notebooks: ReadbackNotebook[]
): { ok: true; messages: number } | { ok: false; reason: string } {
  if (notebooks.length !== expected.length) {
    return { ok: false, reason: `imported ${notebooks.length} of ${expected.length} notebooks` };
  }
  const pairKey = (prompt: string | null, reply: string) => JSON.stringify([prompt ?? '', reply]);
  let messages = 0;
  for (const want of expected) {
    const got = notebooks.find(s => s.name === want.name);
    if (!got) return { ok: false, reason: `notebook "${want.name}" is missing` };
    const gotPairs = got.quests.map(q => pairKey(q.prompt, q.reply)).sort();
    const wantPairs = want.messages.map(e => pairKey(e.prompt, e.reply)).sort();
    if (JSON.stringify(gotPairs) !== JSON.stringify(wantPairs)) {
      return {
        ok: false,
        reason: `notebook "${want.name}" holds ${gotPairs.length} messages that do not match the ${wantPairs.length} exported`,
      };
    }
    messages += wantPairs.length;
  }
  return { ok: true, messages };
}

interface JobRow {
  id?: unknown;
  source?: unknown;
  status?: unknown;
  errorMessage?: unknown;
}

const ACTIVE_JOB_STATUSES = new Set(['pending', 'processing']);

/** Server error text from the response envelope; never echoes headers. */
async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    const text = body.error ?? body.message;
    if (typeof text === 'string') return text;
  } catch {
    // non-JSON body
  }
  return res.statusText || 'no detail';
}

/** Polls that hit these are retried until the deadline, like a transient proxy or network fault. */
const RETRYABLE_POLL_STATUSES = new Set([429, 502, 503, 504]);

const isAbort = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Newest jobs first; enough rows that a just-created job is always on this page. */
const JOBS_PATH = '/api/import-history-jobs?limit=50&orderBy=createdAt&direction=desc';

/** The job source notebookImportComplete.ts records; history imports share the jobs list. */
const NOTEBOOK_JOB_SOURCE = 'Notebook';

/**
 * Prepares a notebook import (`POST /api/notebooks/import`), uploads the export through the
 * self-host upload proxy so MinIO's ObjectCreated webhook starts the import as it does for a UI
 * upload, waits for the job it creates to reach `completed`, then reads the notebooks back through
 * the public API and compares count and content. `timeoutMs` bounds the whole check, including
 * every request.
 */
export async function runSelfhostNotebookImportCheck(
  deps: NotebookImportCheckDeps,
  config: NotebookImportCheckConfig
): Promise<NotebookImportCheckResult> {
  const { baseUrl, apiKey, nonce, broken, timeoutMs = 300_000, pollIntervalMs = 3_000 } = config;
  const auth = { Authorization: `Bearer ${apiKey}` };
  const timeoutSignal = deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));
  const deadline = deps.now() + timeoutMs;

  const call = (
    method: string,
    pathOrUrl: string,
    init: { body?: Uint8Array<ArrayBuffer> | string; headers?: Record<string, string> } = {}
  ) =>
    deps.fetch(pathOrUrl.startsWith('/') ? `${baseUrl}${pathOrUrl}` : pathOrUrl, {
      method,
      headers: { ...auth, ...init.headers },
      body: init.body,
      signal: timeoutSignal(Math.max(1, deadline - deps.now())),
    });

  let jobId: string | undefined;
  let lastStatus: unknown;
  let lastError: string | undefined;
  const timedOut = (): NotebookImportCheckResult => {
    const seen =
      jobId === undefined
        ? 'no import job appeared (is the MinIO webhook reaching the app?)'
        : `last status ${String(lastStatus)}`;
    const err = lastError ? `; last error ${lastError}` : '';
    return { ok: false, jobId, reason: `timed out after ${Math.round(timeoutMs / 1000)}s; ${seen}${err}` };
  };

  const listJobs = async (): Promise<JobRow[] | { error: string; retry: boolean }> => {
    const res = await call('GET', JOBS_PATH);
    if (RETRYABLE_POLL_STATUSES.has(res.status)) return { error: `HTTP ${res.status}`, retry: true };
    if (!res.ok) return { error: `job list HTTP ${res.status}: ${await errorText(res)}`, retry: false };
    const body = (await res.json()) as { data?: unknown };
    return Array.isArray(body.data) ? (body.data as JobRow[]) : { error: 'job list returned no data', retry: false };
  };

  try {
    const { exportData, expected } = buildNotebookExport(nonce);
    const file = Buffer.from(notebookFileBody(exportData, broken), 'utf8');

    let before = await listJobs();
    while (!Array.isArray(before) && before.retry && deps.now() < deadline) {
      await deps.sleep(pollIntervalMs);
      before = await listJobs();
    }
    if (!Array.isArray(before)) return { ok: false, reason: before.error };
    const active = before.find(j => ACTIVE_JOB_STATUSES.has(String(j.status)));
    if (active) {
      // The webhook skips a new upload while any import of this user is active, so this run
      // could never get a job.
      return { ok: false, reason: `import job ${String(active.id)} is still ${String(active.status)}; wait for it` };
    }
    const seenIds = new Set(before.map(j => String(j.id)));

    // `rename` so a name clash with an earlier notebook can never merge into or overwrite it.
    const prepRes = await call('POST', '/api/notebooks/import', {
      body: JSON.stringify({ conflictResolution: 'rename', size: file.length }),
      headers: { 'Content-Type': 'application/json' },
    });
    if (!prepRes.ok) return { ok: false, reason: `import prepare HTTP ${prepRes.status}: ${await errorText(prepRes)}` };
    const uploadUrl = ((await prepRes.json()) as { uploadUrl?: unknown }).uploadUrl;
    if (typeof uploadUrl !== 'string' || !uploadUrl) return { ok: false, reason: 'import prepare had no uploadUrl' };
    if (!uploadUrl.startsWith('/')) {
      // A presigned URL means the app is not in self-host mode, so the upload proxy and MinIO
      // webhook this check exists to cover are not in play.
      return { ok: false, reason: 'upload URL is not the self-host proxy; is B4M_SELF_HOST=true on the app?' };
    }

    const putRes = await call('PUT', uploadUrl, {
      body: new Uint8Array(file),
      headers: { 'Content-Type': 'application/json' },
    });
    if (!putRes.ok) return { ok: false, reason: `upload HTTP ${putRes.status}: ${await errorText(putRes)}` };

    let job: JobRow | undefined;
    while (deps.now() < deadline) {
      try {
        const jobs = await listJobs();
        if (!Array.isArray(jobs)) {
          if (!jobs.retry) return { ok: false, jobId, reason: jobs.error };
          lastError = jobs.error;
        } else {
          const mine = jobs.find(j => !seenIds.has(String(j.id)) && j.source === NOTEBOOK_JOB_SOURCE);
          if (mine) {
            jobId = String(mine.id);
            lastStatus = mine.status;
            if (!ACTIVE_JOB_STATUSES.has(String(mine.status))) {
              job = mine;
              break;
            }
          }
        }
      } catch (err) {
        if (isAbort(err)) break;
        lastError = messageOf(err);
      }
      await deps.sleep(pollIntervalMs);
    }
    if (!job) return timedOut();
    if (job.status !== 'completed') {
      const detail = typeof job.errorMessage === 'string' && job.errorMessage ? `: ${job.errorMessage}` : '';
      return { ok: false, jobId, reason: `import job ended ${String(job.status)}${detail}` };
    }

    const listRes = await call('GET', `/api/v1/sessions?search=${encodeURIComponent(nonce)}&limit=50`);
    if (!listRes.ok) {
      return { ok: false, jobId, reason: `notebook list HTTP ${listRes.status}: ${await errorText(listRes)}` };
    }
    const listed = ((await listRes.json()) as { data?: { id?: unknown; name?: unknown }[] }).data ?? [];

    const notebooks: ReadbackNotebook[] = [];
    for (const s of listed) {
      const questsRes = await call('GET', `/api/v1/sessions/${encodeURIComponent(String(s.id))}/quests?limit=100`);
      if (!questsRes.ok) {
        return { ok: false, jobId, reason: `message list HTTP ${questsRes.status}: ${await errorText(questsRes)}` };
      }
      const quests = ((await questsRes.json()) as { data?: { prompt?: unknown; reply?: unknown }[] }).data ?? [];
      notebooks.push({
        name: String(s.name),
        quests: quests.map(q => ({
          prompt: typeof q.prompt === 'string' ? q.prompt : null,
          reply: typeof q.reply === 'string' ? q.reply : '',
        })),
      });
    }

    const verdict = evaluateNotebookReadback(expected, notebooks);
    if (!verdict.ok) return { ok: false, jobId, reason: `job completed but ${verdict.reason}` };
    return { ok: true, jobId: jobId!, notebooks: expected.length, messages: verdict.messages };
  } catch (err) {
    if (isAbort(err)) return timedOut();
    return { ok: false, jobId, reason: `request failed: ${messageOf(err)}` };
  }
}
