// Free of the tutorial service, so file routes can read it without loading it.
import { CORE_TUTORIALS } from './registry';

/** Names the user's copies of the core sample sheets. */
export const CORE_TUTORIAL_SHEET_TAG = 'tutorial';

/** The tag a sheet copy's content digest sits under; sheet.ts writes `<prefix><16 hex>`. */
export const sheetContentPrefix = (tag: string) => `${tag}-csv:`;

const CORE_MODULE_IDS: ReadonlySet<string> = new Set(CORE_TUTORIALS.map(tutorial => tutorial.id));
const CONTENT_DIGEST = /^[0-9a-f]{16}$/;
const CORE_COPY_PREFIX = `${CORE_TUTORIAL_SHEET_TAG}:`;
const CORE_CONTENT_PREFIX = sheetContentPrefix(CORE_TUTORIAL_SHEET_TAG);

/**
 * Whether a tag is one the core sheet wrote on a copy (`tutorial:<moduleId>`, `tutorial-csv:<digest>`, see sheet.ts),
 * matched by exact shape so a user's own `tutorial:<anything else>` is never taken for one.
 */
export function isCoreTutorialSheetTag(tag: string): boolean {
  if (tag.startsWith(CORE_COPY_PREFIX)) return CORE_MODULE_IDS.has(tag.slice(CORE_COPY_PREFIX.length));
  if (tag.startsWith(CORE_CONTENT_PREFIX)) return CONTENT_DIGEST.test(tag.slice(CORE_CONTENT_PREFIX.length));
  return false;
}

/** The namespaces those tags sit under; one may also hold the user's own tags of the same name. */
export const isCoreTutorialSheetNamespace = (namespace: string): boolean =>
  `${namespace}:` === CORE_COPY_PREFIX || `${namespace}:` === CORE_CONTENT_PREFIX;
