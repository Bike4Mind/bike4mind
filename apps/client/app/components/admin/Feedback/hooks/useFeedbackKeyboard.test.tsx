import { useRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useFeedbackKeyboard } from './useFeedbackKeyboard';

function Harness({ drawer = false, enabled = true, onAction = vi.fn(), onNext = vi.fn(), onPrevious = vi.fn() }) {
  const ref = useRef<HTMLDivElement>(null);
  useFeedbackKeyboard({ rootRef: ref, drawer, enabled, onAction, onNext, onPrevious });
  return (
    <div role={drawer ? 'dialog' : undefined}>
      <div ref={ref} tabIndex={-1} data-testid="keyboard-root">
        <div data-row-id="one" tabIndex={0} data-testid="keyboard-row-one" />
        <div data-row-id="two" tabIndex={0} data-testid="keyboard-row-two" />
        <input data-testid="keyboard-input" />
        <div contentEditable suppressContentEditableWarning data-testid="keyboard-editable">
          <span data-testid="keyboard-editable-child">text</span>
        </div>
        <button data-testid="keyboard-button">Action</button>
      </div>
    </div>
  );
}

describe('useFeedbackKeyboard', () => {
  it('moves focus with j/k and keeps focus at the ends', () => {
    render(<Harness />);
    const root = screen.getByTestId('keyboard-root');
    const one = screen.getByTestId('keyboard-row-one');
    const two = screen.getByTestId('keyboard-row-two');
    fireEvent.keyDown(root, { key: 'j' });
    expect(one).toHaveFocus();
    fireEvent.keyDown(one, { key: 'j' });
    expect(two).toHaveFocus();
    fireEvent.keyDown(two, { key: 'j' });
    expect(two).toHaveFocus();
    fireEvent.keyDown(two, { key: 'k' });
    expect(one).toHaveFocus();
  });

  it('dispatches actions for the focused row, leaving Enter and x to DataTable', () => {
    const onAction = vi.fn();
    render(<Harness onAction={onAction} />);
    const row = screen.getByTestId('keyboard-row-one');
    for (const key of ['i', 'c', 'e']) fireEvent.keyDown(row, { key });
    expect(onAction.mock.calls).toEqual([
      ['i', 'one'],
      ['c', 'one'],
      ['e', 'one'],
    ]);
    for (const key of ['Enter', 'x']) fireEvent.keyDown(row, { key });
    expect(onAction).toHaveBeenCalledTimes(3);
  });

  it('ignores typing, modifiers, repeats, IME, nested controls and unrelated overlays', () => {
    const onAction = vi.fn();
    render(<Harness onAction={onAction} />);
    for (const id of ['keyboard-input', 'keyboard-editable-child', 'keyboard-button']) {
      for (const key of ['j', 'k', 'i', 'c', 'e']) fireEvent.keyDown(screen.getByTestId(id), { key });
    }
    const row = screen.getByTestId('keyboard-row-one');
    for (const extra of [
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { shiftKey: true },
      { repeat: true },
      { isComposing: true },
    ]) {
      fireEvent.keyDown(row, { key: 'c', ...extra });
    }
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    document.body.appendChild(overlay);
    fireEvent.keyDown(row, { key: 'c' });
    overlay.remove();
    expect(onAction).not.toHaveBeenCalled();
  });

  it('navigates and acts inside its drawer, but not behind a nested modal', () => {
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    const onAction = vi.fn();
    render(<Harness drawer onNext={onNext} onPrevious={onPrevious} onAction={onAction} />);
    const button = screen.getByTestId('keyboard-button');
    for (const key of ['j', 'k', 'c']) fireEvent.keyDown(button, { key });
    expect(onNext).toHaveBeenCalledOnce();
    expect(onPrevious).toHaveBeenCalledOnce();
    expect(onAction).toHaveBeenCalledWith('c', undefined);
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'alertdialog');
    document.body.appendChild(overlay);
    fireEvent.keyDown(button, { key: 'c' });
    overlay.remove();
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('does nothing while disabled', () => {
    const onAction = vi.fn();
    render(<Harness enabled={false} onAction={onAction} />);
    fireEvent.keyDown(screen.getByTestId('keyboard-row-one'), { key: 'c' });
    expect(onAction).not.toHaveBeenCalled();
  });
});
