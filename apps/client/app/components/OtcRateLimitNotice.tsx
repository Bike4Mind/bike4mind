import { Typography } from '@mui/joy';
import { useTranslation } from 'react-i18next';
import { waitMinutes } from '@client/app/hooks/useOtcRateLimit';

interface OtcRateLimitNoticeProps {
  initialSeconds: number;
  testId: string;
}

/** Announced once when a code request is rate limited; the live countdown lives on the Continue button. */
export default function OtcRateLimitNotice({ initialSeconds, testId }: OtcRateLimitNoticeProps) {
  const { t } = useTranslation();
  if (initialSeconds <= 0) return null;
  const minutes = waitMinutes(initialSeconds);
  const message =
    minutes === null
      ? t('auth.rateLimitedSeconds', { count: initialSeconds })
      : t('auth.rateLimitedMinutes', { count: minutes });

  return (
    <Typography role="alert" data-testid={testId} level="body-sm" color="danger" sx={{ mt: 1, textAlign: 'center' }}>
      {message} {t('auth.rateLimitedSupport')}
    </Typography>
  );
}
