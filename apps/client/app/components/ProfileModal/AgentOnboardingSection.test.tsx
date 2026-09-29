import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import AgentOnboardingSection from './AgentOnboardingSection';
import { buildCursorInstallLink } from './agentOnboarding';

const appTheme = extendTheme({ ...getThemeConfig() });
const origin = window.location.origin;
const writeText = vi.fn<(text: string) => Promise<void>>();

const renderSection = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <AgentOnboardingSection />
    </CssVarsProvider>
  );

const copiedBy = async (testId: string): Promise<string> => {
  fireEvent.click(screen.getByTestId(testId));
  await waitFor(() => expect(writeText).toHaveBeenCalled());
  return writeText.mock.calls.at(-1)![0];
};

describe('AgentOnboardingSection', () => {
  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  it('renders the card with every copy control', () => {
    renderSection();
    expect(screen.getByTestId('agent-onboarding-card')).toBeTruthy();
    for (const id of [
      'agent-onboarding-copy-prompt-btn',
      'agent-onboarding-claude-code-copy-btn',
      'agent-onboarding-codex-copy-btn',
      'agent-onboarding-codex-env-copy-btn',
      'agent-onboarding-cursor-copy-btn',
      'agent-onboarding-cursor-install-link',
    ]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
  });

  it('copies a prompt pointing at this origin with no key in it', async () => {
    renderSection();
    const prompt = await copiedBy('agent-onboarding-copy-prompt-btn');

    expect(prompt).toContain(`${origin}/llms.txt`);
    expect(prompt).toContain(`${origin}/api/v1/openapi.json`);
    expect(prompt).toContain(`${origin}/api/v1/docs`);
    expect(prompt).toContain('X-API-Key');
    expect(prompt).toContain('B4M_API_KEY');
    expect(prompt).toContain(`B4M_API_URL=${origin}`);
    expect(prompt).not.toContain('b4m_live_');
  });

  it.each([
    ['agent-onboarding-claude-code-copy-btn', 'claude mcp add'],
    ['agent-onboarding-codex-copy-btn', 'codex mcp add'],
    ['agent-onboarding-codex-env-copy-btn', 'env_vars = ["B4M_API_KEY"]'],
    ['agent-onboarding-cursor-copy-btn', 'cursor://anysphere.cursor-deeplink/mcp/install?name=bike4mind'],
  ])('%s copies its own snippet without a key', async (testId, expected) => {
    renderSection();
    const text = await copiedBy(testId);

    expect(text).toContain(expected);
    expect(text).not.toContain('b4m_live_');
  });

  it('references the key by env var in the Claude Code command so the shell does not expand it', async () => {
    renderSection();
    const command = await copiedBy('agent-onboarding-claude-code-copy-btn');

    expect(command).toContain(`--env 'B4M_API_KEY=\${B4M_API_KEY}'`);
    expect(command).toContain(`--env B4M_API_URL=${origin}`);
    expect(command).toMatch(/ bike4mind -- npx -y @bike4mind\/cli@latest mcp serve$/);
  });

  it('encodes a Cursor config that reads the key from the environment', () => {
    const link = new URL(buildCursorInstallLink(origin));
    const config = JSON.parse(atob(link.searchParams.get('config')!));

    expect(link.searchParams.get('name')).toBe('bike4mind');
    expect(config).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@bike4mind/cli@latest', 'mcp', 'serve'],
      env: { B4M_API_KEY: '${env:B4M_API_KEY}', B4M_API_URL: origin },
    });
  });
});
