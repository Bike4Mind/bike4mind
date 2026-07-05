import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

vi.mock('@client/app/hooks/useHelpContent');
vi.mock('@client/app/hooks/useHelpPanel', () => {
  const store = Object.assign(
    vi.fn(() => ({ currentSlug: 'test', navigateTo: vi.fn(), setCurrentFilePath: vi.fn() })),
    {
      getState: vi.fn(() => ({ currentSlug: 'test', navigateTo: vi.fn(), setCurrentFilePath: vi.fn() })),
    }
  );
  return { useHelpPanel: store };
});
vi.mock('@bike4mind/scripts/help/utils', () => ({
  toAnchor: (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
}));
vi.mock('./HelpFeedbackWidget', () => ({ default: () => null }));

import { useHelpContent } from '@client/app/hooks/useHelpContent';
import HelpContent from './HelpContent';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const mockUseHelpContent = vi.mocked(useHelpContent);

describe('HelpContent accordion rendering', () => {
  beforeEach(() => {
    mockUseHelpContent.mockReturnValue({
      data: `<details>\n<summary>Why can't I log in?</summary>\n\nCheck your email and password.\n\n</details>`,
      isLoading: false,
      error: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });

  it('renders the accordion summary text', async () => {
    render(
      <TestWrapper>
        <HelpContent slug="features/common-issues" />
      </TestWrapper>
    );

    expect(await screen.findByText("Why can't I log in?")).toBeInTheDocument();
  });

  it('details content is hidden before expanding', async () => {
    render(
      <TestWrapper>
        <HelpContent slug="features/common-issues" />
      </TestWrapper>
    );

    await screen.findByText("Why can't I log in?");
    expect(screen.queryByText('Check your email and password.')).not.toBeVisible();
  });

  it('expands to show content when summary is clicked', async () => {
    render(
      <TestWrapper>
        <HelpContent slug="features/common-issues" />
      </TestWrapper>
    );

    const summary = await screen.findByText("Why can't I log in?");
    fireEvent.click(summary);

    expect(await screen.findByText('Check your email and password.')).toBeVisible();
  });

  it('collapses content when summary is clicked again', async () => {
    render(
      <TestWrapper>
        <HelpContent slug="features/common-issues" />
      </TestWrapper>
    );

    const summary = await screen.findByText("Why can't I log in?");
    fireEvent.click(summary);
    await screen.findByText('Check your email and password.');
    fireEvent.click(summary);

    expect(screen.queryByText('Check your email and password.')).not.toBeVisible();
  });
});
