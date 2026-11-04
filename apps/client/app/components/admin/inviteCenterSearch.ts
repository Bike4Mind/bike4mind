import { oneOf } from './adminSearchValues';

// `section` belongs to Admin Settings, and each registered param key needs exactly one owner (adminTabParams.ts).
export const INVITE_CENTER_SECTION_PARAM = 'inviteSection';
export const INVITE_CENTER_SECTION_IDS = ['waitlist', 'packages', 'schedule', 'pending', 'rewards'] as const;
export type InviteCenterSectionId = (typeof INVITE_CENTER_SECTION_IDS)[number];
export const DEFAULT_INVITE_CENTER_SECTION: InviteCenterSectionId = 'waitlist';
export const INVITE_CENTER_TAB_PARAMS = [INVITE_CENTER_SECTION_PARAM] as const;

export type InviteCenterSearch = {
  [INVITE_CENTER_SECTION_PARAM]?: InviteCenterSectionId;
};

/** Per-key coercion for the route's `validateSearch`; an unknown section becomes undefined. */
export const INVITE_CENTER_SEARCH_PARSERS: {
  readonly [K in keyof InviteCenterSearch]-?: (value: unknown) => InviteCenterSearch[K];
} = {
  [INVITE_CENTER_SECTION_PARAM]: oneOf(INVITE_CENTER_SECTION_IDS),
};
