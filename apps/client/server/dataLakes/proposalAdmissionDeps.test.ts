import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  createFabFileByUrl: vi.fn(),
  adminSettings: { kind: 'adminSettings' },
  scopedSettings: { kind: 'scopedSettings' },
  dataLakes: { kind: 'dataLakes' },
  dataLakeAccessGrants: { kind: 'dataLakeAccessGrants' },
  users: { kind: 'users' },
  fabFiles: { kind: 'fabFiles', findByIdAndDelete: vi.fn() },
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: h.adminSettings,
  scopedSettingsRepository: h.scopedSettings,
  dataLakeRepository: h.dataLakes,
  dataLakeAccessGrantRepository: h.dataLakeAccessGrants,
}));
vi.mock('@bike4mind/database/auth', () => ({ User: h.users }));
vi.mock('@bike4mind/database/content', () => ({ FabFile: h.fabFiles }));
vi.mock('@bike4mind/services', () => ({ fabFilesService: { createFabFileByUrl: h.createFabFileByUrl } }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ upload: vi.fn(), getSignedUrl: vi.fn() }) }));

import { admitProposedSource } from './proposalAdmissionDeps';

const actor = { userId: 'reviewer-1', isAdmin: false, administeredOrgIds: ['org-1'] } as never;
const params = {
  url: 'https://example.com/report',
  tags: [{ name: 'datalake:acme', strength: 1 }],
  provenance: { sourceType: 'PROPOSAL_APPROVAL', sourceMetadata: {} },
} as never;

/** The `db` bag this adapter handed to the ingestion door on the last call. */
const dbHandedToDoor = () => h.createFabFileByUrl.mock.calls[0][2].db;

describe('admitProposedSource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createFabFileByUrl.mockResolvedValue({ id: 'file-1', fileName: 'Report' });
  });

  /**
   * Every adapter below is load-bearing for a gate that runs INSIDE the door, so an omission fails
   * silently rather than loudly - either narrowing the write gate below the review gate that already
   * cleared the reviewer, or letting a configured control resolve to its platform default. That is
   * the whole reason this file has a test: the service-level tests stub `admitSource`, so only an
   * assertion on the real wiring can see a missing key.
   */
  it.each([
    ['adminSettings', 'adminSettings'],
    ['users', 'users'],
    ['fabFiles', 'fabFiles'],
    ['dataLakes', 'dataLakes'],
    ['dataLakeAccessGrants', 'dataLakeAccessGrants'],
    ['scopedSettings', 'scopedSettings'],
  ] as const)('wires %s into the ingestion door', async (key, repo) => {
    await admitProposedSource(actor, params);

    expect(dbHandedToDoor()[key]).toBe(h[repo]);
  });

  // The admission contract reads BOTH its enforcement lever and the chunk-size it predicts against
  // through scoped overrides. Absent this repo both resolve platform-only, so a lake with scoped
  // enforcement on admits a violating member, and the prediction stops matching what the chunker
  // does for a reviewer holding an owner-scoped default. Same omission class as the grant repo.
  it('does not leave scopedSettings undefined, which would silently disable per-scope overrides', async () => {
    await admitProposedSource(actor, params);

    expect(dbHandedToDoor()).toHaveProperty('scopedSettings');
    expect(dbHandedToDoor().scopedSettings).toBeDefined();
  });

  // Cannot be derived from a user document inside the door, so the two ORG manage rungs are lost
  // without it - an org admin clears the 403 and is then refused the write it entitles them to.
  it('forwards the actor administered orgs and the compensating delete', async () => {
    await admitProposedSource(actor, params);

    const opts = h.createFabFileByUrl.mock.calls[0][2];
    expect(h.createFabFileByUrl.mock.calls[0][0]).toBe('reviewer-1');
    expect(opts.administeredOrgIds).toEqual(['org-1']);
    expect(typeof opts.deleteCreatedFile).toBe('function');
  });

  it('passes the caller tags and provenance through unchanged', async () => {
    await admitProposedSource(actor, params);

    const opts = h.createFabFileByUrl.mock.calls[0][2];
    expect(h.createFabFileByUrl.mock.calls[0][1]).toEqual({ url: 'https://example.com/report' });
    expect(opts.tags).toEqual([{ name: 'datalake:acme', strength: 1 }]);
    expect(opts.provenance).toEqual({ sourceType: 'PROPOSAL_APPROVAL', sourceMetadata: {} });
  });
});
