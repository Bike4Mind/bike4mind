import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
  default: ({ onChange }: { onChange: (orgId: string) => void }) => (
    <button data-testid="org-selector-pick-btn" onClick={() => onChange('org-2')} />
  ),
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

const renderForm = () => render(<ProfileDataForm userData={makeUser()} />, { wrapper: TestWrapper });

const renderWith = (userData: WithOrgRef<IUserDocument>, onCancel?: () => void) =>
  render(<ProfileDataForm userData={userData} onCancel={onCancel} />, { wrapper: TestWrapper });

beforeEach(() => {
  mockMutate.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ProfileDataForm', () => {
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

  it('edits a security question without mutating the user data it was given', () => {
    const userData = makeUser();
    userData.securityQuestions = [
      { question: 'Q1', answer: 'A1' },
      { question: 'Q2', answer: 'A2' },
    ];
    renderWith(userData);

    fireEvent.change(screen.getByDisplayValue('Q1'), { target: { value: 'Q1-edited' } });
    fireEvent.click(screen.getByTestId('profile-save-btn'));

    expect(userData.securityQuestions).toEqual([
      { question: 'Q1', answer: 'A1' },
      { question: 'Q2', answer: 'A2' },
    ]);
    expect(mockMutate.mock.calls[0][0].data.securityQuestions).toEqual([
      { question: 'Q1-edited', answer: 'A1' },
      { question: 'Q2', answer: 'A2' },
    ]);
  });

  it('does not call the mutation when nothing was edited', () => {
    renderForm();

    fireEvent.click(screen.getByTestId('profile-save-btn'));

    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('sends edited team, role and formatted phone values', () => {
    renderForm();

    fireEvent.change(screen.getByTestId('profile-form-input-team').querySelector('input') as HTMLInputElement, {
      target: { value: 'Team B' },
    });
    fireEvent.change(screen.getByTestId('profile-form-input-role').querySelector('input') as HTMLInputElement, {
      target: { value: 'Lead' },
    });
    fireEvent.change(screen.getByTestId('profile-form-input-phone').querySelector('input') as HTMLInputElement, {
      target: { value: '1234567890123456' },
    });
    fireEvent.click(screen.getByTestId('profile-save-btn'));

    expect(mockMutate.mock.calls[0][0].data).toEqual({ team: 'Team B', role: 'Lead', phone: '(123) 456-7890' });
  });

  it('leaves short phone input unformatted beyond digits', () => {
    renderForm();

    fireEvent.change(screen.getByTestId('profile-form-input-phone').querySelector('input') as HTMLInputElement, {
      target: { value: 'a12' },
    });
    fireEvent.click(screen.getByTestId('profile-save-btn'));

    expect(mockMutate.mock.calls[0][0].data).toEqual({ phone: '12' });
  });

  it('sends the organization chosen in the selector', () => {
    renderWith({ ...makeUser(), organizationId: { id: 'org-1', name: 'Org' } } as unknown as WithOrgRef<IUserDocument>);

    fireEvent.click(screen.getByTestId('org-selector-pick-btn'));
    fireEvent.click(screen.getByTestId('profile-save-btn'));

    expect(mockMutate.mock.calls[0][0].data).toEqual({ organizationId: 'org-2' });
  });

  it('sends the chosen preferred contact and t-shirt size', async () => {
    renderForm();

    const [contactSelect, shirtSelect] = screen.getAllByTestId('profile-form-select');
    fireEvent.click(contactSelect);
    fireEvent.click(await screen.findByRole('option', { name: 'Email' }));
    fireEvent.click(shirtSelect);
    fireEvent.click(await screen.findByRole('option', { name: 'XL' }));
    fireEvent.click(screen.getByTestId('profile-save-btn'));

    expect(mockMutate.mock.calls[0][0].data).toEqual({ preferredContact: 'Email', tshirtSize: 'XL' });
  });

  it('adds a security question and edits its answer', () => {
    renderWith({ ...makeUser(), securityQuestions: undefined } as unknown as WithOrgRef<IUserDocument>);

    fireEvent.click(screen.getByTestId('profile-form-add-question-btn'));
    fireEvent.change(screen.getByPlaceholderText('New answer (leave blank to keep existing)'), {
      target: { value: 'secret' },
    });
    fireEvent.click(screen.getByTestId('profile-save-btn'));

    expect(mockMutate.mock.calls[0][0].data.securityQuestions).toEqual([{ question: '', answer: 'secret' }]);
  });

  it('deletes a security question', () => {
    renderForm();

    fireEvent.click(screen.getByTestId('profile-form-delete-question-btn'));
    fireEvent.click(screen.getByTestId('profile-save-btn'));

    expect(mockMutate.mock.calls[0][0].data.securityQuestions).toEqual([]);
  });

  it('renders empty inputs for a user with no profile fields', () => {
    renderWith({ id: 'user-2' } as unknown as WithOrgRef<IUserDocument>);

    for (const field of ['name', 'username', 'team', 'role', 'phone']) {
      const input = screen.getByTestId(`profile-form-input-${field}`).querySelector('input') as HTMLInputElement;
      expect(input.value).toBe('');
    }
  });

  it('ignores the save when the user has no id', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderWith({ ...makeUser(), id: undefined } as unknown as WithOrgRef<IUserDocument>);

    fireEvent.click(screen.getByTestId('profile-save-btn'));

    expect(error).toHaveBeenCalledWith('Failed to update user: User ID not found');
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('re-enables saving once the mutation settles', async () => {
    renderForm();

    fireEvent.change(screen.getByTestId('profile-form-input-name').querySelector('input') as HTMLInputElement, {
      target: { value: 'X' },
    });
    fireEvent.click(screen.getByTestId('profile-save-btn'));
    expect(screen.getByTestId('profile-save-btn')).toBeDisabled();

    mockMutate.mock.calls[0][1].onSettled();

    await waitFor(() => expect(screen.getByTestId('profile-save-btn')).not.toBeDisabled());
  });

  it('keeps unsaved edits when userData refreshes and resets when pristine', () => {
    const user = makeUser();
    const { rerender } = renderWith(user);
    const nameInput = () => screen.getByTestId('profile-form-input-name').querySelector('input') as HTMLInputElement;

    rerender(<ProfileDataForm userData={{ ...user, name: 'Refetched' }} />);
    expect(nameInput().value).toBe('Refetched');

    fireEvent.change(nameInput(), { target: { value: 'Typing' } });
    rerender(<ProfileDataForm userData={{ ...user, name: 'Refetched Again' }} />);
    expect(nameInput().value).toBe('Typing');
  });

  it('renders the cancel button only when onCancel is provided and calls it', () => {
    const onCancel = vi.fn();
    const { unmount } = renderForm();
    expect(screen.queryByText('Cancel')).toBeNull();
    unmount();

    renderWith(makeUser(), onCancel);
    fireEvent.click(screen.getByText('Cancel'));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  describe('geolocation', () => {
    it('fills the location from reverse geocoding', async () => {
      const getCurrentPosition = vi.fn((success: (p: unknown) => void) =>
        success({ coords: { latitude: 1, longitude: 2 } })
      );
      vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ locality: 'Springfield' }) }));
      renderForm();

      fireEvent.click(screen.getByText('Locate'));

      await waitFor(() => expect(screen.getByDisplayValue('Springfield')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('profile-save-btn'));
      expect(mockMutate.mock.calls[0][0].data).toEqual({ geoLocation: 'Springfield' });
    });

    it('alerts when the location cannot be retrieved', () => {
      const getCurrentPosition = vi.fn((_: unknown, failure: () => void) => failure());
      vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } });
      const alertSpy = vi.fn();
      vi.stubGlobal('alert', alertSpy);
      renderForm();

      fireEvent.click(screen.getByText('Locate'));

      expect(alertSpy).toHaveBeenCalledWith('Unable to retrieve your location');
    });

    it('does nothing when geolocation is unsupported', () => {
      vi.stubGlobal('navigator', {});
      renderForm();

      fireEvent.click(screen.getByText('Locate'));

      expect(mockMutate).not.toHaveBeenCalled();
    });

    it('lets the user type a location manually', () => {
      renderForm();

      fireEvent.change(screen.getByPlaceholderText('Your location'), { target: { value: 'Mars' } });
      fireEvent.click(screen.getByTestId('profile-save-btn'));

      expect(mockMutate.mock.calls[0][0].data).toEqual({ geoLocation: 'Mars' });
    });
  });
});
