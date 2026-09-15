import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recordPolicyAcceptance } from './recordPolicyAcceptance';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { CURRENT_POLICY_VERSION } from '@bike4mind/common';

describe('recordPolicyAcceptance — AUP/ToS consent gate', () => {
  let mockAdapters: any;

  beforeEach(() => {
    vi.resetAllMocks();
    mockAdapters = {
      db: {
        users: {
          findById: vi.fn().mockResolvedValue({ id: 'user-1', username: 'u1', aupAcceptedVersion: null }),
          update: vi.fn().mockResolvedValue(undefined),
        },
      },
    };
  });

  it('stamps the current version, timestamp, and age flag on the user', async () => {
    const result = await recordPolicyAcceptance({ userId: 'user-1', ageAttestation: true }, mockAdapters);

    expect(result.aupAcceptedVersion).toBe(CURRENT_POLICY_VERSION);
    expect(result.aupAcceptedAt).toBeInstanceOf(Date);
    expect(result.ageAttestedAdult).toBe(true);
    expect(mockAdapters.db.users.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'user-1',
        aupAcceptedVersion: CURRENT_POLICY_VERSION,
        ageAttestedAdult: true,
      })
    );
  });

  it('rejects when the 18+ attestation is not true', async () => {
    await expect(
      recordPolicyAcceptance({ userId: 'user-1', ageAttestation: false as unknown as true }, mockAdapters)
    ).rejects.toThrow(BadRequestError);
    expect(mockAdapters.db.users.update).not.toHaveBeenCalled();
  });

  it('throws NotFoundError when the user does not exist', async () => {
    mockAdapters.db.users.findById.mockResolvedValue(null);
    await expect(recordPolicyAcceptance({ userId: 'missing', ageAttestation: true }, mockAdapters)).rejects.toThrow(
      NotFoundError
    );
    expect(mockAdapters.db.users.update).not.toHaveBeenCalled();
  });
});
