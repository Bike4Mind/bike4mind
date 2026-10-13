// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CssVarsProvider } from '@mui/joy/styles';
import Tooltip from '@mui/joy/Tooltip';
import { desktopTheme, TOOLTIP_MAX_WIDTH } from './theme';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('the desktop theme', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // CssVarsProvider reads the system color scheme, which jsdom does not implement.
    window.matchMedia ??= (query: string) =>
      ({ matches: false, media: query, addListener: () => {}, removeListener: () => {} }) as unknown as MediaQueryList;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('caps every tooltip at a width that wraps, however long its text', async () => {
    await act(async () =>
      root.render(
        <CssVarsProvider theme={desktopTheme}>
          <Tooltip title={`/srv/${'a-very-long-folder-name/'.repeat(12)}end`} open>
            <span>anchor</span>
          </Tooltip>
        </CssVarsProvider>
      )
    );

    const style = getComputedStyle(document.body.querySelector('[role="tooltip"]') as HTMLElement);
    expect(style.maxWidth).toContain(`${TOOLTIP_MAX_WIDTH}px`);
    expect(style.overflowWrap).toBe('anywhere');
  });
});
