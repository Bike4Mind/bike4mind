import { BriefcasePrompt } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Stand up the Briefcase capability:
 *  1. Ensure the catalog indexes exist (idempotent - createIndexes is a no-op for
 *     already-built indexes; they're also declared on the model for autoIndex).
 *  2. Backfill schemaVersion on any pre-existing docs (idempotent - only docs
 *     missing the field are touched).
 *  3. Seed a small set of generic starter SYSTEM prompts so the launcher panel is
 *     non-empty the first time EnableBriefcase is turned on. Seeding is idempotent:
 *     each prompt is upserted on its (userId:null, type, name) natural key, so
 *     re-running never duplicates and never clobbers admin edits to the text.
 *
 * Personal prompts are authored at runtime via the briefcase API; none are seeded.
 */

interface SeedPrompt {
  type: string;
  name: string;
  description: string;
  promptText: string;
  tags: string[];
}

// Generic, domain-neutral starters. Execution mode defaults to 'inject' (places
// text in the input for the user to edit/send) - the safe default for a launcher
// shipping with no usage history. Variables resolve against IPromptContext.
const SEED_PROMPTS: SeedPrompt[] = [
  {
    type: 'general',
    name: 'Summarize this conversation',
    description: 'Condense the discussion so far into key points and decisions.',
    promptText:
      'Summarize our conversation so far into a short list of key points, decisions, and any open questions. Today is {{currentDate}}.',
    tags: ['starter', 'productivity'],
  },
  {
    type: 'general',
    name: 'Brainstorm ideas',
    description: 'Generate a spread of fresh ideas on a topic you provide.',
    promptText:
      'Brainstorm a diverse set of creative ideas about the following topic. Give me at least ten distinct options, then highlight the three most promising:\n\n',
    tags: ['starter', 'productivity'],
  },
  {
    type: 'writing',
    name: 'Improve this writing',
    description: 'Tighten and clarify a passage while keeping your voice.',
    promptText:
      'Improve the clarity, flow, and concision of the following text without changing its meaning or my voice. Return the revised version, then a short bullet list of what you changed:\n\n',
    tags: ['starter', 'writing'],
  },
  {
    type: 'writing',
    name: 'Draft a follow-up email',
    description: 'Turn a few notes into a polished, ready-to-send email.',
    promptText:
      'Draft a professional, friendly follow-up email from {{userName}} based on these notes. Keep it concise and end with a clear call to action:\n\n',
    tags: ['starter', 'writing'],
  },
  {
    type: 'learning',
    name: 'Explain it simply',
    description: 'Get a plain-language explanation of a tricky concept.',
    promptText:
      'Explain the following concept in plain language, as if to a curious beginner. Use a concrete analogy and avoid jargon:\n\n',
    tags: ['starter', 'learning'],
  },
];

const migration: MigrationFile = {
  id: 20260602000000,
  name: 'briefcase indexes and seed system prompts',

  up: async () => {
    // 1. Ensure indexes (idempotent).
    await BriefcasePrompt.createIndexes();

    // 2. Backfill schemaVersion on any legacy docs (idempotent - conditional).
    await BriefcasePrompt.updateMany({ schemaVersion: { $exists: false } }, { $set: { schemaVersion: 1 } });

    // 3. Seed starter system prompts (idempotent upsert on natural key).
    for (const seed of SEED_PROMPTS) {
      await BriefcasePrompt.updateOne(
        { userId: null, type: seed.type, name: seed.name },
        {
          $setOnInsert: {
            ...seed,
            userId: null,
            executionMode: 'inject',
            visibilityScopes: [],
            requiredTools: [],
            schemaVersion: 1,
            deletedAt: null,
          },
        },
        { upsert: true }
      );
    }
  },

  down: async () => {
    // Indexes are additive and dropping them risks a write-performance regression,
    // and the seeded prompts may have been edited or relied upon by users - so the
    // down is intentionally a no-op. Removal, if ever needed, should be a deliberate
    // forward migration, not an automatic rollback.
  },
};

export default migration;
