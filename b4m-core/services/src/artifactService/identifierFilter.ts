/**
 * Mongo filter matching an artifact by its `identifier`. Rows written before `identifier` became a
 * field recorded it only in `metadata.originalIdentifier`, so those match through that instead.
 */
export const identifierFilter = (identifier: string) => ({
  $or: [{ identifier }, { identifier: { $exists: false }, 'metadata.originalIdentifier': identifier }],
});
