import { describe, it, expect, beforeEach } from 'vitest';
import { ModelDiscoveryState, modelDiscoveryStateRepository } from './ModelDiscoveryStateModel';
import { setupMongoTest } from '../../__test__/utils';

const firstMiss = new Date('2026-07-01T00:00:00Z');
const secondMiss = new Date('2026-07-02T00:00:00Z');

const deprecation = { status: 'deprecated', deprecationDate: '2026-08-10', source: 'anthropic' };

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

  it('reads a whole run of models in one query and skips the ids with no row', async () => {
    await modelDiscoveryStateRepository.recordMiss('gpt-x', firstMiss);
    await modelDiscoveryStateRepository.recordMiss('gpt-y', secondMiss);

    const states = await modelDiscoveryStateRepository.findByModelIds(['gpt-x', 'gpt-y', 'never-seen']);

    expect(states.map(state => state.modelId).sort()).toEqual(['gpt-x', 'gpt-y']);
    expect(await modelDiscoveryStateRepository.findByModelIds([])).toEqual([]);
  });

  describe('suggestions', () => {
    it('records one and lists it as pending', async () => {
      const stored = await modelDiscoveryStateRepository.recordSuggestion('gpt-x', deprecation, firstMiss);

      expect(stored.suggestion).toMatchObject({ ...deprecation, suggestedAt: firstMiss });
      expect((await modelDiscoveryStateRepository.pendingSuggestions()).map(state => state.modelId)).toEqual(['gpt-x']);
    });

    it('overwrites an unresolved suggestion on the next run', async () => {
      await modelDiscoveryStateRepository.recordSuggestion('gpt-x', deprecation, firstMiss);
      const rerun = await modelDiscoveryStateRepository.recordSuggestion(
        'gpt-x',
        { ...deprecation, retirementDate: '2027-01-01' },
        secondMiss
      );

      expect(rerun.suggestion).toMatchObject({ retirementDate: '2027-01-01', suggestedAt: secondMiss });
      expect(await ModelDiscoveryState.countDocuments({})).toBe(1);
    });

    it('keeps the original suggestedAt while an unresolved item says the same thing', async () => {
      await modelDiscoveryStateRepository.recordSuggestion('gpt-x', deprecation, firstMiss);

      const rerun = await modelDiscoveryStateRepository.recordSuggestion('gpt-x', deprecation, secondMiss);

      // Re-stamping every run would make the queue age read as today forever.
      expect(rerun.suggestion).toMatchObject({ suggestedAt: firstMiss });
    });

    it('leaves a settled suggestion settled while the content is unchanged', async () => {
      await modelDiscoveryStateRepository.recordSuggestion('gpt-x', deprecation, firstMiss);
      await modelDiscoveryStateRepository.resolveSuggestion('gpt-x', 'dismissed', secondMiss);

      const rerun = await modelDiscoveryStateRepository.recordSuggestion('gpt-x', deprecation, secondMiss);

      expect(rerun.suggestion).toMatchObject({ resolution: 'dismissed', suggestedAt: firstMiss });
      expect(await modelDiscoveryStateRepository.pendingSuggestions()).toEqual([]);
    });

    it('re-raises a settled suggestion when the content differs', async () => {
      await modelDiscoveryStateRepository.recordSuggestion('gpt-x', deprecation, firstMiss);
      await modelDiscoveryStateRepository.resolveSuggestion('gpt-x', 'dismissed', secondMiss);

      const rerun = await modelDiscoveryStateRepository.recordSuggestion(
        'gpt-x',
        { ...deprecation, replacedBy: 'gpt-y' },
        secondMiss
      );

      expect(rerun.suggestion?.resolution).toBeUndefined();
      expect(rerun.suggestion?.replacedBy).toBe('gpt-y');
      expect((await modelDiscoveryStateRepository.pendingSuggestions()).map(state => state.modelId)).toEqual(['gpt-x']);
    });

    it('records the operator verdict and reports nothing to settle when there is none', async () => {
      await modelDiscoveryStateRepository.recordSuggestion('gpt-x', deprecation, firstMiss);

      const resolved = await modelDiscoveryStateRepository.resolveSuggestion('gpt-x', 'accepted', secondMiss);

      expect(resolved?.suggestion).toMatchObject({ resolution: 'accepted', resolvedAt: secondMiss });
      expect(await modelDiscoveryStateRepository.resolveSuggestion('gpt-y', 'accepted')).toBeNull();
    });
  });

  it('reads a row written before the suggestion field existed', async () => {
    // Straight to the collection: this is the shape a pre-Phase-4 build wrote,
    // plus a field a later one might add. Neither may cost us the row.
    await ModelDiscoveryState.collection.insertOne({
      modelId: 'gpt-old',
      missCount: 2,
      firstMissAt: firstMiss,
      somethingLaterBuildsAdded: true,
      createdAt: firstMiss,
      updatedAt: firstMiss,
    });

    const state = await modelDiscoveryStateRepository.findByModelId('gpt-old');
    expect(state).toMatchObject({ modelId: 'gpt-old', missCount: 2 });
    expect(state?.suggestion).toBeUndefined();

    const suggested = await modelDiscoveryStateRepository.recordSuggestion('gpt-old', deprecation, secondMiss);
    expect(suggested.suggestion).toMatchObject(deprecation);
    expect(suggested.missCount).toBe(2);
  });
});
