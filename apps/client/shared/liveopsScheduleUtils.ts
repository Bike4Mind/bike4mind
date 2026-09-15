/**
 * Shared schedule utilities for LiveOps Triage
 *
 * These functions calculate run times for the configurable schedule feature.
 * Used by both server (cron) and client (admin UI) code.
 *
 * Schedule Details:
 * - AWS EventBridge fires every 6 hours at 2, 8, 14, 20 UTC
 * - Lambda checks config.runIntervalHours to decide whether to run
 * - All times use UTC to avoid DST issues
 *
 * Reference times (during CST, UTC-6):
 * - 2 UTC = 8pm CST (previous day) = 10am PHT
 * - 8 UTC = 2am CST = 4pm PHT
 * - 14 UTC = 8am CST = 10pm PHT
 * - 20 UTC = 2pm CST = 4am PHT (next day)
 */

import { LIVEOPS_TRIAGE_VALIDATION_LIMITS } from '@bike4mind/common';

/**
 * Valid run interval options
 */
export type RunIntervalHours = 6 | 12 | 24;

/**
 * Get the UTC hours when triage should run based on interval setting.
 * All times are UTC to avoid DST issues.
 */
export function getRunHoursForInterval(intervalHours: number): number[] {
  switch (intervalHours) {
    case 6:
      return [2, 8, 14, 20]; // Every 6 hours
    case 12:
      return [2, 14]; // 8am + 8pm CST (10pm + 10am PHT)
    case 24:
      return [14]; // 8am CST only (10pm PHT)
    default:
      return [14]; // Default to 8am CST
  }
}

/**
 * Calculate the next scheduled run time based on interval.
 *
 * @param intervalHours - The run interval (6, 12, or 24 hours)
 * @param referenceDate - Optional date to calculate from (defaults to now, useful for testing)
 * @returns Date object representing the next scheduled run time
 */
export function getNextScheduledRun(
  intervalHours: number = LIVEOPS_TRIAGE_VALIDATION_LIMITS.runIntervalHours.default,
  referenceDate: Date = new Date()
): Date {
  const currentHourUTC = referenceDate.getUTCHours();
  const runHours = getRunHoursForInterval(intervalHours);

  // Find the next run hour after current time
  const nextHour = runHours.find(h => h > currentHourUTC) ?? runHours[0];
  const nextRun = new Date(referenceDate);
  nextRun.setUTCHours(nextHour, 0, 0, 0);

  // If next hour wrapped around (is tomorrow), add a day
  if (nextHour <= currentHourUTC) {
    nextRun.setUTCDate(nextRun.getUTCDate() + 1);
  }

  return nextRun;
}

/**
 * Check if the current UTC hour matches the configured interval schedule.
 *
 * @param intervalHours - The run interval (6, 12, or 24 hours)
 * @param referenceDate - Optional date to check (defaults to now, useful for testing)
 * @returns true if we should run, false if we should skip
 */
export function shouldRunAtCurrentHour(intervalHours: number, referenceDate: Date = new Date()): boolean {
  const currentHourUTC = referenceDate.getUTCHours();
  const runHours = getRunHoursForInterval(intervalHours);
  return runHours.includes(currentHourUTC);
}

/**
 * Format next run time for display with both CST and PHT timezones.
 * Useful for showing users when the next run will occur in their timezone.
 */
export function formatNextRun(nextRun: Date): string {
  const cst = nextRun.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const pht = nextRun.toLocaleString('en-US', {
    timeZone: 'Asia/Manila',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${cst} CST (${pht} PHT)`;
}

/**
 * Get friendly description for interval setting (for UI display).
 */
export function getIntervalDescription(interval: number): string {
  switch (interval) {
    case 6:
      return 'Runs at 2am, 8am, 2pm, 8pm CST';
    case 12:
      return 'Runs at 8am, 8pm CST (10am, 10pm PHT)';
    case 24:
      return 'Runs daily at 8am CST (10pm PHT)';
    default:
      return '';
  }
}
