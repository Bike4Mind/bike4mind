import { PROVIDER_END_USER_ID } from './adminUsersQuery';

type Matches = { count: number; sole?: { id: string; displayName: string } };

/**
 * The 'user.provider_id.resolved' audit input for an admin users search that is a provider end-user
 * identifier, or null for any other search. `matches` is omitted when the route cannot count them.
 */
export function providerIdSearchAudit(search: string | undefined, source: string, matches?: Matches) {
  if (!search || !PROVIDER_END_USER_ID.test(search)) return null;
  return {
    action: 'user.provider_id.resolved' as const,
    target: matches?.sole
      ? { kind: 'user' as const, ...matches.sole }
      : { kind: 'system' as const, id: 'provider-end-user-id', displayName: 'Provider end-user identifier' },
    summary: 'Searched the admin users by provider end-user identifier',
    details: {
      providerEndUserId: search.toLowerCase(),
      source,
      ...(matches && { matched: matches.count > 0, matchedCount: matches.count }),
    },
  };
}
