import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { HtmlArtifact } from '@bike4mind/common';

// The card mounts an iframe-backed preview; stub it so we can assert rendered-vs-source
// without a real iframe.
vi.mock('./InlineArtifactPreview', () => ({
  default: () => <div data-testid="inline-artifact-preview" />,
}));

vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSession: null, setCurrentSession: vi.fn(), currentSessionId: 's1' }),
  useWorkBenchFiles: () => [],
  useWorkBenchActions: () => ({ setWorkBenchFiles: vi.fn() }),
}));

vi.mock('@client/app/hooks/useSessionLayout', () => {
  const hook = () => undefined; // selector is ignored; no artifact is selected in these tests
  return {
    default: Object.assign(hook, { getState: () => ({ selectedArtifactId: null, artifactData: null }) }),
    setSessionLayout: vi.fn(),
    setSelectedArtifactVersion: vi.fn(),
  };
});

// Mutable so both arms of the artifacts flag get exercised. The card no longer reads it -- the
// parameterized mount test below is the guard against seeding the expand state from it again,
// which is what #534 was.
const featureFlag = vi.hoisted(() => ({ artifactsEnabled: false }));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => featureFlag.artifactsEnabled }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('@client/app/utils/filesAPICalls', () => ({ createFabFileOnServerWithUpload: vi.fn() }));
vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  // The card reads maxVisibleLines/autoCollapseContent to bound a long source body.
  useUserSettings: () => ({ settings: { autoCollapseContent: true, maxVisibleLines: 25 } }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import HtmlArtifactPreviewCard from './HtmlArtifactPreviewCard';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const SENTINEL = 'data-source-sentinel-xyz';
const artifact = {
  id: 'a1',
  title: 'Taipei Night Markets',
  content: `<!DOCTYPE html><html lang="en"><head><title>Markets</title></head><body>${SENTINEL}</body></html>`,
  metadata: {},
} as unknown as HtmlArtifact;

describe('HtmlArtifactPreviewCard', () => {
  // Plain hoisted state, not a mock, so nothing resets it between tests -- do it here so the
  // flag arms cannot leak into the cases below.
  beforeEach(() => {
    featureFlag.artifactsEnabled = false;
  });

  it.each([false, true])(
    'mounts on the rendered preview, not raw source, with enableArtifacts=%s',
    artifactsEnabled => {
      featureFlag.artifactsEnabled = artifactsEnabled;
      render(
        <TestWrapper>
          <HtmlArtifactPreviewCard artifact={artifact} />
        </TestWrapper>
      );
      expect(screen.getByTestId('inline-artifact-preview')).toBeInTheDocument();
      expect(screen.queryByTestId('html-artifact-source')).not.toBeInTheDocument();
      expect(screen.queryByText(new RegExp(SENTINEL))).not.toBeInTheDocument();
    }
  );

  // A card no longer folds: the render is bounded by its own cap and the viewer is where a
  // reader goes for more, so there is no collapsed state left to hide the body - and with it
  // goes the raw-source teaser, which was DOCTYPE boilerplate identical on every artifact.
  it('has no fold control and always shows its render', () => {
    render(
      <TestWrapper>
        <HtmlArtifactPreviewCard artifact={artifact} />
      </TestWrapper>
    );
    expect(screen.queryByTestId('html-artifact-toggle-btn')).not.toBeInTheDocument();
    expect(screen.getByTestId('inline-artifact-preview')).toBeInTheDocument();
    expect(screen.queryByTestId('html-artifact-source')).not.toBeInTheDocument();
    expect(screen.queryByText(/DOCTYPE/)).not.toBeInTheDocument();
  });

  // The card no longer flips between the render and the source: switching views is the
  // viewer's job, where ArtifactModeTabs gives every renderable type the same Preview/Code
  // strip and there is room to read either. The two tests that drove the old inline toggle
  // are gone with it; this one pins the card to the render alone.
  it('offers no inline view toggle - the card shows the render only', () => {
    render(
      <TestWrapper>
        <HtmlArtifactPreviewCard artifact={artifact} />
      </TestWrapper>
    );
    expect(screen.queryByTestId('view-mode-code')).not.toBeInTheDocument();
    expect(screen.queryByTestId('view-mode-preview')).not.toBeInTheDocument();
    expect(screen.getByTestId('inline-artifact-preview')).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(SENTINEL))).not.toBeInTheDocument();
  });
});
