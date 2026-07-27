import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { PromptMeta } from '@bike4mind/common';
import PromptMetaInspector, { usePromptMetaInspector } from './PromptMetaInspector';

// react-draggable needs a real DOM node and adds nothing to what these tests check.
vi.mock('react-draggable', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('./ContextVisualizer', () => ({ default: () => <div /> }));
vi.mock('./StatusTimeline', () => ({ default: () => <div /> }));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

// The real string this PR writes into promptMeta.warnings. It is a full sentence, and the two facts
// a reader needs (the excluded model and the file count) sit at the START, so a truncating renderer
// hides exactly the payload.
const KB_WARNING =
  'Partial knowledge-base results: 1 file(s) (about 1 chunks) were excluded because they are ' +
  "embedded with text-embedding-3-small, not the query's text-embedding-ada-002. Re-embed those " +
  'files to include them.';

const show = (promptMeta: Partial<PromptMeta>) =>
  usePromptMetaInspector.getState().setPromptMeta(promptMeta as PromptMeta);

describe('PromptMetaInspector warnings', () => {
  beforeEach(() => {
    usePromptMetaInspector.getState().setPromptMeta(null);
  });

  it('renders the whole warning, not a truncated prefix', () => {
    // Regression: these were rendered in a MUI Joy Chip, a single-line control that ellipsizes, so
    // in the fixed-width panel the sentence was cut off before naming the model or the count.
    show({ warnings: [KB_WARNING] });
    render(<PromptMetaInspector />, { wrapper: TestWrapper });

    const item = screen.getByTestId('prompt-meta-warning-item');
    expect(item.textContent).toBe(KB_WARNING);
    // The facts the acceptance criterion asks for must both be present.
    expect(item.textContent).toContain('text-embedding-3-small');
    expect(item.textContent).toContain('1 file(s)');
  });

  it('lets a long warning wrap instead of clipping it to one line', () => {
    show({ warnings: [KB_WARNING] });
    render(<PromptMetaInspector />, { wrapper: TestWrapper });

    const text = screen.getByTestId('prompt-meta-warning-item').firstElementChild as HTMLElement;
    const style = window.getComputedStyle(text);
    expect(style.whiteSpace).not.toBe('nowrap');
    expect(style.textOverflow).not.toBe('ellipsis');
  });

  it('renders every warning when more than one producer has written', () => {
    // warnings accretes across producers (response truncation + knowledge-base partial results).
    show({ warnings: ['Response was truncated against the output-token limit.', KB_WARNING] });
    render(<PromptMetaInspector />, { wrapper: TestWrapper });

    const items = screen.getAllByTestId('prompt-meta-warning-item');
    expect(items).toHaveLength(2);
    expect(items[1].textContent).toBe(KB_WARNING);
  });

  it('shows no warnings section on a healthy prompt', () => {
    show({ warnings: [] });
    render(<PromptMetaInspector />, { wrapper: TestWrapper });

    expect(screen.queryByTestId('prompt-meta-warning-item')).toBeNull();
    expect(screen.queryByText('Warnings')).toBeNull();
  });

  it('renders a prompt error in full too', () => {
    const err = 'The model refused the request because the attached file could not be parsed as UTF-8 text.';
    show({ promptErrors: [err] });
    render(<PromptMetaInspector />, { wrapper: TestWrapper });

    expect(screen.getByTestId('prompt-meta-error-item').textContent).toBe(err);
  });
});
