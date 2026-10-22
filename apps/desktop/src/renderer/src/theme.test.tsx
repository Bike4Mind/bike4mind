// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CssVarsProvider } from '@mui/joy/styles';
import Dropdown from '@mui/joy/Dropdown';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Tooltip from '@mui/joy/Tooltip';
import { avoidPageModifier } from './chat/agentBrowser';
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

  it('runs every tooltip and menu through the modifier that keeps them off the browser page', async () => {
    const avoid = vi.spyOn(avoidPageModifier, 'fn');
    await act(async () =>
      root.render(
        <CssVarsProvider theme={desktopTheme}>
          <Tooltip title="Context 27k / 400k" open>
            <span>ring</span>
          </Tooltip>
          <Dropdown open>
            <MenuButton>model</MenuButton>
            <Menu>
              <MenuItem>GPT-5</MenuItem>
            </Menu>
          </Dropdown>
        </CssVarsProvider>
      )
    );

    const placed = avoid.mock.calls.map(([{ state }]) =>
      (state as unknown as { elements: { popper: Element } }).elements.popper.getAttribute('role')
    );
    expect(new Set(placed)).toEqual(new Set(['tooltip', 'menu']));
    avoid.mockRestore();
  });
});
