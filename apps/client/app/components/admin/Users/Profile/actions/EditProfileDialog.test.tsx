import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AxiosError, AxiosHeaders } from 'axios';
import { USERNAME_RULES_MESSAGE } from '@bike4mind/common';
import { EditProfileDialog } from './EditProfileDialog';
import { ProfileTestWrapper, buildProfile } from '../profileTestUtils';
import type { AdminUserProfile } from '../userProfileModel';

const mocks = vi.hoisted(() => ({
  apiPatch: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  stepUpCancelled: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { patch: mocks.apiPatch } }));
vi.mock('@client/app/utils/stepUpInterceptor', () => ({ isStepUpCancelled: mocks.stepUpCancelled }));
vi.mock('./useAdminUserUpdate', () => ({
  adminUpdateErrorMessage: (_error: unknown, fallback: string) => fallback,
}));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));

const ID = 'edit-profile-dialog';

const renderDialog = (overrides: Partial<AdminUserProfile> = {}) => {
  const onClose = vi.fn();
  render(<EditProfileDialog user={buildProfile(overrides)} onClose={onClose} />, { wrapper: ProfileTestWrapper });
  return { onClose };
};

const type = (field: 'name' | 'username' | 'email', value: string) =>
  fireEvent.change(screen.getByTestId(`${ID}-${field}-input`), { target: { value } });
const pickReason = () => fireEvent.click(screen.getByTestId(`${ID}-reason-input-preset-0`));
const confirm = () => fireEvent.click(screen.getByTestId(`${ID}-confirm-btn`));
const hint = () => screen.getByTestId(`${ID}-hint`);

const httpError = (status: number, data?: unknown) =>
  new AxiosError('failed', String(status), undefined, undefined, {
    status,
    statusText: '',
    data,
    headers: {},
    config: { headers: new AxiosHeaders() },
  });

describe('EditProfileDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiPatch.mockResolvedValue({ data: {} });
    mocks.stepUpCancelled.mockReturnValue(false);
  });

  it('starts from the current values and asks for a change before it saves', () => {
    renderDialog();

    expect(screen.getByTestId(`${ID}-name-input`)).toHaveValue('Ada Lovelace');
    expect(screen.getByTestId(`${ID}-username-input`)).toHaveValue('ada');
    expect(screen.getByTestId(`${ID}-email-input`)).toHaveValue('ada@example.com');
    expect(hint()).toHaveTextContent('Change the name, username or email.');
    expect(screen.getByTestId(`${ID}-confirm-btn`)).toBeDisabled();
    expect(screen.queryByTestId(`${ID}-preview-name`)).not.toBeInTheDocument();
  });

  it('previews and saves a new name and username with the reason, without an email note', async () => {
    const { onClose } = renderDialog();

    type('name', '  Ada King ');
    type('username', ' ada2 ');
    expect(screen.getByTestId(`${ID}-preview-name-before`)).toHaveTextContent('Ada Lovelace');
    expect(screen.getByTestId(`${ID}-preview-name-after`)).toHaveTextContent('Ada King');
    expect(screen.getByTestId(`${ID}-preview-username-after`)).toHaveTextContent('ada2');
    expect(screen.queryByTestId(`${ID}-email-note`)).not.toBeInTheDocument();

    pickReason();
    confirm();

    await waitFor(() =>
      expect(mocks.apiPatch).toHaveBeenCalledWith('/api/admin/users/test-user-1/profile', {
        name: 'Ada King',
        username: 'ada2',
        reason: 'Customer request',
      })
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Profile saved');
  });

  it('shows a dash for a value that is empty on either side', () => {
    renderDialog({ name: undefined });

    type('name', 'Ada');
    expect(screen.getByTestId(`${ID}-preview-name-before`)).toHaveTextContent('-');

    type('name', '');
    expect(hint()).toHaveTextContent('Change the name, username or email.');
  });

  it('refuses to clear the name, which the account requires', () => {
    renderDialog();

    type('name', '   ');

    expect(screen.getByTestId(`${ID}-name-error`)).toHaveTextContent('Enter a name.');
    expect(screen.queryByTestId(`${ID}-preview-name`)).not.toBeInTheDocument();
    expect(hint()).toHaveTextContent('Fix the highlighted field to continue.');
  });

  it('says a new email waits for the user to confirm it, and saves the normalized address', async () => {
    renderDialog({ pendingEmail: 'stale@example.com' });

    type('email', ' New@Example.com ');

    expect(screen.getByTestId(`${ID}-preview-email-after`)).toHaveTextContent('new@example.com');
    expect(screen.getByTestId(`${ID}-preview-email-delta`)).toHaveTextContent('Needs verification');
    const note = screen.getByTestId(`${ID}-email-note`);
    expect(note).toHaveTextContent('We email a confirmation link to new@example.com.');
    expect(note).toHaveTextContent('The account keeps ada@example.com until the link is clicked');
    expect(note).toHaveTextContent('This replaces the pending change to stale@example.com.');

    pickReason();
    confirm();

    await waitFor(() =>
      expect(mocks.apiPatch).toHaveBeenCalledWith('/api/admin/users/test-user-1/profile', {
        email: 'new@example.com',
        reason: 'Customer request',
      })
    );
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith('Profile saved. Confirmation link sent to new@example.com.')
    );
  });

  it('words the note as adding an address for an account with no email', () => {
    renderDialog({ email: null, username: undefined });

    expect(screen.getByTestId(`${ID}-username-input`)).toHaveValue('');
    type('email', 'first@example.com');

    expect(screen.getByTestId(`${ID}-email-note`)).toHaveTextContent('The address is added once the link is clicked.');
    expect(screen.getByTestId(`${ID}-preview-email-before`)).toHaveTextContent('-');
  });

  it('treats a case-only email edit as no change', () => {
    renderDialog();

    type('email', 'ADA@example.com');

    expect(hint()).toHaveTextContent('Change the name, username or email.');
  });

  it('flags an invalid email and username inline and blocks the save', () => {
    renderDialog();

    type('email', 'not-an-email');
    type('username', '<script>');

    expect(screen.getByTestId(`${ID}-email-error`)).toHaveTextContent('Enter a valid email address.');
    expect(screen.getByTestId(`${ID}-username-error`)).toHaveTextContent(USERNAME_RULES_MESSAGE);
    expect(screen.queryByTestId(`${ID}-preview-email`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`${ID}-email-note`)).not.toBeInTheDocument();
    expect(hint()).toHaveTextContent('Fix the highlighted field to continue.');
  });

  it('treats a username that normalizes back to the current one as no change', () => {
    renderDialog();

    type('username', ' ada ');

    expect(hint()).toHaveTextContent('Change the name, username or email.');
  });

  it('shows a taken username inline, keeps the dialog open, and clears it on the next edit', async () => {
    mocks.apiPatch.mockRejectedValue(httpError(409, { error: 'That username is taken.', field: 'username' }));
    const { onClose } = renderDialog();

    type('username', 'taken');
    pickReason();
    confirm();

    expect(await screen.findByTestId(`${ID}-username-error`)).toHaveTextContent('That username is taken.');
    expect(hint()).toHaveTextContent('Fix the highlighted field to continue.');
    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();

    type('username', 'free');
    expect(screen.queryByTestId(`${ID}-username-error`)).not.toBeInTheDocument();
  });

  it('shows a taken email inline', async () => {
    mocks.apiPatch.mockRejectedValue(
      httpError(409, { error: 'That email address is already in use.', field: 'email' })
    );
    renderDialog();

    type('email', 'taken@example.com');
    pickReason();
    confirm();

    expect(await screen.findByTestId(`${ID}-email-error`)).toHaveTextContent('That email address is already in use.');
  });

  it.each([
    ['a non-HTTP failure', new Error('boom')],
    ['a response with no body', httpError(500)],
    ['a body that is not an object', httpError(500, 'Server Error')],
    ['an error on an unknown field', httpError(400, { error: 'Bad', field: 'phone' })],
    ['a field error with no message', httpError(400, { field: 'name' })],
  ])('toasts %s and stays open', async (_label, error) => {
    mocks.apiPatch.mockRejectedValue(error);
    const { onClose } = renderDialog();

    type('name', 'Ada King');
    pickReason();
    confirm();

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('The profile was not saved.'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('stays silent when the admin cancels the step-up prompt', async () => {
    mocks.apiPatch.mockRejectedValue(httpError(403, { code: 'step_up_required' }));
    mocks.stepUpCancelled.mockReturnValue(true);
    const { onClose } = renderDialog();

    type('email', 'new@example.com');
    pickReason();
    confirm();

    await waitFor(() => expect(mocks.stepUpCancelled).toHaveBeenCalled());
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
