import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FabFileSourceType, KnowledgeType } from '@bike4mind/common';

/**
 * Guards the WIRING, which the ingest-module tests structurally cannot reach: they replace
 * `createLakeFile` / `createLakeFileFromUrl` with fakes at the deps boundary, so everything this
 * file does between that boundary and `fabFilesService` is unverified by them. That blind spot was
 * not hypothetical - `administeredOrgIds` arrived on the params and was dropped here, and
 * `@datalake add` failed at `createFabFile`'s own tag gate ("You do not have permission to change
 * this data lake's files") AFTER both prologue gates had authorized the write.
 *
 * The field is OPTIONAL on `CreateFabFileAdapters` (legitimately - the upload doors own their files
 * and pass no such context), so dropping it here typechecks green and fails only at runtime, for one
 * class of actor. Hence a test rather than a type.
 */

const createFabFile = vi.fn().mockResolvedValue({ id: 'f1', fileName: 'doc.txt' });
const createFabFileByUrl = vi.fn().mockResolvedValue({ id: 'f2', fileName: 'An Article' });

vi.mock('@bike4mind/services', () => ({
  fabFilesService: {
    get createFabFile() {
      return createFabFile;
    },
    get createFabFileByUrl() {
      return createFabFileByUrl;
    },
  },
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: vi.fn().mockResolvedValue(undefined) },
  scopedSettingsRepository: {},
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  fabFileRepository: {},
  organizationRepository: { findMembershipOrgIds: vi.fn(), findIdsWithAdminRights: vi.fn() },
  // Must actually run the callback: the FILE adapter wraps the create in it, so a stub that
  // returned without invoking would make the assertions below vacuously pass.
  withTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('@bike4mind/database/auth', () => ({ User: {} }));
vi.mock('@bike4mind/database/content', () => ({ FabFile: { findByIdAndDelete: vi.fn() } }));
vi.mock('@server/entitlements', () => ({ getUserEntitlements: vi.fn().mockResolvedValue([]) }));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ upload: vi.fn(), getSignedUrl: vi.fn() }),
}));

const { buildSlackLakeIngestDeps } = await import('./dataLakeIngestDeps');
const { dataLakeAccessGrantRepository } = await import('@bike4mind/database');

describe('buildSlackLakeIngestDeps forwards administeredOrgIds to the file create', () => {
  const deps = () =>
    buildSlackLakeIngestDeps({
      downloadFile: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

  beforeEach(() => {
    createFabFile.mockClear();
    createFabFileByUrl.mockClear();
  });

  it('relays the value on the FILE path', async () => {
    await deps().createLakeFile('user-1', {
      fileName: 'doc.txt',
      mimeType: 'text/plain',
      fileSize: 5,
      type: KnowledgeType.FILE,
      content: Buffer.from('hello'),
      contentType: 'text/plain',
      contentHash: 'abc',
      tags: [{ name: 'datalake:sales', strength: 1 }],
      provenance: { sourceType: FabFileSourceType.SLACK, sourceMetadata: {} },
      administeredOrgIds: ['org-2'],
    });

    // Third argument is the adapters object - where createFabFile reads it to build its actor.
    expect(createFabFile.mock.calls[0][2]).toMatchObject({ administeredOrgIds: ['org-2'] });
  });

  it('relays the value on the LINK path', async () => {
    await deps().createLakeFileFromUrl('user-1', {
      url: 'https://example.com/article',
      tags: [{ name: 'datalake:sales', strength: 1 }],
      provenance: { sourceType: FabFileSourceType.SLACK, sourceMetadata: {} },
      administeredOrgIds: ['org-2'],
    });

    // `createFabFileByUrl` accepts it and relays it onward to `createFabFile` itself, so the two
    // ingest paths cannot diverge on who is allowed to write.
    expect(createFabFileByUrl.mock.calls[0][2]).toMatchObject({ administeredOrgIds: ['org-2'] });
  });

  it('passes an empty set through rather than dropping the key', async () => {
    // A non-org-admin legitimately has none. The key must still arrive: `?? []` inside createFabFile
    // makes the two indistinguishable there, but asserting presence here keeps the contract explicit
    // and stops a truthiness guard from being added at the call site later.
    await deps().createLakeFileFromUrl('user-1', {
      url: 'https://example.com/article',
      tags: [],
      provenance: { sourceType: FabFileSourceType.SLACK, sourceMetadata: {} },
      administeredOrgIds: [],
    });

    expect(createFabFileByUrl.mock.calls[0][2]).toHaveProperty('administeredOrgIds', []);
  });
});

/**
 * GATE 4, found live against #2034's actual grant fixture: the shared `db` object wired here had no
 * `dataLakeAccessGrants`, so `createFabFile`'s own tag gate could not see ANY grant - a curator
 * grantee passed both prologue gates and was refused here with "You do not have permission to
 * change this data lake's files". The field is OPTIONAL on `CreateFabFileAdapters.db` (legitimately
 * - the upload doors apply their own tags and need no grant supersession), so this typechecked green
 * and failed only for a curator/grant-transferred-owner actor, same shape as the
 * `administeredOrgIds` gaps above.
 */
describe('buildSlackLakeIngestDeps wires dataLakeAccessGrants into the shared db', () => {
  const deps = () =>
    buildSlackLakeIngestDeps({
      downloadFile: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

  beforeEach(() => {
    createFabFile.mockClear();
    createFabFileByUrl.mockClear();
  });

  it('gives the FILE create the same grants repo the module exports for gates 1/2', async () => {
    await deps().createLakeFile('user-1', {
      fileName: 'doc.txt',
      mimeType: 'text/plain',
      fileSize: 5,
      type: KnowledgeType.FILE,
      content: Buffer.from('hello'),
      contentType: 'text/plain',
      contentHash: 'abc',
      tags: [{ name: 'datalake:sales', strength: 1 }],
      provenance: { sourceType: FabFileSourceType.SLACK, sourceMetadata: {} },
      administeredOrgIds: [],
    });

    const { db } = createFabFile.mock.calls[0][2];
    expect(db.dataLakeAccessGrants).toBe(dataLakeAccessGrantRepository);
  });

  it('gives the LINK create the same grants repo', async () => {
    await deps().createLakeFileFromUrl('user-1', {
      url: 'https://example.com/article',
      tags: [],
      provenance: { sourceType: FabFileSourceType.SLACK, sourceMetadata: {} },
      administeredOrgIds: [],
    });

    const { db } = createFabFileByUrl.mock.calls[0][2];
    expect(db.dataLakeAccessGrants).toBe(dataLakeAccessGrantRepository);
  });
});
