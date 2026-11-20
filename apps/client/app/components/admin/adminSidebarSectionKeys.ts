/**
 * The admin sidebar's section keys, in display order. Kept apart from adminSidebarConfig.tsx
 * (icons, admin types) so the premium route contract and its partition can name a section
 * without pulling that module into the router's graph. adminSidebarConfig.test.tsx pins this
 * list to SIDEBAR_SECTIONS, so the two cannot drift.
 */
export const ADMIN_SIDEBAR_SECTION_KEYS = [
  'overview',
  'people',
  'money',
  'trust',
  'ai',
  'platform',
  'settings',
] as const;

export type AdminSidebarSectionKey = (typeof ADMIN_SIDEBAR_SECTION_KEYS)[number];

export const isAdminSidebarSectionKey = (value: unknown): value is AdminSidebarSectionKey =>
  typeof value === 'string' && (ADMIN_SIDEBAR_SECTION_KEYS as readonly string[]).includes(value);
