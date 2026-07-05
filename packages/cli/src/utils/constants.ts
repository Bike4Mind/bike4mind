/**
 * Common human name suffixes that should NOT trigger file autocomplete
 * Examples: @john.jr, @mary.phd, @bob.iii
 */
export const NAME_SUFFIXES = ['jr', 'sr', 'ii', 'iii', 'iv', 'v', 'phd', 'md', 'esq'] as const;

export type NameSuffix = (typeof NAME_SUFFIXES)[number];

/**
 * Type-safe check if a string is a name suffix
 */
export function isNameSuffix(value: string): value is NameSuffix {
  return (NAME_SUFFIXES as readonly string[]).includes(value);
}
