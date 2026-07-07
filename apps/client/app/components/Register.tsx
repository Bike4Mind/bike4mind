import { useUser } from '@client/app/contexts/UserContext';
import { useSendOTC, useVerifyOTC } from '@client/app/hooks/data/auth';
import { useVerifyMFA, useSetupMFA, useVerifyMFASetup, MFASetupResponse } from '@client/app/hooks/data/mfa';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import MFAModal from './common/MFAModal';
import { useTheme } from '@mui/joy/styles';
import { useCommonStyles } from '@client/app/hooks/useCommonStyles';
import {
  Box,
  Button,
  Container,
  FormControl,
  FormLabel,
  Input,
  Stack,
  Typography,
  CircularProgress,
  Divider,
  Checkbox,
} from '@mui/joy';
import { useNavigate, useRouter } from '@tanstack/react-router';
import Link from '@mui/joy/Link';
import Image from 'next/image';
import GitHubIcon from '@mui/icons-material/GitHub';
import OktaIcon from './svgs/flags/OktaIcon';
import GoogleColorIcon from './svgs/flags/GoogleColorIcon';
import ErrorAlert from './common/ErrorAlert';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import React, { useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import useGetLogo from '../hooks/useGetLogo';
import { useBrandingSettings, usePublicConfig } from '../hooks/data/settings';
import { gray, brand } from '@client/app/utils/themes/colors';
import { trackSignupConversion } from '@client/app/utils/signupConversion';
import { applyRedirect, appendRedirectTo } from '@client/app/utils/authRedirect';
import { resetRefreshPromise } from '@client/app/contexts/ApiContext';
import { CURRENT_POLICY_VERSION } from '@bike4mind/common';
import { ExternalLinks, CHECKBOX_LABEL_LINK_SX } from '@client/app/utils/externalLinks';

const registerSchema = z.object({
  username: z
    .string()
    .min(1, 'Username is required')
    .regex(/^[A-Za-z0-9@_.-]+$/, 'Username can only contain letters, numbers, and @_.-'),
  email: z.email('Invalid email format').min(1, 'Email is required'),
  // P0-B abuse gate: both must be checked (literal true) before the Continue button
  // is enabled. Acceptance is captured BEFORE the OTC code is requested, and the accepted policy
  // version + age flag are threaded through OTC verify -> registerViaOTC -> registerUser so the
  // account is gated at creation on this path too (not only via the post-auth interstitial).
  acceptPolicies: z.literal(true),
  confirmAdult: z.literal(true),
});

type RegisterFormData = z.infer<typeof registerSchema>;

type RegisterStep = 'form' | 'otc';

const Register: React.FC = () => {
  const { setCurrentUser, currentUser } = useUser();
  const navigate = useNavigate();
  const router = useRouter();
  const { setAccessToken } = useAccessToken();
  const theme = useTheme();
  const { t } = useTranslation();

  const { mutateAsync: sendOTC, isPending: isSendingOTC } = useSendOTC();
  const { mutateAsync: verifyOTC, isPending: isVerifying } = useVerifyOTC();

  const [createError, setCreateError] = React.useState<string | null>(null);
  const [serverUsernameError, setServerUsernameError] = React.useState<string | null>(null);
  const [serverEmailError, setServerEmailError] = React.useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState<RegisterStep>('form');
  const [otcCode, setOtcCode] = useState('');
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [submittedData, setSubmittedData] = useState<RegisterFormData | null>(null);

  // MFA state - the verify call can come back as a LOGIN when the email already has an
  // account (the user forgot they registered, or a prior attempt created it), and that
  // login can demand MFA. Mirrors MultiStepLogin.
  const [showMFAModal, setShowMFAModal] = useState(false);
  const [mfaUserId, setMfaUserId] = useState<string | null>(null);
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [mfaMode, setMfaMode] = useState<'verify' | 'setup'>('verify');
  const [mfaSetupData, setMfaSetupData] = useState<MFASetupResponse | null>(null);
  const verifyMFA = useVerifyMFA();
  const setupMFA = useSetupMFA();
  const verifyMFASetup = useVerifyMFASetup();

  // Resend cooldown
  const [resendCooldown, setResendCooldown] = useState(0);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [emailFocused, setEmailFocused] = React.useState<boolean>(false);
  const [emailBlurred, setEmailBlurred] = React.useState<boolean>(false);
  const [usernameFocused, setUsernameFocused] = React.useState<boolean>(false);
  const [usernameBlurred, setUsernameBlurred] = React.useState<boolean>(false);
  const isDarkMode = theme.palette.mode === 'dark';
  const logoUrl = useGetLogo();

  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isValid },
  } = useForm<RegisterFormData>({
    resolver: zodResolver(registerSchema),
    mode: 'onChange',
  });

  const emailField = register('email');
  const emailValue = useWatch({ control, name: 'email' }) || '';
  const emailShowError = emailBlurred && !emailFocused && emailValue.length > 0 && !!errors.email;
  const usernameField = register('username');
  const usernameShowError = usernameBlurred && !usernameFocused && !!errors.username;

  const hasRedirectedRef = useRef(false);

  // Gate direct navigation to /register on the open-registration master switch.
  // The login page already hides the "Sign up" link when this is off, but a user
  // hitting /register directly would otherwise reach the form, submit, receive an
  // OTC code, and dead-end on the backend's "invite code required" rejection.
  // Redirect them to /login instead. Only act once the config has loaded and is
  // explicitly false - never on the undefined (still-loading) value.
  const { data: publicConfig, isLoading: isPublicConfigLoading } = usePublicConfig();
  const registrationClosed = !isPublicConfigLoading && publicConfig?.allowOpenRegistration === false;

  useEffect(() => {
    if (currentUser && !hasRedirectedRef.current) {
      hasRedirectedRef.current = true;
      const searchParams = new URLSearchParams(window.location.search);
      applyRedirect(router.history, searchParams.get('redirectTo'), '/', true);
    }
  }, [currentUser, router]);

  useEffect(() => {
    if (registrationClosed && !hasRedirectedRef.current) {
      hasRedirectedRef.current = true;
      const searchParams = new URLSearchParams(window.location.search);
      const redirectTo = searchParams.get('redirectTo');
      navigate({ to: '/login', search: redirectTo ? { redirectTo } : undefined });
    }
  }, [registrationClosed, navigate]);

  // Cleanup cooldown timer
  useEffect(() => {
    return () => {
      if (cooldownRef.current) clearInterval(cooldownRef.current);
    };
  }, []);

  const startResendCooldown = () => {
    // Match the server-side OTC_SEND_COOLDOWN_MS (30s) in /api/otc/send so the client
    // countdown doesn't block a resend the server would already allow.
    setResendCooldown(30);
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

  const darkInactive = {
    '&:disabled': {
      border: 'none',
      background: '#636B74',
      '> p': { color: 'text.tertiary' },
    },
  };

  const lightInactive = {
    '&:disabled': {
      border: `1px solid ${gray[160]}`,
      background: gray[12],
      opacity: 0.3,
      '> p': { color: brand[600] },
    },
  };

  const { inputStyles, dividerStyles } = useCommonStyles();

  useBrandingSettings();

  const onSubmit = async (data: RegisterFormData) => {
    setCreateError(null);
    setServerUsernameError(null);
    setServerEmailError(null);

    try {
      const result = await sendOTC({ email: data.email });

      // Store pending data for after OTC verification
      setSubmittedData(data);
      setPendingToken(result.pendingToken);
      setCurrentStep('otc');
      startResendCooldown();
      toast.success(t('auth.codeSent'));
    } catch (error: unknown) {
      const serverMsg: string = (error as Record<string, string>)?.message || '';
      setCreateError(serverMsg || t('auth.errors.registrationFailed'));
    }
  };

  const handleResendCode = async () => {
    if (resendCooldown > 0 || !submittedData) return;
    try {
      const result = await sendOTC({ email: submittedData.email });
      setPendingToken(result.pendingToken);
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
      // Setting currentUser triggers the redirect effect above.
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
    // challenge, so the code step can't be resumed (any retry dies as "Invalid code.").
    // Restart cleanly from the form.
    setCurrentStep('form');
    setOtcCode('');
    setPendingToken(null);
    if (mfaMode === 'setup') {
      toast.info(
        'Multi-factor authentication setup is required by your administrator. Please complete the setup to continue.'
      );
    } else {
      toast.error('Multi-factor authentication is required to sign in. Please enter your code to continue.');
    }
  };

  const handleOTCVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!submittedData || otcCode.length !== 6) return;

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
        browser: detectBrowser(),
        operatingSystem: detectOS(),
        deviceType: /Mobile|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'Mobile' : 'Desktop',
      };

      const response = await verifyOTC({
        email: submittedData.email,
        code: otcCode,
        username: submittedData.username,
        pendingToken: pendingToken || undefined,
        clientData,
        // P0-B: the schema's z.literal(true) guarantees both boxes were checked before
        // the code was even sent, so acceptance is recorded at account creation on the OTC path too.
        acceptedPolicyVersion: CURRENT_POLICY_VERSION,
        ageAttestation: submittedData.confirmAdult,
      });

      // The email may already have an account - the server then answers with the LOGIN
      // shapes, including MFA challenges. Without these branches the code below would set
      // up a half-session from an MFA response that has no refreshToken.
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

      // Registration successful - response may be OTCRegisterResponse ({ user, accessToken, refreshToken })
      // or OTCVerifyResponse (user doc spread with tokens). Handle both shapes.
      const result = response as Record<string, unknown>;
      const accessToken = (result.accessToken as string) || '';
      const refreshToken = (result.refreshToken as string) || '';
      const user = result.user ?? result; // OTCRegisterResponse has .user, OTCVerifyResponse spreads it
      resetRefreshPromise();

      if (result.user) {
        // Ad-conversion signal (GA4 sign_up + Reddit SignUp). Fires exactly once per
        // created account, before the auth-state swap below unmounts the component.
        // OAuth signups fire the same call from /auth/success via the isNewUser hash param.
        // Only the nested shape is a freshly created account - the flat shape is a login of
        // one that already existed, which must not count as a signup conversion.
        trackSignupConversion('password');
      }

      setAccessToken(accessToken);
      useAccessToken.getState().setVerifiedTokens(accessToken, refreshToken);
      setCurrentUser(user as Parameters<typeof setCurrentUser>[0]);

      const searchParams = new URLSearchParams(window.location.search);
      applyRedirect(router.history, searchParams.get('redirectTo'), '/');
    } catch (error: unknown) {
      const errorMessage = (error as Error).message || 'Verification failed';
      // useVerifyOTC normalizes the AxiosError and surfaces any re-issued pending token
      // (rotated nonce) at the error TOP LEVEL - not under response.data. Swap it in so the
      // next attempt uses the fresh token; retrying with the stale one fails the nonce
      // check and rejects even a correct code (matches MultiStepLogin).
      const reissuedToken = (error as { pendingToken?: string })?.pendingToken;
      if (reissuedToken) {
        setPendingToken(reissuedToken);
      }
      toast.error(errorMessage);
    }
  };

  const detectBrowser = () => {
    const ua = navigator.userAgent;
    if (ua.includes('Firefox/')) return 'Firefox';
    if (ua.includes('Chrome/')) return 'Chrome';
    if (ua.includes('Safari/') && !ua.includes('Chrome/')) return 'Safari';
    if (ua.includes('Edge/') || ua.includes('Edg/')) return 'Edge';
    if (ua.includes('Opera/') || ua.includes('OPR/')) return 'Opera';
    return 'Unknown';
  };

  const detectOS = () => {
    const ua = navigator.userAgent;
    if (ua.includes('Windows')) return 'Windows';
    if (ua.includes('Mac OS')) return 'macOS';
    if (ua.includes('Linux')) return 'Linux';
    if (ua.includes('Android')) return 'Android';
    if (ua.includes('iOS') || ua.includes('iPhone') || ua.includes('iPad')) return 'iOS';
    return 'Unknown';
  };

  const handleSocialLogin = (provider: 'google' | 'github' | 'okta') => {
    const redirectUrl = `/api/auth/${provider}`;
    // Carry redirectTo across the provider round-trip - the full-page navigation
    // drops the in-URL ?redirectTo=, so merge it onto the provider URL and let the
    // server re-attach it to /auth/success after callback (see appendRedirectTo).
    window.location.href = appendRedirectTo(redirectUrl, new URLSearchParams(window.location.search).get('redirectTo'));
  };

  // Avoid flashing the registration form while the open-registration switch is still
  // loading or when it's off (the effect above redirects to /login).
  if (isPublicConfigLoading || registrationClosed) {
    return (
      <Box
        data-testid="register-config-gate"
        sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <CircularProgress />
      </Box>
    );
  }

  return (
    <>
      <Box
        className="register-page-container"
        sx={theme => ({
          backgroundColor: theme.palette.background.panel,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
        })}
      >
        <Container
          className="register-form-container"
          maxWidth={false}
          disableGutters
          sx={theme => ({
            maxWidth: '420px',
            width: '100%',
            mx: 'auto',
            my: 'auto',
            py: '32px',
            backgroundColor: theme.palette.background.panel,
          })}
        >
          <Box
            className="register-header"
            sx={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              alignItems: 'center',
              margin: '0 0 32px',
            }}
          >
            <Box className="register-logo-container" sx={{ position: 'relative', width: 56, height: 56 }}>
              <Image src={logoUrl} alt="Logo" fill style={{ objectFit: 'contain' }} />
            </Box>
            <Typography
              className="register-title"
              level="h2"
              component="h1"
              variant="plain"
              sx={theme => ({
                textWrap: 'balance',
                textAlign: 'center',
                color: theme.palette.text.primary,
                fontWeight: 500,
                fontSize: '20px',
                padding: 0,
              })}
              marginTop={'16px'}
            >
              {currentStep === 'form' ? t('welcome', { name: theme.branding.name }) : t('auth.checkYourEmail')}
            </Typography>
            <Typography
              className="register-subtitle"
              variant="plain"
              sx={{ textAlign: 'center', color: 'text.tertiary', fontSize: '14px', mt: '4px' }}
            >
              {currentStep === 'form'
                ? t('auth.createAccountDesc')
                : t('auth.codeSentTo', { email: submittedData?.email })}
            </Typography>
          </Box>

          {currentStep === 'form' && (
            <>
              <Box
                className="register-social-buttons"
                sx={{ display: 'flex', gap: '8px', width: '100%', '& > button': { minHeight: '40px' } }}
              >
                <Button
                  className="google-login-button"
                  type="button"
                  variant="outlined"
                  color="neutral"
                  sx={{ flex: 1, minWidth: 0, px: '8px', display: 'flex', gap: '.4rem', borderRadius: '8px' }}
                  disabled={isSendingOTC}
                  onClick={() => handleSocialLogin('google')}
                >
                  <Box display="flex" alignItems="center">
                    <GoogleColorIcon />
                    <Typography sx={{ color: 'text.primary', fontWeight: 500, fontSize: '14px', marginLeft: '8px' }}>
                      Google
                    </Typography>
                  </Box>
                </Button>
                <Button
                  className="github-login-button"
                  type="button"
                  variant="outlined"
                  color="neutral"
                  sx={{ flex: 1, minWidth: 0, px: '8px', display: 'flex', gap: '.4rem', borderRadius: '8px' }}
                  disabled={isSendingOTC}
                  onClick={() => handleSocialLogin('github')}
                >
                  <Box display="flex" alignItems="center">
                    <GitHubIcon sx={{ color: 'text.primary', width: '16px', height: '16px' }} />
                    <Typography sx={{ color: 'text.primary', fontWeight: 500, fontSize: '14px', marginLeft: '8px' }}>
                      GitHub
                    </Typography>
                  </Box>
                </Button>
                <Button
                  className="okta-login-button"
                  type="button"
                  variant="outlined"
                  color="neutral"
                  sx={{ flex: 1, minWidth: 0, px: '8px', display: 'flex', gap: '.4rem', borderRadius: '8px' }}
                  disabled={isSendingOTC}
                  onClick={() => handleSocialLogin('okta')}
                >
                  <Box display="flex" alignItems="center">
                    <OktaIcon sx={{ color: '#007DC1' }} />
                    <Typography sx={{ color: 'text.primary', fontWeight: 500, fontSize: '14px', marginLeft: '8px' }}>
                      Okta
                    </Typography>
                  </Box>
                </Button>
              </Box>
              <Divider sx={dividerStyles}>or</Divider>

              <Stack className="register-stack" spacing={3}>
                {/* eslint-disable-next-line react-hooks/refs -- react-hook-form's handleSubmit uses refs internally */}
                <form className="register-form" data-testid="register-form" onSubmit={handleSubmit(onSubmit)}>
                  <Box sx={{ '& .MuiInput-root': { '--Input-minHeight': '40px' } }}>
                    <Stack direction="row" spacing={2}>
                      <FormControl
                        className="register-username-control"
                        size="sm"
                        required
                        id="username"
                        sx={{ width: '50%' }}
                      >
                        <FormLabel
                          className="register-username-label"
                          id="username-label"
                          sx={{ opacity: '0.5' }}
                          required={false}
                        >
                          {t('auth.username')}
                        </FormLabel>
                        <Input
                          className="register-username-input"
                          data-testid="register-username-input"
                          variant="outlined"
                          fullWidth
                          autoComplete="username"
                          {...usernameField}
                          onChange={e => {
                            usernameField.onChange(e);
                            setServerUsernameError(null);
                          }}
                          onFocus={() => setUsernameFocused(true)}
                          onBlur={e => {
                            usernameField.onBlur(e);
                            setUsernameFocused(false);
                            setUsernameBlurred(true);
                          }}
                          error={usernameShowError || !!serverUsernameError}
                          sx={inputStyles}
                        />
                        <Typography
                          className="register-username-error"
                          level="body-xs"
                          color="danger"
                          sx={{ minHeight: '18px', mt: '4px', fontSize: '12px' }}
                        >
                          {serverUsernameError || (usernameShowError ? t('auth.fieldErrors.invalidUsername') : '')}
                        </Typography>
                      </FormControl>
                      <FormControl className="register-email-control" size="sm" id="email" sx={{ width: '50%' }}>
                        <FormLabel className="register-email-label" id="email-label" sx={{ opacity: '0.5' }}>
                          {t('auth.email')}
                        </FormLabel>
                        <Input
                          className="register-email-input"
                          data-testid="register-email-input"
                          variant="outlined"
                          fullWidth
                          autoComplete="email"
                          type="email"
                          {...emailField}
                          onChange={e => {
                            emailField.onChange(e);
                            setServerEmailError(null);
                          }}
                          onFocus={() => setEmailFocused(true)}
                          onBlur={e => {
                            emailField.onBlur(e);
                            setEmailFocused(false);
                            setEmailBlurred(true);
                          }}
                          error={emailShowError || !!serverEmailError}
                          sx={inputStyles}
                        />
                        <Typography
                          className="register-email-error"
                          level="body-xs"
                          color="danger"
                          sx={{ minHeight: '18px', mt: '4px', fontSize: '12px' }}
                        >
                          {serverEmailError || (emailShowError ? t('auth.fieldErrors.invalidEmail') : '')}
                        </Typography>
                      </FormControl>
                    </Stack>

                    {/* P0-B abuse gate: AUP/ToS acceptance + 18+ attestation. Both are
                        z.literal(true) in the schema, so Continue stays disabled until both are
                        checked. The acceptedPolicyVersion sent on OTC verify is the single
                        CURRENT_POLICY_VERSION constant; the server re-validates and rejects if it
                        isn't current.
                        Controller (not register spread): MUI Joy Checkbox forwards a ref to its
                        root span, not the <input>, so a bare register() would not reliably track
                        `checked`. Controller drives the boolean value explicitly. */}
                    <Stack spacing={1} sx={{ mt: '20px' }}>
                      <Controller
                        control={control}
                        name="acceptPolicies"
                        render={({ field: { value, onChange, onBlur, ref } }) => (
                          <Checkbox
                            className="register-aup-tos-checkbox"
                            data-testid="register-aup-tos-checkbox"
                            size="sm"
                            checked={value === true}
                            onChange={e => onChange(e.target.checked)}
                            onBlur={onBlur}
                            slotProps={{ input: { ref } }}
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
                        )}
                      />
                      <Controller
                        control={control}
                        name="confirmAdult"
                        render={({ field: { value, onChange, onBlur, ref } }) => (
                          <Checkbox
                            className="register-age-checkbox"
                            data-testid="register-age-checkbox"
                            size="sm"
                            checked={value === true}
                            onChange={e => onChange(e.target.checked)}
                            onBlur={onBlur}
                            slotProps={{ input: { ref } }}
                            label={
                              <Typography sx={{ fontSize: '13px', color: 'text.secondary' }}>
                                I confirm I am 18 years of age or older
                              </Typography>
                            }
                          />
                        )}
                      />
                    </Stack>

                    <FormControl className="register-submit-control" sx={{ mt: '24px' }}>
                      <Button
                        className="register-submit-button"
                        data-testid="register-submit-btn"
                        type="submit"
                        fullWidth
                        color="primary"
                        disabled={!isValid || isSendingOTC}
                        sx={[
                          { borderRadius: '8px', display: 'flex', gap: 1, alignItems: 'center' },
                          isDarkMode ? darkInactive : lightInactive,
                        ]}
                      >
                        {isSendingOTC && <CircularProgress size="sm" />}
                        <Typography
                          sx={{
                            color: isDarkMode ? 'white' : 'background.body',
                            fontWeight: '500',
                            fontSize: '14px',
                          }}
                        >
                          {t('auth.continue')}
                        </Typography>
                      </Button>
                    </FormControl>

                    <Box
                      className="register-login-prompt"
                      sx={{ display: 'flex', justifyContent: 'center', mt: '20px' }}
                    >
                      <Typography sx={{ color: 'text.tertiary', fontSize: '14px' }}>
                        {t('auth.haveAccount')}{' '}
                        <Link
                          className="register-login-link"
                          data-testid="register-login-btn"
                          color="primary"
                          onClick={() => {
                            const searchParams = new URLSearchParams(window.location.search);
                            const redirectTo = searchParams.get('redirectTo');
                            navigate({ to: '/login', search: redirectTo ? { redirectTo } : undefined });
                          }}
                          sx={{
                            fontWeight: 500,
                            fontSize: '14px',
                            cursor: 'pointer',
                            transition: 'opacity 0.2s ease-in-out',
                            '&:hover': { textDecoration: 'underline' },
                          }}
                        >
                          {t('auth.loginBtn')}
                        </Link>
                      </Typography>
                    </Box>
                  </Box>
                </form>
              </Stack>
            </>
          )}

          {currentStep === 'otc' && (
            <form className="otc-step-form" onSubmit={handleOTCVerify} style={{ width: '100%' }}>
              <FormControl className="otc-control" required id="otc-code" sx={{ width: '100%', margin: '0 auto 16px' }}>
                <FormLabel sx={{ opacity: '0.5' }}>Verification code</FormLabel>
                <Input
                  className="otc-input"
                  data-testid="register-otc-input"
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
                className="register-verify-button"
                data-testid="register-verify-btn"
                type="submit"
                fullWidth
                color="primary"
                disabled={otcCode.length !== 6 || isVerifying}
                sx={[
                  { borderRadius: '8px', display: 'flex', gap: 1, alignItems: 'center', minHeight: '40px' },
                  isDarkMode ? darkInactive : lightInactive,
                ]}
              >
                {isVerifying && <CircularProgress size="sm" />}
                <Typography
                  sx={{
                    color: isDarkMode ? 'white' : 'background.body',
                    fontWeight: '500',
                    fontSize: '14px',
                  }}
                >
                  {isVerifying ? t('auth.verifying') : t('auth.createAccount')}
                </Typography>
              </Button>

              <Box sx={{ display: 'flex', justifyContent: 'center', mt: '20px', gap: 2 }}>
                <Link
                  className="resend-code-link"
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

              <Box sx={{ display: 'flex', justifyContent: 'center', mt: '12px' }}>
                <Link
                  className="back-to-form-link"
                  onClick={() => {
                    setCurrentStep('form');
                    setOtcCode('');
                    setPendingToken(null);
                  }}
                  sx={{
                    color: 'text.tertiary',
                    fontWeight: 500,
                    fontSize: '14px',
                    cursor: 'pointer',
                    transition: 'opacity 0.2s ease-in-out',
                    '&:hover': { textDecoration: 'underline' },
                  }}
                >
                  ← {t('auth.back')}
                </Link>
              </Box>
            </form>
          )}
        </Container>

        <ErrorAlert
          className="register-global-error"
          error={createError}
          onClose={() => setCreateError(null)}
          sx={{
            position: 'fixed',
            bottom: '16px',
            left: '50%',
            transform: 'translateX(-50%)',
            width: 'calc(100% - 32px)',
            maxWidth: '420px',
            zIndex: 1300,
            my: 0,
            p: '8px 4px 8px 12px',
            alignItems: 'center',
            boxShadow: 'md',
          }}
        />
      </Box>

      {/* MFA Modal — only reachable when the verify call resolved to a login of an
          already-existing account whose org enforces (or user configured) MFA. */}
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
    </>
  );
};

export default Register;
