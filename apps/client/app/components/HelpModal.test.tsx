import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import HelpModal from './HelpModal';
import { toast } from 'sonner';

const h = vi.hoisted(() => ({
  createFeedbackOnServer: vi.fn(),
  logEventMutate: vi.fn(),
  updatePreferences: vi.fn(),
}));

vi.mock('@client/app/utils/feedbackAPICalls', () => ({
  createFeedbackOnServer: h.createFeedbackOnServer,
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector?: (s: { currentUser: unknown }) => unknown) => {
    const state = { currentUser: { id: 'u1', username: 'reporter', email: 'reporter@example.com' } };
    return selector ? selector(state) : state;
  },
}));

vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({
    settings: { showHelp: true },
    updatePreferences: h.updatePreferences,
  }),
}));

vi.mock('@client/app/hooks/data/analytics', () => ({
  useLogEvent: () => ({ mutate: h.logEventMutate }),
}));

vi.mock('@client/app/hooks/useGetLogo', () => ({
  default: () => 'logo.png',
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

const appTheme = extendTheme({ ...getThemeConfig() });

const renderModal = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <HelpModal />
    </CssVarsProvider>
  );

beforeEach(() => {
  h.createFeedbackOnServer.mockReset();
  h.logEventMutate.mockClear();
  h.updatePreferences.mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.error).mockClear();
});

const submitFeedback = (content: string) => {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: content } });
  fireEvent.click(screen.getByTestId('help-modal-feedback-submit-btn'));
};

describe('HelpModal', () => {
  it('does not toast at all while the submission is still pending (no premature success toast)', async () => {
    h.createFeedbackOnServer.mockReturnValue(new Promise(() => {}));
    renderModal();

    submitFeedback('great app');

    await waitFor(() => expect(h.createFeedbackOnServer).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('shows a success toast and logs the event once delivery succeeds', async () => {
    h.createFeedbackOnServer.mockResolvedValue({
      id: 'fb1',
      content: 'great app',
      delivery: { delivered: true, channels: {} },
    });
    renderModal();

    submitFeedback('great app');

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(toast.warning).not.toHaveBeenCalled();
    // Content must never reach the analytics event - CounterLog has no TTL, and logging the
    // verbatim report text there would defeat the 90-day retention the FeedbackText split enforces.
    expect(h.logEventMutate).toHaveBeenCalledWith(expect.objectContaining({ metadata: { id: 'fb1' } }));
  });

  it('shows a warning toast instead of success when nothing was delivered', async () => {
    h.createFeedbackOnServer.mockResolvedValue({
      id: 'fb1',
      content: 'great app',
      delivery: { delivered: false, channels: {} },
    });
    renderModal();

    submitFeedback('great app');

    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('falls back to the success toast, not a throw, when a rolling deploy returns no delivery field', async () => {
    h.createFeedbackOnServer.mockResolvedValue({ id: 'fb1', content: 'great app' });
    renderModal();

    submitFeedback('great app');

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('warns the reporter when their content was truncated, even though delivery succeeded', async () => {
    h.createFeedbackOnServer.mockResolvedValue({
      id: 'fb1',
      content: 'a very long report cut at the cap',
      contentTruncated: true,
      delivery: { delivered: true, channels: {} },
    });
    renderModal();

    submitFeedback('a very long report cut at the cap');

    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('trim'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('warns the reporter when the text itself failed to save', async () => {
    h.createFeedbackOnServer.mockResolvedValue({
      id: 'fb1',
      contentStored: false,
      delivery: { delivered: true, channels: {} },
    });
    renderModal();

    submitFeedback('great app');

    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('could not save'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('does not call the API or toast for empty/whitespace-only content', () => {
    renderModal();

    submitFeedback('   ');

    expect(h.createFeedbackOnServer).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
