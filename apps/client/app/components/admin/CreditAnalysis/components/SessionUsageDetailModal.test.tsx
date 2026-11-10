import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mockUseSessionUsage = vi.fn();

vi.mock('../hooks/useSessionUsage', () => ({
  useSessionUsage: (...args: unknown[]) => mockUseSessionUsage(...args),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

import { SessionUsageDetailModal } from './SessionUsageDetailModal';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const modelRow = (overrides: Record<string, unknown>) => ({
  provider: 'bedrock',
  model: 'claude-sonnet-4-5',
  requests: 1,
  inputTokens: 10,
  outputTokens: 5,
  cogsUsd: 0.01,
  creditsCharged: 1,
  ...overrides,
});

describe('SessionUsageDetailModal by-model table', () => {
  it('labels a substituted row with what ran and leaves a plain row alone', () => {
    mockUseSessionUsage.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        usage: {
          totals: { creditsCharged: 2, cogsUsd: 0.02, requests: 2, inputTokens: 20, outputTokens: 10 },
          byQuest: [],
          byModel: [
            modelRow({ executedProvider: 'openai', executedModel: 'gpt-4o-mini' }),
            modelRow({ provider: 'openai', model: 'gpt-4o', executedProvider: 'openai', executedModel: 'gpt-4o' }),
          ],
        },
        executions: [],
      },
    });

    render(
      <TestWrapper>
        <SessionUsageDetailModal sessionId="session-1" onClose={vi.fn()} />
      </TestWrapper>
    );

    const table = within(screen.getByTestId('session-usage-model-table'));
    expect(table.getByText('bedrock / claude-sonnet-4-5 (ran: openai / gpt-4o-mini)')).toBeTruthy();
    const plain = table.getByText('openai / gpt-4o');
    expect(plain.textContent).not.toContain('(ran:');
  });
});
