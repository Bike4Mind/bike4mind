import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({ copyTextWithToast: vi.fn() }));

vi.mock('@client/app/utils/copyToClipboard', () => ({ copyTextWithToast: mocks.copyTextWithToast }));

import AgentConnectSection from './AgentConnectSection';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderSection = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <AgentConnectSection />
    </CssVarsProvider>
  );

const lastCopiedText = (): string => {
  const [copied] = mocks.copyTextWithToast.mock.calls.at(-1) ?? [];
  if (typeof copied !== 'string') throw new Error('Nothing was copied');
  return copied;
};

describe('AgentConnectSection', () => {
  beforeEach(() => {
    mocks.copyTextWithToast.mockReset();
  });

  it("copies an agent prompt built from this deployment's origin, with no key in it", async () => {
    renderSection();

    await userEvent.click(screen.getByTestId('agent-connect-copy-prompt-btn'));

    const prompt = lastCopiedText();
    const { origin } = window.location;
    expect(prompt).toContain(`${origin}/llms.txt`);
    expect(prompt).toContain(`${origin}/api/v1/openapi.json`);
    expect(prompt).toContain(`${origin}/api/v1/docs`);
    expect(prompt).not.toContain('b4m_live_');
  });

  it.each(['claude-code', 'codex'])('copies the %s MCP setup snippet', async id => {
    renderSection();

    expect(screen.getByTestId(`agent-connect-snippet-${id}`)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId(`agent-connect-copy-${id}-btn`));

    const snippet = lastCopiedText();
    expect(snippet).toContain('B4M_API_KEY');
    expect(snippet).toContain(window.location.origin);
    expect(snippet).not.toContain('b4m_live_');
  });

  it('links to the Cursor MCP install deeplink', () => {
    renderSection();

    const link = screen.getByTestId('agent-connect-cursor-install-link');
    expect(link.getAttribute('href')).toMatch(
      /^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=bike4mind&config=/
    );
  });
});
