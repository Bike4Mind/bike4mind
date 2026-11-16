import { CreditHolderType } from '@bike4mind/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeCreditHold, recordSettlementAfterSweep } from './creditHoldTelemetry';

vi.mock('../security/resolveStage', () => ({ resolveStage: () => 'test' }));

const context = {
  ownerId: 'owner-1',
  ownerType: CreditHolderType.Organization as const,
  featureLabel: 'embeddings',
  lifecycle: 'request' as const,
};

beforeEach(() => {
  vi.stubEnv('B4M_SELF_HOST', 'false');
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('credit hold telemetry', () => {
  it('records one raw latency sample with owner attribution but only bounded metric dimensions', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(375);
    const result = { id: 'hold-1' };
    expect(await observeCreditHold(context, async () => result)).toBe(result);
    expect(console.info).toHaveBeenCalledTimes(1);
    const event = JSON.parse(vi.mocked(console.info).mock.calls[0][0]);
    expect(event).toMatchObject({ ...context, Stage: 'test', HoldLatency: 275, outcome: 'held' });
    expect(event._aws.CloudWatchMetrics).toEqual([
      {
        Namespace: 'Lumina5/CreditHolds',
        Dimensions: [['Stage', 'Lifecycle', 'Outcome']],
        Metrics: [{ Name: 'HoldLatency', Unit: 'Milliseconds' }],
      },
    ]);
  });

  it('records failed reservations without replacing the original error', async () => {
    const error = new Error('write conflict');
    await expect(
      observeCreditHold(context, async () => {
        throw error;
      })
    ).rejects.toBe(error);
    expect(JSON.parse(vi.mocked(console.info).mock.calls[0][0])).toMatchObject({
      outcome: 'error',
      Outcome: 'error',
    });
  });

  it('emits a count and a hold id for missing-hold settlement attempts', () => {
    recordSettlementAfterSweep(context, 'hold-1');
    expect(JSON.parse(vi.mocked(console.info).mock.calls[0][0])).toMatchObject({
      ...context,
      holdId: 'hold-1',
      SettlementsAfterSweep: 1,
      outcome: 'missing_hold',
    });
    const event = JSON.parse(vi.mocked(console.info).mock.calls[0][0]);
    expect(event._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Stage', 'Lifecycle']]);
    expect(event).not.toHaveProperty('Outcome');
  });

  it('does not serialize extra hold fields passed by a caller', () => {
    recordSettlementAfterSweep({ ...context, ...{ userId: 'actor', reservedCredits: 99 } }, 'hold-1');
    const event = JSON.parse(vi.mocked(console.info).mock.calls[0][0]);
    expect(event).not.toHaveProperty('userId');
    expect(event).not.toHaveProperty('reservedCredits');
  });

  it('keeps self-host observations in logs without publishing CloudWatch metrics', () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    recordSettlementAfterSweep(context, 'hold-1');
    const event = JSON.parse(vi.mocked(console.info).mock.calls[0][0]);
    expect(event.SettlementsAfterSweep).toBe(1);
    expect(event).not.toHaveProperty('_aws');
  });

  it('does not change success or failure when logging throws', async () => {
    vi.mocked(console.info).mockImplementation(() => {
      throw new Error('log unavailable');
    });
    expect(await observeCreditHold(context, async () => 7)).toBe(7);
    const error = new Error('reservation failed');
    await expect(
      observeCreditHold(context, async () => {
        throw error;
      })
    ).rejects.toBe(error);
    expect(() => recordSettlementAfterSweep(context, 'hold-1')).not.toThrow();
  });
});
