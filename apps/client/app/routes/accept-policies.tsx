import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearch, useRouter } from '@tanstack/react-router';
import { Box, Button, Checkbox, Container, Sheet, Stack, Typography, Link } from '@mui/joy';
import GppGoodIcon from '@mui/icons-material/GppGood';
import Image from 'next/image';

import { useUser } from '@client/app/contexts/UserContext';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { api, forceSessionExpiredRedirect, getAxiosErrorStatus } from '@client/app/contexts/ApiContext';
import { useGetIdentify } from '@client/app/hooks/data/user';
import useGetLogo from '@client/app/hooks/useGetLogo';
import { ExternalLinks, CHECKBOX_LABEL_LINK_SX } from '@client/app/utils/externalLinks';
import { applyRedirect } from '@client/app/utils/authRedirect';

// A second consecutive 401 on submit here means the session couldn't be recovered
// even after ApiContext's own refresh retry - most likely a sustained transient
// refresh-endpoint outage (a confirmed 401/400 rejection already redirects via the
// interceptor itself before this catch runs). Don't leave the user resubmitting into
// a dead session forever; fall back to the same teardown used for any other
// unrecoverable 401. Only a 401 counts toward this - an unrelated failure (5xx,
// validation, network) says nothing about the session and should just be retryable.
const MAX_SUBMIT_ATTEMPTS = 2;

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
  const submitAttemptsRef = useRef(0);

  const redirectTo = (search as { redirectTo?: string }).redirectTo;

  // True when identify came back with a confirmed 401 (a stale token whose refresh attempt
  // itself failed, per ApiContext's transient-vs-confirmed distinction) - this page then has no
  // server-confirmed user to render off. Excludes mfaPending, which both ApiContext's interceptor
  // and UserContext's bootstrap effect also exempt: during mfaPending no refresh token is issued
  // by design, so a 401 here is expected, not a dead session. Also excludes anything other than a
  // confirmed 401 (5xx, network, an unrelated background-refetch blip on an otherwise-valid
  // session) - those say nothing about this session being unrecoverable.
  const sessionUnverified = identity.isError && !mfaPending && getAxiosErrorStatus(identity.error) === 401;

  // Guard the guard: no token -> login; already-accepted user -> don't trap them on this page;
  // unverifiable session -> tear down the same way any other unrecoverable 401 does instead of
  // stranding the user on an interstitial their session can't back.
  useEffect(() => {
    if (!accessToken) {
      navigate({ to: '/login', replace: true });
      return;
    }
    if (currentUser?.aupAcceptedVersion) {
      applyRedirect(router.history, redirectTo, '/', true);
      return;
    }
    if (sessionUnverified) {
      void forceSessionExpiredRedirect();
    }
  }, [accessToken, currentUser, sessionUnverified, navigate, redirectTo, router]);

  const isFormValid = acceptPolicies && confirmAdult;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFormValid || isSubmitting) return;

    setError(null);
    setIsSubmitting(true);
    try {
      const response = await api.post('/api/user/accept-policies', { ageAttestation: true });
      submitAttemptsRef.current = 0;
      // Update currentUser so the consent gate clears (both the server field and this client state).
      setCurrentUser(response.data.user);
      applyRedirect(router.history, redirectTo, '/', true);
    } catch (err: unknown) {
      const message =
        (err as { response?: { data?: { error?: string } }; message?: string }).response?.data?.error ||
        (err as Error).message ||
        'Failed to record acceptance';
      setError(message);

      // Only a confirmed 401 says anything about the session; an unrelated failure (5xx,
      // validation, network) is retryable indefinitely and should never count toward teardown.
      if (mfaPending || getAxiosErrorStatus(err) !== 401) {
        submitAttemptsRef.current = 0;
        setIsSubmitting(false);
        return;
      }

      submitAttemptsRef.current += 1;
      if (submitAttemptsRef.current >= MAX_SUBMIT_ATTEMPTS) {
        await forceSessionExpiredRedirect();
      }
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
