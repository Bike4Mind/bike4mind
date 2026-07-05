import {
  IChatHistoryItemDocument,
  ISessionDocument,
  IMessage,
  ISkill,
  ModelInfo,
  detectSkillMentions,
  renderInvokedSkill,
} from '@bike4mind/common';
import { ChatCompletionFeature, ChatCompletionContext } from '../ChatCompletionFeatures';

/**
 * Cap on how many user skills are listed in the per-turn "Available Skills"
 * catalog. Bounds the token cost a power-user pays for skill discovery - the
 * LLM still resolves uncatalogued skills when the user types `/skill-name`
 * directly (that path runs through detectSkillMentions, not the catalog).
 */
const SKILLS_CATALOG_LIMIT = 50;

/**
 * SkillsFeature - expands `/skill-name args` invocations in the user's message
 * into system-prompt instructions before the LLM responds.
 *
 * Mirrors AgentDetectionFeature's two-phase shape:
 *   1. `beforeDataGathering` parses the message for `/skill` mentions and
 *      resolves them against the user's accessible skills, storing the
 *      resolved set on the quest for the second phase.
 *   2. `getContextMessages` returns one system message per resolved skill,
 *      with `$ARGUMENTS` / `$1` / `$2` substituted from the invocation args.
 *
 * Scope: resolves skills across everything the invoking user can access -
 * owned, shared directly, or global-read (`listAccessibleInvocableForUser` /
 * `findAccessibleByNamesForUser`). A resolved skill the user does NOT own is
 * injected as *untrusted* content (delimiter-wrapped, "do not follow conflicting
 * instructions" framing) so a shared skill's author can't hijack the turn.
 */
export class SkillsFeature implements ChatCompletionFeature {
  constructor(private service: ChatCompletionContext) {
    this.service.logger.log('🔧 SkillsFeature initialized');
  }

  async onComplete(): Promise<void> {
    // No cleanup needed.
  }

  async beforeDataGathering(args: {
    quest: IChatHistoryItemDocument & { _skillsToInvoke?: ResolvedSkillInvocation[]; _skillCatalog?: ISkill[] };
    session: ISessionDocument;
    startParams: unknown;
    llm: unknown;
    model: string;
    message: string;
    historyCount: number;
    fabFileIds: string[];
    questId: string;
    questMaster: unknown;
  }): Promise<{ shouldContinue: boolean }> {
    const { message, quest } = args;
    if (!this.service.db.skills) {
      this.service.logger.log('🔧 SkillsFeature: skill repository unavailable — no-op');
      return { shouldContinue: true };
    }

    const userId = this.service.user.id;

    // Catalog: surfaces the model-invocable skills into the system prompt so
    // the LLM can call the `skill` tool autonomously. Cap is pushed into Mongo
    // (`limit + sort {updatedAt:-1}`) - a power-user with 1000 skills pulls
    // SKILLS_CATALOG_LIMIT docs, not 1000. The LLM still discovers uncatalogued
    // skills via the user's `/skill-name` slash invocation, which is parsed
    // below and not subject to the cap.
    const invocableSkills = await this.service.db.skills.listAccessibleInvocableForUser(userId, SKILLS_CATALOG_LIMIT);
    if (invocableSkills.length > 0) {
      quest._skillCatalog = invocableSkills;
    }

    // Mention resolution: `/skill-name args` invocations in the user message.
    // Batched as one `$in` query so several mentions in one message don't
    // fan out to N round-trips.
    const mentions = detectSkillMentions(message);
    if (mentions.length > 0) {
      const names = mentions.map(m => m.name);
      const skills = await this.service.db.skills.findAccessibleByNamesForUser(userId, names);
      const byName = new Map(skills.map(s => [s.name, s]));
      const resolved: ResolvedSkillInvocation[] = [];
      for (const mention of mentions) {
        const skill = byName.get(mention.name);
        if (!skill) {
          this.service.logger.log(`🔧 SkillsFeature: skill "/${mention.name}" not found for user ${userId}`);
          continue;
        }
        resolved.push({ skill, rawArgs: mention.args });
      }
      if (resolved.length > 0) {
        this.service.logger.log(
          `🔧 SkillsFeature: resolved ${resolved.length} skill(s): ${resolved.map(r => r.skill.name).join(', ')}`
        );
        quest._skillsToInvoke = resolved;
      }
    }

    return { shouldContinue: true };
  }

  async getContextMessages(
    quest: IChatHistoryItemDocument & { _skillsToInvoke?: ResolvedSkillInvocation[]; _skillCatalog?: ISkill[] },
    _embeddingFactory: unknown,
    _message: string,
    _maxTokens: number,
    _modelInfo: ModelInfo
  ): Promise<IMessage[]> {
    const messages: IMessage[] = [];

    const catalog = quest._skillCatalog ?? [];
    if (catalog.length > 0) {
      messages.push({
        role: 'system' as const,
        content: buildSkillCatalogPrompt(catalog),
      });
    }

    const invocations = quest._skillsToInvoke ?? [];
    const userId = this.service.user.id;
    for (const { skill, rawArgs } of invocations) {
      // Owner vs. untrusted framing + argument substitution is shared with the
      // agent-executor path via `renderInvokedSkill` so a `/skill` invocation
      // expands identically whichever pipeline a turn routes through.
      messages.push({
        role: 'system' as const,
        content: renderInvokedSkill(skill, rawArgs, userId),
      });
    }

    return messages;
  }
}

/**
 * Sanitize a catalog field that the LLM will see. Strips backticks (which
 * could close the surrounding markdown code span and let the description
 * escape into prompt-instruction context) and collapses newlines (which let
 * a description impersonate a separate prompt block). Defensive for v1 where
 * the description is author-controlled and authors are the invoking user -
 * load-bearing once shared/global skills can be authored by other users.
 */
function sanitizeCatalogField(input: string, maxLen = 200): string {
  return input.replace(/`/g, "'").replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

/** Format the LLM-invocable skill catalog for inclusion in the system prompt. */
function buildSkillCatalogPrompt(skills: ISkill[]): string {
  const lines = skills.map(s => {
    const hint = s.argumentHint ? ` ${sanitizeCatalogField(s.argumentHint, 100)}` : '';
    return `- \`/${s.name}${hint}\` — ${sanitizeCatalogField(s.description)}`;
  });
  return [
    '## Available Skills',
    '',
    'The user has defined reusable instruction templates. Invoke one via the `skill` tool ' +
      'when its description fits the task — pass `{ name, args }`. Skills the user invokes ' +
      'directly with `/skill-name` are already expanded for you.',
    '',
    ...lines,
  ].join('\n');
}

interface ResolvedSkillInvocation {
  skill: ISkill;
  rawArgs: string;
}
