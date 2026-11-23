const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter(key => record[key] !== undefined)
        .map(key => [key, canonicalize(record[key])])
    );
  }
  return value;
};

/** JSON with object keys sorted at every depth; array order is meaningful and kept. */
export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));
