import { agentRepository, userRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { triggerWordsSchema } from '@bike4mind/common';

/**
 * Seeds orchestration-enabled test agents on the shared `test@test.com` super
 * admin account. Every regression test of ReAct,
 * `delegate_to_agent`, and mid-iteration checkpoint flows needs a foreground
 * subagent provisioned on the test account, and clicking through the Agents UI
 * doesn't survive preview-env resets.
 *
 * Runs after {@link UserSeeder} so the owning super admin exists.
 */

const SUPER_ADMIN_EMAIL = 'test@test.com';

export type AgentSeed = {
  name: string;
  triggerWord: string;
  description: string;
  systemPrompt: string;
  defaultThoroughness: 'quick' | 'medium' | 'very_thorough';
  allowedTools?: string[];
};

const SEEDS: AgentSeed[] = [
  {
    name: 'Research Lead',
    triggerWord: '@researchlead',
    description: 'Iterative ReAct research agent for testing orchestration flows',
    defaultThoroughness: 'very_thorough',
    // Empty = all tools allowed.
    allowedTools: [],
    systemPrompt: [
      'You are Research Lead, an iterative research agent used to exercise ReAct orchestration flows.',
      '',
      'You MUST run AT LEAST FOUR ReAct iterations that each call a tool before you emit `final_answer`.',
      'Do not short-circuit. Use web search, code execution, or `delegate_to_agent` as appropriate to',
      'gather distinct evidence on each iteration. Only after four substantive tool-call iterations may',
      'you synthesise and finalise.',
      '',
      'When delegating, prefer `delegate_to_agent` and route sub-questions to `@researcher`.',
    ].join('\n'),
  },
  {
    name: 'Researcher',
    triggerWord: '@researcher',
    description: 'Focused subagent used as the delegate target for delegate_to_agent flows',
    defaultThoroughness: 'medium',
    // Whitelist research-oriented tools; explicitly omits `delegate_to_agent` so the subagent
    // cannot recursively spawn its own children - keeps the test surface bounded.
    allowedTools: ['web_search', 'web_fetch', 'wikipedia_on_this_day', 'current_datetime', 'math_evaluate'],
    systemPrompt: [
      'You are Researcher, a focused subagent invoked via `delegate_to_agent` from a parent orchestrator.',
      '',
      "Answer the parent's sub-question directly and concisely. Use 2–3 tool calls to gather evidence,",
      'then emit `final_answer` with the findings and source URLs. Do not delegate further. Do not over-elaborate.',
    ].join('\n'),
  },
  {
    name: 'Tool-Gated',
    triggerWord: '@toolgated',
    description: 'Permission-gated agent for exercising the awaiting_permission flow',
    defaultThoroughness: 'quick',
    // Narrow whitelist. Any tool the model picks outside this set triggers the permission gate
    // (`awaiting_permission` status, inline approval card in the UI).
    allowedTools: ['current_datetime', 'math_evaluate'],
    systemPrompt: [
      'You are Tool-Gated, a permission-gated test agent.',
      '',
      "Your allowed tools are narrow (datetime + math). When the user's request needs something outside",
      'that set — web search, image generation, code execution — go ahead and try it. The permission gate',
      'will intercept and prompt the user for approval; that is the flow under test.',
    ].join('\n'),
  },
];

export class AgentSeeder {
  constructor(private readonly logger: Logger) {}

  // `seeds` is injectable so tests can exercise normalization paths (e.g. an
  // uppercase trigger word); production callers use the default SEEDS.
  async seed(seeds: AgentSeed[] = SEEDS) {
    const owner = await userRepository.findOne({ email: SUPER_ADMIN_EMAIL });
    if (!owner) {
      this.logger.info(`Super admin ${SUPER_ADMIN_EMAIL} not found, skipping AgentSeeder`);
      return;
    }

    // Validate seed trigger words against the same schema the API uses, so a malformed
    // seed (e.g. `@bad-` or `@-handle`) fails fast in the preview-deploy logs instead
    // of silently persisting an @-mention the chat parser can't read at runtime.
    triggerWordsSchema.parse(seeds.map(seed => seed.triggerWord));

    this.logger.info(`Processing ${seeds.length} test agents for ${SUPER_ADMIN_EMAIL}`);

    for (const seed of seeds) {
      // Normalize to lowercase up front so the seeder stays symmetric with the model's
      // on-save behavior (AgentModel's `pre('validate')` hook lowercases `triggerWords`).
      // Without this, an uppercase seed would be stored lowercased but looked up
      // case-sensitively (`findByTriggerWords` uses `$in`), so every re-seed would miss
      // the stored agent and create a duplicate. The `triggerWordsSchema.parse`
      // above is validation-only and discards its result, so the authored seed value
      // still needs explicit normalization here.
      const triggerWord = seed.triggerWord.toLowerCase();

      // Mirror the shape the API endpoint constructs (apps/client/pages/api/agents/index.ts).
      // Capabilities is `[String]` with `required: true` on the element, so we must persist a
      // non-empty array - the API stores a single JSON-encoded entry, so we do the same.
      const capabilitiesJson = JSON.stringify({
        triggerWords: [triggerWord],
        responseStyle: 'friendly',
        specialBehaviors: [],
      });

      // Fields that are safe to rewrite on every seed run - the seed definition is the
      // source of truth for these. `userId`, `createdAt`, etc. are deliberately omitted
      // so a re-seed doesn't reparent an agent or rewrite history.
      const seededFields = {
        name: seed.name,
        description: seed.description,
        triggerWords: [triggerWord],
        capabilities: [capabilitiesJson],
        systemPrompt: seed.systemPrompt,
        defaultThoroughness: seed.defaultThoroughness,
        // Present (even when empty) so the executor routes through the orchestration path.
        allowedTools: seed.allowedTools ?? [],
      };

      // `findByTriggerWords` matches via `$or: [{ userId }, { 'users.userId': userId }]`,
      // so a shared-membership match could surface an agent the seeder doesn't own.
      // Filter to strictly owned agents - the seeder only ever creates/updates agents
      // owned by the test super admin.
      const existing = (await agentRepository.findByTriggerWords([triggerWord], owner.id)).filter(
        a => a.userId === owner.id
      );
      if (existing.length > 0) {
        // Upsert semantics: if the seed definition changed (e.g. tweaked system prompt or
        // thoroughness), bring the existing agent in line. Skip the `update` call when the
        // stored doc is already aligned - keeps logs quiet on no-op re-runs.
        const target = existing[0];
        const drift = (Object.keys(seededFields) as Array<keyof typeof seededFields>).some(
          k => JSON.stringify(target[k]) !== JSON.stringify(seededFields[k])
        );
        if (!drift) {
          this.logger.info(`Agent ${triggerWord} up to date, skipping`);
          continue;
        }
        await agentRepository.update({ id: target.id, ...seededFields });
        this.logger.info(`Updated agent ${triggerWord} (id ${target.id})`);
        continue;
      }

      const created = await agentRepository.create({
        ...seededFields,
        userId: owner.id,
        isPublic: false,
        personality: {
          majorMotivation: 'Verifying orchestration loops',
          minorMotivation: 'Producing reproducible test traces',
          flaw: 'None',
          quirk: 'None',
          description: 'ReAct test harness agent',
        },
        visual: {
          portraitUrl: '',
          style: 'modern',
          generationPrompt: '',
        },
        identity: {
          gender: 'prefer-not-to-say',
          pronouns: {
            subject: '',
            object: '',
            possessive: '',
            possessiveAdjective: '',
            reflexive: '',
          },
        },
        useOwnCredits: false,
        currentCredits: 0,
        isGlobalRead: false,
        isGlobalWrite: false,
        users: [],
        groups: [],
      });

      this.logger.info(`Created agent ${triggerWord} (id ${created.id})`);
    }

    this.logger.info('AgentSeeder done');
  }
}
