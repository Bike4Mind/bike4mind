import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';

/**
 * Pins the seeder's load-bearing properties: it upserts (re-asserts fields on an existing
 * client, never creates a duplicate), it never rotates the public client's stored hash, it
 * skips only the federated client when APP_URL is unset, and it never throws out of seed() -
 * a failure must not abort the users/agents seeded before it (MigrationManager.seed has no
 * per-seeder catch). Real-model validation lives in OAuthClientSeeder.integration.test.ts.
 */

const h = vi.hoisted(() => {
  const save = vi.fn();
  const findOne = vi.fn();
  const Model = Object.assign(
    vi.fn(function (this: Record<string, unknown>, init: Record<string, unknown>) {
      Object.assign(this, init, { save });
    }),
    { findOne }
  );
  return { save, findOne, Model, fetchPw: vi.fn() };
});

vi.mock('@bike4mind/database', () => ({ OAuthClientModel: h.Model }));
vi.mock('./UserSeeder', () => ({ fetchSeederPassword: h.fetchPw }));

import {
  OAuthClientSeeder,
  PREVIEW_PUBLIC_CLIENT_ID,
  PREVIEW_CONFIDENTIAL_CLIENT_ID,
  PREVIEW_FEDERATED_CLIENT_ID,
} from './OAuthClientSeeder';

const logger = { info: vi.fn(), error: vi.fn() } as unknown as ConstructorParameters<typeof OAuthClientSeeder>[0];
const absent = () => ({ exec: () => Promise.resolve(null) });
const constructedIds = () => h.Model.mock.calls.map(([init]) => (init as { clientId: string }).clientId);

type ExistingRow = { clientId: string; clientSecretHash: string; set: Mock; save: Mock };
const existingRows = () => {
  const rows = new Map<string, ExistingRow>();
  (h.findOne as Mock).mockImplementation(({ clientId }: { clientId: string }) => {
    const row: ExistingRow = { clientId, clientSecretHash: 'stored-hash', set: vi.fn(), save: vi.fn() };
    row.set.mockReturnValue(row);
    rows.set(clientId, row);
    return { exec: () => Promise.resolve(row) };
  });
  return rows;
};

describe('OAuthClientSeeder', () => {
  const priorIsPreview = process.env.IS_PREVIEW;
  const priorAppUrl = process.env.APP_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    h.fetchPw.mockResolvedValue('seeder-pw');
    h.save.mockResolvedValue(undefined);
    process.env.IS_PREVIEW = 'true';
    process.env.APP_URL = 'https://pr-1.preview.example.com/';
  });

  afterEach(() => {
    if (priorIsPreview === undefined) delete process.env.IS_PREVIEW;
    else process.env.IS_PREVIEW = priorIsPreview;
    if (priorAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = priorAppUrl;
  });

  it('creates the public, confidential and federated clients when none exists', async () => {
    (h.findOne as Mock).mockReturnValue(absent());

    await new OAuthClientSeeder(logger).seed();

    expect(constructedIds()).toEqual([
      PREVIEW_PUBLIC_CLIENT_ID,
      PREVIEW_CONFIDENTIAL_CLIENT_ID,
      PREVIEW_FEDERATED_CLIENT_ID,
    ]);
    expect(h.save).toHaveBeenCalledTimes(3);
    expect(h.Model).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: PREVIEW_PUBLIC_CLIENT_ID,
        tokenEndpointAuthMethod: 'none',
        clientType: 'relying-party',
        clientSecretHash: expect.any(String),
      })
    );
    expect(h.Model).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: PREVIEW_CONFIDENTIAL_CLIENT_ID,
        tokenEndpointAuthMethod: 'client_secret_post',
        clientType: 'relying-party',
      })
    );
  });

  it('builds the federated client on APP_URL (trailing slash stripped) with subjectSource sub', async () => {
    (h.findOne as Mock).mockReturnValue(absent());

    await new OAuthClientSeeder(logger).seed();

    expect(h.Model).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: PREVIEW_FEDERATED_CLIENT_ID,
        tokenEndpointAuthMethod: 'client_secret_post',
        clientType: 'relying-party',
        allowedScopes: ['openid', 'email', 'profile', 'ai:generate'],
        federatedIdp: {
          issuer: 'https://pr-1.preview.example.com',
          audience: PREVIEW_FEDERATED_CLIENT_ID,
          jwksUri: 'https://pr-1.preview.example.com/api/oauth/jwks',
          subjectSource: 'sub',
        },
      })
    );
  });

  it('updates existing clients in place (set + save) instead of creating new ones', async () => {
    const rows = existingRows();

    await new OAuthClientSeeder(logger).seed();

    expect(h.Model).not.toHaveBeenCalled();
    expect([...rows.keys()]).toEqual([
      PREVIEW_PUBLIC_CLIENT_ID,
      PREVIEW_CONFIDENTIAL_CLIENT_ID,
      PREVIEW_FEDERATED_CLIENT_ID,
    ]);
    for (const row of rows.values()) {
      expect(row.set).toHaveBeenCalledWith(expect.objectContaining({ isActive: true, clientType: 'relying-party' }));
      expect(row.save).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps an existing public client hash but re-sets the confidential and federated hashes', async () => {
    const rows = existingRows();

    await new OAuthClientSeeder(logger).seed();

    expect(rows.get(PREVIEW_PUBLIC_CLIENT_ID)!.set.mock.calls[0][0]).not.toHaveProperty('clientSecretHash');
    for (const id of [PREVIEW_CONFIDENTIAL_CLIENT_ID, PREVIEW_FEDERATED_CLIENT_ID]) {
      expect(rows.get(id)!.set).toHaveBeenCalledWith(expect.objectContaining({ clientSecretHash: expect.any(String) }));
    }
  });

  it('skips only the federated client, with an error log, when APP_URL is unset', async () => {
    delete process.env.APP_URL;
    (h.findOne as Mock).mockReturnValue(absent());

    await new OAuthClientSeeder(logger).seed();

    expect(constructedIds()).toEqual([PREVIEW_PUBLIC_CLIENT_ID, PREVIEW_CONFIDENTIAL_CLIENT_ID]);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('APP_URL'));
  });

  it('is a no-op on a non-preview stage (IS_PREVIEW!=true)', async () => {
    process.env.IS_PREVIEW = 'false';
    (h.findOne as Mock).mockReturnValue(absent());

    await new OAuthClientSeeder(logger).seed();

    expect(h.findOne).not.toHaveBeenCalled();
    expect(h.Model).not.toHaveBeenCalled();
  });

  it('never throws out of seed(): a failure is caught and logged', async () => {
    (h.findOne as Mock).mockReturnValue(absent());
    (h.fetchPw as Mock).mockRejectedValue(new Error('ssm down'));

    await expect(new OAuthClientSeeder(logger).seed()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});
