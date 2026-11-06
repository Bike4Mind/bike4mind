// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createThemedMount, el, query } from './testUtils';
import { ThreadDock, type ThreadDockMode } from './ThreadDock';

const themed = createThemedMount();
const STORAGE_KEY = 'b4m.orchestrator.dockWidth';

const renderDock = (mode: ThreadDockMode = 'docked') =>
  themed.render(
    <ThreadDock mode={mode} hostRef={() => {}}>
      <div data-testid="thread-content" />
    </ThreadDock>
  );

const handle = () => el('orchestrator-dock-resize-handle');
const dockWidth = () => el('orchestrator-dock').style.width || getComputedStyle(el('orchestrator-dock')).width;
const valueNow = () => Number(handle().getAttribute('aria-valuenow'));

const key = (name: string) =>
  act(() => {
    handle().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });
const pointer = (type: string, clientX: number) => new MouseEvent(type, { bubbles: true, clientX, button: 0 });

let innerWidth: number;

beforeEach(() => {
  window.localStorage.clear();
  innerWidth = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
});

afterEach(() => {
  themed.unmount();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
});

describe('ThreadDock', () => {
  it('docks at 380px behind an accessible separator', async () => {
    await renderDock();
    expect(handle().getAttribute('role')).toBe('separator');
    expect(handle().getAttribute('aria-orientation')).toBe('vertical');
    expect(valueNow()).toBe(380);
    expect(handle().getAttribute('aria-valuemin')).toBe('300');
    expect(handle().getAttribute('aria-valuemax')).toBe('720');
    expect(dockWidth()).toBe('380px');
    expect(el('orchestrator-dock').contains(el('thread-content'))).toBe(true);
  });

  it('has no handle outside the docked mode', async () => {
    await renderDock('chat');
    expect(query('orchestrator-dock-resize-handle')).toBeNull();
    expect(query('orchestrator-dock')).toBeNull();
    await renderDock('hidden');
    expect(query('orchestrator-dock-resize-handle')).toBeNull();
    expect(query('orchestrator-dock-hidden')).not.toBeNull();
  });

  it('grows with ArrowLeft and shrinks with ArrowRight, persisting each step', async () => {
    await renderDock();
    key('ArrowLeft');
    expect(valueNow()).toBe(396);
    expect(dockWidth()).toBe('396px');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('396');
    key('ArrowRight');
    key('ArrowRight');
    expect(valueNow()).toBe(364);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('364');
  });

  it('clamps keyboard resizes to 300px and to half the window', async () => {
    window.localStorage.setItem(STORAGE_KEY, '310');
    await renderDock();
    key('ArrowRight');
    expect(valueNow()).toBe(300);
    window.localStorage.setItem(STORAGE_KEY, '715');
    themed.unmount();
    await renderDock();
    key('ArrowLeft');
    expect(valueNow()).toBe(720);
  });

  it('follows a drag of its left edge and remembers the release', async () => {
    await renderDock();
    act(() => {
      handle().dispatchEvent(pointer('pointerdown', 1000));
    });
    act(() => {
      window.dispatchEvent(pointer('pointermove', 900));
    });
    expect(valueNow()).toBe(480);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    act(() => {
      window.dispatchEvent(pointer('pointermove', 100));
    });
    expect(valueNow()).toBe(720);
    act(() => {
      window.dispatchEvent(pointer('pointerup', 100));
    });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('720');
  });

  it('restores the remembered width, capped by a smaller window', async () => {
    window.localStorage.setItem(STORAGE_KEY, '600');
    await renderDock();
    expect(valueNow()).toBe(600);
    act(() => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
      window.dispatchEvent(new Event('resize'));
    });
    expect(valueNow()).toBe(500);
    // The cap is the window's, not a new preference: a wider window gets the 600px back.
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('600');
  });

  it('resets to 380px on double-click', async () => {
    window.localStorage.setItem(STORAGE_KEY, '600');
    await renderDock();
    act(() => {
      handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(valueNow()).toBe(380);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('380');
  });

  describe('closing', () => {
    const renderClosable = (mode: ThreadDockMode, onClose: () => void) =>
      themed.render(
        <ThreadDock mode={mode} hostRef={() => {}} onClose={onClose}>
          <div data-testid="thread-content" />
        </ThreadDock>
      );
    const escape = (target: EventTarget = document.body, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init });
      act(() => {
        target.dispatchEvent(event);
      });
      return event;
    };

    it('closes from its own header button', async () => {
      const onClose = vi.fn();
      await renderClosable('docked', onClose);
      expect(el('orchestrator-dock-header').textContent).toContain('Conversation');
      act(() => el('orchestrator-dock-close-btn').click());
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes on Escape and claims the key', async () => {
      const onClose = vi.fn();
      await renderClosable('docked', onClose);
      expect(escape().defaultPrevented).toBe(true);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('leaves an Escape alone that is composing, already handled, or inside a menu or dialog', async () => {
      const onClose = vi.fn();
      await renderClosable('docked', onClose);
      escape(document.body, { isComposing: true });
      const handled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      handled.preventDefault();
      act(() => {
        document.body.dispatchEvent(handled);
      });
      const menu = document.createElement('div');
      menu.setAttribute('role', 'menu');
      const item = menu.appendChild(document.createElement('button'));
      document.body.appendChild(menu);
      escape(item);
      menu.remove();
      const trigger = document.body.appendChild(document.createElement('button'));
      trigger.setAttribute('aria-expanded', 'true');
      escape(trigger);
      trigger.remove();
      const select = document.body.appendChild(document.createElement('button'));
      select.setAttribute('aria-haspopup', 'listbox');
      select.setAttribute('aria-expanded', 'false');
      escape(select);
      select.remove();
      const modal = document.createElement('div');
      modal.setAttribute('aria-modal', 'true');
      document.body.appendChild(modal);
      escape();
      modal.remove();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('ignores Escape while hidden, and keeps its header mounted so reopening never shifts the thread', async () => {
      const onClose = vi.fn();
      await renderClosable('hidden', onClose);
      escape();
      expect(onClose).not.toHaveBeenCalled();
      expect(query('orchestrator-dock-header')).not.toBeNull();
    });

    it('has no header in the chat layout', async () => {
      await renderClosable('chat', vi.fn());
      expect(query('orchestrator-dock-header')).toBeNull();
    });
  });
});
