import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';

const getAgentEmbedKeys = vi.hoisted(() => vi.fn());
vi.mock('@client/app/utils/agentsAPICalls', () => ({ getAgentEmbedKeys }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { EmbedSnippetSection } from './EmbedSnippetSection';
import { EMBED_CHAT_PATH, EMBED_KEY_PLACEHOLDER } from '@client/app/utils/embedSnippet';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const KEY = {
  id: 'key-1',
  name: 'Widget key',
  keyPrefix: 'b4m_live_abc1234',
  agentId: 'agent-1',
  allowedOrigins: ['https://example.com'],
  status: 'active',
  createdAt: '2026-07-01T00:00:00Z',
};

const renderSection = () =>
  render(
    <Wrapper>
      <EmbedSnippetSection agentId="agent-1" agentName="Sales Bot" />
    </Wrapper>
  );

const snippetValue = () => (screen.getByTestId('agent-embed-snippet-snippet') as HTMLTextAreaElement).value;

describe('EmbedSnippetSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAgentEmbedKeys.mockResolvedValue([KEY]);
  });

  it('shows the empty-state hint when the agent has no embed keys', async () => {
    getAgentEmbedKeys.mockResolvedValue([]);
    renderSection();
    await waitFor(() => expect(screen.getByTestId('agent-embed-snippet-empty')).toBeTruthy());
  });

  it('lists the key and emits a script snippet with the placeholder by default', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByTestId('agent-embed-snippet-snippet')).toBeTruthy());
    expect(screen.getByText('https://example.com')).toBeTruthy();
    const snippet = snippetValue();
    expect(snippet).toContain('<script');
    expect(snippet).toContain(`data-key="${EMBED_KEY_PLACEHOLDER}"`);
  });

  it('toggles to an iframe snippet at the pretty path', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByTestId('agent-embed-snippet-snippet')).toBeTruthy());
    fireEvent.click(screen.getByTestId('agent-embed-snippet-format-iframe'));
    const snippet = snippetValue();
    expect(snippet).toContain('<iframe');
    expect(snippet).toContain(`${EMBED_CHAT_PATH}?k=${EMBED_KEY_PLACEHOLDER}`);
    expect(snippet).toContain('title="Sales Bot chat"');
  });

  it('substitutes a locally pasted raw key without sending it anywhere', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByTestId('agent-embed-snippet-snippet')).toBeTruthy());
    fireEvent.change(screen.getByTestId('agent-embed-snippet-key-input'), {
      target: { value: 'b4m_live_pasted_secret' },
    });
    expect(snippetValue()).toContain('data-key="b4m_live_pasted_secret"');
    // The only network call is the initial metadata fetch; the pasted key never leaves the component.
    expect(getAgentEmbedKeys).toHaveBeenCalledTimes(1);
    expect(getAgentEmbedKeys).toHaveBeenCalledWith('agent-1');
  });

  it('copies the snippet to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderSection();
    await waitFor(() => expect(screen.getByTestId('agent-embed-snippet-copy')).toBeTruthy());
    fireEvent.click(screen.getByTestId('agent-embed-snippet-copy'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(snippetValue()));
  });
});
