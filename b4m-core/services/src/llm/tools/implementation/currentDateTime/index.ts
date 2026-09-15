import { ToolDefinition } from '../../base/types';

interface CurrentDateTimeParams {
  timezone?: string;
  format?: 'iso' | 'human' | 'detailed' | 'unix' | 'day_of_year' | 'week_number' | 'julian_day';
  includeTimezone?: boolean;
  includeWeekday?: boolean;
  // Enhanced features
  calculate_until?: string; // Target date for countdown (YYYY-MM-DD format)
  calculate_since?: string; // Target date for elapsed time (YYYY-MM-DD format)
  historical_date?: string; // Get day of week for any historical date (YYYY-MM-DD format)
}

/**
 * Parse a date string in YYYY-MM-DD format
 */
const parseDate = (dateStr: string): Date => {
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid date format: ${dateStr}. Please use YYYY-MM-DD format.`);
  }
  const [, year, month, day] = match;
  return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
};

/**
 * Calculate the day of year (1-366)
 */
const getDayOfYear = (date: Date): number => {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date.getTime() - start.getTime();
  const oneDay = 1000 * 60 * 60 * 24;
  return Math.floor(diff / oneDay);
};

/**
 * Calculate ISO week number (1-53)
 */
const getWeekNumber = (date: Date): number => {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
};

/**
 * Calculate Julian Day Number
 * The Julian Day Number is the count of days since the beginning of the Julian Period (January 1, 4713 BC)
 */
const getJulianDayNumber = (date: Date): number => {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();

  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;

  return (
    day +
    Math.floor((153 * m + 2) / 5) +
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) -
    32045
  );
};

/**
 * Calculate days between two dates
 */
const daysBetween = (date1: Date, date2: Date): number => {
  const oneDay = 1000 * 60 * 60 * 24;
  const diffTime = date2.getTime() - date1.getTime();
  return Math.round(diffTime / oneDay);
};

/**
 * Get day of week name for any date
 */
const getDayOfWeekName = (date: Date): string => {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[date.getDay()];
};

/**
 * Check if a year is a leap year
 */
const isLeapYear = (year: number): boolean => {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
};

const getCurrentDateTime = async (parameters: CurrentDateTimeParams = {}): Promise<string> => {
  const {
    timezone = 'UTC',
    format = 'human',
    includeTimezone = true,
    includeWeekday = true,
    calculate_until,
    calculate_since,
    historical_date,
  } = parameters;

  try {
    const now = new Date();

    // Validate timezone (this will throw if invalid)
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
    } catch {
      throw new Error(
        `Invalid timezone: ${timezone}. Please use IANA timezone format (e.g., "America/New_York", "Europe/London")`
      );
    }

    // Handle historical date query
    if (historical_date) {
      const histDate = parseDate(historical_date);
      const dayName = getDayOfWeekName(histDate);
      const formattedDate = histDate.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      const julianDay = getJulianDayNumber(histDate);
      const dayOfYear = getDayOfYear(histDate);
      const weekNum = getWeekNumber(histDate);
      const leap = isLeapYear(histDate.getFullYear());

      return (
        `${formattedDate} was a ${dayName}.\n` +
        `Day of year: ${dayOfYear}/${leap ? 366 : 365}\n` +
        `Week number: ${weekNum}\n` +
        `Julian Day Number: ${julianDay}`
      );
    }

    // Handle countdown calculation
    if (calculate_until) {
      const targetDate = parseDate(calculate_until);
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const days = daysBetween(today, targetDate);

      if (days < 0) {
        return `${calculate_until} was ${Math.abs(days)} days ago.`;
      } else if (days === 0) {
        return `${calculate_until} is today!`;
      } else {
        const weeks = Math.floor(days / 7);
        const remainingDays = days % 7;
        let result = `${days} days until ${calculate_until}`;
        if (weeks > 0) {
          result += ` (${weeks} week${weeks > 1 ? 's' : ''}`;
          if (remainingDays > 0) {
            result += ` and ${remainingDays} day${remainingDays > 1 ? 's' : ''}`;
          }
          result += ')';
        }
        return result;
      }
    }

    // Handle elapsed time calculation
    if (calculate_since) {
      const startDate = parseDate(calculate_since);
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const days = daysBetween(startDate, today);

      if (days < 0) {
        return `${calculate_since} is ${Math.abs(days)} days in the future.`;
      } else if (days === 0) {
        return `${calculate_since} is today!`;
      } else {
        const years = Math.floor(days / 365.25);
        const remainingDays = Math.round(days % 365.25);
        const weeks = Math.floor(remainingDays / 7);
        const daysLeft = remainingDays % 7;

        let result = `${days.toLocaleString()} days since ${calculate_since}`;
        if (years > 0) {
          result += ` (${years} year${years > 1 ? 's' : ''}`;
          if (remainingDays > 0) {
            result += `, ${remainingDays} day${remainingDays > 1 ? 's' : ''}`;
          }
          result += ')';
        } else if (weeks > 0) {
          result += ` (${weeks} week${weeks > 1 ? 's' : ''}`;
          if (daysLeft > 0) {
            result += ` and ${daysLeft} day${daysLeft > 1 ? 's' : ''}`;
          }
          result += ')';
        }
        return result;
      }
    }

    const formatOptions: Intl.DateTimeFormatOptions = {
      timeZone: timezone,
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      ...(includeWeekday && { weekday: 'long' }),
      ...(includeTimezone && { timeZoneName: 'short' }),
    };

    switch (format) {
      case 'unix':
        return `Unix timestamp: ${Math.floor(now.getTime() / 1000)}`;

      case 'day_of_year': {
        const dayOfYear = getDayOfYear(now);
        const totalDays = isLeapYear(now.getFullYear()) ? 366 : 365;
        const daysRemaining = totalDays - dayOfYear;
        return `Day ${dayOfYear} of ${totalDays} (${daysRemaining} days remaining in ${now.getFullYear()})`;
      }

      case 'week_number': {
        const weekNum = getWeekNumber(now);
        return `Week ${weekNum} of ${now.getFullYear()} (ISO week number)`;
      }

      case 'julian_day': {
        const julianDay = getJulianDayNumber(now);
        return `Julian Day Number: ${julianDay}`;
      }

      case 'iso': {
        // Convert to the specified timezone and return ISO format
        const offset = now.getTimezoneOffset() * 60000;
        const localISOTime = new Date(now.getTime() - offset).toISOString();

        // Get timezone offset for the specified timezone
        const formatter = new Intl.DateTimeFormat('en', {
          timeZone: timezone,
          timeZoneName: 'longOffset',
        });
        const parts = formatter.formatToParts(now);
        const timeZonePart = parts.find(part => part.type === 'timeZoneName');
        const timezoneOffset = timeZonePart?.value || 'Z';

        return `${localISOTime.slice(0, -1)}${timezoneOffset === 'GMT' ? 'Z' : timezoneOffset}`;
      }

      case 'human': {
        const humanFormat = new Intl.DateTimeFormat('en-US', formatOptions);
        return humanFormat.format(now);
      }

      case 'detailed': {
        const detailedFormat = new Intl.DateTimeFormat('en-US', {
          timeZone: timezone,
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZoneName: 'long',
        });
        const formatted = detailedFormat.format(now);
        const dayOfYear = getDayOfYear(now);
        const weekNum = getWeekNumber(now);
        const julianDay = getJulianDayNumber(now);
        const totalDays = isLeapYear(now.getFullYear()) ? 366 : 365;

        return (
          `It's currently ${formatted}\n` +
          `Day ${dayOfYear} of ${totalDays} | Week ${weekNum} | Julian Day ${julianDay}`
        );
      }

      default:
        throw new Error(
          `Unsupported format: ${format}. Supported formats are: iso, human, detailed, unix, day_of_year, week_number, julian_day`
        );
    }
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to get current date/time: ${String(error)}`);
  }
};

export const currentDateTimeTool: ToolDefinition = {
  name: 'current_datetime',
  implementation: context => ({
    toolFn: async value => {
      const params = value as CurrentDateTimeParams;
      context.logger.log('🕒 CurrentDateTime: Starting execution', params);

      try {
        const result = await getCurrentDateTime(params);
        context.logger.log('✅ CurrentDateTime: Execution completed', { result });
        return result;
      } catch (error) {
        context.logger.error('❌ CurrentDateTime: Execution failed', error);
        throw error;
      }
    },
    toolSchema: {
      name: 'current_datetime',
      description:
        'Get the current, real-world date and time, fresh at the moment of the call. Call this whenever you need the current time of day (hour/minute) or to timestamp an action as it executes — never guess or rely on memory. Supports multiple output formats, date calculations (days until/since), historical day lookups, and IANA timezone identifiers.',
      parameters: {
        type: 'object',
        properties: {
          timezone: {
            type: 'string',
            description:
              'IANA timezone identifier (e.g., "America/New_York", "Europe/London", "Asia/Tokyo"). Defaults to UTC if not specified.',
          },
          format: {
            type: 'string',
            description:
              'Output format: iso (ISO 8601), human (readable), detailed (with extra info), unix (Unix timestamp), day_of_year (1-366), week_number (ISO week), julian_day (astronomical)',
            enum: ['iso', 'human', 'detailed', 'unix', 'day_of_year', 'week_number', 'julian_day'],
          },
          includeTimezone: {
            type: 'boolean',
            description: 'Whether to include timezone information in the output. Defaults to true.',
          },
          includeWeekday: {
            type: 'boolean',
            description: 'Whether to include the day of the week in the output. Defaults to true.',
          },
          calculate_until: {
            type: 'string',
            description:
              'Calculate days until a future date. Use YYYY-MM-DD format. Example: "2025-12-25" for Christmas countdown.',
          },
          calculate_since: {
            type: 'string',
            description:
              'Calculate days since a past date. Use YYYY-MM-DD format. Example: "1990-01-15" for "how long since my birthday".',
          },
          historical_date: {
            type: 'string',
            description:
              'Get information about any historical date including day of week, day of year, week number, and Julian Day. Use YYYY-MM-DD format. Example: "1776-07-04".',
          },
        },
        additionalProperties: false,
        required: [],
      },
    },
  }),
};
