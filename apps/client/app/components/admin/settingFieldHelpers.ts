/**
 * Why the server would refuse this number, in the words the field shows. The setting's own
 * schema carries the same bounds (makeNumberSetting in @bike4mind/common), and the update
 * route parses with it directly, so an out-of-range value comes back as an untranslated
 * ZodError: without this the admin sees Save do nothing and is told nothing.
 *
 * Shared by the platform-value field (AdminSettingInputField) and the scoped-override add row
 * (ScopedSettingOverrides), which have the same bounds and must not describe them differently.
 */
export const rangeMessage = (value: number, min?: number, max?: number): string | undefined => {
  const inRange = (min === undefined || value >= min) && (max === undefined || value <= max);
  if (!Number.isNaN(value) && inRange) return undefined;
  if (min !== undefined && max !== undefined) return `Enter a number between ${min} and ${max}.`;
  if (min !== undefined) return `Enter a number of ${min} or more.`;
  if (max !== undefined) return `Enter a number of ${max} or less.`;
  return 'Enter a number.';
};
