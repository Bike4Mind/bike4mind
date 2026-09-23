import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';

/**
 * Pins the seeder's two load-bearing properties: it is idempotent (skips a client
 * that already exists) and it never throws out of seed() - a failure must not abort
 * the users/agents seeded before it (MigrationManager.seed has no per-seeder catch).
 */

const h = vi.hoisted(() => ({
  findOne: vi.fn(),
  create: vi.fn(),
  fetchPw: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  OAuthClientModel: { findOne: h.findOne, create: h.create },
}));
vi.mock('./UserSeeder', () => ({ fetchSeederPassword: h.fetchPw }));

import { OAuthClientSeeder, PREVIEW_PUBLIC_CLIENT_ID, PREVIEW_CONFIDENTIAL_CLIENT_ID } from './OAuthClientSeeder';

const logger = { info: vi.fn(), error: vi.fn() } as unknown as ConstructorParameters<typeof OAuthClientSeeder>[0];
const absent = () => ({ exec: () => Promise.resolve(null) });

describe('OAuthClientSeeder', () => {
  const priorIsPreview = process.env.IS_PREVIEW;

  beforeEach(() => {
    vi.clearAllMocks();
    h.fetchPw.mockResolvedValue('seeder-pw');
    h.create.mockResolvedValue({});
    process.env.IS_PREVIEW = 'true';
  });

  afterEach(() => {
    if (priorIsPreview === undefined) delete process.env.IS_PREVIEW;
    else process.env.IS_PREVIEW = priorIsPreview;
  });

  it('creates a public and a confidential client when neither exists', async () => {
    (h.findOne as Mock).mockReturnValue(absent());

    await new OAuthClientSeeder(logger).seed();

    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: PREVIEW_PUBLIC_CLIENT_ID,
        tokenEndpointAuthMethod: 'none',
        clientType: 'relying-party',
      })
    );
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: PREVIEW_CONFIDENTIAL_CLIENT_ID,
        tokenEndpointAuthMethod: 'client_secret_post',
        clientType: 'relying-party',
      })
    );
  });

  it('skips a client that already exists (idempotent)', async () => {
    (h.findOne as Mock).mockReturnValue({ exec: () => Promise.resolve({ clientId: 'x' }) });

    await new OAuthClientSeeder(logger).seed();

    expect(h.create).not.toHaveBeenCalled();
  });

  it('is a no-op on a non-preview stage (IS_PREVIEW!=true)', async () => {
    process.env.IS_PREVIEW = 'false';
    (h.findOne as Mock).mockReturnValue(absent());

    await new OAuthClientSeeder(logger).seed();

    expect(h.findOne).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it('never throws out of seed(): a failure is caught and logged', async () => {
    (h.findOne as Mock).mockReturnValue(absent());
    (h.fetchPw as Mock).mockRejectedValue(new Error('ssm down'));

    await expect(new OAuthClientSeeder(logger).seed()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});
