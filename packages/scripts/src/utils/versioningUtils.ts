/**
 * Versioning utilities for CalVer-based production releases
 * Format: vYYYY.MM.DD.N where N is the daily deployment counter
 */

interface CalVerComponents {
  year: number;
  month: number;
  day: number;
  counter: number;
}

/**
 * Parse a CalVer tag into its components
 * @param tag - Git tag in format v2025.01.14.3
 * @returns Parsed components or null if invalid
 */
export function parseCalVer(tag: string): CalVerComponents | null {
  const match = tag.match(/^v(\d{4})\.(\d{2})\.(\d{2})\.(\d+)$/);
  if (!match) return null;

  return {
    year: parseInt(match[1], 10),
    month: parseInt(match[2], 10),
    day: parseInt(match[3], 10),
    counter: parseInt(match[4], 10),
  };
}

/**
 * Generate the next CalVer version based on the latest tag
 * @param latestTag - Latest production tag (or null for first release)
 * @param deploymentDate - Date of deployment (defaults to now)
 * @returns Next version tag
 */
export function getNextVersion(latestTag: string | null, deploymentDate: Date = new Date()): string {
  const year = deploymentDate.getFullYear();
  const month = String(deploymentDate.getMonth() + 1).padStart(2, '0');
  const day = String(deploymentDate.getDate()).padStart(2, '0');

  // First release ever
  if (!latestTag) {
    return `v${year}.${month}.${day}.1`;
  }

  const parsed = parseCalVer(latestTag);

  // Invalid tag format, start fresh
  if (!parsed) {
    return `v${year}.${month}.${day}.1`;
  }

  // Same day as previous release - increment counter
  const latestYear = parsed.year;
  const latestMonth = String(parsed.month).padStart(2, '0');
  const latestDay = String(parsed.day).padStart(2, '0');

  if (year === latestYear && month === latestMonth && day === latestDay) {
    return `v${year}.${month}.${day}.${parsed.counter + 1}`;
  }

  // New day - reset counter to 1
  return `v${year}.${month}.${day}.1`;
}

/**
 * Calculate the deployment number for today
 * @param latestTag - Latest production tag
 * @param deploymentDate - Date of deployment (defaults to now)
 * @returns Deployment number for the day (e.g., 3 for "Deploy #3 today")
 */
export function getDailyDeploymentNumber(latestTag: string | null, deploymentDate: Date = new Date()): number {
  const nextVersion = getNextVersion(latestTag, deploymentDate);
  const parsed = parseCalVer(nextVersion);
  return parsed?.counter ?? 1;
}

/**
 * Validate that a tag follows CalVer format
 * @param tag - Tag to validate
 * @returns True if valid CalVer format
 */
export function isValidCalVerTag(tag: string): boolean {
  return parseCalVer(tag) !== null;
}
