import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  useModelLogs: vi.fn(),
}));

vi.mock('@tanstack/react-router', async () => (await import('./__tests__/fakeAdminRouter')).fakeRouterModule);
vi.mock('@client/app/hooks/useModelLogs', () => ({ useModelLogs: mocks.useModelLogs }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));

import { fakeAdminRouter } from './__tests__/fakeAdminRouter';
import { ModelLogsTab } from './ModelLogsTab';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ModelLogsTab />
    </CssVarsProvider>
  );

const queryResult = (overrides: Record<string, unknown>) => ({
  data: { logs: [] },
  isLoading: false,
  isSuccess: true,
  refetch: vi.fn(),
  ...overrides,
});

describe('ModelLogsTab', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T12:00:00'));
    mocks.useModelLogs.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clamps a linked page past the end once the results have loaded', async () => {
    mocks.useModelLogs.mockReturnValue(queryResult({}));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs', modelLogsPage: 3 }));
    renderTab();

    await waitFor(() => expect(fakeAdminRouter.search).toEqual({ tab: 'model-logs' }));
    expect(fakeAdminRouter.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ replace: true }));
  });

  it('leaves a linked page alone until the results have loaded', () => {
    mocks.useModelLogs.mockReturnValue(queryResult({ data: undefined, isSuccess: false }));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs', modelLogsPage: 3 }));
    renderTab();

    expect(fakeAdminRouter.navigate).not.toHaveBeenCalled();
  });

  it('goes back to the first page when the model filter changes', async () => {
    mocks.useModelLogs.mockReturnValue(queryResult({ data: undefined, isSuccess: false }));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs', modelLogsPage: 3 }));
    renderTab();

    await userEvent.click(within(screen.getByTestId('model-logs-model-select')).getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: 'Claude 3 Opus' }));

    expect(fakeAdminRouter.search).toEqual({ tab: 'model-logs', modelLogsModel: 'claude-3-opus' });
  });
});
