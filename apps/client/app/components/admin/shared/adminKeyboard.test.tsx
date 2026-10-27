import { useRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { isAdminShortcutEvent, useAdminSaveShortcut } from './adminKeyboard';

describe('admin keyboard scoping', () => {
  it.each(['input', 'textarea', 'select', 'div[contenteditable]', 'div[role=textbox]', 'div[role=combobox]'])(
    'ignores typing in %s, including descendants',
    selector => {
      const root = document.createElement(selector.split('[')[0]);
      if (selector.includes('contenteditable')) root.setAttribute('contenteditable', 'true');
      if (selector.includes('role=')) root.setAttribute('role', selector.split('role=')[1].replace(']', ''));
      const child = document.createElement('span');
      root.append(child);
      const handler = vi.fn((event: KeyboardEvent) => isAdminShortcutEvent(event));
      root.addEventListener('keydown', handler);
      child.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
      expect(handler.mock.results[0].value).toBe(false);
    }
  );

  it.each([{ repeat: true }, { isComposing: true }, { altKey: true }])('ignores %j', options => {
    expect(isAdminShortcutEvent(new KeyboardEvent('keydown', { key: 'c', ...options }))).toBe(false);
  });

  it('saves only the focused editor outside inputs, and respects disabled buttons', () => {
    const save = vi.fn();
    function Editor() {
      const ref = useRef<HTMLDivElement>(null);
      useAdminSaveShortcut(ref);
      return (
        <div ref={ref} data-admin-settings-editor data-testid="editor" tabIndex={0}>
          <input data-testid="input" />
          <button data-testid="save" data-admin-save onClick={save}>
            Save
          </button>
        </div>
      );
    }
    render(<Editor />);
    fireEvent.keyDown(screen.getByTestId('input'), { key: 's', metaKey: true });
    fireEvent.keyDown(document.body, { key: 's', metaKey: true });
    expect(save).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByTestId('editor'), { key: 's', ctrlKey: true });
    expect(save).toHaveBeenCalledOnce();
    screen.getByTestId('save').setAttribute('disabled', '');
    fireEvent.keyDown(screen.getByTestId('editor'), { key: 's', metaKey: true });
    expect(save).toHaveBeenCalledOnce();
  });

  it('claims Cmd/Ctrl+S on an editor with no Save button so the browser dialog stays closed', () => {
    function CleanEditor() {
      const ref = useRef<HTMLDivElement>(null);
      useAdminSaveShortcut(ref);
      return <div ref={ref} data-admin-settings-editor data-testid="clean-editor" tabIndex={0} />;
    }
    render(<CleanEditor />);
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
    screen.getByTestId('clean-editor').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
