import { beforeEach, describe, expect, it } from 'vitest';
import { AxiosError, type AxiosAdapter } from 'axios';
import { api } from './apiClient';
import { DEPLOY_REVISION_HEADER } from '@server/middlewares/deployRevision';
import { resetDeployedRevisionBaseline } from '../utils/deployRevision';
import { useClientOutdatedStore } from '../stores/useClientOutdatedStore';

const adapterWith =
  (revision: string | undefined, status = 200, extraHeaders: Record<string, string> = {}): AxiosAdapter =>
  async config => {
    // Built from the server's constant so a rename on either side breaks this suite.
    const headers: Record<string, string> = {
      ...(revision ? { [DEPLOY_REVISION_HEADER.toLowerCase()]: revision } : {}),
      ...extraHeaders,
    };
    const response = { data: {}, status, statusText: '', headers, config };
    if (status >= 400) throw new AxiosError('request failed', String(status), config, undefined, response);
    return response;
  };

const requestWith = (adapter: AxiosAdapter) => api.get('/api/probe', { adapter });

const isOutdated = () => useClientOutdatedStore.getState().outdated;

describe('api deploy-revision interceptor', () => {
  beforeEach(() => {
    resetDeployedRevisionBaseline();
    useClientOutdatedStore.setState({ outdated: false });
  });

  it('takes the first response as the page-load baseline', async () => {
    await requestWith(adapterWith('rev-a'));
    expect(isOutdated()).toBe(false);
  });

  it('marks the client outdated when a later response names another revision', async () => {
    await requestWith(adapterWith('rev-a'));
    await requestWith(adapterWith('rev-b'));
    expect(isOutdated()).toBe(true);
  });

  it('does not mark the client outdated while the revision is unchanged', async () => {
    await requestWith(adapterWith('rev-a'));
    await requestWith(adapterWith('rev-a'));
    expect(isOutdated()).toBe(false);
  });

  it('ignores responses with no revision header', async () => {
    await requestWith(adapterWith('rev-a'));
    await requestWith(adapterWith(undefined));
    expect(isOutdated()).toBe(false);
  });

  it('reads the revision from a rejected response too', async () => {
    await requestWith(adapterWith('rev-a'));
    await expect(requestWith(adapterWith('rev-b', 500))).rejects.toBeInstanceOf(AxiosError);
    expect(isOutdated()).toBe(true);
  });

  it('does not mark on a repeated revision in a rejected response', async () => {
    await requestWith(adapterWith('rev-a'));
    await expect(requestWith(adapterWith('rev-a', 500))).rejects.toBeInstanceOf(AxiosError);
    expect(isOutdated()).toBe(false);
  });

  it('stays outdated when a later response returns to the baseline revision', async () => {
    await requestWith(adapterWith('rev-a'));
    await requestWith(adapterWith('rev-b'));
    await requestWith(adapterWith('rev-a'));
    expect(isOutdated()).toBe(true);
  });

  const SHARED_CACHE = { 'cache-control': 'public, s-maxage=300, stale-while-revalidate=600' };

  it('does not mark outdated when a shared-cache response carries an older revision', async () => {
    await requestWith(adapterWith('rev-c'));
    await requestWith(adapterWith('rev-b', 200, SHARED_CACHE));
    expect(isOutdated()).toBe(false);
  });

  it('does not let a shared-cache response become the baseline', async () => {
    await requestWith(adapterWith('rev-b', 200, SHARED_CACHE));
    await requestWith(adapterWith('rev-c'));
    expect(isOutdated()).toBe(false);
  });

  it('ignores a browser-private-cache response with an older revision', async () => {
    const PRIVATE_CACHE = { 'cache-control': 'private, max-age=3600' };
    await requestWith(adapterWith('rev-b', 200, PRIVATE_CACHE));
    await requestWith(adapterWith('rev-c'));
    expect(isOutdated()).toBe(false);
    await requestWith(adapterWith('rev-b', 200, PRIVATE_CACHE));
    expect(isOutdated()).toBe(false);
  });

  it('still marks outdated on a genuine uncached a -> b sequence', async () => {
    await requestWith(adapterWith('rev-a', 200, { 'cache-control': 'no-store' }));
    await requestWith(adapterWith('rev-b', 200, { 'cache-control': 'no-store' }));
    expect(isOutdated()).toBe(true);
  });

  it.each([
    'private, max-age="3600"',
    'public, s-maxage="300"',
    'private, max-age = 3600',
    'private, max-age=03600',
    'PUBLIC, S-MAXAGE=300',
    'max-age=0, stale-while-revalidate=600',
    'max-age=0, stale-if-error="600"',
  ])('ignores replayable revisions for %s in both baseline and comparison', async cacheControl => {
    const cachedHeaders = { 'cache-control': cacheControl };
    await requestWith(adapterWith('cached-rev', 200, cachedHeaders));
    await requestWith(adapterWith('live-rev'));
    expect(isOutdated()).toBe(false);

    await requestWith(adapterWith('cached-rev', 200, cachedHeaders));
    expect(isOutdated()).toBe(false);

    await expect(requestWith(adapterWith('cached-rev', 500, cachedHeaders))).rejects.toBeInstanceOf(AxiosError);
    expect(isOutdated()).toBe(false);
  });

  it.each([
    'max-age=0',
    's-maxage="000"',
    'max-age=0, stale-while-revalidate=0',
    'x-max-age=300',
    'max-age=invalid',
    'no-store, max-age=3600',
    'max-age=3600, NO-STORE',
  ])('still observes live revisions for %s', async cacheControl => {
    await requestWith(adapterWith('rev-a', 200, { 'cache-control': cacheControl }));
    await requestWith(adapterWith('rev-b', 200, { 'cache-control': cacheControl }));
    expect(isOutdated()).toBe(true);
  });
});
