import { ToolDefinition } from '../../base/types';

interface MoonPhaseParams {
  date?: string; // YYYY-MM-DD format
  timezone?: string;
}

const PHASE_NAMES = [
  'New Moon',
  'Waxing Crescent',
  'First Quarter',
  'Waxing Gibbous',
  'Full Moon',
  'Waning Gibbous',
  'Last Quarter',
  'Waning Crescent',
];

const PHASE_EMOJIS = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];

// Traditional full moon names by month (Northern Hemisphere)
const FULL_MOON_NAMES: Record<number, string> = {
  1: 'Wolf Moon',
  2: 'Snow Moon',
  3: 'Worm Moon',
  4: 'Pink Moon',
  5: 'Flower Moon',
  6: 'Strawberry Moon',
  7: 'Buck Moon',
  8: 'Sturgeon Moon',
  9: 'Harvest Moon', // or Corn Moon - Harvest Moon is the full moon closest to autumn equinox
  10: "Hunter's Moon",
  11: 'Beaver Moon',
  12: 'Cold Moon',
};

/**
 * Calculate the Julian Date for a given date
 */
const getJulianDate = (date: Date): number => {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate() + date.getHours() / 24 + date.getMinutes() / 1440 + date.getSeconds() / 86400;

  let y = year;
  let m = month;

  if (m <= 2) {
    y -= 1;
    m += 12;
  }

  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);

  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + b - 1524.5;
};

/**
 * Calculate moon age in days (days since last new moon)
 * Uses the synodic month (lunation) of approximately 29.53059 days
 */
const getMoonAge = (date: Date): number => {
  const SYNODIC_MONTH = 29.53059; // Average length of synodic month in days

  // Known new moon: January 6, 2000 at 18:14 UTC
  const knownNewMoon = new Date(Date.UTC(2000, 0, 6, 18, 14, 0));
  const knownNewMoonJD = getJulianDate(knownNewMoon);

  const currentJD = getJulianDate(date);
  const daysSinceKnownNewMoon = currentJD - knownNewMoonJD;

  // Calculate moon age (days into current lunation)
  let moonAge = daysSinceKnownNewMoon % SYNODIC_MONTH;
  if (moonAge < 0) moonAge += SYNODIC_MONTH;

  return moonAge;
};

/**
 * Get moon phase index (0-7) based on moon age
 */
const getPhaseIndex = (moonAge: number): number => {
  const SYNODIC_MONTH = 29.53059;
  const phaseLength = SYNODIC_MONTH / 8;
  return Math.floor(((moonAge + phaseLength / 2) % SYNODIC_MONTH) / phaseLength);
};

/**
 * Calculate illumination percentage
 */
const getIllumination = (moonAge: number): number => {
  const SYNODIC_MONTH = 29.53059;
  // Illumination follows a cosine curve
  const phase = (moonAge / SYNODIC_MONTH) * 2 * Math.PI;
  const illumination = ((1 - Math.cos(phase)) / 2) * 100;
  return Math.round(illumination * 10) / 10;
};

/**
 * Calculate days until next phase
 */
const daysUntilPhase = (moonAge: number, targetPhaseDay: number): number => {
  const SYNODIC_MONTH = 29.53059;
  let days = targetPhaseDay - moonAge;
  if (days < 0) days += SYNODIC_MONTH;
  return Math.round(days * 10) / 10;
};

/**
 * Find the next occurrence of a specific phase
 */
const getNextPhaseDate = (date: Date, targetPhaseDay: number): Date => {
  const moonAge = getMoonAge(date);
  const daysToAdd = daysUntilPhase(moonAge, targetPhaseDay);
  const nextDate = new Date(date.getTime() + daysToAdd * 24 * 60 * 60 * 1000);
  return nextDate;
};

/**
 * Parse date string to Date object
 */
const parseDate = (dateStr?: string): Date => {
  if (!dateStr) {
    return new Date();
  }

  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid date format: ${dateStr}. Please use YYYY-MM-DD format.`);
  }

  const [, year, month, day] = match;
  return new Date(parseInt(year), parseInt(month) - 1, parseInt(day), 12, 0, 0);
};

const getMoonPhase = async (parameters: MoonPhaseParams = {}): Promise<string> => {
  const { date: dateStr, timezone = 'UTC' } = parameters;

  try {
    // Validate timezone
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
    } catch {
      throw new Error(
        `Invalid timezone: ${timezone}. Please use IANA timezone format (e.g., "America/New_York", "Europe/London")`
      );
    }

    const date = parseDate(dateStr);
    const moonAge = getMoonAge(date);
    const phaseIndex = getPhaseIndex(moonAge);
    const phaseName = PHASE_NAMES[phaseIndex];
    const phaseEmoji = PHASE_EMOJIS[phaseIndex];
    const illumination = getIllumination(moonAge);

    const SYNODIC_MONTH = 29.53059;

    // Days until key phases
    const daysToNewMoon = daysUntilPhase(moonAge, 0);
    const daysToFullMoon = daysUntilPhase(moonAge, SYNODIC_MONTH / 2);
    const daysToFirstQuarter = daysUntilPhase(moonAge, SYNODIC_MONTH / 4);
    const daysToLastQuarter = daysUntilPhase(moonAge, (3 * SYNODIC_MONTH) / 4);

    // Get traditional name if it's a full moon
    const month = date.getMonth() + 1;
    const traditionalName = FULL_MOON_NAMES[month];

    // Format date for display
    const dateFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const results: string[] = [];

    results.push(`${phaseEmoji} **${phaseName}**`);
    results.push('');
    results.push(`**Date:** ${dateFormatter.format(date)}`);
    results.push(`**Moon Age:** ${moonAge.toFixed(1)} days into lunar cycle`);
    results.push(`**Illumination:** ${illumination}%`);

    // Special info for full moon
    if (phaseIndex === 4) {
      results.push(`**Traditional Name:** ${traditionalName}`);
    }

    results.push('');
    results.push('**Upcoming Phases:**');

    // Show next phases
    if (daysToNewMoon > 0.5) {
      const nextNewMoon = getNextPhaseDate(date, 0);
      results.push(
        `- 🌑 New Moon: in ${daysToNewMoon.toFixed(1)} days (${nextNewMoon.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`
      );
    }
    if (daysToFirstQuarter > 0.5 && daysToFirstQuarter < SYNODIC_MONTH - 1) {
      const nextFirst = getNextPhaseDate(date, SYNODIC_MONTH / 4);
      results.push(
        `- 🌓 First Quarter: in ${daysToFirstQuarter.toFixed(1)} days (${nextFirst.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`
      );
    }
    if (daysToFullMoon > 0.5) {
      const nextFull = getNextPhaseDate(date, SYNODIC_MONTH / 2);
      const nextMonth = nextFull.getMonth() + 1;
      results.push(
        `- 🌕 Full Moon (${FULL_MOON_NAMES[nextMonth]}): in ${daysToFullMoon.toFixed(1)} days (${nextFull.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`
      );
    }
    if (daysToLastQuarter > 0.5 && daysToLastQuarter < SYNODIC_MONTH - 1) {
      const nextLast = getNextPhaseDate(date, (3 * SYNODIC_MONTH) / 4);
      results.push(
        `- 🌗 Last Quarter: in ${daysToLastQuarter.toFixed(1)} days (${nextLast.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`
      );
    }

    results.push('');
    results.push(`_Lunar cycle: ${SYNODIC_MONTH.toFixed(2)} days (synodic month)_`);

    return results.join('\n');
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to calculate moon phase: ${String(error)}`);
  }
};

export const moonPhaseTool: ToolDefinition = {
  name: 'moon_phase',
  implementation: context => ({
    toolFn: async value => {
      const params = value as MoonPhaseParams;
      context.logger.log('🌙 MoonPhase: Starting execution', params);

      try {
        const result = await getMoonPhase(params);
        context.logger.log('✅ MoonPhase: Execution completed');
        return result;
      } catch (error) {
        context.logger.error('❌ MoonPhase: Execution failed', error);
        throw error;
      }
    },
    toolSchema: {
      name: 'moon_phase',
      description:
        'Get the current moon phase with illumination percentage, moon age, traditional moon names, and upcoming lunar phase predictions. Uses astronomical calculations for accuracy.',
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: 'The date to check moon phase for. Use YYYY-MM-DD format. Defaults to today if not specified.',
          },
          timezone: {
            type: 'string',
            description: 'IANA timezone identifier (e.g., "America/New_York"). Used for date display. Defaults to UTC.',
          },
        },
        additionalProperties: false,
        required: [],
      },
    },
  }),
};
