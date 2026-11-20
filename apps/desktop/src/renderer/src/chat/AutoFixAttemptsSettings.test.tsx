// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { AutoFixAttemptsSettings, autoFixAttemptsSummary, useAutoFixAttempts } from './AutoFixAttemptsSettings';

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

const getAutoFixAttempts = vi.fn<() => Promise<number>>();
const setAutoFixAttempts = vi.fn<(attempts: number) => Promise<number>>();

function Harness() {
  const [attempts, save, error] = useAutoFixAttempts();
  return (
    <>
      <span data-testid="summary">{autoFixAttemptsSummary(attempts)}</span>
      <AutoFixAttemptsSettings attempts={attempts} onChange={next => void save(next)} error={error} />
    </>
  );
}

let root: Root;
let host: HTMLElement;
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function mount() {
  root = createRoot(host);
  await act(async () =>
    root.render(
      <CssVarsProvider theme={desktopTheme}>
        <Harness />
      </CssVarsProvider>
    )
  );
}

beforeEach(async () => {
  getAutoFixAttempts.mockReset().mockResolvedValue(5);
  setAutoFixAttempts.mockReset().mockImplementation(async attempts => attempts);
  Object.assign(window, { b4m: { pullRequests: { getAutoFixAttempts, setAutoFixAttempts } } });
  host = document.createElement('div');
  document.body.appendChild(host);
  await mount();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('AutoFixAttemptsSettings', () => {
  it('shows the saved value and saves a new one picked from the list', async () => {
    expect(byTestId('summary')?.textContent).toBe('Up to 5 attempts per pull request');
    expect(byTestId('settings-autofix-attempts-select')?.textContent).toBe('5');

    await act(async () => byTestId('settings-autofix-attempts-select')?.click());
    expect(byTestId('settings-autofix-attempts-option-1')).not.toBeNull();
    expect(byTestId('settings-autofix-attempts-option-20')).not.toBeNull();
    expect(byTestId('settings-autofix-attempts-option-21')).toBeNull();
    await act(async () => byTestId('settings-autofix-attempts-option-2')?.click());

    expect(setAutoFixAttempts).toHaveBeenCalledWith(2);
    expect(byTestId('summary')?.textContent).toBe('Up to 2 attempts per pull request');
  });

  it('shows what main saved, not what was picked', async () => {
    setAutoFixAttempts.mockResolvedValueOnce(5);
    await act(async () => byTestId('settings-autofix-attempts-select')?.click());
    await act(async () => byTestId('settings-autofix-attempts-option-1')?.click());
    expect(byTestId('summary')?.textContent).toBe('Up to 5 attempts per pull request');
  });

  it('says when the value could not be saved', async () => {
    setAutoFixAttempts.mockRejectedValueOnce(new Error('disk full'));
    await act(async () => byTestId('settings-autofix-attempts-select')?.click());
    await act(async () => byTestId('settings-autofix-attempts-option-3')?.click());
    expect(byTestId('settings-autofix-attempts-error')?.textContent).toContain('Could not save this setting');
    expect(byTestId('summary')?.textContent).toBe('Up to 5 attempts per pull request');
  });

  it('says when the value could not be loaded', async () => {
    await act(async () => root.unmount());
    getAutoFixAttempts.mockRejectedValueOnce(new Error('no store'));
    await mount();
    expect(byTestId('settings-autofix-attempts-error')?.textContent).toContain('Could not load this setting');
    expect(byTestId('summary')?.textContent).toBe('Loading');
  });

  it('says one attempt in the singular', () => {
    expect(autoFixAttemptsSummary(1)).toBe('Up to 1 attempt per pull request');
  });
});
