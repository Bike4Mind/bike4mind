import { describe, expect, it, vi } from 'vitest';
import { DATA_LAKES, MAX_TAG_PREFIX_LENGTH } from '@bike4mind/common';
import {
  collidesWithRegistryPrefix,
  findCollidingPrefixLakes,
  previewDataLakeTagPrefix,
  warnOnPrefixCollision,
  withTagPrefixSuffix,
} from './tagPrefixCollision';

const lakeRow = (over: Partial<{ id: string; name: string; fileTagPrefix: string }> = {}) => ({
  id: 'other',
  name: 'Other Lake',
  fileTagPrefix: 'acme:',
  ...over,
});

const repo = (rows: unknown[] = []) => ({ find: vi.fn().mockResolvedValue(rows) });

describe('findCollidingPrefixLakes', () => {
  describe('the scope it queries', () => {
    it('asks for same-creator OR same-org, never a global claim', async () => {
      const dataLakes = repo();

      await findCollidingPrefixLakes({ dataLakes }, 'acme:', {
        createdByUserId: 'creator-1',
        organizationId: 'org-1',
      });

      // Asserting the filter, not just the outcome: with a mocked `find` an outcome-only test
      // passes even if the creator arm or the org arm is dropped entirely.
      expect(dataLakes.find).toHaveBeenCalledWith({
        $or: [{ createdByUserId: 'creator-1' }, { organizationId: 'org-1' }],
      });
    });

    it('narrows to the creator alone for an org-less lake', async () => {
      const dataLakes = repo();

      await findCollidingPrefixLakes({ dataLakes }, 'acme:', { createdByUserId: 'creator-1' });

      // No org-less arm on purpose: two unrelated personal `docs:` lakes cannot reach each
      // other's files, so claiming the prefix across them would just block the second user.
      expect(dataLakes.find).toHaveBeenCalledWith({ $or: [{ createdByUserId: 'creator-1' }] });
    });

    it('does not query at all for an unusable prefix', async () => {
      const dataLakes = repo([lakeRow()]);

      expect(await findCollidingPrefixLakes({ dataLakes }, '  ', { createdByUserId: 'c' })).toEqual([]);
      expect(await findCollidingPrefixLakes({ dataLakes }, 'acme', { createdByUserId: 'c' })).toEqual([]);
      expect(dataLakes.find).not.toHaveBeenCalled();
    });
  });

  describe('which prefixes overlap', () => {
    it.each([
      ['identical', 'acme:', 'acme:'],
      ['padded', '  acme:  ', 'acme:'],
      ['candidate nested under an existing lake', 'docs:legal:', 'docs:'],
      ['existing lake nested under the candidate', 'docs:', 'docs:legal:'],
    ])('flags a %s prefix', async (_label, wanted, existing) => {
      const dataLakes = repo([lakeRow({ fileTagPrefix: existing })]);

      const clashes = await findCollidingPrefixLakes({ dataLakes }, wanted, { createdByUserId: 'c' });

      expect(clashes).toHaveLength(1);
    });

    it.each([
      ['a merely similar prefix', 'acme-docs:', 'acme:x:'],
      ['a different prefix', 'globex:', 'acme:'],
      ['a prefix differing only in case', 'ACME:', 'acme:'],
    ])('allows %s', async (_label, wanted, existing) => {
      const dataLakes = repo([lakeRow({ fileTagPrefix: existing })]);

      expect(await findCollidingPrefixLakes({ dataLakes }, wanted, { createdByUserId: 'c' })).toEqual([]);
    });

    it('ignores a row whose own prefix is unusable', async () => {
      const dataLakes = repo([lakeRow({ fileTagPrefix: '' }), lakeRow({ fileTagPrefix: 'nope' })]);

      expect(await findCollidingPrefixLakes({ dataLakes }, 'acme:', { createdByUserId: 'c' })).toEqual([]);
    });

    it('never reports the lake being checked against itself', async () => {
      const dataLakes = repo([lakeRow({ id: 'self' })]);

      const clashes = await findCollidingPrefixLakes({ dataLakes }, 'acme:', {
        createdByUserId: 'c',
        excludeLakeId: 'self',
      });

      expect(clashes).toEqual([]);
    });
  });
});

describe('collidesWithRegistryPrefix', () => {
  it('rejects a built-in registry lake prefix', () => {
    // The registry's prefix arm is an ownership bypass and its lakes have no Mongo rows, so the
    // scoped query can never see them.
    const registryPrefix = DATA_LAKES[0]?.fileTagPrefix;
    expect(registryPrefix).toBeTruthy();
    expect(collidesWithRegistryPrefix(registryPrefix)).toBe(true);
    // Upper-cased is a genuinely different prefix: the registry's arm is an unflagged ^regex.
    expect(collidesWithRegistryPrefix(registryPrefix?.toUpperCase())).toBe(false);
  });

  it('allows an unrelated prefix', () => {
    expect(collidesWithRegistryPrefix('totally-unrelated-prefix:')).toBe(false);
  });

  it('is false for an unusable prefix rather than throwing', () => {
    expect(collidesWithRegistryPrefix('')).toBe(false);
    expect(collidesWithRegistryPrefix(null)).toBe(false);
  });
});

describe('warnOnPrefixCollision', () => {
  const lake = {
    id: 'lake1',
    name: 'Acme Docs',
    fileTagPrefix: 'acme:',
    createdByUserId: 'creator-1',
    organizationId: undefined,
  };

  it('names both lakes when a teardown will reach shared prefix-tagged files', async () => {
    const logger = { warn: vi.fn() };

    await warnOnPrefixCollision({ dataLakes: repo([lakeRow({ id: 'lake2', name: 'Acme Archive' })]) }, lake, logger);

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0][0]).toContain('Acme Docs');
    expect(logger.warn.mock.calls[0][0]).toContain('Acme Archive');
  });

  it('stays silent for a lake with no overlap', async () => {
    const logger = { warn: vi.fn() };

    await warnOnPrefixCollision(
      { dataLakes: repo([lakeRow({ id: 'lake2', fileTagPrefix: 'globex:' })]) },
      lake,
      logger
    );

    // The normal case must log nothing, or the warning stops meaning anything.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('swallows a lookup failure so a teardown is never blocked', async () => {
    const logger = { warn: vi.fn() };
    const dataLakes = { find: vi.fn().mockRejectedValue(new Error('mongo down')) };

    await expect(warnOnPrefixCollision({ dataLakes }, lake, logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});

describe('withTagPrefixSuffix', () => {
  it('keeps the base on attempt 0 and numbers later attempts from -1', () => {
    expect(withTagPrefixSuffix('acme:', 0)).toBe('acme:');
    expect(withTagPrefixSuffix('acme:', 1)).toBe('acme-1:');
    expect(withTagPrefixSuffix('docs:legal:', 1)).toBe('docs:legal-1:');
  });

  it('keeps fitting once the suffix reaches two digits, trimming a trailing hyphen', () => {
    const base = `${'a'.repeat(MAX_TAG_PREFIX_LENGTH - 4)}-bc:`;

    for (const attempt of [1, 12]) {
      const candidate = withTagPrefixSuffix(base, attempt);
      expect(candidate.length).toBeLessThanOrEqual(MAX_TAG_PREFIX_LENGTH);
      expect(candidate).toMatch(new RegExp(`[^-]-${attempt}:$`));
    }
  });
});

describe('previewDataLakeTagPrefix', () => {
  const scope = { createdByUserId: 'creator-1', organizationId: 'org-1' };

  it('returns a free base as-is', async () => {
    expect(await previewDataLakeTagPrefix({ dataLakes: repo() }, 'acme:', scope)).toBe('acme:');
  });

  it('skips a prefix held by a deleted lake, querying the scope once', async () => {
    const dataLakes = repo([{ ...lakeRow(), status: 'deleted' }]);

    expect(await previewDataLakeTagPrefix({ dataLakes }, 'acme:', scope)).toBe('acme-1:');
    expect(dataLakes.find).toHaveBeenCalledOnce();
    expect(dataLakes.find).toHaveBeenCalledWith({
      $or: [{ createdByUserId: 'creator-1' }, { organizationId: 'org-1' }],
    });
  });

  it('walks past every held candidate, including nested overlaps', async () => {
    const dataLakes = repo([lakeRow(), lakeRow({ fileTagPrefix: 'acme-1:sub:' })]);

    expect(await previewDataLakeTagPrefix({ dataLakes }, 'acme:', scope)).toBe('acme-2:');
  });

  it('skips a candidate that overlaps a built-in registry lake', async () => {
    const registryPrefix = DATA_LAKES.find(lake => lake.fileTagPrefix)?.fileTagPrefix;
    if (!registryPrefix) return;

    const picked = await previewDataLakeTagPrefix({ dataLakes: repo() }, registryPrefix, scope);

    expect(picked).not.toBe(registryPrefix);
    expect(collidesWithRegistryPrefix(picked)).toBe(false);
  });

  it('returns the base when every candidate is held, so create reports the collision', async () => {
    const dataLakes = repo(
      Array.from({ length: 50 }, (_, i) => lakeRow({ fileTagPrefix: withTagPrefixSuffix('acme:', i) }))
    );

    expect(await previewDataLakeTagPrefix({ dataLakes }, 'acme:', scope)).toBe('acme:');
  });
});
