// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyMessageButton } from './CopyMessageButton';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom ships no matchMedia, and Joy's colour-scheme provider asks for one on mount.
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

let container: HTMLDivElement;
let root: Root;
const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset();
  // jsdom has no clipboard; the app's renderer writes text through this same API.
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <CssVarsProvider>
        <CopyMessageButton text={'# Title\n\nSee [docs](https://x.com).'} testId="test-copy-btn" />
      </CssVarsProvider>
    )
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const button = () => container.querySelector<HTMLButtonElement>('[data-testid="test-copy-btn"]')!;
const status = () => container.querySelector<HTMLElement>('[data-testid="test-copy-btn-status"]')!;

async function press(): Promise<void> {
  await act(async () => button().click());
}

describe('CopyMessageButton', () => {
  it('is a labelled, focusable button before anything happens', () => {
    expect(button().tagName).toBe('BUTTON');
    expect(button().getAttribute('aria-label')).toBe('Copy message');
    expect(button().dataset.state).toBe('idle');
  });

  it('keeps an empty live region mounted so the first outcome is announced', () => {
    expect(status().getAttribute('role')).toBe('status');
    expect(status().textContent).toBe('');
  });

  it('puts the exact text on the clipboard and says it did', async () => {
    writeText.mockResolvedValue(undefined);

    await press();

    expect(writeText).toHaveBeenCalledExactlyOnceWith('# Title\n\nSee [docs](https://x.com).');
    expect(button().dataset.state).toBe('copied');
    expect(button().getAttribute('aria-label')).toBe('Copied');
    expect(status().textContent).toBe('Copied');
  });

  it('goes back to offering a copy once the confirmation has been seen', async () => {
    vi.useFakeTimers();
    writeText.mockResolvedValue(undefined);

    await press();
    expect(button().dataset.state).toBe('copied');

    act(() => vi.advanceTimersByTime(2000));
    expect(button().dataset.state).toBe('idle');
    expect(status().textContent).toBe('');
  });

  it('says so, and logs why, when the clipboard refuses the write', async () => {
    const failure = new Error('Document is not focused.');
    writeText.mockRejectedValue(failure);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await press();

    expect(button().dataset.state).toBe('failed');
    expect(button().getAttribute('aria-label')).toBe('Could not copy to the clipboard');
    expect(status().textContent).toBe('Could not copy to the clipboard');
    expect(logged).toHaveBeenCalledWith(expect.any(String), failure);
  });
});
