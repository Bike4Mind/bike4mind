/**
 * Pre-authorization is INERT unless the request's authenticated principal IS the session owner.
 * Checked once, here, rather than re-derived at each consumption site: a worker path that
 * substitutes identity (running as the session owner with no live requester, e.g.
 * notebookCuration/agentProactiveMessage) never reaches this call at all, and a request acting on
 * someone else's session (a share, a teammate reply) must not inherit the owner's grant.
 */
export function vetPreauthorizedLakeIds(
  session: { userId?: string; preauthorizedLakeIds?: string[] },
  actingUserId: string
): string[] | undefined {
  return session.userId === actingUserId ? session.preauthorizedLakeIds : undefined;
}
