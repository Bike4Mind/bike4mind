import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

// Helper function to determine date label
export const getDateLabel = (itemDate: Date) => {
  const now = new Date();
  const itemDay = new Date(itemDate);
  const diffTime = Math.abs(now.getTime() - itemDay.getTime());
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays === 1) {
    return 'Today';
  } else if (diffDays === 2) {
    return 'Yesterday';
  } else if (diffDays <= 7) {
    return 'Previous 7 Days';
  } else if (diffDays <= 30) {
    return 'Previous 30 Days';
  } else {
    const monthNames = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];
    const label = monthNames[itemDay.getMonth()];
    return itemDay.getFullYear() === now.getFullYear() ? label : `${label} ${itemDay.getFullYear()}`;
  }
};

export function timeOrDateFormat(date: Date): string {
  const now = dayjs();
  const inputDate = dayjs(date);

  if (inputDate.isBefore(now, 'day')) {
    // If the date is older than today, show date format
    return inputDate.format('M-DD-YYYY');
  } else {
    // If the date is today, show hour and minute format
    return inputDate.format('hh:mm A');
  }
}

export function relativeTimeFormat(date: Date): string {
  const inputDate = dayjs(date);
  return inputDate.fromNow();
}

export const getLocalDate = (daysOffset = 0) => {
  const now = dayjs();
  return daysOffset < 0
    ? now.subtract(Math.abs(daysOffset), 'day').format('YYYY-MM-DD')
    : now.add(daysOffset, 'day').format('YYYY-MM-DD');
};

/**
 * Format date as YYYY-MM-DD string for display
 * @param date Date to format (Date, string, null, or undefined)
 * @returns Formatted date string or 'N/A' if no date provided
 */
export function formatDateISO(date: Date | string | null | undefined): string {
  if (!date) return 'N/A';
  const d = typeof date === 'string' ? new Date(date) : date;
  return dayjs(d).format('YYYY-MM-DD');
}

/**
 * Get date string for input[type="date"] value
 * @param date Date to format (Date, string, null, or undefined)
 * @returns Formatted date string or empty string if no date provided
 */
export function toDateInputValue(date: Date | string | null | undefined): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  return dayjs(d).format('YYYY-MM-DD');
}

/**
 * Format date for display in What's New modals (e.g., "February 7, 2026")
 * @param date Date to format (Date, string, null, or undefined)
 * @returns Human-readable date string or empty string if no date provided
 */
export function formatDisplayDate(date: Date | string | null | undefined): string {
  if (!date) return '';
  // Use dayjs directly for strings to avoid UTC-to-local shift from new Date('YYYY-MM-DD')
  const d = typeof date === 'string' ? dayjs(date, 'YYYY-MM-DD') : dayjs(date);
  return d.format('MMMM D, YYYY');
}

/** Pattern for display dates from formatDisplayDate (e.g., "February 7, 2026") */
export const DISPLAY_DATE_REGEX =
  /^(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}$/;

/**
 * Parse subtitle field for admin edit form. Extracts display date (as YYYY-MM-DD for input) and subtitle text.
 *
 * ### Subtitle encoding convention
 * The `subtitle` DB field encodes an optional display date and optional subtitle text as a single string:
 *   - Date only:          "February 7, 2026"
 *   - Date + subtitle:   "February 7, 2026 · Some subtitle text"
 *   - Subtitle only:     "Some subtitle text"  (legacy, no date)
 *
 * The separator is " · " (space-middot-space). Avoid using " · " in subtitle text itself,
 * as it would be misinterpreted as the date/subtitle delimiter.
 *
 * Long-term, a dedicated `displayDate` schema field would be cleaner than this encoding.
 *
 * Handles "DATE", "DATE · SUBTITLE", and "SUBTITLE" formats.
 */
export function parseSubtitleToEditFields(subtitle: string | null | undefined): {
  displayDateInput: string;
  subtitleText: string;
} {
  if (!subtitle?.trim()) return { displayDateInput: '', subtitleText: '' };
  const sep = ' · ';
  if (subtitle.includes(sep)) {
    const [first, ...rest] = subtitle.split(sep);
    const datePart = first?.trim() ?? '';
    const subtitlePart = rest.join(sep).trim();
    const parsed = dayjs(datePart, 'MMMM D, YYYY', true);
    return {
      displayDateInput: parsed.isValid() ? parsed.format('YYYY-MM-DD') : '',
      subtitleText: subtitlePart,
    };
  }
  if (DISPLAY_DATE_REGEX.test(subtitle.trim())) {
    const parsed = dayjs(subtitle.trim(), 'MMMM D, YYYY', true);
    return {
      displayDateInput: parsed.isValid() ? parsed.format('YYYY-MM-DD') : '',
      subtitleText: '',
    };
  }
  return { displayDateInput: '', subtitleText: subtitle.trim() };
}
