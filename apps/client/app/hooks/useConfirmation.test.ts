import { describe, it, expect, vi } from 'vitest';
import { useConfirmationModal } from './useConfirmation';

const confirm = useConfirmationModal.getState().confirm;

describe('useConfirmationModal', () => {
  it("does not leak one dialog's labels into the next one that omits them", () => {
    confirm({
      title: 'Discard changes?',
      okLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
      onOk: () => {},
    });
    confirm({ title: 'Reset User MFA', onOk: () => {} });

    const state = useConfirmationModal.getState();
    expect(state.title).toBe('Reset User MFA');
    // Undefined, so ConfirmationModal falls back to its own Ok / Cancel defaults.
    expect(state.okLabel).toBeUndefined();
    expect(state.cancelLabel).toBeUndefined();
  });

  it("does not leak one dialog's onOk into the next one that omits it", async () => {
    const firstOnOk = vi.fn();
    confirm({ title: 'Discard changes?', onOk: firstOnOk });
    confirm({ title: 'Something else' });

    await useConfirmationModal.getState().onOk();
    expect(firstOnOk).not.toHaveBeenCalled();
  });

  it('clears the description and type between dialogs', () => {
    confirm({ type: 'danger', description: 'Tags and product access', onOk: () => {} });
    confirm({ title: 'Plain dialog', onOk: () => {} });

    const state = useConfirmationModal.getState();
    expect(state.type).toBe('default');
    expect(state.description).toBeUndefined();
  });
});
