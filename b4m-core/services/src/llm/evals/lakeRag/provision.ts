/**
 * Builds the eval's lakes on a live deployment through the public HTTP API: one lake per corpus
 * subject, every document uploaded, attached and polled to `ready`. Fetch-injected and fs-free so
 * the subpath stays importable anywhere; `corpus.ts` is the node:fs half.
 */
import { call, pollUntil, resolved, stringField, type LakeRagCredential } from './http';

export type { LakeRagCredential } from './http';

export type LakeRagApi = {
  baseUrl: string;
  /**
   * Full header value (`Bearer b4m_live_...`), or a credential that renews an expiring JWT and is
   * retried once on a 401. Never echoed into errors.
   */
  authorization: string | LakeRagCredential;
  fetch?: typeof fetch;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /**
   * A just-attached file reports `not_ingested` until its first chunk lands
   * (retrievalUnavailable.ts), so that status is only fatal once it outlasts this window (ms).
   */
  notIngestedGraceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type CorpusDoc = {
  subject: string;
  /** Bare file name, never prefixed with `superseded/`, so both generations share an identity. */
  fileName: string;
  generation: 'superseded' | 'current';
  body: string;
};

export type ProvisionedLake = { id: string; datalakeTag: string };

export type LakeRagProvision = {
  lakes: Record<string, ProvisionedLake>;
  /** Best-effort; resolves to the error messages of the deletes that failed. */
  teardown(): Promise<string[]>;
};

// The presign is not ContentType-bound (apps/client/server/files/createPresignedUpload.ts); the PUT
// sends the type the file was created with so the stored object matches its record.
const MARKDOWN_MIME = 'text/markdown';
const RUN_ID = /^[a-z0-9]{1,12}$/;

async function createLake(api: LakeRagApi, subject: string, runId: string): Promise<ProvisionedLake> {
  const slug = `lakerag-eval-${subject}-${runId}`;
  const lake = await call(api, 'POST', '/api/data-lakes', {
    name: slug,
    slug,
    // MAX_TAG_PREFIX_LENGTH is 30: 3 + 12 + 1 + 12 + 1 at most.
    fileTagPrefix: `lr-${runId}-${subject.slice(0, 12)}:`,
  });
  const id = typeof lake.id === 'string' ? lake.id : stringField(lake, '_id', `create lake ${slug}`);
  return { id, datalakeTag: stringField(lake, 'datalakeTag', `create lake ${slug}`) };
}

async function uploadFile(api: LakeRagApi, doc: CorpusDoc): Promise<string> {
  const label = `${doc.subject}/${doc.generation}/${doc.fileName}`;
  const created = await call(api, 'POST', '/api/v1/files', {
    file_name: doc.fileName,
    mime_type: MARKDOWN_MIME,
    file_size: new TextEncoder().encode(doc.body).byteLength,
  });
  const fileId = stringField(created, 'id', label);
  // Presigned: the signature is the credential, so no Authorization header goes to storage.
  const put = await resolved(api).fetch(stringField(created, 'upload_url', label), {
    method: 'PUT',
    headers: { 'Content-Type': MARKDOWN_MIME },
    body: doc.body,
  });
  if (!put.ok) throw new Error(`${label}: upload PUT -> ${put.status}`);

  await pollUntil(api, `${label} moderation`, async () => {
    const status = (await call(api, 'GET', `/api/v1/files/${fileId}`)).moderation_status;
    // null predates scanning and counts as clean (schemas/publicFile.ts).
    if (status === null || status === 'clean') return { done: true };
    if (status === 'pending' || status === 'scanning') return { done: false, status };
    throw new Error(`${label}: moderation_status ${String(status)}`);
  });
  return fileId;
}

async function attachAndIngest(
  api: LakeRagApi,
  lakeId: string,
  fileId: string,
  label: string,
  onAttached: () => void
): Promise<void> {
  const path = `/api/v1/data-lakes/${lakeId}/files/${fileId}`;
  await call(api, 'POST', path);
  onAttached();
  const { now, notIngestedGraceMs } = resolved(api);
  const attachedAt = now();
  await pollUntil(api, `${label} ingestion`, async () => {
    const status = (await call(api, 'GET', path)).ingestion_status;
    if (status === 'ready') return { done: true };
    if (status === 'indexing') return { done: false, status };
    if (status === 'not_ingested' && now() - attachedAt < notIngestedGraceMs) return { done: false, status };
    throw new Error(`${label}: ingestion_status ${String(status)}`);
  });
}

// A new lake starts as a draft, and a draft lake does not ground chat, so each lake is promoted
// once all of its files are ready (lifecycle.ts -> promoteDataLake.ts; idempotent on 'active').
async function promoteLake(api: LakeRagApi, subject: string, lakeId: string): Promise<void> {
  const lake = await call(api, 'POST', `/api/data-lakes/${lakeId}/lifecycle`, { action: 'promote' });
  if (lake.status !== 'active') throw new Error(`promote lake ${subject}: status ${String(lake.status)}`);
}

/**
 * Supersession ranks by `createdAt`, so every superseded generation is registered and fully
 * ingested before any current one is even created, and the lake is promoted only after both.
 * A partial failure tears down what exists and rethrows the original error, or an AggregateError
 * carrying it plus whatever teardown could not delete. Uploaded files
 * outlive teardown (v1 has no file DELETE).
 */
export async function provisionLakeRagLakes(
  api: LakeRagApi,
  docs: readonly CorpusDoc[],
  { runId }: { runId: string }
): Promise<LakeRagProvision> {
  if (docs.length === 0) throw new Error('provisionLakeRagLakes: no corpus documents');
  if (!RUN_ID.test(runId)) throw new Error(`provisionLakeRagLakes: runId must match ${RUN_ID}`);

  const lakes: Record<string, ProvisionedLake> = {};
  const attachments: { lakeId: string; fileId: string }[] = [];
  let teardownRun: Promise<string[]> | undefined;
  const teardown = () =>
    (teardownRun ??= (async () => {
      const errors: string[] = [];
      const attempt = async (method: string, path: string) => {
        try {
          await call(api, method, path);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      };
      for (const { lakeId, fileId } of attachments)
        await attempt('DELETE', `/api/v1/data-lakes/${lakeId}/files/${fileId}`);
      // Archives the lake ([id].ts DELETE).
      for (const lake of Object.values(lakes)) await attempt('DELETE', `/api/data-lakes/${lake.id}`);
      return errors;
    })());

  try {
    const subjects = [...new Set(docs.map(d => d.subject))];
    for (const subject of subjects) lakes[subject] = await createLake(api, subject, runId);
    for (const subject of subjects) {
      for (const generation of ['superseded', 'current'] as const) {
        for (const doc of docs.filter(d => d.subject === subject && d.generation === generation)) {
          const fileId = await uploadFile(api, doc);
          const lakeId = lakes[subject].id;
          await attachAndIngest(api, lakeId, fileId, `${subject}/${generation}/${doc.fileName}`, () =>
            attachments.push({ lakeId, fileId })
          );
        }
      }
      await promoteLake(api, subject, lakes[subject].id);
    }
  } catch (err) {
    const left = await teardown();
    if (left.length === 0) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new AggregateError(
      [err, ...left.map(m => new Error(m))],
      `${message}; teardown left ${left.length} failed delete(s)`
    );
  }
  return { lakes, teardown };
}
