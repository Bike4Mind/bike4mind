export interface CooldownResult {
  canRun: boolean;
  hoursRemaining: number;
  remainingMs: number;
}

export function getCooldownStatus(
  lastRun: Date | string | null | undefined,
  windowMs = 24 * 60 * 60 * 1000
): CooldownResult {
  if (!lastRun) {
    return { canRun: true, hoursRemaining: 0, remainingMs: 0 };
  }

  const lastTime = new Date(lastRun).getTime();
  if (Number.isNaN(lastTime)) {
    return { canRun: true, hoursRemaining: 0, remainingMs: 0 };
  }

  const now = Date.now();
  const diffMs = now - lastTime;

  if (diffMs >= windowMs) {
    return { canRun: true, hoursRemaining: 0, remainingMs: 0 };
  }

  const remainingMs = windowMs - diffMs;
  const hoursRemaining = Math.ceil(remainingMs / (60 * 60 * 1000));

  return {
    canRun: false,
    hoursRemaining,
    remainingMs,
  };
}
