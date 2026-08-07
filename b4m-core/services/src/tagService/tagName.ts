/**
 * Moved to common so client components can share the one definition of "the same tag" (the chip
 * resolution needs it, and the services barrel pulls server-only code). Re-exported here because
 * every tagService path imports it from `./tagName`.
 */
export {
  foldTagName,
  isDataLakeTagName,
  matchTagDocument,
  normalizeTagName,
  resolveFileTagDocs,
} from '@bike4mind/common';
