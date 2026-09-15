import { useEffect, useState } from 'react';

export interface SecurityScanCooldown {
  cooldownActive: boolean;
  hoursRemaining: number;
  minutesRemaining: number;
  remainingMs: number;
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

// Re-tick every 30 seconds while a cooldown is active so the displayed minutesRemaining
// counts down without requiring a network refetch.
const TICK_INTERVAL_MS = 30 * 1000;

function compute(checkedAt: string | Date | null | undefined, windowMs: number, now: number): SecurityScanCooldown {
  if (!checkedAt) {
    return { cooldownActive: false, hoursRemaining: 0, minutesRemaining: 0, remainingMs: 0 };
  }
  const lastTime = (checkedAt instanceof Date ? checkedAt : new Date(checkedAt)).getTime();
  if (Number.isNaN(lastTime)) {
    return { cooldownActive: false, hoursRemaining: 0, minutesRemaining: 0, remainingMs: 0 };
  }
  const diffMs = now - lastTime;
  if (diffMs >= windowMs) {
    return { cooldownActive: false, hoursRemaining: 0, minutesRemaining: 0, remainingMs: 0 };
  }
  const remainingMs = windowMs - diffMs;
  return {
    cooldownActive: true,
    hoursRemaining: Math.ceil(remainingMs / (60 * 60 * 1000)),
    minutesRemaining: Math.max(1, Math.ceil(remainingMs / 60_000)),
    remainingMs,
  };
}

/**
 * React hook that returns the cooldown status for a security scan and ticks down once a
 * minute while the cooldown is active.
 *
 * @param checkedAt - ISO timestamp of the most recent scan; null/undefined treated as "never run"
 * @param windowMs - cooldown window length, defaults to 24h. Pass a smaller value for tabs
 *   with shorter cooldowns (e.g. 30 minutes for Active Defense).
 */
export function useSecurityScanCooldown(
  checkedAt?: string | Date | null,
  windowMs: number = DEFAULT_WINDOW_MS
): SecurityScanCooldown {
  const [now, setNow] = useState<number>(() => Date.now());
  const status = compute(checkedAt, windowMs, now);

  useEffect(() => {
    if (!status.cooldownActive) return;
    const interval = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [status.cooldownActive]);

  return status;
}
