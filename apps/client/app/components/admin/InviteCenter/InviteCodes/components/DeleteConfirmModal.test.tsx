import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { useRegistrationInvitesStore } from '../store';
import { DeleteConfirmModal } from './DeleteConfirmModal';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderModal = (selected: string[]) => {
  useRegistrationInvitesStore.setState({ openDeleteWarning: true, multiSelected: selected });
  const onConfirm = vi.fn();
  render(
    <CssVarsProvider theme={appTheme}>
      <DeleteConfirmModal onConfirm={onConfirm} />
    </CssVarsProvider>
  );
  return onConfirm;
};

describe('DeleteConfirmModal', () => {
  beforeEach(() => useRegistrationInvitesStore.setState({ openDeleteWarning: false, multiSelected: [] }));

  it('is an alert dialog whose confirm deletes once and closes', () => {
    const onConfirm = renderModal(['a', 'b']);
    expect(screen.getByRole('alertdialog', { name: 'Delete invites' })).toBeTruthy();
    const confirm = screen.getByTestId('delete-invites-confirm-btn');
    expect(confirm.textContent).toBe('Delete 2 invites');
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(useRegistrationInvitesStore.getState().openDeleteWarning).toBe(false);
  });

  it('closes without deleting on Cancel and on Escape', () => {
    const onConfirm = renderModal(['a']);
    expect(screen.getByTestId('delete-invites-confirm-btn').textContent).toBe('Delete 1 invite');
    fireEvent.keyDown(screen.getByTestId('delete-invites-modal'), { key: 'Escape' });
    expect(useRegistrationInvitesStore.getState().openDeleteWarning).toBe(false);
    act(() => useRegistrationInvitesStore.setState({ openDeleteWarning: true }));
    fireEvent.click(screen.getByTestId('delete-invites-cancel-btn'));
    expect(useRegistrationInvitesStore.getState().openDeleteWarning).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('cannot confirm with nothing selected', () => {
    renderModal([]);
    expect(screen.getByTestId('delete-invites-confirm-btn')).toHaveProperty('disabled', true);
  });
});
