import React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mutation = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  isError: false,
  error: null as unknown,
}));
vi.mock('@client/app/hooks/data/user', () => ({ useRequestAccountDeletion: () => mutation }));
vi.mock('@client/app/hooks/data/sessions', () => ({ useOwnSessionCount: () => ({ data: undefined }) }));
vi.mock('@client/app/hooks/data/fabFiles', () => ({ useGetFabFiles: () => ({ data: undefined }) }));

import DeleteAccountSection from './DeleteAccountSection';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: React.ReactElement) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);
const confirmBtn = () => screen.getByTestId('confirm-modal-confirm-btn') as HTMLButtonElement;
const open = () => fireEvent.click(screen.getByTestId('delete-account-open-btn'));
const typeWord = (value: string) =>
  fireEvent.change(screen.getByTestId('delete-account-confirm-input'), { target: { value } });

beforeEach(() => {
  mutation.mutate.mockReset();
  mutation.isPending = false;
  mutation.isError = false;
  mutation.error = null;
});

describe('DeleteAccountSection', () => {
  it('states the 30-day window in the dialog', () => {
    wrap(<DeleteAccountSection />);
    open();
    const text = screen.getByTestId('delete-account-confirm').textContent;
    expect(text).toContain('after 30 days');
    expect(text).toContain('restore it');
  });

  it('only requests the deletion once DELETE is typed', () => {
    wrap(<DeleteAccountSection />);
    open();
    expect(confirmBtn().disabled).toBe(true);

    typeWord('delete');
    expect(confirmBtn().disabled).toBe(true);

    typeWord('DELETE');
    expect(confirmBtn().disabled).toBe(false);
    fireEvent.click(confirmBtn());
    expect(mutation.mutate).toHaveBeenCalledOnce();
  });

  it("shows the server's refusal, e.g. an organization that needs a new owner", () => {
    mutation.isError = true;
    mutation.error = new Error('Transfer ownership of your organizations first.');
    wrap(<DeleteAccountSection />);
    open();
    expect(screen.getByTestId('delete-account-confirm-error').textContent).toContain('Transfer ownership');
  });
});
