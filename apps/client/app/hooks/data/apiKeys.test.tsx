import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { SERVER_CONFIG_QUERY_KEY } from './queryKeys';
import { useAddNewApiKey, useDeleteApiKey, useSetActiveApiKey } from './apiKeys';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: vi.fn(), delete: vi.fn(), get: vi.fn() } }));

const post = vi.mocked(api.post);
const del = vi.mocked(api.delete);

const API_KEYS_QUERY_KEY = ['api-keys'] as const;

const setup = <T,>(useHook: () => T) => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(useHook, { wrapper });
  return { result, queryClient, invalidateSpy };
};

// Tool availability (serverConfig) is derived from the user's own keys, so every key mutation
// must refetch it alongside the key list.
const expectKeyDependentInvalidation = (invalidateSpy: ReturnType<typeof vi.spyOn>) => {
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: API_KEYS_QUERY_KEY });
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: SERVER_CONFIG_QUERY_KEY });
};

describe('api key mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refetches tool availability after adding a key', async () => {
    post.mockResolvedValue({ data: { id: 'k2' } });
    const onSuccess = vi.fn();
    const { result, invalidateSpy } = setup(() => useAddNewApiKey({ onSuccess }));

    // isActive matches what AddApiKeyModal sends: a freshly added personal key starts inactive.
    await result.current.mutateAsync({ apiKey: 'sk-test-key', type: 'elevenlabs', description: '', isActive: false });

    expectKeyDependentInvalidation(invalidateSpy);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('refetches tool availability after switching the active key', async () => {
    post.mockResolvedValue({ data: {} });
    const { result, invalidateSpy } = setup(() => useSetActiveApiKey('elevenlabs'));

    await result.current.mutateAsync('k1');

    expectKeyDependentInvalidation(invalidateSpy);
  });

  it('refetches tool availability after deleting a key', async () => {
    del.mockResolvedValue({ data: { id: 'k1' } });
    const onSuccess = vi.fn();
    const { result, queryClient, invalidateSpy } = setup(() => useDeleteApiKey({ onSuccess }));
    queryClient.setQueryData(API_KEYS_QUERY_KEY, [{ id: 'k1' }, { id: 'k2' }]);

    await result.current.mutateAsync('k1');

    expectKeyDependentInvalidation(invalidateSpy);
    // The optimistic filter drops the deleted key without waiting for the refetch.
    expect(queryClient.getQueryData(API_KEYS_QUERY_KEY)).toEqual([{ id: 'k2' }]);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  // A rejected mutation never committed the key, so there is nothing to refetch.
  it('does not refetch tool availability when adding a key fails', async () => {
    post.mockRejectedValue(new Error('nope'));
    const { result, invalidateSpy } = setup(() => useAddNewApiKey({}));

    await expect(
      result.current.mutateAsync({ apiKey: 'sk-test-key', type: 'elevenlabs', description: '', isActive: false })
    ).rejects.toThrow('nope');

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('does not refetch tool availability when switching the active key fails', async () => {
    post.mockRejectedValue(new Error('nope'));
    const { result, invalidateSpy } = setup(() => useSetActiveApiKey('elevenlabs'));

    await expect(result.current.mutateAsync('k1')).rejects.toThrow('nope');

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('does not refetch tool availability when deleting a key fails', async () => {
    del.mockRejectedValue(new Error('nope'));
    const { result, queryClient, invalidateSpy } = setup(() => useDeleteApiKey());
    queryClient.setQueryData(API_KEYS_QUERY_KEY, [{ id: 'k1' }]);

    await expect(result.current.mutateAsync('k1')).rejects.toThrow('nope');

    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(API_KEYS_QUERY_KEY)).toEqual([{ id: 'k1' }]);
  });
});
