import { describe, expect, it } from 'vitest';
import { SUBQUEST_STATUS_VALUES } from '../types/entities/QuestTypes';
import { QuestSchema, QuestStatusSchema } from './questmaster';

/**
 * Drift guard for the canonical sub-quest status vocabulary. The artifact zod
 * layer and the persistence layer once carried divergent enums (hyphenated
 * `in-progress`, a `pending` initial state, and no `deleted`), so any code
 * moving a status across the boundary had to translate and nothing enforced it.
 * These pin the three divergences shut.
 */
describe('QuestStatusSchema', () => {
  it('accepts exactly the canonical vocabulary', () => {
    expect(QuestStatusSchema.options).toEqual([...SUBQUEST_STATUS_VALUES]);
  });

  it('rejects the hyphenated spelling the artifact layer used to accept', () => {
    expect(QuestStatusSchema.safeParse('in-progress').success).toBe(false);
    expect(QuestStatusSchema.safeParse('in_progress').success).toBe(true);
  });

  it('accepts the deleted terminal state the artifact layer used to omit', () => {
    expect(QuestStatusSchema.safeParse('deleted').success).toBe(true);
  });

  it('rejects the pending initial state the artifact layer used to default to', () => {
    expect(QuestStatusSchema.safeParse('pending').success).toBe(false);
  });

  it('defaults an omitted status to the same initial state the DB defaults to', () => {
    const quest = QuestSchema.parse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      title: 'Set up the project',
      description: 'Scaffold the repo',
      order: 0,
    });

    expect(quest.status).toBe('not_started');
  });
});
