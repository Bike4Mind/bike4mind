import { AuthStrategy, IUserDocument } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { useRouter, useSearch } from '@tanstack/react-router';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { applyRedirect } from '@client/app/utils/authRedirect';

interface LoginError {
  message: string;
  code?: string;
  details?: unknown;
  // Re-issued OTC pending token from a failed /api/otc/verify. The server rotates the
  // single-use nonce on every attempt and returns a fresh token, so the client MUST retry
  // with this one; reusing the original token fails the nonce check (a correct code would
  // then be rejected). Surfaced here so the login UI can swap it in before the next attempt.
  pendingToken?: string;
}

// OTC login response: successful login, MFA required, MFA setup required, or, for an
// email with no account, a signal to collect a username and finish registration inline.
type OTCVerifyResponse =
  | (IUserDocument & { accessToken: string; refreshToken: string })
  | { mfaRequired: true; userId: string; accessToken: string; refreshToken: string }
  | { mfaSetupRequired: true; userId: string; accessToken: string; refreshToken: string }
  | { registrationRequired: true; email: string; pendingToken: string };

interface OTCRegisterResponse {
  user: IUserDocument;
  accessToken: string;
  refreshToken: string;
}

interface SendOTCData {
  email: string;
}

interface SendOTCResponse {
  pendingToken: string;
}

interface VerifyOTCData {
  email: string;
  code: string;
  username?: string;
  pendingToken?: string;
  // P0-B abuse gate: only sent on the new-user branch (username present). The server
  // rejects registration if the version isn't current or the age attestation isn't true.
  acceptedPolicyVersion?: string;
  ageAttestation?: boolean;
  clientData?: {
    userAgent: string;
    browserLanguage: string;
    platform: string;
    screenResolution: string;
    viewportSize: string;
    colorDepth: number;
    pixelDepth: number;
    devicePixelRatio: number;
    browser?: string;
    operatingSystem?: string;
    deviceType?: string;
  };
}

export function useSendOTC() {
  return useMutation<SendOTCResponse, LoginError, SendOTCData>({
    mutationFn: async (data: SendOTCData) => {
      try {
        const response = await api.post<SendOTCResponse>('/api/otc/send', data);
        return response.data;
      } catch (error) {
        if (error instanceof AxiosError && error.response) {
          throw {
            message: error.response.data.error || `HTTP ${error.response.status}`,
            code: `CLIENT_ERROR_${error.response.status}`,
          };
        }
        throw {
          message: error instanceof Error ? error.message : 'An unexpected error occurred',
          code: 'UNEXPECTED_ERROR',
        };
      }
    },
  });
}

export function useVerifyOTC() {
  return useMutation<OTCVerifyResponse | OTCRegisterResponse, LoginError, VerifyOTCData>({
    mutationFn: async (data: VerifyOTCData) => {
      try {
        const response = await api.post<OTCVerifyResponse | OTCRegisterResponse>('/api/otc/verify', data);
        return response.data;
      } catch (error) {
        if (error instanceof AxiosError && error.response) {
          throw {
            message: error.response.data.error || `HTTP ${error.response.status}`,
            code: `CLIENT_ERROR_${error.response.status}`,
            // Preserve the re-issued pending token (rotated nonce) so the caller can retry
            // with it; dropping it here strands the user on a valid code (see LoginError).
            pendingToken: error.response.data.pendingToken,
          };
        }
        throw {
          message: error instanceof Error ? error.message : 'An unexpected error occurred',
          code: 'UNEXPECTED_ERROR',
        };
      }
    },
  });
}

export function useSendEmailVerification() {
  return useMutation({
    mutationFn: async () => {
      await api.post('/api/email/send-verification');
    },
    onSuccess: () => {
      toast.success('Verification email sent! Please check your inbox.');
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to send verification email');
    },
  });
}

export function useResendEmailVerification() {
  return useMutation({
    mutationFn: async () => {
      await api.post('/api/email/resend-verification');
    },
    onSuccess: () => {
      toast.success('Verification email resent! Please check your inbox.');
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to resend verification email');
    },
  });
}

export const useAuthCallback = (
  strategy: string | string[] | undefined,
  code: string | string[] | undefined,
  state: string | string[] | undefined
) => {
  const { setCurrentUser } = useUser();
  const router = useRouter();
  const search = useSearch({ strict: false });

  const oauthCallback = useQuery({
    queryKey: ['auth', strategy, code, state],
    queryFn: async () => {
      try {
        const params = new URLSearchParams({ code: code as string });
        if (strategy === AuthStrategy.Okta && state !== undefined) {
          params.append('state', state as string);
        }
        const { data } = await api.get<IUserDocument & { accessToken: string; refreshToken: string }>(
          `/api/auth/${strategy}/callback?${params.toString()}`
        );
        return data;
      } catch (err) {
        console.error('Error in callback:', err);
        toast.error('Authentication Error');
      }
    },
    enabled: !!strategy && !!code,
  });

  // Handles successful callback
  useEffect(() => {
    if (oauthCallback.data) {
      const user = oauthCallback.data;
      useAccessToken.getState().setVerifiedTokens(user.accessToken, user.refreshToken);
      setCurrentUser(user);
      // Route the user-controlled redirectTo through sanitizeRedirectTo so an
      // open-redirect can't ride the OAuth callback. Falls back to /new.
      applyRedirect(router.history, (search as any)?.redirectTo, '/new');
    }
  }, [oauthCallback.data, router, setCurrentUser, search]);

  return oauthCallback;
};
