import { CssVarsProvider } from '@mui/joy/styles';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CustomizeNavItem, CustomizeScreen } from './CustomizePanel';

/**
 * Rendered to a string, like DiffView's tests and for the same reason: this package's vitest
 * runs on `node`. What is worth asking of a screen that replaced a collapse is answerable from
 * the markup - is every setting on the page, and is the one that used to need a window on it
 * too, rather than behind a button that opens one.
 */
const markup = (node: React.ReactNode) => renderToStaticMarkup(<CssVarsProvider>{node}</CssVarsProvider>);

const testids = (html: string) => html.match(/data-testid="[^"]+"/g) ?? [];

describe('the Customize screen', () => {
  const html = markup(<CustomizeScreen onClose={() => {}} />);

  it('puts every setting on the page', () => {
    expect(html).toContain('data-entry="appearance"');
    expect(html).toContain('data-entry="prompt-suggestions"');
    expect(html).toContain('data-entry="mcp"');
  });

  it('offers appearance as a three-way choice rather than one that cycles', () => {
    for (const mode of ['system', 'light', 'dark']) {
      expect(html).toContain(`customize-appearance-${mode}-btn`);
    }
  });

  // The whole point of the screen: a row that opened a dialog would have added a navigation
  // step and nothing else, so the MCP list and its add button are on the screen itself.
  it('manages MCP servers inline, with no dialog left to open', () => {
    expect(html).toContain('data-testid="mcp-settings"');
    expect(html).toContain('data-testid="mcp-settings-add-btn"');
    expect(testids(html)).not.toContain('data-testid="customize-entry-btn"');
  });

  it('keeps a way out of the screen', () => {
    expect(html).toContain('data-testid="customize-close-btn"');
  });
});

describe('the Customize nav row', () => {
  it('opens the screen and keeps its stable hook', () => {
    expect(markup(<CustomizeNavItem onOpen={() => {}} />)).toContain('data-testid="chat-customize-btn"');
  });

  /**
   * Nothing is failing in a renderer that has not talked to main yet, so the chip is absent -
   * the badge is a report of a real problem, not decoration on the row.
   */
  it('shows no attention badge when nothing needs attention', () => {
    expect(markup(<CustomizeNavItem onOpen={() => {}} />)).not.toContain('customize-attention-chip');
  });
});
