// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AMBIENT_IDLE_MS, ambientHeld, isEditable, isPrintableKey, useAmbientSettle } from './ambient';
import { createThemedMount, query } from './testUtils';

const themed = createThemedMount();

afterEach(() => {
  themed.unmount();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

const key = (init: Partial<KeyboardEvent>) => ({
  key: 'a',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  isComposing: false,
  ...init,
});

describe('isPrintableKey', () => {
  it('takes a typed character', () => {
    expect(isPrintableKey(key({ key: 'a' }))).toBe(true);
    expect(isPrintableKey(key({ key: '?' }))).toBe(true);
  });

  it('leaves named keys, shortcuts and composition alone', () => {
    expect(isPrintableKey(key({ key: 'Escape' }))).toBe(false);
    expect(isPrintableKey(key({ key: 'Shift' }))).toBe(false);
    expect(isPrintableKey(key({ key: 'k', metaKey: true }))).toBe(false);
    expect(isPrintableKey(key({ key: 'k', ctrlKey: true }))).toBe(false);
    expect(isPrintableKey(key({ key: 'a', isComposing: true }))).toBe(false);
  });
});

describe('isEditable', () => {
  it('knows a field from the rest of the page', () => {
    const input = document.createElement('input');
    const button = document.createElement('button');
    expect(isEditable(input)).toBe(true);
    expect(isEditable(document.createElement('textarea'))).toBe(true);
    expect(isEditable(button)).toBe(false);
    expect(isEditable(window)).toBe(false);
    expect(isEditable(null)).toBe(false);
  });
});

describe('ambientHeld', () => {
  const add = (html: string) => {
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    return host;
  };

  it('is free on a page with nothing open', () => {
    add('<textarea data-testid="chat-composer-input"></textarea><button>ok</button>');
    expect(ambientHeld(document)).toBe(false);
  });

  it('holds for a composer draft, focused or not', () => {
    const host = add('<textarea data-testid="chat-composer-input"></textarea>');
    host.querySelector('textarea')!.value = 'half a thought';
    expect(ambientHeld(document)).toBe(true);
  });

  it('holds for text in the focused field but not for an empty focused composer', () => {
    const host = add('<textarea data-testid="chat-composer-input"></textarea><input id="other" />');
    host.querySelector('textarea')!.focus();
    expect(ambientHeld(document)).toBe(false);
    const other = host.querySelector<HTMLInputElement>('#other')!;
    other.value = 'search';
    other.focus();
    expect(ambientHeld(document)).toBe(true);
  });

  it('is free beside an expanded tree row, which is not a popup', () => {
    add('<div role="treeitem" aria-expanded="true"></div>');
    expect(ambientHeld(document)).toBe(false);
  });

  it.each([
    ['an open menu', '<div role="menu"></div>'],
    ['an expanded menu button', '<button aria-haspopup="menu" aria-expanded="true"></button>'],
    ['an open combobox', '<input role="combobox" aria-expanded="true" />'],
    ['a modal dialog', '<div aria-modal="true"></div>'],
    ['the peek drawer or order slip', '<div data-ambient-hold></div>'],
  ])('holds for %s', (_label, html) => {
    add(html);
    expect(ambientHeld(document)).toBe(true);
  });
});

describe('useAmbientSettle', () => {
  const onSettledKey = vi.fn();
  let held = false;
  let enabled = true;

  function Harness() {
    const { settled } = useAmbientSettle({ enabled, held: () => held, onSettledKey });
    return (
      <div data-testid="harness" data-settled={settled}>
        <div data-testid="quiet" data-ambient-quiet />
        <input data-testid="field" hidden={settled} />
      </div>
    );
  }

  const settled = () => query('harness')?.getAttribute('data-settled') === 'true';
  const idle = (ms = AMBIENT_IDLE_MS) => act(() => vi.advanceTimersByTime(ms));
  const fire = (target: EventTarget, event: Event) => act(() => void target.dispatchEvent(event));

  beforeEach(() => {
    vi.useFakeTimers();
    held = false;
    enabled = true;
    onSettledKey.mockReset();
  });

  it('settles after the idle spell and wakes on pointer movement', async () => {
    await themed.render(<Harness />);
    await idle(AMBIENT_IDLE_MS - 1);
    expect(settled()).toBe(false);
    await idle(1);
    expect(settled()).toBe(true);

    await fire(window, new Event('pointermove'));
    expect(settled()).toBe(false);
  });

  it('restarts the wait on input, so a busy user never sees it settle', async () => {
    await themed.render(<Harness />);
    await idle(AMBIENT_IDLE_MS - 1000);
    await fire(window, new Event('wheel'));
    await idle(AMBIENT_IDLE_MS - 1000);
    expect(settled()).toBe(false);
  });

  it('waits again while something holds it', async () => {
    held = true;
    await themed.render(<Harness />);
    await idle();
    expect(settled()).toBe(false);
    held = false;
    await idle();
    expect(settled()).toBe(true);
  });

  it('stays settled under pointer input on a quiet card, but wakes for a key there', async () => {
    await themed.render(<Harness />);
    await idle();
    const quiet = query('quiet')!;
    await fire(quiet, new Event('pointermove', { bubbles: true }));
    await fire(quiet, new Event('pointerdown', { bubbles: true }));
    expect(settled()).toBe(true);
    await fire(quiet, new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(settled()).toBe(false);
  });

  it('hands a key pressed while settled to onSettledKey, and only then', async () => {
    await themed.render(<Harness />);
    await fire(window, new KeyboardEvent('keydown', { key: 'a' }));
    expect(onSettledKey).not.toHaveBeenCalled();
    await idle();
    await fire(window, new KeyboardEvent('keydown', { key: 'b' }));
    expect(onSettledKey).toHaveBeenCalledTimes(1);
    expect(onSettledKey.mock.calls[0][0].key).toBe('b');
    expect(settled()).toBe(false);
  });

  it('gives focus back to the field it hid', async () => {
    await themed.render(<Harness />);
    const field = query('field')!;
    field.focus();
    await idle();
    expect(settled()).toBe(true);
    field.blur();
    await fire(window, new Event('pointermove'));
    expect(document.activeElement).toBe(field);
  });

  it('never settles while disabled, and disabling wakes it', async () => {
    await themed.render(<Harness />);
    await idle();
    expect(settled()).toBe(true);
    enabled = false;
    await themed.render(<Harness />);
    expect(settled()).toBe(false);
    await idle();
    expect(settled()).toBe(false);
  });
});
