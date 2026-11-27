import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../__test__/createMongoServer';
import { sreErrorPatternRepository } from './SreErrorPatternModel';

// The admin patterns table keys rows and builds PATCH /api/sre/patterns/{id} from `id`, so every
// read that feeds it must return the string id, not only the raw `_id`.
let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
}, MONGO_TEST_TIMEOUT_MS);
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  await mongoose.connection.collection('sreerrorpatterns').deleteMany({});
});

const seed = (fingerprint: string, repoSlug = 'acme/widgets') =>
  sreErrorPatternRepository.upsertFromFix(fingerprint, repoSlug, {
    name: `pattern ${fingerprint}`,
    errorMessage: 'boom',
    diagnosis: { rootCause: 'rc', proposedFix: 'fix', confidence: 0.9, riskAssessment: 'low', affectedFiles: [] },
    originTrackingId: 'tracking-1',
  });

describe('SreErrorPatternRepository id shape', () => {
  it('findRecent returns a string id equal to _id on every doc', async () => {
    await seed('fp-a');
    await seed('fp-b');
    await seed('fp-c', 'acme/other');

    const all = await sreErrorPatternRepository.findRecent(100);
    expect(all).toHaveLength(3);
    for (const doc of all) {
      const raw = doc as typeof doc & { _id: unknown };
      expect(typeof doc.id).toBe('string');
      expect(doc.id).toBe(String(raw._id));
    }

    const scoped = await sreErrorPatternRepository.findRecent(100, 'acme/widgets');
    expect(scoped.map(d => d.errorFingerprint).sort()).toEqual(['fp-a', 'fp-b']);
    expect(scoped.every(d => typeof d.id === 'string' && d.id.length === 24)).toBe(true);
  });

  it('the findRecent id round-trips through findById and update, the PATCH handler path', async () => {
    await seed('fp-a');
    const [listed] = await sreErrorPatternRepository.findRecent(100);

    const found = await sreErrorPatternRepository.findById(listed.id);
    expect(found?.errorFingerprint).toBe('fp-a');

    const updated = await sreErrorPatternRepository.update({ id: listed.id, isActive: false });
    expect(updated?.isActive).toBe(false);
    expect(String((updated as { id?: unknown; _id?: unknown }).id ?? '')).toBe(listed.id);
  });

  it('findActiveByFingerprint and upsertFromFix return a string id', async () => {
    const upserted = await seed('fp-a');
    expect(typeof upserted.id).toBe('string');

    const active = await sreErrorPatternRepository.findActiveByFingerprint('fp-a', 'acme/widgets', 0);
    expect(typeof active?.id).toBe('string');
    expect(active?.id).toBe(upserted.id);
  });

  it('recordMatch and update by the looked-up id affect the stored pattern', async () => {
    await seed('fp-a');
    const active = await sreErrorPatternRepository.findActiveByFingerprint('fp-a', 'acme/widgets', 0);
    const before = active?.matchCount ?? 0;

    await sreErrorPatternRepository.recordMatch(active!.id);
    const [afterMatch] = await sreErrorPatternRepository.findRecent(100);
    expect(afterMatch.matchCount).toBe(before + 1);

    await sreErrorPatternRepository.update({ id: active!.id, isActive: false });
    expect(await sreErrorPatternRepository.findActiveByFingerprint('fp-a', 'acme/widgets', 0)).toBeNull();
  });
});
