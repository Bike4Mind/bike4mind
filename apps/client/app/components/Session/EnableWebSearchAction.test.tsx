import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const hoisted = vi.hoisted(() => ({
  tools: [] as string[],
  toolMode: 'smart' as 'fast' | 'smart',
  setLLM: vi.fn(),
  toolAvailability: undefined as Record<string, boolean> | undefined,
  supportsTools: true,
}));

vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: (selector: (s: unknown) => unknown) =>
    selector({ tools: hoisted.tools, toolMode: hoisted.toolMode, setLLM: hoisted.setLLM, model: 'gpt-4o' }),
}));
vi.mock('@client/app/hooks/data/settings', () => ({
  useConfig: () => ({ data: { toolAvailability: hoisted.toolAvailability } }),
}));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: [{ id: 'gpt-4o', name: 'GPT-4o', supportsTools: hoisted.supportsTools }] }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

import EnableWebSearchAction from './EnableWebSearchAction';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const NO_SEARCH_REPLY = 'Sorry, no search tool is connected, so I cannot look that up.';

describe('EnableWebSearchAction', () => {
  beforeEach(() => {
    hoisted.tools = ['current_datetime'];
    hoisted.toolMode = 'smart';
    hoisted.setLLM.mockReset();
    hoisted.toolAvailability = undefined;
    hoisted.supportsTools = true;
  });

  it('turns Web Search on when the reply says no search tool is connected', () => {
    render(<EnableWebSearchAction reply={NO_SEARCH_REPLY} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByTestId('enable-web-search-btn'));
    expect(hoisted.setLLM).toHaveBeenCalledWith({ toolMode: 'smart', tools: ['current_datetime', 'web_search'] });
  });

  it('stays hidden for an ordinary reply', () => {
    render(<EnableWebSearchAction reply="Here is your answer." />, { wrapper: Wrapper });
    expect(screen.queryByTestId('enable-web-search-action')).not.toBeInTheDocument();
  });

  it('stays hidden once Web Search is already on', () => {
    hoisted.tools = ['web_search'];
    render(<EnableWebSearchAction reply={NO_SEARCH_REPLY} />, { wrapper: Wrapper });
    expect(screen.queryByTestId('enable-web-search-action')).not.toBeInTheDocument();
  });

  it('stays hidden when the deployment has no search key', () => {
    hoisted.toolAvailability = { web_search: false };
    render(<EnableWebSearchAction reply={NO_SEARCH_REPLY} />, { wrapper: Wrapper });
    expect(screen.queryByTestId('enable-web-search-action')).not.toBeInTheDocument();
  });

  it('stays hidden for a model without tool support', () => {
    hoisted.supportsTools = false;
    render(<EnableWebSearchAction reply={NO_SEARCH_REPLY} />, { wrapper: Wrapper });
    expect(screen.queryByTestId('enable-web-search-action')).not.toBeInTheDocument();
  });

  it('switches Fast mode to Smart so the resend carries Web Search', () => {
    hoisted.toolMode = 'fast';
    hoisted.tools = ['web_search'];
    render(<EnableWebSearchAction reply={NO_SEARCH_REPLY} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByTestId('enable-web-search-btn'));
    expect(hoisted.setLLM).toHaveBeenCalledWith({ toolMode: 'smart', tools: ['web_search'] });
  });
});
