import { IOrganizationDocument } from '@bike4mind/common';
import { MemberCreditUsage } from './memberCreditBudget';

export type MemberStatus = 'accepted' | 'pending';
export type MemberRole = 'owner' | 'manager' | 'member';
export type RoleFilter = MemberRole | 'all';
export type StatusFilter = MemberStatus | 'all';
export type RosterSortKey = 'name' | 'role' | 'usage';
export type SortDirection = 'asc' | 'desc';

/** Team roles, most authority first; each is labelled by `organization.roles.<role>` in en.json. */
export const MEMBER_ROLES: readonly MemberRole[] = ['owner', 'manager', 'member'];

const ROLE_RANK: Record<MemberRole, number> = { owner: 0, manager: 1, member: 2 };

export const ROSTER_PAGE_SIZE = 50;

export interface RosterMember {
  id: string;
  name: string;
  email?: string | null;
  status: MemberStatus;
  role: MemberRole;
  /** Null for a pending invite, or when the viewer may not see member budgets. */
  creditUsage: MemberCreditUsage | null;
}

export interface RosterFilters {
  search: string;
  role: RoleFilter;
  status: StatusFilter;
}

/** One team role per row; sharing permissions are not roles (see the settings-access chip in UserCard). */
export function getMemberRole(
  organization: Pick<IOrganizationDocument, 'userId' | 'adminUserIds'>,
  userId: string
): MemberRole {
  if (userId === organization.userId) return 'owner';
  if ((organization.adminUserIds ?? []).some(id => String(id) === userId)) return 'manager';
  return 'member';
}

export function filterMembers<T extends RosterMember>(members: readonly T[], filters: RosterFilters): T[] {
  const term = filters.search.trim().toLowerCase();
  return members.filter(
    member =>
      (filters.role === 'all' || member.role === filters.role) &&
      (filters.status === 'all' || member.status === filters.status) &&
      (!term || member.name.toLowerCase().includes(term) || !!member.email?.toLowerCase().includes(term))
  );
}

const byName = (a: RosterMember, b: RosterMember) => a.name.localeCompare(b.name);

/** Returns a new array. Ties fall back to name A-Z; rows with no usage figure sort last either way. */
export function sortMembers<T extends RosterMember>(
  members: readonly T[],
  key: RosterSortKey,
  direction: SortDirection
): T[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...members].sort((a, b) => {
    if (key === 'name') return sign * byName(a, b);
    if (key === 'role') return sign * (ROLE_RANK[a.role] - ROLE_RANK[b.role]) || byName(a, b);
    const usedA = a.creditUsage?.used ?? null;
    const usedB = b.creditUsage?.used ?? null;
    if (usedA === null || usedB === null) {
      if (usedA === usedB) return byName(a, b);
      return usedA === null ? 1 : -1;
    }
    return sign * (usedA - usedB) || byName(a, b);
  });
}

export interface RosterPage<T> {
  items: T[];
  /** 1-based, clamped into range. */
  page: number;
  pageCount: number;
  /** 1-based index of the first row shown; 0 when there are none. */
  first: number;
  last: number;
}

export function paginate<T>(items: readonly T[], page: number, pageSize: number = ROSTER_PAGE_SIZE): RosterPage<T> {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(Math.max(1, page), pageCount);
  const start = (current - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize);
  return {
    items: pageItems,
    page: current,
    pageCount,
    first: pageItems.length ? start + 1 : 0,
    last: start + pageItems.length,
  };
}

export const ROSTER_TABLE_QUERY = '@container organization-members-roster (min-width: 920px)';

/** Grid track list shared by the roster header and every row, so their columns cannot drift apart. */
export function rosterGridColumns(selectable: boolean): string {
  return `${selectable ? '32px ' : ''}minmax(200px, 2fr) minmax(160px, 2fr) minmax(100px, 1fr) minmax(140px, 1fr) minmax(100px, 1fr) 48px`;
}

/** What removal does, per organizationService.revokeAccess; shared by the single and bulk confirmations. */
export const REMOVE_MEMBER_EFFECT =
  "They lose access to this team, including its groups and data lakes, and stop using the team's credits. Their account and the content in it are not deleted.";
