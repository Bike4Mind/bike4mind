import { userRepository } from '@bike4mind/database';

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

/**
 * Resolve user ids to display names for operator-facing tables (credit
 * analytics, usage dashboards).
 *
 * Ids that are not valid ObjectIds - legacy, synthetic, or system attribution
 * that #332's usage recording may carry - are skipped instead of passed to the
 * id cast in userRepository.findByIds, which throws a BSONError and would 500
 * the whole request. Unresolved ids simply have no entry in the returned map;
 * callers decide how to render them.
 */
export const resolveUserNames = async (userIds: string[]): Promise<Map<string, string>> => {
  const validIds = [...new Set(userIds)].filter(id => OBJECT_ID_RE.test(id));
  if (validIds.length === 0) return new Map();

  const users = await userRepository.findByIds(validIds);
  return new Map(users.map(u => [String(u.id), u.name || u.username || u.email || String(u.id)]));
};
