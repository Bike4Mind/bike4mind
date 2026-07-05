import { Stack, Typography } from '@mui/joy';
import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';

const InteractiveChaoticLaserBicycleWheel = dynamic(
  () => import('@client/app/components/common/InteractiveChaoticLaserBicycleWheel'),
  { ssr: false }
);

const LONG_RUNNING_THRESHOLD_S = 30;

const formatElapsed = (seconds: number): string => {
  if (seconds < 1) return '';
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

interface ReplyStatusProps {
  renderSpinnerStatusNull?: boolean;
  status?: string | null;
  createdAt?: Date | string | number;
  /** The user's message for the running quest, shown above the status (e.g. the
   *  transcribed voice turn) so it's clear what's being worked on. */
  userMessage?: string | null;
}

const ReplyStatus = ({ renderSpinnerStatusNull = false, status, createdAt, userMessage }: ReplyStatusProps) => {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Anchored to createdAt - status transitions reseed (never blink to 0) and
  // pausing status clears the interval so we don't tick while invisible.
  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (!createdAt) {
      setElapsedSeconds(0);
      return;
    }

    const startTime = new Date(createdAt).getTime();
    if (!Number.isFinite(startTime)) {
      setElapsedSeconds(0);
      return;
    }
    const computeElapsed = () => Math.max(0, Math.floor((Date.now() - startTime) / 1000));
    setElapsedSeconds(computeElapsed());

    if (!status) return;

    intervalRef.current = setInterval(() => setElapsedSeconds(computeElapsed()), 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [createdAt, status]);

  const shouldRenderSpinner = status !== null || renderSpinnerStatusNull;
  const isLongRunning = elapsedSeconds >= LONG_RUNNING_THRESHOLD_S;

  const trimmedUserMessage = userMessage?.trim();

  return (
    <Stack
      className="reply-status-container"
      sx={{
        display: 'flex',
        gap: 1,
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'white',
      }}
    >
      {trimmedUserMessage && (
        <Typography
          data-testid="reply-status-user-message"
          sx={{ color: 'text.tertiary', fontStyle: 'italic', textAlign: 'center', maxWidth: '32rem' }}
          level="body-sm"
        >
          “{trimmedUserMessage}”
        </Typography>
      )}
      <Stack
        sx={{
          display: 'flex',
          gap: 2,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          flexWrap: 'wrap',
        }}
      >
        {shouldRenderSpinner && <InteractiveChaoticLaserBicycleWheel />}
        {status && (
          <Typography
            className="reply-status-text"
            sx={{ color: 'text.primary50', lineHeight: '100%', fontSize: '16px' }}
            level="body-lg"
          >
            {status}
            {elapsedSeconds > 0 && (
              <Typography
                component="span"
                data-testid="reply-status-elapsed"
                sx={{
                  ml: 1,
                  color: isLongRunning ? 'warning.400' : 'neutral.400',
                  fontSize: '14px',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                ({formatElapsed(elapsedSeconds)})
              </Typography>
            )}
          </Typography>
        )}
      </Stack>
    </Stack>
  );
};

export default ReplyStatus;
