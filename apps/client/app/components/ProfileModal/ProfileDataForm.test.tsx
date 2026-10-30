import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IUserDocument, WithOrgRef } from '@bike4mind/common';
import ProfileDataForm from './ProfileDataForm';

const { mockMutate } = vi.hoisted(() => ({ mockMutate: vi.fn() }));

vi.mock('@client/app/hooks/data/user', () => ({
  useUpdateUser: () => ({ mutate: mockMutate, isPending: false }),
}));

// SingleOrganizationSelector fetches org data + reads the user context; stub it out.
vi.mock('@client/app/components/common/SingleOrganizationSelector', () => ({
  default: ({ disabled }: { disabled?: boolean }) => <button data-testid="stub-org-selector" disabled={disabled} />,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const makeUser = (): WithOrgRef<IUserDocument> =>
  ({
    id: 'user-1',
    name: 'Original Name',
    username: 'orig',
    email: 'orig@example.com',
    team: 'Team A',
    role: 'Engineer',
    // Fields the form does NOT manage - must never appear in the save payload:
    userNotes: [{ timestamp: '2026-01-01', note: 'admin note', userName: 'admin' }],
    securityQuestions: [{ question: 'Q1', answer: 'A1' }],
    isAdmin: true,
    isBanned: false,
    isModerated: false,
  }) as unknown as WithOrgRef<IUserDocument>;

const renderForm = (adminMode = true, userData = makeUser()) =>
  render(<ProfileDataForm userData={userData} adminMode={adminMode} />, { wrapper: TestWrapper });

type SaveCallbacks = { onSuccess: () => void; onSettled: () => void };

const nameInput = () => within(screen.getByTestId('profile-form-input-name')).getByRole('textbox');

beforeEach(() => {
  mockMutate.mockReset();
});

describe('ProfileDataForm', () => {
  it('keeps failed edits so saving again retries the same payload', () => {
    renderForm();
    fireEvent.change(nameInput(), { target: { value: 'Retry Name' } });
    fireEvent.click(screen.getByTestId('profile-save-btn'));
    const callbacks = mockMutate.mock.calls[0][1] as SaveCallbacks;

    act(() => callbacks.onSettled());

    expect(nameInput()).toHaveValue('Retry Name');
    expect(screen.getByTestId('profile-save-btn')).toBeEnabled();
    fireEvent.click(screen.getByTestId('profile-save-btn'));
    expect(mockMutate).toHaveBeenCalledTimes(2);
    expect(mockMutate.mock.calls[1][0]).toEqual({ id: 'user-1', data: { name: 'Retry Name' } });
  });

  it('clears saved edits and displays the refreshed profile after success', () => {
    const user = makeUser();
    const { rerender } = renderForm(true, user);
    fireEvent.change(nameInput(), { target: { value: 'Saved Name' } });
    fireEvent.click(screen.getByTestId('profile-save-btn'));
    const callbacks = mockMutate.mock.calls[0][1] as SaveCallbacks;

    act(() => {
      rerender(<ProfileDataForm userData={{ ...user, name: 'Saved Name' }} adminMode />);
      callbacks.onSuccess();
      callbacks.onSettled();
    });

    expect(nameInput()).toHaveValue('Saved Name');
    fireEvent.click(screen.getByTestId('profile-save-btn'));
    expect(mockMutate).toHaveBeenCalledTimes(1);
  });

  it('disables the fields, organization picker, selects and save while a save is pending', () => {
    renderForm();
    fireEvent.change(nameInput(), { target: { value: 'Pending Name' } });
    fireEvent.click(screen.getByTestId('profile-save-btn'));

    expect(screen.getByTestId('profile-form-fields')).toBeDisabled();
    expect(nameInput()).toBeDisabled();
    expect(nameInput()).toHaveValue('Pending Name');
    expect(screen.getByTestId('stub-org-selector')).toHaveAttribute('disabled');
    for (const select of screen.getAllByTestId('profile-form-select')) expect(select).toHaveAttribute('disabled');
    expect(screen.getByTestId('profile-save-btn')).toBeDisabled();
  });

  it('sends only the edited field, never re-sending unmanaged fields', () => {
    const { container } = renderForm();

    const nameInput = container.querySelector('input[name="name"]') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'New Name' } });

    fireEvent.click(screen.getByTestId('profile-save-btn'));

    expect(mockMutate).toHaveBeenCalledTimes(1);
    const [payload] = mockMutate.mock.calls[0];
    expect(payload).toEqual({ id: 'user-1', data: { name: 'New Name' } });
    // Regression guard for issue #466: unmanaged fields must not round-trip.
    expect(payload.data).not.toHaveProperty('userNotes');
    expect(payload.data).not.toHaveProperty('securityQuestions');
    expect(payload.data).not.toHaveProperty('isAdmin');
    expect(payload.data).not.toHaveProperty('isBanned');
    expect(payload.data).not.toHaveProperty('isModerated');
  });

  it('includes securityQuestions (with the edit) only when the user touches them', () => {
    renderForm();

    const questionInput = screen.getByDisplayValue('Q1') as HTMLInputElement;
    fireEvent.change(questionInput, { target: { value: 'Q1-edited' } });

    fireEvent.click(screen.getByTestId('profile-save-btn'));

    expect(mockMutate).toHaveBeenCalledTimes(1);
    const [payload] = mockMutate.mock.calls[0];
    expect(payload.data.securityQuestions).toEqual([{ question: 'Q1-edited', answer: 'A1' }]);
    // Only the touched field ships; unmanaged/untouched fields stay out.
    expect(payload.data).not.toHaveProperty('userNotes');
    expect(payload.data).not.toHaveProperty('name');
  });

  it('does not call the mutation when nothing was edited', () => {
    renderForm();

    fireEvent.click(screen.getByTestId('profile-save-btn'));

    expect(mockMutate).not.toHaveBeenCalled();
  });
});
