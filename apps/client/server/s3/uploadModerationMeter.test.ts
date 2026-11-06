// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findUser: vi.fn(),
  findOrg: vi.fn(),
  record: vi.fn(),
  reserve: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { name: 'adminSettings' },
  creditTransactionRepository: { name: 'creditTransactions' },
  organizationRepository: { findById: h.findOrg },
  usageEventRepository: { name: 'usageEvents' },
  userRepository: { findById: h.findUser },
}));
vi.mock('@bike4mind/services', () => ({ recordOperationalUsage: h.record }));
vi.mock('@bike4mind/utils/imageModeration', () => ({ REKOGNITION_MODERATION_USD_PER_CALL: 0.5 }));
vi.mock('@bike4mind/server-utils/entitlements/activeSubscriptions', () => ({
  activePlanResolver: { name: 'activePlans' },
}));
vi.mock('@server/s3/imageModerationBudget', () => ({ reserveImageModerationCalls: h.reserve }));

import { buildUploadModerationMeter } from './uploadModerationMeter';

const logger = { warn: vi.fn(), info: vi.fn() } as never;
const uploader = { id: 'u1', organizationId: 'o1' };
const meter = () => buildUploadModerationMeter({ userId: 'u1', fabFileId: 'ff1', logger });

beforeEach(() => {
  vi.clearAllMocks();
  h.findUser.mockResolvedValue(uploader);
  h.findOrg.mockResolvedValue({ id: 'o1' });
  h.record.mockResolvedValue(undefined);
  h.reserve.mockResolvedValue(true);
});

describe('buildUploadModerationMeter', () => {
  it('spends from the uploader allowance and reads the uploader once across both hooks', async () => {
    const m = meter();
    await expect(m.reserveModerationCalls!(4)).resolves.toBe(true);
    await m.recordModerationCalls!(4);

    expect(h.reserve).toHaveBeenCalledWith(uploader, 4);
    expect(h.findUser).toHaveBeenCalledTimes(1);
    expect(h.findUser).toHaveBeenCalledWith('u1');
  });

  it('relays a refused reservation', async () => {
    h.reserve.mockResolvedValue(false);

    await expect(meter().reserveModerationCalls!(1)).resolves.toBe(false);
  });

  it('charges a missing uploader the free allowance under its id', async () => {
    h.findUser.mockResolvedValue(null);

    await meter().reserveModerationCalls!(2);

    expect(h.reserve).toHaveBeenCalledWith({ id: 'u1' }, 2);
  });

  it('records the calls as operational usage with normal debit wiring', async () => {
    await meter().recordModerationCalls!(3);

    expect(h.record).toHaveBeenCalledWith(
      {
        requestId: 'ff1',
        user: uploader,
        organization: { id: 'o1' },
        feature: 'operations',
        provider: 'aws-rekognition',
        model: 'detect-moderation-labels',
        inputTokens: 0,
        costUsd: 1.5,
        source: 'system',
      },
      {
        db: {
          usageEvents: { name: 'usageEvents' },
          adminSettings: { name: 'adminSettings' },
          creditTransactions: { name: 'creditTransactions' },
          users: expect.objectContaining({ findById: h.findUser }),
          organizations: expect.objectContaining({ findById: h.findOrg }),
          activePlans: { name: 'activePlans' },
        },
        logger,
      }
    );
  });

  it('records without an organization when the uploader has none', async () => {
    h.findUser.mockResolvedValue({ id: 'u1' });
    await meter().recordModerationCalls!(1);
    expect(h.findOrg).not.toHaveBeenCalled();
    expect(h.record.mock.calls[0][0].organization).toBeNull();
  });

  it.each([
    ['missing', () => h.findOrg.mockResolvedValue(null)],
    ['unavailable', () => h.findOrg.mockRejectedValue(new Error('db down'))],
  ])('does not redirect an organization charge when its payer is %s', async (_state, failLookup) => {
    failLookup();

    await expect(meter().recordModerationCalls!(1)).resolves.toBeUndefined();

    expect(h.record).not.toHaveBeenCalled();
    expect((logger as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith(
      expect.stringContaining('could not record moderation usage for ff1')
    );
  });

  it('skips recording for a missing uploader', async () => {
    h.findUser.mockResolvedValue(null);

    await meter().recordModerationCalls!(1);

    expect(h.record).not.toHaveBeenCalled();
  });

  it('never throws into the scan when recording fails', async () => {
    h.findUser.mockRejectedValue(new Error('db down'));

    await expect(meter().recordModerationCalls!(1)).resolves.toBeUndefined();
    expect((logger as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith(
      expect.stringContaining('could not record moderation usage for ff1')
    );
  });
});
