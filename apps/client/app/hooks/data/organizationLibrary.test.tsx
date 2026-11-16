import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useReuseLibraryItem } from './organizationLibrary';
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api }));

describe('org library member reuse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it.each([
    ['agent', '/api/agents', 'agents'],
    ['skill', '/api/skills', 'skills'],
    ['prompt', '/api/briefcase/prompts', 'briefcase-catalog'],
    ['template', '/api/image-templates', 'image-templates'],
  ])('adds a %s working copy through its normal validated API', async (kind, path, queryKey) => {
    const definition = { name: 'Published definition' };
    api.get.mockResolvedValue({ data: { item: { kind, definition } } });
    api.post.mockResolvedValue({ data: { id: 'copy' } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useReuseLibraryItem(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('published-item');
    });
    expect(api.get).toHaveBeenCalledWith('/api/organization-library/published-item');
    expect(api.post).toHaveBeenCalledWith(path, definition);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [queryKey] });
  });
  it('does not create a copy if current membership no longer permits reading the snapshot', async () => {
    api.get.mockRejectedValue(new Error('Library item not found'));
    const qc = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useReuseLibraryItem(), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync('hidden-item')).rejects.toThrow('Library item not found');
    });
    expect(api.post).not.toHaveBeenCalled();
  });
});
