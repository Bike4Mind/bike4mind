import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import ClaudeCodeExportDialog, { type ClaudeCodeExportDialogProps } from './ClaudeCodeExportDialog';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const appTheme = extendTheme({ ...getThemeConfig() });

const skill = { name: 'review-pr', description: 'Review a PR', body: 'Review $ARGUMENTS.' };

const renderDialog = (props: Partial<ClaudeCodeExportDialogProps> = {}) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ClaudeCodeExportDialog onClose={vi.fn()} skill={skill} sourcePath="/skills/abc" thirdParty={false} {...props} />
    </CssVarsProvider>
  );

const writeText = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

describe('ClaudeCodeExportDialog', () => {
  it('copies an install command stamped with the source page and version', async () => {
    renderDialog({ sourcePath: '/skills/market/l1', version: 3 });
    fireEvent.click(screen.getByTestId('skill-claude-code-copy-cmd'));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const command: string = writeText.mock.calls[0][0];
    expect(command).toMatch(
      /^mkdir -p ~\/\.claude\/skills\/review-pr && cat > ~\/\.claude\/skills\/review-pr\/SKILL\.md <<'/
    );
    expect(command).toContain(`# Bike4Mind-Source: ${window.location.origin}/skills/market/l1\n# Version: 3\n`);
  });

  it('shows no warnings for a plain own skill', () => {
    renderDialog();
    expect(screen.queryByTestId('skill-claude-code-b4m-only')).not.toBeInTheDocument();
    expect(screen.queryByText(/third-party skill/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('skill-claude-code-import-hint')).not.toBeInTheDocument();
  });

  it('warns about Bike4Mind-only tools and agents, third-party text, and a missing import', () => {
    renderDialog({
      skill: { ...skill, body: 'Ask @github_manager, not me@example.com.', allowedTools: ['web_search'] },
      thirdParty: true,
      showImportHint: true,
    });
    const alert = screen.getByTestId('skill-claude-code-b4m-only');
    expect(alert).toHaveTextContent('web_search');
    expect(alert).toHaveTextContent('@github_manager');
    expect(alert).not.toHaveTextContent('example');
    expect(screen.getByText(/third-party skill/)).toBeInTheDocument();
    expect(screen.getByTestId('skill-claude-code-import-hint')).toBeInTheDocument();
  });

  it('reports a name Claude Code cannot use instead of a clipboard failure', () => {
    renderDialog({ skill: { ...skill, name: 'Bad Name' } });
    fireEvent.click(screen.getByTestId('skill-claude-code-copy-cmd'));
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('not a valid Claude Code skill name'));
    expect(writeText).not.toHaveBeenCalled();
  });
});
