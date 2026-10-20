import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  servers: [] as { id: string; name: string; envVariables: { key: string }[]; enabled: boolean; tools: string[] }[],
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('@client/app/hooks/data/mcpServers', () => ({
  useMcpServers: () => ({ data: mocks.servers, isLoading: false }),
  mcpServerKeys: { list: () => ['mcpServers', 'list'] },
}));

import McpSection from './McpSection';
import { api } from '@client/app/contexts/ApiContext';
import { toast } from 'sonner';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderSection = () => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <McpSection />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

// Joy's Input puts the data-testid on its root element, with the real input inside.
const valueInputAt = (index: number) =>
  within(screen.getAllByTestId('mcp-env-value-input')[index]).getByRole('textbox') as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  // The LinkedIn server shares a key with the add-new form's defaults, so the cancel test can
  // tell a cleared stored-keys set from a stale one.
  mocks.servers = [
    { id: 's1', name: 'linkedin', envVariables: [{ key: 'LINKEDIN_ACCESS_TOKEN' }], enabled: true, tools: [] },
  ];
});

describe('McpSection env variable form', () => {
  it('opens a stored key blank and optional, with the Unchanged placeholder', async () => {
    renderSection();

    await userEvent.setup().click(screen.getByTestId('mcp-server-edit-btn'));

    const input = valueInputAt(0);
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('Unchanged');
    expect(input.required).toBe(false);
  });

  it('requires a value for a newly added key', async () => {
    renderSection();
    const user = userEvent.setup();

    await user.click(screen.getByTestId('mcp-server-edit-btn'));
    await user.click(screen.getByTestId('mcp-env-add-btn'));

    expect(valueInputAt(0).required).toBe(false);
    expect(valueInputAt(1).required).toBe(true);
    expect(valueInputAt(1).placeholder).toBe('');
  });

  // A stale stored-keys set would mark the next new key optional, and the server answers 400.
  it('stops treating a stored key as optional after the edit is canceled', async () => {
    renderSection();
    const user = userEvent.setup();

    await user.click(screen.getByTestId('mcp-server-edit-btn'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Add New MCP Server' }));

    expect(valueInputAt(0).required).toBe(true);
    expect(valueInputAt(0).placeholder).toBe('');
  });
});

describe('McpSection create', () => {
  const submitNewServer = async () => {
    renderSection();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add New MCP Server' }));
    for (const input of screen.getAllByTestId('mcp-env-value-input')) {
      await user.type(within(input).getByRole('textbox'), 'test-value');
    }
    await user.click(screen.getByTestId('mcp-server-submit-btn'));
  };

  it('closes the dialog and warns when the server saved but could not connect', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { id: 's2', connectionError: 'Connection closed' } });

    await submitNewServer();

    expect(toast.warning).toHaveBeenCalledWith('Saved, but could not connect: Connection closed');
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mcp-server-submit-btn')).toBeNull();
  });

  it('closes the dialog without a warning when the connect succeeds', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { id: 's2' } });

    await submitNewServer();

    expect(toast.warning).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mcp-server-submit-btn')).toBeNull();
  });

  it('keeps the dialog open with the reason when the save itself is refused', async () => {
    vi.mocked(api.post).mockRejectedValue({ response: { data: { reason: 'Forbidden env key: NODE_OPTIONS' } } });

    await submitNewServer();

    expect(toast.error).toHaveBeenCalledWith('Forbidden env key: NODE_OPTIONS');
    expect(screen.getByTestId('mcp-server-submit-btn')).toBeTruthy();
  });
});
