import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  callableFunctionBreakingChanges,
  callableFunctionContractUnreadable,
  callableFunctionErrorCode,
  callableFunctionErrorMessage,
  callableFunctionErrorProblems,
  callableFunctionSlugHolder,
  useArtifactCallableFunction,
  useCallableFunctionsEnabled,
  useCreateCallableFunction,
  useDeleteCallableFunction,
  useRepinCallableFunction,
  useSetCallableFunctionEnabled,
} from './callableFunctions';
import { CALLABLE_FUNCTIONS_LIST_QUERY_KEY, CALLABLE_FUNCTIONS_STATUS_QUERY_KEY } from './queryKeys';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  accessToken: 'token' as string | null,
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: h.get, post: h.post, patch: h.patch, delete: h.delete },
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
