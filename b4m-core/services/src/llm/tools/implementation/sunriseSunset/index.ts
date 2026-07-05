import { ToolDefinition } from '../../base/types';

interface SunriseSunsetParams {
  latitude: number;
  longitude: number;
  date?: string; // YYYY-MM-DD format
  timezone?: string;
}

/**
 * Convert degrees to radians
 */
const toRadians = (degrees: number): number => degrees * (Math.PI / 180);

/**
 * Convert radians to degrees
 */
const toDegrees = (radians: number): number => radians * (180 / Math.PI);

/**
 * Calculate Julian Day from date
 */
const getJulianDay = (date: Date): number => {
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
 * Calculate the Julian Century from Julian Day
 */
const getJulianCentury = (julianDay: number): number => {
  return (julianDay - 2451545) / 36525;
};

/**
 * Calculate the sun's geometric mean longitude (degrees)
 */
const getSunMeanLongitude = (julianCentury: number): number => {
  let L0 = 280.46646 + julianCentury * (36000.76983 + 0.0003032 * julianCentury);
  while (L0 > 360) L0 -= 360;
  while (L0 < 0) L0 += 360;
  return L0;
};

/**
 * Calculate the sun's mean anomaly (degrees)
 */
const getSunMeanAnomaly = (julianCentury: number): number => {
  return 357.52911 + julianCentury * (35999.05029 - 0.0001537 * julianCentury);
};

/**
 * Calculate the eccentricity of Earth's orbit
 */
const getEccentricity = (julianCentury: number): number => {
  return 0.016708634 - julianCentury * (0.000042037 + 0.0000001267 * julianCentury);
};

/**
 * Calculate the sun's equation of center
 */
const getSunEquationOfCenter = (julianCentury: number, meanAnomaly: number): number => {
  const M = toRadians(meanAnomaly);
  return (
    Math.sin(M) * (1.914602 - julianCentury * (0.004817 + 0.000014 * julianCentury)) +
    Math.sin(2 * M) * (0.019993 - 0.000101 * julianCentury) +
    Math.sin(3 * M) * 0.000289
  );
};

/**
 * Calculate the sun's true longitude (degrees)
 */
const getSunTrueLongitude = (meanLongitude: number, equationOfCenter: number): number => {
  return meanLongitude + equationOfCenter;
};

/**
 * Calculate the sun's apparent longitude (degrees)
 */
const getSunApparentLongitude = (trueLongitude: number, julianCentury: number): number => {
  const omega = 125.04 - 1934.136 * julianCentury;
  return trueLongitude - 0.00569 - 0.00478 * Math.sin(toRadians(omega));
};

/**
 * Calculate the mean obliquity of the ecliptic (degrees)
 */
const getMeanObliquity = (julianCentury: number): number => {
  const seconds = 21.448 - julianCentury * (46.815 + julianCentury * (0.00059 - julianCentury * 0.001813));
  return 23 + (26 + seconds / 60) / 60;
};

/**
 * Calculate the corrected obliquity of the ecliptic (degrees)
 */
const getObliquityCorrection = (julianCentury: number, meanObliquity: number): number => {
  const omega = 125.04 - 1934.136 * julianCentury;
  return meanObliquity + 0.00256 * Math.cos(toRadians(omega));
};

/**
 * Calculate the sun's declination (degrees)
 */
const getSunDeclination = (obliquityCorrection: number, apparentLongitude: number): number => {
  return toDegrees(Math.asin(Math.sin(toRadians(obliquityCorrection)) * Math.sin(toRadians(apparentLongitude))));
};

/**
 * Calculate the equation of time (minutes)
 */
const getEquationOfTime = (
  julianCentury: number,
  meanLongitude: number,
  eccentricity: number,
  meanAnomaly: number,
  obliquityCorrection: number
): number => {
  const y = Math.tan(toRadians(obliquityCorrection / 2)) ** 2;
  const L0 = toRadians(meanLongitude);
  const e = eccentricity;
  const M = toRadians(meanAnomaly);

  const EoT =
    y * Math.sin(2 * L0) -
    2 * e * Math.sin(M) +
    4 * e * y * Math.sin(M) * Math.cos(2 * L0) -
    0.5 * y * y * Math.sin(4 * L0) -
    1.25 * e * e * Math.sin(2 * M);

  return toDegrees(EoT) * 4; // Convert to minutes
};

/**
 * Calculate the hour angle for sunrise/sunset (degrees)
 */
const getHourAngle = (latitude: number, declination: number, zenith: number): number | null => {
  const latRad = toRadians(latitude);
  const decRad = toRadians(declination);
  const zenithRad = toRadians(zenith);

  const cosHA = Math.cos(zenithRad) / (Math.cos(latRad) * Math.cos(decRad)) - Math.tan(latRad) * Math.tan(decRad);

  if (cosHA > 1 || cosHA < -1) {
    return null; // Sun never rises or sets on this day
  }

  return toDegrees(Math.acos(cosHA));
};

/**
 * Calculate solar noon (minutes from midnight UTC)
 */
const getSolarNoon = (longitude: number, equationOfTime: number): number => {
  return 720 - 4 * longitude - equationOfTime;
};

/**
 * Convert minutes from midnight to time string
 */
const minutesToTime = (minutes: number, timezone: string): string => {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCMinutes(Math.round(minutes));

  return date.toLocaleTimeString('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
  });
};

/**
 * Format duration in hours and minutes
 */
const formatDuration = (minutes: number): string => {
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return `${hours}h ${mins}m`;
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

// Zenith angles for different twilight types
const ZENITH = {
  OFFICIAL: 90.833, // Sunrise/sunset (accounting for refraction)
  CIVIL: 96, // Civil twilight (6 degrees below horizon)
  NAUTICAL: 102, // Nautical twilight (12 degrees below horizon)
  ASTRONOMICAL: 108, // Astronomical twilight (18 degrees below horizon)
  GOLDEN_HOUR: 84, // Golden hour (approximate)
};

const getSunriseSunset = async (parameters: SunriseSunsetParams): Promise<string> => {
  const { latitude, longitude, date: dateStr, timezone = 'UTC' } = parameters;

  // Validate inputs
  if (latitude === undefined || latitude === null) {
    throw new Error('Latitude is required. Please provide a value between -90 and 90.');
  }
  if (longitude === undefined || longitude === null) {
    throw new Error('Longitude is required. Please provide a value between -180 and 180.');
  }
  if (latitude < -90 || latitude > 90) {
    throw new Error(`Invalid latitude: ${latitude}. Must be between -90 and 90.`);
  }
  if (longitude < -180 || longitude > 180) {
    throw new Error(`Invalid longitude: ${longitude}. Must be between -180 and 180.`);
  }

  // Validate timezone
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    throw new Error(
      `Invalid timezone: ${timezone}. Please use IANA timezone format (e.g., "America/New_York", "Europe/London")`
    );
  }

  const date = parseDate(dateStr);
  const julianDay = getJulianDay(date);
  const julianCentury = getJulianCentury(julianDay);

  // Calculate solar parameters
  const meanLongitude = getSunMeanLongitude(julianCentury);
  const meanAnomaly = getSunMeanAnomaly(julianCentury);
  const eccentricity = getEccentricity(julianCentury);
  const equationOfCenter = getSunEquationOfCenter(julianCentury, meanAnomaly);
  const trueLongitude = getSunTrueLongitude(meanLongitude, equationOfCenter);
  const apparentLongitude = getSunApparentLongitude(trueLongitude, julianCentury);
  const meanObliquity = getMeanObliquity(julianCentury);
  const obliquityCorrection = getObliquityCorrection(julianCentury, meanObliquity);
  const declination = getSunDeclination(obliquityCorrection, apparentLongitude);
  const equationOfTime = getEquationOfTime(
    julianCentury,
    meanLongitude,
    eccentricity,
    meanAnomaly,
    obliquityCorrection
  );

  const solarNoon = getSolarNoon(longitude, equationOfTime);

  // Calculate times for different events
  const calculateTime = (zenith: number, isSunrise: boolean): string | null => {
    const hourAngle = getHourAngle(latitude, declination, zenith);
    if (hourAngle === null) return null;
    const minutes = solarNoon + (isSunrise ? -hourAngle : hourAngle) * 4;
    return minutesToTime(minutes, timezone);
  };

  const sunrise = calculateTime(ZENITH.OFFICIAL, true);
  const sunset = calculateTime(ZENITH.OFFICIAL, false);
  const civilDawn = calculateTime(ZENITH.CIVIL, true);
  const civilDusk = calculateTime(ZENITH.CIVIL, false);
  const nauticalDawn = calculateTime(ZENITH.NAUTICAL, true);
  const nauticalDusk = calculateTime(ZENITH.NAUTICAL, false);
  const astroDawn = calculateTime(ZENITH.ASTRONOMICAL, true);
  const astroDusk = calculateTime(ZENITH.ASTRONOMICAL, false);
  const goldenHourMorningEnd = calculateTime(ZENITH.GOLDEN_HOUR, true);
  const goldenHourEveningStart = calculateTime(ZENITH.GOLDEN_HOUR, false);

  // Calculate day length
  const sunriseHA = getHourAngle(latitude, declination, ZENITH.OFFICIAL);
  const dayLength = sunriseHA !== null ? sunriseHA * 8 : null; // minutes of daylight

  // Calculate day length change (compare to yesterday)
  const yesterdayDate = new Date(date);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterdayJD = getJulianDay(yesterdayDate);
  const yesterdayJC = getJulianCentury(yesterdayJD);
  const yesterdayML = getSunMeanLongitude(yesterdayJC);
  const yesterdayMA = getSunMeanAnomaly(yesterdayJC);
  const yesterdayEOC = getSunEquationOfCenter(yesterdayJC, yesterdayMA);
  const yesterdayTL = getSunTrueLongitude(yesterdayML, yesterdayEOC);
  const yesterdayAL = getSunApparentLongitude(yesterdayTL, yesterdayJC);
  const yesterdayMO = getMeanObliquity(yesterdayJC);
  const yesterdayOC = getObliquityCorrection(yesterdayJC, yesterdayMO);
  const yesterdayDec = getSunDeclination(yesterdayOC, yesterdayAL);
  const yesterdayHA = getHourAngle(latitude, yesterdayDec, ZENITH.OFFICIAL);
  const yesterdayDayLength = yesterdayHA !== null ? yesterdayHA * 8 : null;

  let dayLengthChange: number | null = null;
  let changingDirection: string | null = null;
  if (dayLength !== null && yesterdayDayLength !== null) {
    dayLengthChange = dayLength - yesterdayDayLength;
    changingDirection = dayLengthChange > 0 ? 'longer' : 'shorter';
  }

  // Format date for display
  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const results: string[] = [];
  results.push(`**Sun Times for ${dateFormatter.format(date)}**`);
  results.push(
    `📍 Location: ${Math.abs(latitude).toFixed(4)}°${latitude >= 0 ? 'N' : 'S'}, ${Math.abs(longitude).toFixed(4)}°${longitude >= 0 ? 'E' : 'W'}`
  );
  results.push('');

  // Check for polar conditions
  if (!sunrise || !sunset) {
    if (declination > 0 && latitude > 66.5) {
      results.push('☀️ **Midnight Sun** - The sun does not set at this latitude today.');
    } else if (declination < 0 && latitude < -66.5) {
      results.push('☀️ **Midnight Sun** - The sun does not set at this latitude today.');
    } else if (declination < 0 && latitude > 66.5) {
      results.push('🌑 **Polar Night** - The sun does not rise at this latitude today.');
    } else if (declination > 0 && latitude < -66.5) {
      results.push('🌑 **Polar Night** - The sun does not rise at this latitude today.');
    }
    return results.join('\n');
  }

  results.push('**Main Events:**');
  results.push(`- 🌅 Sunrise: ${sunrise}`);
  results.push(`- ☀️ Solar Noon: ${minutesToTime(solarNoon, timezone)}`);
  results.push(`- 🌇 Sunset: ${sunset}`);

  if (dayLength !== null) {
    results.push(`- ⏱️ Day Length: ${formatDuration(dayLength)}`);
    if (dayLengthChange !== null && Math.abs(dayLengthChange) >= 0.1) {
      const changeSeconds = Math.round(Math.abs(dayLengthChange) * 60);
      results.push(
        `  _(Days are getting ${changingDirection} by ~${Math.floor(changeSeconds / 60)}m ${changeSeconds % 60}s)_`
      );
    }
  }

  results.push('');
  results.push('**Twilight Periods:**');
  if (astroDawn) results.push(`- 🌌 Astronomical Dawn: ${astroDawn}`);
  if (nauticalDawn) results.push(`- 🌊 Nautical Dawn: ${nauticalDawn}`);
  if (civilDawn) results.push(`- 🏙️ Civil Dawn: ${civilDawn}`);
  if (civilDusk) results.push(`- 🏙️ Civil Dusk: ${civilDusk}`);
  if (nauticalDusk) results.push(`- 🌊 Nautical Dusk: ${nauticalDusk}`);
  if (astroDusk) results.push(`- 🌌 Astronomical Dusk: ${astroDusk}`);

  results.push('');
  results.push('**Golden Hour (Photography):**');
  if (sunrise && goldenHourMorningEnd) {
    results.push(`- 📸 Morning: ${sunrise} - ${goldenHourMorningEnd}`);
  }
  if (goldenHourEveningStart && sunset) {
    results.push(`- 📸 Evening: ${goldenHourEveningStart} - ${sunset}`);
  }

  return results.join('\n');
};

export const sunriseSunsetTool: ToolDefinition = {
  name: 'sunrise_sunset',
  implementation: context => ({
    toolFn: async value => {
      const params = value as SunriseSunsetParams;
      context.logger.log('🌅 SunriseSunset: Starting execution', params);

      try {
        const result = await getSunriseSunset(params);
        context.logger.log('✅ SunriseSunset: Execution completed');
        return result;
      } catch (error) {
        context.logger.error('❌ SunriseSunset: Execution failed', error);
        throw error;
      }
    },
    toolSchema: {
      name: 'sunrise_sunset',
      description:
        'Calculate sunrise, sunset, twilight times, golden hour, and day length for any location. Uses NOAA solar calculations for accuracy. Also shows how day length is changing (getting longer or shorter).',
      parameters: {
        type: 'object',
        properties: {
          latitude: {
            type: 'number',
            description:
              'Latitude in decimal degrees (-90 to 90). Positive for North, negative for South. Example: 40.7128 for New York City.',
          },
          longitude: {
            type: 'number',
            description:
              'Longitude in decimal degrees (-180 to 180). Positive for East, negative for West. Example: -74.0060 for New York City.',
          },
          date: {
            type: 'string',
            description: 'The date to calculate for. Use YYYY-MM-DD format. Defaults to today if not specified.',
          },
          timezone: {
            type: 'string',
            description: 'IANA timezone identifier for time display (e.g., "America/New_York"). Defaults to UTC.',
          },
        },
        additionalProperties: false,
        required: ['latitude', 'longitude'],
      },
    },
  }),
};
