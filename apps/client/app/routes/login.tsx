import MultiStepLogin from '@client/app/components/MultiStepLogin';
import { clearClientCaches } from '@client/app/utils/clearClientCaches';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useUser } from '@client/app/contexts/UserContext';
import { usePublicConfig } from '@client/app/hooks/data/settings';
import { ACCESS_TOKEN_STORAGE_KEY, useAccessToken } from '@client/app/hooks/useAccessToken';
import { applyRedirect } from '@client/app/utils/authRedirect';
import { bootstrapSession } from '@client/app/utils/sessionBootstrap';
import { Box, CircularProgress } from '@mui/joy';
import { useRouter } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

const hasLiveSession = (): boolean => !!useAccessToken.getState().accessToken && !!useUser.getState().currentUser;

/**
 * Whether this page load should try to resume a session before showing the form. The refresh cookie
 * is HttpOnly, so the persisted `hasSession` flag (written by every tab on sign-in and cleared on
 * sign-out, expiry and mid-MFA) is the only hint; without it a signed-out visitor makes no refresh
 * call here. A sign-in error in the URL wins: the visitor came back to see it, not to be forwarded.
 */
const shouldResumeSession = (): boolean =>
  useAccessToken.getState().hasSession && !new URLSearchParams(window.location.search).has('error');

const storageSignalsSession = (newValue: string | null): boolean => {
  try {
    return (JSON.parse(newValue ?? '') as { state?: { hasSession?: unknown } })?.state?.hasSession === true;
  } catch {
    return false;
  }
};

const LoginPage = () => {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { data: publicConfig } = usePublicConfig();
  const [checkingSession, setCheckingSession] = useState(shouldResumeSession);

  useEffect(() => {
    // Same allow-list and fallback MultiStepLogin applies after a fresh sign-in.
    const forward = () =>
      applyRedirect(router.history, new URLSearchParams(window.location.search).get('redirectTo'), '/new', true);

    // Clear all client-side persistence (IndexedDB) before removing in-memory queries
    // to avoid the persist-after-delete race.
    // Use a cancelled flag so that if the user logs in and navigates away before
    // clearClientCaches() resolves, we don't removeQueries() on the newly-mounted
    // ProviderBundle's queries - which would reset adminSettingsLoading and leave
    // MFAEnforcementWrapper stuck on its loader.
    let cancelled = false;
    const resumeOrClear = async () => {
      // The resume must run before the teardown below: removeQueries and the cache wipe would drop
      // the very session the shared bootstrap is about to establish (see sessionBootstrap.ts).
      if (shouldResumeSession()) {
        await bootstrapSession();
        if (cancelled) return;
        if (hasLiveSession()) {
          forward();
          return;
        }
        setCheckingSession(false);
      }
      await clearClientCaches();
      if (cancelled) return;
      // clearClientCaches dropped the persisted 'llm-settings', but an in-app navigation here keeps
      // the in-memory store, which would re-persist the previous identity's model on its next write.
      useLLM.getState().resetSettings();
      // Preserve server-config-public: it contains only apiUrl + defaultTheme and is not user-specific.
      // The full server-config (auth'd) is intentionally purged on logout to prevent
      // bucket names and the PDF Express key from persisting in memory across sessions.
      queryClient.removeQueries({
        predicate: query => query.queryKey[0] !== 'server-config-public',
      });
    };
    void resumeOrClear();

    // A sign-in in another tab writes hasSession: true to the shared store; the 'storage' event only
    // fires in the other tabs, so this never reacts to this tab's own sign-in. A tab mid-MFA keeps
    // its own challenge rather than being swapped onto whatever session the other tab opened.
    const onStorage = (event: StorageEvent) => {
      if (event.key !== ACCESS_TOKEN_STORAGE_KEY || !storageSignalsSession(event.newValue)) return;
      if (useAccessToken.getState().mfaPending || hasLiveSession()) return;
      void bootstrapSession().then(() => {
        if (!cancelled && hasLiveSession()) forward();
      });
    };
    window.addEventListener('storage', onStorage);

    return () => {
      cancelled = true;
      window.removeEventListener('storage', onStorage);
    };
  }, [queryClient, router]);

  if (checkingSession) {
    return (
      <Box
        data-testid="login-session-check"
        sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}
      >
        <CircularProgress aria-label="Checking your session" data-testid="login-session-check-spinner" />
      </Box>
    );
  }

  return (
    <MultiStepLogin
      enableRegister={publicConfig?.allowOpenRegistration ?? false}
      enableSocials
      enableGithubAuth
      enableOktaAuth
      enableAppleAuth={publicConfig?.appleSignInEnabled ?? false}
    />
  );
};

export default LoginPage;
