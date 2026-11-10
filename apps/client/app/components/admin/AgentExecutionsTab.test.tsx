import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const m = vi.hoisted(() => ({
  currentUser: { isAdmin: false, adminPermissions: [] } as { isAdmin: boolean; adminPermissions?: string[] },
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: m.currentUser }) }));
vi.mock('@client/app/hooks/data/stuckAgentExecutions', () => ({
  useStuckAgentExecutions: () => ({
    data: {
      items: [
        {
          id: 'exec-1',
          userId: 'user-1',
          sessionId: 'session-1',
          questId: 'quest-1',
          query: 'stuck query',
          model: 'model-1',
          status: 'running',
          totalCreditsUsed: 0,
          lambdaInvocationCount: 1,
          createdAt: '2026-10-30T10:00:00.000Z',
          updatedAt: '2026-10-30T10:00:00.000Z',
        },
      ],
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    isFetching: false,
  }),
  useCleanupAgentExecutions: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import AgentExecutionsTab from './AgentExecutionsTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderTab = (user: typeof m.currentUser) => {
  m.currentUser = user;
  render(
    <CssVarsProvider theme={appTheme}>
      <AgentExecutionsTab />
    </CssVarsProvider>
  );
  fireEvent.click(within(screen.getByTestId('stuck-execution-checkbox-exec-1')).getByRole('checkbox'));
  return screen.getByTestId('stuck-agent-executions-cleanup-btn') as HTMLButtonElement;
};

describe('AgentExecutionsTab cleanup action', () => {
  it('is disabled with the missing-permission hint for a support:read delegate', () => {
    const button = renderTab({ isAdmin: false, adminPermissions: ['support:read'] });

    expect(button.disabled).toBe(true);
    expect(screen.getByTestId('admin-missing-permission-action')).toBeTruthy();
  });

  it('is enabled for a settings:manage delegate', () => {
    const button = renderTab({ isAdmin: false, adminPermissions: ['settings:manage'] });

    expect(button.disabled).toBe(false);
    expect(screen.queryByTestId('admin-missing-permission-action')).toBeNull();
  });
});
