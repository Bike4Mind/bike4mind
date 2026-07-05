import { useState, useEffect, useRef } from 'react';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { applyRedirect, appendRedirectTo } from '@client/app/utils/authRedirect';
import { getLoginErrorMessage } from '@client/app/utils/loginErrorMessages';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Container,
  Divider,
  FormControl,
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
import { useVerifyMFA, useSetupMFA, useVerifyMFASetup, MFASetupResponse } from '@client/app/hooks/data/mfa';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { resetRefreshPromise } from '@client/app/contexts/ApiContext';
import { useCommonStyles } from '@client/app/hooks/useCommonStyles';
import { useTheme } from '@mui/joy/styles';
import MFAModal from './common/MFAModal';
import useGetLogo from '@client/app/hooks/useGetLogo';
import { useBrandingSettings } from '@client/app/hooks/data/settings';
import { gray, brand } from '@client/app/utils/themes/colors';
import { visuallyHidden } from '@client/app/utils/a11yStyles';
import { getWebsiteUrl, WEBSITE_URL } from '@client/config/general';
import { CURRENT_POLICY_VERSION } from '@bike4mind/common';
import { ExternalLinks } from '@client/app/utils/externalLinks';
import { trackSignupConversion } from '@client/app/utils/signupConversion';

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

const MultiStepLogin: React.FC<MultiStepLoginProps> = ({
  enableRegister = true,
  enableSocials = true,
  enableGithubAuth = true,
  enableOktaAuth = true,
}) => {
  const { setCurrentUser, currentUser } = useUser();
  const [currentStep, setCurrentStep] = useState<LoginStep>('email');
  const [email, setEmail] = useState('');
  const [otcCode, setOtcCode] = useState('');
  // Username collected when a verified code belongs to an email with no account yet
  // (the login form doubling as inline registration - see handleRegisterUsernameSubmit).
  const [username, setUsername] = useState('');
  // Abuse gate on the inline path too: registerUser rejects creation unless
  // the current policy version + age attestation are sent, so both must be collected here;
  // the checkboxes gate the Create account button.
  const [acceptPolicies, setAcceptPolicies] = useState(false);
  const [confirmAdult, setConfirmAdult] = useState(false);
  // Signed pending token from /api/otc/send - carries the hashed code + nonce and is
  // required by /api/otc/verify. Re-issued (attempt-tracked) on each wrong code.
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [isCheckingStrategy, setIsCheckingStrategy] = useState(false);

  // MFA state
  const [showMFAModal, setShowMFAModal] = useState(false);
  const [mfaUserId, setMfaUserId] = useState<string | null>(null);
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [mfaMode, setMfaMode] = useState<'verify' | 'setup'>('verify');
  const [mfaSetupData, setMfaSetupData] = useState<MFASetupResponse | null>(null);

  // Resend cooldown
  const [resendCooldown, setResendCooldown] = useState(0);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const navigate = useNavigate();
  const router = useRouter();
  const { mutateAsync: sendOTC, isPending: isSendingOTC } = useSendOTC();
  const { mutateAsync: verifyOTC, isPending: isVerifying } = useVerifyOTC();
  const verifyMFA = useVerifyMFA();
  const setupMFA = useSetupMFA();
  const verifyMFASetup = useVerifyMFASetup();
  const { t } = useTranslation();
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
    if (currentUser) {
      const searchParams = new URLSearchParams(window.location.search);
      applyRedirect(router.history, searchParams.get('redirectTo'), '/new', true);
    }
  }, [currentUser, router]);

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

  const handleEmailSubmit = async (e: React.FormEvent | React.KeyboardEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      toast.error(t('auth.emailRequired'));
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmedEmail)) {
      toast.error(t('no_valid_emails_error'));
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
      toast.success(t('auth.codeSent'));
      setCurrentStep('otc');
      startResendCooldown();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
      toast.error(errorMessage);
    } finally {
      setIsCheckingStrategy(false);
    }
  };

  const handleResendCode = async () => {
    if (resendCooldown > 0) return;
    try {
      const sendResult = await sendOTC({ email: email.trim() });
      setPendingToken(sendResult.pendingToken);
      toast.success(t('auth.codeSent'));
      startResendCooldown();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to resend code';
      toast.error(errorMessage);
    }
  };

  const handleMFASetup = async () => {
    try {
      const result = await setupMFA.mutateAsync();
      setMfaSetupData(result);
      setShowMFAModal(true);
    } catch (error: unknown) {
      const errorMessage = (error as Record<string, unknown>)?.response
        ? (error as Record<string, Record<string, Record<string, string>>>).response?.data?.error
        : (error as Error).message || 'MFA setup failed';
      toast.error(errorMessage);
      useAccessToken.getState().resetTokens();
      setMfaUserId(null);
      setMfaMode('verify');
      setMfaSetupData(null);
    }
  };

  const handleMFAVerification = async (token: string) => {
    if (!mfaUserId) return;
    setMfaError(null);
    try {
      let result;
      if (mfaMode === 'setup') {
        result = await verifyMFASetup.mutateAsync({ token });
      } else {
        result = await verifyMFA.mutateAsync({ token });
      }
      resetRefreshPromise();
      useAccessToken.getState().setVerifiedTokens(result.accessToken, result.refreshToken);
      setShowMFAModal(false);
      setCurrentUser(result.user);
    } catch (error: unknown) {
      const errorData = (error as Record<string, Record<string, Record<string, unknown>>>)?.response?.data;
      if (errorData?.forceLogout) {
        useAccessToken.getState().forceLogoutTokens();
        setShowMFAModal(false);
        setMfaUserId(null);
        setMfaError(null);
        setMfaMode('verify');
        setMfaSetupData(null);
        toast.error((errorData.error as string) || 'Too many failed attempts. Please try again.');
        return;
      }
      if (errorData?.accessToken && errorData?.refreshToken) {
        useAccessToken
          .getState()
          .setMfaPendingTokens(errorData.accessToken as string, errorData.refreshToken as string);
      }
      const baseError = (errorData?.error as string) || (error as Error).message || 'MFA verification failed';
      const attemptsInfo = errorData?.attemptsRemaining ? ` (${errorData.attemptsRemaining} attempts remaining)` : '';
      setMfaError(baseError + attemptsInfo);
    }
  };

  const handleMFACancel = () => {
    useAccessToken.getState().resetTokens();
    setShowMFAModal(false);
    setMfaUserId(null);
    setMfaError(null);
    setMfaMode('verify');
    setMfaSetupData(null);
    // The nonce behind the held pendingToken was consumed by the submit that raised the MFA
    // challenge, so the OTC/username steps can't be resumed (any retry dies as "Invalid
    // code."). Restart cleanly from the email step.
    handleBackToEmail();
    if (mfaMode === 'setup') {
      toast.info(
        'Multi-factor authentication setup is required by your administrator. Please complete the setup to continue.'
      );
    } else {
      toast.error('Multi-factor authentication is required to sign in. Please enter your code to continue.');
    }
  };

  const handleOTCSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otcCode.trim() || otcCode.length !== 6) {
      toast.error('Please enter the 6-digit code');
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

      if ('mfaRequired' in response && response.mfaRequired) {
        if ('accessToken' in response) {
          useAccessToken.getState().setMfaPendingTokens(response.accessToken);
        }
        setMfaUserId(response.userId);
        setMfaMode('verify');
        setShowMFAModal(true);
        return;
      }

      if ('mfaSetupRequired' in response && response.mfaSetupRequired) {
        if ('accessToken' in response) {
          useAccessToken.getState().setMfaPendingTokens(response.accessToken);
        }
        setMfaUserId(response.userId);
        setMfaMode('setup');
        await handleMFASetup();
        return;
      }

      // Correct code, but no account for this email yet -> finish registration inline.
      // The server re-issued a pending token carrying the same (already-verified) code;
      // we collect a username + policy/age acceptance and re-submit to create the
      // account. No second email.
      if ('registrationRequired' in response && response.registrationRequired) {
        // No account for this email. If open registration is disabled, don't advance to the
        // username step - registerUser would reject with "invite code required" and strand the
        // user with no way forward. Surface a clear message instead. (The code-holder already
        // proved inbox ownership, so this leaks no account-existence info to an attacker.)
        if (!enableRegister) {
          toast.error(t('auth.registrationClosed'));
          return;
        }
        setPendingToken(response.pendingToken);
        setCurrentStep('register-username');
        return;
      }

      // Successful login
      finishLogin(response as Record<string, unknown> & { accessToken: string; refreshToken: string });
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

  // Shared success path: persist tokens, set the user, honor ?redirectTo.
  const finishLogin = (user: Record<string, unknown> & { accessToken: string; refreshToken: string }) => {
    resetRefreshPromise();
    useAccessToken.getState().setVerifiedTokens(user.accessToken, user.refreshToken);
    setCurrentUser(user as unknown as Parameters<typeof setCurrentUser>[0]);
    const searchParams = new URLSearchParams(window.location.search);
    applyRedirect(router.history, searchParams.get('redirectTo'));
  };

  // Second leg of the inline-registration flow: the code was already verified on the
  // login step (registrationRequired); re-submit it WITH the chosen username to create
  // the account. A brand-new user has no MFA, so this returns a logged-in session.
  const handleRegisterUsernameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const uname = username.trim();
    if (!uname) {
      toast.error('Please enter a username');
      return;
    }
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
        if ('accessToken' in response) {
          useAccessToken.getState().setMfaPendingTokens(response.accessToken);
        }
        setMfaUserId(response.userId);
        setMfaMode('verify');
        setShowMFAModal(true);
        return;
      }
      if ('mfaSetupRequired' in response && response.mfaSetupRequired) {
        if ('accessToken' in response) {
          useAccessToken.getState().setMfaPendingTokens(response.accessToken);
        }
        setMfaUserId(response.userId);
        setMfaMode('setup');
        await handleMFASetup();
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
              refreshToken: response.refreshToken,
            }
          : response;
      if ('user' in response) {
        // Ad-conversion signal (GA4 sign_up + Reddit SignUp), mirroring Register.tsx. Only the
        // nested shape is a freshly created account - the flat shape is a login of one that
        // already existed, which must not double-count.
        trackSignupConversion('password');
      }
      finishLogin(flat as Record<string, unknown> & { accessToken: string; refreshToken: string });
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
    setAcceptPolicies(false);
    setConfirmAdult(false);
    setPendingToken(null);
  };

  if (currentUser) {
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
              {t('auth.codeSentTo', { email: email.trim() })}
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
                    onChange={e => setEmail(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && email.trim() && !isCheckingStrategy && !isSendingOTC) {
                        handleEmailSubmit(e);
                      }
                    }}
                    placeholder={t('auth.enterEmail')}
                    autoComplete="email"
                    autoFocus
                    disabled={isCheckingStrategy || isSendingOTC}
                    sx={{ ...inputStyles, '--Input-minHeight': '40px' }}
                  />
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
                  disabled={!email.trim() || isCheckingStrategy || isSendingOTC}
                >
                  {(isCheckingStrategy || isSendingOTC) && <CircularProgress />}
                  <Typography sx={{ color: 'common.white', fontWeight: '500', fontSize: '14px' }}>
                    {isCheckingStrategy || isSendingOTC ? t('auth.checking') : t('auth.continue')}
                  </Typography>
                </Button>

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
                          transition: 'opacity 0.2s ease-in-out',
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
                    inputMode="numeric"
                    placeholder="000000"
                    value={otcCode}
                    onChange={e => {
                      const val = e.target.value.replace(/\D/g, '').slice(0, 6);
                      setOtcCode(val);
                    }}
                    autoComplete="one-time-code"
                    fullWidth
                    autoFocus
                    disabled={isVerifying}
                    sx={{
                      ...inputStyles,
                      '--Input-minHeight': '48px',
                      fontSize: '24px',
                      letterSpacing: '8px',
                      textAlign: 'center',
                      '& input': { textAlign: 'center' },
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
                  disabled={otcCode.length !== 6 || isVerifying}
                >
                  {isVerifying && <CircularProgress className="verify-spinner" />}
                  <Typography sx={{ color: 'common.white', fontWeight: '500', fontSize: '14px' }}>
                    {isVerifying ? t('auth.verifying') : t('auth.verifyCode')}
                  </Typography>
                </Button>

                <Box sx={{ display: 'flex', justifyContent: 'center', mt: '20px', gap: 2 }}>
                  <Link
                    className="resend-code-link"
                    data-testid="login-resend-btn"
                    color="primary"
                    onClick={handleResendCode}
                    sx={{
                      fontWeight: 500,
                      fontSize: '14px',
                      cursor: resendCooldown > 0 ? 'default' : 'pointer',
                      opacity: resendCooldown > 0 ? 0.5 : 1,
                      transition: 'opacity 0.2s ease-in-out',
                      '&:hover': { textDecoration: resendCooldown > 0 ? 'none' : 'underline' },
                    }}
                  >
                    {resendCooldown > 0 ? `${t('auth.resendCode')} (${resendCooldown}s)` : t('auth.resendCode')}
                  </Link>
                </Box>

                <Box className="back-to-email-container" sx={{ display: 'flex', justifyContent: 'center', mt: '12px' }}>
                  <Link
                    className="back-to-email-link"
                    data-testid="login-back-btn"
                    onClick={handleBackToEmail}
                    sx={{
                      color: 'text.tertiary',
                      fontWeight: 500,
                      fontSize: '14px',
                      cursor: 'pointer',
                      transition: 'opacity 0.2s ease-in-out',
                      '&:hover': { textDecoration: 'underline' },
                    }}
                  >
                    ← {t('auth.backToEmail')}
                  </Link>
                </Box>
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
                    onChange={e => setUsername(e.target.value)}
                    autoComplete="username"
                    fullWidth
                    autoFocus
                    disabled={isVerifying}
                    sx={{ ...inputStyles, '--Input-minHeight': '48px' }}
                  />
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
                          onClick={e => e.stopPropagation()}
                        >
                          Terms of Service
                        </Link>
                        ,{' '}
                        <Link
                          href={ExternalLinks.acceptableUse}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={e => e.stopPropagation()}
                        >
                          Acceptable Use Policy
                        </Link>
                        , and{' '}
                        <Link
                          href={ExternalLinks.privacy}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={e => e.stopPropagation()}
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
                      transition: 'opacity 0.2s ease-in-out',
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
            getWebsiteUrl yields relative URLs that 404 in the SPA, so hide the sentence. */}
        {WEBSITE_URL && (
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
              By continuing, you agree to our{' '}
              <Link
                className="terms-link"
                href={getWebsiteUrl('terms-of-service')}
                target="_blank"
                rel="noopener noreferrer"
                sx={{
                  color: 'text.tertiary',
                  fontWeight: 600,
                  textDecoration: 'underline',
                  transition: 'color 0.2s ease-in-out',
                  '&:hover': { color: 'text.primary', textDecoration: 'underline' },
                }}
              >
                {t('Terms of Service')}
              </Link>{' '}
              and{' '}
              <Link
                className="privacy-link"
                href={getWebsiteUrl('privacy')}
                target="_blank"
                rel="noopener noreferrer"
                sx={{
                  color: 'text.tertiary',
                  fontWeight: 600,
                  textDecoration: 'underline',
                  transition: 'color 0.2s ease-in-out',
                  '&:hover': { color: 'text.primary', textDecoration: 'underline' },
                }}
              >
                {t('Privacy Policy')}
              </Link>
              .
            </Typography>
          </Container>
        )}
      </Container>

      {/* MFA Modal */}
      <MFAModal
        className="mfa-modal"
        open={showMFAModal}
        onClose={handleMFACancel}
        onCancel={handleMFACancel}
        onVerify={handleMFAVerification}
        loading={verifyMFA.isPending || verifyMFASetup.isPending}
        error={mfaError}
        title={mfaMode === 'setup' ? 'Set Up Multi-Factor Authentication' : 'Multi-Factor Authentication Required'}
        description={
          mfaMode === 'setup'
            ? 'Your administrator requires MFA. Scan the QR code with your authenticator app to set up MFA.'
            : 'Enter your 6-digit code or backup code to continue.'
        }
        qrCodeUrl={mfaSetupData?.qrCodeUrl}
        manualEntryKey={mfaSetupData?.manualEntryKey}
        backupCodes={mfaSetupData?.backupCodes}
        showVerify={true}
      />
    </Box>
  );
};

export default MultiStepLogin;
