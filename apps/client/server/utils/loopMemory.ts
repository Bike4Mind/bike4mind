import { renderInvokedSkill } from '@bike4mind/common';
import { skillRepository } from '@bike4mind/database';

export { LOOP_MEMORY_TAIL_CHARS } from '@bike4mind/common';
export {
  buildLoopQuery,
  buildTriageQuery,
  LOOP_PROMPT_ANSWERS,
  LOOP_PROMPT_DIRECTIVES,
  LOOP_TICKET_PROMPT_CHARS,
  type LoopOversight,
  parseLoopMemory,
} from '@bike4mind/common/loops';

/**
 * A stage's skills rendered for `buildLoopQuery`, in stage order; undefined when it has none. One deleted or
 * unshared since the loop was saved is skipped, not fatal, as with a `/skill` mention. Shared by the cloud
 * dispatch (apps/workers/src/cron/loopScheduler.ts) and the desktop claim (loopRunner.ts).
 */
export async function renderLoopStageSkills(
  userId: string,
  ids: string[] | undefined,
  logger: { warn: (message: string, meta?: Record<string, unknown>) => void }
): Promise<string | undefined> {
  if (!ids?.length) return undefined;
  const skills = await skillRepository.findAccessibleByIdsForUser(userId, ids);
  const found = new Set(skills.map(skill => skill.id));
  const missing = ids.filter(id => !found.has(id));
  if (missing.length) logger.warn('[Loops] Stage skills not available; skipping them', { skillIds: missing });
  return skills.length ? skills.map(skill => renderInvokedSkill(skill, '', userId)).join('\n\n') : undefined;
}
