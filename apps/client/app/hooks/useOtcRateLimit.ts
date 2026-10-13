import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface OtcRateLimitError {
  code?: string;
  retryAfterSeconds?: number;
}

export interface OtcRateLimit {
  /** Seconds left until another code can be requested; 0 when not limited. */
  secondsLeft: number;
  /** Whole wait announced when the limit was hit; stays fixed so a live region is not re-read every tick. */
  initialSeconds: number;
  /** Returns true when the error was a 429 with a wait and the countdown started. */
  handleError: (error: unknown) => boolean;
  /** True when the server wait exceeded the client cap, so the announced duration would understate it. */
  capped: boolean;
  /** Message for a failed send: a client "try again" string for Retry-After 0, else the server message or fallback. */
  errorMessage: (error: unknown, fallback: string) => string;
  clear: () => void;
}

const FALLBACK_WAIT_SECONDS = 60;
// Bounds a bogus header so the button never shows a multi-day countdown; the server still enforces the real wait.
const MAX_WAIT_SECONDS = 3600;

/** Formats a wait as "m:ss" for the button countdown. */
export function formatCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Whole minutes (rounded up) for the announced message, or null when under a minute. */
export function waitMinutes(totalSeconds: number): number | null {
  return totalSeconds >= 60 ? Math.ceil(totalSeconds / 60) : null;
}

/** Tracks a 429 from /api/otc/send and counts the wait down once per second. */
export function useOtcRateLimit(): OtcRateLimit {
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [initialSeconds, setInitialSeconds] = useState(0);
  const [capped, setCapped] = useState(false);
  const { t } = useTranslation();
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  const clear = useCallback(() => {
    stop();
    setSecondsLeft(0);
    setInitialSeconds(0);
    setCapped(false);
  }, [stop]);

  const handleError = useCallback(
    (error: unknown): boolean => {
      const { code, retryAfterSeconds } = (error ?? {}) as OtcRateLimitError;
      if (code !== 'CLIENT_ERROR_429') return false;
      // Retry-After: 0 means "retry now" (lost a concurrent-send race), so no lockout; the caller shows the server message.
      if (retryAfterSeconds === 0) return false;
      const requested =
        typeof retryAfterSeconds === 'number' && retryAfterSeconds > 0
          ? Math.ceil(retryAfterSeconds)
          : FALLBACK_WAIT_SECONDS;
      const wait = Math.min(requested, MAX_WAIT_SECONDS);
      stop();
      setCapped(requested > MAX_WAIT_SECONDS);
      setInitialSeconds(wait);
      setSecondsLeft(wait);
      timerRef.current = setInterval(() => {
        setSecondsLeft(prev => {
          if (prev <= 1) {
            stop();
            setInitialSeconds(0);
            setCapped(false);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return true;
    },
    [stop]
  );

  const errorMessage = useCallback(
    (error: unknown, fallback: string): string => {
      const { code, retryAfterSeconds, message } = (error ?? {}) as OtcRateLimitError & { message?: string };
      if (code === 'CLIENT_ERROR_429' && retryAfterSeconds === 0) return t('auth.rateLimitRetryNow');
      return message || fallback;
    },
    [t]
  );

  return { secondsLeft, initialSeconds, capped, errorMessage, handleError, clear };
}
