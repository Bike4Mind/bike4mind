import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useProfileShortcuts } from './useProfileShortcuts';

const Harness = ({
  enabled,
  onCredits,
  onSuspend,
}: {
  enabled?: boolean;
  onCredits: () => void;
  onSuspend: () => void;
}) => {
  useProfileShortcuts({ c: onCredits, s: onSuspend }, enabled);
  return (
    <div>
      <input data-testid="field-input" />
      <textarea data-testid="field-textarea" />
      <select data-testid="field-select" />
      <div data-testid="field-editable" contentEditable="true" suppressContentEditableWarning />
      <button data-testid="plain-btn" />
    </div>
  );
};

const setup = (enabled?: boolean) => {
  const onCredits = vi.fn();
  const onSuspend = vi.fn();
  const view = render(<Harness enabled={enabled} onCredits={onCredits} onSuspend={onSuspend} />);
  return { onCredits, onSuspend, ...view };
};

describe('useProfileShortcuts', () => {
  afterEach(() => {
    document.querySelectorAll('[role="dialog"]').forEach(node => node.remove());
  });

  it('fires the handler for c and s, case-insensitively', () => {
    const { onCredits, onSuspend } = setup();

    fireEvent.keyDown(document.body, { key: 'c' });
    fireEvent.keyDown(document.body, { key: 'S' });

    expect(onCredits).toHaveBeenCalledTimes(1);
    expect(onSuspend).toHaveBeenCalledTimes(1);
  });

  it('fires from a focused non-text element such as a button', () => {
    const { onCredits } = setup();

    fireEvent.keyDown(screen.getByTestId('plain-btn'), { key: 'c' });

    expect(onCredits).toHaveBeenCalledTimes(1);
  });

  it('prevents the default of a key it handled, and ignores keys it has no handler for', () => {
    const { onCredits } = setup();

    expect(fireEvent.keyDown(document.body, { key: 'c' })).toBe(false);
    expect(fireEvent.keyDown(document.body, { key: 'x' })).toBe(true);
    expect(onCredits).toHaveBeenCalledTimes(1);
  });

  it.each(['field-input', 'field-textarea', 'field-select', 'field-editable'])('ignores a key typed in %s', testId => {
    const { onCredits } = setup();

    fireEvent.keyDown(screen.getByTestId(testId), { key: 'c' });

    expect(onCredits).not.toHaveBeenCalled();
  });

  it.each([['metaKey'], ['ctrlKey'], ['altKey']])('ignores the key with %s held', modifier => {
    const { onCredits } = setup();

    fireEvent.keyDown(document.body, { key: 'c', [modifier]: true });

    expect(onCredits).not.toHaveBeenCalled();
  });

  it('allows shift, which only changes the case of the letter', () => {
    const { onCredits } = setup();

    fireEvent.keyDown(document.body, { key: 'C', shiftKey: true });

    expect(onCredits).toHaveBeenCalledTimes(1);
  });

  it('ignores auto-repeat', () => {
    const { onCredits } = setup();

    fireEvent.keyDown(document.body, { key: 'c', repeat: true });

    expect(onCredits).not.toHaveBeenCalled();
  });

  it('ignores a key already handled by someone else', () => {
    const { onCredits } = setup();
    const event = new KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true });
    event.preventDefault();

    document.body.dispatchEvent(event);

    expect(onCredits).not.toHaveBeenCalled();
  });

  it('ignores keys while a dialog is open and resumes once it is gone', () => {
    const { onCredits } = setup();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);

    fireEvent.keyDown(document.body, { key: 'c' });
    expect(onCredits).not.toHaveBeenCalled();

    dialog.remove();
    fireEvent.keyDown(document.body, { key: 'c' });
    expect(onCredits).toHaveBeenCalledTimes(1);
  });

  it('ignores a closed dialog left mounted under an aria-hidden root', () => {
    const { onCredits } = setup();
    const root = document.createElement('div');
    root.setAttribute('aria-hidden', 'true');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    root.appendChild(dialog);
    document.body.appendChild(root);

    fireEvent.keyDown(document.body, { key: 'c' });
    expect(onCredits).toHaveBeenCalledTimes(1);
    root.remove();
  });

  it('does nothing while disabled and starts working when enabled', () => {
    const onCredits = vi.fn();
    const onSuspend = vi.fn();
    const { rerender } = render(<Harness enabled={false} onCredits={onCredits} onSuspend={onSuspend} />);

    fireEvent.keyDown(document.body, { key: 'c' });
    expect(onCredits).not.toHaveBeenCalled();

    rerender(<Harness enabled onCredits={onCredits} onSuspend={onSuspend} />);
    fireEvent.keyDown(document.body, { key: 'c' });
    expect(onCredits).toHaveBeenCalledTimes(1);
  });

  it('calls the latest handler without re-subscribing', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Harness onCredits={first} onSuspend={vi.fn()} />);

    rerender(<Harness onCredits={second} onSuspend={vi.fn()} />);
    fireEvent.keyDown(document.body, { key: 'c' });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('stops listening on unmount', () => {
    const { onCredits, unmount } = setup();

    unmount();
    fireEvent.keyDown(document.body, { key: 'c' });

    expect(onCredits).not.toHaveBeenCalled();
  });
});
