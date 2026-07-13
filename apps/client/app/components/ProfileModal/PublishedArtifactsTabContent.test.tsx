import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';

const { mockList } = vi.hoisted(() => ({ mockList: vi.fn() }));

vi.mock('@client/app/utils/publishApi', () => ({
  listMyPublishedArtifacts: (...a: unknown[]) => mockList(...a),
  deletePublishedArtifact: vi.fn(),
  updatePublishedVisibility: vi.fn(),
  updatePublishedCommentPolicy: vi.fn(),
  restorePreviousVersion: vi.fn(),
  toArtifactSharePath: (_t: string, s: string, slug: string) => `/p/u/${s}/${slug}`,
}));

// Stub the panel so this test targets the toggle wiring, not the panel's fetch.
vi.mock('@client/app/components/common/ManageSharingPanel', () => ({
  ManageSharingPanel: (p: { publicId: string }) => <div data-testid={`stub-panel-${p.publicId}`} />,
}));

import PublishedArtifactsTabContent from './PublishedArtifactsTabContent';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CssVarsProvider theme={appTheme}>
        <PublishedArtifactsTabContent />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

beforeEach(() => {
  mockList.mockReset().mockResolvedValue([
    {
      publicId: 'pub-1',
      tier: 'user',
      scopeId: 'erik',
      slug: 's',
      title: 'My Artifact',
      visibility: 'public',
      commentPolicy: 'none',
      source: { kind: 'bundle' },
      versionsCount: 1,
    },
  ]);
});

describe('PublishedArtifactsTabContent - manage toggle', () => {
  it('mounts the sharing panel only after the </> toggle is clicked, and unmounts on re-click', async () => {
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');

    // Lazy: panel not mounted until the owner opens it.
    expect(screen.queryByTestId('stub-panel-pub-1')).toBeNull();

    fireEvent.click(screen.getByTestId('published-artifact-manage-pub-1'));
    expect(screen.getByTestId('stub-panel-pub-1')).not.toBeNull();

    fireEvent.click(screen.getByTestId('published-artifact-manage-pub-1'));
    expect(screen.queryByTestId('stub-panel-pub-1')).toBeNull();
  });
});
