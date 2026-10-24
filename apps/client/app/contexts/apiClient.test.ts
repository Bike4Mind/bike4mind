import { beforeEach, describe, expect, it } from 'vitest';
import { AxiosError, type AxiosAdapter } from 'axios';
import { api } from './apiClient';
import { resetDeployedRevisionBaseline } from '../utils/deployRevision';
import { useClientOutdatedStore } from '../stores/useClientOutdatedStore';

const adapterWith =
  (revision: string | undefined, status = 200): AxiosAdapter =>
  async config => {
    const headers: Record<string, string> = revision ? { 'x-deployed-revision': revision } : {};
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
});
