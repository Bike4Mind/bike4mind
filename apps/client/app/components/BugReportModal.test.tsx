import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import BugReportModal from './BugReportModal';
import { toast } from 'sonner';

const h = vi.hoisted(() => ({
  createFeedbackOnServer: vi.fn(),
}));

vi.mock('@client/app/utils/feedbackAPICalls', () => ({
  createFeedbackOnServer: h.createFeedbackOnServer,
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'u1', username: 'reporter', email: 'reporter@example.com' } }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

const appTheme = extendTheme({ ...getThemeConfig() });

const renderModal = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <BugReportModal open onClose={vi.fn()} promptMeta={null} />
    </CssVarsProvider>
  );

beforeEach(() => {
  h.createFeedbackOnServer.mockReset();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe('BugReportModal', () => {
  it('shows a success toast only after the submission resolves as delivered', async () => {
    let resolveSubmit: (value: unknown) => void = () => {};
    h.createFeedbackOnServer.mockReturnValue(
      new Promise(resolve => {
        resolveSubmit = resolve;
      })
    );
    renderModal();

    fireEvent.click(screen.getByTestId('bug-report-modal-submit-btn'));

    expect(toast.success).not.toHaveBeenCalled();

    resolveSubmit({ delivery: { delivered: true, channels: {} } });

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('shows a warning toast, not a success toast, when nothing was delivered', async () => {
    h.createFeedbackOnServer.mockResolvedValue({
      delivery: { delivered: false, channels: { slack: { outcome: 'skipped' }, email: { outcome: 'skipped' } } },
    });
    renderModal();

    fireEvent.click(screen.getByTestId('bug-report-modal-submit-btn'));

    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('falls back to the success toast, not a throw, when a rolling deploy returns no delivery field', async () => {
    h.createFeedbackOnServer.mockResolvedValue({});
    renderModal();

    fireEvent.click(screen.getByTestId('bug-report-modal-submit-btn'));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('shows an error toast, not a success toast, when the request rejects', async () => {
    h.createFeedbackOnServer.mockRejectedValue(new Error('network down'));
    renderModal();

    fireEvent.click(screen.getByTestId('bug-report-modal-submit-btn'));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('disables the submit button while the request is pending', async () => {
    let resolveSubmit: (value: unknown) => void = () => {};
    h.createFeedbackOnServer.mockReturnValue(
      new Promise(resolve => {
        resolveSubmit = resolve;
      })
    );
    renderModal();

    const button = screen.getByTestId('bug-report-modal-submit-btn');
    fireEvent.click(button);

    expect(button).toBeDisabled();

    resolveSubmit({ delivery: { delivered: true, channels: {} } });
    await waitFor(() => expect(button).not.toBeDisabled());
  });
});
