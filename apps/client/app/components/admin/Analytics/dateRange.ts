import dayjs from 'dayjs';

const DATE_FORMAT = 'YYYY-MM-DD';

export interface DateRange {
  startDate: string;
  endDate: string;
}

/** Preset lengths in days; 1 is "Today". */
export const DATE_PRESET_DAYS = [1, 7, 30] as const;
export type DatePresetDays = (typeof DATE_PRESET_DAYS)[number];

export const DEFAULT_PRESET_DAYS: DatePresetDays = 7;

export const today = () => dayjs().format(DATE_FORMAT);

/** The inclusive range of exactly `days` calendar days ending today (7 days = today-6..today). */
export const getPresetRange = (days: DatePresetDays): DateRange => ({
  startDate: dayjs()
    .subtract(days - 1, 'day')
    .format(DATE_FORMAT),
  endDate: today(),
});

/** The preset `range` matches exactly, or null for a custom range. */
export const getActivePreset = ({ startDate, endDate }: DateRange): DatePresetDays | null => {
  if (endDate !== today()) return null;
  const spanDays = dayjs(endDate).diff(dayjs(startDate), 'day') + 1;
  return DATE_PRESET_DAYS.find(days => days === spanDays) ?? null;
};
