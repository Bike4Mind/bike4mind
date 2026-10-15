/**
 * Skill-invocation expansion for agent_executor.
 *
 * The chat-completion flow expands `/skill-name args` invocations via
 * `SkillsFeature` (`b4m-core/services/src/llm/features/SkillsFeature.ts`).
 * When a turn routes to the agent-executor pipeline instead (agent-mode
 * toggle, an attached/default agent, or a "complex" classification),
 * `SkillsFeature` never runs, so the literal `/skill-name` text reaches the
 * LLM un-expanded. This helper resolves the same mentions and renders them
 * with the same `renderInvokedSkill` framing so expansion is consistent
 * across pipelines.
 *
 * Returns a preamble the caller appends to the first-iteration query, same
 * handoff contract as the `[ATTACHED FILES ...]` and `[KNOWN FACTS ...]`
 * preambles. The caller gates on iteration 0 of a new execution, so
 * continuation/gate/DAG resumes see the expansion already persisted in the
 * checkpointed first user message and do not re-resolve.
 *
 * Best-effort: a resolution failure does not fail the run - errors log and
 * return ''. A mention that doesn't resolve to an accessible skill is
 * skipped (logged), matching `SkillsFeature`'s "skill not found" behavior.
 *
 * Extracted to its own module (mirroring `getFirstIterationMementosPreamble`)
 * so it's unit-testable without agentExecutor's server-only deps.
 */

import type { ISkill } from '@bike4mind/common';
import { detectSkillMentions, renderInvokedSkill } from '@bike4mind/common';

/**
 * Minimal structural Logger contract, kept local so this module doesn't
 * import `@bike4mind/utils`/`@bike4mind/observability` (which pull in AWS /
 * Smithy native deps the Vitest resolver can't load). The full `Logger`
 * satisfies this shape, so production callers pass theirs verbatim.
 */
interface MinimalLogger {
  log: (message: string) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * The single skill-repository method this helper needs: the accessible-scope
 * batch resolver (owned + shared + org + global-read), identical to the one
 * `SkillsFeature.beforeDataGathering` calls.
 */
interface SkillResolverRepo {
  findAccessibleByNamesForUser: (userId: string, names: string[]) => Promise<ISkill[]>;
}

/**
 * Resolve and render the `/skill-name args` invocations in `message`, returning
 * a preamble to append to the agent's first-iteration query (leading blank line
 * included), or '' when there's nothing to inject.
 */
export async function getFirstIterationSkillsPreamble(
  message: string,
  userId: string,
  repo: SkillResolverRepo,
  logger: MinimalLogger
): Promise<string> {
  const mentions = detectSkillMentions(message);
  if (mentions.length === 0) return '';

  let skills: ISkill[];
  try {
    skills = await repo.findAccessibleByNamesForUser(
      userId,
      mentions.map(m => m.name)
    );
  } catch (err) {
    logger.error('[Skills] Failed to resolve /skill invocations; proceeding without expansion', {
      userId,
      mentions: mentions.map(m => m.name),
      error: err instanceof Error ? err.message : String(err),
    });
    return '';
  }

  const byName = new Map(skills.map(s => [s.name, s]));
  const rendered: string[] = [];
  const expandedNames: string[] = [];
  for (const mention of mentions) {
    const skill = byName.get(mention.name);
    if (!skill) {
      logger.log(`🔧 [Skills] /${mention.name} not found for user ${userId} — skipping`);
      continue;
    }
    rendered.push(renderInvokedSkill(skill, mention.args, userId));
    // Track per-mention (not per-unique-skill) so the count and name list agree
    // even when the same skill is invoked more than once.
    expandedNames.push(mention.name);
  }

  if (rendered.length === 0) return '';
  logger.log(`🔧 [Skills] expanded ${rendered.length} invocation(s): ${expandedNames.join(', ')}`);
  return `\n\n${rendered.join('\n\n')}`;
}
