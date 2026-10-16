// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatErrorDetail } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatErrorDetails, ReplyErrorCard } from './ReplyErrorCard';

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

const DETAIL: ChatErrorDetail = {
  requestId: 'req-abc',
  model: 'gpt-x',
  code: 'provider_error',
  kind: 'connection_lost',
  transportCode: 'UND_ERR_SOCKET',
  elapsedMs: 649_000,
};
const FAILED_AT = '2026-10-16T06:40:13.000Z';
const MESSAGE = 'Lost the connection to the model provider after 10m 49s (no data for 10m 49s)';

describe('formatErrorDetails', () => {
  it('lists what the server logs can be searched by, one line each, skipping what is unknown', () => {
    expect(formatErrorDetails(DETAIL, FAILED_AT)).toBe(
      [
        'Request ID: req-abc',
        'Model: gpt-x',
        'Code: provider_error',
        'Kind: connection_lost',
        'Transport code: UND_ERR_SOCKET',
        'Elapsed: 10m 49s (649000 ms)',
        `Time: ${FAILED_AT}`,
      ].join('\n')
    );
  });
});

describe('ReplyErrorCard', () => {
  let container: HTMLDivElement;
  let root: Root;
  const writeText = vi.fn<(text: string) => Promise<void>>();

  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (detail?: ChatErrorDetail) =>
    act(() =>
      root.render(
        <CssVarsProvider>
          <ReplyErrorCard error={MESSAGE} failedAt={FAILED_AT} {...(detail ? { detail } : {})} />
        </CssVarsProvider>
      )
    );

  const copyButton = () => container.querySelector<HTMLButtonElement>('[data-testid="chat-error-copy-btn"]');

  it('shows the specific message the server sent', () => {
    render(DETAIL);
    expect(container.querySelector('[data-testid="chat-message-error"]')?.textContent).toContain(MESSAGE);
  });

  it('copies the details and says so', async () => {
    render(DETAIL);
    await act(async () => copyButton()!.click());
    expect(writeText).toHaveBeenCalledWith(formatErrorDetails(DETAIL, FAILED_AT));
    expect(copyButton()!.textContent).toBe('Copied');
  });

  it('offers no copy action for a failure with nothing to trace it by', () => {
    render();
    expect(copyButton()).toBeNull();
  });
});
