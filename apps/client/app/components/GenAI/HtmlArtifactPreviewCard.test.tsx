import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
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

vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  // Artifacts disabled => card mounts expanded, which is the state the bug reported (raw source).
  useFeatureEnabled: () => ({ isFeatureEnabled: () => false }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('@client/app/utils/filesAPICalls', () => ({ createFabFileOnServerWithUpload: vi.fn() }));
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
  it('defaults an expanded artifact to the rendered preview, not raw source', () => {
    render(
      <TestWrapper>
        <HtmlArtifactPreviewCard artifact={artifact} />
      </TestWrapper>
    );
    expect(screen.getByTestId('inline-artifact-preview')).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(SENTINEL))).not.toBeInTheDocument();
  });

  it('toggles to source view when the preview button is clicked', () => {
    render(
      <TestWrapper>
        <HtmlArtifactPreviewCard artifact={artifact} />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('html-artifact-preview-btn'));
    expect(screen.queryByTestId('inline-artifact-preview')).not.toBeInTheDocument();
    expect(screen.getByText(new RegExp(SENTINEL))).toBeInTheDocument();
  });
});
