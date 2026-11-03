import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import ProfileDetailSection from './ProfileDetailSection';

const { mockUseGetUser, mockUseUser } = vi.hoisted(() => ({ mockUseGetUser: vi.fn(), mockUseUser: vi.fn() }));

vi.mock('@client/app/hooks/data/user', () => ({ useGetUser: mockUseGetUser }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: mockUseUser }));
vi.mock('@client/app/utils/s3', () => ({
  getAppFileUrl: ({ key }: { key: string }) => `https://files.example.com/${key}`,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: string | { defaultValue?: string }) =>
      typeof opts === 'string' ? opts : (opts?.defaultValue ?? key),
  }),
}));
vi.mock('@client/app/components/ProfileModal/SectionContainer', () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@client/app/components/ProfileModal/ProfileDataForm', () => ({
  default: ({ onCancel }: { onCancel: () => void }) => (
    <button data-testid="profile-form-cancel-btn" onClick={onCancel} />
  ),
}));
vi.mock('../ProfileModal/UploadProfilePhotoModal', () => ({
  default: ({
    open,
    onClose,
    onUploadComplete,
  }: {
    open: boolean;
    onClose: () => void;
    onUploadComplete: (url: string) => void;
  }) =>
    open ? (
      <div data-testid="upload-modal">
        <button data-testid="upload-modal-close-btn" onClick={onClose} />
        <button data-testid="upload-modal-complete-btn" onClick={() => onUploadComplete('x')} />
      </div>
    ) : null,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const setUser = (data: Record<string, unknown> | undefined, state: { isPending?: boolean; isLoading?: boolean } = {}) =>
  mockUseGetUser.mockReturnValue({ data, isPending: false, isLoading: false, ...state });

const renderSection = (props: Partial<React.ComponentProps<typeof ProfileDetailSection>> = {}) =>
  render(<ProfileDetailSection userId="u1" {...props} />, { wrapper: TestWrapper });

beforeEach(() => {
  mockUseGetUser.mockReset();
  mockUseUser.mockReset();
  mockUseUser.mockReturnValue({ currentUser: { id: 'other' } });
});

describe('ProfileDetailSection', () => {
  it('shows the loading bar while the user is pending', () => {
    setUser(undefined, { isPending: true });
    renderSection();
    expect(screen.getByTestId('profile-detail-loading')).toBeInTheDocument();
  });

  it('shows the loading bar while the user is loading', () => {
    setUser(undefined, { isLoading: true });
    renderSection();
    expect(screen.getByTestId('profile-detail-loading')).toBeInTheDocument();
  });

  it('shows the loading bar without a userId', () => {
    setUser({ name: 'Ada' });
    renderSection({ userId: '' });
    expect(screen.getByTestId('profile-detail-loading')).toBeInTheDocument();
  });

  it('renders name, role at organization and all contact details', () => {
    setUser({
      name: 'Ada Lovelace',
      role: 'Engineer',
      organizationId: { name: 'Acme' },
      email: 'ada@example.com',
      phone: '555-0100',
      geoLocation: 'London',
      photoUrl: 'photo.png',
    });
    renderSection();

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Engineer at Acme')).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toHaveAttribute('href', 'mailto:ada@example.com');
    expect(screen.getByText('555-0100')).toBeInTheDocument();
    expect(screen.getByText(/London/)).toBeInTheDocument();
    expect(screen.queryByText('Edit')).toBeNull();
  });

  it('uses the email prop and invited placeholder for a user without data', () => {
    setUser(undefined);
    renderSection({ email: 'invitee@example.com' });

    expect(screen.getByText('Invited user')).toBeInTheDocument();
    expect(screen.getByText('invitee@example.com')).toHaveAttribute('href', 'mailto:invitee@example.com');
    expect(screen.getByText(/read-only preview/)).toBeInTheDocument();
  });

  it('shows the contact-unavailable note and hides the read-only note when editable', () => {
    setUser(undefined);
    renderSection({ canEdit: true });

    expect(screen.getByText('No contact info available yet.')).toBeInTheDocument();
    expect(screen.queryByText(/read-only preview/)).toBeNull();
  });

  it('renders only a phone number when that is the sole contact detail', () => {
    setUser({ name: 'Bob', phone: '555-0199' });
    renderSection();

    expect(screen.getByText('555-0199')).toBeInTheDocument();
    expect(screen.queryByText('No contact info available yet.')).toBeNull();
  });

  it('prefers the user email over the email prop and renders extra content', () => {
    setUser({ name: 'Bob', email: 'bob@example.com', role: 'Dev' });
    renderSection({ email: 'other@example.com', extra: <span data-testid="extra-slot" /> });

    expect(screen.getByText('bob@example.com')).toBeInTheDocument();
    expect(screen.getByText('Dev')).toBeInTheDocument();
    expect(screen.getByTestId('extra-slot')).toBeInTheDocument();
  });

  it('switches to the edit form and back on cancel', () => {
    setUser({ name: 'Bob' });
    renderSection({ canEdit: true });

    fireEvent.click(screen.getByTestId('profile-edit-btn'));
    expect(screen.queryByTestId('profile-edit-btn')).toBeNull();
    fireEvent.click(screen.getByTestId('profile-form-cancel-btn'));

    expect(screen.getByTestId('profile-edit-btn')).toBeInTheDocument();
  });

  it('does not offer photo upload for another user', () => {
    setUser({ name: 'Bob' });
    renderSection();
    expect(screen.queryByLabelText('Change profile photo')).toBeNull();
  });

  it('handles a missing current user', () => {
    mockUseUser.mockReturnValue({ currentUser: undefined });
    setUser({ name: 'Bob' });
    renderSection();
    expect(screen.queryByLabelText('Change profile photo')).toBeNull();
  });

  it('opens the photo upload modal for the current user and closes it', () => {
    mockUseUser.mockReturnValue({ currentUser: { id: 'u1' } });
    setUser({ name: 'Bob' });
    renderSection();

    fireEvent.click(screen.getByLabelText('Change profile photo'));
    fireEvent.click(screen.getByTestId('upload-modal-close-btn'));
    expect(screen.queryByTestId('upload-modal')).toBeNull();

    fireEvent.click(screen.getByLabelText('Change profile photo'));
    fireEvent.click(screen.getByTestId('upload-modal-complete-btn'));
    expect(screen.queryByTestId('upload-modal')).toBeNull();
  });
});
