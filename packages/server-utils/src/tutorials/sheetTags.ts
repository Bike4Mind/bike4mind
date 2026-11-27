// Dependency-free, so file routes can read it without loading the tutorial service.

/** Names the user's copies of the core sample sheets. */
export const CORE_TUTORIAL_SHEET_TAG = 'tutorial';

/**
 * The namespaces the core sheet's bookkeeping tags sit under (`tutorial:<moduleId>`, `tutorial-csv:<digest>`,
 * see sheet.ts). The File Browser lists each tag namespace as a folder, so these would show as folders of their own.
 */
const CORE_TUTORIAL_SHEET_NAMESPACES: ReadonlySet<string> = new Set([
  CORE_TUTORIAL_SHEET_TAG,
  `${CORE_TUTORIAL_SHEET_TAG}-csv`,
]);

export const isCoreTutorialSheetTag = (tag: string): boolean => CORE_TUTORIAL_SHEET_NAMESPACES.has(tag.split(':')[0]);
