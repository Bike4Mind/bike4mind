import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { toSkillMd } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { SkillForm } from './SkillForm';

vi.mock('@client/app/hooks/data/skills', () => ({}));

const appTheme = extendTheme({ ...getThemeConfig() });

const renderForm = (enableSkillMdImport = true) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <SkillForm submitLabel="Create" onSubmit={vi.fn()} onCancel={vi.fn()} enableSkillMdImport={enableSkillMdImport} />
    </CssVarsProvider>
  );

const value = (testId: string) => (screen.getByTestId(testId) as HTMLInputElement).value;

const upload = (text: string) =>
  fireEvent.change(screen.getByTestId('skill-form-import-file'), {
    target: { files: [new File([text], 'SKILL.md', { type: 'text/markdown' })] },
  });

const paste = (text: string) => {
  fireEvent.click(screen.getByTestId('skill-form-import-paste-toggle'));
  fireEvent.change(screen.getByTestId('skill-form-import-paste-input'), { target: { value: text } });
  fireEvent.click(screen.getByTestId('skill-form-import-paste-apply'));
};

describe('SkillForm SKILL.md import', () => {
  it('prefills every field from an uploaded file and reports unsupported keys', async () => {
    renderForm();
    upload(
      '---\nname: review-pr\ndescription: "Review: a PR"\nargument-hint: "[pr]"\ndisable-model-invocation: true\nallowed-tools: Bash\nhooks: {}\n---\n\nReview $ARGUMENTS.\n'
    );
    await waitFor(() => expect(value('skill-name-input')).toBe('review-pr'));
    expect(value('skill-description-input')).toBe('Review: a PR');
    expect(value('skill-argument-hint-input')).toBe('[pr]');
    expect(value('skill-body-input')).toBe('Review $ARGUMENTS.');
    expect((screen.getByTestId('skill-disable-model-invocation') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('skill-form-import-dropped')).toHaveTextContent('allowed-tools, hooks');
    expect(screen.queryByTestId('skill-form-import-from-b4m')).not.toBeInTheDocument();
  });

  it.each([
    ['a non-YAML fence', '---js\n{ name: "x" }\n---\nbody'],
    ['invalid YAML', '---\nname: [oops\n---\nbody'],
  ])('shows an error and leaves the form untouched for %s', (_label, text) => {
    renderForm();
    paste(text);
    expect(screen.getByTestId('skill-form-import-error')).toBeInTheDocument();
    expect(value('skill-name-input')).toBe('');
    expect(value('skill-body-input')).toBe('');
  });

  it('flags a Bike4Mind export and warns when it is a third-party market skill', () => {
    const skill = { name: 'mine', description: 'd', body: 'b' };
    renderForm();
    paste(toSkillMd(skill, { sourceUrl: 'https://app.example/skills/1' }));
    const own = screen.getByTestId('skill-form-import-from-b4m');
    expect(own).toHaveTextContent('came from Bike4Mind');
    expect(own.querySelector('a')).toHaveAttribute('href', 'https://app.example/skills/1');
    expect(screen.queryByTestId('skill-form-import-dropped')).not.toBeInTheDocument();

    paste(toSkillMd(skill, { sourceUrl: 'https://app.example/skills/market/2', thirdParty: true }));
    expect(screen.getByTestId('skill-form-import-from-b4m')).toHaveTextContent("another author's Skill Market skill");
  });

  it('does not render a non-http source as a link', () => {
    renderForm();
    paste('---\n# Bike4Mind-Source: javascript:alert(1)\nname: x\n---\nb');
    expect(screen.getByTestId('skill-form-import-from-b4m').querySelector('a')).toBeNull();
  });

  it('hides the import strip unless enabled (edit mode)', () => {
    renderForm(false);
    expect(screen.queryByTestId('skill-form-import-skillmd')).not.toBeInTheDocument();
  });
});
