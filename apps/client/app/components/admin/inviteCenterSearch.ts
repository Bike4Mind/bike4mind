// `section` belongs to Admin Settings, and each registered param key needs exactly one owner (adminTabParams.ts).
export const INVITE_CENTER_SECTION_PARAM = 'inviteSection';
export const INVITE_CENTER_SECTION_IDS = ['waitlist', 'packages', 'schedule', 'pending', 'rewards'] as const;
export type InviteCenterSectionId = (typeof INVITE_CENTER_SECTION_IDS)[number];
export const DEFAULT_INVITE_CENTER_SECTION: InviteCenterSectionId = 'waitlist';
export const INVITE_CENTER_TAB_PARAMS = [INVITE_CENTER_SECTION_PARAM] as const;

// An array check, not an object lookup: the value comes from the query string.
export const inviteCenterSectionFromParam = (value: string | undefined): InviteCenterSectionId =>
  INVITE_CENTER_SECTION_IDS.find(id => id === value) ?? DEFAULT_INVITE_CENTER_SECTION;
