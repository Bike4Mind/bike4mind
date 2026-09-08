import { SUBQUEST_STATUS_VALUES } from '@bike4mind/common';
import type { Schema } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { QuestMasterDataSchema } from './QuestMasterPlanModel';

/**
 * Persistence half of the sub-quest status drift guard - the zod half lives in
 * b4m-core/common/src/schemas/questmaster.test.ts. The two layers once carried
 * divergent enums with divergent initial states, so these pin the mongoose
 * enum and its default to the canonical vocabulary. Reads the compiled schema
 * rather than the source list so a literal reintroduced here still fails.
 */
describe('QuestMasterDataSchema sub-quest status', () => {
  const subQuestSchema = (QuestMasterDataSchema.path('subQuests') as unknown as { schema: Schema }).schema;
  const statusPath = subQuestSchema.path('status') as unknown as {
    enumValues: string[];
    defaultValue: unknown;
  };

  it('persists exactly the canonical vocabulary', () => {
    expect(statusPath.enumValues).toEqual([...SUBQUEST_STATUS_VALUES]);
  });

  it('defaults to the same initial state the artifact zod layer defaults to', () => {
    expect(statusPath.defaultValue).toBe('not_started');
  });
});
