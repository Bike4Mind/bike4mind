/**
 * Shared plumbing for the "why not" reasons the capability validators attach to each failure (image/validate.ts,
 * video/validate.ts, music/validate.ts). A validator models its failure context as a discriminated union keyed on
 * the failure code, then supplies one reason builder per code through a ReasonTable.
 */

/**
 * One reason builder per failure code. Keyed on the validator's full code list, and a code with no matching detail
 * variant maps to `never`, so adding a code to the list without both a detail variant and a reason fails to compile.
 */
export type ReasonTable<Code extends string, Detail extends { code: Code }> = {
  [C in Code]: [Extract<Detail, { code: C }>] extends [never]
    ? never
    : (detail: Extract<Detail, { code: C }>) => string;
};

export function reasonFor<Code extends string, Detail extends { code: Code }>(
  table: ReasonTable<Code, Detail>,
  detail: Detail
): string {
  // TS cannot correlate the indexed builder with the narrowed detail; the mapped type above guarantees the match.
  const build = table[detail.code] as unknown as (value: Detail) => string;
  return build(detail);
}

/** `['4', '6', '8']` -> `'4, 6 or 8'`. */
export function joinWithOr(values: readonly string[]): string {
  if (values.length <= 1) return values.join('');
  return `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}`;
}

export const pluralize = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`;

/**
 * The tighter of "up to max" / "at least min" when the request falls outside the bounds, else null so the caller
 * can name the allowed set instead (an off-step or between-values request).
 */
export function outOfBoundsPhrase(requested: number, min: number, max: number, unit: string): string | null {
  if (requested > max) return `up to ${max}${unit}`;
  if (requested < min) return `at least ${min}${unit}`;
  return null;
}
