// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TAVERN_DIALOGUE_ATTR } from './tavern/dialogue';
import { fillWindowKeyAction, useFillWindow, type FillWindow } from './useFillWindow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function Probe({ available, onRender }: { available: boolean; onRender(value: FillWindow): void }) {
  onRender(useFillWindow(available));
  return null;
}

function renderHook(initialProps: { available: boolean }) {
  const result: { current: FillWindow } = { current: { on: false, setOn: () => undefined } };
  const container = document.createElement('div');
  root = createRoot(container);
  const render = ({ available }: { available: boolean }) =>
    act(() => root?.render(<Probe available={available} onRender={value => (result.current = value)} />));
  render(initialProps);
  return { result, rerender: render };
}

function press(key: string, target: EventTarget = document.body, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function mount<T extends HTMLElement>(element: T): T {
  document.body.appendChild(element);
  return element;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('fillWindowKeyAction', () => {
  const keyEvent = (key: string, target: EventTarget, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    Object.defineProperty(event, 'target', { value: target });
    return event;
  };

  it('switches on F and leaves on Escape', () => {
    expect(fillWindowKeyAction(keyEvent('f', document.body), false)).toBe('enter');
    expect(fillWindowKeyAction(keyEvent('F', document.body), false)).toBe('enter');
    expect(fillWindowKeyAction(keyEvent('f', document.body), true)).toBe('exit');
    expect(fillWindowKeyAction(keyEvent('Escape', document.body), true)).toBe('exit');
    expect(fillWindowKeyAction(keyEvent('Escape', document.body), false)).toBeNull();
  });

  it('leaves a shortcut with a modifier to the app', () => {
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey'] as const)
      expect(fillWindowKeyAction(keyEvent('f', document.body, { [modifier]: true }), false)).toBeNull();
  });

  it('ignores keys typed into a field', () => {
    for (const tag of ['input', 'textarea'] as const) {
      const field = mount(document.createElement(tag));
      expect(fillWindowKeyAction(keyEvent('f', field), false)).toBeNull();
      expect(fillWindowKeyAction(keyEvent('Escape', field), true)).toBeNull();
    }
  });

  it('leaves the Tavern dialogue box its own keys', () => {
    const box = mount(document.createElement('div'));
    box.setAttribute(TAVERN_DIALOGUE_ATTR, '');
    const choice = box.appendChild(document.createElement('button'));
    expect(fillWindowKeyAction(keyEvent('Escape', choice), true)).toBeNull();
    expect(fillWindowKeyAction(keyEvent('f', choice), true)).toBeNull();
  });

  it('leaves keys inside an open menu or dialog alone', () => {
    const menu = mount(document.createElement('div'));
    menu.setAttribute('role', 'menu');
    expect(fillWindowKeyAction(keyEvent('Escape', menu), true)).toBeNull();
    expect(fillWindowKeyAction(keyEvent('f', menu), false)).toBeNull();
  });
});

describe('useFillWindow', () => {
  it('enters on F, leaves on Escape, and claims both keys', () => {
    const { result } = renderHook({ available: true });
    expect(result.current.on).toBe(false);

    expect(press('f').defaultPrevented).toBe(true);
    expect(result.current.on).toBe(true);

    expect(press('Escape').defaultPrevented).toBe(true);
    expect(result.current.on).toBe(false);
  });

  it('enters and leaves through setOn, the header buttons', () => {
    const { result } = renderHook({ available: true });
    act(() => result.current.setOn(true));
    expect(result.current.on).toBe(true);
    act(() => result.current.setOn(false));
    expect(result.current.on).toBe(false);
  });

  it('does not fire while typing in an input or textarea', () => {
    const { result } = renderHook({ available: true });
    press('f', mount(document.createElement('textarea')));
    expect(result.current.on).toBe(false);

    act(() => result.current.setOn(true));
    const escape = press('Escape', mount(document.createElement('input')));
    expect(escape.defaultPrevented).toBe(false);
    expect(result.current.on).toBe(true);
  });

  it('leaves Escape to the dialogue box while it has focus', () => {
    const { result } = renderHook({ available: true });
    act(() => result.current.setOn(true));
    const box = mount(document.createElement('div'));
    box.setAttribute(TAVERN_DIALOGUE_ATTR, '');
    press('Escape', box);
    expect(result.current.on).toBe(true);
  });

  it('leaves a key another handler already claimed', () => {
    const { result } = renderHook({ available: true });
    act(() => result.current.setOn(true));
    const drawer = mount(document.createElement('div'));
    drawer.addEventListener('keydown', event => event.preventDefault());
    press('Escape', drawer);
    expect(result.current.on).toBe(true);
  });

  it('ignores the keys and turns off for good while the Agent view is not shown', () => {
    const { result, rerender } = renderHook({ available: true });
    act(() => result.current.setOn(true));
    rerender({ available: false });
    expect(result.current.on).toBe(false);
    press('f');
    expect(result.current.on).toBe(false);

    rerender({ available: true });
    expect(result.current.on).toBe(false);
  });
});
