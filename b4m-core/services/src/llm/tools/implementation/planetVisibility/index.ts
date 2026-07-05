import { ToolDefinition } from '../../base/types';

interface PlanetVisibilityParams {
  latitude: number;
  longitude: number;
  date?: string; // YYYY-MM-DD format
  timezone?: string;
}

// Orbital elements for the naked-eye planets (J2000.0 epoch)
// These are simplified elements for approximate calculations
interface OrbitalElements {
  name: string;
  symbol: string;
  a: number; // Semi-major axis (AU)
  e: number; // Eccentricity
  i: number; // Inclination (degrees)
  L: number; // Mean longitude at epoch (degrees)
  longPeri: number; // Longitude of perihelion (degrees)
  longNode: number; // Longitude of ascending node (degrees)
  // Rates per century
  aRate: number;
  eRate: number;
  iRate: number;
  LRate: number;
  longPeriRate: number;
  longNodeRate: number;
  // Visual properties
  maxMagnitude: number; // Brightest apparent magnitude
  color: string;
}

const PLANETS: OrbitalElements[] = [
  {
    name: 'Mercury',
    symbol: '☿',
    a: 0.38709927,
    e: 0.20563593,
    i: 7.00497902,
    L: 252.2503235,
    longPeri: 77.45779628,
    longNode: 48.33076593,
    aRate: 0.00000037,
    eRate: 0.00001906,
    iRate: -0.00594749,
    LRate: 149472.67411175,
    longPeriRate: 0.16047689,
    longNodeRate: -0.12534081,
    maxMagnitude: -1.9,
    color: 'gray',
  },
  {
    name: 'Venus',
    symbol: '♀',
    a: 0.72333566,
    e: 0.00677672,
    i: 3.39467605,
    L: 181.9790995,
    longPeri: 131.60246718,
    longNode: 76.67984255,
    aRate: 0.0000039,
    eRate: -0.00004107,
    iRate: -0.0007889,
    LRate: 58517.81538729,
    longPeriRate: 0.00268329,
    longNodeRate: -0.27769418,
    maxMagnitude: -4.6,
    color: 'white',
  },
  {
    name: 'Mars',
    symbol: '♂',
    a: 1.52371034,
    e: 0.0933941,
    i: 1.84969142,
    L: -4.55343205,
    longPeri: -23.94362959,
    longNode: 49.55953891,
    aRate: 0.00001847,
    eRate: 0.00007882,
    iRate: -0.00813131,
    LRate: 19140.30268499,
    longPeriRate: 0.44441088,
    longNodeRate: -0.29257343,
    maxMagnitude: -2.9,
    color: 'red',
  },
  {
    name: 'Jupiter',
    symbol: '♃',
    a: 5.202887,
    e: 0.04838624,
    i: 1.30439695,
    L: 34.39644051,
    longPeri: 14.72847983,
    longNode: 100.47390909,
    aRate: -0.00011607,
    eRate: -0.00013253,
    iRate: -0.00183714,
    LRate: 3034.74612775,
    longPeriRate: 0.21252668,
    longNodeRate: 0.20469106,
    maxMagnitude: -2.9,
    color: 'orange',
  },
  {
    name: 'Saturn',
    symbol: '♄',
    a: 9.53667594,
    e: 0.05386179,
    i: 2.48599187,
    L: 49.95424423,
    longPeri: 92.59887831,
    longNode: 113.66242448,
    aRate: -0.0012506,
    eRate: -0.00050991,
    iRate: 0.00193609,
    LRate: 1222.49362201,
    longPeriRate: -0.41897216,
    longNodeRate: -0.28867794,
    maxMagnitude: -0.5,
    color: 'gold',
  },
];

// Earth's orbital elements for reference
const EARTH = {
  a: 1.00000261,
  e: 0.01671123,
  i: -0.00001531,
  L: 100.46457166,
  longPeri: 102.93768193,
  longNode: 0,
  aRate: 0.00000562,
  eRate: -0.00004392,
  iRate: -0.01294668,
  LRate: 35999.37244981,
  longPeriRate: 0.32327364,
  longNodeRate: 0,
};

const toRadians = (deg: number): number => deg * (Math.PI / 180);
const toDegrees = (rad: number): number => rad * (180 / Math.PI);
const normalizeAngle = (deg: number): number => ((deg % 360) + 360) % 360;

/**
 * Calculate Julian Day from date
 */
const getJulianDay = (date: Date): number => {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate() + date.getHours() / 24;

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
 * Calculate Julian centuries from J2000.0
 */
const getJulianCenturies = (jd: number): number => (jd - 2451545.0) / 36525;

/**
 * Calculate heliocentric coordinates of a planet
 */
const getHeliocentricCoords = (
  planet: OrbitalElements | typeof EARTH,
  T: number
): { x: number; y: number; z: number; r: number } => {
  // Current orbital elements
  const a = planet.a + planet.aRate * T;
  const e = planet.e + planet.eRate * T;
  const i = toRadians(planet.i + planet.iRate * T);
  const L = normalizeAngle(planet.L + planet.LRate * T);
  const longPeri = normalizeAngle(planet.longPeri + planet.longPeriRate * T);
  const longNode = toRadians(planet.longNode + planet.longNodeRate * T);

  // Mean anomaly
  const M = toRadians(normalizeAngle(L - longPeri));

  // Eccentric anomaly (Newton-Raphson iteration)
  let E = M;
  for (let iter = 0; iter < 10; iter++) {
    E = M + e * Math.sin(E);
  }

  // True anomaly and radius
  const xv = a * (Math.cos(E) - e);
  const yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const r = Math.sqrt(xv * xv + yv * yv);
  const v = Math.atan2(yv, xv);

  // Heliocentric coordinates in ecliptic plane
  const omega = toRadians(longPeri) - longNode;
  const cosOmega = Math.cos(omega + v);
  const sinOmega = Math.sin(omega + v);
  const cosI = Math.cos(i);
  const sinI = Math.sin(i);
  const cosNode = Math.cos(longNode);
  const sinNode = Math.sin(longNode);

  const x = r * (cosNode * cosOmega - sinNode * sinOmega * cosI);
  const y = r * (sinNode * cosOmega + cosNode * sinOmega * cosI);
  const z = r * sinOmega * sinI;

  return { x, y, z, r };
};

/**
 * Calculate geocentric ecliptic coordinates
 */
const getGeocentricEcliptic = (
  planet: { x: number; y: number; z: number },
  earth: { x: number; y: number; z: number }
): { lon: number; lat: number; dist: number } => {
  const dx = planet.x - earth.x;
  const dy = planet.y - earth.y;
  const dz = planet.z - earth.z;

  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const lon = normalizeAngle(toDegrees(Math.atan2(dy, dx)));
  const lat = toDegrees(Math.asin(dz / dist));

  return { lon, lat, dist };
};

/**
 * Calculate right ascension and declination from ecliptic coordinates
 */
const eclipticToEquatorial = (lon: number, lat: number, obliquity: number): { ra: number; dec: number } => {
  const lonRad = toRadians(lon);
  const latRad = toRadians(lat);
  const oblRad = toRadians(obliquity);

  const sinDec = Math.sin(latRad) * Math.cos(oblRad) + Math.cos(latRad) * Math.sin(oblRad) * Math.sin(lonRad);
  const dec = toDegrees(Math.asin(sinDec));

  const y = Math.sin(lonRad) * Math.cos(oblRad) - Math.tan(latRad) * Math.sin(oblRad);
  const x = Math.cos(lonRad);
  const ra = normalizeAngle(toDegrees(Math.atan2(y, x)));

  return { ra, dec };
};

/**
 * Calculate local sidereal time
 */
const getLocalSiderealTime = (jd: number, longitude: number): number => {
  const T = (jd - 2451545.0) / 36525;
  let GST = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T;
  GST = normalizeAngle(GST);
  return normalizeAngle(GST + longitude);
};

/**
 * Calculate altitude and azimuth
 */
const getAltAz = (ra: number, dec: number, lat: number, lst: number): { alt: number; az: number } => {
  const ha = toRadians(normalizeAngle(lst - ra));
  const decRad = toRadians(dec);
  const latRad = toRadians(lat);

  const sinAlt = Math.sin(decRad) * Math.sin(latRad) + Math.cos(decRad) * Math.cos(latRad) * Math.cos(ha);
  const alt = toDegrees(Math.asin(sinAlt));

  const cosA = (Math.sin(decRad) - Math.sin(latRad) * sinAlt) / (Math.cos(latRad) * Math.cos(toRadians(alt)));
  let az = toDegrees(Math.acos(Math.max(-1, Math.min(1, cosA))));
  if (Math.sin(ha) > 0) az = 360 - az;

  return { alt, az };
};

/**
 * Calculate approximate rise/set times
 */
const getRiseSetTimes = (
  ra: number,
  dec: number,
  lat: number,
  lon: number,
  jd: number
): { rises: boolean; sets: boolean; riseTime?: number; setTime?: number; transitTime: number } => {
  const latRad = toRadians(lat);
  const decRad = toRadians(dec);

  // Hour angle at rise/set (horizon + refraction)
  const h0 = toRadians(-0.5667); // Standard altitude for rise/set
  const cosH = (Math.sin(h0) - Math.sin(latRad) * Math.sin(decRad)) / (Math.cos(latRad) * Math.cos(decRad));

  // Transit time (when object crosses meridian)
  const lst0 = getLocalSiderealTime(Math.floor(jd) + 0.5, lon);
  let transitTime = (ra - lst0) / 15;
  if (transitTime < 0) transitTime += 24;
  if (transitTime > 24) transitTime -= 24;

  if (cosH > 1) {
    // Never rises (circumpolar below horizon)
    return { rises: false, sets: false, transitTime };
  } else if (cosH < -1) {
    // Never sets (circumpolar above horizon)
    return { rises: true, sets: true, transitTime };
  }

  const H = toDegrees(Math.acos(cosH)) / 15; // Hour angle in hours
  let riseTime = transitTime - H;
  let setTime = transitTime + H;

  if (riseTime < 0) riseTime += 24;
  if (setTime > 24) setTime -= 24;

  return { rises: true, sets: true, riseTime, setTime, transitTime };
};

/**
 * Calculate elongation from sun
 */
const getElongation = (planetLon: number, sunLon: number): number => {
  let elong = planetLon - sunLon;
  if (elong > 180) elong -= 360;
  if (elong < -180) elong += 360;
  return elong;
};

/**
 * Format time from decimal hours
 */
const formatTime = (hours: number, timezone: string): string => {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  const date = new Date();
  date.setUTCHours(h, m, 0, 0);
  return date.toLocaleTimeString('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' });
};

/**
 * Get direction name from azimuth
 */
const getDirection = (az: number): string => {
  const directions = [
    'N',
    'NNE',
    'NE',
    'ENE',
    'E',
    'ESE',
    'SE',
    'SSE',
    'S',
    'SSW',
    'SW',
    'WSW',
    'W',
    'WNW',
    'NW',
    'NNW',
  ];
  const index = Math.round(az / 22.5) % 16;
  return directions[index];
};

/**
 * Get visibility description
 */
const getVisibilityDescription = (
  elongation: number,
  altitude: number,
  isSuperior: boolean
): { quality: string; description: string } => {
  const absElong = Math.abs(elongation);

  if (altitude < 0) {
    return { quality: 'Not visible', description: 'Below horizon' };
  }

  if (altitude < 10) {
    return { quality: 'Poor', description: 'Very low in sky, atmospheric interference' };
  }

  if (isSuperior) {
    // Mars, Jupiter, Saturn
    if (absElong > 120) {
      return { quality: 'Excellent', description: 'Near opposition, visible most of the night' };
    } else if (absElong > 90) {
      return { quality: 'Good', description: 'Well placed for evening/morning viewing' };
    } else if (absElong > 45) {
      return { quality: 'Fair', description: 'Visible but not optimally placed' };
    } else {
      return { quality: 'Poor', description: 'Too close to Sun' };
    }
  } else {
    // Mercury, Venus (inferior planets)
    if (absElong > 40) {
      return { quality: 'Excellent', description: 'Near greatest elongation' };
    } else if (absElong > 20) {
      return { quality: 'Good', description: 'Well separated from Sun' };
    } else if (absElong > 10) {
      return { quality: 'Fair', description: 'Low in twilight' };
    } else {
      return { quality: 'Poor', description: 'Too close to Sun' };
    }
  }
};

const getPlanetVisibility = async (parameters: PlanetVisibilityParams): Promise<string> => {
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
    throw new Error(`Invalid timezone: ${timezone}. Please use IANA timezone format.`);
  }

  // Parse date
  let date: Date;
  if (dateStr) {
    const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) throw new Error(`Invalid date format: ${dateStr}. Use YYYY-MM-DD.`);
    date = new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]), 12, 0, 0);
  } else {
    date = new Date();
  }

  const jd = getJulianDay(date);
  const T = getJulianCenturies(jd);
  const obliquity = 23.439 - 0.00000036 * (jd - 2451545.0);

  // Calculate Earth's position
  const earthHelio = getHeliocentricCoords(EARTH, T);

  // Calculate Sun's geocentric position (opposite of Earth's heliocentric)
  const sunLon = normalizeAngle(toDegrees(Math.atan2(-earthHelio.y, -earthHelio.x)));

  const results: string[] = [];
  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  results.push(`🪐 **Planet Visibility for ${dateFormatter.format(date)}**`);
  results.push(
    `📍 ${Math.abs(latitude).toFixed(2)}°${latitude >= 0 ? 'N' : 'S'}, ${Math.abs(longitude).toFixed(2)}°${longitude >= 0 ? 'E' : 'W'}`
  );
  results.push('');

  const planetData: Array<{
    name: string;
    symbol: string;
    color: string;
    altitude: number;
    azimuth: number;
    elongation: number;
    visibility: { quality: string; description: string };
    riseSet: ReturnType<typeof getRiseSetTimes>;
    isSuperior: boolean;
  }> = [];

  // Calculate data for each planet
  for (const planet of PLANETS) {
    const helio = getHeliocentricCoords(planet, T);
    const geo = getGeocentricEcliptic(helio, earthHelio);
    const equatorial = eclipticToEquatorial(geo.lon, geo.lat, obliquity);
    const lst = getLocalSiderealTime(jd, longitude);
    const altAz = getAltAz(equatorial.ra, equatorial.dec, latitude, lst);
    const elongation = getElongation(geo.lon, sunLon);
    const isSuperior = planet.a > 1; // Mars, Jupiter, Saturn
    const visibility = getVisibilityDescription(elongation, altAz.alt, isSuperior);
    const riseSet = getRiseSetTimes(equatorial.ra, equatorial.dec, latitude, longitude, jd);

    planetData.push({
      name: planet.name,
      symbol: planet.symbol,
      color: planet.color,
      altitude: altAz.alt,
      azimuth: altAz.az,
      elongation,
      visibility,
      riseSet,
      isSuperior,
    });
  }

  // Sort by visibility quality and altitude
  const visiblePlanets = planetData.filter(
    p => p.visibility.quality !== 'Not visible' && p.visibility.quality !== 'Poor'
  );
  const notVisiblePlanets = planetData.filter(
    p => p.visibility.quality === 'Not visible' || p.visibility.quality === 'Poor'
  );

  if (visiblePlanets.length > 0) {
    results.push('**Currently Visible Planets:**');
    results.push('');

    for (const p of visiblePlanets.sort((a, b) => b.altitude - a.altitude)) {
      const emoji =
        p.name === 'Jupiter'
          ? '🟠'
          : p.name === 'Saturn'
            ? '🟡'
            : p.name === 'Mars'
              ? '🔴'
              : p.name === 'Venus'
                ? '⚪'
                : '⚫';
      results.push(`${emoji} **${p.name}** ${p.symbol}`);
      results.push(`   Visibility: ${p.visibility.quality} - ${p.visibility.description}`);

      if (p.altitude > 0) {
        results.push(
          `   Current position: ${p.altitude.toFixed(1)}° altitude, ${getDirection(p.azimuth)} (${p.azimuth.toFixed(0)}°)`
        );
      }

      if (p.riseSet.riseTime !== undefined) {
        results.push(
          `   Rises: ${formatTime(p.riseSet.riseTime, timezone)} | Transit: ${formatTime(p.riseSet.transitTime, timezone)} | Sets: ${formatTime(p.riseSet.setTime!, timezone)}`
        );
      }

      // Special notes based on elongation
      if (p.isSuperior) {
        if (Math.abs(p.elongation) > 150) {
          results.push(`   ⭐ Near opposition! Best time to observe - visible all night`);
        } else if (p.elongation > 90) {
          results.push(`   Evening sky - visible after sunset`);
        } else if (p.elongation < -90) {
          results.push(`   Morning sky - visible before sunrise`);
        }
      } else {
        if (p.elongation > 0) {
          results.push(`   Evening star - look west after sunset`);
        } else {
          results.push(`   Morning star - look east before sunrise`);
        }
      }
      results.push('');
    }
  } else {
    results.push('_No planets are well-positioned for viewing tonight._');
    results.push('');
  }

  // Check for close conjunctions
  const conjunctions: string[] = [];
  for (let i = 0; i < planetData.length; i++) {
    for (let j = i + 1; j < planetData.length; j++) {
      const p1 = planetData[i];
      const p2 = planetData[j];
      const separation = Math.sqrt(
        Math.pow(p1.altitude - p2.altitude, 2) +
          Math.pow((p1.azimuth - p2.azimuth) * Math.cos(toRadians(p1.altitude)), 2)
      );
      if (separation < 10 && p1.altitude > 0 && p2.altitude > 0) {
        conjunctions.push(`${p1.name} and ${p2.name} are close together (${separation.toFixed(1)}° apart)`);
      }
    }
  }

  if (conjunctions.length > 0) {
    results.push('**Planetary Conjunctions:**');
    conjunctions.forEach(c => results.push(`- ${c}`));
    results.push('');
  }

  // Planets not well visible
  if (notVisiblePlanets.length > 0) {
    results.push('**Not Currently Visible:**');
    for (const p of notVisiblePlanets) {
      results.push(`- ${p.symbol} ${p.name}: ${p.visibility.description}`);
    }
  }

  results.push('');
  results.push('_Naked-eye planets: Mercury, Venus, Mars, Jupiter, Saturn_');

  return results.join('\n');
};

export const planetVisibilityTool: ToolDefinition = {
  name: 'planet_visibility',
  implementation: context => ({
    toolFn: async value => {
      const params = value as PlanetVisibilityParams;
      context.logger.log('🪐 PlanetVisibility: Starting execution', params);

      try {
        const result = await getPlanetVisibility(params);
        context.logger.log('✅ PlanetVisibility: Execution completed');
        return result;
      } catch (error) {
        context.logger.error('❌ PlanetVisibility: Execution failed', error);
        throw error;
      }
    },
    toolSchema: {
      name: 'planet_visibility',
      description:
        'Get visibility information for the 5 naked-eye planets (Mercury, Venus, Mars, Jupiter, Saturn). Shows which planets are visible tonight, their positions, rise/set times, and any planetary conjunctions.',
      parameters: {
        type: 'object',
        properties: {
          latitude: {
            type: 'number',
            description: 'Latitude in decimal degrees (-90 to 90). Example: 40.7128 for New York City.',
          },
          longitude: {
            type: 'number',
            description: 'Longitude in decimal degrees (-180 to 180). Example: -74.0060 for New York City.',
          },
          date: {
            type: 'string',
            description: 'The date to check. Use YYYY-MM-DD format. Defaults to today if not specified.',
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
