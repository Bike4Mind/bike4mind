import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { HtmlArtifact } from '@bike4mind/common';

// Regression guard for #457: an iterated artifact's v1/v2 chat cards share the same id, so a
// same-id card that merely mounts (or re-mounts on scroll) must NOT overwrite the shared
// Knowledge Base store with its own content. Only a content change observed while the card
// stays mounted (live streaming) may propagate.

vi.mock('./InlineArtifactPreview', () => ({ default: () => <div data-testid="inline-artifact-preview" /> }));

vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSession: null, setCurrentSession: vi.fn(), currentSessionId: 's1' }),
  useWorkBenchFiles: () => [],
  useWorkBenchActions: () => ({ setWorkBenchFiles: vi.fn() }),
}));

// Hoisted so the vi.mock factory (also hoisted) can close over them.
const { setSessionLayout, getState } = vi.hoisted(() => ({
  setSessionLayout: vi.fn(),
  // The card is "selected" (viewer open on this id) so the sync effect's guard is exercised.
  getState: () => ({
    selectedArtifactId: 'a1',
    artifactData: { type: 'html', id: 'a1', mimeType: 'text/html', content: { id: 'a1', content: '<old/>' } },
  }),
}));

vi.mock('@client/app/hooks/useSessionLayout', () => {
  const hook = () => undefined;
  return {
    default: Object.assign(hook, { getState }),
    setSessionLayout,
    setSelectedArtifactVersion: vi.fn(),
  };
});

vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => false }),
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@client/app/utils/filesAPICalls', () => ({ createFabFileOnServerWithUpload: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import HtmlArtifactPreviewCard from './HtmlArtifactPreviewCard';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const mk = (content: string) => ({ id: 'a1', title: 'T', content, metadata: {} }) as unknown as HtmlArtifact;

describe('HtmlArtifactPreviewCard store-sync guard (#457)', () => {
  beforeEach(() => setSessionLayout.mockClear());

  it('does not push to the store on initial mount (scroll-in must not clobber)', () => {
    render(
      <TestWrapper>
        <HtmlArtifactPreviewCard artifact={mk('<v2-red/>')} />
      </TestWrapper>
    );
    expect(setSessionLayout).not.toHaveBeenCalled();
  });

  it('pushes when content changes while the card stays mounted (live streaming)', () => {
    const { rerender } = render(
      <TestWrapper>
        <HtmlArtifactPreviewCard artifact={mk('<v2-partial/>')} />
      </TestWrapper>
    );
    expect(setSessionLayout).not.toHaveBeenCalled();

    rerender(
      <TestWrapper>
        <HtmlArtifactPreviewCard artifact={mk('<v2-final/>')} />
      </TestWrapper>
    );
    expect(setSessionLayout).toHaveBeenCalledTimes(1);
    expect(setSessionLayout.mock.calls[0][0].artifactData.content.content).toBe('<v2-final/>');
  });

  it('a freshly mounted older card does not clobber the store', () => {
    // Simulate scrolling an old (v1) card into view: a brand-new component instance mounts.
    const { unmount } = render(
      <TestWrapper>
        <HtmlArtifactPreviewCard artifact={mk('<v2-red/>')} />
      </TestWrapper>
    );
    unmount();
    setSessionLayout.mockClear();

    render(
      <TestWrapper>
        <HtmlArtifactPreviewCard artifact={mk('<v1-blue/>')} />
      </TestWrapper>
    );
    expect(setSessionLayout).not.toHaveBeenCalled();
  });
});
