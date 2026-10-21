import { describe, expect, it, vi } from 'vitest';
import { regenerateHashesForDeletion } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({ distinct: vi.fn(), setOptions: vi.fn() }));
vi.mock('sst', () => ({ Resource: { SECRET_ENCRYPTION_KEY: { value: 'test-telemetry-hmac-secret' } } }));
vi.mock('@bike4mind/database', () => ({
  User: { findById: () => ({ select: () => ({ lean: async () => ({ organizationId: 'current-org' }) }) }) },
  organizationRepository: { findMembershipOrgIds: async () => ['member-org'] },
  Quest: { distinct: mocks.distinct },
}));
import { deriveTelemetrySalts, regenerateUserTelemetryHashes } from './telemetryHashLookup';

describe('telemetry hash lookup', () => {
  it('covers personal, current, member and departed organizations, including deleted turns', async () => {
    mocks.distinct.mockReturnValue({ setOptions: mocks.setOptions });
    mocks.setOptions.mockResolvedValue(['departed-org']);
    const hashes = await regenerateUserTelemetryHashes('user-1');
    const salts = deriveTelemetrySalts();
    for (const organizationId of ['default', 'current-org', 'member-org', 'departed-org']) {
      expect(hashes).toEqual(expect.arrayContaining(regenerateHashesForDeletion('user-1', organizationId, salts)));
    }
    expect(mocks.distinct).toHaveBeenCalledWith('promptMeta.session.organizationId', {
      'promptMeta.session.userId': 'user-1',
    });
    expect(mocks.setOptions).toHaveBeenCalledWith({ includeDeleted: true });
  });
});
