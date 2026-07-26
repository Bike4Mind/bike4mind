import { describe, it, expect, beforeEach } from 'vitest';
import { ModelDiscoveryState, modelDiscoveryStateRepository } from './ModelDiscoveryStateModel';
import { setupMongoTest } from '../../__test__/utils';

const firstMiss = new Date('2026-07-01T00:00:00Z');
const secondMiss = new Date('2026-07-02T00:00:00Z');

describe('ModelDiscoveryStateRepository', () => {
  setupMongoTest();

  beforeEach(async () => {
    await ModelDiscoveryState.deleteMany({});
    await ModelDiscoveryState.ensureIndexes();
  });

  it('stamps firstMissAt once and counts consecutive misses', async () => {
    const first = await modelDiscoveryStateRepository.recordMiss('gpt-x', firstMiss);
    expect(first.missCount).toBe(1);
    expect(first.firstMissAt).toEqual(firstMiss);

    const second = await modelDiscoveryStateRepository.recordMiss('gpt-x', secondMiss);
    expect(second.missCount).toBe(2);
    expect(second.firstMissAt).toEqual(firstMiss);
  });

  it('resets the streak on a sighting and restamps it on the next miss', async () => {
    await modelDiscoveryStateRepository.recordMiss('gpt-x', firstMiss);
    const seen = await modelDiscoveryStateRepository.recordSighting('gpt-x', secondMiss);
    expect(seen.missCount).toBe(0);
    expect(seen.firstMissAt).toBeUndefined();
    expect(seen.lastSeenAt).toEqual(secondMiss);

    const missedAgain = await modelDiscoveryStateRepository.recordMiss('gpt-x', new Date('2026-07-03T00:00:00Z'));
    expect(missedAgain.missCount).toBe(1);
    expect(missedAgain.firstMissAt).toEqual(new Date('2026-07-03T00:00:00Z'));
  });

  it('keeps one mutable document per model', async () => {
    await modelDiscoveryStateRepository.recordMiss('gpt-x', firstMiss);
    await modelDiscoveryStateRepository.recordMiss('gpt-x', secondMiss);
    expect(await ModelDiscoveryState.countDocuments({ modelId: 'gpt-x' })).toBe(1);
    expect(await modelDiscoveryStateRepository.findByModelId('nope')).toBeNull();
  });
});
