// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReasoningRow } from './ReasoningRow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The row is opened by setting `open` and dispatching 'toggle' rather than by clicking the
 * summary: a click on a summary is answered by the browser's own activation behaviour for
 * `details`, which jsdom does not run, so a click here would assert nothing. React's handler
 * listens for the event either way, which is the part this file is about.
 */
describe('ReasoningRow', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (reasoning: string) => act(() => root.render(<ReasoningRow reasoning={reasoning} />));

  const open = () =>
    act(() => {
      const details = container.querySelector<HTMLDetailsElement>('[data-testid="chat-reasoning-row"]');
      if (details) {
        details.open = true;
        details.dispatchEvent(new Event('toggle'));
      }
    });

  it('names the thought in one line and keeps the thought itself out of the document', () => {
    render(
      'The user wants the status line to stop repeating the transcript, so the fix is to\ndisclose only what is hidden.'
    );

    expect(container.querySelector('[data-testid="chat-reasoning-row-summary"]')?.textContent).toBe(
      'Thinking: The user wants the status line to stop repeating the ...'
    );
    expect(container.querySelector('[data-testid="chat-reasoning-row-body"]')).toBeNull();
    expect(container.textContent).not.toContain('disclose only what is hidden');
  });

  it('shows the whole thought once it is opened', () => {
    render('first line\nsecond line');
    open();

    expect(container.querySelector('[data-testid="chat-reasoning-row-body"]')?.textContent).toBe(
      'first line\nsecond line'
    );
  });

  it('draws nothing at all for a round that recorded no thinking', () => {
    render('   ');
    expect(container.querySelector('[data-testid="chat-reasoning-row"]')).toBeNull();
  });

  it('falls back to the bare word when the thought is too short to preview', () => {
    render('ok');
    expect(container.querySelector('[data-testid="chat-reasoning-row-summary"]')?.textContent).toBe('Thinking: ok');
  });
});
