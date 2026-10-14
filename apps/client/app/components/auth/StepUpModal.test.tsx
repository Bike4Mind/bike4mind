// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { useStepUpStore } from '@client/app/stores/useStepUpStore';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockStartAuthentication = vi.fn();

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: (...args: unknown[]) => mockGet(...args), post: (...args: unknown[]) => mockPost(...args) },
}));
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: (...args: unknown[]) => mockStartAuthentication(...args),
  startRegistration: vi.fn(),
  browserSupportsWebAuthn: () => true,
}));

import StepUpModal from './StepUpModal';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderModal = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <StepUpModal />
    </CssVarsProvider>
  );

const openWith = async (methods: string[]) => {
  mockGet.mockResolvedValue({ data: { methods, stepUpUntil: null } });
  renderModal();
  let pending: Promise<void> = Promise.resolve();
  act(() => {
    pending = useStepUpStore.getState().requestStepUp();
  });
  return { pending };
};

const axiosFailure = (data: unknown) => Object.assign(new Error('fail'), { isAxiosError: true, response: { data } });

describe('StepUpModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStepUpStore.setState({ open: false, pending: null, resolvePending: null, rejectPending: null });
  });

  it('is closed until a step-up is requested', () => {
    renderModal();
    expect(screen.queryByTestId('step-up-modal-cancel-btn')).toBeNull();
  });

  it('shows only the methods the server offers', async () => {
    await openWith(['totp']);
    await screen.findByTestId('step-up-modal-totp-input');
    expect(screen.getByText("Confirm it's you")).toBeTruthy();
    expect(screen.queryByTestId('step-up-modal-password-input')).toBeNull();
    expect(screen.queryByTestId('step-up-modal-passkey-btn')).toBeNull();
  });

  it('verifies a TOTP code and resolves the pending request', async () => {
    const { pending } = await openWith(['totp']);
    mockPost.mockResolvedValue({ data: { stepUpUntil: 'x' } });
    fireEvent.change(await screen.findByTestId('step-up-modal-totp-input'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('step-up-modal-verify-btn'));

    await expect(pending).resolves.toBeUndefined();
    expect(mockPost).toHaveBeenCalledWith('/api/auth/step-up', { method: 'totp', code: '123456' });
    expect(useStepUpStore.getState().open).toBe(false);
  });

  it('shows the server error and attempts remaining on a wrong code', async () => {
    await openWith(['totp']);
    mockPost.mockRejectedValue(axiosFailure({ error: 'Invalid code', attemptsRemaining: 2 }));
    fireEvent.change(await screen.findByTestId('step-up-modal-totp-input'), { target: { value: '000000' } });
    fireEvent.click(screen.getByTestId('step-up-modal-verify-btn'));

    const alert = await screen.findByTestId('step-up-modal-error');
    expect(alert.textContent).toContain('Invalid code (2 attempts remaining)');
    expect(useStepUpStore.getState().open).toBe(true);
  });

  it('shows only the server message once no attempts remain', async () => {
    await openWith(['totp']);
    mockPost.mockRejectedValue(
      axiosFailure({ error: 'This code has expired. Request a new one.', attemptsRemaining: 0 })
    );
    fireEvent.change(await screen.findByTestId('step-up-modal-totp-input'), { target: { value: '000000' } });
    fireEvent.click(screen.getByTestId('step-up-modal-verify-btn'));

    const alert = await screen.findByTestId('step-up-modal-error');
    expect(alert.textContent).toBe('This code has expired. Request a new one.');
  });

  it('offers a retry when the options fail to load, without claiming no method exists', async () => {
    mockGet
      .mockRejectedValueOnce(axiosFailure({ error: 'Server unavailable' }))
      .mockResolvedValueOnce({ data: { methods: ['totp'], stepUpUntil: null } });
    renderModal();
    act(() => {
      void useStepUpStore
        .getState()
        .requestStepUp()
        .catch(() => undefined);
    });

    expect((await screen.findByTestId('step-up-modal-load-error')).textContent).toContain('Server unavailable');
    expect(screen.queryByTestId('step-up-modal-no-methods')).toBeNull();

    fireEvent.click(screen.getByTestId('step-up-modal-retry-btn'));
    await screen.findByTestId('step-up-modal-totp-input');
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('step-up-modal-load-error')).toBeNull();
  });

  it('says no method is available only when the server returns none', async () => {
    await openWith([]);
    await screen.findByTestId('step-up-modal-no-methods');
    expect(screen.queryByTestId('step-up-modal-load-error')).toBeNull();
  });

  it('keeps Cancel disabled while a verification is in flight', async () => {
    await openWith(['totp']);
    let finish: (value: unknown) => void = () => undefined;
    mockPost.mockReturnValue(new Promise(resolve => (finish = resolve)));
    fireEvent.change(await screen.findByTestId('step-up-modal-totp-input'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('step-up-modal-verify-btn'));

    const cancel = screen.getByTestId('step-up-modal-cancel-btn') as HTMLButtonElement;
    await waitFor(() => expect(cancel.disabled).toBe(true));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(useStepUpStore.getState().open).toBe(true);

    await act(async () => finish({ data: { stepUpUntil: 'x' } }));
    expect(useStepUpStore.getState().open).toBe(false);
  });

  it('runs the passkey ceremony', async () => {
    const { pending } = await openWith(['passkey']);
    mockStartAuthentication.mockResolvedValue({ id: 'cred' });
    mockPost.mockResolvedValue({ data: { challenge: 'c' } });
    fireEvent.click(await screen.findByTestId('step-up-modal-passkey-btn'));

    await expect(pending).resolves.toBeUndefined();
    expect(mockPost).toHaveBeenNthCalledWith(1, '/api/auth/step-up/passkey-options');
    expect(mockPost).toHaveBeenNthCalledWith(2, '/api/auth/step-up', { method: 'passkey', response: { id: 'cred' } });
  });

  it('verifies a password', async () => {
    const { pending } = await openWith(['password']);
    mockPost.mockResolvedValue({ data: {} });
    fireEvent.change(await screen.findByTestId('step-up-modal-password-input'), { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByTestId('step-up-modal-password-verify-btn'));

    await expect(pending).resolves.toBeUndefined();
    expect(mockPost).toHaveBeenCalledWith('/api/auth/step-up', { method: 'password', password: 'hunter2' });
  });

  it('sends an email code, then verifies it with the pending token', async () => {
    const { pending } = await openWith(['email']);
    mockPost.mockResolvedValueOnce({ data: { pendingToken: 'tok' } }).mockResolvedValueOnce({ data: {} });
    fireEvent.click(await screen.findByTestId('step-up-modal-email-send-btn'));
    fireEvent.change(await screen.findByTestId('step-up-modal-email-code-input'), { target: { value: '12345678' } });
    fireEvent.click(screen.getByTestId('step-up-modal-email-verify-btn'));

    await expect(pending).resolves.toBeUndefined();
    expect(mockPost).toHaveBeenNthCalledWith(1, '/api/auth/step-up/email/send');
    expect(mockPost).toHaveBeenNthCalledWith(2, '/api/auth/step-up', {
      method: 'email',
      pendingToken: 'tok',
      code: '12345678',
    });
  });

  it('sends a new email code on request and verifies with the newest token', async () => {
    const { pending } = await openWith(['email']);
    mockPost
      .mockResolvedValueOnce({ data: { pendingToken: 'tok-1' } })
      .mockResolvedValueOnce({ data: { pendingToken: 'tok-2' } })
      .mockResolvedValueOnce({ data: {} });
    fireEvent.click(await screen.findByTestId('step-up-modal-email-send-btn'));
    fireEvent.click(await screen.findByTestId('step-up-modal-email-resend-btn'));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByTestId('step-up-modal-email-code-input'), { target: { value: '12345678' } });
    await waitFor(() =>
      expect((screen.getByTestId('step-up-modal-email-verify-btn') as HTMLButtonElement).disabled).toBe(false)
    );
    fireEvent.click(screen.getByTestId('step-up-modal-email-verify-btn'));

    await expect(pending).resolves.toBeUndefined();
    expect(mockPost).toHaveBeenNthCalledWith(2, '/api/auth/step-up/email/send');
    expect(mockPost).toHaveBeenNthCalledWith(3, '/api/auth/step-up', {
      method: 'email',
      pendingToken: 'tok-2',
      code: '12345678',
    });
  });

  it('rejects the pending request on cancel', async () => {
    const { pending } = await openWith(['totp']);
    const rejection = expect(pending).rejects.toThrow('cancelled');
    fireEvent.click(await screen.findByTestId('step-up-modal-cancel-btn'));
    await rejection;
    await waitFor(() => expect(useStepUpStore.getState().open).toBe(false));
  });
});
