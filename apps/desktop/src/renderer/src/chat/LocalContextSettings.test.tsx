// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalContextSetting } from '@shared/localContextSetting';
import { desktopTheme } from '../theme';
import { LocalContextSettings, localContextSummary, useLocalContextSetting } from './LocalContextSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

const getLocalContext = vi.fn<() => Promise<LocalContextSetting>>();
const setLocalContext = vi.fn<(setting: LocalContextSetting) => Promise<LocalContextSetting>>();

function Harness() {
  const [setting, save, error] = useLocalContextSetting();
  return (
    <>
      <span data-testid="summary">{localContextSummary(setting)}</span>
      <LocalContextSettings setting={setting} onChange={next => void save(next)} error={error} />
    </>
  );
}

let root: Root;
let host: HTMLElement;
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(async () => {
  getLocalContext.mockReset().mockResolvedValue({ mode: 'auto' });
  setLocalContext.mockReset().mockImplementation(async setting => setting);
  Object.assign(window, { b4m: { chat: { getLocalContext, setLocalContext } } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <CssVarsProvider theme={desktopTheme}>
        <Harness />
      </CssVarsProvider>
    )
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('LocalContextSettings', () => {
  it('shows the saved choice and saves a fixed size picked from the list', async () => {
    expect(byTestId('summary')?.textContent).toBe("Auto: 16K to 64K tokens, as this computer's memory allows");
    expect(byTestId('settings-local-context-select')?.textContent).toBe('Auto (fits this computer)');

    await act(async () => byTestId('settings-local-context-select')?.click());
    await act(async () => byTestId('settings-local-context-option-32768')?.click());

    expect(setLocalContext).toHaveBeenCalledWith({ mode: 'fixed', tokens: 32768 });
    expect(byTestId('summary')?.textContent).toBe('32K tokens for every local model');
  });

  it('says when the choice could not be saved', async () => {
    setLocalContext.mockRejectedValueOnce(new Error('disk full'));
    await act(async () => byTestId('settings-local-context-select')?.click());
    await act(async () => byTestId('settings-local-context-option-16384')?.click());

    expect(byTestId('settings-local-context-error')?.textContent).toContain('Could not save this setting');
    expect(byTestId('summary')?.textContent).toMatch(/^Auto/);
  });
});
