import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { SkillImportHelp } from './SkillImportHelp';
import { SKILL_IMPORT_CLAUDE_CODE_PROMPT } from './skillImportRules';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const appTheme = extendTheme({ ...getThemeConfig() });

const renderHelp = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <SkillImportHelp />
    </CssVarsProvider>
  );

describe('SkillImportHelp', () => {
  const writeText = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  it('opens the import rules from the help button', () => {
    renderHelp();
    expect(screen.queryByTestId('skill-form-import-help-dialog')).toBeNull();
    fireEvent.click(screen.getByTestId('skill-form-import-help-btn'));
    expect(screen.getByTestId('skill-form-import-help-rules')).toHaveTextContent('500 characters or fewer');
    expect(screen.getByTestId('skill-form-import-help-rules')).toHaveTextContent('scripts/ and references/');
  });

  it('copies the Claude Code prompt and confirms', async () => {
    renderHelp();
    fireEvent.click(screen.getByTestId('skill-form-import-help-btn'));
    fireEvent.click(screen.getByTestId('skill-form-import-help-copy-btn'));
    expect(writeText).toHaveBeenCalledWith(SKILL_IMPORT_CLAUDE_CODE_PROMPT);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('reports a failed copy', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    renderHelp();
    fireEvent.click(screen.getByTestId('skill-form-import-help-btn'));
    fireEvent.click(screen.getByTestId('skill-form-import-help-copy-btn'));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });
});

describe('SKILL_IMPORT_CLAUDE_CODE_PROMPT', () => {
  it('states the description limit, the quoting rule and the skill path placeholder', () => {
    expect(SKILL_IMPORT_CLAUDE_CODE_PROMPT).toContain('500 characters or fewer');
    expect(SKILL_IMPORT_CLAUDE_CODE_PROMPT).toContain('wrap the description value in double quotes');
    expect(SKILL_IMPORT_CLAUDE_CODE_PROMPT).toContain('~/.claude/skills/<name>/');
    expect(SKILL_IMPORT_CLAUDE_CODE_PROMPT).toContain('scripts/ and references/');
    expect(SKILL_IMPORT_CLAUDE_CODE_PROMPT).toContain('starts and ends with a letter or digit');
  });

  it('states the supporting-file, body and escaping limits', () => {
    expect(SKILL_IMPORT_CLAUDE_CODE_PROMPT).toContain('20 supporting files');
    expect(SKILL_IMPORT_CLAUDE_CODE_PROMPT).toContain('50000 characters or fewer');
    expect(SKILL_IMPORT_CLAUDE_CODE_PROMPT).toContain('escape any backslashes and double quotes');
    expect(SKILL_IMPORT_CLAUDE_CODE_PROMPT).toContain(String.raw`(as \\ and \").`);
  });
});
