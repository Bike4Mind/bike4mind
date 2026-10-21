import { InviteType } from '@bike4mind/common';

// Map URL path types to InviteType enum values
const URL_PATH_TO_INVITE_TYPE = {
  files: InviteType.FabFile,
  sessions: InviteType.Session,
  projects: InviteType.Project,
  groups: InviteType.Group,
  organizations: InviteType.Organization,
  tools: InviteType.Tool,
};

/**
 * Resolves the `:type` segment of the pages/api/[type]/[id] routes. The segment historically meant
 * different things per verb: GET/POST were called with the lowercase alias (`/api/projects/...`)
 * while DELETE was called with the InviteType value itself (`/api/Project/...`). Both forms are
 * accepted on every verb so the same document has one address regardless of the method; existing
 * callers of either shape keep working. Returns undefined for anything that is neither.
 */
export const resolveInviteType = (segment: string | undefined): InviteType | undefined => {
  if (!segment) return undefined;
  // hasOwn, or a segment like 'constructor' resolves to an inherited value instead of undefined.
  if (Object.hasOwn(URL_PATH_TO_INVITE_TYPE, segment)) {
    return URL_PATH_TO_INVITE_TYPE[segment as keyof typeof URL_PATH_TO_INVITE_TYPE];
  }
  return Object.values(InviteType).find(value => value === segment);
};
