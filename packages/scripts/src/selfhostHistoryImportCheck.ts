import { randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';

export interface HistoryImportCheckDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Abort signal firing after `ms`; injectable so tests need no wall-clock time. */
  timeoutSignal?: (ms: number) => AbortSignal;
  /** Fresh UUIDs for the export's conversation and message ids; injectable for stable tests. */
  uuid?: () => string;
}

/**
 * Uploads a deliberately broken export instead of the good one, so an operator can prove the
 * check fails rather than passing vacuously. `bad-json`: conversations.json does not parse, so the
 * job ends `failed`. `invalid-conversation`: it parses but no conversation matches the Claude
 * schema, so the importer skips them all and the job still ends `completed` - only the readback
 * catches that one.
 */
export type BrokenExport = 'bad-json' | 'invalid-conversation';

export interface HistoryImportCheckConfig {
  baseUrl: string;
  apiKey: string;
  nonce: string;
  broken?: BrokenExport;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export type HistoryImportCheckResult =
  { ok: true; jobId: string; conversations: number; exchanges: number } | { ok: false; jobId?: string; reason: string };

export interface ExpectedConversation {
  name: string;
  exchanges: { prompt: string; reply: string }[];
}

const CONVERSATION_COUNT = 2;

/**
 * A Claude-format export (the shape importClaudeHistory.ts parses) with every name carrying the
 * nonce, so the readback can find exactly this run's sessions. Ids are fresh per run because the
 * importer upserts by conversation uuid: reused ids would update an earlier run's sessions.
 */
export function buildClaudeExport(
  nonce: string,
  uuid: () => string = randomUUID
): { conversations: unknown[]; expected: ExpectedConversation[] } {
  const at = new Date(0).toISOString();
  const account = { uuid: uuid() };
  const conversations: unknown[] = [];
  const expected: ExpectedConversation[] = [];
  for (let c = 1; c <= CONVERSATION_COUNT; c++) {
    const name = `selfhost history-import check ${nonce} #${c}`;
    const exchanges = [1, 2].map(m => ({
      prompt: `prompt ${c}.${m} ${nonce}`,
      reply: `reply ${c}.${m} ${nonce}`,
    }));
    const message = (sender: 'human' | 'assistant', text: string) => ({
      uuid: uuid(),
      text,
      content: [{ type: 'text', text }],
      sender,
      created_at: at,
      updated_at: at,
      attachments: [],
      files: [],
    });
    conversations.push({
      uuid: uuid(),
      name,
      created_at: at,
      updated_at: at,
      account,
      chat_messages: exchanges.flatMap(e => [message('human', e.prompt), message('assistant', e.reply)]),
    });
    expected.push({ name, exchanges });
  }
  return { conversations, expected };
}

/** The conversations.json body to upload: the good export, or one of the deliberate breakages. */
export function conversationsJson(conversations: unknown[], broken?: BrokenExport): string {
  if (broken === 'bad-json') return '[{"uuid": ';
  if (broken === 'invalid-conversation') {
    return JSON.stringify(conversations.map(c => ({ ...(c as object), chat_messages: 'not-an-array' })));
  }
  return JSON.stringify(conversations);
}

/**
 * Minimal single-disk zip with STORED (uncompressed) entries - all the importer's reader needs,
 * and it keeps the check free of a zip dependency.
 */
export function buildStoredZip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const fileName = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    locals.push(local, fileName, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + data.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
}

export interface ReadbackSession {
  name: string;
  quests: { prompt: string | null; reply: string }[];
}

/**
 * Pure verdict on what the app holds after the job completed: exactly the expected
 * conversations, each with exactly its prompt/reply pairs. Order-insensitive, since quests
 * imported in one write share a timestamp.
 */
export function evaluateReadback(
  expected: ExpectedConversation[],
  sessions: ReadbackSession[]
): { ok: true; exchanges: number } | { ok: false; reason: string } {
  if (sessions.length !== expected.length) {
    return { ok: false, reason: `imported ${sessions.length} of ${expected.length} conversations` };
  }
  const pairKey = (prompt: string | null, reply: string) => JSON.stringify([prompt ?? '', reply]);
  let exchanges = 0;
  for (const want of expected) {
    const got = sessions.find(s => s.name === want.name);
    if (!got) return { ok: false, reason: `conversation "${want.name}" is missing` };
    const gotPairs = got.quests.map(q => pairKey(q.prompt, q.reply)).sort();
    const wantPairs = want.exchanges.map(e => pairKey(e.prompt, e.reply)).sort();
    if (JSON.stringify(gotPairs) !== JSON.stringify(wantPairs)) {
      return {
        ok: false,
        reason: `conversation "${want.name}" holds ${gotPairs.length} exchanges that do not match the ${wantPairs.length} exported`,
      };
    }
    exchanges += wantPairs.length;
  }
  return { ok: true, exchanges };
}

interface JobRow {
  id?: unknown;
  source?: unknown;
  status?: unknown;
  errorMessage?: unknown;
}

const ACTIVE_JOB_STATUSES = new Set(['pending', 'processing']);

/** Server error text from the shared envelope; never echoes headers. */
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

/**
 * Uploads a Claude export through the self-host upload proxy (so MinIO's ObjectCreated webhook
 * starts the import, as in the app), waits for the job it creates to reach `completed`, then
 * reads the conversations back through the public API and compares count and content.
 * `timeoutMs` bounds the whole check, including every request.
 */
export async function runSelfhostHistoryImportCheck(
  deps: HistoryImportCheckDeps,
  config: HistoryImportCheckConfig
): Promise<HistoryImportCheckResult> {
  const { baseUrl, apiKey, nonce, broken, timeoutMs = 300_000, pollIntervalMs = 3_000 } = config;
  const auth = { Authorization: `Bearer ${apiKey}` };
  const timeoutSignal = deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));
  const deadline = deps.now() + timeoutMs;

  const call = (
    method: string,
    pathOrUrl: string,
    init: { body?: Uint8Array<ArrayBuffer>; headers?: Record<string, string> } = {}
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
  const timedOut = (): HistoryImportCheckResult => {
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
    const { conversations, expected } = buildClaudeExport(nonce, deps.uuid);
    const archive = buildStoredZip([
      { name: 'conversations.json', data: Buffer.from(conversationsJson(conversations, broken), 'utf8') },
    ]);

    let before = await listJobs();
    while (!Array.isArray(before) && before.retry && deps.now() < deadline) {
      await deps.sleep(pollIntervalMs);
      before = await listJobs();
    }
    if (!Array.isArray(before)) return { ok: false, reason: before.error };
    const active = before.find(j => ACTIVE_JOB_STATUSES.has(String(j.status)));
    if (active) {
      // The webhook drops a new upload while one is active, so this run could never get a job.
      return { ok: false, reason: `import job ${String(active.id)} is still ${String(active.status)}; wait for it` };
    }
    const seenIds = new Set(before.map(j => String(j.id)));

    const urlRes = await call('GET', `/api/import-history/upload?source=Claude&size=${archive.length}`);
    if (!urlRes.ok) return { ok: false, reason: `upload URL HTTP ${urlRes.status}: ${await errorText(urlRes)}` };
    const uploadUrl = ((await urlRes.json()) as { url?: unknown }).url;
    if (typeof uploadUrl !== 'string' || !uploadUrl) return { ok: false, reason: 'upload URL response had no url' };
    if (!uploadUrl.startsWith('/')) {
      // A presigned URL means the app is not in self-host mode, so the upload proxy and MinIO
      // webhook this check exists to cover are not in play.
      return { ok: false, reason: 'upload URL is not the self-host proxy; is B4M_SELF_HOST=true on the app?' };
    }

    const putRes = await call('PUT', uploadUrl, {
      body: new Uint8Array(archive),
      headers: { 'Content-Type': 'application/zip' },
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
          const mine = jobs.find(j => !seenIds.has(String(j.id)) && j.source === 'Claude');
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
    if (!listRes.ok)
      return { ok: false, jobId, reason: `session list HTTP ${listRes.status}: ${await errorText(listRes)}` };
    const listed = ((await listRes.json()) as { data?: { id?: unknown; name?: unknown }[] }).data ?? [];

    const sessions: ReadbackSession[] = [];
    for (const s of listed) {
      const questsRes = await call('GET', `/api/v1/sessions/${encodeURIComponent(String(s.id))}/quests?limit=100`);
      if (!questsRes.ok) {
        return { ok: false, jobId, reason: `quest list HTTP ${questsRes.status}: ${await errorText(questsRes)}` };
      }
      const quests = ((await questsRes.json()) as { data?: { prompt?: unknown; reply?: unknown }[] }).data ?? [];
      sessions.push({
        name: String(s.name),
        quests: quests.map(q => ({
          prompt: typeof q.prompt === 'string' ? q.prompt : null,
          reply: typeof q.reply === 'string' ? q.reply : '',
        })),
      });
    }

    const verdict = evaluateReadback(expected, sessions);
    if (!verdict.ok) return { ok: false, jobId, reason: `job completed but ${verdict.reason}` };
    return { ok: true, jobId: jobId!, conversations: expected.length, exchanges: verdict.exchanges };
  } catch (err) {
    if (isAbort(err)) return timedOut();
    return { ok: false, jobId, reason: `request failed: ${messageOf(err)}` };
  }
}
