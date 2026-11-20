import { useEffect, useState } from 'react';
import { Typography } from '@mui/joy';
import { useTranslation } from 'react-i18next';

export const OTC_NO_CODE_HINT_DELAY_MS = 30_000;

interface OtcNoCodeHintProps {
  testId?: string;
}

/** Shown to every caller after the same delay, so it says nothing about whether a code was mailed. */
export default function OtcNoCodeHint({ testId = 'otc-no-code-hint' }: OtcNoCodeHintProps) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), OTC_NO_CODE_HINT_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;
  return (
    <Typography
      role="status"
      data-testid={testId}
      level="body-sm"
      sx={{ mt: 2, textAlign: 'center', color: 'text.tertiary' }}
    >
      {t('auth.noCodeHint')}
    </Typography>
  );
}
