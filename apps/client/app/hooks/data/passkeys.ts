import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { IUserDocument } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';

export interface Passkey {
  id: string;
  name: string;
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

const QUERY_KEY = ['passkeys'];

export const passkeysSupported = (): boolean => browserSupportsWebAuthn();

/** A user-facing message for a failed passkey ceremony, whether the browser or the server refused it. */
export function describePasskeyError(error: unknown, fallback: string): string {
  if (isAxiosError(error)) {
    return (error.response?.data as { error?: string } | undefined)?.error || fallback;
  }
  const name = (error as { name?: string } | null)?.name;
  // The spec deliberately collapses "user cancelled" and "timed out" into NotAllowedError.
  if (name === 'NotAllowedError' || name === 'AbortError') return 'The passkey prompt was cancelled or timed out.';
  if (name === 'InvalidStateError') return 'This passkey is already registered on your account.';
  return fallback;
}

/** describePasskeyError plus the attempts left, for a passkey offered as the MFA second factor. */
export function describePasskeyMfaError(error: unknown): string {
  const attemptsRemaining = isAxiosError(error)
    ? (error.response?.data as { attemptsRemaining?: number } | undefined)?.attemptsRemaining
    : undefined;
  const attemptsInfo = attemptsRemaining ? ` (${attemptsRemaining} attempts remaining)` : '';
  return describePasskeyError(error, 'Passkey verification failed') + attemptsInfo;
}

export function usePasskeys(enabled = true) {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const response = await api.get<{ passkeys: Passkey[] }>('/api/auth/mfa/passkey');
      return response.data.passkeys;
    },
    enabled,
  });
}

export function useRegisterPasskey() {
  const queryClient = useQueryClient();
  return useMutation<Passkey, Error, { name?: string; token: string }>({
    mutationFn: async ({ name, token }) => {
      const { data: optionsJSON } = await api.post('/api/auth/mfa/passkey/register-options', { token });
      const response = await startRegistration({ optionsJSON });
      const { data } = await api.post<{ passkey: Passkey }>('/api/auth/mfa/passkey/register', { response, name });
      return data.passkey;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}

export function useRemovePasskey() {
  const queryClient = useQueryClient();
  return useMutation<{ removed: boolean; id: string }, Error, { id: string }>({
    mutationFn: async ({ id }) => {
      const response = await api.delete(`/api/auth/mfa/passkey/${id}`);
      return response.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}

/** Satisfies the login MFA challenge with a passkey; resolves to the same shape as useVerifyMFA. */
export function useVerifyPasskeyMFA() {
  return useMutation<
    { verified: true; accessToken: string; deviceRemembered: boolean; user: IUserDocument },
    Error,
    { rememberDevice?: boolean }
  >({
    mutationFn: async ({ rememberDevice }) => {
      const { data: optionsJSON } = await api.post('/api/auth/mfa/passkey/authenticate-options');
      const response = await startAuthentication({ optionsJSON });
      const { data } = await api.post('/api/auth/mfa/passkey/authenticate', { response, rememberDevice });
      return data;
    },
  });
}
