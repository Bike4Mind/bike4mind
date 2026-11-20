import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ findOne: vi.fn() }));

// withContext just threads a logger; the handler body is the subject.
vi.mock('@bike4mind/server-utils/s3/utils', () => ({
  withContext: (fn: unknown) => fn,
  decodeS3Key: (k: string) => k,
  findWithRetry: <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock('@bike4mind/database', () => ({ AppFile: { findOne: h.findOne } }));

import { func } from './appFileUploadComplete';

type Handler = (event: unknown, context: unknown, logger: unknown) => Promise<void>;
const handler = func as unknown as Handler;

const makeLogger = () => ({
  updateMetadata: vi.fn(),
  info: vi.fn(),
  log: vi.fn(),
  error: vi.fn(),
});

const eventFor = (key: string) => ({ Records: [{ s3: { object: { key } } }] });

describe('appFileUploadComplete', () => {
  beforeEach(() => {
    h.findOne.mockReset();
  });

  it.each(['bob-screenshots/run-1/desktop.png', 'bob-screenshots/run-1/phone.png'])(
    'skips %s without a lookup or an error log',
    async key => {
      const logger = makeLogger();
      await handler(eventFor(key), {}, logger);

      expect(h.findOne).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(`Skipping S3 event for untracked file: ${key}`);
    }
  );

  it('marks a tracked AppFile complete', async () => {
    const save = vi.fn();
    const appFile = { id: 'f1', userId: 'u1', status: 'pending', save };
    h.findOne.mockResolvedValue(appFile);
    const logger = makeLogger();

    await handler(eventFor('abc.png'), {}, logger);

    expect(h.findOne).toHaveBeenCalledWith({ path: 'abc.png' });
    expect(appFile.status).toBe('complete');
    expect(save).toHaveBeenCalledOnce();
  });

  it('logs an error when a tracked key has no AppFile row', async () => {
    h.findOne.mockResolvedValue(null);
    const logger = makeLogger();

    await handler(eventFor('abc.png'), {}, logger);

    expect(logger.error).toHaveBeenCalledWith('Metadata not found for file: abc.png');
  });
});
