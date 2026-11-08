import { readFile } from 'fs/promises';
import { Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import yauzl from 'yauzl';
import type { Context, SQSEvent } from 'aws-lambda';

const USER_ID = 'user-1';
const JOB_ID = '7d0c1f5e-9a7b-4c1e-8f0a-2b3c4d5e6f70';
const KEY = `exports/account-data/${USER_ID}/${JOB_ID}/account-data.zip`;

const h = vi.hoisted(() => ({
  uploaded: null as Buffer | null,
  getMetadata: vi.fn(),
  getContent: vi.fn(),
  genMetadata: vi.fn(),
  genContent: vi.fn(),
  uploadFile: vi.fn(),
  publish: vi.fn(),
  userFindById: vi.fn(),
  leaseClaim: vi.fn(),
  leaseExists: vi.fn(),
  leaseRelease: vi.fn(),
  leaseRenew: vi.fn(),
  permanentDelete: vi.fn(),
  fabFind: vi.fn(),
  mementoFind: vi.fn(),
  artifactFind: vi.fn(),
  artifactContentFind: vi.fn(),
  agentFind: vi.fn(),
  projectFind: vi.fn(),
  readProfile: vi.fn(),
  notebooks: [] as Array<{ id: string; name: string; chatHistory?: Array<{ images?: string[] }> }>,
}));

vi.mock('@bike4mind/server-utils/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
}));
vi.mock('@bike4mind/utils', () => ({
  secureParameters: (obj: unknown, schema: { parse: (value: unknown) => unknown }) => schema.parse(obj),
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: h.userFindById },
  User: {
    findOneAndUpdate: (...args: unknown[]) => ({ lean: () => h.leaseClaim(...args) }),
    exists: h.leaseExists,
    updateOne: (filter: unknown, update: { $set?: unknown }) =>
      update.$set ? h.leaseRenew(filter, update) : h.leaseRelease(filter, update),
  },
  fabFileRepository: { find: h.fabFind },
  mementoRepository: { find: h.mementoFind },
  artifactRepository: { find: h.artifactFind },
  artifactContentRepository: { find: h.artifactContentFind },
  agentRepository: { find: h.agentFind },
  projectRepository: { find: h.projectFind },
  sessionRepository: {},
  questRepository: {},
  toolRepository: {},
  memoryLedgerRepository: {},
  memoryPrincipalKeyRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  notebookExportService: {
    NotebookExportService: class {
      async *buildNotebooks() {
        for (const notebook of h.notebooks) yield { chatHistory: [], ...notebook };
      }
      async listNotebooks() {
        return h.notebooks.map(({ id, name }) => ({ id, name }));
      }
    },
  },
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({
    getMetadata: h.getMetadata,
    getContent: h.getContent,
    uploadFile: h.uploadFile,
    deletePermanently: h.permanentDelete,
  }),
  getGeneratedImageStorage: () => ({ getMetadata: h.genMetadata, getContent: h.genContent }),
}));
vi.mock('@bike4mind/server-utils/memory/factCipher', () => ({ createKeyProvider: () => ({}) }));
vi.mock('@bike4mind/server-utils/memory/ledgerMemoryStore', () => ({
  createLedgerMemoryStore: () => ({ readProfile: h.readProfile }),
}));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({ EmailEvents: { Send: { publish: h.publish } } }));

import { ACCOUNT_DATA_EXPORT_TTL_MS } from '@bike4mind/server-utils/utils/accountDataExport';
import { dispatch, MAX_FILE_BYTES } from './accountDataExport';

const logger = { updateMetadata: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const FULL_BUDGET_MS = 15 * 60 * 1000;
let remainingMs: () => number = () => FULL_BUDGET_MS;
const context = { getRemainingTimeInMillis: () => remainingMs() } as Context;
const run = (body: unknown = { exportJobId: JOB_ID, userId: USER_ID }) =>
  (dispatch as unknown as (event: SQSEvent, context: Context, logger: unknown) => Promise<void>)(
    { Records: [{ body: JSON.stringify(body) }] } as SQSEvent,
    context,
    logger
  );

async function unzip(buffer: Buffer): Promise<Map<string, string>> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zf) => (err || !zf ? reject(err) : resolve(zf)))
  );
  const entries = new Map<string, string>();
  return new Promise((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', () => resolve(entries));
    zip.on('entry', (entry: yauzl.Entry) => {
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) return reject(err);
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          entries.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
}

const notFound = () => Object.assign(new Error('Not Found'), { name: 'NotFound' });

beforeEach(() => {
  vi.clearAllMocks();
  h.leaseClaim.mockResolvedValue({ email: 'ada@example.com' });
  h.leaseRenew.mockResolvedValue({ matchedCount: 1 });
  h.leaseExists.mockResolvedValue({ _id: USER_ID });
  process.env.APP_URL = 'https://app.example.com/';
  remainingMs = () => FULL_BUDGET_MS;
  h.uploaded = null;
  h.notebooks = [{ id: 'nb-1', name: 'Trip/plans' }];
  h.getMetadata.mockRejectedValue(notFound());
  h.uploadFile.mockImplementation(async (localPath: string) => {
    h.uploaded = await readFile(localPath);
  });
  h.getContent.mockImplementation(async () => Readable.from([Buffer.from('file-bytes')]));
  h.genMetadata.mockResolvedValue({ size: 9 });
  h.genContent.mockImplementation(async () => Readable.from([Buffer.from('image-png')]));
  h.userFindById.mockResolvedValue({
    id: USER_ID,
    name: 'Ada',
    username: 'ada',
    email: 'ada@example.com',
    password: 'hash-must-not-ship',
    mfa: { secret: 'mfa-must-not-ship' },
    createdAt: new Date('2025-01-01T00:00:00Z'),
  });
  h.fabFind.mockResolvedValue([
    {
      id: 'f1',
      fileName: 'notes.txt',
      fileSize: 10,
      mimeType: 'text/plain',
      filePath: 'u/notes.txt',
      moderationStatus: 'clean',
    },
    {
      id: 'f2',
      fileName: 'notes.txt',
      fileSize: 10,
      mimeType: 'text/plain',
      filePath: 'u/other.txt',
      moderationStatus: 'clean',
    },
    {
      id: 'f3',
      fileName: 'held.png',
      fileSize: 10,
      mimeType: 'image/png',
      filePath: 'u/held.png',
      moderationStatus: 'pending',
    },
  ]);
  h.mementoFind.mockResolvedValue([{ id: 'm1', summary: 'Likes tea', fullContent: 'Likes green tea' }]);
  h.readProfile.mockResolvedValue({
    beliefs: [
      { id: 'b1', fact: 'Lives in Paris', evidenceTier: 'stated', confidence: 0.9, embedding: [0.1] },
      { id: 'b2', fact: '[shredded]', shredded: true },
    ],
  });
  h.artifactFind.mockResolvedValue([{ id: 'artifact_1', title: 'Plan', type: 'markdown' }]);
  h.artifactContentFind.mockResolvedValue([{ artifactId: 'artifact_1', version: 2, content: '# Plan v2' }]);
  h.agentFind.mockResolvedValue([{ id: 'a1', name: 'Helper', description: 'Helps' }]);
  h.projectFind.mockResolvedValue([{ id: 'p1', name: 'Home', description: '' }]);
});

describe('account data export worker', () => {
  it('builds the zip with every category and emails a link to the app page', async () => {
    await run();

    expect(h.uploadFile).toHaveBeenCalledWith(
      expect.any(String),
      KEY,
      { ContentType: 'application/zip' },
      expect.any(AbortSignal)
    );
    const entries = await unzip(h.uploaded!);
    expect([...entries.keys()].sort()).toEqual([
      'README.txt',
      'agents.json',
      'artifacts/artifact_1-Plan.json',
      'artifacts/index.json',
      'files/f1-notes.txt',
      'files/f2-notes.txt',
      'files/index.json',
      'memories.json',
      'notebooks/index.json',
      'notebooks/nb-1-Trip_plans.json',
      'profile.json',
      'projects.json',
    ]);

    const profile = entries.get('profile.json')!;
    expect(JSON.parse(profile)).toMatchObject({ id: USER_ID, email: 'ada@example.com' });
    expect(profile).not.toContain('must-not-ship');

    expect(entries.get('files/f1-notes.txt')).toBe('file-bytes');
    const index = JSON.parse(entries.get('files/index.json')!);
    expect(index.find((f: { id: string }) => f.id === 'f3')).toMatchObject({ omitted: 'moderation' });
    expect(index.find((f: { id: string }) => f.id === 'f3').path).toBeUndefined();

    const memories = JSON.parse(entries.get('memories.json')!);
    expect(memories.mementos[0]).toMatchObject({ summary: 'Likes tea' });
    expect(memories.beliefs).toEqual([{ id: 'b1', fact: 'Lives in Paris', evidenceTier: 'stated', confidence: 0.9 }]);
    expect(JSON.parse(entries.get('artifacts/artifact_1-Plan.json')!).content).toBe('# Plan v2');
    expect(JSON.parse(entries.get('artifacts/index.json')!)).toEqual([
      { id: 'artifact_1', title: 'Plan', type: 'markdown', path: 'artifacts/artifact_1-Plan.json' },
    ]);

    expect(h.fabFind).toHaveBeenCalledWith({ userId: USER_ID, deletedAt: null }, expect.anything());
    expect(h.artifactFind).toHaveBeenCalledWith({ userId: USER_ID, deletedAt: null }, expect.anything());

    expect(h.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ada@example.com',
        body: expect.stringContaining(`https://app.example.com/account-data-export/${JOB_ID}`),
      })
    );
  });

  describe('notebook images', () => {
    const chat = (...images: string[][]) => ({
      id: 'nb-1',
      name: 'Trip/plans',
      chatHistory: images.map(i => ({ images: i })),
    });
    const notebookImages = async () => {
      const entries = await unzip(h.uploaded!);
      const notebook = JSON.parse(entries.get('notebooks/nb-1-Trip_plans.json')!);
      return { entries, images: notebook.chatHistory.map((m: { images: unknown }) => m.images) };
    };

    it('copies a generated image under images/ once and references it by path', async () => {
      h.notebooks = [chat(['generated/a.png'], ['generated/a.png'])];

      await run();

      const { entries, images } = await notebookImages();
      const imagePaths = [...entries.keys()].filter(k => k.startsWith('images/'));
      expect(imagePaths).toHaveLength(1);
      expect(imagePaths[0]).toMatch(/^images\/[0-9a-f]{10}-a\.png$/);
      expect(entries.get(imagePaths[0])).toBe('image-png');
      expect(images).toEqual([[{ path: imagePaths[0] }], [{ path: imagePaths[0] }]]);
      expect(h.genContent).toHaveBeenCalledTimes(1);
    });

    it("references an image that is one of the user's files by file id without copying it", async () => {
      h.notebooks = [chat(['u/notes.txt'])];

      await run();

      const { entries, images } = await notebookImages();
      expect(images).toEqual([[{ fileId: 'f1' }]]);
      expect([...entries.keys()].some(k => k.startsWith('images/'))).toBe(false);
      expect(h.genContent).not.toHaveBeenCalled();
    });

    it('marks a generated image missing from storage as unavailable', async () => {
      h.genMetadata.mockRejectedValue(notFound());
      h.notebooks = [chat(['generated/gone.png'])];

      await run();

      const { entries, images } = await notebookImages();
      expect(images).toEqual([[{ key: 'generated/gone.png', omitted: 'unavailable' }]]);
      expect([...entries.keys()].some(k => k.startsWith('images/'))).toBe(false);
    });

    it('marks an image whose key the store rejects as unavailable and still ships the export', async () => {
      h.genMetadata.mockRejectedValue(Object.assign(new Error('Invalid key'), { name: 'InvalidObjectState' }));
      h.notebooks = [chat(['generated/../bad key.png'])];

      await run();

      expect((await notebookImages()).images).toEqual([[{ key: 'generated/../bad key.png', omitted: 'unavailable' }]]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ key: 'generated/../bad key.png', error: 'Invalid key' })
      );
      expect(h.uploadFile).toHaveBeenCalledOnce();
      expect(h.publish).toHaveBeenCalledOnce();
    });

    it('rethrows a transient network error so the job is retried', async () => {
      h.genMetadata.mockRejectedValue(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
      h.notebooks = [chat(['generated/a.png'])];

      await expect(run()).rejects.toThrow('reset');
      expect(h.publish).not.toHaveBeenCalled();
    });

    it('rejects a generated image stream failure rather than publishing a partial archive', async () => {
      h.notebooks = [chat(['generated/a.png'])];
      const source = new Readable({
        read() {
          this.push(Buffer.from('partial image'));
          this.destroy(new Error('Image checksum mismatch'));
        },
      });
      h.genContent.mockResolvedValue(source);

      await expect(run()).rejects.toThrow('Image checksum mismatch');

      expect(source.destroyed).toBe(true);
      expect(h.uploadFile).not.toHaveBeenCalled();
      expect(h.publish).not.toHaveBeenCalled();
    });

    it('marks an image over the shared byte budget as size_limit', async () => {
      h.genMetadata.mockResolvedValue({ size: MAX_FILE_BYTES + 1 });
      h.notebooks = [chat(['generated/big.png'])];

      await run();

      expect((await notebookImages()).images).toEqual([[{ key: 'generated/big.png', omitted: 'size_limit' }]]);
      expect(h.genContent).not.toHaveBeenCalled();
    });
  });

  it('stops building notebooks on a low budget and lists the rest as omitted', async () => {
    // A full budget when the section starts, then seven minutes: past the notebook share, inside the file share.
    let calls = 0;
    remainingMs = () => (calls++ === 0 ? FULL_BUDGET_MS : 7 * 60 * 1000);
    h.notebooks = [
      { id: 'nb-1', name: 'Trip/plans' },
      { id: 'nb-2', name: 'Other' },
    ];

    await run();

    const entries = await unzip(h.uploaded!);
    expect([...entries.keys()].some(k => k.startsWith('notebooks/') && k !== 'notebooks/index.json')).toBe(false);
    expect(JSON.parse(entries.get('notebooks/index.json')!)).toEqual([
      { id: 'nb-1', name: 'Trip/plans', omitted: 'time_limit' },
      { id: 'nb-2', name: 'Other', omitted: 'time_limit' },
    ]);
    expect(entries.get('files/f1-notes.txt')).toBe('file-bytes');
    expect(h.uploadFile).toHaveBeenCalledOnce();
    expect(h.publish).toHaveBeenCalledOnce();
  });

  it('lists a file over the size limit as omitted without copying it', async () => {
    h.fabFind.mockResolvedValue([
      {
        id: 'big',
        fileName: 'huge.bin',
        fileSize: MAX_FILE_BYTES + 1,
        mimeType: 'application/octet-stream',
        filePath: 'u/huge.bin',
        moderationStatus: 'clean',
      },
    ]);

    await run();

    const entries = await unzip(h.uploaded!);
    const index = JSON.parse(entries.get('files/index.json')!);
    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({ id: 'big', omitted: 'size_limit' });
    expect(index[0].path).toBeUndefined();
    expect(h.getContent).not.toHaveBeenCalled();
    expect(entries.has('files/big-huge.bin')).toBe(false);
  });

  it('still ships the zip and the email when the time budget is nearly spent', async () => {
    remainingMs = () => 4 * 60 * 1000;

    await run();

    const entries = await unzip(h.uploaded!);
    const files = JSON.parse(entries.get('files/index.json')!);
    expect(
      files.filter((f: { omitted?: string }) => f.omitted === 'time_limit').map((f: { id: string }) => f.id)
    ).toEqual(['f1', 'f2']);
    expect(h.getContent).not.toHaveBeenCalled();
    expect(JSON.parse(entries.get('artifacts/index.json')!)).toEqual([
      { id: 'artifact_1', title: 'Plan', type: 'markdown', omitted: 'time_limit' },
    ]);
    expect(entries.has('artifacts/artifact_1-Plan.json')).toBe(false);
    expect(h.uploadFile).toHaveBeenCalledOnce();
    expect(h.publish).toHaveBeenCalledOnce();
  });

  it('only re-sends the email when the export already exists', async () => {
    h.getMetadata.mockResolvedValue({ lastModified: new Date() });

    await run();

    expect(h.uploadFile).not.toHaveBeenCalled();
    expect(h.fabFind).not.toHaveBeenCalled();
    expect(h.publish).toHaveBeenCalledOnce();
  });

  it('rebuilds instead of re-sending when the existing export is older than the TTL', async () => {
    h.getMetadata.mockResolvedValue({ lastModified: new Date(Date.now() - ACCOUNT_DATA_EXPORT_TTL_MS - 60_000) });

    await run();

    expect(h.uploadFile).toHaveBeenCalledOnce();
    expect(h.publish).toHaveBeenCalledOnce();
  });

  it('counts the bytes actually streamed toward the cap, not the declared size', async () => {
    h.fabFind.mockResolvedValue([
      {
        id: 'a',
        fileName: 'a.bin',
        fileSize: 1,
        mimeType: 'text/plain',
        filePath: 'u/a.bin',
        moderationStatus: 'clean',
      },
      {
        id: 'b',
        fileName: 'b.bin',
        fileSize: MAX_FILE_BYTES - 5,
        mimeType: 'text/plain',
        filePath: 'u/b.bin',
        moderationStatus: 'clean',
      },
    ]);

    await run();

    const index = JSON.parse((await unzip(h.uploaded!)).get('files/index.json')!);
    expect(index.find((f: { id: string }) => f.id === 'a').path).toBeDefined();
    expect(index.find((f: { id: string }) => f.id === 'b')).toMatchObject({ omitted: 'size_limit' });
    expect(h.getContent).toHaveBeenCalledTimes(1);
  });

  it('rejects an uploaded file stream reset without an unhandled stream error', async () => {
    const source = new Readable({
      read() {
        this.destroy(Object.assign(new Error('Storage connection reset'), { code: 'ECONNRESET' }));
      },
    });
    h.getContent.mockResolvedValue(source);

    await expect(run()).rejects.toThrow('Storage connection reset');

    expect(source.destroyed).toBe(true);
    expect(h.uploadFile).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('retries rather than rebuilding when the existence check itself fails', async () => {
    h.getMetadata.mockRejectedValue(new Error('AccessDenied'));

    await expect(run()).rejects.toThrow('AccessDenied');
    expect(h.uploadFile).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('fails without emailing when a category cannot be read', async () => {
    h.readProfile.mockRejectedValue(new Error('key unavailable'));

    await expect(run()).rejects.toThrow('key unavailable');
    expect(h.uploadFile).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.leaseRelease).toHaveBeenCalledOnce();
  });

  it('skips an account that no longer exists', async () => {
    h.userFindById.mockResolvedValue(null);

    await run();

    expect(h.getMetadata).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('rejects a malformed job id', async () => {
    await expect(run({ exportJobId: '../x', userId: USER_ID })).rejects.toThrow();
    expect(h.userFindById).not.toHaveBeenCalled();
  });

  it('refuses overdue and already-purging accounts before acquiring an export lease', async () => {
    h.userFindById.mockResolvedValue({
      email: 'ada@example.com',
      deletion: { scheduledFor: new Date(Date.now() - 1) },
    });
    await run();
    expect(h.leaseClaim).not.toHaveBeenCalled();
    expect(h.uploadFile).not.toHaveBeenCalled();
    h.userFindById.mockResolvedValue({ email: 'ada@example.com', deletion: { purgeStartedAt: new Date() } });
    await run();
    expect(h.leaseClaim).not.toHaveBeenCalled();
    expect(h.permanentDelete).toHaveBeenCalledTimes(2);
    expect(h.permanentDelete).toHaveBeenCalledWith(KEY);
  });

  it('atomically excludes the purge and concurrent exports, then releases only its own lease', async () => {
    await run();
    const [filter, update] = h.leaseClaim.mock.calls[0];
    expect(filter).toMatchObject({ _id: USER_ID, 'deletion.purgeStartedAt': null });
    expect(filter.$and).toEqual([
      {
        $or: [
          { 'accountDataExportLease.expiresAt': null },
          { 'accountDataExportLease.expiresAt': { $lte: expect.any(Date) } },
        ],
      },
    ]);
    expect(update.$set.accountDataExportLease.id).toEqual(expect.any(String));
    expect(update.$set.accountDataExportLease.expiresAt.getTime()).toBeGreaterThan(Date.now() + 19 * 60 * 1000);
    expect(h.leaseRelease).toHaveBeenCalledWith(
      { _id: USER_ID, 'accountDataExportLease.id': update.$set.accountDataExportLease.id },
      { $unset: { accountDataExportLease: 1 } }
    );
  });

  it('rejects before upload and releases the lease if admission is lost while building', async () => {
    h.leaseExists.mockResolvedValue(null);
    await expect(run()).rejects.toThrow('lease lost');
    expect(h.uploadFile).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.leaseRelease).toHaveBeenCalledOnce();
  });

  it('erases a late upload permanently if the lease is lost after remote success', async () => {
    h.leaseExists.mockResolvedValueOnce({ _id: USER_ID }).mockResolvedValueOnce(null);
    await expect(run()).rejects.toThrow('lease lost after upload');
    expect(h.uploadFile).toHaveBeenCalledOnce();
    expect(h.permanentDelete).toHaveBeenCalledWith(KEY);
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.leaseRelease).toHaveBeenCalledOnce();
  });

  it('retries a concurrent-export admission failure without releasing the other invocation lease', async () => {
    h.leaseClaim.mockResolvedValue(null);
    await expect(run()).rejects.toThrow('Another account data export');
    expect(h.leaseRelease).not.toHaveBeenCalled();
    expect(h.getMetadata).not.toHaveBeenCalled();
  });

  it('renews the same unexpired account lease immediately before a hard-bounded upload', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      await run();
      expect(h.leaseRenew).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: USER_ID,
          'deletion.purgeStartedAt': null,
          'accountDataExportLease.id': expect.any(String),
          'accountDataExportLease.expiresAt': { $gt: expect.any(Date) },
        }),
        { $set: { 'accountDataExportLease.expiresAt': expect.any(Date) } }
      );
      expect(h.leaseRenew.mock.invocationCallOrder[0]).toBeLessThan(h.uploadFile.mock.invocationCallOrder[0]);
      expect(timeout).toHaveBeenCalledWith(5 * 60 * 1000);
      expect(h.uploadFile.mock.calls[0][3]).toBeInstanceOf(AbortSignal);
    } finally {
      timeout.mockRestore();
    }
  });

  it('does not upload or email when atomic pre-upload lease renewal loses admission', async () => {
    h.leaseRenew.mockResolvedValue({ matchedCount: 0 });
    await expect(run()).rejects.toThrow('lease lost before upload');
    expect(h.uploadFile).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.leaseRelease).toHaveBeenCalledOnce();
  });

  it('does not start an upload after a cooperative self-host deadline has elapsed', async () => {
    remainingMs = () => 0;
    await expect(run()).rejects.toThrow('No remaining time');
    expect(h.leaseRenew).not.toHaveBeenCalled();
    expect(h.uploadFile).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('reconciles an ambiguous failed upload and retains the lease through its expiry', async () => {
    h.uploadFile.mockRejectedValueOnce(Object.assign(new Error('response lost'), { code: 'ECONNRESET' }));
    await expect(run()).rejects.toThrow('response lost');
    expect(h.permanentDelete).toHaveBeenCalledWith(KEY);
    expect(h.leaseRelease).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('preserves the original upload error and its fence when remote cleanup also fails', async () => {
    h.uploadFile.mockRejectedValueOnce(new Error('upload timeout'));
    h.permanentDelete.mockRejectedValueOnce(new Error('cleanup denied'));
    await expect(run()).rejects.toThrow('upload timeout');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('ambiguous upload'),
      expect.objectContaining({ key: KEY, cleanupError: expect.any(Error) })
    );
    expect(h.leaseRelease).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('reconciles known remote output on redelivery after the account has been removed', async () => {
    h.userFindById.mockResolvedValue(null);
    await run();
    expect(h.permanentDelete).toHaveBeenCalledWith(KEY);
    expect(h.leaseClaim).not.toHaveBeenCalled();
  });

  it('reconciles known remote output when an irreversible purge wins atomic admission', async () => {
    h.leaseClaim.mockResolvedValue(null);
    h.userFindById
      .mockResolvedValueOnce({ email: 'ada@example.com' })
      .mockResolvedValueOnce({ deletion: { purgeStartedAt: new Date() } });
    await run();
    expect(h.permanentDelete).toHaveBeenCalledWith(KEY);
    expect(h.uploadFile).not.toHaveBeenCalled();
    expect(h.leaseRelease).not.toHaveBeenCalled();
  });
});
