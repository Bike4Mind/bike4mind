import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  CALLABLE_FUNCTION_CALLS_REFRESH_MS,
  callableFunctionBreakingChanges,
  callableFunctionContractUnreadable,
  callableFunctionErrorCode,
  callableFunctionErrorMessage,
  callableFunctionErrorProblems,
  callableFunctionSlugHolder,
  fetchCallableFunctionSources,
  useArtifactCallableFunction,
  useCallableFunctionCalls,
  useCallableFunctionsEnabled,
  usePromoteCallableFunction,
  useRunCallableFunctionTests,
  useCreateCallableFunction,
  useCallableFunctionShare,
  useDeleteCallableFunction,
  useRepinCallableFunction,
  useSetCallableFunctionEnabled,
  useSharedCallableFunctions,
  useShareCallableFunction,
  useStopSharingCallableFunction,
  fetchCallableFunctionDataFiles,
  resetCallableFunctionDataCache,
} from './callableFunctions';
import { CALLABLE_FUNCTIONS_LIST_QUERY_KEY, CALLABLE_FUNCTIONS_STATUS_QUERY_KEY } from './queryKeys';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  accessToken: 'token' as string | null,
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: h.get, post: h.post, patch: h.patch, put: h.put, delete: h.delete },
}));
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: (select: (s: { accessToken: string | null }) => unknown) => select({ accessToken: h.accessToken }),
}));

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

const renderWith = <T,>(hook: () => T, client = newClient()) => {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, ...renderHook(hook, { wrapper }) };
};

const renderEnabled = () => renderWith(() => useCallableFunctionsEnabled());

const axiosError = (status: number, data: unknown) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data },
  });

const CONTRACT = {
  name: 'double_it',
  description: 'Doubles a length.',
  inputs: { type: 'object', additionalProperties: false, properties: {} },
  outputs: { type: 'object', additionalProperties: false, properties: {} },
} as never;

const saved = { id: 'fn-1', slug: 'double_it', pin: { version: 2 } };

describe('useCallableFunctionsEnabled', () => {
  beforeEach(() => {
    h.get.mockReset();
    h.accessToken = 'token';
  });

  it('is false while the status loads, then follows the route', async () => {
    let answer: (response: unknown) => void = () => {};
    h.get.mockReturnValue(new Promise(resolve => (answer = resolve)));
    const { result } = renderEnabled();

    await waitFor(() => expect(h.get).toHaveBeenCalledWith('/api/callable-functions/status'));
    expect(result.current).toBe(false);

    answer({ data: { enabled: true } });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('is false when the status request fails', async () => {
    h.get.mockRejectedValue(new Error('Request failed with status code 404'));
    const { client, result } = renderEnabled();

    await waitFor(() => expect(client.getQueryState(CALLABLE_FUNCTIONS_STATUS_QUERY_KEY)?.status).toBe('error'));
    expect(result.current).toBe(false);
  });

  it('is false without a session and does not ask', () => {
    h.accessToken = null;
    const { result } = renderEnabled();

    expect(result.current).toBe(false);
    expect(h.get).not.toHaveBeenCalled();
  });
});

describe('useArtifactCallableFunction', () => {
  beforeEach(() => {
    h.get.mockReset();
    h.accessToken = 'token';
  });

  it('reads the list filtered by the artifact, under a key that carries the artifact id and version', async () => {
    h.get.mockResolvedValue({ data: [saved] });
    const { client, result } = renderWith(() => useArtifactCallableFunction('artifact-1', 2, 'double_it'));

    await waitFor(() => expect(result.current.data).toEqual({ saved, others: [] }));
    expect(h.get).toHaveBeenCalledWith('/api/callable-functions', { params: { artifactId: 'artifact-1' } });
    expect(client.getQueryData([...CALLABLE_FUNCTIONS_LIST_QUERY_KEY, 'artifact-1', 2])).toEqual([saved]);
  });

  it('picks the tool named in the code and returns the other tools in order', async () => {
    const renamed = { id: 'fn-2', slug: 'double_it_v2', pin: { version: 4 } };
    const third = { id: 'fn-3', slug: 'double_it_v3', pin: { version: 5 } };
    h.get.mockResolvedValue({ data: [saved, renamed, third] });
    const { result } = renderWith(() => useArtifactCallableFunction('artifact-1', 5, 'double_it_v2'));

    await waitFor(() => expect(result.current.data).toEqual({ saved: renamed, others: [saved, third] }));
  });

  it('has no saved tool, and the rest as others, when none has the name in the code', async () => {
    h.get.mockResolvedValue({ data: [saved] });
    const { result } = renderWith(() => useArtifactCallableFunction('artifact-1', 1, 'triple_it'));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ saved: null, others: [saved] });
  });

  it('does not ask without an artifact id or a session', () => {
    renderWith(() => useArtifactCallableFunction(null, 1, 'double_it'));
    h.accessToken = null;
    renderWith(() => useArtifactCallableFunction('artifact-1', 1, 'double_it'));

    expect(h.get).not.toHaveBeenCalled();
  });
});

describe('callable function mutations', () => {
  beforeEach(() => {
    h.post.mockReset();
    h.patch.mockReset();
    h.delete.mockReset();
  });

  const listInvalidations = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.filter(([filters]) => {
      const key = (filters as { queryKey?: unknown } | undefined)?.queryKey;
      return JSON.stringify(key) === JSON.stringify(CALLABLE_FUNCTIONS_LIST_QUERY_KEY);
    }).length;

  it('create posts only the artifact id, the expected version, and the contract, then re-reads the list', async () => {
    h.post.mockResolvedValue({ data: saved });
    const client = newClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderWith(() => useCreateCallableFunction(), client);

    const input = { artifactId: 'artifact-1', expectedVersion: 2, contract: CONTRACT, slug: 'other' };
    await act(() => result.current.mutateAsync(input));

    expect(h.post).toHaveBeenCalledWith('/api/callable-functions', {
      artifactId: 'artifact-1',
      expectedVersion: 2,
      contract: CONTRACT,
    });
    expect(listInvalidations(invalidate)).toBe(1);
  });

  it('a refused create re-reads the list too', async () => {
    h.post.mockRejectedValue(axiosError(409, { error: 'You can have at most 100 saved tools.' }));
    const client = newClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderWith(() => useCreateCallableFunction(), client);

    await act(async () => {
      await result.current
        .mutateAsync({ artifactId: 'artifact-1', expectedVersion: 2, contract: CONTRACT })
        .catch(() => {});
    });

    expect(listInvalidations(invalidate)).toBe(1);
  });

  it('repin posts the expected version and the contract to the pin route', async () => {
    h.post.mockResolvedValue({ data: saved });
    const client = newClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderWith(() => useRepinCallableFunction(), client);

    await act(() => result.current.mutateAsync({ id: 'fn/1', expectedVersion: 3, contract: CONTRACT }));

    expect(h.post).toHaveBeenCalledWith('/api/callable-functions/fn%2F1/pin', {
      expectedVersion: 3,
      contract: CONTRACT,
    });
    expect(listInvalidations(invalidate)).toBe(1);
  });

  it('turning a function off patches only enabled', async () => {
    h.patch.mockResolvedValue({ data: saved });
    const client = newClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderWith(() => useSetCallableFunctionEnabled(), client);

    await act(() => result.current.mutateAsync({ id: 'fn-1', enabled: false }));

    expect(h.patch).toHaveBeenCalledWith('/api/callable-functions/fn-1', { enabled: false });
    expect(listInvalidations(invalidate)).toBe(1);
  });

  it('delete removes the function and re-reads the list', async () => {
    h.delete.mockResolvedValue({ status: 204 });
    const client = newClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderWith(() => useDeleteCallableFunction(), client);

    await act(() => result.current.mutateAsync('fn-1'));

    expect(h.delete).toHaveBeenCalledWith('/api/callable-functions/fn-1');
    expect(listInvalidations(invalidate)).toBe(1);
  });
});

describe('the calls panel query', () => {
  let served = 0;
  beforeEach(() => {
    served = 0;
    h.get.mockReset();
    h.post.mockReset();
    h.get.mockImplementation(async (url: string) => {
      if (url !== '/api/callable-functions/fn-1/calls') throw new Error(`unexpected ${url}`);
      served += 1;
      return { data: { since: new Date(), total: served, outcomes: { ok: served }, recent: [] } };
    });
    h.post.mockResolvedValue({ data: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['a server test run', () => useRunCallableFunctionTests(), { id: 'fn-1' }],
    ['a promotion', () => usePromoteCallableFunction(), 'fn-1'],
  ] as const)('reads the calls again after %s, with no reload', async (_name, useAction, variables) => {
    const { result } = renderWith(() => ({ calls: useCallableFunctionCalls('fn-1'), action: useAction() }));
    await waitFor(() => expect(result.current.calls.data?.total).toBe(1));

    await act(() => (result.current.action.mutateAsync as (v: unknown) => Promise<unknown>)(variables));

    await waitFor(() => expect(result.current.calls.data?.total).toBe(2));
  });

  it('reads the calls again on its own while shown, so calls made elsewhere appear', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result, unmount } = renderWith(() => useCallableFunctionCalls('fn-1'));
    await waitFor(() => expect(result.current.data?.total).toBe(1));

    await act(() => vi.advanceTimersByTimeAsync(CALLABLE_FUNCTION_CALLS_REFRESH_MS));
    await waitFor(() => expect(result.current.data?.total).toBe(2));

    unmount();
    await act(() => vi.advanceTimersByTimeAsync(CALLABLE_FUNCTION_CALLS_REFRESH_MS * 2));
    expect(served).toBe(2);
  });
});

describe('callable function sharing hooks', () => {
  beforeEach(() => {
    h.get.mockReset();
    h.put.mockReset();
    h.delete.mockReset();
    h.accessToken = 'token';
  });

  it('reads the share from the grants route, and drops it when nothing watches it', async () => {
    h.get.mockResolvedValue({ data: { grants: null, people: [] } });
    const { result, client, unmount } = renderWith(() => useCallableFunctionShare('fn/1'));
    await waitFor(() => expect(result.current.data).toEqual({ grants: null, people: [] }));
    expect(h.get).toHaveBeenCalledWith('/api/callable-functions/fn%2F1/grants');

    unmount();
    await waitFor(() => expect(client.getQueryCache().findAll()).toHaveLength(0));
  });

  it('share puts the grants without the id, then re-reads the list', async () => {
    h.put.mockResolvedValue({ data: saved });
    const client = newClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderWith(() => useShareCallableFunction(), client);

    await act(() => result.current.mutateAsync({ id: 'fn/1', visibility: 'private', userIds: ['person-1'] }));

    expect(h.put).toHaveBeenCalledWith('/api/callable-functions/fn%2F1/grants', {
      visibility: 'private',
      userIds: ['person-1'],
    });
    expect(invalidate).toHaveBeenCalled();
  });

  it('stop sharing deletes the grants, then re-reads the list', async () => {
    h.delete.mockResolvedValue({ data: saved });
    const client = newClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderWith(() => useStopSharingCallableFunction(), client);

    await act(() => result.current.mutateAsync('fn/1'));

    expect(h.delete).toHaveBeenCalledWith('/api/callable-functions/fn%2F1/grants');
    expect(invalidate).toHaveBeenCalled();
  });

  it('drops the cached share once a save or stop lands, so a reopened dialog reads it fresh', async () => {
    h.put.mockResolvedValue({ data: saved });
    h.delete.mockResolvedValue({ data: saved });
    const client = newClient();
    const key = [...CALLABLE_FUNCTIONS_LIST_QUERY_KEY, 'fn-1', 'grants'];
    const share = renderWith(() => useShareCallableFunction(), client);
    const stop = renderWith(() => useStopSharingCallableFunction(), client);

    client.setQueryData(key, { grants: { visibility: 'private' }, people: [] });
    await act(() => share.result.current.mutateAsync({ id: 'fn-1', visibility: 'private', userIds: ['p'] }));
    expect(client.getQueryData(key)).toBeUndefined();

    client.setQueryData(key, { grants: { visibility: 'private' }, people: [] });
    await act(() => stop.result.current.mutateAsync('fn-1'));
    expect(client.getQueryData(key)).toBeUndefined();
  });

  it('lists what is shared with the caller, and does not ask without a session', async () => {
    h.get.mockResolvedValue({ data: [{ id: 'fn-1' }] });
    const { result } = renderWith(() => useSharedCallableFunctions());
    await waitFor(() => expect(result.current.data).toEqual([{ id: 'fn-1' }]));
    expect(h.get).toHaveBeenCalledWith('/api/callable-functions/shared');

    h.get.mockClear();
    h.accessToken = null;
    renderWith(() => useSharedCallableFunctions());
    expect(h.get).not.toHaveBeenCalled();
  });
});

describe('callable function error helpers', () => {
  it('reads the code, the message, and the problems of an invalid_contract answer', () => {
    const error = axiosError(400, {
      error: 'The function contract has problems.',
      code: 'invalid_contract',
      problems: [{ path: 'inputs.properties.span.unit', message: 'a number field needs a unit' }, { path: 3 }],
      request_id: 'req-1',
    });

    expect(callableFunctionErrorCode(error)).toBe('invalid_contract');
    expect(callableFunctionErrorMessage(error, 'fallback')).toBe('The function contract has problems.');
    expect(callableFunctionErrorProblems(error)).toEqual([
      { path: 'inputs.properties.span.unit', message: 'a number field needs a unit' },
    ]);
  });

  it('reads the first issue of an invalid_body answer', () => {
    const error = axiosError(400, {
      error: 'Invalid request body',
      code: 'invalid_body',
      issues: [{ path: '', message: 'Unrecognized key: "codeHash"' }],
    });

    expect(callableFunctionErrorMessage(error, 'fallback')).toBe('Unrecognized key: "codeHash"');
    expect(callableFunctionErrorProblems(error)).toEqual([]);
  });

  it('falls back for an error that carries no answer', () => {
    const error = new Error('Network Error');

    expect(callableFunctionErrorMessage(error, 'Could not save the tool.')).toBe('Could not save the tool.');
    expect(callableFunctionErrorCode(error)).toBeUndefined();
    expect(callableFunctionErrorProblems(error)).toEqual([]);
    expect(callableFunctionSlugHolder(error)).toBeNull();
  });

  it('reads the tool a slug_taken answer names, and nothing from other answers', () => {
    const taken = (extra: Record<string, unknown>) =>
      axiosError(409, { error: 'You already have a tool named beam.', code: 'slug_taken', slug: 'beam', ...extra });

    expect(callableFunctionSlugHolder(taken({ functionId: 'fn-1', sourceDeleted: true }))).toEqual({
      functionId: 'fn-1',
      sourceDeleted: true,
    });
    expect(callableFunctionSlugHolder(taken({ functionId: 'fn-1', sourceDeleted: false }))).toEqual({
      functionId: 'fn-1',
      sourceDeleted: false,
    });
    expect(callableFunctionSlugHolder(taken({}))).toBeNull();
    expect(
      callableFunctionSlugHolder(axiosError(409, { code: 'name_changed', functionId: 'fn-1', sourceDeleted: true }))
    ).toBeNull();
  });

  it('reads the changes a breaking_change answer lists, and nothing from other answers', () => {
    const removed = { path: 'outputs.deflection', side: 'outputs', field: 'deflection', kind: 'removed' };
    const renamed = { path: 'name', side: null, field: '', kind: 'name_changed', before: 'a', after: 'b' };
    const refused = axiosError(409, {
      code: 'breaking_change',
      changes: [removed, renamed, { path: 'inputs.x', side: 'elsewhere', field: 'x', kind: 'removed' }, null],
    });

    expect(callableFunctionBreakingChanges(refused)).toEqual([removed, renamed]);
    expect(callableFunctionBreakingChanges(axiosError(409, { code: 'version_changed', changes: [removed] }))).toEqual(
      []
    );
    expect(callableFunctionBreakingChanges(new Error('Network Error'))).toEqual([]);
  });

  it('reads a contract_unreadable answer, and nothing from other answers', () => {
    expect(callableFunctionContractUnreadable(axiosError(409, { code: 'contract_unreadable' }))).toBe(true);
    expect(callableFunctionContractUnreadable(axiosError(409, { code: 'breaking_change', changes: [] }))).toBe(false);
    expect(callableFunctionContractUnreadable(new Error('Network Error'))).toBe(false);
  });
});

describe('fetchCallableFunctionDataFiles', () => {
  const bytesOf = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
  const sha256Of = async (buffer: ArrayBuffer) =>
    [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', buffer))]
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('');
  const pinOf = async (name: string, text: string) => ({
    name,
    sha256: await sha256Of(bytesOf(text)),
    bytes: text.length,
  });
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetCallableFunctionDataCache();
    h.get.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads each file from its signed link, checks its hash, and URL-encodes the name in the link request', async () => {
    const pin = await pinOf('a b#1.csv', 'x,y\n1,2\n');
    h.get.mockResolvedValue({ data: { url: 'https://data.example.com/signed' } });
    fetchMock.mockResolvedValue(new Response(bytesOf('x,y\n1,2\n')));

    const files = await fetchCallableFunctionDataFiles('fn/1', [pin]);

    expect(h.get).toHaveBeenCalledWith('/api/callable-functions/fn%2F1/data/a%20b%231.csv');
    expect(fetchMock).toHaveBeenCalledWith('https://data.example.com/signed', {
      credentials: 'omit',
      cache: 'no-store',
    });
    expect(new TextDecoder().decode(files[0]!.bytes)).toBe('x,y\n1,2\n');
    expect(files[0]!.name).toBe('a b#1.csv');
  });

  it('refuses bytes that do not match the pinned hash, and does not cache them', async () => {
    const pin = await pinOf('points.csv', 'x,y\n1,2\n');
    h.get.mockResolvedValue({ data: { url: 'https://data.example.com/signed' } });
    fetchMock.mockImplementation(async () => new Response(bytesOf('x,y\n9,9\n')));

    await expect(fetchCallableFunctionDataFiles('fn1', [pin])).rejects.toThrow(
      'The data file points.csv does not match its pinned hash.'
    );
    await expect(fetchCallableFunctionDataFiles('fn1', [pin])).rejects.toThrow('does not match');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fetches nothing on a repeat run and hands back fresh copies each time', async () => {
    const pin = await pinOf('points.csv', 'x,y\n1,2\n');
    h.get.mockResolvedValue({ data: { url: 'https://data.example.com/signed' } });
    fetchMock.mockImplementation(async () => new Response(bytesOf('x,y\n1,2\n')));

    const first = await fetchCallableFunctionDataFiles('fn1', [pin]);
    const second = await fetchCallableFunctionDataFiles('fn1', [{ ...pin, name: 'renamed.csv' }]);

    expect(h.get).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second[0]!.bytes).not.toBe(first[0]!.bytes);
    expect(second[0]!.name).toBe('renamed.csv');
  });

  it('reads through the app with credentials when the link is same-origin', async () => {
    const pin = await pinOf('points.csv', 'x,y\n1,2\n');
    h.get
      .mockResolvedValueOnce({ data: { url: '/api/callable-functions/fn1/data/points.csv?bytes=1' } })
      .mockResolvedValueOnce({ data: bytesOf('x,y\n1,2\n') });

    await fetchCallableFunctionDataFiles('fn1', [pin]);

    expect(h.get).toHaveBeenLastCalledWith('/api/callable-functions/fn1/data/points.csv?bytes=1', {
      responseType: 'arraybuffer',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a refused link read', async () => {
    const pin = await pinOf('points.csv', 'x,y\n1,2\n');
    h.get.mockResolvedValue({ data: { url: 'https://data.example.com/signed' } });
    fetchMock.mockResolvedValue(new Response('denied', { status: 403 }));
    await expect(fetchCallableFunctionDataFiles('fn1', [pin])).rejects.toThrow('could not be read (403)');
  });
});

describe('fetchCallableFunctionSources', () => {
  const bytesOf = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
  const sha256 = async (text: string) =>
    Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytesOf(text))))
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('');
  const sources = [
    { name: 'rates.csv', url: 'https://data.example.com/rates.csv', mode: 'live' as const },
    { name: 'base.csv', url: 'https://data.example.com/base.csv', mode: 'pinned' as const },
  ];

  const fetchMock = vi.fn();

  beforeEach(() => {
    resetCallableFunctionDataCache();
    h.get.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stamps each source in the shape a server call writes and reads its bytes from the signed link', async () => {
    const live = await sha256('x,y\n1,2\n');
    const pinned = await sha256('x,y\n0,0\n');
    const liveEntry = {
      name: 'rates.csv',
      mode: 'live',
      sha256: live,
      bytes: 8,
      fetched_at: '2026-11-24T00:00:00.000Z',
    };
    const pinnedEntry = { name: 'base.csv', mode: 'pinned', sha256: pinned, bytes: 8 };
    h.get.mockImplementation(async (url: string) => ({
      data: url.endsWith('/rates.csv')
        ? { entry: liveEntry, url: 'https://data.example.com/live-signed' }
        : { entry: pinnedEntry, url: 'https://data.example.com/pinned-signed' },
    }));
    fetchMock.mockImplementation(
      async (url: string) => new Response(bytesOf(url.endsWith('/live-signed') ? 'x,y\n1,2\n' : 'x,y\n0,0\n'))
    );

    const read = await fetchCallableFunctionSources('fn-1', sources);

    expect(h.get).toHaveBeenCalledWith('/api/callable-functions/fn-1/sources/rates.csv');
    expect(fetchMock).toHaveBeenCalledWith('https://data.example.com/live-signed', {
      credentials: 'omit',
      cache: 'no-store',
    });
    expect(read.map(entry => entry.entry)).toEqual([liveEntry, pinnedEntry]);
    expect(new TextDecoder().decode(read[0]!.bytes)).toBe('x,y\n1,2\n');
  });

  it('downloads bytes it already holds by hash only once, and hands back fresh copies', async () => {
    const live = await sha256('x,y\n1,2\n');
    h.get.mockResolvedValue({
      data: { entry: { name: 'rates.csv', mode: 'live', sha256: live, bytes: 8 }, url: 'https://data.example.com/s' },
    });
    fetchMock.mockImplementation(async () => new Response(bytesOf('x,y\n1,2\n')));

    const first = await fetchCallableFunctionSources('fn-1', sources.slice(0, 1));
    const second = await fetchCallableFunctionSources('fn-1', sources.slice(0, 1));

    expect(h.get).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second[0]!.bytes).not.toBe(first[0]!.bytes);
  });

  it('refuses bytes that do not match the hash they were read with', async () => {
    h.get.mockResolvedValue({
      data: {
        entry: { name: 'rates.csv', mode: 'live', sha256: '0'.repeat(64), bytes: 7 },
        url: 'https://data.example.com/s',
      },
    });
    fetchMock.mockImplementation(async () => new Response(bytesOf('changed')));
    await expect(fetchCallableFunctionSources('fn-1', sources.slice(0, 1))).rejects.toThrow(
      'The source rates.csv does not match the hash it was read with.'
    );
  });
});
