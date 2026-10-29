import { useUser } from '@client/app/contexts/UserContext';
import { useSendOTC, useSignupBotFields, useStartOAuthSignIn, useVerifyOTC } from '@client/app/hooks/data/auth';
import { formatCountdown, useOtcRateLimit } from '@client/app/hooks/useOtcRateLimit';
import OtcRateLimitNotice from './OtcRateLimitNotice';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { useMfaChallenge } from '@client/app/hooks/useMfaChallenge';
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
import SignupHoneypot from './SignupHoneypot';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import React, { useEffect, useState, useRef } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { toast } from 'sonner';
import { dismissOtcCodeSentToast, toastOtcCodeSent } from './otcToast';
import useGetLogo from '../hooks/useGetLogo';
import { useBrandingSettings, usePublicConfig } from '../hooks/data/settings';
import { gray, brand } from '@client/app/utils/themes/colors';
import { trackSignupConversion } from '@client/app/utils/signupConversion';
import { markFirstSignupSession } from '@client/app/utils/firstSignupSession';
import { applyRedirect } from '@client/app/utils/authRedirect';
import { isSubmittableOtcCode, OTC_CODE_PLACEHOLDER, sanitizeOtcInput } from '@client/app/utils/otcCode';
import { resetRefreshCoordinator } from '@client/app/utils/refreshCoordinator';
import { resetSessionBootstrap } from '@client/app/utils/sessionBootstrap';
import { CURRENT_POLICY_VERSION, FirstRunEvents, usernameSchema } from '@bike4mind/common';
import { ExternalLinks, CHECKBOX_LABEL_LINK_SX } from '@client/app/utils/externalLinks';
import { useLogEvent } from '@client/app/hooks/data/analytics';
import { useJoinWaitlist } from '@client/app/hooks/useJoinWaitlist';

const registerSchema = z.object({
  // Same rules the server enforces in registerUser.
  username: usernameSchema,
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
  const joinWaitlist = useJoinWaitlist();
  const router = useRouter();
  const theme = useTheme();
  const { t } = useTranslation();
  const startOAuthSignIn = useStartOAuthSignIn();
  const { mutate: logEvent } = useLogEvent();

  const { mutateAsync: sendOTC, isPending: isSendingOTC } = useSendOTC();
  const { botFields, honeypotProps } = useSignupBotFields();
  const rateLimit = useOtcRateLimit();
  const { mutateAsync: verifyOTC, isPending: isVerifying } = useVerifyOTC();

  const [createError, setCreateError] = React.useState<string | null>(null);
  const [serverUsernameError, setServerUsernameError] = React.useState<string | null>(null);
  const [serverEmailError, setServerEmailError] = React.useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState<RegisterStep>('form');
  const [otcCode, setOtcCode] = useState('');
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [submittedData, setSubmittedData] = useState<RegisterFormData | null>(null);
  const [inviteCode, setInviteCode] = useState('');

  // MFA state - the verify call can come back as a LOGIN when the email already has an
  // account (the user forgot they registered, or a prior attempt created it), and that
  // login can demand MFA. Mirrors MultiStepLogin.
  const mfaChallenge = useMfaChallenge({
    // Setting currentUser triggers the redirect effect.
    onComplete: ({ user }) => setCurrentUser(user),
    onCancel: mode => {
      // The nonce behind the held pendingToken was consumed by the submit that raised the MFA
      // challenge, so the code step can't be resumed (any retry dies as "Invalid code.").
      // Restart cleanly from the form.
      setCurrentStep('form');
      setOtcCode('');
      setPendingToken(null);
      if (mode === 'setup') {
        toast.info(
          'Multi-factor authentication setup is required by your administrator. Please complete the setup to continue.'
        );
      } else {
        toast.error('Multi-factor authentication is required to sign in. Please enter your code to continue.');
      }
    },
  });

  // Resend cooldown
  const [resendCooldown, setResendCooldown] = useState(0);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Synchronous: isPending re-renders too late to stop a double-clicked Resend starting a second challenge.
  const resendingRef = useRef(false);

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
    // any: Zod v4 schema type is incompatible with @hookform/resolvers v5 Zod v3 overload signature
    resolver: zodResolver(registerSchema as any),
    mode: 'onChange',
  });

  const emailField = register('email');
  const emailValue = useWatch({ control, name: 'email' }) || '';
  const emailShowError = emailBlurred && !emailFocused && emailValue.length > 0 && !!errors.email;
  const usernameField = register('username');
  const usernameShowError = usernameBlurred && !usernameFocused && !!errors.username;

  const hasRedirectedRef = useRef(false);

  const { data: publicConfig, isLoading: isPublicConfigLoading } = usePublicConfig();
  const registrationClosed = !isPublicConfigLoading && publicConfig?.allowOpenRegistration === false;

  useEffect(() => {
    if (currentUser && !hasRedirectedRef.current) {
      hasRedirectedRef.current = true;
      const searchParams = new URLSearchParams(window.location.search);
      applyRedirect(router.history, searchParams.get('redirectTo'), '/', true);
    }
  }, [currentUser, router]);

  // Cleanup cooldown timer
  useEffect(() => {
    return () => {
      if (cooldownRef.current) clearInterval(cooldownRef.current);
    };
  }, []);

  const resendBlockedSeconds = Math.max(resendCooldown, rateLimit.secondsLeft);

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
    if (rateLimit.secondsLeft > 0) return;
    if (registrationClosed && !inviteCode.trim()) return;
    setCreateError(null);
    setServerUsernameError(null);
    setServerEmailError(null);

    try {
      const result = await sendOTC({ email: data.email, ...botFields });

      // Store pending data for after OTC verification
      setSubmittedData(data);
      setPendingToken(result.pendingToken);
      setCurrentStep('otc');
      startResendCooldown();
      toastOtcCodeSent(t('auth.codeSent'));
    } catch (error: unknown) {
      if (rateLimit.handleError(error)) return;
      setCreateError(rateLimit.errorMessage(error, t('auth.errors.registrationFailed')));
    }
  };

  const handleResendCode = async () => {
    if (resendingRef.current || resendCooldown > 0 || rateLimit.secondsLeft > 0 || !submittedData) return;
    resendingRef.current = true;
    try {
      const result = await sendOTC({ email: submittedData.email, ...botFields });
      setPendingToken(result.pendingToken);
      toastOtcCodeSent(t('auth.codeSent'));
      startResendCooldown();
    } catch (error) {
      if (rateLimit.handleError(error)) return;
      const errorMessage = rateLimit.errorMessage(error, 'Failed to resend code');
      toast.error(errorMessage);
    } finally {
      resendingRef.current = false;
    }
  };

  const handleOTCVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!submittedData || !isSubmittableOtcCode(otcCode)) return;

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
        inviteCode: inviteCode.trim() || undefined,
        pendingToken: pendingToken || undefined,
        clientData,
        // P0-B: the schema's z.literal(true) guarantees both boxes were checked before
        // the code was even sent, so acceptance is recorded at account creation on the OTC path too.
        acceptedPolicyVersion: CURRENT_POLICY_VERSION,
        ageAttestation: submittedData.confirmAdult,
      });
      dismissOtcCodeSentToast();

      // The email may already have an account - the server then answers with the LOGIN
      // shapes, including MFA challenges. Without these branches the code below would set
      // up a half-session from an MFA response that has no refreshToken.
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

      // Registration successful - response may be OTCRegisterResponse ({ user, accessToken })
      // or OTCVerifyResponse (user doc spread with the access token). Handle both shapes.
      const result = response as Record<string, unknown>;
      const accessToken = (result.accessToken as string) || '';
      const user = result.user ?? result; // OTCRegisterResponse has .user, OTCVerifyResponse spreads it
      resetRefreshCoordinator();
      // Drop the cached cold-load result: this browser just acquired a session, so the next
      // protected navigation must not reuse the "no session" answer from before login.
      resetSessionBootstrap();

      const registeredUser = user as Parameters<typeof setCurrentUser>[0];
      if (result.user) {
        // Ad-conversion signal (GA4 sign_up + Reddit SignUp). Fires exactly once per
        // created account, before the auth-state swap below unmounts the component.
        // OAuth signups fire the same call from /auth/success via the isNewUser hash param.
        // Only the nested shape is a freshly created account - the flat shape is a login of
        // one that already existed, which must not count as a signup conversion.
        if (registeredUser?.id) markFirstSignupSession(registeredUser.id);
        trackSignupConversion('password');
      }

      useAccessToken.getState().setVerifiedSession(accessToken);
      setCurrentUser(registeredUser);
      if (result.user) {
        logEvent({ type: FirstRunEvents.POLICIES_ACCEPTED, metadata: { path: 'registration' } });
      }

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
    startOAuthSignIn(`/api/auth/${provider}`).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Sign-in could not start. Please try again.');
    });
  };

  if (isPublicConfigLoading) {
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
            boxSizing: 'border-box',
            mx: 'auto',
            my: 'auto',
            py: '32px',
            // disableGutters drops the side margins; a phone needs them back.
            px: { xs: '16px', sm: 0 },
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
              {currentStep === 'form' ? (
                t('auth.createAccountDesc')
              ) : (
                <Trans
                  i18nKey="auth.codeSentTo"
                  values={{ email: submittedData?.email }}
                  components={{ email: <Box component="span" sx={{ color: 'text.primary', fontWeight: 600 }} /> }}
                />
              )}
            </Typography>
          </Box>

          {currentStep === 'form' && (
            <>
              <Box hidden={registrationClosed}>
                <Box
                  className="register-social-buttons"
                  sx={{ display: 'flex', gap: '8px', width: '100%', '& > button': { minHeight: '40px' } }}
                >
                  <Button
                    className="google-login-button"
                    data-testid="register-google-btn"
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
                    data-testid="register-github-btn"
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
                    data-testid="register-okta-btn"
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
              </Box>

              <Stack className="register-stack" spacing={3}>
                {/* eslint-disable-next-line react-hooks/refs -- react-hook-form's handleSubmit uses refs internally */}
                <form className="register-form" data-testid="register-form" onSubmit={handleSubmit(onSubmit)}>
                  <Box sx={{ '& .MuiInput-root': { '--Input-minHeight': '40px' } }}>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                      <FormControl
                        className="register-username-control"
                        size="sm"
                        required
                        id="username"
                        sx={{ width: { xs: '100%', sm: '50%' } }}
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
                          slotProps={{
                            input: {
                              'aria-invalid': usernameShowError || !!serverUsernameError,
                              'aria-describedby': 'register-username-error',
                            },
                          }}
                          sx={inputStyles}
                        />
                        <Typography
                          id="register-username-error"
                          role="alert"
                          data-testid="register-username-error"
                          className="register-username-error"
                          level="body-xs"
                          color="danger"
                          sx={{ minHeight: '18px', mt: '4px', fontSize: '12px' }}
                        >
                          {serverUsernameError || (usernameShowError ? t('auth.fieldErrors.invalidUsername') : '')}
                        </Typography>
                      </FormControl>
                      <FormControl
                        className="register-email-control"
                        size="sm"
                        id="email"
                        sx={{ width: { xs: '100%', sm: '50%' } }}
                      >
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
                          slotProps={{
                            input: {
                              'aria-invalid': emailShowError || !!serverEmailError,
                              'aria-describedby': 'register-email-error',
                            },
                          }}
                          sx={inputStyles}
                        />
                        <Typography
                          id="register-email-error"
                          role="alert"
                          data-testid="register-email-error"
                          className="register-email-error"
                          level="body-xs"
                          color="danger"
                          sx={{ minHeight: '18px', mt: '4px', fontSize: '12px' }}
                        >
                          {serverEmailError || (emailShowError ? t('auth.fieldErrors.invalidEmail') : '')}
                        </Typography>
                      </FormControl>
                    </Stack>

                    <FormControl size="sm" required={registrationClosed} sx={{ mt: '16px' }}>
                      <FormLabel htmlFor="register-invite-code">Invite code</FormLabel>
                      <Input
                        data-testid="register-invite-input"
                        slotProps={{ input: { id: 'register-invite-code' } }}
                        value={inviteCode}
                        onChange={e => setInviteCode(e.target.value)}
                        sx={inputStyles}
                      />
                      {registrationClosed && (
                        <Typography level="body-xs" sx={{ mt: '6px', color: 'text.tertiary' }}>
                          {t('auth.noInviteCode')}{' '}
                          <Link
                            component="button"
                            type="button"
                            data-testid="register-join-waitlist-link"
                            onClick={() => joinWaitlist('register_signup_closed', emailValue)}
                          >
                            {t('auth.joinWaitlist')}
                          </Link>
                        </Typography>
                      )}
                    </FormControl>

                    {/* P0-B abuse gate: AUP/ToS acceptance + 18+ attestation. Both are
                        z.literal(true) in the schema, so Continue stays disabled until both are
                        checked. The acceptedPolicyVersion sent on OTC verify is the single
                        CURRENT_POLICY_VERSION constant; the server re-validates and rejects if it
                        isn't current.
                        Controller (not register spread): MUI Joy Checkbox forwards a ref to its
                        root span, not the <input>, so a bare register() would not reliably track
                        `checked`. Controller drives the boolean value explicitly. */}
                    <Stack sx={{ mt: '20px', gap: '8px' }}>
                      <Controller
                        control={control}
                        name="acceptPolicies"
                        render={({ field: { value, onChange, onBlur, ref } }) => (
                          <Checkbox
                            className="register-aup-tos-checkbox"
                            data-testid="register-aup-tos-checkbox"
                            size="sm"
                            sx={{ alignItems: 'center' }}
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

                    <FormControl className="register-submit-control" sx={{ mt: '32px' }}>
                      <Button
                        className="register-submit-button"
                        data-testid="register-submit-btn"
                        type="submit"
                        fullWidth
                        color="primary"
                        disabled={
                          !isValid ||
                          isSendingOTC ||
                          rateLimit.secondsLeft > 0 ||
                          (registrationClosed && !inviteCode.trim())
                        }
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
                          {rateLimit.secondsLeft > 0
                            ? t('auth.retryIn', { time: formatCountdown(rateLimit.secondsLeft) })
                            : t('auth.continue')}
                        </Typography>
                      </Button>
                      <OtcRateLimitNotice
                        initialSeconds={rateLimit.initialSeconds}
                        capped={rateLimit.capped}
                        testId="register-rate-limit-alert"
                      />
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
                            transition: 'color 0.2s ease-in-out',
                            '&:hover': { textDecoration: 'underline' },
                          }}
                        >
                          {t('auth.loginBtn')}
                        </Link>
                      </Typography>
                    </Box>
                  </Box>
                  <SignupHoneypot {...honeypotProps} />
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
                disabled={!isSubmittableOtcCode(otcCode) || isVerifying}
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
                  data-testid="register-resend-btn"
                  color="primary"
                  onClick={handleResendCode}
                  sx={{
                    fontWeight: 500,
                    fontSize: '14px',
                    cursor: resendBlockedSeconds > 0 ? 'default' : 'pointer',
                    opacity: resendBlockedSeconds > 0 ? 0.5 : 1,
                    transition: 'color 0.2s ease-in-out, opacity 0.2s ease-in-out',
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
                testId="register-otc-rate-limit-alert"
              />

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
      <MFAModal {...mfaChallenge.modalProps} />
    </>
  );
};

export default Register;
