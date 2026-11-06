import { createHash, randomUUID } from 'crypto';
import { createReadStream, createWriteStream, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import archiver from 'archiver';
import { z } from 'zod';
import {
  User,
  agentRepository,
  artifactContentRepository,
  artifactRepository,
  fabFileRepository,
  mementoRepository,
  memoryLedgerRepository,
  memoryPrincipalKeyRepository,
  mongoose,
  projectRepository,
  questRepository,
  sessionRepository,
  toolRepository,
  userRepository,
} from '@bike4mind/database';
import { isImageServeable, toSafeUser } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { notebookExportService } from '@bike4mind/services';
import type { Logger } from '@bike4mind/observability';
import { dispatchWithLogger } from '@bike4mind/server-utils/queueHandlers/utils';
import { getFilesStorage, getGeneratedImageStorage } from '@bike4mind/server-utils/utils/storage/index';
import {
  ACCOUNT_DATA_EXPORT_TTL_MS,
  accountDataExportKey,
  adminDataExportKey,
  isMissingObjectError,
} from '@bike4mind/server-utils/utils/accountDataExport';
// Registered outside the `@bike4mind/database` barrel; the registry walk refuses a classified model
// it cannot query, so both must be registered here.
import '@bike4mind/server-utils/models/Subscription';
import '@server/models/UserSubscription';
import { SubjectRecordExport, assertEveryModelClassified } from '@server/dataSubject/subjectRecordExport';
import { createKeyProvider } from '@bike4mind/server-utils/memory/factCipher';
import { createLedgerMemoryStore } from '@bike4mind/server-utils/memory/ledgerMemoryStore';
import { EmailEvents } from '@server/utils/eventBus';
import { buildAccountDataExportReadyEmail } from '@server/utils/mailer/accountDataExportEmail';

const { NotebookExportService } = notebookExportService;

const AccountDataExportPayload = z.object({
  exportJobId: z.uuid(),
  userId: z.string().min(1),
  /**
   * The admin who requested a data subject export of `userId` (apps/client/pages/api/admin/users/
   * [userId]/data-export). Such an export adds the registry records, is stored under its own key and
   * is fetched from the admin profile, so the subject is not emailed.
   */
  requestedBy: z.string().min(1).optional(),
});

// Original file bytes past this total are listed in files/index.json but not copied, so the zip
// stays under a single S3 PutObject (5 GB) and the function's ephemeral storage.
export const MAX_FILE_BYTES = 3 * 1024 ** 3;
// Left for the upload and the email once the file copy stops.
const UPLOAD_RESERVE_MS = 5 * 60 * 1000;
const EXPORT_LEASE_MS = 20 * 60 * 1000;
// The registry records stop here, leaving the content sections a share before the upload reserve.
const RECORDS_RESERVE_MS = 2 * UPLOAD_RESERVE_MS;
// Aborts, timeouts and network resets are retried by SQS; any other per-object error omits that object.
const isTransientError = (error: unknown) => {
  const { name, code } = (error ?? {}) as { name?: string; code?: string };
  return (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EPIPE' ||
    code === 'ECONNABORTED'
  );
};

// Notebooks stop once two thirds of the time past the upload reserve is used, so files and
// artifacts keep a share on both the 15-minute Lambda and the shorter self-host budget.
const notebookReserveMs = (startingMs: number) => UPLOAD_RESERVE_MS + Math.max(0, startingMs - UPLOAD_RESERVE_MS) / 3;

type Archiver = archiver.Archiver;
type Storage = ReturnType<typeof getFilesStorage>;

/** Zip entry names: no path separators or control characters from user-chosen names, never twice the same. */
class ZipNames {
  private used = new Set<string>();

  name(dir: string, label: string | null | undefined, id: string, ext = ''): string {
    const safe =
      (label ?? '')
        .normalize('NFKD')
        .replace(/[^\w.\- ]+/g, '_')
        .replace(/^[.\s_]+|[.\s_]+$/g, '')
        .slice(0, 80) || 'untitled';
    // Id first so a file keeps its own extension at the end of the name.
    const base = `${dir}/${id.replace(/[^\w-]+/g, '_')}-${safe}`;
    let candidate = `${base}${ext}`;
    for (let n = 2; this.used.has(candidate); n++) candidate = `${dir}/${n}-${base.slice(dir.length + 1)}${ext}`;
    this.used.add(candidate);
    return candidate;
  }
}

/** Appends one entry and waits for archiver to consume it, so at most one source is buffered at a time. */
function appendEntry(archive: Archiver, source: string | Buffer | Readable, name: string, store = false) {
  return new Promise<void>((resolve, reject) => {
    const onEntry = () => {
      archive.off('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      archive.off('entry', onEntry);
      reject(error);
    };
    archive.once('entry', onEntry);
    archive.once('error', onError);
    archive.append(source, { name, store });
  });
}

/** Bytes copied into the zip so far, shared by files/ and images/ against MAX_FILE_BYTES. */
interface ByteBudget {
  copiedBytes: number;
}

/** Streams one storage body into the zip, stored uncompressed, and returns the bytes that went through. */
async function appendStream(archive: Archiver, body: unknown, zipPath: string): Promise<number> {
  if (!(body instanceof Readable)) throw new Error('Storage returned a non-stream body');
  let streamed = 0;
  // A Transform, not a 'data' listener: that would start the flow before archiver pipes the entry.
  const counted = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      streamed += chunk.length;
      callback(null, chunk);
    },
  });
  try {
    // pipeline installs stream error handlers before starting flow. Archiver queues entries,
    // so it may not have attached its own source error handler when an S3 body first fails.
    await Promise.all([appendEntry(archive, counted, zipPath, true), pipeline(body, counted)]);
  } catch (error) {
    body.destroy();
    counted.destroy();
    throw error;
  }
  return streamed;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);
const iso = (value: Date | string | null | undefined) => (value ? new Date(value).toISOString() : undefined);

async function writeProfile(archive: Archiver, userId: string) {
  const user = await userRepository.findById(userId);
  const safe = toSafeUser(user, 'self');
  await appendEntry(archive, json({ ...safe, createdAt: iso(user?.createdAt) }), 'profile.json');
}

type FabFileRow = Awaited<ReturnType<typeof fabFileRepository.find>>[number];

interface PlannedFile {
  file: FabFileRow;
  zipPath?: string;
}

/** Reads the user's files and fixes their zip names up front, so notebooks can point at them by id. */
async function planFiles(names: ZipNames, userId: string) {
  const rows = await fabFileRepository.find(
    { userId, deletedAt: null },
    { sort: { createdAt: 1 }, fileName: 1, fileSize: 1, mimeType: 1, filePath: 1, createdAt: 1, moderationStatus: 1 }
  );
  const fileIdByPath = new Map<string, string>();
  const planned: PlannedFile[] = rows.map(file => {
    if (file.filePath) fileIdByPath.set(file.filePath, file.id);
    const copyable = isImageServeable(file) && !!file.filePath;
    return { file, zipPath: copyable ? names.name('files', file.fileName, file.id) : undefined };
  });
  return { planned, fileIdByPath };
}

type ImageRef =
  { fileId: string } | { path: string } | { key: string; omitted: 'size_limit' | 'time_limit' | 'unavailable' };

interface NotebookIndexEntry {
  id: string;
  name: string;
  path?: string;
  omitted?: 'time_limit';
}

const NOTEBOOK_OPTIONS = {
  includeKnowledge: true,
  includeArtifacts: true,
  includeTools: true,
  includeAgents: true,
  anonymize: false,
  includeMetadata: true,
  includeImages: true,
  // Image keys stay keys: bytes are copied under images/ or found under files/, never inlined.
  imagesAsKeys: true,
  // Knowledge bytes ship once, under files/, instead of base64 inside every notebook that uses them.
  maxFileSize: 0,
};

async function writeNotebooks(
  archive: Archiver,
  names: ZipNames,
  userId: string,
  fileIdByPath: Map<string, string>,
  budget: ByteBudget,
  remainingMs: () => number,
  logger: Logger
) {
  const service = new NotebookExportService({
    sessionRepository,
    chatHistoryRepository: questRepository,
    knowledgeRepository: fabFileRepository,
    artifactRepository,
    artifactContentRepository,
    toolRepository,
    agentRepository,
    fileStorageService: {
      getFileContent: async (filePath: string) => {
        try {
          return await getFilesStorage().getContentAsBuffer(filePath);
        } catch (error) {
          logger.warn('Account data export: notebook file content unavailable', { filePath, error });
          return null;
        }
      },
      uploadFile: async () => {
        throw new Error('The account data export never stores a notebook export on its own');
      },
      getSignedUrl: async () => null,
    },
    logger,
  });

  const reserveMs = notebookReserveMs(remainingMs());
  const generated = getGeneratedImageStorage();
  const copied = new Map<string, ImageRef>();
  const resolveImage = async (key: string): Promise<ImageRef> => {
    const fileId = fileIdByPath.get(key);
    if (fileId) return { fileId };
    const known = copied.get(key);
    if (known) return known;

    let ref: ImageRef;
    if (remainingMs() < reserveMs) {
      ref = { key, omitted: 'time_limit' };
    } else {
      let appendStarted = false;
      try {
        const { size = 0 } = await generated.getMetadata(key);
        if (budget.copiedBytes + size > MAX_FILE_BYTES) {
          ref = { key, omitted: 'size_limit' };
        } else {
          const body = await generated.getContent(key);
          const ext = path.extname(key);
          const zipPath = names.name(
            'images',
            path.basename(key, ext),
            createHash('sha1').update(key).digest('hex').slice(0, 10),
            /^\.\w{1,8}$/.test(ext) ? ext : ''
          );
          // Once insertion starts, an error invalidates the archive; omission is only safe
          // for lookup failures before any entry bytes have been written.
          appendStarted = true;
          budget.copiedBytes += await appendStream(archive, body, zipPath);
          ref = { path: zipPath };
        }
      } catch (error) {
        if (appendStarted || isTransientError(error)) throw error;
        logger.warn('Account data export: generated image unavailable', {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
        ref = { key, omitted: 'unavailable' };
      }
    }
    copied.set(key, ref);
    return ref;
  };

  const index: NotebookIndexEntry[] = [];
  const iterator = service.buildNotebooks(userId, NOTEBOOK_OPTIONS);
  let stopped = false;
  for (;;) {
    if (remainingMs() < reserveMs) {
      stopped = true;
      break;
    }
    const next = await iterator.next();
    if (next.done) break;
    const notebook = next.value;
    const chatHistory = [];
    for (const message of notebook.chatHistory) {
      if (!message.images) {
        chatHistory.push(message);
        continue;
      }
      // One at a time: each copy is a zip entry, and appendEntry buffers a single source.
      const images: ImageRef[] = [];
      for (const key of message.images) images.push(await resolveImage(key));
      chatHistory.push({ ...message, images });
    }
    const zipPath = names.name('notebooks', notebook.name, notebook.id, '.json');
    await appendEntry(archive, json({ ...notebook, chatHistory }), zipPath);
    index.push({ id: notebook.id, name: notebook.name, path: zipPath });
  }
  await iterator.return(undefined);

  if (stopped) {
    const written = new Set(index.map(n => n.id));
    for (const { id, name } of await service.listNotebooks(userId, NOTEBOOK_OPTIONS)) {
      if (!written.has(id)) index.push({ id, name, omitted: 'time_limit' });
    }
  }
  await appendEntry(archive, json(index), 'notebooks/index.json');
  return { count: index.filter(n => n.path).length, omitted: index.filter(n => n.omitted).length };
}

interface FileIndexEntry {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
  createdAt?: string;
  path?: string;
  omitted?: 'moderation' | 'size_limit' | 'time_limit' | 'unavailable';
}

async function writeFiles(
  archive: Archiver,
  planned: PlannedFile[],
  storage: Storage,
  budget: ByteBudget,
  remainingMs: () => number,
  logger: Logger
) {
  const index: FileIndexEntry[] = [];
  for (const { file, zipPath } of planned) {
    const entry: FileIndexEntry = {
      id: file.id,
      name: file.fileName,
      mimeType: file.mimeType,
      size: file.fileSize,
      createdAt: iso(file.createdAt),
    };
    index.push(entry);

    if (!isImageServeable(file)) {
      entry.omitted = 'moderation';
    } else if (!file.filePath || !zipPath) {
      entry.omitted = 'unavailable';
    } else if (budget.copiedBytes + (file.fileSize ?? 0) > MAX_FILE_BYTES) {
      entry.omitted = 'size_limit';
    } else if (remainingMs() < UPLOAD_RESERVE_MS) {
      entry.omitted = 'time_limit';
    } else {
      try {
        const streamed = await appendStream(archive, await storage.getContent(file.filePath), zipPath);
        entry.path = zipPath;
        budget.copiedBytes += streamed;
      } catch (error) {
        if (!isMissingObjectError(error)) throw error;
        logger.warn('Account data export: file object missing', { fileId: file.id });
        entry.omitted = 'unavailable';
      }
    }
  }

  await appendEntry(archive, json(index), 'files/index.json');
  return { count: index.length, omitted: index.filter(f => f.omitted).length };
}

async function writeMemories(archive: Archiver, userId: string) {
  const legacy = await mementoRepository.find({ userId }, { embedding: 0 });
  const profile = await createLedgerMemoryStore({
    ledger: memoryLedgerRepository,
    keys: createKeyProvider(memoryPrincipalKeyRepository),
    ownerUserId: userId,
  }).readProfile({ kind: 'user', id: userId });

  await appendEntry(
    archive,
    json({
      mementos: legacy.map(m => ({
        id: m.id,
        type: m.type,
        tier: m.tier,
        summary: m.summary,
        fullContent: m.fullContent,
        tags: m.tags,
        sessionId: m.sessionId,
        createdAt: iso(m.createdAt),
        updatedAt: iso(m.updatedAt),
      })),
      beliefs: (profile?.beliefs ?? [])
        .filter(b => !b.shredded)
        .map(b => ({
          id: b.id,
          fact: b.fact,
          evidenceTier: b.evidenceTier,
          confidence: b.confidence,
          salience: b.salience,
        })),
    }),
    'memories.json'
  );
}

interface ArtifactIndexEntry {
  id: string;
  title?: string;
  type?: string;
  createdAt?: string;
  path?: string;
  omitted?: 'time_limit';
}

async function writeArtifacts(archive: Archiver, names: ZipNames, userId: string, remainingMs: () => number) {
  const artifacts = await artifactRepository.find({ userId, deletedAt: null }, { sort: { createdAt: 1 } });
  const index: ArtifactIndexEntry[] = [];
  for (const artifact of artifacts) {
    const entry: ArtifactIndexEntry = {
      id: artifact.id,
      title: artifact.title,
      type: artifact.type,
      createdAt: iso(artifact.createdAt),
    };
    index.push(entry);
    if (remainingMs() < UPLOAD_RESERVE_MS) {
      entry.omitted = 'time_limit';
      continue;
    }
    // Newest content row, the same rule the viewer and the notebook export resolve the body by.
    const [latest] = await artifactContentRepository.find(
      { artifactId: artifact.id },
      { sort: { version: -1 }, limit: 1 }
    );
    const zipPath = names.name('artifacts', artifact.title, artifact.id, '.json');
    await appendEntry(
      archive,
      json({
        id: artifact.id,
        title: artifact.title,
        type: artifact.type,
        sessionId: artifact.sessionId,
        createdAt: iso(artifact.createdAt),
        updatedAt: iso(artifact.updatedAt),
        metadata: artifact.metadata,
        content: latest?.content,
      }),
      zipPath
    );
    entry.path = zipPath;
  }
  await appendEntry(archive, json(index), 'artifacts/index.json');
  return { count: index.length, omitted: index.filter(a => a.omitted).length };
}

async function writeAgentsAndProjects(archive: Archiver, userId: string) {
  const agents = await agentRepository.find({ userId, deletedAt: null });
  await appendEntry(
    archive,
    json(
      agents.map(a => ({
        id: a.id,
        name: a.name,
        description: a.description,
        type: a.type,
        firstMessage: a.firstMessage,
        triggerWords: a.triggerWords,
        systemPrompt: a.systemPrompt,
        allowedTools: a.allowedTools,
        deniedTools: a.deniedTools,
        defaultThoroughness: a.defaultThoroughness,
        isPublic: a.isPublic,
        createdAt: iso(a.createdAt),
        updatedAt: iso(a.updatedAt),
      }))
    ),
    'agents.json'
  );

  const projects = await projectRepository.find({ userId, deletedAt: null });
  await appendEntry(
    archive,
    json(
      projects.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        sessionIds: p.sessionIds,
        fileIds: p.fileIds,
        createdAt: iso(p.createdAt),
        updatedAt: iso(p.updatedAt),
      }))
    ),
    'projects.json'
  );
}

const RECORDS_README = `
records/           Admin data subject export only: every stored record that names this person, one
                   NDJSON file per collection (records/<Model>.ndjson), walked from the data holder
                   registry. Credentials, token hashes and other secrets are removed. Where a record
                   belongs to someone else and only lists this person in an array (a shared
                   notebook's members), just this person's entries and the record id are included.
                   records/index.json lists every collection searched with its record count; an
                   "omitted" value of time_limit or error means that collection is not included.
`;

const readme = (
  exportedAt: Date,
  includesRecords: boolean
) => `${includesRecords ? 'Data subject export' : 'Your account data export'}
Created: ${exportedAt.toISOString()}

profile.json       Your profile: name, username, email, photo, and when the account was created.
notebooks/         One JSON file per notebook: its messages, and the knowledge files, artifacts,
                   tools and agents attached to it.
                   notebooks/index.json lists every notebook; an "omitted" value of time_limit
                   means the export ran out of time before that notebook was written.
                   Images in messages are listed as references: { "fileId" } for one of your
                   uploaded files (see files/), { "path" } for a copy under images/, or
                   { "key", "omitted" } when the image could not be copied (size_limit,
                   time_limit, or unavailable).
images/            Images generated in your notebooks.
files/             The original bytes of every file you uploaded. files/index.json lists each file;
                   an "omitted" value says why a file's bytes are not included (a moderation
                   hold, including files still being scanned,
                   the ${Math.round(MAX_FILE_BYTES / 1024 ** 3)} GB export limit, time limit, or missing from storage).
memories.json      Memories saved about you, from both memory systems.
artifacts/         One JSON file per artifact you own, with its latest content. artifacts/index.json
                   lists every artifact; an "omitted" value of time_limit means the export ran out
                   of time before that artifact was written.
agents.json        Agents you created.
projects.json      Projects you own.

Deleted items, other data shared with you by others, and credentials (passwords, API keys, tokens,
two-factor secrets and connected-app grants) are not included. The exception is notebooks, which also
include artifacts and files attached to them that others shared with you or made public, and messages
and images that other participants added to a shared notebook.
${includesRecords ? RECORDS_README : ''}`;

type RecordsIndexEntry = { model: string; count: number; omitted?: 'time_limit' | 'error' };

/** Streams one model's records to a scratch NDJSON file and returns how many there were. */
async function writeModelRecords(exporter: SubjectRecordExport, model: string, scratchPath: string): Promise<number> {
  let count = 0;
  async function* lines() {
    for await (const record of exporter.records(model)) {
      count++;
      yield `${JSON.stringify(record)}\n`;
    }
  }
  await pipeline(Readable.from(lines()), createWriteStream(scratchPath));
  return count;
}

/**
 * The registry walk (apps/client/server/dataSubject): each model goes to a scratch file first, so a
 * model that fails is listed as omitted without corrupting the zip entry being written.
 */
async function writeRegistryRecords(
  archive: Archiver,
  scratchDir: string,
  subject: { userId: string; email: string | null },
  remainingMs: () => number,
  logger: Logger
) {
  assertEveryModelClassified(mongoose.modelNames());
  const exporter = new SubjectRecordExport(subject);
  const index: RecordsIndexEntry[] = [];
  for (const model of exporter.models) {
    if (remainingMs() < RECORDS_RESERVE_MS) {
      index.push({ model, count: 0, omitted: 'time_limit' });
      continue;
    }
    const scratchPath = path.join(scratchDir, `records-${index.length}.ndjson`);
    try {
      const count = await writeModelRecords(exporter, model, scratchPath);
      if (count > 0) await appendEntry(archive, createReadStream(scratchPath), `records/${model}.ndjson`);
      index.push({ model, count });
    } catch (error) {
      if (isTransientError(error)) throw error;
      // A child of an omitted parent fails here too, so the gap shows for every collection it affects.
      logger.error('Data subject export: collection omitted', { model, error });
      index.push({ model, count: 0, omitted: 'error' });
    } finally {
      await fs.rm(scratchPath, { force: true });
    }
  }
  await appendEntry(archive, json({ collections: index }), 'records/index.json');
  return { collections: index.length, omitted: index.filter(entry => entry.omitted).length };
}

async function buildArchive(
  zipPath: string,
  subject: { userId: string; email: string | null },
  includeRecords: boolean,
  storage: Storage,
  remainingMs: () => number,
  logger: Logger
) {
  const { userId } = subject;
  const output = createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 6 } });
  const closed = new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
  });
  // Observed here so a failure while entries are still being added is not an unhandled rejection.
  closed.catch(() => undefined);
  archive.pipe(output);

  const names = new ZipNames();
  try {
    await appendEntry(archive, readme(new Date(), includeRecords), 'README.txt');
    await writeProfile(archive, userId);
    // First, so the structured records a data subject request is about get the time budget before
    // the bulk file copy.
    const records = includeRecords
      ? await writeRegistryRecords(archive, path.dirname(zipPath), subject, remainingMs, logger)
      : null;
    const budget: ByteBudget = { copiedBytes: 0 };
    const { planned, fileIdByPath } = await planFiles(names, userId);
    const notebooks = await writeNotebooks(archive, names, userId, fileIdByPath, budget, remainingMs, logger);
    const files = await writeFiles(archive, planned, storage, budget, remainingMs, logger);
    await writeMemories(archive, userId);
    const artifacts = await writeArtifacts(archive, names, userId, remainingMs);
    await writeAgentsAndProjects(archive, userId);
    await archive.finalize();
    await closed;
    logger.info('Account data export built', {
      notebooks: notebooks.count,
      notebooksOmitted: notebooks.omitted,
      files: files.count,
      filesOmitted: files.omitted,
      artifacts: artifacts.count,
      artifactsOmitted: artifacts.omitted,
      ...(records && { recordCollections: records.collections, recordCollectionsOmitted: records.omitted }),
    });
  } catch (error) {
    archive.abort();
    output.destroy();
    throw error;
  }
}

async function existingExport(storage: Storage, key: string) {
  try {
    return await storage.getMetadata(key);
  } catch (error) {
    if (isMissingObjectError(error)) return null;
    throw error;
  }
}

export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  const { exportJobId, userId, requestedBy } = secureParameters(
    JSON.parse(event.Records[0].body),
    AccountDataExportPayload
  );
  logger.updateMetadata({ exportJobId, userId, requestedBy });
  const forAdmin = requestedBy !== undefined;
  const key = forAdmin ? adminDataExportKey(userId, exportJobId) : accountDataExportKey(userId, exportJobId);
  const removeSkippedExport = () => getFilesStorage().deletePermanently(key);

  const user = await userRepository.findById(userId);
  // An admin export is fetched from the admin profile, so it does not need an address to deliver to.
  if (!user || (!forAdmin && !user.email)) {
    logger.warn('Account data export skipped: the account is gone or has no email to deliver to');
    await removeSkippedExport();
    return;
  }

  const now = new Date();
  const deletionDue = (account: typeof user) =>
    !!account?.deletion?.purgeStartedAt ||
    (!!account?.deletion?.scheduledFor && new Date(account.deletion.scheduledFor).getTime() <= Date.now());
  if (deletionDue(user)) {
    logger.info('Account data export skipped: permanent deletion is due or has started');
    await removeSkippedExport();
    return;
  }
  const appUrl = process.env.APP_URL?.trim();
  if (!appUrl) throw new Error('APP_URL is required to link an account data export');

  // The purge's atomic claim checks this same User document. Holding the lease prevents
  // prefix cleanup and final user deletion from racing a slow export upload.
  const leaseId = randomUUID();
  const admissionFilter = {
    _id: userId,
    deletedAt: null,
    'deletion.purgeStartedAt': null,
    $or: [{ 'deletion.scheduledFor': null }, { 'deletion.scheduledFor': { $gt: now } }],
  };
  const claimed = await User.findOneAndUpdate(
    {
      ...admissionFilter,
      $and: [
        { $or: [{ 'accountDataExportLease.expiresAt': null }, { 'accountDataExportLease.expiresAt': { $lte: now } }] },
      ],
    },
    { $set: { accountDataExportLease: { id: leaseId, expiresAt: new Date(now.getTime() + EXPORT_LEASE_MS) } } },
    { new: true, projection: { email: 1 } }
  ).lean<{ email?: string | null }>();
  if (!claimed) {
    const current = await userRepository.findById(userId);
    if (!current || deletionDue(current)) {
      logger.info('Account data export skipped: permanent deletion won admission');
      await removeSkippedExport();
      return;
    }
    throw new Error('Another account data export holds the account lease');
  }
  const leaseFilter = () => ({
    ...admissionFilter,
    $or: [{ 'deletion.scheduledFor': null }, { 'deletion.scheduledFor': { $gt: new Date() } }],
    'accountDataExportLease.id': leaseId,
    'accountDataExportLease.expiresAt': { $gt: new Date() },
  });
  const hasLease = async () => !!(await User.exists(leaseFilter()));
  const assertLease = async () => {
    if (!(await hasLease())) throw new Error('Account data export lease lost or account deletion is due');
  };

  const storage = getFilesStorage();
  let releaseLease = true;
  try {
    // A redelivery after the upload only re-sends the email.
    const existing = await existingExport(storage, key);
    const fresh = existing?.lastModified && Date.now() - existing.lastModified.getTime() < ACCOUNT_DATA_EXPORT_TTL_MS;
    let builtAt = fresh ? existing.lastModified : null;
    if (!builtAt) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'account-data-export-'));
      try {
        const zipPath = path.join(dir, 'account-data.zip');
        await buildArchive(
          zipPath,
          { userId, email: user.email ?? null },
          forAdmin,
          storage,
          () => context.getRemainingTimeInMillis(),
          logger
        );
        await assertLease();
        const uploadTimeoutMs = Math.min(UPLOAD_RESERVE_MS, context.getRemainingTimeInMillis() - 1000);
        if (uploadTimeoutMs <= 0) throw new Error('No remaining time to upload the account data export');
        // Self-host budgets are cooperative, so building can overrun them. Renew atomically
        // before the remote write and bound its total duration below the renewed lease.
        const renewed = await User.updateOne(leaseFilter(), {
          $set: { 'accountDataExportLease.expiresAt': new Date(Date.now() + EXPORT_LEASE_MS) },
        });
        if (renewed.matchedCount !== 1) throw new Error('Account data export lease lost before upload');
        try {
          await storage.uploadFile(
            zipPath,
            key,
            { ContentType: 'application/zip' },
            AbortSignal.timeout(uploadTimeoutMs)
          );
        } catch (error) {
          // A failed response does not prove S3 rejected the write. Keep the renewed fence
          // until expiry even after cleanup: the remote PutObject may commit after deletion.
          releaseLease = false;
          try {
            await storage.deletePermanently(key);
          } catch (cleanupError) {
            logger.error('Account data export: failed to reconcile an ambiguous upload', { key, cleanupError });
          }
          throw error;
        }
        if (!(await hasLease())) {
          // Remote success survives loss of the local lease. Erase the object before
          // reporting failure, so a retrying purge cannot miss a late export upload.
          await storage.deletePermanently(key);
          throw new Error('Account data export lease lost after upload');
        }
        builtAt = new Date();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    } else {
      logger.info('Account data export already built; not rebuilding it');
    }

    await assertLease();
    if (forAdmin) {
      logger.info('Data subject export ready for the requesting admin');
      return;
    }
    const email = buildAccountDataExportReadyEmail({
      downloadPageUrl: `${appUrl.replace(/\/+$/, '')}/account-data-export/${exportJobId}`,
      expiresAt: new Date(builtAt.getTime() + ACCOUNT_DATA_EXPORT_TTL_MS),
    });
    const deliverTo = claimed.email || user.email;
    if (!deliverTo) throw new Error('No email to deliver the account data export to');
    await EmailEvents.Send.publish({ to: deliverTo, subject: email.subject, body: email.body });
  } finally {
    if (releaseLease) {
      await User.updateOne(
        { _id: userId, 'accountDataExportLease.id': leaseId },
        { $unset: { accountDataExportLease: 1 } }
      );
    }
  }
});
