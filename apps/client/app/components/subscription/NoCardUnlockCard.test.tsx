import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { NoCardUnlockCard } from './NoCardUnlockCard';

const state = vi.hoisted(() => ({
  enabled: true,
  probeAllows: true,
  phoneEnabled: false,
  mutate: vi.fn(),
  startPhone: vi.fn(),
  verifyPhone: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({
    getSettingBoolean: (key: string) =>
      ({
        noCardUnlockEnabled: state.enabled,
        noCardUnlockProbeInconclusiveAllows: state.probeAllows,
        noCardUnlockPhoneEnabled: state.phoneEnabled,
      })[key] ?? false,
  }),
}));
vi.mock('@client/app/hooks/data/noCardUnlock', () => ({
  useNoCardUnlock: () => ({ mutate: state.mutate }),
  usePhoneUnlockStart: () => ({ mutate: state.startPhone, isPending: false }),
  usePhoneUnlockVerify: () => ({ mutate: state.verifyPhone, isPending: false }),
}));

const theme = extendTheme({ ...getThemeConfig() });
const renderCard = () =>
  render(
    <CssVarsProvider theme={theme}>
      <NoCardUnlockCard />
    </CssVarsProvider>
  );

const respondWith = (result: { creditsGranted: number; currentCredits: number; refusal?: string }) =>
  state.mutate.mockImplementation((_reason, opts) => {
    opts.onSuccess(result);
    opts.onSettled();
  });

describe('NoCardUnlockCard', () => {
  beforeEach(() => {
    state.enabled = true;
    state.probeAllows = true;
    state.phoneEnabled = false;
    state.mutate.mockReset();
    state.startPhone.mockReset();
    state.verifyPhone.mockReset();
  });

  it('renders nothing when the unlock is disabled', () => {
    state.enabled = false;
    renderCard();
    expect(screen.queryByTestId('no-card-unlock-card')).toBeNull();
  });

  it('shows success after a grant', async () => {
    respondWith({ creditsGranted: 5, currentCredits: 5 });
    renderCard();
    fireEvent.click(screen.getByTestId('no-card-unlock-github-btn'));
    await waitFor(() => expect(screen.getByTestId('no-card-unlock-success')).toBeTruthy());
    expect(state.mutate.mock.calls[0][0]).toBe('github_verified');
  });

  it('shows a refusal message', async () => {
    respondWith({ creditsGranted: 0, currentCredits: 0, refusal: 'github_too_new' });
    renderCard();
    fireEvent.click(screen.getByTestId('no-card-unlock-github-btn'));
    await waitFor(() => expect(screen.getByTestId('no-card-unlock-refusal')).toBeTruthy());
    expect(screen.queryByTestId('no-card-unlock-integrations-link')).toBeNull();
  });

  it('links to Integrations when reauthorization is needed', async () => {
    respondWith({ creditsGranted: 0, currentCredits: 0, refusal: 'github_reauthorize_required' });
    renderCard();
    fireEvent.click(screen.getByTestId('no-card-unlock-github-btn'));
    const link = await screen.findByTestId('no-card-unlock-integrations-link');
    expect(link.getAttribute('href')).toBe('/integrations');
  });

  it('uses the work email reason for the work email button', () => {
    state.mutate.mockImplementation(() => {});
    renderCard();
    fireEvent.click(screen.getByTestId('no-card-unlock-work-email-btn'));
    expect(state.mutate.mock.calls[0][0]).toBe('work_email_verified');
  });

  it('hides the work email button while inconclusive probe results are not allowed', () => {
    state.probeAllows = false;
    renderCard();
    expect(screen.getByTestId('no-card-unlock-github-btn')).toBeTruthy();
    expect(screen.queryByTestId('no-card-unlock-work-email-btn')).toBeNull();
  });

  it('shows the error alert when the request fails', async () => {
    state.mutate.mockImplementation((_reason, opts) => {
      opts.onError(new Error('network'));
      opts.onSettled();
    });
    renderCard();
    fireEvent.click(screen.getByTestId('no-card-unlock-github-btn'));
    await waitFor(() => expect(screen.getByTestId('no-card-unlock-error')).toBeTruthy());
  });

  describe('phone unlock', () => {
    const settleWith = (mock: ReturnType<typeof vi.fn>, result: unknown) =>
      mock.mockImplementation((_arg, opts) => {
        opts.onSuccess(result);
        opts.onSettled();
      });

    it('is hidden until its own toggle is on', () => {
      renderCard();
      expect(screen.queryByTestId('no-card-unlock-phone-btn')).toBeNull();
    });

    it('sends a code, then verifies it and shows success', async () => {
      state.phoneEnabled = true;
      settleWith(state.startPhone, { sent: true });
      settleWith(state.verifyPhone, { creditsGranted: 3, currentCredits: 3 });
      renderCard();
      fireEvent.click(screen.getByTestId('no-card-unlock-phone-btn'));
      fireEvent.change(screen.getByTestId('no-card-unlock-phone-input'), { target: { value: ' +14155552671 ' } });
      fireEvent.click(screen.getByTestId('no-card-unlock-phone-send-btn'));
      expect(state.startPhone.mock.calls[0][0]).toBe('+14155552671');

      const codeInput = await screen.findByTestId('no-card-unlock-phone-code-input');
      const verifyBtn = screen.getByTestId('no-card-unlock-phone-verify-btn');
      expect((verifyBtn as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(codeInput, { target: { value: '123456' } });
      fireEvent.click(screen.getByTestId('no-card-unlock-phone-verify-btn'));
      expect(state.verifyPhone.mock.calls[0][0]).toBe('123456');
      await waitFor(() => expect(screen.getByTestId('no-card-unlock-success')).toBeTruthy());
    });

    it('shows the line-type refusal and stays on the number step', async () => {
      state.phoneEnabled = true;
      settleWith(state.startPhone, { sent: false, refusal: 'phone_line_type' });
      renderCard();
      fireEvent.click(screen.getByTestId('no-card-unlock-phone-btn'));
      fireEvent.change(screen.getByTestId('no-card-unlock-phone-input'), { target: { value: '+14155552671' } });
      fireEvent.click(screen.getByTestId('no-card-unlock-phone-send-btn'));
      const refusal = await screen.findByTestId('no-card-unlock-refusal');
      expect(refusal.textContent).toContain('Only mobile numbers qualify');
      expect(screen.getByTestId('no-card-unlock-phone-input')).toBeTruthy();
      expect(state.verifyPhone).not.toHaveBeenCalled();
    });
  });
});
