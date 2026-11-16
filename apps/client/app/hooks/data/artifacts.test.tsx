import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSubscribeToArtifactVersions } from './artifacts';

type VersionsCallback = (type: string, val: { _id: string; artifactId: string }) => void;

const subscription = vi.hoisted(() => ({ callback: undefined as unknown }));

vi.mock('@/app/contexts/ApiContext', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/app/utils/react-query', () => ({
  updateAllQueryData: vi.fn(),
  useSubscribeCollection: (_collection: string, _query: unknown, callback: unknown) => {
    subscription.callback = callback;
  },
}));

describe('useSubscribeToArtifactVersions', () => {
  it('refreshes the version list and the artifact an open viewer syncs from when a version is written', () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useSubscribeToArtifactVersions('artifact_react_counter_1_0'), { wrapper });
    (subscription.callback as VersionsCallback)('write', { _id: 'v4', artifactId: 'artifact_react_counter_1_0' });

    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toContainEqual(['artifactVersions', 'artifact_react_counter_1_0']);
    expect(keys).toContainEqual(['artifact', 'artifact_react_counter_1_0']);
  });
});
