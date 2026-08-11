import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { OrgGoogleDriveConnection, orgGoogleDriveConnectionRepository } from './OrgGoogleDriveConnectionModel';

/**
 * Invariants for the org Google Drive connection (#1588). The load-bearing ones are the global
 * uniqueness of driveFolderId (a folder is claimable by one org, ever - the anti-cross-org-claim
 * control from the #1587 security review) and that oauthRefreshToken never leaks into a default read.
 */

let server: Awaited<ReturnType<typeof createMongoServer>>;

const base = {
  organizationId: 'org-1',
  authMode: 'oauth' as const,
  driveFolderId: 'folder-1',
  targetDataLakeId: 'lake-1',
  connectedBy: 'user-1',
};

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // Build the unique indexes so the uniqueness invariants below actually fire.
  await OrgGoogleDriveConnection.syncIndexes();
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 30000);

afterEach(async () => {
  await OrgGoogleDriveConnection.deleteMany({}, { hardDelete: true });
});

describe('OrgGoogleDriveConnectionModel - credential handling', () => {
  it('excludes oauthRefreshToken from default reads but returns it via findByIdWithCredentials', async () => {
    const created = await OrgGoogleDriveConnection.create({ ...base, oauthRefreshToken: 'enc-token' });

    const defaultRead = await OrgGoogleDriveConnection.findById(created.id);
    expect(defaultRead).not.toBeNull();
    expect(defaultRead?.oauthRefreshToken).toBeUndefined();

    const withCreds = await orgGoogleDriveConnectionRepository.findByIdWithCredentials(created.id, 'org-1');
    expect(withCreds?.oauthRefreshToken).toBe('enc-token');

    // org-scoped: another org cannot load this connection's credential by id alone.
    expect(await orgGoogleDriveConnectionRepository.findByIdWithCredentials(created.id, 'org-2')).toBeFalsy();
  });
});

describe('OrgGoogleDriveConnectionModel - uniqueness invariants', () => {
  it('rejects a second org claiming the same Drive folder (global folder uniqueness)', async () => {
    await OrgGoogleDriveConnection.create(base);
    await expect(
      OrgGoogleDriveConnection.create({
        ...base,
        organizationId: 'org-2',
        targetDataLakeId: 'lake-2', // different lake, same folder
      })
    ).rejects.toThrow();
  });

  it('rejects two connections feeding the same lake (one folder per lake)', async () => {
    await OrgGoogleDriveConnection.create(base);
    await expect(
      OrgGoogleDriveConnection.create({
        ...base,
        organizationId: 'org-2',
        driveFolderId: 'folder-2', // different folder, same lake
      })
    ).rejects.toThrow();
  });

  it('allows one org to hold multiple connections (distinct folders + lakes)', async () => {
    await OrgGoogleDriveConnection.create(base);
    const second = await OrgGoogleDriveConnection.create({
      ...base,
      driveFolderId: 'folder-2',
      targetDataLakeId: 'lake-2',
    });
    expect(second.id).toBeTruthy();

    const all = await orgGoogleDriveConnectionRepository.findByOrganizationId('org-1');
    expect(all).toHaveLength(2);
  });
});

describe('OrgGoogleDriveConnectionModel - accessors', () => {
  it('findByOrganizationId excludes disabled; findByOrganizationIdAny includes it', async () => {
    await OrgGoogleDriveConnection.create(base);
    await OrgGoogleDriveConnection.create({
      ...base,
      driveFolderId: 'folder-2',
      targetDataLakeId: 'lake-2',
      enabled: false,
    });

    const enabledOnly = await orgGoogleDriveConnectionRepository.findByOrganizationId('org-1');
    expect(enabledOnly).toHaveLength(1);
    expect(enabledOnly[0].driveFolderId).toBe('folder-1');

    const any = await orgGoogleDriveConnectionRepository.findByOrganizationIdAny('org-1');
    expect(any).toHaveLength(2);
  });

  it('findByDataLakeId and findByDriveFolderId resolve the connection', async () => {
    const created = await OrgGoogleDriveConnection.create(base);
    expect((await orgGoogleDriveConnectionRepository.findByDataLakeId('lake-1', 'org-1'))?.id).toBe(created.id);
    expect((await orgGoogleDriveConnectionRepository.findByDriveFolderId('folder-1'))?.id).toBe(created.id);
    // org-scoped: a different org sees no connection for this lake.
    expect(await orgGoogleDriveConnectionRepository.findByDataLakeId('lake-1', 'org-2')).toBeFalsy();
  });

  it('findByDataLakeId excludes a disabled connection', async () => {
    await OrgGoogleDriveConnection.create({ ...base, enabled: false });
    // BaseRepository.findOne resolves to undefined (not null) on no match - matches the sibling repos.
    expect(await orgGoogleDriveConnectionRepository.findByDataLakeId('lake-1', 'org-1')).toBeFalsy();
  });
});

describe('OrgGoogleDriveConnectionModel - health + sync cursor', () => {
  it('updateHealth sets an error and then clears it on a healthy update', async () => {
    const created = await OrgGoogleDriveConnection.create(base);

    const failed = await orgGoogleDriveConnectionRepository.updateHealth(created.id, {
      status: 'needs_reconnect',
      lastError: 'folder 404',
    });
    expect(failed?.status).toBe('needs_reconnect');
    expect(failed?.lastError).toBe('folder 404');

    const recovered = await orgGoogleDriveConnectionRepository.updateHealth(created.id, {
      status: 'connected',
      lastUsedAt: new Date(),
    });
    expect(recovered?.status).toBe('connected');
    expect(recovered?.lastError ?? null).toBeNull();
  });

  it('updateHealth redacts token-shaped fragments and truncates lastError', async () => {
    const created = await OrgGoogleDriveConnection.create(base);
    const raw = 'GET https://oauth2.googleapis.com/token?access_token=ya29.A0ARrdaM9longtokenfragmentxyz123 failed';
    const updated = await orgGoogleDriveConnectionRepository.updateHealth(created.id, {
      status: 'credential_error',
      lastError: raw,
    });
    expect(updated?.lastError).toContain('[redacted]');
    expect(updated?.lastError).not.toContain('ya29.A0ARrdaM9longtokenfragmentxyz123');
    expect((updated?.lastError || '').length).toBeLessThanOrEqual(520);
  });

  it('updateSyncCursor advances the cursor and stamps lastPolledAt', async () => {
    const created = await OrgGoogleDriveConnection.create(base);
    const when = new Date();
    const updated = await orgGoogleDriveConnectionRepository.updateSyncCursor(created.id, 'page-token-2', when);
    expect(updated?.syncCursor).toBe('page-token-2');
    expect(updated?.lastPolledAt?.getTime()).toBe(when.getTime());
  });
});
