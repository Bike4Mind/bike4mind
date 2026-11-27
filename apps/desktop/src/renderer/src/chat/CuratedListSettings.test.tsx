// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useCuratedListSettings } from './CuratedListSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const get = vi.fn();
const save = vi.fn();
const unsubscribe = vi.fn();
let changed = () => {};
let root: Root;
let container: HTMLDivElement;

function SettingsProbe() {
  const { settings, error, reload, setEnabled, saving } = useCuratedListSettings();
  return (
    <div>
      <output>{error ?? (settings ? String(settings.enabled) : 'loading')}</output>
      <button onClick={() => void reload()}>Retry</button>
      <button disabled={saving} onClick={() => void setEnabled(false)}>
        Disable
      </button>
    </div>
  );
}

beforeEach(() => {
  get.mockReset().mockResolvedValue({ available: true, enabled: true });
  save.mockReset().mockResolvedValue({ available: true, enabled: false });
  unsubscribe.mockReset();
  Object.defineProperty(window, 'b4m', {
    configurable: true,
    value: {
      models: {
        getCuratedSettings: get,
        setCuratedEnabled: save,
        onCuratedChanged: (listener: () => void) => {
          changed = listener;
          return unsubscribe;
        },
      },
    },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  expect(unsubscribe).toHaveBeenCalledOnce();
  container.remove();
});

async function mount() {
  await act(async () => root.render(<SettingsProbe />));
}

it('re-reads the setting when another window changes it and unsubscribes on unmount', async () => {
  await mount();
  expect(container.querySelector('output')?.textContent).toBe('true');
  get.mockResolvedValue({ available: true, enabled: false });
  await act(async () => changed());
  expect(container.querySelector('output')?.textContent).toBe('false');
});

it('reports a failed settings read and lets the user retry', async () => {
  get.mockRejectedValueOnce(new Error('IPC unavailable'));
  await mount();
  expect(container.querySelector('output')?.textContent).toContain('Could not load');
  await act(async () => container.querySelector('button')?.click());
  expect(container.querySelector('output')?.textContent).toBe('true');
});

it('reports a failed save instead of silently keeping the previous switch state', async () => {
  await mount();
  save.mockRejectedValueOnce(new Error('IPC unavailable'));
  await act(async () => container.querySelectorAll('button')[1].click());
  expect(save).toHaveBeenCalledWith(false);
  expect(container.querySelector('output')?.textContent).toContain('Could not save');
});

it('ignores a stale settings read after a later change notification', async () => {
  let finish: (value: { available: boolean; enabled: boolean }) => void = () => {};
  get.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      })
  );
  await mount();
  get.mockResolvedValue({ available: true, enabled: false });
  await act(async () => changed());
  await act(async () => finish({ available: true, enabled: true }));
  expect(container.querySelector('output')?.textContent).toBe('false');
});
