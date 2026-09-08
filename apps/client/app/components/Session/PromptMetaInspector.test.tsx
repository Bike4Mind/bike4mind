import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
    // Asserted POSITIVELY: a `not.toBe('nowrap')` passes vacuously when styles fail to inject,
    // which would hide the very regression this test exists for.
    expect(style.whiteSpace).toBe('normal');
    expect(style.wordBreak).toBe('break-word');
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

describe('PromptMetaInspector tools reporting: absent is not empty', () => {
  // offeredTools is IS part of PromptMetaZodSchema and IS written server-side, but is routinely
  // absent on turns from before that write existed. The report used to read
  // `offeredTools?.length > 0`, which is falsy for undefined, and printed a confident
  // "NONE (empty array)" with count 0 - accusing the tool pipeline when the real signal was
  // "nothing was captured".
  const withTools = (offeredTools?: string[]) =>
    show({ ...(offeredTools === undefined ? {} : { offeredTools }) } as Partial<PromptMeta>);

  const copiedMarkdown = () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    render(<PromptMetaInspector />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('prompt-meta-copy-md-btn'));
    return writeText.mock.calls[0][0] as string;
  };

  beforeEach(() => {
    usePromptMetaInspector.getState().setPromptMeta(null);
  });

  it('reports an absent offeredTools field as not captured, never as an empty array', () => {
    withTools(undefined);
    const md = copiedMarkdown();

    expect(md).toContain('**Tools Sent to Model**: not captured (promptMeta.offeredTools absent)');
    expect(md).toContain('**Tools Count**: not captured');
    expect(md).not.toContain('NONE (empty array)');
    // The Issues section must point at the real cause instead of staying silent, which is what made
    // an uncaptured report indistinguishable from a healthy tool-free one.
    expect(md).toContain('NOT CAPTURED');
  });

  it('does not call a genuinely empty tools array CRITICAL - forced retrieval runs tool-free', () => {
    withTools([]);
    const md = copiedMarkdown();

    expect(md).toContain('**Tools Sent to Model**: NONE (empty array)');
    expect(md).toContain('**Tools Count**: 0');
    expect(md).not.toContain('CRITICAL');
    expect(md).toContain('forced knowledge retrieval');
  });

  it('still lists tool names when tools were captured', () => {
    withTools(['search_knowledge_base', 'web_search']);
    const md = copiedMarkdown();

    expect(md).toContain('**Tools Sent to Model**: search_knowledge_base, web_search');
    expect(md).toContain('**Tools Count**: 2');
    expect(md).not.toContain('not captured');
  });

  it('distinguishes absent from empty in the panel, and flags neither as danger', () => {
    withTools(undefined);
    const { unmount } = render(<PromptMetaInspector />, { wrapper: TestWrapper });
    expect(screen.getByTestId('prompt-meta-tools-count-chip').textContent).toBe('not captured');
    expect(screen.getByTestId('prompt-meta-tools-absent-chip')).toBeTruthy();
    expect(screen.queryByTestId('prompt-meta-tools-empty-chip')).toBeNull();
    unmount();

    withTools([]);
    render(<PromptMetaInspector />, { wrapper: TestWrapper });
    expect(screen.getByTestId('prompt-meta-tools-count-chip').textContent).toBe('0 tools');
    expect(screen.getByTestId('prompt-meta-tools-empty-chip')).toBeTruthy();
    expect(screen.queryByTestId('prompt-meta-tools-absent-chip')).toBeNull();
  });

  it('renders the panel honestly when offeredTools was actually recorded on the wire', () => {
    withTools(['search_knowledge_base']);
    render(<PromptMetaInspector />, { wrapper: TestWrapper });
    expect(screen.getByTestId('prompt-meta-tools-count-chip').textContent).toBe('1 tools');
    expect(screen.getByText('search_knowledge_base')).toBeTruthy();
  });
});

describe('PromptMetaInspector timestamps', () => {
  beforeEach(() => {
    usePromptMetaInspector.getState().setPromptMeta(null);
  });

  it('renders generatedAt from the real schema field without a cast-and-hope', () => {
    show({ generatedAt: '2026-01-15T10:00:00.000Z' } as Partial<PromptMeta>);
    render(<PromptMetaInspector />, { wrapper: TestWrapper });
    expect(screen.getByText(/Generated: 2026-01-15/)).toBeTruthy();
  });

  it('falls back to the spliced-on quest createdAt when generatedAt is absent', () => {
    show({ createdAt: '2026-02-20T10:00:00.000Z' } as unknown as Partial<PromptMeta>);
    render(<PromptMetaInspector />, { wrapper: TestWrapper });
    expect(screen.getByText(/Generated: 2026-02-20/)).toBeTruthy();
  });

  it('renders the spliced-on quest updatedAt', () => {
    show({ updatedAt: '2026-03-10T10:00:00.000Z' } as unknown as Partial<PromptMeta>);
    render(<PromptMetaInspector />, { wrapper: TestWrapper });
    expect(screen.getByText(/Updated: 2026-03-10/)).toBeTruthy();
  });
});
