const MAX_PUZZLE_AGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const PUZZLE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const isCalendarDate = (value: string) => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

// Dates compare as ISO strings, so puzzleDate must already match PUZZLE_DATE_PATTERN.
export function isWithinPuzzleWindow(puzzleDate: string, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10);
  const oldest = new Date(now - MAX_PUZZLE_AGE_DAYS * DAY_MS).toISOString().slice(0, 10);
  return puzzleDate >= oldest && puzzleDate <= today;
}

/** True when the grant endpoint would accept this puzzleDate. */
export const isGrantablePuzzleDate = (puzzleDate: string, now = Date.now()) =>
  PUZZLE_DATE_PATTERN.test(puzzleDate) && isCalendarDate(puzzleDate) && isWithinPuzzleWindow(puzzleDate, now);
