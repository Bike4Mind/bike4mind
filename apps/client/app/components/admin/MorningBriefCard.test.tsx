import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: query }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn() } }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: { isAdmin: true } }) }));
import { MorningBriefCard } from './MorningBriefCard';
const theme = extendTheme({ ...getThemeConfig() });
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
);

describe('MorningBriefCard', () => {
  it('shows latest persisted plain facts and manual links without a model summary', () => {
    query.mockReturnValue({
      data: {
        brief: {
          day: '2026-11-12',
          environment: 'dev',
          delivery: 'sent',
          facts: 'Feedback: 3',
          summary: null,
          needsHuman: [{ label: 'Review feedback', href: '/admin?tab=2' }],
        },
      },
    });
    render(<MorningBriefCard />, { wrapper });
    expect(screen.getByTestId('morning-brief-facts')).toHaveTextContent('Feedback: 3');
    expect(screen.getByTestId('morning-brief-human-link')).toHaveAttribute('href', '/admin?tab=2');
    expect(screen.queryByText(/AI summary/)).not.toBeInTheDocument();
  });
  it('explains the empty manual fallback', () => {
    query.mockReturnValue({ data: { brief: null } });
    render(<MorningBriefCard />, { wrapper });
    expect(screen.getByText(/Review the admin queues manually/)).toBeInTheDocument();
  });
});
