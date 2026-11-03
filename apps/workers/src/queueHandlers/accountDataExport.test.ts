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
  uploadFile: vi.fn(),
  publish: vi.fn(),
  userFindById: vi.fn(),
  fabFind: vi.fn(),
  mementoFind: vi.fn(),
  artifactFind: vi.fn(),
  artifactContentFind: vi.fn(),
  agentFind: vi.fn(),
  projectFind: vi.fn(),
  readProfile: vi.fn(),
  notebooks: [] as Array<{ id: string; name: string }>,
}));

vi.mock('@bike4mind/server-utils/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
}));
vi.mock('@bike4mind/utils', () => ({
  secureParameters: (obj: unknown, schema: { parse: (value: unknown) => unknown }) => schema.parse(obj),
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: h.userFindById },
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
        yield* h.notebooks;
      }
    },
  },
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ getMetadata: h.getMetadata, getContent: h.getContent, uploadFile: h.uploadFile }),
}));
vi.mock('@bike4mind/server-utils/memory/factCipher', () => ({ createKeyProvider: () => ({}) }));
vi.mock('@bike4mind/server-utils/memory/ledgerMemoryStore', () => ({
  createLedgerMemoryStore: () => ({ readProfile: h.readProfile }),
}));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: h.publish } } }));

import { dispatch } from './accountDataExport';

const logger = { updateMetadata: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const context = { getRemainingTimeInMillis: () => 15 * 60 * 1000 } as Context;
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
  process.env.APP_URL = 'https://app.example.com/';
  h.uploaded = null;
  h.notebooks = [{ id: 'nb-1', name: 'Trip/plans' }];
  h.getMetadata.mockRejectedValue(notFound());
  h.uploadFile.mockImplementation(async (localPath: string) => {
    h.uploaded = await readFile(localPath);
  });
  h.getContent.mockImplementation(async () => Readable.from([Buffer.from('file-bytes')]));
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

    expect(h.uploadFile).toHaveBeenCalledWith(expect.any(String), KEY, { ContentType: 'application/zip' });
    const entries = await unzip(h.uploaded!);
    expect([...entries.keys()].sort()).toEqual([
      'README.txt',
      'agents.json',
      'artifacts/artifact_1-Plan.json',
      'files/f1-notes.txt',
      'files/f2-notes.txt',
      'files/index.json',
      'memories.json',
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

    expect(h.fabFind).toHaveBeenCalledWith({ userId: USER_ID, deletedAt: null }, expect.anything());
    expect(h.artifactFind).toHaveBeenCalledWith({ userId: USER_ID, deletedAt: null }, expect.anything());

    expect(h.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ada@example.com',
        body: expect.stringContaining(`https://app.example.com/account-data-export/${JOB_ID}`),
      })
    );
  });

  it('only re-sends the email when the export already exists', async () => {
    h.getMetadata.mockResolvedValue({ lastModified: new Date() });

    await run();

    expect(h.uploadFile).not.toHaveBeenCalled();
    expect(h.fabFind).not.toHaveBeenCalled();
    expect(h.publish).toHaveBeenCalledOnce();
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
});
