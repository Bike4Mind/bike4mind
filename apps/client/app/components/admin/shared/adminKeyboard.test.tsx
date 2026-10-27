import { useRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { focusAdminSearch, isAdminShortcutEvent, useAdminSaveShortcut } from './adminKeyboard';

describe('admin keyboard scoping', () => {
  it('focuses only an enabled visible search within the current surface', () => {
    render(
      <>
        <input data-admin-search data-testid="outside-search" />
        <div data-testid="search-scope">
          <input data-admin-search disabled />
          <div hidden>
            <input data-admin-search />
          </div>
          <div aria-hidden="true">
            <input data-admin-search />
          </div>
          <div style={{ display: 'none' }}>
            <input data-admin-search />
          </div>
          <div style={{ visibility: 'hidden' }}>
            <input data-admin-search />
          </div>
          <input data-admin-search data-testid="visible-search" />
        </div>
      </>
    );
    const scope = screen.getByTestId('search-scope');
    expect(focusAdminSearch(scope)).toBe(true);
    expect(screen.getByTestId('visible-search')).toHaveFocus();
    screen.getByTestId('visible-search').setAttribute('disabled', '');
    expect(focusAdminSearch(scope)).toBe(false);
    expect(screen.getByTestId('outside-search')).not.toHaveFocus();
  });

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

  it('saves only the editor that holds focus, including from its inputs, and respects disabled buttons', () => {
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
    fireEvent.keyDown(document.body, { key: 's', metaKey: true });
    fireEvent.keyDown(screen.getByTestId('input'), { key: 's', metaKey: true, isComposing: true });
    expect(save).not.toHaveBeenCalled();
    const fromInput = new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true });
    screen.getByTestId('input').dispatchEvent(fromInput);
    expect(save).toHaveBeenCalledOnce();
    expect(fromInput.defaultPrevented).toBe(true);
    fireEvent.keyDown(screen.getByTestId('editor'), { key: 's', ctrlKey: true });
    expect(save).toHaveBeenCalledTimes(2);
    screen.getByTestId('save').setAttribute('disabled', '');
    fireEvent.keyDown(screen.getByTestId('editor'), { key: 's', metaKey: true });
    expect(save).toHaveBeenCalledTimes(2);
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
