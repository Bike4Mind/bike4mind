import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictError } from '@server/utils/errors';

const h = vi.hoisted(() => ({
  ghFindByDataLakeIdAny: vi.fn(),
  driveFindByDataLakeIdAny: vi.fn(),
  ghFindById: vi.fn(),
  driveFindById: vi.fn(),
  tryAcquire: vi.fn(),
  takeOver: vi.fn(),
  releaseByConnectionId: vi.fn(),
  findByLakeId: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  orgGitHubLakeConnectionRepository: { findByDataLakeIdAny: h.ghFindByDataLakeIdAny, findById: h.ghFindById },
  orgGoogleDriveConnectionRepository: { findByDataLakeIdAny: h.driveFindByDataLakeIdAny, findById: h.driveFindById },
  lakeConnectorClaimRepository: {
    tryAcquire: h.tryAcquire,
    takeOver: h.takeOver,
    releaseByConnectionId: h.releaseByConnectionId,
    findByLakeId: h.findByLakeId,
  },
}));

import { assertLakeConnectorFree, CLAIM_GRACE_MS, withLakeConnectorClaim } from './assertLakeConnectorFree';

describe('assertLakeConnectorFree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.ghFindByDataLakeIdAny.mockResolvedValue(null);
    h.driveFindByDataLakeIdAny.mockResolvedValue(null);
  });

  it('resolves when the lake has no connector of any kind', async () => {
    await expect(assertLakeConnectorFree('lake1')).resolves.toBeUndefined();
    expect(h.ghFindByDataLakeIdAny).toHaveBeenCalledWith('lake1');
    expect(h.driveFindByDataLakeIdAny).toHaveBeenCalledWith('lake1');
  });

  it('throws a ConflictError naming GitHub when a GitHub row exists', async () => {
    h.ghFindByDataLakeIdAny.mockResolvedValue({ id: 'gh1' });
    await expect(assertLakeConnectorFree('lake1')).rejects.toThrow(/already connected to a GitHub repository/i);
    await expect(assertLakeConnectorFree('lake1')).rejects.toThrow(ConflictError);
  });

  it('throws a ConflictError naming Google Drive when a Drive row exists', async () => {
    h.driveFindByDataLakeIdAny.mockResolvedValue({ id: 'drive1' });
    await expect(assertLakeConnectorFree('lake1')).rejects.toThrow(/already connected to a Google Drive folder/i);
    await expect(assertLakeConnectorFree('lake1')).rejects.toThrow(ConflictError);
  });

  it('ignores a Drive row (and never queries it) when except is googleDrive, but still refuses GitHub', async () => {
    h.driveFindByDataLakeIdAny.mockResolvedValue({ id: 'drive1' });
    await expect(assertLakeConnectorFree('lake1', { except: 'googleDrive' })).resolves.toBeUndefined();
    expect(h.driveFindByDataLakeIdAny).not.toHaveBeenCalled();

    h.ghFindByDataLakeIdAny.mockResolvedValue({ id: 'gh1' });
    await expect(assertLakeConnectorFree('lake1', { except: 'googleDrive' })).rejects.toThrow(
      /already connected to a GitHub repository/i
    );
  });

  it('ignores a GitHub row (and never queries it) when except is github, but still refuses Drive', async () => {
    h.ghFindByDataLakeIdAny.mockResolvedValue({ id: 'gh1' });
    await expect(assertLakeConnectorFree('lake1', { except: 'github' })).resolves.toBeUndefined();
    expect(h.ghFindByDataLakeIdAny).not.toHaveBeenCalled();

    h.driveFindByDataLakeIdAny.mockResolvedValue({ id: 'drive1' });
    await expect(assertLakeConnectorFree('lake1', { except: 'github' })).rejects.toThrow(
      /already connected to a Google Drive folder/i
    );
  });

  it('includeClaim refuses a live claim with no row yet, naming the holder kind', async () => {
    h.findByLakeId.mockResolvedValue({ kind: 'googleDrive', connectionId: 'd1', claimedAt: new Date() });
    await expect(assertLakeConnectorFree('lake1')).resolves.toBeUndefined();
    await expect(assertLakeConnectorFree('lake1', { includeClaim: true })).rejects.toThrow(
      /already connected to a Google Drive folder/i
    );
  });

  it('includeClaim ignores a stale claim (past grace, connection row gone)', async () => {
    h.findByLakeId.mockResolvedValue({
      kind: 'github',
      connectionId: 'g1',
      claimedAt: new Date(Date.now() - CLAIM_GRACE_MS - 1000),
    });
    h.ghFindById.mockResolvedValue(null);
    await expect(assertLakeConnectorFree('lake1', { includeClaim: true })).resolves.toBeUndefined();
    expect(h.ghFindById).toHaveBeenCalledWith('g1');
  });

  it('names GitHub when the lake is bound to both kinds', async () => {
    h.ghFindByDataLakeIdAny.mockResolvedValue({ id: 'gh1' });
    h.driveFindByDataLakeIdAny.mockResolvedValue({ id: 'drive1' });
    await expect(assertLakeConnectorFree('lake1')).rejects.toThrow(/already connected to a GitHub repository/i);
  });

  it('checks both kinds when no options are passed', async () => {
    h.ghFindByDataLakeIdAny.mockResolvedValue(null);
    h.driveFindByDataLakeIdAny.mockResolvedValue(null);
    await assertLakeConnectorFree('lake1');
    expect(h.ghFindByDataLakeIdAny).toHaveBeenCalledWith('lake1');
    expect(h.driveFindByDataLakeIdAny).toHaveBeenCalledWith('lake1');
  });
});

describe('withLakeConnectorClaim', () => {
  const create = vi.fn();
  const held = (kind: 'github' | 'googleDrive', ageMs: number) => ({
    acquired: false,
    holder: { kind, connectionId: 'holder1', claimedAt: new Date(Date.now() - ageMs) },
  });
  const claimedId = () => (h.tryAcquire.mock.calls[0][0] as { connectionId: string }).connectionId;

  beforeEach(() => {
    vi.clearAllMocks();
    h.ghFindByDataLakeIdAny.mockResolvedValue(null);
    h.driveFindByDataLakeIdAny.mockResolvedValue(null);
    h.ghFindById.mockResolvedValue(null);
    h.driveFindById.mockResolvedValue(null);
    h.tryAcquire.mockResolvedValue({ acquired: true });
    h.takeOver.mockResolvedValue(true);
    h.releaseByConnectionId.mockResolvedValue(true);
    create.mockImplementation(async (id: string) => ({ id }));
  });

  it('claims the lake under a fresh ObjectId and creates the row with that id', async () => {
    await expect(withLakeConnectorClaim('lake1', 'github', create)).resolves.toEqual({ id: claimedId() });
    expect(h.tryAcquire).toHaveBeenCalledWith({ lakeId: 'lake1', kind: 'github', connectionId: claimedId() });
    expect(claimedId()).toMatch(/^[0-9a-f]{24}$/);
    expect(h.releaseByConnectionId).not.toHaveBeenCalled();
  });

  it.each([
    ['github', 'googleDrive', /already connected to a Google Drive folder/i],
    ['googleDrive', 'github', /already connected to a GitHub repository/i],
    ['googleDrive', 'googleDrive', /already connected to a different Drive folder/i],
    ['github', 'github', /already connected to a GitHub repository/i],
  ] as const)('a %s connect loses to a live %s holder with a 409', async (kind, holderKind, message) => {
    h.tryAcquire.mockResolvedValue(held(holderKind, CLAIM_GRACE_MS * 2));
    h.ghFindById.mockResolvedValue({ id: 'holder1' });
    h.driveFindById.mockResolvedValue({ id: 'holder1' });
    const attempt = withLakeConnectorClaim('lake1', kind, create);
    await expect(attempt).rejects.toThrow(ConflictError);
    await expect(withLakeConnectorClaim('lake1', kind, create)).rejects.toThrow(message);
    expect(h.takeOver).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('takes over a holder past the grace window whose connection row is gone', async () => {
    h.tryAcquire.mockResolvedValue(held('github', CLAIM_GRACE_MS + 1000));
    await withLakeConnectorClaim('lake1', 'googleDrive', create);
    expect(h.ghFindById).toHaveBeenCalledWith('holder1');
    expect(h.takeOver).toHaveBeenCalledWith('lake1', 'holder1', { kind: 'googleDrive', connectionId: claimedId() });
    expect(create).toHaveBeenCalledWith(claimedId());
  });

  it('never takes over a holder inside the grace window, even with no row yet', async () => {
    h.tryAcquire.mockResolvedValue(held('github', 1000));
    await expect(withLakeConnectorClaim('lake1', 'googleDrive', create)).rejects.toThrow(ConflictError);
    expect(h.takeOver).not.toHaveBeenCalled();
  });

  it('409s (not 500s) when the claim kept changing hands and no holder could be read', async () => {
    h.tryAcquire.mockResolvedValue({ acquired: false, holder: null });
    await expect(withLakeConnectorClaim('lake1', 'github', create)).rejects.toThrow(ConflictError);
    expect(h.takeOver).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('409s when the takeover CAS loses to another request', async () => {
    h.tryAcquire.mockResolvedValue(held('github', CLAIM_GRACE_MS + 1000));
    h.takeOver.mockResolvedValue(false);
    await expect(withLakeConnectorClaim('lake1', 'googleDrive', create)).rejects.toThrow(ConflictError);
    expect(create).not.toHaveBeenCalled();
  });

  it('409s on a legacy row of another kind (no claim) and hands its own claim back', async () => {
    h.ghFindByDataLakeIdAny.mockResolvedValue({ id: 'legacy-gh' });
    await expect(withLakeConnectorClaim('lake1', 'googleDrive', create)).rejects.toThrow(
      /already connected to a GitHub repository/i
    );
    expect(create).not.toHaveBeenCalled();
    expect(h.releaseByConnectionId).toHaveBeenCalledWith(claimedId());
  });

  it('releases the claim and rethrows the original error when create throws, even if release fails', async () => {
    const boom = new Error('E11000 duplicate key');
    create.mockRejectedValue(boom);
    h.releaseByConnectionId.mockRejectedValue(new Error('db down'));
    await expect(withLakeConnectorClaim('lake1', 'github', create)).rejects.toBe(boom);
    expect(h.releaseByConnectionId).toHaveBeenCalledWith(claimedId());
  });
});
