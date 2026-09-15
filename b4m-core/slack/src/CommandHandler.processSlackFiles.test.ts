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
// #1685: processSlackFiles now enforces MaxFileSize + the user's storage limit before create.
const getSettingsValue = vi.fn();
const organizationFindById = vi.fn();

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
  // Same length as attachment()'s claimed `size` (1024) so the pinned assertions below hold
  // whether they read the claim or the real bytes - the two are only meant to diverge in the
  // lying-client tests further down, which override this explicitly.
  downloadFile.mockResolvedValue(Buffer.alloc(1024));
  // The real MaxFileSize schema has .prefault(30) - getSettingsValue never actually resolves
  // undefined for this key in production, so the default here matches that instead of
  // modeling an unconfigured-setting case that can't happen. Tests that need a different
  // value (or the never-configured case) override this explicitly.
  getSettingsValue.mockResolvedValue(30);
  getSlackDeps.mockReturnValue({ storage: { filesStorage: { upload } } });
  getSlackDb.mockReturnValue({
    FabFile: { create },
    adminSettingsRepository: { getSettingsValue },
    Organization: { findById: organizationFindById },
  });
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
    // Wording is user-visible in Slack: keep the name, the type and "Skipping.". Names the
    // extension ("zip"), not the client's claimed mimetype - reporting the claim let it name a
    // type that IS on the allow-list for other files, e.g. a .py claiming text/plain.
    expect(result.errors[0]).toContain('archive.zip');
    expect(result.errors[0]).toContain('unsupported type zip');
    expect(result.errors[0]).toMatch(/skipping\./i);
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('refuses an oversized file and reports the limit', async () => {
    const result = await makeHandler().processSlackFiles([
      attachment({ name: 'huge.pdf', size: 51 * 1024 * 1024 }),
    ] as never);

    expect(result.fabFileIds).toEqual([]);
    // Pin the WHOLE sentence, not just '50MB'. A loose toContain let an "exceeds" -> "exceeds the"
    // drift through the validator extraction, which quietly falsified "behaviour preserved exactly".
    expect(result.errors[0]).toBe('\u26a0\ufe0f File "huge.pdf" (51.0MB) exceeds 50MB limit. Skipping.');
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

  it('persists the resolved (extension-based) mimetype and real byte count, not the claim', async () => {
    // Claimed mimetype is a lie and claimed size understates the real download - the FabFile
    // record and fileMetadata must reflect what the checks actually verified, not the claim,
    // or a job that later rebuilds storage usage from fileSize would undercount this file.
    downloadFile.mockResolvedValue(Buffer.alloc(2048));
    const result = await makeHandler().processSlackFiles([
      attachment({ mimetype: 'application/octet-stream', size: 1024 }),
    ] as never);

    const data = create.mock.calls[0][0];
    expect(data.mimeType).toBe('application/pdf');
    expect(data.fileSize).toBe(2048);
    expect(result.fileMetadata[0].mimeType).toBe('application/pdf');
    expect(result.fileMetadata[0].sizeBytes).toBe(2048);
  });
});

/**
 * NOT part of the characterization set above - this pins behavior deliberately ADDED after it (the
 * `sourceMetadata` origin stamp), so it would fail against the pre-refactor implementation by
 * design. Kept in a separate block so the 9 tests above keep meaning "unchanged pre/post refactor".
 */
describe('processSlackFiles origin stamp', () => {
  it('stamps the Slack channel and message ts alongside sourceType', async () => {
    await makeHandler().processSlackFiles([attachment()] as never);

    expect(create.mock.calls[0][0].sourceMetadata).toEqual({ channel: 'C1', messageTs: '1700000000.0001' });
  });

  it('stamps an empty channel rather than omitting the field when the event carries none', async () => {
    const slackEvent = new SlackEvent({ user: 'U1', text: 'hello', ts: '1700000000.0002' } as never);
    const handler = new CommandHandler(slackEvent, { id: 'user-1' } as never, { downloadFile } as never, logger);

    await handler.processSlackFiles([attachment()] as never);

    // A DM carries no `channel` on the raw event; the shape stays consistent so anything reading
    // sourceMetadata later does not have to handle a missing key as well as an empty one.
    expect(create.mock.calls[0][0].sourceMetadata).toEqual({ channel: '', messageTs: '1700000000.0002' });
  });
});

/**
 * #1685 - this path wrote the FabFile via a raw `FabFile.create`, never enforcing the `MaxFileSize`
 * admin setting or the user's storage limit (both only ran inside `fabFilesService.createFabFile`,
 * which this path never called). These pin the two new refusals added to close that gap.
 */
describe('processSlackFiles storage + MaxFileSize limits (#1685)', () => {
  it('refuses a file whose CLAIMED size already exceeds MaxFileSize, without downloading it', async () => {
    // Claimed size alone is over the limit - refused before the wasted transfer.
    getSettingsValue.mockResolvedValue(1); // MB
    const result = await makeHandler().processSlackFiles([attachment({ size: 2 * 1024 * 1024 })] as never);

    expect(result.fabFileIds).toEqual([]);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(result.errors[0]).toContain('1MB limit');
  });

  it('refuses a file whose REAL size exceeds MaxFileSize even though the claimed size did not (lying client)', async () => {
    getSettingsValue.mockResolvedValue(1); // MB
    downloadFile.mockResolvedValue(Buffer.alloc(2 * 1024 * 1024));

    // attachment()'s claimed size (1024 bytes) is well under the 1MB limit, but the real
    // downloaded buffer is 2MB - the post-download check must not trust the claim.
    const result = await makeHandler().processSlackFiles([attachment()] as never);

    expect(result.fabFileIds).toEqual([]);
    expect(downloadFile).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(result.errors[0]).toContain('1MB limit');
  });

  it('refuses a file for a user already at their storage limit, naming the limit, and creates no FabFile', async () => {
    const slackEvent = new SlackEvent({ channel: 'C1', user: 'U1', text: 'hello', ts: '1700000000.0001' } as never);
    const user = { id: 'user-1', storageLimit: 1, currentStorageSize: 1_000_000 } as never; // 1MB, fully used
    const handler = new CommandHandler(slackEvent, user, { downloadFile } as never, logger);

    const result = await handler.processSlackFiles([attachment()] as never);

    expect(result.fabFileIds).toEqual([]);
    expect(create).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(result.errors[0]).toContain('storage limit');
  });

  it('still succeeds for a normal in-limit attachment once both new checks are wired in', async () => {
    getSettingsValue.mockResolvedValue(30);

    const result = await makeHandler().processSlackFiles([attachment()] as never);

    expect(result.fabFileIds).toEqual(['fab-1']);
    expect(result.errors).toEqual([]);
  });

  it('creates the file and logs, rather than failing the whole call, when the MaxFileSize settings lookup rejects', async () => {
    getSettingsValue.mockRejectedValue(new Error('db down'));

    const result = await makeHandler().processSlackFiles([attachment()] as never);

    expect(result.fabFileIds).toEqual(['fab-1']);
    expect(result.errors).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      '[Slack Files] Failed to resolve MaxFileSize setting, proceeding without it',
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it('rejects the second of two attachments that together exceed storage even though each individually fits', async () => {
    // Neither the admin setting nor the org lookup applies here - this pins the same-message
    // accumulator itself, not the org lookup covered separately below.
    const slackEvent = new SlackEvent({ channel: 'C1', user: 'U1', text: 'hello', ts: '1700000000.0001' } as never);
    const user = { id: 'user-1', storageLimit: 1, currentStorageSize: 0 } as never; // 1MB total, empty
    const handler = new CommandHandler(slackEvent, user, { downloadFile } as never, logger);

    const bytes = 600_000; // under the 1,000,000-byte (1MB) limit alone; two together exceed it
    downloadFile.mockResolvedValue(Buffer.alloc(bytes));

    const result = await handler.processSlackFiles([
      attachment({ id: 'F1', name: 'one.pdf', size: bytes }),
      attachment({ id: 'F2', name: 'two.pdf', size: bytes }),
    ] as never);

    expect(result.fabFileIds).toEqual(['fab-1']);
    expect(result.fileMetadata).toHaveLength(1);
    expect(result.fileMetadata[0].filename).toBe('one.pdf');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('two.pdf');
    expect(result.errors[0]).toContain('storage limit');
  });

  it('does not charge a file against the same-message quota unless it is actually persisted', async () => {
    // If a file's bytes were charged as soon as it cleared the storage check - rather than
    // after upload + create actually succeed - a later attachment in the same message could be
    // wrongly refused against bytes that were never durably stored.
    const slackEvent = new SlackEvent({ channel: 'C1', user: 'U1', text: 'hello', ts: '1700000000.0001' } as never);
    const user = { id: 'user-1', storageLimit: 1, currentStorageSize: 0 } as never; // 1MB total, empty
    const handler = new CommandHandler(slackEvent, user, { downloadFile } as never, logger);

    const bytes = 400_000; // three of these exceed 1,000,000 bytes; any two never do
    downloadFile.mockResolvedValue(Buffer.alloc(bytes));
    create.mockImplementation(async (data: { fileName: string }) => {
      if (data.fileName === 'fails-to-persist.pdf') throw new Error('S3 write failed');
      return { _id: { toString: () => `fab-${data.fileName}` } };
    });

    const result = await handler.processSlackFiles([
      attachment({ id: 'F1', name: 'one.pdf', size: bytes }),
      attachment({ id: 'F2', name: 'fails-to-persist.pdf', size: bytes }),
      attachment({ id: 'F3', name: 'three.pdf', size: bytes }),
    ] as never);

    expect(result.fabFileIds).toEqual(['fab-one.pdf', 'fab-three.pdf']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('fails-to-persist.pdf');
    expect(result.errors[0]).not.toContain('storage limit');
  });

  it('checks the org storage limit for 2+ attachments from an org-affiliated user without re-executing the lookup', async () => {
    // A real Mongoose Query is a one-shot thenable: awaiting (or `.exec()`-ing) the SAME query
    // instance a second time throws "Query was already executed". `Organization.findById(id)`
    // must be memoized as an already-executed Promise, not as the raw Query, or the second
    // attachment's `checkStorageLimitForFile` call - which awaits the memoized value again -
    // reproduces that throw and wrongly refuses an otherwise-valid file.
    let executed = false;
    const execute = () => {
      if (executed) throw new Error('Query was already executed: organizations.findOne(...)');
      executed = true;
      return Promise.resolve({ storageLimit: 1000, currentStorageSize: 0 });
    };
    // Models the real chain: `.findById(id).select(...).lean()` still returns an un-executed,
    // one-shot Mongoose Query - only `.exec()` (or awaiting it) actually runs it.
    organizationFindById.mockReturnValue({
      select: () => ({
        lean: () => ({
          exec: execute,
          then: (resolve: never, reject: never) => execute().then(resolve, reject),
        }),
      }),
    });

    const slackEvent = new SlackEvent({ channel: 'C1', user: 'U1', text: 'hello', ts: '1700000000.0001' } as never);
    const user = { id: 'user-1', organizationId: 'org-1' } as never;
    const handler = new CommandHandler(slackEvent, user, { downloadFile } as never, logger);

    const result = await handler.processSlackFiles([
      attachment({ id: 'F1', name: 'one.pdf' }),
      attachment({ id: 'F2', name: 'two.pdf' }),
    ] as never);

    expect(result.errors).toEqual([]);
    expect(result.fabFileIds).toEqual(['fab-1', 'fab-1']);
    // Memoized: the org lookup is resolved once per message, not once per attachment.
    expect(organizationFindById).toHaveBeenCalledTimes(1);
  });

  it('reports a generic message and logs, instead of leaking the raw error, when the org lookup itself fails', async () => {
    // An unexpected DB error (not the storage-limit BadRequestError) must not be echoed
    // verbatim into a customer Slack channel - it can name internal details like a host:port.
    organizationFindById.mockReturnValue({
      select: () => ({
        lean: () => ({ exec: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:27017')) }),
      }),
    });

    const slackEvent = new SlackEvent({ channel: 'C1', user: 'U1', text: 'hello', ts: '1700000000.0001' } as never);
    const user = { id: 'user-1', organizationId: 'org-1' } as never;
    const handler = new CommandHandler(slackEvent, user, { downloadFile } as never, logger);

    const result = await handler.processSlackFiles([attachment()] as never);

    expect(result.fabFileIds).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).not.toContain('ECONNREFUSED');
    expect(result.errors[0]).toContain('Could not verify your storage limit');
    expect(logger.error).toHaveBeenCalledWith(
      '[Slack Files] Storage limit check failed',
      expect.objectContaining({ error: expect.any(Error) })
    );
  });
});
