import { describe, it, expect, vi, beforeEach } from 'vitest';

const { assertLakeWriteAccess, assertCanWriteDataLakeTags, reconcileDataLakeFallbackTags } = vi.hoisted(() => ({
  assertLakeWriteAccess: vi.fn(),
  assertCanWriteDataLakeTags: vi.fn(),
  reconcileDataLakeFallbackTags: vi.fn(),
}));

vi.mock('@bike4mind/services', () => ({
  dataLakeService: { assertLakeWriteAccess, assertCanWriteDataLakeTags, reconcileDataLakeFallbackTags },
}));

import { FabFileSourceType, KnowledgeType } from '@bike4mind/common';
import { SLACK_MOCK_USER_ID } from '@bike4mind/slack';
import { ingestSlackFilesIntoLake, type SlackLakeIngestDeps } from './dataLakeFileIngest';

const actor = {
  id: 'user-1',
  isAdmin: false,
  tags: ['beta'],
  organizationId: 'org-1',
  email: 'a@example.com',
  emailVerified: true,
};

const lake = {
  id: 'lake-1',
  name: 'Sales',
  slug: 'sales',
  status: 'active',
  datalakeTag: 'datalake:sales',
  createdByUserId: 'user-1',
};

const attachment = (overrides: Record<string, unknown> = {}) => ({
  id: 'F1',
  name: 'notes.pdf',
  mimetype: 'application/pdf',
  url_private_download: 'https://files.slack.com/notes.pdf',
  size: 1024,
  ...overrides,
});

let deps: SlackLakeIngestDeps;
let createLakeFile: ReturnType<typeof vi.fn>;
let downloadFile: ReturnType<typeof vi.fn>;
let findByContentHashesInDataLake: ReturnType<typeof vi.fn>;
let resolveEntitlementKeys: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();

  createLakeFile = vi.fn().mockResolvedValue({ id: 'fab-1' });
  downloadFile = vi.fn().mockResolvedValue(Buffer.from('hello'));
  findByContentHashesInDataLake = vi.fn().mockResolvedValue([]);
  resolveEntitlementKeys = vi.fn().mockResolvedValue(['ent-a']);

  assertLakeWriteAccess.mockResolvedValue(lake);
  assertCanWriteDataLakeTags.mockResolvedValue(undefined);
  reconcileDataLakeFallbackTags.mockImplementation(async (tags: unknown[]) => [
    ...tags,
    { name: 'sales:uncategorized', strength: 1 },
  ]);

  deps = {
    dataLakes: {} as never,
    fabFiles: { findByContentHashesInDataLake },
    createLakeFile,
    resolveEntitlementKeys,
    downloadFile,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

const run = (overrides: Record<string, unknown> = {}) =>
  ingestSlackFilesIntoLake(
    {
      actor,
      lakeSlug: 'sales',
      files: [attachment()],
      channel: 'C123',
      messageTs: '1700000000.0001',
      ...overrides,
    } as never,
    deps
  );

describe('authorization comes before any side effect', () => {
  it('refuses the SLACK_BYPASS_USER_LOOKUP mock user without touching the lake or files', async () => {
    const outcome = await run({ actor: { ...actor, id: SLACK_MOCK_USER_ID } });

    expect(outcome).toMatchObject({ ok: false, reason: 'unlinked_actor' });
    expect(assertLakeWriteAccess).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
    expect(createLakeFile).not.toHaveBeenCalled();
  });

  it('does NOT download or create anything when the write gate denies', async () => {
    assertLakeWriteAccess.mockRejectedValue(new Error('Only the creator can add files to this data lake'));

    const outcome = await run();

    expect(outcome).toMatchObject({ ok: false, reason: 'not_authorized' });
    // The whole point of authorize-first: no orphan FabFile, no wasted download.
    expect(downloadFile).not.toHaveBeenCalled();
    expect(createLakeFile).not.toHaveBeenCalled();
  });

  it('maps an unreadable lake to not-found so existence is not leaked', async () => {
    assertLakeWriteAccess.mockRejectedValue(new Error('Data lake not found'));

    const outcome = await run();

    expect(outcome).toMatchObject({ ok: false, reason: 'lake_not_found' });
    if (outcome.ok) throw new Error('expected refusal');
    // Same wording a genuinely missing lake gets - a reader cannot distinguish the two.
    expect(outcome.message).toContain('No Data Lake `sales` found');
  });

  it('refuses a lake that is not draft or active', async () => {
    assertLakeWriteAccess.mockResolvedValue({ ...lake, status: 'archived' });

    const outcome = await run();

    expect(outcome).toMatchObject({ ok: false, reason: 'lake_not_writable' });
    expect(createLakeFile).not.toHaveBeenCalled();
  });

  it('also gates the meta-tag it is about to apply (defense in depth)', async () => {
    await run();

    expect(assertCanWriteDataLakeTags).toHaveBeenCalledWith(
      { userId: 'user-1', isAdmin: false },
      ['datalake:sales'],
      expect.anything()
    );
  });

  it('reports a meta-tag denial as a permission refusal, not a generic failure', async () => {
    assertCanWriteDataLakeTags.mockRejectedValue(new Error("Only the creator can change this data lake's files"));

    const outcome = await run();

    // Must not escape as a throw: the orchestrator would turn it into "something went wrong",
    // which tells the user nothing about it being a permission decision.
    expect(outcome).toMatchObject({ ok: false, reason: 'not_authorized' });
    expect(downloadFile).not.toHaveBeenCalled();
    expect(createLakeFile).not.toHaveBeenCalled();
  });

  it('refuses when the message carried no attachments', async () => {
    const outcome = await run({ files: [] });

    expect(outcome).toMatchObject({ ok: false, reason: 'no_files' });
    expect(assertLakeWriteAccess).not.toHaveBeenCalled();
  });
});

describe('AccessContext is built server-side', () => {
  it('resolves entitlements for a non-admin', async () => {
    await run();

    expect(resolveEntitlementKeys).toHaveBeenCalledWith(actor);
    expect(assertLakeWriteAccess).toHaveBeenCalledWith(
      'sales',
      expect.objectContaining({
        userId: 'user-1',
        isAdmin: false,
        userTags: ['beta'],
        organizationId: 'org-1',
        entitlementKeys: ['ent-a'],
      }),
      expect.anything()
    );
  });

  it('skips entitlement resolution for an admin (the gates never consult the keys)', async () => {
    await run({ actor: { ...actor, isAdmin: true } });

    expect(resolveEntitlementKeys).not.toHaveBeenCalled();
    expect(assertLakeWriteAccess).toHaveBeenCalledWith(
      'sales',
      expect.objectContaining({ isAdmin: true, entitlementKeys: [] }),
      expect.anything()
    );
  });
});

describe('ingest', () => {
  it('creates the file in the lake with tags, a server-computed hash and Slack provenance', async () => {
    const outcome = await run();

    expect(outcome).toMatchObject({ ok: true, lakeName: 'Sales', added: ['notes.pdf'], duplicates: [] });
    expect(createLakeFile).toHaveBeenCalledTimes(1);

    const [userId, params] = createLakeFile.mock.calls[0];
    // Attribution is the resolved B4M user, not any Slack-supplied identity.
    expect(userId).toBe('user-1');
    expect(params.type).toBe(KnowledgeType.FILE);
    expect(params.organizationId).toBe('org-1');
    // The downloaded buffer's real length, NOT the attachment's claimed `size` (1024): this value
    // becomes the S3 Content-Length and the storage charge.
    expect(params.fileSize).toBe(Buffer.from('hello').length);
    // sha256 of "hello", computed here rather than trusted from anywhere.
    expect(params.contentHash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(params.tags).toEqual([
      { name: 'datalake:sales', strength: 1 },
      { name: 'sales:uncategorized', strength: 1 },
    ]);
    expect(params.provenance).toEqual({
      sourceType: FabFileSourceType.SLACK,
      sourceMetadata: { channel: 'C123', messageTs: '1700000000.0001' },
    });
  });

  it('skips a file whose content is already in THIS lake, without replacing it', async () => {
    findByContentHashesInDataLake.mockResolvedValue([
      { contentHash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' },
    ]);

    const outcome = await run();

    expect(outcome).toMatchObject({ ok: true, added: [], duplicates: ['notes.pdf'] });
    expect(createLakeFile).not.toHaveBeenCalled();
  });

  it('queries dedup per-lake, scoped to the lake meta-tag', async () => {
    await run();

    expect(findByContentHashesInDataLake).toHaveBeenCalledWith(
      ['2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'],
      'datalake:sales'
    );
  });

  it('dedups two identical attachments within one message', async () => {
    const outcome = await run({ files: [attachment(), attachment({ id: 'F2', name: 'copy.pdf' })] });

    expect(outcome).toMatchObject({ ok: true, added: ['notes.pdf'], duplicates: ['copy.pdf'] });
    expect(createLakeFile).toHaveBeenCalledTimes(1);
  });

  it('surfaces an unsupported attachment while still ingesting the good one', async () => {
    const outcome = await run({
      files: [attachment(), attachment({ id: 'F2', name: 'app.exe', mimetype: 'application/octet-stream' })],
    });

    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.added).toEqual(['notes.pdf']);
    expect(outcome.rejected.join(' ')).toContain('app.exe');
  });

  it('surfaces an incomplete Slack file object rather than dropping it silently', async () => {
    const outcome = await run({ files: [attachment({ id: 'F2', name: undefined, mimetype: undefined })] });

    if (!outcome.ok) throw new Error('expected success');
    // The plain attachment path skips these quietly; after an explicit "add", silence reads as success.
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.added).toEqual([]);
  });

  it('keeps going when one download fails', async () => {
    downloadFile.mockRejectedValueOnce(new Error('slack 404')).mockResolvedValueOnce(Buffer.from('second'));

    const outcome = await run({ files: [attachment(), attachment({ id: 'F2', name: 'ok.pdf' })] });

    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.added).toEqual(['ok.pdf']);
    expect(outcome.rejected.join(' ')).toContain('notes.pdf');
  });

  it('keeps going when one create fails, reporting it instead of losing the batch', async () => {
    createLakeFile.mockRejectedValueOnce(new Error('File size exceeds maximum file size'));
    downloadFile.mockResolvedValueOnce(Buffer.from('one')).mockResolvedValueOnce(Buffer.from('two'));

    const outcome = await run({ files: [attachment(), attachment({ id: 'F2', name: 'ok.pdf' })] });

    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.added).toEqual(['ok.pdf']);
    expect(outcome.rejected.join(' ')).toContain('File size exceeds maximum file size');
  });

  // Guards the memory ceiling: each attachment is downloaded, created and released before the next
  // download starts. Batching every download first would hold the sum of all attachments at once.
  it('processes one attachment start-to-finish before downloading the next', async () => {
    const order: string[] = [];
    downloadFile.mockImplementation(async (_url: string, name: string) => {
      order.push(`download:${name}`);
      return Buffer.from(name);
    });
    createLakeFile.mockImplementation(async (_userId: string, params: { fileName: string }) => {
      order.push(`create:${params.fileName}`);
      return { id: 'fab' };
    });

    await run({ files: [attachment({ name: 'a.pdf' }), attachment({ id: 'F2', name: 'b.pdf' })] });

    expect(order).toEqual(['download:a.pdf', 'create:a.pdf', 'download:b.pdf', 'create:b.pdf']);
  });

  it('does not call an identical retry a duplicate when the first create failed', async () => {
    // Both attachments carry the same bytes, so the second hits the in-message dedup path. It must
    // not be reported as already in the lake - nothing landed, so that message would be a lie.
    createLakeFile.mockRejectedValue(new Error('storage limit reached'));

    const outcome = await run({ files: [attachment(), attachment({ id: 'F2', name: 'copy.pdf' })] });

    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.duplicates).toEqual([]);
    expect(outcome.added).toEqual([]);
    expect(outcome.rejected).toHaveLength(2);
  });

  it('does not query dedup or create when every attachment was rejected', async () => {
    const outcome = await run({ files: [attachment({ mimetype: 'application/octet-stream' })] });

    expect(outcome).toMatchObject({ ok: true, added: [], duplicates: [] });
    expect(findByContentHashesInDataLake).not.toHaveBeenCalled();
    expect(createLakeFile).not.toHaveBeenCalled();
  });
});
