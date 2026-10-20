import { useState, useEffect, useRef } from 'react';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { applyRedirect, appendRedirectTo } from '@client/app/utils/authRedirect';
import { getLoginErrorMessage } from '@client/app/utils/loginErrorMessages';
import { useTranslation, Trans } from 'react-i18next';
import { toast } from 'sonner';
import { dismissOtcCodeSentToast, toastOtcCodeSent } from './otcToast';
import {
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Container,
  Divider,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Stack,
  Typography,
} from '@mui/joy';
import GitHubIcon from '@mui/icons-material/GitHub';
import Image from 'next/image';
import Link from '@mui/joy/Link';
import OktaIcon from './svgs/flags/OktaIcon';
import GoogleColorIcon from './svgs/flags/GoogleColorIcon';

import { useUser } from '@client/app/contexts/UserContext';
import { useSendOTC, useVerifyOTC } from '@client/app/hooks/data/auth';
import { formatCountdown, useOtcRateLimit } from '@client/app/hooks/useOtcRateLimit';
import OtcRateLimitNotice from './OtcRateLimitNotice';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { useMfaChallenge } from '@client/app/hooks/useMfaChallenge';
import { resetRefreshCoordinator } from '@client/app/utils/refreshCoordinator';
import { resetSessionBootstrap } from '@client/app/utils/sessionBootstrap';
import { useCommonStyles } from '@client/app/hooks/useCommonStyles';
import { useTheme } from '@mui/joy/styles';
import MFAModal from './common/MFAModal';
import useGetLogo from '@client/app/hooks/useGetLogo';
import { useBrandingSettings, usePublicConfig } from '@client/app/hooks/data/settings';
import { gray, brand } from '@client/app/utils/themes/colors';
import { visuallyHidden } from '@client/app/utils/a11yStyles';
import { getWebsiteUrl, WEBSITE_URL } from '@client/config/general';
import { CURRENT_POLICY_VERSION, USERNAME_RULES_MESSAGE, usernameSchema } from '@bike4mind/common';
import { ExternalLinks, CHECKBOX_LABEL_LINK_SX } from '@client/app/utils/externalLinks';
import { trackSignupConversion } from '@client/app/utils/signupConversion';
import {
  isSubmittableOtcCode,
  OTC_CODE_LENGTH,
  OTC_CODE_PLACEHOLDER,
  sanitizeOtcInput,
} from '@client/app/utils/otcCode';
import { useCookieSettings } from '@client/app/components/CookieConsentBanner';

/**
 * Reads the SPA's current `?redirectTo=` and merges it onto a provider auth
 * URL so it round-trips through the IdP `state`/`RelayState` param (the
 * full-page navigation to the provider drops the in-URL query). The merge
 * itself lives in `appendRedirectTo` (pure + unit-tested).
 */
function withRedirectTo(targetUrl: string): string {
  return appendRedirectTo(targetUrl, new URLSearchParams(window.location.search).get('redirectTo'));
}

interface MultiStepLoginProps {
  enableRegister?: boolean;
  enableSocials?: boolean;
  enableGithubAuth?: boolean;
  enableOktaAuth?: boolean;
}

type LoginStep = 'email' | 'otc' | 'register-username' | 'redirect';

const FOOTER_LINK_SX = {
  color: 'text.tertiary',
  fontWeight: 600,
  textDecoration: 'underline',
  transition: 'color 0.2s ease-in-out',
  '&:hover': { color: 'text.primary', textDecoration: 'underline' },
} as const;

const MultiStepLogin: React.FC<MultiStepLoginProps> = ({
  enableRegister = true,
  enableSocials = true,
  enableGithubAuth = true,
  enableOktaAuth = true,
}) => {
  const { setCurrentUser, currentUser } = useUser();
  // Only a live session (token present) counts as "already logged in". A stale persisted
  // `currentUser` with no access token must fall through to the login form rather than be
  // bounced back into the app shell - otherwise a broken session is trapped in a /login <->
  // /accept-policies loop (see issue #386 and shouldRedirectToConsent).
  const accessToken = useAccessToken(s => s.accessToken);
  const isLoggedIn = !!currentUser && !!accessToken;
  const [currentStep, setCurrentStep] = useState<LoginStep>('email');
  const [email, setEmail] = useState('');
  const [otcCode, setOtcCode] = useState('');
  // Username collected when a verified code belongs to an email with no account yet
  // (the login form doubling as inline registration - see handleRegisterUsernameSubmit).
  const [username, setUsername] = useState('');
  const [usernameError, setUsernameError] = useState<string | null>(null);
  // Abuse gate on the inline path too: registerUser rejects creation unless
  // the current policy version + age attestation are sent, so both must be collected here;
  // the checkboxes gate the Create account button.
  const [acceptPolicies, setAcceptPolicies] = useState(false);
  const [confirmAdult, setConfirmAdult] = useState(false);
  // Signed pending token from /api/otc/send - references the pending code by nonce (jti) and
  // is required by /api/otc/verify. Re-issued (attempt-tracked) on each wrong code.
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [isCheckingStrategy, setIsCheckingStrategy] = useState(false);

  // Resend cooldown
  const [resendCooldown, setResendCooldown] = useState(0);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const navigate = useNavigate();
  const router = useRouter();
  const { mutateAsync: sendOTC, isPending: isSendingOTC } = useSendOTC();
  const rateLimit = useOtcRateLimit();
  const [emailError, setEmailError] = useState<string | null>(null);
  const { mutateAsync: verifyOTC, isPending: isVerifying } = useVerifyOTC();
  const { data: publicConfig } = usePublicConfig();
  const mfaChallenge = useMfaChallenge({
    allowRememberDevice: publicConfig?.allowTrustedDevices ?? false,
    onComplete: ({ user }) => setCurrentUser(user),
    onCancel: mode => {
      // The nonce behind the held pendingToken was consumed by the submit that raised the MFA
      // challenge, so the OTC/username steps can't be resumed (any retry dies as "Invalid
      // code."). Restart cleanly from the email step.
      handleBackToEmail();
      if (mode === 'setup') {
        toast.info(
          'Multi-factor authentication setup is required by your administrator. Please complete the setup to continue.'
        );
      } else {
        toast.error('Multi-factor authentication is required to sign in. Please enter your code to continue.');
      }
    },
  });
  const { t } = useTranslation();
  const openCookieSettings = useCookieSettings(s => s.open);
  const theme = useTheme();
  const { inputStyles, dividerStyles } = useCommonStyles();
  const logoUrl = useGetLogo();
  useBrandingSettings();

  const isDarkMode = theme.palette.mode === 'dark';

  const darkInactive = {
    '&:disabled': {
      border: 'none',
      background: '#636B74',
      '> p': {
        color: 'text.tertiary',
      },
    },
  };

  const lightInactive = {
    '&:disabled': {
      border: `1px solid ${gray[160]}`,
      background: gray[12],
      opacity: 0.3,
      '> p': {
        color: brand[600],
      },
    },
  };

  // Redirect if already logged in
  useEffect(() => {
    if (isLoggedIn) {
      const searchParams = new URLSearchParams(window.location.search);
      applyRedirect(router.history, searchParams.get('redirectTo'), '/new', true);
    }
  }, [isLoggedIn, router]);

  // Surface SSO/OAuth failures
  useEffect(() => {
    const url = new URL(window.location.href);
    const message = getLoginErrorMessage(url.searchParams.get('error'));
    if (!message) return;
    toast.error(message, { duration: 8000 });
    url.searchParams.delete('error');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
  }, []);

  // Cleanup cooldown timer
  useEffect(() => {
    return () => {
      if (cooldownRef.current) clearInterval(cooldownRef.current);
    };
  }, []);

  const startResendCooldown = () => {
    setResendCooldown(30); // matches the server-side OTC_SEND_COOLDOWN_MS of 30s
    if (cooldownRef.current) clearInterval(cooldownRef.current);
    cooldownRef.current = setInterval(() => {
      setResendCooldown(prev => {
        if (prev <= 1) {
          if (cooldownRef.current) clearInterval(cooldownRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const resendBlockedSeconds = Math.max(resendCooldown, rateLimit.secondsLeft);

  const handleEmailSubmit = async (e: React.FormEvent | React.KeyboardEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim();
    if (rateLimit.secondsLeft > 0) return;
    setEmailError(null);
    if (!trimmedEmail) {
      setEmailError(t('auth.emailRequired'));
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmedEmail)) {
      setEmailError(t('auth.fieldErrors.invalidEmail'));
      return;
    }

    setIsCheckingStrategy(true);
    try {
      // Check auth strategy first (for SSO/OAuth redirects)
      const strategyResponse = await fetch(`/api/auth/strategy?email=${encodeURIComponent(trimmedEmail)}`);
      const strategy = await strategyResponse.json();

      if (!strategyResponse.ok) {
        throw new Error(strategy.message || 'An unexpected error occurred');
      }

      if (strategy.requiresRedirect && strategy.redirectUrl) {
        setCurrentStep('redirect');
        // Redirect to the appropriate OAuth/SAML provider, carrying redirectTo
        // through the IdP state/RelayState round-trip (the full-page navigation
        // below drops the SPA's ?redirectTo= query).
        window.location.href = withRedirectTo(strategy.redirectUrl);
        return;
      }

      const sendResult = await sendOTC({ email: trimmedEmail });
      setPendingToken(sendResult.pendingToken);
      toastOtcCodeSent(t('auth.codeSent'));
      setCurrentStep('otc');
      startResendCooldown();
    } catch (error) {
      // useSendOTC rejects with a plain { message, code } object (not an Error instance),
      // so read .message off either shape - otherwise real server messages like the OTC
      // rate-limit's "try again in N seconds" collapse into "An unexpected error occurred".
      if (rateLimit.handleError(error)) return;
      const errorMessage = rateLimit.errorMessage(error, 'An unexpected error occurred');
      toast.error(errorMessage);
    } finally {
      setIsCheckingStrategy(false);
    }
  };

  const handleResendCode = async () => {
    if (resendCooldown > 0 || rateLimit.secondsLeft > 0) return;
    try {
      const sendResult = await sendOTC({ email: email.trim() });
      setPendingToken(sendResult.pendingToken);
      toastOtcCodeSent(t('auth.codeSent'));
      startResendCooldown();
    } catch (error) {
      // Same plain-object rejection shape as handleEmailSubmit above.
      if (rateLimit.handleError(error)) return;
      const errorMessage = rateLimit.errorMessage(error, 'Failed to resend code');
      toast.error(errorMessage);
    }
  };

  const handleOTCSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSubmittableOtcCode(otcCode)) {
      toast.error(`Please enter the ${OTC_CODE_LENGTH}-digit code`);
      return;
    }

    try {
      const clientData = {
        userAgent: navigator.userAgent,
        browserLanguage: navigator.language,
        platform: navigator.platform,
        screenResolution: `${window.screen.width}x${window.screen.height}`,
        viewportSize: `${window.innerWidth}x${window.innerHeight}`,
        colorDepth: window.screen.colorDepth,
        pixelDepth: window.screen.pixelDepth,
        devicePixelRatio: window.devicePixelRatio,
      };

      const response = await verifyOTC({
        email: email.trim(),
        code: otcCode,
        pendingToken: pendingToken || undefined,
        clientData,
      });
      dismissOtcCodeSentToast();

      if ('mfaRequired' in response && response.mfaRequired) {
        await mfaChallenge.begin({
          userId: response.userId,
          mfaToken: response.accessToken,
          mode: 'verify',
          passkeyAvailable: !!response.passkeyAvailable,
        });
        return;
      }

      if ('mfaSetupRequired' in response && response.mfaSetupRequired) {
        await mfaChallenge.begin({ userId: response.userId, mfaToken: response.accessToken, mode: 'setup' });
        return;
      }

      // Correct code, but no account for this email yet -> finish registration inline.
      // The server re-issued a pending token carrying the same (already-verified) code;
      // we collect a username + policy/age acceptance and re-submit to create the
      // account. No second email.
      if ('registrationRequired' in response && response.registrationRequired) {
        // The verified email may qualify for a partner bypass even on an invite-only instance.
        // Fall back to public config for responses from servers predating this decision field.
        if (!(response.registrationAllowed ?? enableRegister)) {
          toast.error(t('auth.registrationClosed'));
          return;
        }
        setPendingToken(response.pendingToken);
        setCurrentStep('register-username');
        return;
      }

      // Successful login
      finishLogin(response as Record<string, unknown> & { accessToken: string });
    } catch (error: unknown) {
      const errorMessage = (error as Error).message || 'Verification failed';
      // On a wrong code the server re-issues an attempt-tracked pending token with a rotated
      // single-use nonce; store it so the next attempt uses the fresh token (reusing the old
      // one fails the nonce check and rejects even a correct code). useVerifyOTC surfaces it
      // as `pendingToken` on the thrown error.
      const reissuedToken = (error as { pendingToken?: string })?.pendingToken;
      if (reissuedToken) {
        setPendingToken(reissuedToken);
      }
      toast.error(errorMessage);
    }
  };

  // Shared success path: store the access token, set the user, honor ?redirectTo. The refresh
  // token is not here - the login endpoint set it as an HttpOnly cookie.
  const finishLogin = (user: Record<string, unknown> & { accessToken: string }) => {
    resetRefreshCoordinator();
    // Drop the cached cold-load result: this browser just acquired a session, so the next
    // protected navigation must not reuse the "no session" answer from before login.
    resetSessionBootstrap();
    useAccessToken.getState().setVerifiedSession(user.accessToken);
    setCurrentUser(user as unknown as Parameters<typeof setCurrentUser>[0]);
    const searchParams = new URLSearchParams(window.location.search);
    applyRedirect(router.history, searchParams.get('redirectTo'));
  };

  // Second leg of the inline-registration flow: the code was already verified on the
  // login step (registrationRequired); re-submit it WITH the chosen username to create
  // the account. A brand-new user has no MFA, so this returns a logged-in session.
  const handleRegisterUsernameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) {
      toast.error('Please enter a username');
      return;
    }
    // Checked before any server call: the code is single-use-ish, so a rejected username must not
    // burn an attempt.
    const parsedUsername = usernameSchema.safeParse(username);
    if (!parsedUsername.success) {
      setUsernameError(USERNAME_RULES_MESSAGE);
      return;
    }
    const uname = parsedUsername.data;
    // The button is disabled until both boxes are checked, but Enter-key implicit form
    // submission can bypass a disabled submit button - and acceptedPolicyVersion is sent
    // unconditionally below, so the handler must enforce the acceptance itself.
    if (!acceptPolicies || !confirmAdult) {
      toast.error('Please accept the terms and confirm you are 18 or older to continue.');
      return;
    }
    try {
      const clientData = {
        userAgent: navigator.userAgent,
        browserLanguage: navigator.language,
        platform: navigator.platform,
        screenResolution: `${window.screen.width}x${window.screen.height}`,
        viewportSize: `${window.innerWidth}x${window.innerHeight}`,
        colorDepth: window.screen.colorDepth,
        pixelDepth: window.screen.pixelDepth,
        devicePixelRatio: window.devicePixelRatio,
      };
      const response = await verifyOTC({
        email: email.trim(),
        code: otcCode,
        username: uname,
        pendingToken: pendingToken || undefined,
        clientData,
        // Abuse gate: the server rejects registration without a current policy
        // version + true age attestation; both checkboxes gate the submit button below.
        acceptedPolicyVersion: CURRENT_POLICY_VERSION,
        ageAttestation: confirmAdult,
      });

      // The account can already exist by the time we submit (e.g. a prior attempt created it
      // but the response was lost) - the server then answers with the LOGIN shapes, including
      // MFA challenges. Mirror handleOTCSubmit so that path doesn't fall into finishLogin with
      // no refresh token.
      if ('mfaRequired' in response && response.mfaRequired) {
        await mfaChallenge.begin({
          userId: response.userId,
          mfaToken: response.accessToken,
          mode: 'verify',
          passkeyAvailable: !!response.passkeyAvailable,
        });
        return;
      }

      if ('mfaSetupRequired' in response && response.mfaSetupRequired) {
        await mfaChallenge.begin({ userId: response.userId, mfaToken: response.accessToken, mode: 'setup' });
        return;
      }

      // Registration returns the user NESTED as { user, ...tokens }, whereas the login path
      // returns a flat user carrying the tokens. finishLogin (shared with login) hands its arg
      // straight to setCurrentUser, so flatten here - otherwise currentUser becomes the wrapper
      // and id/email/tags/isAdmin all read undefined until a full reload. The `else` covers the
      // rare case where the account raced into existence and the server returned a flat login.
      const flat =
        'user' in response
          ? {
              ...(response.user as unknown as Record<string, unknown>),
              accessToken: response.accessToken,
            }
          : response;
      if ('user' in response) {
        // Ad-conversion signal (GA4 sign_up + Reddit SignUp), mirroring Register.tsx. Only the
        // nested shape is a freshly created account - the flat shape is a login of one that
        // already existed, which must not double-count.
        trackSignupConversion('password');
      }
      finishLogin(flat as Record<string, unknown> & { accessToken: string });
    } catch (error: unknown) {
      const errorMessage = (error as Error).message || 'Registration failed';
      // useVerifyOTC surfaces any re-issued pending token (rotated nonce) at the error
      // top-level - swap it in so a retry uses the fresh token (matches handleOTCSubmit).
      const reissuedToken = (error as { pendingToken?: string })?.pendingToken;
      if (reissuedToken) {
        setPendingToken(reissuedToken);
      }
      toast.error(errorMessage);
    }
  };

  const handleSocialLogin = (provider: 'google' | 'github' | 'okta') => {
    // Carry redirectTo through the IdP state round-trip (the full-page
    // navigation below drops the SPA's ?redirectTo= query).
    window.location.href = withRedirectTo(`/api/auth/${provider}`);
  };

  const handleBackToEmail = () => {
    setCurrentStep('email');
    setEmail('');
    setOtcCode('');
    setUsername('');
    setUsernameError(null);
    setAcceptPolicies(false);
    setConfirmAdult(false);
    setPendingToken(null);
    rateLimit.clear();
  };

  if (isLoggedIn) {
    return null;
  }

  return (
    <Box
      className="multi-step-login-wrapper"
      sx={theme => ({
        backgroundColor: theme.palette.background.panel,
        display: 'flex',
      })}
    >
      <Container
        className="multi-step-login-container"
        sx={theme => ({
          display: 'flex',
          flexDirection: 'column',
          minHeight: '100vh',
          maxWidth: '100vw',
          mx: 'auto',
          backgroundColor: theme.palette.background.panel,
        })}
      >
        <Box
          className="login-content-box"
          sx={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            margin: '1rem 0',
          }}
        >
          <Box className="logo-container" sx={{ position: 'relative', width: 56, height: 56 }}>
            <Image className="login-logo" src={logoUrl} alt="Logo" fill style={{ objectFit: 'contain' }} />
          </Box>

          <Typography
            className="login-title"
            level="h2"
            component="h1"
            variant="plain"
            sx={theme => ({ color: theme.palette.text.primary, fontWeight: 500, fontSize: '20px', padding: 0 })}
            marginTop={'16px'}
          >
            {currentStep === 'email'
              ? t('welcome', { name: theme.branding.name })
              : currentStep === 'redirect'
                ? t('auth.justAMoment')
                : currentStep === 'register-username'
                  ? 'Finish creating your account'
                  : t('auth.checkYourEmail')}
          </Typography>

          {currentStep === 'email' && (
            <Typography
              className="login-subtitle"
              sx={{ color: 'text.tertiary', fontSize: '14px', mt: '4px', textAlign: 'center' }}
            >
              {t('auth.signInOrCreate')}
            </Typography>
          )}

          {currentStep === 'otc' && (
            <Typography
              className="otc-subtitle"
              sx={{ color: 'text.tertiary', fontSize: '14px', mt: '4px', textAlign: 'center' }}
            >
              <Trans
                i18nKey="auth.codeSentTo"
                values={{ email: email.trim() }}
                components={{ email: <Box component="span" sx={{ color: 'text.primary', fontWeight: 600 }} /> }}
              />
            </Typography>
          )}

          {currentStep === 'register-username' && (
            <Typography
              className="register-username-subtitle"
              sx={{ color: 'text.tertiary', fontSize: '14px', mt: '4px', textAlign: 'center' }}
            >
              We couldn&apos;t find an account for {email.trim()}. Pick a username to create one.
            </Typography>
          )}

          <Stack
            className="login-form-stack"
            spacing={2}
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              overflow: 'hidden',
              width: '100%',
              maxWidth: '100vw',
              mx: 'auto',
            }}
          >
            {/* Email Step */}
            {currentStep === 'email' && (
              <form
                className="email-step-form"
                onSubmit={handleEmailSubmit}
                style={{ marginTop: '32px', width: '100%', maxWidth: '420px' }}
              >
                <Box
                  className="social-buttons-container"
                  sx={{ display: 'flex', gap: '8px', width: '100%', '& > button': { minHeight: '40px' } }}
                >
                  <Button
                    className="google-login-button"
                    type="button"
                    variant="outlined"
                    color="neutral"
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      px: '8px',
                      display: 'flex',
                      gap: '.4rem',
                      borderRadius: '8px',
                      '&:disabled': {
                        borderColor:
                          'var(--variant-outlinedBorder,var(--joy-palette-neutral-outlinedBorder,var(--joy-palette-neutral-300, #CDD7E1)))',
                      },
                    }}
                    disabled={isCheckingStrategy || isSendingOTC}
                    onClick={() => handleSocialLogin('google')}
                  >
                    <Box display={'flex'} alignItems={'center'}>
                      <GoogleColorIcon />
                      <Typography
                        sx={{ color: 'text.primary', fontWeight: '500', fontSize: '14px', marginLeft: '8px' }}
                      >
                        Google
                      </Typography>
                    </Box>
                  </Button>

                  {enableGithubAuth && (
                    <Button
                      className="github-login-button"
                      type="button"
                      variant="outlined"
                      color="neutral"
                      sx={{
                        flex: 1,
                        minWidth: 0,
                        px: '8px',
                        display: 'flex',
                        gap: '.4rem',
                        borderRadius: '8px',
                        '&:disabled': {
                          borderColor:
                            'var(--variant-outlinedBorder,var(--joy-palette-neutral-outlinedBorder,var(--joy-palette-neutral-300, #CDD7E1)))',
                        },
                      }}
                      disabled={isCheckingStrategy || isSendingOTC}
                      onClick={() => handleSocialLogin('github')}
                    >
                      <Box display={'flex'} alignItems={'center'}>
                        <GitHubIcon sx={{ color: 'text.primary', width: '16px', height: '16px' }} />
                        <Typography
                          sx={{ color: 'text.primary', fontWeight: '500', fontSize: '14px', marginLeft: '8px' }}
                        >
                          GitHub
                        </Typography>
                      </Box>
                    </Button>
                  )}

                  {enableOktaAuth && (
                    <Button
                      className="okta-login-button"
                      type="button"
                      variant="outlined"
                      color="neutral"
                      sx={{
                        flex: 1,
                        minWidth: 0,
                        px: '8px',
                        display: 'flex',
                        gap: '.4rem',
                        borderRadius: '8px',
                        '&:disabled': {
                          borderColor:
                            'var(--variant-outlinedBorder,var(--joy-palette-neutral-outlinedBorder,var(--joy-palette-neutral-300, #CDD7E1)))',
                        },
                      }}
                      disabled={isCheckingStrategy || isSendingOTC}
                      onClick={() => handleSocialLogin('okta')}
                    >
                      <Box display={'flex'} alignItems={'center'}>
                        <OktaIcon sx={{ color: '#007DC1' }} />
                        <Typography
                          sx={{ color: 'text.primary', fontWeight: '500', fontSize: '14px', marginLeft: '8px' }}
                        >
                          Okta
                        </Typography>
                      </Box>
                    </Button>
                  )}
                </Box>

                <Divider sx={dividerStyles}>or</Divider>

                <FormControl
                  className="email-control"
                  required
                  id="email"
                  error={!!emailError}
                  sx={{ width: '100%', maxWidth: '700px', margin: '0 auto 16px' }}
                >
                  <FormLabel sx={visuallyHidden}>Email</FormLabel>
                  <Input
                    className="email-input"
                    data-testid="login-email-input"
                    variant="outlined"
                    fullWidth
                    name="email"
                    type="email"
                    value={email}
                    onChange={e => {
                      setEmail(e.target.value);
                      setEmailError(null);
                    }}
                    onKeyDown={e => {
                      if (
                        e.key === 'Enter' &&
                        email.trim() &&
                        !isCheckingStrategy &&
                        !isSendingOTC &&
                        rateLimit.secondsLeft === 0
                      ) {
                        handleEmailSubmit(e);
                      }
                    }}
                    placeholder={t('auth.enterEmail')}
                    autoComplete="email"
                    autoFocus
                    disabled={isCheckingStrategy || isSendingOTC}
                    slotProps={{ input: { 'aria-invalid': !!emailError } }}
                    sx={{ ...inputStyles, '--Input-minHeight': '40px' }}
                  />
                  {emailError ? (
                    <FormHelperText role="alert" data-testid="login-email-error" sx={{ color: 'danger.plainColor' }}>
                      {emailError}
                    </FormHelperText>
                  ) : (
                    <FormHelperText data-testid="login-passwordless-hint">{t('auth.passwordlessHint')}</FormHelperText>
                  )}
                </FormControl>
                <Button
                  className="continue-button"
                  data-testid="login-continue-btn"
                  type="submit"
                  fullWidth
                  color="primary"
                  sx={[
                    { marginTop: '0.5vh', minHeight: '40px', display: 'flex', gap: '.5rem', borderRadius: '8px' },
                    isDarkMode ? darkInactive : lightInactive,
                  ]}
                  disabled={!email.trim() || isCheckingStrategy || isSendingOTC || rateLimit.secondsLeft > 0}
                >
                  {(isCheckingStrategy || isSendingOTC) && <CircularProgress />}
                  <Typography sx={{ color: 'common.white', fontWeight: '500', fontSize: '14px' }}>
                    {isCheckingStrategy || isSendingOTC
                      ? t('auth.checking')
                      : rateLimit.secondsLeft > 0
                        ? t('auth.retryIn', { time: formatCountdown(rateLimit.secondsLeft) })
                        : t('auth.continue')}
                  </Typography>
                </Button>
                <OtcRateLimitNotice
                  initialSeconds={rateLimit.initialSeconds}
                  capped={rateLimit.capped}
                  testId="login-rate-limit-alert"
                />
                <Typography
                  data-testid="login-no-password-hint"
                  level="body-xs"
                  sx={{ mt: 1.5, textAlign: 'center', color: 'text.tertiary' }}
                >
                  {t('auth.noPasswordNeeded')}
                </Typography>

                {enableRegister && (
                  <Box
                    className="register-prompt-container"
                    sx={{ display: 'flex', justifyContent: 'center', mt: '20px' }}
                  >
                    <Typography sx={{ color: 'text.tertiary', fontSize: '14px' }}>
                      {t('auth.noAccount')}{' '}
                      <Link
                        className="register-link"
                        data-testid="signup-text"
                        color="primary"
                        onClick={() => {
                          const searchParams = new URLSearchParams(window.location.search);
                          const redirectTo = searchParams.get('redirectTo');
                          navigate({ to: '/register', search: redirectTo ? { redirectTo } : undefined });
                        }}
                        sx={{
                          fontWeight: 500,
                          fontSize: '14px',
                          cursor: 'pointer',
                          transition: 'color 0.2s ease-in-out',
                          '&:hover': { textDecoration: 'underline' },
                        }}
                      >
                        {t('auth.registerNow')}
                      </Link>
                    </Typography>
                  </Box>
                )}
              </form>
            )}

            {/* OTC Code Step */}
            {currentStep === 'otc' && (
              <form
                className="otc-step-form"
                onSubmit={handleOTCSubmit}
                style={{ marginTop: '32px', width: '100%', maxWidth: '420px' }}
              >
                <FormControl
                  className="otc-control"
                  required
                  id="otc-code"
                  sx={{ width: '100%', maxWidth: '700px', margin: '0 auto 16px' }}
                >
                  <FormLabel sx={visuallyHidden}>Verification code</FormLabel>
                  <Input
                    className="otc-input"
                    data-testid="login-otc-input"
                    variant="outlined"
                    name="otc-code"
                    type="text"
                    // Joy's Input forwards autoComplete to the <input> but not inputMode (that lands on the
                    // root div), so the numeric keypad hint has to go through the input slot.
                    slotProps={{ input: { inputMode: 'numeric', pattern: '[0-9]*' } }}
                    placeholder={OTC_CODE_PLACEHOLDER}
                    value={otcCode}
                    onChange={e => {
                      const val = sanitizeOtcInput(e.target.value);
                      setOtcCode(val);
                    }}
                    autoComplete="one-time-code"
                    fullWidth
                    autoFocus
                    disabled={isVerifying}
                    sx={{
                      ...inputStyles,
                      '--Input-minHeight': '40px',
                      textAlign: 'center',
                      '& input': { textAlign: 'center', letterSpacing: '4px' },
                    }}
                  />
                </FormControl>

                <Button
                  className="verify-button"
                  data-testid="login-verify-btn"
                  type="submit"
                  fullWidth
                  color="primary"
                  sx={[
                    { marginTop: '0.5vh', minHeight: '40px', display: 'flex', gap: '.5rem', borderRadius: '8px' },
                    isDarkMode ? darkInactive : lightInactive,
                  ]}
                  disabled={!isSubmittableOtcCode(otcCode) || isVerifying}
                >
                  {isVerifying && <CircularProgress className="verify-spinner" />}
                  <Typography sx={{ color: 'common.white', fontWeight: '500', fontSize: '14px' }}>
                    {isVerifying ? t('auth.verifying') : t('auth.verifyCode')}
                  </Typography>
                </Button>

                <Box
                  className="otc-actions-container"
                  sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mt: '20px', gap: 2 }}
                >
                  <Link
                    className="back-to-email-link"
                    data-testid="login-back-btn"
                    onClick={handleBackToEmail}
                    sx={{
                      color: 'text.tertiary',
                      fontWeight: 500,
                      fontSize: '14px',
                      cursor: 'pointer',
                      transition: 'color 0.2s ease-in-out',
                      '&:hover': { textDecoration: 'underline' },
                    }}
                  >
                    ← {t('auth.backToEmail')}
                  </Link>

                  <Link
                    className="resend-code-link"
                    data-testid="login-resend-btn"
                    color={resendBlockedSeconds > 0 ? 'neutral' : 'primary'}
                    onClick={handleResendCode}
                    sx={{
                      fontWeight: 500,
                      fontSize: '14px',
                      color: resendBlockedSeconds > 0 ? 'text.tertiary' : undefined,
                      cursor: resendBlockedSeconds > 0 ? 'default' : 'pointer',
                      transition: 'color 0.2s ease-in-out',
                      '&:hover': { textDecoration: resendBlockedSeconds > 0 ? 'none' : 'underline' },
                    }}
                  >
                    {resendBlockedSeconds > 0
                      ? `${t('auth.resendCode')} (${formatCountdown(resendBlockedSeconds)})`
                      : t('auth.resendCode')}
                  </Link>
                </Box>
                <OtcRateLimitNotice
                  initialSeconds={rateLimit.initialSeconds}
                  capped={rateLimit.capped}
                  testId="login-otc-rate-limit-alert"
                />
              </form>
            )}

            {/* Inline registration - collect a username after a verified code for a new email */}
            {currentStep === 'register-username' && (
              <form
                className="register-username-step-form"
                onSubmit={handleRegisterUsernameSubmit}
                style={{ marginTop: '32px', width: '100%', maxWidth: '420px' }}
              >
                <FormControl
                  className="register-username-control"
                  required
                  id="register-username"
                  sx={{ width: '100%', maxWidth: '700px', margin: '0 auto 16px' }}
                >
                  <FormLabel sx={visuallyHidden}>Username</FormLabel>
                  <Input
                    className="register-username-input"
                    data-testid="login-register-username-input"
                    variant="outlined"
                    name="register-username"
                    type="text"
                    placeholder="Choose a username"
                    value={username}
                    onChange={e => {
                      setUsername(e.target.value);
                      setUsernameError(null);
                    }}
                    autoComplete="username"
                    fullWidth
                    autoFocus
                    disabled={isVerifying}
                    sx={{ ...inputStyles, '--Input-minHeight': '48px' }}
                  />
                  {usernameError && (
                    <FormHelperText
                      role="alert"
                      data-testid="login-register-username-error"
                      sx={{ color: 'danger.plainColor' }}
                    >
                      {usernameError}
                    </FormHelperText>
                  )}
                </FormControl>

                {/* Abuse gate: same acceptance controls as /register - the
                    server rejects account creation without them, so the button below stays
                    disabled until both are checked. */}
                <Stack spacing={1} sx={{ mb: '16px' }}>
                  <Checkbox
                    className="login-register-aup-tos-checkbox"
                    data-testid="login-register-aup-tos-checkbox"
                    size="sm"
                    checked={acceptPolicies}
                    onChange={e => setAcceptPolicies(e.target.checked)}
                    disabled={isVerifying}
                    label={
                      <Typography sx={{ fontSize: '13px', color: 'text.secondary' }}>
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
                    className="login-register-age-checkbox"
                    data-testid="login-register-age-checkbox"
                    size="sm"
                    checked={confirmAdult}
                    onChange={e => setConfirmAdult(e.target.checked)}
                    disabled={isVerifying}
                    label={
                      <Typography sx={{ fontSize: '13px', color: 'text.secondary' }}>
                        I confirm I am 18 years of age or older
                      </Typography>
                    }
                  />
                </Stack>

                <Button
                  className="register-username-button"
                  data-testid="login-register-username-btn"
                  type="submit"
                  fullWidth
                  color="primary"
                  sx={[
                    { marginTop: '0.5vh', minHeight: '40px', display: 'flex', gap: '.5rem', borderRadius: '8px' },
                    isDarkMode ? darkInactive : lightInactive,
                  ]}
                  disabled={!username.trim() || !acceptPolicies || !confirmAdult || isVerifying}
                >
                  {isVerifying && <CircularProgress className="register-username-spinner" />}
                  <Typography sx={{ color: 'common.white', fontWeight: '500', fontSize: '14px' }}>
                    {isVerifying ? t('auth.verifying') : 'Create account'}
                  </Typography>
                </Button>

                <Box sx={{ display: 'flex', justifyContent: 'center', mt: '12px' }}>
                  <Link
                    className="back-to-email-link"
                    data-testid="login-register-back-btn"
                    onClick={handleBackToEmail}
                    sx={{
                      color: 'text.tertiary',
                      fontWeight: 500,
                      fontSize: '14px',
                      cursor: 'pointer',
                      transition: 'color 0.2s ease-in-out',
                      '&:hover': { textDecoration: 'underline' },
                    }}
                  >
                    ← {t('auth.backToEmail')}
                  </Link>
                </Box>
              </form>
            )}

            {/* Redirect Step */}
            {currentStep === 'redirect' && (
              <Box className="redirect-step-box" sx={{ textAlign: 'center' }}>
                <CircularProgress className="redirect-spinner" sx={{ mb: 2 }} />
                <Typography className="redirect-text" level="body-sm">
                  {t('auth.redirectingToProvider')}
                </Typography>
              </Box>
            )}
          </Stack>
        </Box>
        {/* Legal links - only when a marketing site is configured; without WEBSITE_URL
            getWebsiteUrl yields relative URLs that 404 in the SPA, so hide the sentence.
            Cookie settings also governs first-party attribution and is always available. */}

        <Container
          className="footer-links-container"
          sx={{
            display: 'flex',
            flexDirection: 'row',
            gap: 0.5,
            justifyContent: 'center',
            alignItems: 'center',
            marginBottom: '16px',
          }}
        >
          <Typography
            className="footer-legal-text"
            level="body-sm"
            sx={{ color: 'text.tertiary', fontSize: '12px', textAlign: 'center' }}
          >
            {WEBSITE_URL && (
              <>
                By continuing, you agree to our{' '}
                <Link
                  className="terms-link"
                  href={getWebsiteUrl('terms-of-service')}
                  target="_blank"
                  rel="noopener noreferrer"
                  sx={FOOTER_LINK_SX}
                >
                  {t('Terms of Service')}
                </Link>{' '}
                and{' '}
                <Link
                  className="privacy-link"
                  href={getWebsiteUrl('privacy')}
                  target="_blank"
                  rel="noopener noreferrer"
                  sx={FOOTER_LINK_SX}
                >
                  {t('Privacy Policy')}
                </Link>
                .
              </>
            )}
            <>
              {WEBSITE_URL && ' '}
              {/* component="button": an onClick Link with no href is an <a> with no href,
                      which is not focusable and unreachable by keyboard. */}
              <Link
                component="button"
                type="button"
                className="cookie-settings-link"
                data-testid="login-cookie-settings-link"
                onClick={openCookieSettings}
                sx={FOOTER_LINK_SX}
              >
                {t('cookie_settings', 'Cookie settings')}
              </Link>
            </>
          </Typography>
        </Container>
      </Container>

      {/* MFA Modal */}
      <MFAModal {...mfaChallenge.modalProps} />
    </Box>
  );
};

export default MultiStepLogin;
