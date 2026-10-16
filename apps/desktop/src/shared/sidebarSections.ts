/**
 * User-made sidebar sections: named buckets a session can be moved into, beside the pinned,
 * project and archived groups the sidebar derives on its own. Owned by main
 * (SidebarSectionStore); the renderer only ever holds the state a call handed back.
 */

export const SIDEBAR_SECTION_NAME_MAX_LENGTH = 60;

export type SidebarSection = {
  id: string;
  name: string;
};

export type SidebarSectionsState = {
  /** In the order the sidebar draws them, which is the order they were made. */
  sections: SidebarSection[];
  /** Session id -> section id. A session with no entry sits in the sidebar's default groups. */
  assignments: Record<string, string>;
};

export const EMPTY_SIDEBAR_SECTIONS: SidebarSectionsState = { sections: [], assignments: {} };

/** A typed name the way the store keeps it, so the dialog can refuse what the store would. */
export function normalizeSectionName(text: string): string {
  // By code point, so the cap cannot split an emoji's surrogate pair.
  return Array.from(text.replace(/\s+/g, ' ').trim())
    .slice(0, SIDEBAR_SECTION_NAME_MAX_LENGTH)
    .join('');
}
