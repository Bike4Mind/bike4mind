import { afterEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import MarkdownViewer from './MarkdownViewer';

vi.mock('../Charts/MermaidChart', () => ({ default: () => <div data-testid="mermaid" /> }));

const appTheme = extendTheme({ ...getThemeConfig() });

const renderDoc = (content: string) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <MarkdownViewer content={content} />
    </CssVarsProvider>
  );

describe('MarkdownViewer empty fences', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('draws an empty tagged fence as an empty code block, not the word undefined', () => {
    const { container } = renderDoc('before\n\n```ts\n```\n\nafter');
    expect(screen.getAllByTestId('markdown-code-block')).toHaveLength(1);
    expect(screen.getByTestId('markdown-code-block').querySelector('pre')?.textContent).toBe('');
    expect(container.textContent).not.toContain('undefined');
  });

  it.each([
    ['empty', '', ''],
    ['nonempty', 'const value = 1;\n\n', 'const value = 1;\n'],
  ])('copies %s fence content without changing its whitespace', async (_name, content, expected) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    renderDoc(`\`\`\`ts\n${content}\`\`\``);
    fireEvent.click(screen.getByTestId('markdown-code-copy-btn'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expected));
    expect(screen.getByTestId('markdown-code-block').querySelector('pre')?.textContent).toBe(expected);
  });

  it('keeps an empty untagged fence empty', () => {
    const { container } = renderDoc('```\n```');
    expect(container.querySelector('code')?.textContent).toBe('');
    expect(container.textContent).not.toContain('undefined');
  });
});
