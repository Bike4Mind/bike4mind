import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearch, useRouter } from '@tanstack/react-router';
import { Box, Button, Checkbox, Container, Sheet, Stack, Typography, Link } from '@mui/joy';
import GppGoodIcon from '@mui/icons-material/GppGood';
import Image from 'next/image';
import { withRetry } from '@bike4mind/common';

import { useUser } from '@client/app/contexts/UserContext';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import {
  api,
  forceSessionExpiredRedirect,
  getAxiosErrorStatus,
  getAxiosRetryCount,
} from '@client/app/contexts/ApiContext';
import { useGetIdentify } from '@client/app/hooks/data/user';
import useGetLogo from '@client/app/hooks/useGetLogo';
import { ExternalLinks, CHECKBOX_LABEL_LINK_SX } from '@client/app/utils/externalLinks';
import { applyRedirect } from '@client/app/utils/authRedirect';

// One backoff retry before giving up on a submit 401 - see the isRetryable predicate below.
const SUBMIT_RETRY_DELAY_MS = 1000;

/**
 * P0-B abuse gate interstitial. Shown to any authenticated account that has not yet
 * recorded an AUP/ToS acceptance - in practice a brand-new OAuth/SAML/Okta user, since the
 * credentials path records acceptance at registration. This is the UX layer; the actual
 * enforcement is the server consent-gate middleware in apps/client/server/auth/auth.ts, which
 * 403s every other authenticated endpoint until acceptance is recorded. A browser user is routed
 * here smoothly by the router `beforeLoad` guard instead of hitting opaque 403s.
 */
const AcceptPoliciesPage = () => {
  const navigate = useNavigate();
  const router = useRouter();
  const search = useSearch({ strict: false });
  const { currentUser, setCurrentUser } = useUser();
  const { accessToken, mfaPending } = useAccessToken();
  const identity = useGetIdentify();
  const logoUrl = useGetLogo();

  const [acceptPolicies, setAcceptPolicies] = useState(false);
  const [confirmAdult, setConfirmAdult] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set right before calling forceSessionExpiredRedirect() so the effect below (which
  // re-runs when that call's markSessionExpired() clears accessToken) can tell "we're
  // already mid-teardown, the hard redirect is already coming" apart from a page load
  // that genuinely never had a token, and skip firing a second, uninformative soft nav.
  const tearingDownRef = useRef(false);
  // Aborted on unmount so a pending submit-retry backoff (see handleSubmit) doesn't fire
  // a pointless extra request, or its follow-on state updates, after the user has left.
  const submitAbortControllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => submitAbortControllerRef.current?.abort();
  }, []);

  const redirectTo = (search as { redirectTo?: string }).redirectTo;

  // True only once identify has both a confirmed 401 (not mfaPending, which both ApiContext's
  // interceptor and UserContext's bootstrap effect also exempt - no refresh token is issued
  // during mfaPending by design, so a 401 there is expected) AND retryCount >= 1, meaning
  // ApiContext's interceptor already completed its own refresh-succeeded-then-retried cycle
  // and still got 401. A first-attempt 401 (retryCount 0) can equally mean the refresh
  // endpoint itself failed transiently - a case the interceptor deliberately does NOT treat as
  // unrecoverable, to avoid a spurious logout on e.g. a cold Lambda right after a deploy - so
  // this page must not force a teardown on that signal alone either.
  const sessionUnverified =
    identity.isError &&
    !mfaPending &&
    getAxiosErrorStatus(identity.error) === 401 &&
    getAxiosRetryCount(identity.error) >= 1;

  // Guard the guard: no token -> login; already-accepted user -> don't trap them on this page;
  // unverifiable session -> tear down the same way any other unrecoverable 401 does instead of
  // stranding the user on an interstitial their session can't back.
  useEffect(() => {
    if (!accessToken) {
      if (!tearingDownRef.current) {
        navigate({ to: '/login', replace: true });
      }
      return;
    }
    if (currentUser?.aupAcceptedVersion) {
      applyRedirect(router.history, redirectTo, '/', true);
      return;
    }
    if (sessionUnverified) {
      tearingDownRef.current = true;
      void forceSessionExpiredRedirect();
    }
  }, [accessToken, currentUser, sessionUnverified, navigate, redirectTo, router]);

  const isFormValid = acceptPolicies && confirmAdult;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFormValid || isSubmitting) return;

    setError(null);
    setIsSubmitting(true);

    const controller = new AbortController();
    submitAbortControllerRef.current = controller;

    try {
      const { result: response } = await withRetry(
        () => api.post('/api/user/accept-policies', { ageAttestation: true }),
        {
          maxRetries: 1,
          initialDelayMs: SUBMIT_RETRY_DELAY_MS,
          abortSignal: controller.signal,
          // Only a first-attempt 401 (config._retryCount still 0 - the interceptor's own
          // refresh attempt itself failed, not yet retried) is worth a retry: a confirmed
          // 400/401 refresh rejection already redirects via the interceptor before this catch
          // ever runs, so a persisting 401 here means either a transient refresh outage worth
          // one more try, or (once retried) the interceptor's own refresh-succeeded-then-retried
          // cycle already failed - not something a resubmit can fix. mfaPending is re-read live
          // (not closed over) since this predicate can run up to a second after the original call.
          isRetryable: err =>
            !useAccessToken.getState().mfaPending && getAxiosErrorStatus(err) === 401 && getAxiosRetryCount(err) === 0,
        }
      );
      // Update currentUser so the consent gate clears (both the server field and this client state).
      setCurrentUser(response.data.user);
      applyRedirect(router.history, redirectTo, '/', true);
    } catch (err: unknown) {
      const message =
        (err as { response?: { data?: { error?: string } }; message?: string }).response?.data?.error ||
        (err as Error).message ||
        'Failed to record acceptance';

      if (!useAccessToken.getState().mfaPending && getAxiosErrorStatus(err) === 401) {
        // Retries exhausted (or none were warranted) - not something resubmitting can fix.
        setError(message);
        await forceSessionExpiredRedirect();
        setIsSubmitting(false);
        return;
      }

      // Unrelated to the session (5xx, validation, network) - just show it, retryable indefinitely.
      setError(message);
      setIsSubmitting(false);
    }
  };

  return (
    <Box
      sx={theme => ({
        backgroundColor: theme.palette.background.surface,
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        p: 2,
      })}
    >
      <Container maxWidth="sm">
        <Sheet variant="outlined" sx={{ p: 4, borderRadius: 'lg', boxShadow: 'lg' }}>
          <form onSubmit={handleSubmit}>
            <Stack spacing={3}>
              <Box sx={{ display: 'flex', justifyContent: 'center' }}>
                <Box sx={{ position: 'relative', width: 64, height: 64 }}>
                  <Image src={logoUrl} alt="Logo" fill style={{ objectFit: 'contain' }} />
                </Box>
              </Box>

              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1.5 }}>
                <GppGoodIcon sx={{ fontSize: 32, color: 'primary.500' }} />
                <Typography level="h3">Before you continue</Typography>
              </Box>

              <Typography level="body-md" sx={{ color: 'text.secondary', textAlign: 'center' }}>
                To use your account, please review and accept our policies and confirm your age.
              </Typography>

              {error && (
                <Box
                  sx={{
                    p: 2,
                    borderRadius: 'sm',
                    bgcolor: 'danger.softBg',
                    border: '1px solid',
                    borderColor: 'danger.outlinedBorder',
                  }}
                >
                  <Typography level="body-sm" sx={{ color: 'danger.700' }}>
                    {error}
                  </Typography>
                </Box>
              )}

              <Stack spacing={1.5}>
                <Checkbox
                  data-testid="accept-policies-checkbox"
                  checked={acceptPolicies}
                  onChange={e => setAcceptPolicies(e.target.checked)}
                  disabled={isSubmitting || sessionUnverified}
                  label={
                    <Typography sx={{ fontSize: '14px' }}>
                      I agree to the{' '}
                      <Link
                        href={ExternalLinks.terms}
                        target="_blank"
                        rel="noopener noreferrer"
                        sx={CHECKBOX_LABEL_LINK_SX}
                      >
                        Terms of Service
                      </Link>
                      ,{' '}
                      <Link
                        href={ExternalLinks.acceptableUse}
                        target="_blank"
                        rel="noopener noreferrer"
                        sx={CHECKBOX_LABEL_LINK_SX}
                      >
                        Acceptable Use Policy
                      </Link>
                      , and{' '}
                      <Link
                        href={ExternalLinks.privacy}
                        target="_blank"
                        rel="noopener noreferrer"
                        sx={CHECKBOX_LABEL_LINK_SX}
                      >
                        Privacy Policy
                      </Link>
                    </Typography>
                  }
                />
                <Checkbox
                  data-testid="accept-age-checkbox"
                  checked={confirmAdult}
                  onChange={e => setConfirmAdult(e.target.checked)}
                  disabled={isSubmitting || sessionUnverified}
                  label={<Typography sx={{ fontSize: '14px' }}>I confirm I am 18 years of age or older</Typography>}
                />
              </Stack>

              <Button
                type="submit"
                color="primary"
                variant="solid"
                loading={isSubmitting}
                disabled={!isFormValid || isSubmitting || sessionUnverified}
                fullWidth
                size="lg"
                data-testid="accept-policies-submit-btn"
              >
                Accept and continue
              </Button>
            </Stack>
          </form>
        </Sheet>
      </Container>
    </Box>
  );
};

export default AcceptPoliciesPage;
