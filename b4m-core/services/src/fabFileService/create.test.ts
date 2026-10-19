import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import {
  FabFileSourceType,
  type IOrganizationDocument,
  isStorageLimitError,
  KnowledgeType,
  SupportedFabFileMimeTypes,
  settingsMap,
} from '@bike4mind/common';
import { BadRequestError, invalidateSettingsCache } from '@bike4mind/utils';
import { createFabFile, createFabFileSchema, type CreateFabFileAdapters } from './create';

// Unsupported file-type gating on ingest. The rejection throws right
// after the user lookup - before any settings/storage adapter is touched - so
// these cases only need a user stub. This guards the loophole where a file with
// an unknown extension (e.g. setup.exe) was silently coerced to text/plain and
// accepted. (Extension-to-MIME resolution itself is covered by utils/file.test.ts.)
function adapters(): CreateFabFileAdapters {
  return {
    // any: these adapters are never reached on the rejection path under test.
    db: {
      users: { findById: vi.fn().mockResolvedValue({ id: 'u1' } as any) },
      fabFiles: { create: vi.fn() },
      adminSettings: { findAll: vi.fn(), findBySettingNames: vi.fn() } as any,
    },
    storage: { generateSignedUrl: vi.fn(), upload: vi.fn() },
  };
}

const base = { fileSize: 100, type: KnowledgeType.FILE as const };

describe('createFabFile — unsupported file-type gating', () => {
  it('rejects a binary with an unknown extension and empty MIME type (the setup.exe loophole)', async () => {
    await expect(createFabFile('u1', { ...base, fileName: 'malware.exe', mimeType: '' }, adapters())).rejects.toThrow(
      /not supported/i
    );
  });

  it('rejects a binary whose claimed MIME type is a real-but-unsupported type', async () => {
    await expect(
      createFabFile('u1', { ...base, fileName: 'installer.dll', mimeType: 'application/x-msdownload' }, adapters())
    ).rejects.toThrow(/not supported/i);
    await expect(
      createFabFile('u1', { ...base, fileName: 'bundle.zip', mimeType: 'application/octet-stream' }, adapters())
    ).rejects.toThrow(/not supported/i);
  });

  // A supplied claim must disqualify the plain-text fallback even when the name itself
  // is extension-less - otherwise the fallback becomes a route around the throw above.
  it('rejects an extension-less name whose claimed MIME type is unsupported', async () => {
    await expect(
      createFabFile('u1', { ...base, fileName: 'payload', mimeType: 'application/octet-stream' }, adapters())
    ).rejects.toThrow(/not supported/i);
  });

  it('rejects a digit-tail name whose claimed MIME type is unsupported', async () => {
    await expect(
      createFabFile('u1', { ...base, fileName: 'backup.001', mimeType: 'application/octet-stream' }, adapters())
    ).rejects.toThrow(/not supported/i);
  });
});

describe('createFabFile - reserved key prefix', () => {
  // exports/ in the fab-file bucket is reaped after 1 day, so a durable file stored there would
  // be deleted while its FabFile record survives.
  it.each(['exports', 'exports/', 'exports/nested', 'generated-audio-offload', 'generated-audio-offload/nested'])(
    'rejects prefix %j',
    async prefix => {
      const deps = adapters();
      await expect(
        createFabFile('u1', { ...base, fileName: 'notes.txt', mimeType: 'text/plain', prefix }, deps)
      ).rejects.toThrow(/reserved/);
      expect(deps.storage.upload).not.toHaveBeenCalled();
      expect(deps.db.fabFiles.create).not.toHaveBeenCalled();
    }
  );

  it.each(['curated-notebooks', 'modals', 'exportsx'])('still accepts prefix %j', prefix => {
    const parsed = createFabFileSchema.safeParse({ ...base, fileName: 'notes.txt', mimeType: 'text/plain', prefix });
    expect(parsed.success).toBe(true);
  });
});

describe('createFabFile - extension-first MIME resolution', () => {
  // Same user/storage stubs as adapters() above, but with fabFiles.create echoing
  // back the built data (so these cases can assert on the persisted mimeType) and
  // adminSettings resolving to an empty settings list (so getSettingsMap doesn't
  // reduce over undefined once execution passes the mime gate).
  function resolvingAdapters(): CreateFabFileAdapters {
    const deps = adapters();
    deps.db.fabFiles.create = vi.fn().mockImplementation(async data => ({ id: 'fab-1', ...data }));
    deps.db.adminSettings = {
      findAll: vi.fn().mockResolvedValue([]),
      findBySettingNames: vi.fn().mockResolvedValue([]),
    };
    return deps;
  }

  it('stores a shell script as its extension type even when the client claims text/plain', async () => {
    const created = await createFabFile(
      'u1',
      { ...base, fileName: 'deploy.sh', mimeType: 'text/plain' },
      resolvingAdapters()
    );

    expect(created.mimeType).toBe(SupportedFabFileMimeTypes.SH);
  });

  // Regression: the Mermaid preview card's disk-icon "Save as Mermaid file" upload sent
  // `<name>_<ts>.mmd` as text/plain and was refused with "File type .mmd is not supported"
  // because `.mmd` was missing from the extension table.
  it('accepts a Mermaid diagram source file (.mmd) saved as text/plain', async () => {
    const created = await createFabFile(
      'u1',
      { ...base, fileName: 'flowchart_1234567890.mmd', mimeType: 'text/plain' },
      resolvingAdapters()
    );

    expect(created.mimeType).toBe(SupportedFabFileMimeTypes.TXT_PLAIN);
  });

  // Inverted deliberately: a digit tail used to be exempted as a date/version fragment, which
  // meant renaming any binary to 'payload.1' got it admitted as plain text. Every dot-tail is
  // an extension now, so it must resolve or the file is refused.
  it('refuses a date-suffixed name rather than reading it as plain text', async () => {
    await expect(
      createFabFile('u1', { ...base, fileName: 'Meeting notes 2026.09.07', mimeType: '' }, resolvingAdapters())
    ).rejects.toThrow(BadRequestError);
  });

  it('still accepts a dotless name with no claim as plain text', async () => {
    const created = await createFabFile('u1', { ...base, fileName: 'LICENSE', mimeType: '' }, resolvingAdapters());

    expect(created.mimeType).toBe(SupportedFabFileMimeTypes.TXT_PLAIN);
  });

  // Malformed rather than extension-less, so it gets no fallback - matches Slack.
  it('refuses a trailing-dot name', async () => {
    await expect(
      createFabFile('u1', { ...base, fileName: 'payload.', mimeType: '' }, resolvingAdapters())
    ).rejects.toThrow(BadRequestError);
  });

  // What the trailing dot withholds is the FALLBACK, not the claim: with one supplied the name
  // resolves like any other extension-less one, so these two pin which half is which.
  it('accepts a trailing-dot name carrying a supported claim, as for any extension-less name', async () => {
    const created = await createFabFile(
      'u1',
      { ...base, fileName: 'payload.', mimeType: SupportedFabFileMimeTypes.TXT_PLAIN },
      resolvingAdapters()
    );

    expect(created.mimeType).toBe(SupportedFabFileMimeTypes.TXT_PLAIN);
  });

  it('refuses a trailing-dot name carrying an unsupported claim', async () => {
    await expect(
      createFabFile('u1', { ...base, fileName: 'payload.', mimeType: 'application/x-msdownload' }, resolvingAdapters())
    ).rejects.toThrow(BadRequestError);
  });

  it('still refuses a digit-led unsupported extension', async () => {
    await expect(
      createFabFile('u1', { ...base, fileName: 'archive.7z', mimeType: '' }, resolvingAdapters())
    ).rejects.toThrow(BadRequestError);
  });

  // Audio is storable but not ingestable: .mp3 resolves by extension, and the storable
  // predicate this door passes is what keeps it accepted.
  it('keeps accepting an audio file', async () => {
    const created = await createFabFile(
      'u1',
      { ...base, fileName: 'speech.mp3', mimeType: 'audio/mpeg' },
      resolvingAdapters()
    );

    expect(created.mimeType).toBe('audio/mpeg');
  });
});

describe('createFabFile (upload moderation gate root cause)', () => {
  const mockUserId = 'user-123';

  let mockAdapters: CreateFabFileAdapters;
  let fabFilesCreate: Mock;
  let storageUpload: Mock;
  let storageGenerateSignedUrl: Mock;

  beforeEach(() => {
    vi.clearAllMocks();

    fabFilesCreate = vi.fn().mockImplementation(async data => ({ id: 'fab-1', ...data }));
    storageUpload = vi.fn().mockResolvedValue(undefined);
    storageGenerateSignedUrl = vi.fn().mockResolvedValue('https://s3.example.com/signed-url');

    mockAdapters = {
      db: {
        fabFiles: { create: fabFilesCreate },
        adminSettings: {
          findAll: vi.fn().mockResolvedValue([]),
          findBySettingNames: vi.fn().mockResolvedValue([]),
        },
        users: {
          findById: vi.fn().mockResolvedValue({ id: mockUserId, storageLimit: 1000, currentStorageSize: 0 }),
        },
      },
      storage: {
        generateSignedUrl: storageGenerateSignedUrl,
        upload: storageUpload,
      },
    } as unknown as CreateFabFileAdapters;
  });

  it('does NOT mint or persist a fileUrl for an image ingested with content (bytes in hand)', async () => {
    const result = await createFabFile(
      mockUserId,
      {
        fileName: 'photo.png',
        mimeType: 'image/png',
        fileSize: 1024,
        type: KnowledgeType.FILE,
        content: Buffer.from('fake-image-bytes'),
        contentType: 'image/png',
      },
      mockAdapters
    );

    // Bytes are still uploaded to storage - only the servable GET url is withheld.
    expect(storageUpload).toHaveBeenCalled();
    expect(storageGenerateSignedUrl).not.toHaveBeenCalled();

    expect(result.fileUrl).toBeUndefined();
    expect(result.fileUrlExpireAt).toBeUndefined();
    // moderationStatus must be left for the schema default ('pending'), never stamped 'clean' here.
    expect((result as { moderationStatus?: string }).moderationStatus).toBeUndefined();

    const persistedData = fabFilesCreate.mock.calls[0][0];
    expect(persistedData).not.toHaveProperty('fileUrl');
    expect(persistedData).not.toHaveProperty('fileUrlExpireAt');
  });

  it('still mints and persists a fileUrl for non-image content (unaffected)', async () => {
    const result = await createFabFile(
      mockUserId,
      {
        fileName: 'notes.txt',
        mimeType: 'text/plain',
        fileSize: 12,
        type: KnowledgeType.FILE,
        content: Buffer.from('hello world!'),
        contentType: 'text/plain',
      },
      mockAdapters
    );

    expect(storageGenerateSignedUrl).toHaveBeenCalledWith(expect.any(String), expect.any(Number), 'get');
    expect(result.fileUrl).toBe('https://s3.example.com/signed-url');
    expect(result.fileUrlExpireAt).toBeInstanceOf(Date);
  });

  it('mints only a PUT presignedUrl (never a GET fileUrl) when no content is provided (client-upload path, unaffected)', async () => {
    const result = await createFabFile(
      mockUserId,
      {
        fileName: 'photo.png',
        mimeType: 'image/png',
        fileSize: 2048,
        type: KnowledgeType.FILE,
      },
      mockAdapters
    );

    expect(storageGenerateSignedUrl).toHaveBeenCalledWith(expect.any(String), 600, 'put');
    expect(result.fileUrl).toBeUndefined();
    expect((result as { presignedUrl?: string }).presignedUrl).toBe('https://s3.example.com/signed-url');
  });

  // Audio (generated TTS / sound effects) is storable-but-not-ingestable: it was
  // previously rejected by the mime gate (audio isn't in SupportedFabFileMimeTypes),
  // and must now be accepted via isStorableFabFileMimeType and stored as AUDIO.
  it('accepts generated audio and stores it as AUDIO with a servable GET url', async () => {
    const result = await createFabFile(
      mockUserId,
      {
        fileName: 'speech-hello-1234.mp3',
        mimeType: 'audio/mpeg',
        fileSize: 4096,
        type: KnowledgeType.AUDIO,
        content: Buffer.from('fake-audio-bytes'),
        contentType: 'audio/mpeg',
        prefix: 'generated-audio',
      },
      mockAdapters
    );

    expect(storageUpload).toHaveBeenCalled();
    // Non-image content path: a GET url is minted immediately (no moderation hold).
    expect(storageGenerateSignedUrl).toHaveBeenCalledWith(expect.any(String), expect.any(Number), 'get');
    expect(result.fileUrl).toBe('https://s3.example.com/signed-url');

    const persistedData = fabFilesCreate.mock.calls[0][0];
    expect(persistedData.type).toBe(KnowledgeType.AUDIO);
    expect(persistedData.mimeType).toBe('audio/mpeg');
    // Stored under the generated-audio prefix with an .mp3 extension.
    expect(persistedData.filePath).toMatch(/^generated-audio\/.+\.mp3$/);
  });
});

describe('createFabFile MaxFileSize enforcement - cleared setting no longer blocks every upload (#2456)', () => {
  const mockUserId = 'user-123';

  let mockAdapters: CreateFabFileAdapters;
  let fabFilesCreate: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    // The admin-settings cache key is process-wide ('all_settings'), not scoped to this test's
    // db mock - without invalidating it, whichever test in this file populates it first would
    // leak its findAll() result into every later test in this file.
    invalidateSettingsCache();

    fabFilesCreate = vi.fn().mockImplementation(async data => ({ id: 'fab-1', ...data }));
    mockAdapters = {
      db: {
        fabFiles: { create: fabFilesCreate },
        adminSettings: {
          findAll: vi.fn().mockResolvedValue([{ settingName: 'MaxFileSize', settingValue: '' }]),
          findBySettingNames: vi.fn().mockResolvedValue([]),
        },
        users: {
          findById: vi.fn().mockResolvedValue({ id: mockUserId, storageLimit: 1000, currentStorageSize: 0 }),
        },
      },
      storage: {
        generateSignedUrl: vi.fn().mockResolvedValue('https://s3.example.com/signed-url'),
        upload: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as CreateFabFileAdapters;
  });

  // Not undoing our own beforeEach - guarding the NEXT describe block in this file from it.
  // The admin-settings cache this block populates (`MaxFileSize: ''`) is process-wide, so
  // without this it would leak forward and feed every describe block that runs after this
  // one, not just the tests inside it.
  afterEach(() => {
    invalidateSettingsCache();
  });

  it('accepts a normal-sized upload when MaxFileSize is stored as a cleared empty string', async () => {
    await expect(
      createFabFile(
        mockUserId,
        {
          fileName: 'notes.txt',
          mimeType: 'text/plain',
          fileSize: 10 * 1024 * 1024, // 10MB - well under the 30MB default, well over a stray 0
          type: KnowledgeType.FILE,
        },
        mockAdapters
      )
    ).resolves.toBeDefined();
  });

  it('refuses a file over the cap with a file_too_large code and the byte counts', async () => {
    const limit = settingsMap.MaxFileSize.defaultValue! * 1024 * 1024;

    await expect(
      createFabFile(
        mockUserId,
        { fileName: 'huge.txt', mimeType: 'text/plain', fileSize: limit + 1, type: KnowledgeType.FILE },
        mockAdapters
      )
    ).rejects.toMatchObject({
      statusCode: 400,
      info: { errorCode: 'file_too_large', limit_bytes: limit, requested_bytes: limit + 1, owner: 'user' },
    });
    expect(fabFilesCreate).not.toHaveBeenCalled();
  });
});

describe('createFabFile provenance', () => {
  const mockUserId = 'user-123';
  let fabFilesCreate: Mock;
  let mockAdapters: CreateFabFileAdapters;

  beforeEach(() => {
    vi.clearAllMocks();
    fabFilesCreate = vi.fn().mockImplementation(async data => ({ id: 'fab-1', ...data }));
    mockAdapters = {
      db: {
        fabFiles: { create: fabFilesCreate },
        adminSettings: {
          findAll: vi.fn().mockResolvedValue([]),
          findBySettingNames: vi.fn().mockResolvedValue([]),
        },
        users: {
          findById: vi.fn().mockResolvedValue({ id: mockUserId, storageLimit: 1000, currentStorageSize: 0 }),
        },
      },
      storage: {
        generateSignedUrl: vi.fn().mockResolvedValue('https://s3.example.com/signed-url'),
        upload: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as CreateFabFileAdapters;
  });

  const params = {
    fileName: 'notes.txt',
    mimeType: 'text/plain',
    fileSize: 10,
    type: KnowledgeType.FILE as const,
  };

  it('stamps a server-supplied origin onto the persisted document', async () => {
    await createFabFile(mockUserId, params, {
      ...mockAdapters,
      provenance: {
        sourceType: FabFileSourceType.SLACK,
        sourceMetadata: { channel: 'C1', messageTs: '1700000000.0001' },
      },
    });

    const persisted = fabFilesCreate.mock.calls[0][0];
    expect(persisted.sourceType).toBe(FabFileSourceType.SLACK);
    expect(persisted.sourceMetadata).toEqual({ channel: 'C1', messageTs: '1700000000.0001' });
  });

  it('leaves both fields off when no provenance is supplied', async () => {
    await createFabFile(mockUserId, params, mockAdapters);

    const persisted = fabFilesCreate.mock.calls[0][0];
    expect(persisted).not.toHaveProperty('sourceType');
    expect(persisted).not.toHaveProperty('sourceMetadata');
  });

  // The whole reason provenance is an adapter and not a schema field: a request body must never
  // be able to claim an origin. This asserts the schema still strips it.
  it('ignores sourceType smuggled in through the request parameters', async () => {
    await createFabFile(
      mockUserId,
      { ...params, sourceType: FabFileSourceType.SLACK, sourceMetadata: { channel: 'spoofed' } } as never,
      mockAdapters
    );

    const persisted = fabFilesCreate.mock.calls[0][0];
    expect(persisted).not.toHaveProperty('sourceType');
    expect(persisted).not.toHaveProperty('sourceMetadata');
  });
});

// This is the door researchTaskService/process.ts and downloadRelevantLinks.ts create files
// through - it had NO lake-tag gating at all before this, unlike the update/toggle doors.
describe('createFabFile - lake-tag gate at create time', () => {
  const findByDatalakeTag = vi.fn().mockResolvedValue(null);

  const mockAdaptersFor = (isAdmin: boolean): CreateFabFileAdapters =>
    ({
      db: {
        fabFiles: { create: vi.fn().mockImplementation(async data => ({ id: 'fab-1', ...data })) },
        adminSettings: { findAll: vi.fn().mockResolvedValue([]), findBySettingNames: vi.fn().mockResolvedValue([]) },
        users: { findById: vi.fn().mockResolvedValue({ id: 'u1', isAdmin }) },
        dataLakes: { findByDatalakeTag },
      },
      storage: { generateSignedUrl: vi.fn().mockResolvedValue('url'), upload: vi.fn() },
    }) as unknown as CreateFabFileAdapters;

  it('refuses a non-admin creating a file with a static-registry-prefixed tag', async () => {
    await expect(
      createFabFile(
        'u1',
        { ...base, fileName: 'notes.txt', mimeType: 'text/plain', tags: [{ name: 'opti:report', strength: 1 }] },
        mockAdaptersFor(false)
      )
    ).rejects.toThrow(/only an admin can change this data lake/i);
  });

  it('allows an admin to create a file with a static-registry-prefixed tag', async () => {
    const result = await createFabFile(
      'u1',
      { ...base, fileName: 'notes.txt', mimeType: 'text/plain', tags: [{ name: 'opti:report', strength: 1 }] },
      mockAdaptersFor(true)
    );
    expect(result.id).toBe('fab-1');
  });

  it('refuses a datalake:* meta-tag naming no lake, even for the fallback researchTaskService path', async () => {
    await expect(
      createFabFile(
        'u1',
        {
          ...base,
          fileName: 'notes.txt',
          mimeType: 'text/plain',
          tags: [{ name: 'datalake:ghost-lake', strength: 1 }],
        },
        mockAdaptersFor(false)
      )
    ).rejects.toThrow(/do not have permission to change this data lake/i);
  });

  it('does not touch the dataLakes adapter for a create with no lake-related tags', async () => {
    findByDatalakeTag.mockClear();
    await createFabFile(
      'u1',
      { ...base, fileName: 'notes.txt', mimeType: 'text/plain', tags: [{ name: 'notes', strength: 1 }] },
      mockAdaptersFor(false)
    );
    expect(findByDatalakeTag).not.toHaveBeenCalled();
  });

  // This is exactly the call shape packages/scripts/datalake/ingest-pdf-datalake.ts makes to seed
  // a STATIC REGISTRY lake (datalake:opti-knowledge, no owning DB document) - the only supported
  // way to populate one. Centralizing assertCanWriteDataLakeTags here must not break it.
  it('allows an admin to create a file tagged into a static-registry lake, minting no fallback stamp', async () => {
    findByDatalakeTag.mockClear();
    const result = await createFabFile(
      'u1',
      {
        ...base,
        fileName: 'notes.txt',
        mimeType: 'text/plain',
        tags: [{ name: 'datalake:opti-knowledge', strength: 1 }],
      },
      mockAdaptersFor(true)
    );
    expect(result.id).toBe('fab-1');
    // assertCanWriteDataLakeTags' static-registry arm does no DB lookup (line 231-235 above), but
    // the fallback tagger (#2397) still resolves the meta-tag - a static-registry lake has no
    // owning document, so this returns null and mints no stamp, same as a stale/orphaned tag would.
    expect(findByDatalakeTag).toHaveBeenCalledTimes(1);
    expect(result.tags).toEqual([{ name: 'datalake:opti-knowledge', strength: 1 }]);
  });

  it('refuses a non-admin creating a file tagged into a static-registry lake', async () => {
    await expect(
      createFabFile(
        'u1',
        {
          ...base,
          fileName: 'notes.txt',
          mimeType: 'text/plain',
          tags: [{ name: 'datalake:opti-knowledge', strength: 1 }],
        },
        mockAdaptersFor(false)
      )
    ).rejects.toThrow(/only an admin can change this data lake/i);
  });
});

// #2397: createFabFile used to persist a lake meta-tag with no content-prefix stamp, unlike
// updateFabFile (which runs every whole-array tag write through reconcileLakeTags). A file
// created this way sat in its lake contributing nothing to tag-counts and appearing under no
// category in the Explorer tree until some later edit happened to trigger the stamp.
describe('createFabFile - lake fallback-tag stamp at create time (#2397)', () => {
  const lake = {
    id: 'lake1',
    name: 'Project Docs',
    fileTagPrefix: 'proj:',
    datalakeTag: 'datalake:project-docs',
    createdByUserId: 'u1',
  };

  const mockAdapters = (): CreateFabFileAdapters =>
    ({
      db: {
        fabFiles: { create: vi.fn().mockImplementation(async data => ({ id: 'fab-1', ...data })) },
        adminSettings: { findAll: vi.fn().mockResolvedValue([]), findBySettingNames: vi.fn().mockResolvedValue([]) },
        users: { findById: vi.fn().mockResolvedValue({ id: 'u1', isAdmin: false }) },
        dataLakes: {
          findByDatalakeTag: vi.fn().mockResolvedValue(lake),
          // No colliding lakes in scope, so decideStampPrefix's overlap check clears.
          find: vi.fn().mockResolvedValue([]),
        },
      },
      storage: { generateSignedUrl: vi.fn().mockResolvedValue('url'), upload: vi.fn() },
    }) as unknown as CreateFabFileAdapters;

  it('stamps <prefix>uncategorized on a file created with only the lake meta-tag', async () => {
    const result = await createFabFile(
      'u1',
      {
        ...base,
        fileName: 'notes.txt',
        mimeType: 'text/plain',
        tags: [{ name: 'datalake:project-docs', strength: 1 }],
      },
      mockAdapters()
    );

    // Same tag-counts/Explorer-tree signal reconcileLakeTags stamps on the update path - this is
    // the parity the acceptance criteria ask for.
    expect(result.tags).toEqual(
      expect.arrayContaining([
        { name: 'datalake:project-docs', strength: 1 },
        { name: 'proj:uncategorized', strength: 1 },
      ])
    );
  });

  it('mints no stamp when the file already carries a tag under the lake prefix', async () => {
    const result = await createFabFile(
      'u1',
      {
        ...base,
        fileName: 'notes.txt',
        mimeType: 'text/plain',
        tags: [
          { name: 'datalake:project-docs', strength: 1 },
          { name: 'proj:onboarding', strength: 1 },
        ],
      },
      mockAdapters()
    );

    expect(result.tags).toEqual([
      { name: 'datalake:project-docs', strength: 1 },
      { name: 'proj:onboarding', strength: 1 },
    ]);
  });

  // The upload and Slack doors record no membership event, so diffLakeMembership reads the join
  // time off this stamp; a create that inherited an older time would count as having sat through.
  it('stamps createdAt at the moment of a lake create', async () => {
    vi.useFakeTimers({ now: new Date('2026-06-10T12:00:00Z'), toFake: ['Date'] });
    try {
      const result = await createFabFile(
        'u1',
        {
          ...base,
          fileName: 'notes.txt',
          mimeType: 'text/plain',
          tags: [{ name: 'datalake:project-docs', strength: 1 }],
        },
        mockAdapters()
      );

      expect(result.createdAt).toEqual(new Date('2026-06-10T12:00:00Z'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a create with no tags at all untouched (no dataLakes round trip)', async () => {
    const adapters = mockAdapters();
    const result = await createFabFile('u1', { ...base, fileName: 'notes.txt', mimeType: 'text/plain' }, adapters);

    expect(result.tags).toBeUndefined();
    expect(adapters.db.dataLakes.findByDatalakeTag).not.toHaveBeenCalled();
  });
});

describe('createFabFile - owning organization', () => {
  const orgLake = {
    id: 'lake-1',
    datalakeTag: 'datalake:team',
    createdByUserId: 'u1',
    organizationId: 'org-1',
    createdAt: new Date('2026-01-01'),
  };

  function ownerAdapters(): CreateFabFileAdapters {
    return {
      db: {
        // any: only the fields prepareFabFile reads are stubbed.
        users: { findById: vi.fn().mockResolvedValue({ id: 'u1' } as any) },
        organizations: { findById: vi.fn().mockResolvedValue({ id: 'org-1', currentStorageSize: 0 } as any) },
        fabFiles: { create: vi.fn().mockImplementation(async data => ({ id: 'fab-1', ...data })) },
        adminSettings: { findAll: vi.fn().mockResolvedValue([]), findBySettingNames: vi.fn().mockResolvedValue([]) },
        dataLakes: {
          findByDatalakeTag: vi.fn(async (tag: string) => (tag === orgLake.datalakeTag ? (orgLake as any) : null)),
          find: vi.fn().mockResolvedValue([]),
        },
      },
      storage: { generateSignedUrl: vi.fn().mockResolvedValue('https://signed'), upload: vi.fn() },
    };
  }

  const file = { ...base, fileName: 'notes.txt', mimeType: 'text/plain' };

  it('persists the org of the org-owned lake the file joins', async () => {
    const created = await createFabFile(
      'u1',
      { ...file, tags: [{ name: orgLake.datalakeTag, strength: 1 }] },
      ownerAdapters()
    );
    expect(created.organizationId).toBe('org-1');
  });

  // The request's organizationId is the user's selected org, which is a display preference: a file
  // uploaded with an org selected stays personal unless it joins one of that org's lakes.
  it('never persists the caller-supplied organizationId', async () => {
    const created = await createFabFile('u1', { ...file, organizationId: 'org-from-request' }, ownerAdapters());
    expect(created).not.toHaveProperty('organizationId');
  });

  it('gates an upload into an org lake on the org quota, not the uploader', async () => {
    const adapters = ownerAdapters();
    // Only the quota fields checkOrganizationStorageLimit reads are stubbed.
    vi.mocked(adapters.db.organizations.findById).mockResolvedValue({
      id: 'org-1',
      storageLimit: 1,
      currentStorageSize: 1_000_000,
    } as unknown as IOrganizationDocument);

    await expect(
      createFabFile('u1', { ...file, fileSize: 100_000, tags: [{ name: orgLake.datalakeTag, strength: 1 }] }, adapters)
    ).rejects.toMatchObject({ info: { errorCode: 'org_storage_limit_exceeded', owner: 'org' } });
    expect(adapters.db.organizations.findById).toHaveBeenCalledWith('org-1');
    expect(adapters.db.fabFiles.create).not.toHaveBeenCalled();
  });

  it('persists the derived owner, not the caller-supplied org, when both are present', async () => {
    const created = await createFabFile(
      'u1',
      { ...file, organizationId: 'org-from-request', tags: [{ name: orgLake.datalakeTag, strength: 1 }] },
      ownerAdapters()
    );
    expect(created.organizationId).toBe('org-1');
  });
});

describe('createFabFile - organization storage limit lookup', () => {
  beforeEach(() => invalidateSettingsCache());
  afterEach(() => invalidateSettingsCache());

  // Shaped like the real repositories: findById is a prototype method that reads `this`, so it
  // only works when called on the adapter, not as a detached function.
  class OrganizationsAdapter {
    private readonly model = new Map([['org-1', { id: 'org-1', storageLimit: 1000, currentStorageSize: 0 }]]);
    async findById(id: string) {
      return (this.model.get(id) ?? null) as never;
    }
  }

  // The org is the one the file is stamped with: the org of the org lake it joins.
  const lakeFile = (organizationId: string) => ({
    fileName: 'report.md',
    mimeType: 'text/markdown',
    fileSize: 10,
    type: KnowledgeType.TEXT,
    tags: [{ name: `datalake:${organizationId}`, strength: 1 }],
  });
  const deps = () =>
    ({
      db: {
        fabFiles: { create: vi.fn().mockImplementation(async data => ({ id: 'fab-1', ...data })) },
        adminSettings: { findAll: vi.fn().mockResolvedValue([]), findBySettingNames: vi.fn().mockResolvedValue([]) },
        users: {
          findById: vi.fn().mockResolvedValue({ id: 'u1', storageLimit: 1000, currentStorageSize: 0 }),
        },
        organizations: new OrganizationsAdapter(),
        dataLakes: {
          findByDatalakeTag: vi.fn(async (tag: string) => ({
            id: `lake-${tag}`,
            datalakeTag: tag,
            createdByUserId: 'u1',
            organizationId: tag.slice('datalake:'.length),
            createdAt: new Date('2026-01-01'),
          })),
          find: vi.fn().mockResolvedValue([]),
        },
      },
      storage: { generateSignedUrl: vi.fn().mockResolvedValue('https://s3.example.com/x'), upload: vi.fn() },
    }) as unknown as CreateFabFileAdapters;

  it('looks the organization up through the adapter it was given', async () => {
    await expect(createFabFile('u1', lakeFile('org-1'), deps())).resolves.toMatchObject({
      id: 'fab-1',
      organizationId: 'org-1',
    });
  });

  it('refuses a file whose owning organization the adapter does not find', async () => {
    await expect(createFabFile('u1', lakeFile('org-missing'), deps())).rejects.toSatisfy(
      error => isStorageLimitError(error) && error.info.errorCode === 'org_storage_limit_exceeded'
    );
  });
});
