import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const reconnect = vi.hoisted(() => vi.fn());

vi.mock('@client/app/hooks/useAgentExecution', () => ({
  useAgentExecutionDispatch: () => ({ reconnect }),
}));

vi.mock('@client/app/stores/useAgentExecutionStore', () => ({
  useAgentExecutionStore: (sel: (s: unknown) => unknown) => sel({ executions: {}, pendingDispatches: [] }),
  selectExecutionIdsForSession: () => () => [],
}));

import ActiveAgentExecutions from './ActiveAgentExecutions';

const appTheme = extendTheme({ ...getThemeConfig() });

describe('ActiveAgentExecutions', () => {
  it('does not send a reconnect probe across a remount', () => {
    const tree = () => (
      <CssVarsProvider theme={appTheme}>
        <ActiveAgentExecutions sessionId="A" />
      </CssVarsProvider>
    );
    render(tree()).unmount();
    render(tree());
    expect(reconnect).not.toHaveBeenCalled();
  });
});
