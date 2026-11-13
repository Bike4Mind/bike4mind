import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ARTIFACT_VERSION_CREATED_EVENT } from '@client/app/utils/artifactPersistence';
import { useRefreshArtifactOnNewVersion } from './useRefreshArtifactOnNewVersion';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));

const setup = () => {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useRefreshArtifactOnNewVersion(), { wrapper });
  const keys = () => invalidate.mock.calls.map(([filters]) => filters?.queryKey);
  return { hook, keys };
};

const announce = (detail: unknown) => window.dispatchEvent(new CustomEvent(ARTIFACT_VERSION_CREATED_EVENT, { detail }));

describe('useRefreshArtifactOnNewVersion', () => {
  it('refetches the artifact and its version list when a new version is announced', () => {
    const { keys } = setup();

    announce({ artifactId: 'artifact_react_counter_1_0' });

    expect(keys()).toEqual([
      ['artifact', 'artifact_react_counter_1_0'],
      ['artifactVersions', 'artifact_react_counter_1_0'],
    ]);
  });

  it('ignores an announcement without an artifact id', () => {
    const { keys } = setup();

    announce({});

    expect(keys()).toEqual([]);
  });

  it('stops listening once unmounted', () => {
    const { hook, keys } = setup();
    hook.unmount();

    announce({ artifactId: 'artifact_react_counter_1_0' });

    expect(keys()).toEqual([]);
  });
});
