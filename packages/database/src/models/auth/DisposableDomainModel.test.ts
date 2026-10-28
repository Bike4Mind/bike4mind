import { beforeEach, describe, expect, it } from 'vitest';
import { setupMongoTest } from '../../__test__/utils';
import {
  DisposableDomainModel,
  DisposableDomainSourceModel,
  DomainIntelligenceModel,
  disposableDomainRepository as repo,
} from './DisposableDomainModel';

describe('disposable domain persistence', () => {
  setupMongoTest();
  beforeEach(async () => {
    await Promise.all([
      DisposableDomainModel.deleteMany({}),
      DisposableDomainSourceModel.deleteMany({}),
      DomainIntelligenceModel.deleteMany({}),
    ]);
    await DisposableDomainModel.ensureIndexes();
  });

  it('replaces one source without touching the others', async () => {
    await repo.replaceDisposableSource('curated', ['shared-burner.test', 'curated-only.test'], new Date(1000));
    await repo.replaceDisposableSource('aggregate', ['shared-burner.test', 'dropped.test'], new Date(1000));
    await repo.replaceDisposableSource('aggregate', ['shared-burner.test', 'new-burner.test'], new Date(2000));

    const docs = await DisposableDomainModel.find({}).sort({ domain: 1 }).lean();
    expect(docs.map(doc => [doc.domain, [...doc.sources].sort()])).toEqual([
      ['curated-only.test', ['curated']],
      ['new-burner.test', ['aggregate']],
      ['shared-burner.test', ['aggregate', 'curated']],
    ]);
    expect(await repo.disposableSources(['sub.shared-burner.test', 'shared-burner.test'])).toEqual(
      expect.arrayContaining(['aggregate', 'curated'])
    );
    expect(await repo.disposableSources(['unlisted.test'])).toEqual([]);
  });

  it('writes every entry of a source larger than one bulk batch', async () => {
    const domains = Array.from({ length: 5001 }, (_, i) => `burner${i}.test`);
    await repo.replaceDisposableSource('aggregate', domains, new Date(1000));
    expect(await DisposableDomainModel.countDocuments({ sources: 'aggregate' })).toBe(5001);
  });

  it('records source success and keeps the last good count on failure', async () => {
    await repo.recordDisposableSource('fakefilter', { count: 42, at: new Date(1000) });
    await repo.recordDisposableSource('fakefilter', { error: 'HTTP 503', at: new Date(2000) });
    const [status] = await repo.getDisposableSourceStatus();
    expect(status).toMatchObject({ source: 'fakefilter', count: 42, lastError: 'HTTP 503' });
    await repo.recordDisposableSource('fakefilter', { count: 43, at: new Date(3000) });
    expect((await repo.getDisposableSourceStatus())[0]).not.toHaveProperty('lastError');
  });

  it('ignores an expired intel entry before the TTL sweep removes it', async () => {
    const intel = {
      domain: 'young-burner.test',
      mxHosts: [],
      mxFlags: ['no-mx'],
      failed: [],
      checkedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    };
    await repo.saveDomainIntel(intel);
    expect(await repo.findDomainIntel(intel.domain)).toMatchObject({ mxFlags: ['no-mx'] });
    await repo.saveDomainIntel({ ...intel, expiresAt: new Date(Date.now() - 1000) });
    expect(await repo.findDomainIntel(intel.domain)).toBeNull();
  });
});
