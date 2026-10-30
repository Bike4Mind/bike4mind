import { Box, Button, FormControl, FormLabel, Input, Typography } from '@mui/joy';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { PHONE_UNLOCK_CODE_PATTERN, PHONE_UNLOCK_INPUT_MAX_LENGTH, type NoCardUnlockRefusal } from '@bike4mind/common';
import { usePhoneUnlockStart, usePhoneUnlockVerify } from '@client/app/hooks/data/noCardUnlock';

export type PhoneUnlockOutcome = { granted: number; refusal?: NoCardUnlockRefusal };

type PhoneUnlockFormProps = {
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onOutcome: (outcome: PhoneUnlockOutcome | null) => void;
  onError: () => void;
};

type Step = 'closed' | 'number' | 'code' | 'done';

/** Two steps: send an SMS code to a number, then submit the code. Outcomes render in the parent card. */
export function PhoneUnlockForm({ disabled, onBusyChange, onOutcome, onError }: PhoneUnlockFormProps) {
  const { t } = useTranslation();
  const start = usePhoneUnlockStart();
  const verify = usePhoneUnlockVerify();
  const [step, setStep] = useState<Step>('closed');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [code, setCode] = useState('');
  const busy = start.isPending || verify.isPending;
  const locked = disabled || busy;

  // Per-call mutate callbacks are skipped after unmount, so a request still in flight must release
  // the card's busy flag here. Refs keep the cleanup to unmount only, whatever the parent passes.
  const ownsBusy = useRef(false);
  const releaseBusy = useRef(onBusyChange);
  useEffect(() => {
    releaseBusy.current = onBusyChange;
  });
  useEffect(
    () => () => {
      if (ownsBusy.current) releaseBusy.current(false);
    },
    []
  );

  const begin = () => {
    onOutcome(null);
    ownsBusy.current = true;
    onBusyChange(true);
  };
  const settle = () => {
    ownsBusy.current = false;
    onBusyChange(false);
  };

  const sendCode = (event?: FormEvent) => {
    event?.preventDefault();
    const number = phoneNumber.trim();
    if (locked || number === '') return;
    begin();
    start.mutate(number, {
      onSuccess: result => {
        if (!result.sent) return onOutcome({ granted: 0, refusal: result.refusal });
        setSentTo(result.sentTo);
        setCode('');
        setStep('code');
      },
      onError,
      onSettled: settle,
    });
  };

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    if (locked || !PHONE_UNLOCK_CODE_PATTERN.test(code.trim())) return;
    begin();
    verify.mutate(code.trim(), {
      onSuccess: result => {
        onOutcome({ granted: result.creditsGranted, refusal: result.refusal });
        if (result.creditsGranted > 0) setStep('done');
      },
      onError,
      onSettled: settle,
    });
  };

  const changeNumber = () => {
    onOutcome(null);
    setStep('number');
  };

  if (step === 'done') return null;

  if (step === 'closed') {
    return (
      <Button
        data-testid="no-card-unlock-phone-btn"
        variant="outlined"
        disabled={disabled}
        onClick={() => setStep('number')}
      >
        {t('billing.no_card_unlock_phone', 'Verify phone number')}
      </Button>
    );
  }

  if (step === 'number') {
    return (
      <Box
        component="form"
        data-testid="no-card-unlock-phone-form"
        onSubmit={sendCode}
        sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'flex-end', width: '100%' }}
      >
        <FormControl>
          <FormLabel>{t('billing.no_card_unlock_phone_label', 'Mobile number')}</FormLabel>
          <Input
            slotProps={{
              input: {
                'data-testid': 'no-card-unlock-phone-input',
                inputMode: 'tel',
                maxLength: PHONE_UNLOCK_INPUT_MAX_LENGTH,
              },
            }}
            placeholder="+14155552671"
            value={phoneNumber}
            onChange={event => setPhoneNumber(event.target.value)}
            autoComplete="tel"
          />
        </FormControl>
        <Button
          type="submit"
          data-testid="no-card-unlock-phone-send-btn"
          loading={start.isPending}
          disabled={locked || phoneNumber.trim() === ''}
        >
          {t('billing.no_card_unlock_phone_send', 'Send code')}
        </Button>
      </Box>
    );
  }

  return (
    <Box
      component="form"
      data-testid="no-card-unlock-phone-form"
      onSubmit={submitCode}
      sx={{ display: 'flex', flexDirection: 'column', gap: 1, width: '100%' }}
    >
      <Typography level="body-sm" data-testid="no-card-unlock-phone-sent-to">
        {t('billing.no_card_unlock_phone_sent_to', 'We sent a code to {{number}}.', { number: sentTo })}
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <FormControl>
          <FormLabel>{t('billing.no_card_unlock_phone_code', 'Code from SMS')}</FormLabel>
          <Input
            slotProps={{ input: { 'data-testid': 'no-card-unlock-phone-code-input', inputMode: 'numeric' } }}
            value={code}
            onChange={event => setCode(event.target.value)}
            autoComplete="one-time-code"
          />
        </FormControl>
        <Button
          type="submit"
          data-testid="no-card-unlock-phone-verify-btn"
          loading={verify.isPending}
          disabled={locked || !PHONE_UNLOCK_CODE_PATTERN.test(code.trim())}
        >
          {t('billing.no_card_unlock_phone_verify', 'Verify code')}
        </Button>
      </Box>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        <Button
          data-testid="no-card-unlock-phone-resend-btn"
          variant="plain"
          size="sm"
          loading={start.isPending}
          disabled={locked}
          onClick={() => sendCode()}
        >
          {t('billing.no_card_unlock_phone_resend', 'Send a new code')}
        </Button>
        <Button
          data-testid="no-card-unlock-phone-change-btn"
          variant="plain"
          size="sm"
          disabled={locked}
          onClick={changeNumber}
        >
          {t('billing.no_card_unlock_phone_change', 'Use a different number')}
        </Button>
      </Box>
    </Box>
  );
}
