// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeedbackSubmitResult } from '@shared/feedback';
import { SendFeedbackDialog } from './SendFeedbackDialog';

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

let root: Root | null = null;
let host: HTMLElement | null = null;
const el = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(send: () => Promise<FeedbackSubmitResult>) {
  const sendFeedback = vi.fn(send);
  const onClose = vi.fn();
  (window as unknown as { b4m: unknown }).b4m = { account: { sendFeedback } };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <CssVarsProvider>
        <SendFeedbackDialog onClose={onClose} />
      </CssVarsProvider>
    )
  );
  return { sendFeedback, onClose };
}

function type(text: string) {
  const input = el('send-feedback-textarea') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('SendFeedbackDialog', () => {
  it('requires nonblank feedback and submits the written message', async () => {
    const { sendFeedback } = mount(async () => ({ ok: true }));
    expect(el('send-feedback-submit-btn')?.hasAttribute('disabled')).toBe(true);
    type('A suggestion');
    await act(async () => el('send-feedback-submit-btn')?.click());
    expect(sendFeedback).toHaveBeenCalledWith('A suggestion');
    expect(el('send-feedback-notice')?.textContent).toContain('Thank you');
    expect(el('send-feedback-submit-btn')).toBeNull();
    expect(el('send-feedback-dialog')?.textContent).toContain('Feedback sent');
    expect(el('send-feedback-close-btn')?.textContent).toBe('Close');
  });

  it('keeps the draft and offers a retry after an error', async () => {
    const { sendFeedback } = mount(async () => ({ ok: false, error: 'Try again' }));
    type('My report');
    await act(async () => el('send-feedback-submit-btn')?.click());
    expect(el('send-feedback-notice')?.textContent).toContain('Try again');
    expect((el('send-feedback-textarea') as HTMLTextAreaElement).value).toBe('My report');
    expect(el('send-feedback-submit-btn')).not.toBeNull();
    expect(sendFeedback).toHaveBeenCalledTimes(1);
  });

  it('shows a warning when the report is saved but delivery fails', async () => {
    mount(async () => ({ ok: true, warning: 'Saved, but could not notify the team.' }));
    type('My report');
    await act(async () => el('send-feedback-submit-btn')?.click());
    expect(el('send-feedback-notice')?.textContent).toContain('could not notify');
    expect(el('send-feedback-submit-btn')).toBeNull();
    expect(el('send-feedback-dialog')?.textContent).toContain('Feedback saved');
  });
});
