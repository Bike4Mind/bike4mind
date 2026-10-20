// Route search coercion: falsy (missing or empty) becomes undefined, anything else is
// String()-coerced, so the numbers TanStack's JSON search parser produces come back as strings.
export const optionalStringSearchValue = (value: unknown): string | undefined => (value ? String(value) : undefined);
