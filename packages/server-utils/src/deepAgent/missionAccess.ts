/**
 * Missions are admin/developer gated while the feature matures. Shared by the REST create route
 * (pages/api/agents/[id]/missions.ts) and the create_mission chat tool, which wake on platform keys.
 */
export function canCreateMissions(user: { isAdmin?: boolean | null; tags?: string[] | null }): boolean {
  return (
    Boolean(user.isAdmin) ||
    (user.tags ?? []).map(t => t.toLowerCase()).some(t => ['developer', 'dev', 'developers'].includes(t))
  );
}
