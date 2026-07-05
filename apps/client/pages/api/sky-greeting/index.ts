import type { NextApiRequest, NextApiResponse } from 'next';

// Moon phase calculation (simplified from moonPhase tool)
const SYNODIC_MONTH = 29.53059;
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
const FULL_MOON_NAMES: Record<number, string> = {
  1: 'Wolf Moon',
  2: 'Snow Moon',
  3: 'Worm Moon',
  4: 'Pink Moon',
  5: 'Flower Moon',
  6: 'Strawberry Moon',
  7: 'Buck Moon',
  8: 'Sturgeon Moon',
  9: 'Harvest Moon',
  10: "Hunter's Moon",
  11: 'Beaver Moon',
  12: 'Cold Moon',
};

const getJulianDate = (date: Date): number => {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate() + date.getHours() / 24 + date.getMinutes() / 1440;
  let y = year,
    m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + b - 1524.5;
};

const getMoonAge = (date: Date): number => {
  const knownNewMoon = new Date(Date.UTC(2000, 0, 6, 18, 14, 0));
  const daysSince = getJulianDate(date) - getJulianDate(knownNewMoon);
  let moonAge = daysSince % SYNODIC_MONTH;
  if (moonAge < 0) moonAge += SYNODIC_MONTH;
  return moonAge;
};

const getMoonPhaseInfo = () => {
  const now = new Date();
  const moonAge = getMoonAge(now);
  const phaseLength = SYNODIC_MONTH / 8;
  const phaseIndex = Math.floor(((moonAge + phaseLength / 2) % SYNODIC_MONTH) / phaseLength);
  const illumination = Math.round(((1 - Math.cos((moonAge / SYNODIC_MONTH) * 2 * Math.PI)) / 2) * 100);

  // Days until full moon
  const fullMoonDay = SYNODIC_MONTH / 2;
  let daysToFull = fullMoonDay - moonAge;
  if (daysToFull < 0) daysToFull += SYNODIC_MONTH;

  const nextMonth = daysToFull > 0 ? now.getMonth() + 1 : now.getMonth() + 2;
  const adjustedMonth = ((nextMonth - 1) % 12) + 1;

  return {
    phase: PHASE_NAMES[phaseIndex],
    emoji: PHASE_EMOJIS[phaseIndex],
    illumination,
    daysToFullMoon: Math.round(daysToFull * 10) / 10,
    nextFullMoonName: FULL_MOON_NAMES[adjustedMonth],
  };
};

// Simplified planet visibility (just show what's generally up in evening sky)
const getPlanetHighlight = () => {
  // This is a simplified version - the full tool does precise calculations
  // For the greeting, we'll show seasonal highlights
  const month = new Date().getMonth() + 1;

  // Winter evening sky (Dec-Feb): Jupiter and Saturn dominate
  // Spring (Mar-May): Mars and Saturn in morning
  // Summer (Jun-Aug): Saturn visible, Mars rising
  // Fall (Sep-Nov): Jupiter rises, Saturn sets

  const highlights: Record<number, string> = {
    1: 'Jupiter bright in the evening sky',
    2: 'Jupiter and Venus dance at dusk',
    3: 'Venus blazes as evening star',
    4: 'Mars climbs higher each night',
    5: 'Saturn rises before midnight',
    6: 'Saturn rules the summer nights',
    7: 'Jupiter returns to morning sky',
    8: 'Saturn at its best all night',
    9: 'Jupiter rises in the east',
    10: 'Jupiter dominates the night',
    11: 'Jupiter at its brightest',
    12: 'Jupiter and Saturn evening show',
  };

  return highlights[month] || 'Planets wander among the stars';
};

// Wikipedia On This Day - fetch a single interesting fact
const getOnThisDayFact = async (): Promise<string | null> => {
  try {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');

    // Add timeout protection for Wikipedia API
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout

    const brand = process.env.APP_NAME || '';
    const websiteUrl = process.env.WEBSITE_URL || '';
    let response: Response;
    try {
      response = await fetch(`https://en.wikipedia.org/api/rest_v1/feed/onthisday/selected/${month}/${day}`, {
        headers: {
          Accept: 'application/json',
          'User-Agent': `${brand || 'App'}/1.0${websiteUrl ? ` (${websiteUrl})` : ''}`,
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (fetchError) {
      clearTimeout(timeoutId);
      // Timeout or network error - return null (non-critical feature)
      return null;
    }

    if (!response.ok) return null;

    const data = await response.json();
    const events = data.selected || [];

    if (events.length === 0) return null;

    // Pick a random interesting event
    const event = events[Math.floor(Math.random() * Math.min(events.length, 5))];
    return `In ${event.year}: ${event.text}`;
  } catch (error) {
    console.error('Failed to fetch On This Day:', error);
    return null;
  }
};

export interface SkyGreetingResponse {
  moon: {
    phase: string;
    emoji: string;
    illumination: number;
    daysToFullMoon: number;
    nextFullMoonName: string;
  };
  planet: string;
  onThisDay: string | null;
  timestamp: string;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<SkyGreetingResponse | { error: string }>
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const [moonInfo, onThisDayFact] = await Promise.all([Promise.resolve(getMoonPhaseInfo()), getOnThisDayFact()]);

    const planetHighlight = getPlanetHighlight();

    res.status(200).json({
      moon: moonInfo,
      planet: planetHighlight,
      onThisDay: onThisDayFact,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Sky greeting error:', error);
    res.status(500).json({ error: 'Failed to generate sky greeting' });
  }
}
