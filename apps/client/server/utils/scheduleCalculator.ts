/**
 * Schedule Calculator Utilities
 *
 * Helper functions for calculating next run times for scheduled security scans.
 * Fixed schedule: Every Sunday at 2:00 AM UTC
 */

/**
 * Calculate the next occurrence of a specific day/time
 *
 * @param dayOfWeek - Day of week (0 = Sunday, 6 = Saturday)
 * @param timeOfDay - Time in HH:MM format (e.g., '02:00')
 * @param fromDate - Starting date (defaults to now)
 * @returns Next occurrence of the specified day/time in UTC
 *
 * @example
 * // Calculate next Sunday at 2:00 AM UTC
 * const nextSunday = calculateNextRunTime(0, '02:00');
 *
 * @example
 * // Calculate from a specific date
 * const nextRun = calculateNextRunTime(0, '02:00', new Date('2024-02-10'));
 */
export function calculateNextRunTime(
  dayOfWeek: number,
  timeOfDay: string,
  fromDate: Date = new Date()
): Date {
  if (dayOfWeek < 0 || dayOfWeek > 6) {
    throw new Error('dayOfWeek must be between 0 (Sunday) and 6 (Saturday)');
  }

  if (!/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/.test(timeOfDay)) {
    throw new Error('timeOfDay must be in HH:MM format (e.g., 02:00)');
  }

  const [hours, minutes] = timeOfDay.split(':').map(Number);
  const next = new Date(fromDate);

  // Calculate days until next occurrence of target day of week
  const currentDay = next.getUTCDay();
  let daysUntil = dayOfWeek - currentDay;

  // If we're already on the target day, check if we've passed the target time
  if (daysUntil === 0) {
    const currentHour = next.getUTCHours();
    const currentMinute = next.getUTCMinutes();

    // If we've already passed the target time today, schedule for next week
    if (currentHour > hours || (currentHour === hours && currentMinute >= minutes)) {
      daysUntil = 7;
    }
  } else if (daysUntil < 0) {
    // If target day is earlier in the week, add 7 days to get next week
    daysUntil += 7;
  }

  next.setUTCDate(next.getUTCDate() + daysUntil);
  next.setUTCHours(hours, minutes, 0, 0);

  return next;
}

/**
 * Calculate the next N occurrences of a scheduled time
 * Useful for showing users upcoming scheduled runs
 *
 * @param dayOfWeek - Day of week (0 = Sunday, 6 = Saturday)
 * @param timeOfDay - Time in HH:MM format
 * @param count - Number of occurrences to calculate
 * @param fromDate - Starting date (defaults to now)
 * @returns Array of next N occurrences
 *
 * @example
 * // Get next 3 scheduled runs
 * const nextRuns = calculateNextRuns(0, '02:00', 3);
 * // Returns [Date(next Sunday), Date(Sunday+7), Date(Sunday+14)]
 */
export function calculateNextRuns(
  dayOfWeek: number,
  timeOfDay: string,
  count: number,
  fromDate: Date = new Date()
): Date[] {
  if (count < 1 || count > 52) {
    throw new Error('count must be between 1 and 52');
  }

  const runs: Date[] = [];
  let currentDate = fromDate;

  for (let i = 0; i < count; i++) {
    const nextRun = calculateNextRunTime(dayOfWeek, timeOfDay, currentDate);
    runs.push(nextRun);
    // Add 1 minute to ensure we don't get the same date again
    currentDate = new Date(nextRun.getTime() + 60 * 1000);
  }

  return runs;
}

/**
 * Get human-readable day name from day number
 *
 * @param dayOfWeek - Day number (0 = Sunday, 6 = Saturday)
 * @returns Day name
 */
export function getDayName(dayOfWeek: number): string {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  if (dayOfWeek < 0 || dayOfWeek > 6) {
    return 'Invalid day';
  }

  return days[dayOfWeek];
}

/**
 * Format a date for display in schedule configuration
 *
 * @param date - Date to format
 * @returns Formatted string (e.g., "Sunday, Feb 18, 2024 at 02:00 UTC")
 */
export function formatScheduledRunTime(date: Date): string {
  return date.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  });
}

/**
 * Check if a scheduled run is overdue
 *
 * @param nextRunAt - Scheduled run time
 * @param now - Current time (defaults to now)
 * @param gracePeriodMinutes - Grace period before considering overdue (default: 5 minutes)
 * @returns true if the scheduled run is overdue
 */
export function isScheduleOverdue(nextRunAt: Date, now: Date = new Date(), gracePeriodMinutes = 5): boolean {
  const overdueThreshold = new Date(nextRunAt.getTime() + gracePeriodMinutes * 60 * 1000);
  return now > overdueThreshold;
}
