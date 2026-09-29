import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { OrgGitHubLakeConnection, orgGitHubLakeConnectionRepository } from './OrgGitHubLakeConnectionModel';

/**
 * Invariants for the one-repo-to-one-lake GitHub connection: the global uniqueness of both
 * repositoryId (a repo feeds one lake, ever) and targetDataLakeId (a lake is fed by one source),
 * that several bindings may legitimately share an installationId, and that release is org-scoped
 * and hard-deletes so the freed claims can be re-taken.
 */

let server: Awaited<ReturnType<typeof createMongoServer>>;

const base = {
  organizationId: 'org-1',
  targetDataLakeId: 'lake-1',
  installationId: 111,
  accountLogin: 'acme',
  repositoryId: 1,
  repositoryFullName: 'acme/one',
  connectedBy: 'user-1',
  connectedAt: new Date('2024-01-01T00:00:00.000Z'),
};

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await OrgGitHubLakeConnection.createIndexes();
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 30000);

afterEach(async () => {
  await OrgGitHubLakeConnection.deleteMany({}, { hardDelete: true });
});

describe('OrgGitHubLakeConnectionModel - creation', () => {
  it('creates a connection', async () => {
    const created = await OrgGitHubLakeConnection.create(base);
    expect(created.id).toBeTruthy();
    expect(created.repositoryFullName).toBe('acme/one');
  });
});

describe('OrgGitHubLakeConnectionModel - uniqueness invariants', () => {
  it('rejects a second lake claiming the same repository (global repositoryId uniqueness)', async () => {
    await OrgGitHubLakeConnection.create(base);
    await expect(
      OrgGitHubLakeConnection.create({
        ...base,
        targetDataLakeId: 'lake-2', // different lake, same repo
      })
    ).rejects.toThrow();
  });

  it('rejects a second repository feeding the same lake (one source per lake)', async () => {
    await OrgGitHubLakeConnection.create(base);
    await expect(
      OrgGitHubLakeConnection.create({
        ...base,
        repositoryId: 2, // different repo, same lake
      })
    ).rejects.toThrow();
  });

  it('allows two repositories under the same installation, and findByInstallationId returns both', async () => {
    const first = await OrgGitHubLakeConnection.create(base);
    const second = await OrgGitHubLakeConnection.create({
      ...base,
      targetDataLakeId: 'lake-2',
      repositoryId: 2,
      repositoryFullName: 'acme/two',
    });

    const bound = await orgGitHubLakeConnectionRepository.findByInstallationId(base.installationId);
    expect(bound.map(b => b.id).sort()).toEqual([first.id, second.id].sort());
  });
});

describe('OrgGitHubLakeConnectionModel - accessors', () => {
  it('findByDataLakeIdAny resolves the connection feeding a lake, or undefined for none', async () => {
    const created = await OrgGitHubLakeConnection.create(base);
    expect((await orgGitHubLakeConnectionRepository.findByDataLakeIdAny('lake-1'))?.id).toBe(created.id);
    expect(await orgGitHubLakeConnectionRepository.findByDataLakeIdAny('lake-missing')).toBeFalsy();
  });
});

describe('OrgGitHubLakeConnectionModel - release', () => {
  it('is org-scoped: the wrong org cannot release, and the row is kept', async () => {
    const created = await OrgGitHubLakeConnection.create(base);
    expect(await orgGitHubLakeConnectionRepository.release(created.id, 'org-2')).toBe(false);
    expect(await OrgGitHubLakeConnection.findById(created.id)).not.toBeNull();
  });

  it('hard-deletes so a released repository can be re-claimed', async () => {
    const created = await OrgGitHubLakeConnection.create(base);
    expect(await orgGitHubLakeConnectionRepository.release(created.id, 'org-1')).toBe(true);
    expect(await OrgGitHubLakeConnection.findById(created.id)).toBeNull();

    const reclaimed = await OrgGitHubLakeConnection.create({
      ...base,
      organizationId: 'org-2',
      targetDataLakeId: 'lake-2',
    });
    expect(reclaimed.id).toBeTruthy();
  });
});
