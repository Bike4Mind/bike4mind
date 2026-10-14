import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormLabel,
  Input,
  Modal,
  ModalDialog,
  Stack,
  Typography,
} from '@mui/joy';
import { isAxiosError } from 'axios';
import { startAuthentication } from '@simplewebauthn/browser';
import { api } from '@client/app/contexts/ApiContext';
import { describePasskeyMfaError, passkeysSupported } from '@client/app/hooks/data/passkeys';
import { useStepUpStore } from '@client/app/stores/useStepUpStore';

type StepUpMethod = 'totp' | 'passkey' | 'password' | 'email';

type StepUpOptions = { methods: StepUpMethod[]; stepUpUntil: string | null };

const describeError = (error: unknown, fallback: string): string => {
  if (!isAxiosError(error)) return fallback;
  const data = error.response?.data as { error?: string; attemptsRemaining?: number } | undefined;
  const message = data?.error || fallback;
  return data?.attemptsRemaining !== undefined ? `${message} (${data.attemptsRemaining} attempts remaining)` : message;
};

/**
 * Global "Confirm it's you" prompt. Opened by the step-up interceptor when a request needs
 * recent verification; renders only the proof methods the server offers for this account.
 */
const StepUpModal: React.FC = () => {
  const open = useStepUpStore(state => state.open);
  const completeStepUp = useStepUpStore(state => state.completeStepUp);
  const cancelStepUp = useStepUpStore(state => state.cancelStepUp);

  const [methods, setMethods] = useState<StepUpMethod[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [password, setPassword] = useState('');
  const [emailPendingToken, setEmailPendingToken] = useState<string | null>(null);
  const [emailCode, setEmailCode] = useState('');

  useEffect(() => {
    if (!open) return;
    setMethods(null);
    setError(null);
    setTotpCode('');
    setPassword('');
    setEmailPendingToken(null);
    setEmailCode('');

    let cancelled = false;
    api
      .get<StepUpOptions>('/api/auth/step-up/options')
      .then(({ data }) => {
        if (!cancelled) setMethods(data.methods);
      })
      .catch(optionsError => {
        if (!cancelled) {
          setMethods([]);
          setError(describeError(optionsError, 'Could not load verification options'));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const submit = useCallback(
    async (body: Record<string, unknown>, fallback: string) => {
      setSubmitting(true);
      setError(null);
      try {
        await api.post('/api/auth/step-up', body);
        completeStepUp();
      } catch (submitError) {
        setError(describeError(submitError, fallback));
      } finally {
        setSubmitting(false);
      }
    },
    [completeStepUp]
  );

  const handlePasskey = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const { data: optionsJSON } = await api.post('/api/auth/step-up/passkey-options');
      const response = await startAuthentication({ optionsJSON });
      await api.post('/api/auth/step-up', { method: 'passkey', response });
      completeStepUp();
    } catch (passkeyError) {
      setError(describePasskeyMfaError(passkeyError));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSendEmail = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const { data } = await api.post<{ pendingToken: string }>('/api/auth/step-up/email/send');
      setEmailPendingToken(data.pendingToken);
    } catch (sendError) {
      setError(describeError(sendError, 'Could not send the verification code'));
    } finally {
      setSubmitting(false);
    }
  };

  const has = (method: StepUpMethod) => methods?.includes(method) ?? false;
  const sections: React.ReactNode[] = [];

  if (has('totp')) {
    sections.push(
      <Stack
        key="totp"
        component="form"
        spacing={1}
        onSubmit={event => {
          event.preventDefault();
          void submit({ method: 'totp', code: totpCode.trim() }, 'Verification failed');
        }}
      >
        <FormControl>
          <FormLabel>Authenticator or backup code</FormLabel>
          <Input
            autoFocus
            autoComplete="one-time-code"
            value={totpCode}
            onChange={event => setTotpCode(event.target.value)}
            disabled={submitting}
            slotProps={{ input: { 'data-testid': 'step-up-modal-totp-input' } }}
          />
        </FormControl>
        <Button
          type="submit"
          loading={submitting}
          disabled={totpCode.trim().length === 0}
          data-testid="step-up-modal-verify-btn"
        >
          Verify
        </Button>
      </Stack>
    );
  }

  if (has('passkey') && passkeysSupported()) {
    sections.push(
      <Button
        key="passkey"
        variant="outlined"
        loading={submitting}
        onClick={() => void handlePasskey()}
        data-testid="step-up-modal-passkey-btn"
      >
        Use a passkey
      </Button>
    );
  }

  if (has('password')) {
    sections.push(
      <Stack
        key="password"
        component="form"
        spacing={1}
        onSubmit={event => {
          event.preventDefault();
          void submit({ method: 'password', password }, 'Incorrect password');
        }}
      >
        <FormControl>
          <FormLabel>Password</FormLabel>
          <Input
            autoFocus
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            disabled={submitting}
            slotProps={{ input: { 'data-testid': 'step-up-modal-password-input' } }}
          />
        </FormControl>
        <Button
          type="submit"
          loading={submitting}
          disabled={password.length === 0}
          data-testid="step-up-modal-password-verify-btn"
        >
          Verify
        </Button>
      </Stack>
    );
  }

  if (has('email')) {
    sections.push(
      emailPendingToken ? (
        <Stack
          key="email"
          component="form"
          spacing={1}
          onSubmit={event => {
            event.preventDefault();
            void submit(
              { method: 'email', pendingToken: emailPendingToken, code: emailCode.trim() },
              'Verification failed'
            );
          }}
        >
          <FormControl>
            <FormLabel>Code sent to your email</FormLabel>
            <Input
              autoFocus
              autoComplete="one-time-code"
              value={emailCode}
              onChange={event => setEmailCode(event.target.value)}
              disabled={submitting}
              slotProps={{ input: { 'data-testid': 'step-up-modal-email-code-input' } }}
            />
          </FormControl>
          <Button
            type="submit"
            loading={submitting}
            disabled={emailCode.trim().length === 0}
            data-testid="step-up-modal-email-verify-btn"
          >
            Verify
          </Button>
        </Stack>
      ) : (
        <Button
          key="email"
          variant="outlined"
          loading={submitting}
          onClick={() => void handleSendEmail()}
          data-testid="step-up-modal-email-send-btn"
        >
          Send code to my email
        </Button>
      )
    );
  }

  return (
    <Modal
      open={open}
      onClose={cancelStepUp}
      sx={{ zIndex: theme => theme.zIndex.modal + 100 }}
      data-testid="step-up-modal"
    >
      <ModalDialog sx={{ width: 400, maxWidth: '92vw' }} aria-labelledby="step-up-modal-title">
        <DialogTitle id="step-up-modal-title">Confirm it&apos;s you</DialogTitle>
        <DialogContent>
          <Typography level="body-sm" sx={{ mb: 2 }}>
            For your security, verify your identity to continue.
          </Typography>
          {error && (
            <Alert color="danger" sx={{ mb: 2 }} role="alert" data-testid="step-up-modal-error">
              {error}
            </Alert>
          )}
          {methods === null && !error && <Typography level="body-sm">Loading...</Typography>}
          {methods?.length === 0 && (
            <Alert color="warning" sx={{ mb: 2 }} data-testid="step-up-modal-no-methods">
              No verification method is available for this account. Please contact support to make this change.
            </Alert>
          )}
          <Stack spacing={2}>
            {sections.map((section, index) => (
              <Box key={index}>
                {index > 0 && <Divider sx={{ mb: 2 }}>or</Divider>}
                {section}
              </Box>
            ))}
          </Stack>
        </DialogContent>
        <Button variant="plain" color="neutral" onClick={cancelStepUp} data-testid="step-up-modal-cancel-btn">
          Cancel
        </Button>
      </ModalDialog>
    </Modal>
  );
};

export default StepUpModal;
