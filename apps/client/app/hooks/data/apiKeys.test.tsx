import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import React from 'react';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useAddNewApiKey, useDeleteApiKey, useSetActiveApiKey } from './apiKeys';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: vi.fn(), delete: vi.fn(), get: vi.fn() } }));

const post = api.post as unknown as Mock;
const del = api.delete as unknown as Mock;

const setup = <T,>(useHook: () => T) => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  queryClient.setQueryData(['api-keys'], [{ id: 'k1' }]);
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(useHook, { wrapper });
  return { result, invalidateSpy };
};

// Tool availability (serverConfig) is derived from the user's own keys, so every key mutation
// must refetch it alongside the key list.
const expectKeyDependentInvalidation = (invalidateSpy: ReturnType<typeof vi.spyOn>) => {
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['api-keys'] });
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['server-config'] });
};

describe('api key mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refetches tool availability after adding a key', async () => {
    post.mockResolvedValue({ data: { id: 'k2' } });
    const { result, invalidateSpy } = setup(() => useAddNewApiKey({}));

    await result.current.mutateAsync({ apiKey: 'sk-test-key', type: 'elevenlabs', description: '', isActive: true });

    expectKeyDependentInvalidation(invalidateSpy);
  });

  it('refetches tool availability after switching the active key', async () => {
    post.mockResolvedValue({ data: {} });
    const { result, invalidateSpy } = setup(() => useSetActiveApiKey('elevenlabs'));

    await result.current.mutateAsync('k1');

    expectKeyDependentInvalidation(invalidateSpy);
  });

  it('refetches tool availability after deleting a key', async () => {
    del.mockResolvedValue({ data: { id: 'k1' } });
    const { result, invalidateSpy } = setup(() => useDeleteApiKey());

    await result.current.mutateAsync('k1');

    expectKeyDependentInvalidation(invalidateSpy);
  });
});
