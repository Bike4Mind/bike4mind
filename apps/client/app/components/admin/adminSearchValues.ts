/**
 * Coercers shared by the admin tabs' `/admin` search param parsers (Users/usersTabSearch.ts,
 * Feedback/feedbackTabSearch.ts). Pure and React-free, since router.tsx imports them eagerly.
 */

// TanStack's JSON search parser hands numbers back as numbers, but a hand-typed link may quote them.
export const toNumber = (value: unknown): number => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return Number.NaN;
};

export const oneOf =
  <T extends string>(allowed: readonly T[]) =>
  (value: unknown): T | undefined =>
    allowed.find(option => option === value);

export const parsePage = (value: unknown): number | undefined => {
  const page = toNumber(value);
  // Safe integers only: a huge page serializes in exponent form, which the list APIs reject.
  return Number.isSafeInteger(page) && page >= 1 ? page : undefined;
};

// A lone string is accepted as a one-item list, so `?tags=Admin` works as well as `?tags=["Admin"]`.
export const parseStringList = (value: unknown): string[] | undefined => {
  const items = Array.isArray(value) ? value : [value];
  const strings = items.filter((item): item is string => typeof item === 'string' && item !== '');
  return strings.length > 0 ? strings : undefined;
};
