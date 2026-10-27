// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalContextFit, LocalContextSetting } from '@shared/localContextSetting';
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
const getLocalContextFit = vi.fn<() => Promise<LocalContextFit>>();

function Harness() {
  const [setting, save, error, fit] = useLocalContextSetting();
  return (
    <>
      <span data-testid="summary">{localContextSummary(setting)}</span>
      <LocalContextSettings setting={setting} onChange={next => void save(next)} error={error} fit={fit} />
    </>
  );
}

let root: Root;
let host: HTMLElement;
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(async () => {
  getLocalContext.mockReset().mockResolvedValue({ mode: 'auto' });
  setLocalContext.mockReset().mockImplementation(async setting => setting);
  getLocalContextFit
    .mockReset()
    .mockResolvedValue({ 131072: ['qwen3:8b'], 262144: ['qwen3:8b', 'gpt-oss:20b', 'gemma3:27b'] });
  Object.assign(window, { b4m: { chat: { getLocalContext, setLocalContext, getLocalContextFit } } });
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
    expect(byTestId('summary')?.textContent).toBe(
      "Auto: 16K tokens or more as this computer's memory allows, less for a model trained on less"
    );
    expect(byTestId('settings-local-context-select')?.textContent).toBe('Auto (fits this computer)');

    await act(async () => byTestId('settings-local-context-select')?.click());
    await act(async () => byTestId('settings-local-context-option-32768')?.click());

    expect(setLocalContext).toHaveBeenCalledWith({ mode: 'fixed', tokens: 32768 });
    expect(byTestId('summary')?.textContent).toBe('32K tokens for every local model, less for a model trained on less');
    expect(byTestId('settings-local-context-select')?.textContent).toBe('32K tokens');
  });

  it('notes the sizes that may not fit this computer, and still lets them be picked', async () => {
    await act(async () => byTestId('settings-local-context-select')?.click());
    expect(byTestId('settings-local-context-option-16384-note')).toBeNull();
    expect(byTestId('settings-local-context-option-131072-note')?.textContent).toBe(
      "May not fit this computer's memory with qwen3:8b"
    );
    expect(byTestId('settings-local-context-option-262144-note')?.textContent).toBe(
      "May not fit this computer's memory with 3 local models"
    );

    await act(async () => byTestId('settings-local-context-option-262144')?.click());
    expect(setLocalContext).toHaveBeenCalledWith({ mode: 'fixed', tokens: 262144 });
    expect(byTestId('settings-local-context-fit-note')?.textContent).toBe(
      "May not fit this computer's memory with 3 local models"
    );
  });

  it('says when the choice could not be saved', async () => {
    setLocalContext.mockRejectedValueOnce(new Error('disk full'));
    await act(async () => byTestId('settings-local-context-select')?.click());
    await act(async () => byTestId('settings-local-context-option-16384')?.click());

    expect(byTestId('settings-local-context-error')?.textContent).toContain('Could not save this setting');
    expect(byTestId('summary')?.textContent).toMatch(/^Auto/);
  });

  it('says when the saved choice could not be loaded', async () => {
    await act(async () => root.unmount());
    getLocalContext.mockRejectedValueOnce(new Error('no store'));
    root = createRoot(host);
    await act(async () =>
      root.render(
        <CssVarsProvider theme={desktopTheme}>
          <Harness />
        </CssVarsProvider>
      )
    );

    expect(byTestId('settings-local-context-error')?.textContent).toContain('Could not load this setting');
  });
});
