import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Characterization tests for `CommandHandler.processSlackFiles`.
 *
 * This function had NO test coverage while being the path every Slack attachment already flows
 * through, and it is NOT behind the `EnableDataLakeSlackAdd` flag - so a regression here ships live.
 * These tests pin the behavior that must survive the extraction of the shared MIME/size validator:
 * which files are accepted, which are refused and with what message, which are dropped silently,
 * and that one bad attachment never costs the others.
 *
 * They were verified to pass UNCHANGED against both the pre-refactor (inline validation) and
 * post-refactor (shared validator) implementations - that equivalence is what makes them evidence
 * of behavior preservation rather than a description of the new code.
 */

const { getSlackDeps, getSlackDb } = vi.hoisted(() => ({
  getSlackDeps: vi.fn(),
  getSlackDb: vi.fn(),
}));
vi.mock('./di/registry', () => ({ getSlackDeps, getSlackDb, configureSlackPackage: vi.fn() }));

import { CommandHandler } from './CommandHandler';
import { SlackEvent } from './SlackEvent';

const upload = vi.fn();
const create = vi.fn();
const downloadFile = vi.fn();

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const attachment = (overrides: Record<string, unknown> = {}) => ({
  id: 'F1',
  name: 'notes.pdf',
  mimetype: 'application/pdf',
  url_private_download: 'https://files.slack.com/notes.pdf',
  size: 1024,
  ...overrides,
});

function makeHandler() {
  const slackEvent = new SlackEvent({ channel: 'C1', user: 'U1', text: 'hello', ts: '1700000000.0001' } as never);
  const slackClient = { downloadFile } as never;
  return new CommandHandler(slackEvent, { id: 'user-1' } as never, slackClient, logger);
}

beforeEach(() => {
  vi.clearAllMocks();
  upload.mockResolvedValue(undefined);
  create.mockImplementation(async () => ({ _id: { toString: () => 'fab-1' } }));
  downloadFile.mockResolvedValue(Buffer.from('bytes'));
  getSlackDeps.mockReturnValue({ storage: { filesStorage: { upload } } });
  getSlackDb.mockReturnValue({ FabFile: { create } });
});

describe('processSlackFiles', () => {
  it('returns empty results for no attachments without touching storage', async () => {
    const result = await makeHandler().processSlackFiles(undefined);

    expect(result).toEqual({ fabFileIds: [], fileMetadata: [], errors: [] });
    expect(downloadFile).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('downloads, uploads and creates a FabFile for a supported attachment', async () => {
    const result = await makeHandler().processSlackFiles([attachment()] as never);

    expect(downloadFile).toHaveBeenCalledWith('https://files.slack.com/notes.pdf', 'notes.pdf');
    expect(upload).toHaveBeenCalled();
    expect(result.fabFileIds).toEqual(['fab-1']);
    expect(result.fileMetadata).toEqual([
      { fabFileId: 'fab-1', filename: 'notes.pdf', mimeType: 'application/pdf', sizeBytes: 1024 },
    ]);
    expect(result.errors).toEqual([]);
  });

  it('refuses an unsupported type with the user-facing warning and skips it', async () => {
    const result = await makeHandler().processSlackFiles([
      attachment({ name: 'archive.zip', mimetype: 'application/zip' }),
    ] as never);

    expect(result.fabFileIds).toEqual([]);
    expect(result.errors).toHaveLength(1);
    // Wording is user-visible in Slack: keep the name, the type and "Skipping.".
    expect(result.errors[0]).toContain('archive.zip');
    expect(result.errors[0]).toContain('application/zip');
    expect(result.errors[0]).toMatch(/skipping\./i);
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('refuses an oversized file and reports the limit', async () => {
    const result = await makeHandler().processSlackFiles([
      attachment({ name: 'huge.pdf', size: 51 * 1024 * 1024 }),
    ] as never);

    expect(result.fabFileIds).toEqual([]);
    expect(result.errors[0]).toContain('huge.pdf');
    expect(result.errors[0]).toContain('50MB');
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('holds images to the tighter 10MB limit', async () => {
    const result = await makeHandler().processSlackFiles([
      attachment({ name: 'big.png', mimetype: 'image/png', size: 11 * 1024 * 1024 }),
    ] as never);

    expect(result.errors[0]).toContain('10MB');
  });

  it('drops an incomplete Slack file object SILENTLY (no user-facing error)', async () => {
    const result = await makeHandler().processSlackFiles([
      attachment({ id: 'F9', name: undefined, mimetype: undefined }),
    ] as never);

    // Deliberate asymmetry with the data-lake path: a pending/deleted file object is a Slack
    // artifact, not a file the user chose, so it must not produce a message here.
    expect(result.errors).toEqual([]);
    expect(result.fabFileIds).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('processes the good attachment and reports the bad one in a mixed message', async () => {
    const result = await makeHandler().processSlackFiles([
      attachment({ id: 'F1', name: 'ok.pdf' }),
      attachment({ id: 'F2', name: 'bad.zip', mimetype: 'application/zip' }),
    ] as never);

    expect(result.fabFileIds).toEqual(['fab-1']);
    expect(result.fileMetadata[0].filename).toBe('ok.pdf');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('bad.zip');
  });

  it('keeps going when one download throws, naming the file that failed', async () => {
    downloadFile.mockRejectedValueOnce(new Error('slack 404')).mockResolvedValueOnce(Buffer.from('ok'));

    const result = await makeHandler().processSlackFiles([
      attachment({ id: 'F1', name: 'broken.pdf' }),
      attachment({ id: 'F2', name: 'fine.pdf' }),
    ] as never);

    expect(result.fabFileIds).toEqual(['fab-1']);
    expect(result.errors).toHaveLength(1);
    // Regression guard: the loop variable was renamed during the validator extraction, and this
    // message is built in the catch block from the raw (un-narrowed) attachment.
    expect(result.errors[0]).toContain('broken.pdf');
    expect(result.errors[0]).toContain('slack 404');
  });

  it('stamps the created FabFile as a Slack-sourced complete file owned by the actor', async () => {
    await makeHandler().processSlackFiles([attachment()] as never);

    const data = create.mock.calls[0][0];
    expect(data.userId).toBe('user-1');
    expect(data.fileName).toBe('notes.pdf');
    expect(data.mimeType).toBe('application/pdf');
    expect(data.fileSize).toBe(1024);
    expect(data.status).toBe('complete');
    expect(data.sourceType).toBe('slack');
  });
});
