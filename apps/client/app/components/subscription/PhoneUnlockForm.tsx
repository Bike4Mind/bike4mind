import { Box, Button, Input } from '@mui/joy';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NoCardUnlockRefusal } from '@bike4mind/common';
import { usePhoneUnlockStart, usePhoneUnlockVerify } from '@client/app/hooks/data/noCardUnlock';

export type PhoneUnlockOutcome = { granted: number; refusal?: NoCardUnlockRefusal };

interface PhoneUnlockFormProps {
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onOutcome: (outcome: PhoneUnlockOutcome | null) => void;
  onError: () => void;
}

/** Two steps: send an SMS code to a number, then submit the code. Outcomes render in the parent card. */
export function PhoneUnlockForm({ disabled, onBusyChange, onOutcome, onError }: PhoneUnlockFormProps) {
  const { t } = useTranslation();
  const start = usePhoneUnlockStart();
  const verify = usePhoneUnlockVerify();
  const [open, setOpen] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);

  const begin = () => {
    onOutcome(null);
    onBusyChange(true);
  };
  const settle = () => onBusyChange(false);

  const sendCode = () => {
    begin();
    start.mutate(phoneNumber.trim(), {
      onSuccess: result => {
        if (result.sent) {
          setCodeSent(true);
          setCode('');
        } else {
          onOutcome({ granted: 0, refusal: result.refusal });
        }
      },
      onError,
      onSettled: settle,
    });
  };

  const submitCode = () => {
    begin();
    verify.mutate(code.trim(), {
      onSuccess: result => onOutcome({ granted: result.creditsGranted, refusal: result.refusal }),
      onError,
      onSettled: settle,
    });
  };

  if (!open) {
    return (
      <Button
        data-testid="no-card-unlock-phone-btn"
        variant="outlined"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {t('billing.no_card_unlock_phone', 'Verify phone number')}
      </Button>
    );
  }

  return (
    <Box data-testid="no-card-unlock-phone-form" sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', width: '100%' }}>
      {codeSent ? (
        <>
          <Input
            slotProps={{ input: { 'data-testid': 'no-card-unlock-phone-code-input', inputMode: 'numeric' } }}
            placeholder={t('billing.no_card_unlock_phone_code', 'Code from SMS')}
            value={code}
            onChange={event => setCode(event.target.value)}
            autoComplete="one-time-code"
          />
          <Button
            data-testid="no-card-unlock-phone-verify-btn"
            loading={verify.isPending}
            disabled={disabled || !/^\d{4,10}$/.test(code.trim())}
            onClick={submitCode}
          >
            {t('billing.no_card_unlock_phone_verify', 'Verify code')}
          </Button>
          <Button
            data-testid="no-card-unlock-phone-change-btn"
            variant="plain"
            disabled={disabled}
            onClick={() => setCodeSent(false)}
          >
            {t('billing.no_card_unlock_phone_change', 'Use a different number')}
          </Button>
        </>
      ) : (
        <>
          <Input
            slotProps={{ input: { 'data-testid': 'no-card-unlock-phone-input', inputMode: 'tel' } }}
            placeholder={t('billing.no_card_unlock_phone_placeholder', 'Mobile number, e.g. +14155552671')}
            value={phoneNumber}
            onChange={event => setPhoneNumber(event.target.value)}
            autoComplete="tel"
          />
          <Button
            data-testid="no-card-unlock-phone-send-btn"
            loading={start.isPending}
            disabled={disabled || phoneNumber.trim() === ''}
            onClick={sendCode}
          >
            {t('billing.no_card_unlock_phone_send', 'Send code')}
          </Button>
        </>
      )}
    </Box>
  );
}
