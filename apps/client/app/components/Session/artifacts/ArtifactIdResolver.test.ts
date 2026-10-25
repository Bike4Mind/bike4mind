// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { getCachedArtifactId, getProvisionalArtifactId, useArtifactIdResolver } from './ArtifactIdResolver';
import { getArtifactTimestamp } from '@client/app/utils/artifactParser';
import { findExistingArtifactId } from '@client/app/utils/artifactPersistence';

vi.mock('@client/app/utils/artifactPersistence', () => ({
  findExistingArtifactId: vi.fn(),
}));
const lookup = vi.mocked(findExistingArtifactId);

type CacheWindow = {
  __artifactIdCache?: Map<string, string>;
  __artifactIdLookups?: Map<string, Promise<string | null>>;
  __provisionalArtifactIds?: Map<string, string>;
};

const resolver = () => renderHook(() => useArtifactIdResolver()).result.current.resolveArtifactId;

describe('useArtifactIdResolver', () => {
  beforeEach(() => {
    const caches = window as unknown as CacheWindow;
    caches.__artifactIdCache = new Map();
    caches.__artifactIdLookups = new Map();
    caches.__provisionalArtifactIds = new Map();
    lookup.mockReset();
  });

  it('caches a row the database returned, for every later card of that identifier', async () => {
    lookup.mockResolvedValue('artifact_react_App_1_0');
    const resolve = resolver();

    expect(await resolve('react', 'App', '', 'q-a', 3, 's1')).toBe('artifact_react_App_1_0');
    expect(getCachedArtifactId('react', 'App', 's1')).toBe('artifact_react_App_1_0');
    expect(await resolve('react', 'App', '', 'q-b', 0, 's1')).toBe('artifact_react_App_1_0');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps a minted fallback provisional, and looks again on the next resolve', async () => {
    lookup.mockResolvedValueOnce(null).mockResolvedValueOnce('artifact_react_Stopwatch_9_1');
    const resolve = resolver();
    const minted = `artifact_react_Stopwatch_${getArtifactTimestamp('q-c')}_0`;

    expect(await resolve('react', 'Stopwatch', '', 'q-c', 0, 's1')).toBe(minted);
    expect(getCachedArtifactId('react', 'Stopwatch', 's1')).toBeNull();
    expect(getProvisionalArtifactId('react', 'Stopwatch', 's1', 'q-c', 0)).toBe(minted);
    expect(getProvisionalArtifactId('react', 'Stopwatch', 's1', 'q-c', 1)).toBeNull();

    expect(await resolve('react', 'Stopwatch', '', 'q-c', 0, 's1')).toBe('artifact_react_Stopwatch_9_1');
  });

  it('shares one in-flight lookup, but each card mints from its own index', async () => {
    let finish: (id: string | null) => void = () => {};
    lookup.mockReturnValue(new Promise(resolve => (finish = resolve)));
    const resolve = resolver();
    const timestamp = getArtifactTimestamp('q-d');

    const first = resolve('react', 'Timer', '', 'q-d', 0, 's1');
    const second = resolve('react', 'Timer', '', 'q-d', 1, 's1');
    finish(null);

    expect(await first).toBe(`artifact_react_Timer_${timestamp}_0`);
    expect(await second).toBe(`artifact_react_Timer_${timestamp}_1`);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('treats a failed lookup as no row, without caching anything', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    lookup.mockRejectedValue(new Error('offline'));
    const resolve = resolver();

    expect(await resolve('html', 'page', '', 'q-e', 2, 's1')).toBe(
      `artifact_html_page_${getArtifactTimestamp('q-e')}_2`
    );
    expect(getCachedArtifactId('html', 'page', 's1')).toBeNull();
  });
});
