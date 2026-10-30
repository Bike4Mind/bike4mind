import {
  AuthStrategy,
  IUserDocument,
  clientIdFromAuthorizeRedirect,
  isTurnstileOAuthProvider,
  TURNSTILE_ACTION_OAUTH_START,
  TURNSTILE_ACTION_OTC_SEND,
  TURNSTILE_OAUTH_TOKEN_PARAM,
} from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { useRouter, useSearch } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { applyRedirect, appendRedirectTo } from '@client/app/utils/authRedirect';
import {
  getTurnstileToken,
  TurnstileCancelledError,
  TurnstileError,
  turnstileFailureMessage,
} from '@client/app/utils/turnstile';
import type { ServerConfigPublic } from '@pages/api/settings/serverConfigPublic';
import type { TurnstileClientFailure } from '@pages/api/turnstile/client-failure';

interface LoginError {
  message: string;
  code?: string;
  retryAfterSeconds?: number;
  details?: unknown;
  // Re-issued OTC pending token from a failed /api/otc/verify. The server rotates the
  // single-use nonce on every attempt and returns a fresh token, so the client MUST retry
  // with this one; reusing the original token fails the nonce check (a correct code would
  // then be rejected). Surfaced here so the login UI can swap it in before the next attempt.
  pendingToken?: string;
}

// OTC login response: successful login, MFA required, MFA setup required, or, for an
// email with no account, a signal to collect a username and finish registration inline.
// The refresh token is absent from every shape: login endpoints set it as an HttpOnly cookie
// (packages/server-utils/src/auth/refreshCookie.ts) rather than returning it.
type OTCVerifyResponse =
  | (IUserDocument & { accessToken: string })
  | { mfaRequired: true; userId: string; accessToken: string; passkeyAvailable?: boolean }
  | { mfaSetupRequired: true; userId: string; accessToken: string }
  | { registrationRequired: true; registrationAllowed?: boolean; email: string; pendingToken: string };

interface OTCRegisterResponse {
  user: IUserDocument;
  accessToken: string;
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
  inviteCode?: string;
  pendingToken?: string;
  // client_id of the /oauth/authorize request this signup started from; the server only uses it
  // to attribute a newly created account.
  sourceClientId?: string;
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
  const queryClient = useQueryClient();
  return useMutation<SendOTCResponse, LoginError, SendOTCData>({
    mutationFn: async (data: SendOTCData) => {
      try {
        const turnstileToken = await solveTurnstileIfRequired(queryClient, TURNSTILE_ACTION_OTC_SEND);
        const response = await api.post<SendOTCResponse>('/api/otc/send', { ...data, turnstileToken });
        return response.data;
      } catch (error) {
        if (error instanceof AxiosError && error.response) {
          throw {
            message: error.response.data?.error || `HTTP ${error.response.status}`,
            code: `CLIENT_ERROR_${error.response.status}`,
            retryAfterSeconds: parseRetryAfter(error.response.headers?.['retry-after']),
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

// Fresh token per attempt: Turnstile tokens are single-use, so retries solve again. Returns undefined
// when the stage does not enforce the challenge.
type TurnstileAction = TurnstileClientFailure['action'];

export async function solveTurnstileIfRequired(
  queryClient: QueryClient,
  action: TurnstileAction
): Promise<string | undefined> {
  const config = await queryClient.fetchQuery({
    queryKey: ['server-config-public'],
    queryFn: async () => (await api.get<ServerConfigPublic>('/api/settings/serverConfigPublic')).data,
    staleTime: 1000 * 60 * 5,
  });
  if (!config?.turnstileSiteKey) return undefined;
  try {
    return await getTurnstileToken(config.turnstileSiteKey, action);
  } catch (error) {
    if (error instanceof TurnstileCancelledError) {
      throw new Error('Verification cancelled. Try again when you are ready.');
    }
    reportTurnstileFailure(action, error);
    throw new Error(turnstileFailureMessage(error));
  }
}

/**
 * Tells the server a challenge failed in the browser, which it otherwise never sees. Fire-and-forget:
 * the user already gets the sign-in error, and a failed report must not replace it.
 */
function reportTurnstileFailure(action: TurnstileAction, error: unknown): void {
  const failure: TurnstileClientFailure =
    error instanceof TurnstileError
      ? { action, reason: error.reason, errorCode: error.errorCode, attempts: error.attempts }
      : { action, reason: 'unavailable', attempts: 1 };
  api.post('/api/turnstile/client-failure', failure).catch((reportError: unknown) => {
    console.warn('Failed to report Turnstile client failure', reportError);
  });
}

/** The `<strategy>` segment of an `/api/auth/<strategy>` start URL, or undefined for any other path. */
export function oauthStartProvider(startUrl: string): string | undefined {
  const match = new URL(startUrl, 'http://localhost').pathname.match(/^\/api\/auth\/([^/]+)\/?$/);
  return match?.[1];
}

/**
 * Builds the full-page navigation target for an OAuth start URL: `redirectTo` survives the provider
 * round-trip through the state parameter and the solved challenge token, if any, rides in the query.
 */
export function oauthStartUrl(startUrl: string, redirectTo: string | null, turnstileToken?: string): string {
  const url = new URL(appendRedirectTo(startUrl, redirectTo), 'http://localhost');
  if (turnstileToken) url.searchParams.set(TURNSTILE_OAUTH_TOKEN_PARAM, turnstileToken);
  return `${url.pathname}${url.search}`;
}

/**
 * Navigates to an `/api/auth/<strategy>` start URL. Self-serve providers solve the Turnstile
 * challenge first and carry the token along; enterprise SSO and a disabled policy navigate as is.
 * Rejects without navigating when the challenge cannot be completed.
 */
export function useStartOAuthSignIn() {
  const queryClient = useQueryClient();
  // Synchronous: a double-clicked provider button must not start a second challenge while the first is open.
  const startingRef = useRef(false);
  // Back from the provider can restore this page from bfcache with the guard still set.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) startingRef.current = false;
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);
  return async (startUrl: string): Promise<void> => {
    if (startingRef.current) return;
    startingRef.current = true;
    try {
      const turnstileToken = isTurnstileOAuthProvider(oauthStartProvider(startUrl))
        ? await solveTurnstileIfRequired(queryClient, TURNSTILE_ACTION_OAUTH_START)
        : undefined;
      const redirectTo = new URLSearchParams(window.location.search).get('redirectTo');
      window.location.href = oauthStartUrl(startUrl, redirectTo, turnstileToken);
    } catch (error) {
      // Only cleared on failure: assigning href does not unload the page synchronously.
      startingRef.current = false;
      throw error;
    }
  };
}

// 0 is kept distinct from a missing header: the server sends it when a concurrent send superseded this one.
function parseRetryAfter(header: unknown): number | undefined {
  const text = header === undefined || header === null ? '' : String(header).trim();
  if (text === '') return undefined;
  const seconds = Number(text);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

export function useVerifyOTC() {
  return useMutation<OTCVerifyResponse | OTCRegisterResponse, LoginError, VerifyOTCData>({
    mutationFn: async (data: VerifyOTCData) => {
      try {
        const sourceClientId = clientIdFromAuthorizeRedirect(
          new URLSearchParams(window.location.search).get('redirectTo')
        );
        const body = sourceClientId ? { ...data, sourceClientId } : data;
        const response = await api.post<OTCVerifyResponse | OTCRegisterResponse>('/api/otc/verify', body);
        return response.data;
      } catch (error) {
        if (error instanceof AxiosError && error.response) {
          throw {
            message: error.response.data.error || `HTTP ${error.response.status}`,
            code: `CLIENT_ERROR_${error.response.status}`,
            // Preserve the re-issued pending token (rotated nonce) so the caller can retry
            // with it; dropping it here strands the user on a valid code (see LoginError).
            pendingToken: error.response.data.pendingToken,
            retryAfterSeconds: parseRetryAfter(error.response.headers?.['retry-after']),
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
        const { data } = await api.get<IUserDocument & { accessToken: string }>(
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
      useAccessToken.getState().setVerifiedSession(user.accessToken);
      setCurrentUser(user);
      // Route the user-controlled redirectTo through sanitizeRedirectTo so an
      // open-redirect can't ride the OAuth callback. Falls back to /new.
      applyRedirect(router.history, (search as any)?.redirectTo, '/new');
    }
  }, [oauthCallback.data, router, setCurrentUser, search]);

  return oauthCallback;
};
