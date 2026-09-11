import { describe, it, expect, vi } from 'vitest';
import {
  moderateImportedKnowledgeFiles,
  type ModerateImportedKnowledgeFilesArgs,
} from './moderateImportedKnowledgeFiles';

const logger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  log: vi.fn(),
} as unknown as ModerateImportedKnowledgeFilesArgs['logger'];

function buildArgs(overrides: Partial<ModerateImportedKnowledgeFilesArgs> = {}): ModerateImportedKnowledgeFilesArgs {
  return {
    filePaths: ['knowledge/u1/a'],
    userId: 'u1',
    enabled: true,
    service: {} as ModerateImportedKnowledgeFilesArgs['service'],
    incidents: { record: vi.fn(async () => undefined) },
    moderateImageOrThrow: vi.fn() as unknown as ModerateImportedKnowledgeFilesArgs['moderateImageOrThrow'],
    moderate: vi.fn(async () => ({
      moderationStatus: 'clean' as const,
    })) as unknown as ModerateImportedKnowledgeFilesArgs['moderate'],
    logger,
    claim: vi.fn(async () => ({ _id: 'oid', id: 'f1', mimeType: 'text/plain' })),
    persist: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    downloadBytes: vi.fn(async () => Buffer.from('x')),
    downloadPartialBytes: vi.fn(async () => Buffer.from('x')),
    ...overrides,
  };
}

describe('moderateImportedKnowledgeFiles', () => {
  it('persists a clean verdict for a non-image', async () => {
    const args = buildArgs();
    await moderateImportedKnowledgeFiles(args);
    expect(args.persist).toHaveBeenCalledWith('oid', { moderationStatus: 'clean' });
    expect(args.release).not.toHaveBeenCalled();
  });

  it('persists a blocked verdict plus the corrected mime and block reason', async () => {
    const moderate = vi.fn(async () => ({
      moderationStatus: 'blocked' as const,
      correctedMimeType: 'image/png',
      blockReason: 'unsupported_format' as const,
    })) as unknown as ModerateImportedKnowledgeFilesArgs['moderate'];
    const args = buildArgs({ moderate });
    await moderateImportedKnowledgeFiles(args);
    expect(args.persist).toHaveBeenCalledWith('oid', {
      moderationStatus: 'blocked',
      mimeType: 'image/png',
      blockReason: 'unsupported_format',
    });
  });

  it('skips a file whose claim was lost (owned by another scan / already terminal)', async () => {
    const moderate = vi.fn() as unknown as ModerateImportedKnowledgeFilesArgs['moderate'];
    const args = buildArgs({ claim: vi.fn(async () => null), moderate });
    await moderateImportedKnowledgeFiles(args);
    expect(moderate).not.toHaveBeenCalled();
    expect(args.persist).not.toHaveBeenCalled();
  });

  it('releases the claim (back to pending) and does not persist when the scan throws', async () => {
    const moderate = vi.fn(async () => {
      throw new Error('rekognition throttled');
    }) as unknown as ModerateImportedKnowledgeFilesArgs['moderate'];
    const args = buildArgs({ moderate });
    await moderateImportedKnowledgeFiles(args);
    expect(args.release).toHaveBeenCalledWith('oid');
    expect(args.persist).not.toHaveBeenCalled();
  });

  const noSuchKey = () => Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });

  it('retires an orphan terminally (blocked/missing_object) when the object is gone and terminalOnMissingObject is set', async () => {
    // A never-uploaded presign row: the object was never written, so the download throws NoSuchKey.
    const moderate = vi.fn(async () => {
      throw noSuchKey();
    }) as unknown as ModerateImportedKnowledgeFilesArgs['moderate'];
    const args = buildArgs({ moderate, terminalOnMissingObject: true });
    await moderateImportedKnowledgeFiles(args);
    expect(args.persist).toHaveBeenCalledWith('oid', { moderationStatus: 'blocked', blockReason: 'missing_object' });
    // Must NOT release - releasing back to pending is exactly the poison loop this fixes.
    expect(args.release).not.toHaveBeenCalled();
  });

  it('still releases (does not retire) a missing object on the import path where terminalOnMissingObject is unset', async () => {
    const moderate = vi.fn(async () => {
      throw noSuchKey();
    }) as unknown as ModerateImportedKnowledgeFilesArgs['moderate'];
    const args = buildArgs({ moderate }); // terminalOnMissingObject not set
    await moderateImportedKnowledgeFiles(args);
    expect(args.release).toHaveBeenCalledWith('oid');
    expect(args.persist).not.toHaveBeenCalled();
  });

  it('still releases (does not retire) a transient failure even when terminalOnMissingObject is set', async () => {
    const moderate = vi.fn(async () => {
      throw new Error('rekognition throttled'); // not a missing-object error
    }) as unknown as ModerateImportedKnowledgeFilesArgs['moderate'];
    const args = buildArgs({ moderate, terminalOnMissingObject: true });
    await moderateImportedKnowledgeFiles(args);
    expect(args.release).toHaveBeenCalledWith('oid');
    expect(args.persist).not.toHaveBeenCalled();
  });
});
