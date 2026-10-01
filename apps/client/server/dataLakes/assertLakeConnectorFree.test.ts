import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictError } from '@server/utils/errors';

const h = vi.hoisted(() => ({
  ghFindByDataLakeIdAny: vi.fn(),
  driveFindByDataLakeIdAny: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  orgGitHubLakeConnectionRepository: { findByDataLakeIdAny: h.ghFindByDataLakeIdAny },
  orgGoogleDriveConnectionRepository: { findByDataLakeIdAny: h.driveFindByDataLakeIdAny },
}));

import { assertLakeConnectorFree } from './assertLakeConnectorFree';

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

  it('checks both kinds when no options are passed', async () => {
    h.ghFindByDataLakeIdAny.mockResolvedValue(null);
    h.driveFindByDataLakeIdAny.mockResolvedValue(null);
    await assertLakeConnectorFree('lake1');
    expect(h.ghFindByDataLakeIdAny).toHaveBeenCalledWith('lake1');
    expect(h.driveFindByDataLakeIdAny).toHaveBeenCalledWith('lake1');
  });
});
