import { createHash } from 'crypto';
import { createWriteStream, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Readable, Transform } from 'stream';
import archiver from 'archiver';
import { z } from 'zod';
import {
  agentRepository,
  artifactContentRepository,
  artifactRepository,
  fabFileRepository,
  mementoRepository,
  memoryLedgerRepository,
  memoryPrincipalKeyRepository,
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
  isMissingObjectError,
} from '@bike4mind/server-utils/utils/accountDataExport';
import { createKeyProvider } from '@bike4mind/server-utils/memory/factCipher';
import { createLedgerMemoryStore } from '@bike4mind/server-utils/memory/ledgerMemoryStore';
import { EmailEvents } from '@server/utils/eventBus';
import { buildAccountDataExportReadyEmail } from '@server/utils/mailer/accountDataExportEmail';

const { NotebookExportService } = notebookExportService;

const AccountDataExportPayload = z.object({
  exportJobId: z.uuid(),
  userId: z.string().min(1),
});

// Original file bytes past this total are listed in files/index.json but not copied, so the zip
// stays under a single S3 PutObject (5 GB) and the function's ephemeral storage.
export const MAX_FILE_BYTES = 3 * 1024 ** 3;
// Left for the upload and the email once the file copy stops.
const UPLOAD_RESERVE_MS = 5 * 60 * 1000;
// Notebooks stop earlier than the file copy, so files and artifacts still get time.
const NOTEBOOK_RESERVE_MS = UPLOAD_RESERVE_MS + 3 * 60 * 1000;

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
  const counted = body.pipe(
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        streamed += chunk.length;
        callback(null, chunk);
      },
    })
  );
  body.once('error', error => counted.destroy(error));
  await appendEntry(archive, counted, zipPath, true);
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

  const generated = getGeneratedImageStorage();
  const copied = new Map<string, ImageRef>();
  const resolveImage = async (key: string): Promise<ImageRef> => {
    const fileId = fileIdByPath.get(key);
    if (fileId) return { fileId };
    const known = copied.get(key);
    if (known) return known;

    let ref: ImageRef;
    if (remainingMs() < NOTEBOOK_RESERVE_MS) {
      ref = { key, omitted: 'time_limit' };
    } else {
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
          budget.copiedBytes += await appendStream(archive, body, zipPath);
          ref = { path: zipPath };
        }
      } catch (error) {
        if (!isMissingObjectError(error)) throw error;
        logger.warn('Account data export: generated image missing', { key });
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
    if (remainingMs() < NOTEBOOK_RESERVE_MS) {
      stopped = true;
      break;
    }
    const next = await iterator.next();
    if (next.done) break;
    const notebook = next.value;
    const chatHistory = [];
    for (const message of notebook.chatHistory) {
      const images = message.images ? await Promise.all(message.images.map(resolveImage)) : undefined;
      chatHistory.push(images ? { ...message, images } : message);
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
        budget.copiedBytes += file.fileSize ?? streamed;
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

const readme = (exportedAt: Date) => `Your account data export
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
include the artifacts and files attached to them that others shared with you.
`;

async function buildArchive(
  zipPath: string,
  userId: string,
  storage: Storage,
  remainingMs: () => number,
  logger: Logger
) {
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
    await appendEntry(archive, readme(new Date()), 'README.txt');
    await writeProfile(archive, userId);
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
  const { exportJobId, userId } = secureParameters(JSON.parse(event.Records[0].body), AccountDataExportPayload);
  logger.updateMetadata({ exportJobId, userId });

  const user = await userRepository.findById(userId);
  if (!user?.email) {
    logger.warn('Account data export skipped: the account is gone or has no email to deliver to');
    return;
  }

  const appUrl = process.env.APP_URL?.trim();
  if (!appUrl) throw new Error('APP_URL is required to link an account data export');

  const storage = getFilesStorage();
  const key = accountDataExportKey(userId, exportJobId);

  // A redelivery after the upload only re-sends the email.
  const existing = await existingExport(storage, key);
  let builtAt = existing?.lastModified ?? null;
  if (!builtAt) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'account-data-export-'));
    try {
      const zipPath = path.join(dir, 'account-data.zip');
      await buildArchive(zipPath, userId, storage, () => context.getRemainingTimeInMillis(), logger);
      await storage.uploadFile(zipPath, key, { ContentType: 'application/zip' });
      builtAt = new Date();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  } else {
    logger.info('Account data export already built; re-sending the email');
  }

  const email = buildAccountDataExportReadyEmail({
    downloadPageUrl: `${appUrl.replace(/\/+$/, '')}/account-data-export/${exportJobId}`,
    expiresAt: new Date(builtAt.getTime() + ACCOUNT_DATA_EXPORT_TTL_MS),
  });
  await EmailEvents.Send.publish({ to: user.email, subject: email.subject, body: email.body });
});
