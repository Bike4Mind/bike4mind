import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
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
  it('draws an empty tagged fence as an empty code block, not the word undefined', () => {
    const { container } = renderDoc('before\n\n```ts\n```\n\nafter');
    expect(container.querySelectorAll('.markdown-viewer-code-block')).toHaveLength(1);
    expect(container.querySelector('.markdown-viewer-code-block pre')?.textContent).toBe('');
    expect(container.textContent).not.toContain('undefined');
  });
});
