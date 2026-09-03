import { IQuestMasterPlanDocument } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { questPlanToCSV, questPlanToJSON, questPlanToMarkdown } from '../questExport';

/**
 * What the export surfaces do with a NON-CANONICAL status that is already on disk.
 *
 * Reachable because the mongoose enum on the sub-quest status path only runs on create - every
 * status write is an unvalidated `$set` (pinned in
 * packages/database/src/__test__/questMasterPlanLegacyStatus.test.ts). These exports are
 * therefore the read path most likely to meet a retired token, so what they do with one has to
 * be a deliberate choice rather than an accident.
 *
 * `pending` / `in-progress` are the retired V2 artifact vocabulary; `blocked` is the retired V1
 * repository vocabulary.
 */
const legacyPlan = {
  id: 'plan-legacy',
  goal: 'Plan holding retired status tokens',
  state: 'active',
  tags: [],
  metrics: { totalTimeSpent: 0, completionRate: 25, subQuestsCompleted: 1, subQuestsTotal: 4 },
  quests: [
    {
      id: 'quest-1',
      title: 'Quest with legacy rows',
      description: 'One canonical row and three retired ones.',
      complexity: 'Medium',
      subQuests: [
        { id: 'sq-1', title: 'Canonical completed row', status: 'completed' },
        { id: 'sq-2', title: 'Retired hyphenated row', status: 'in-progress' },
        { id: 'sq-3', title: 'Retired pending row', status: 'pending' },
        { id: 'sq-4', title: 'Retired blocked row', status: 'blocked' },
      ],
    },
  ],
} as unknown as IQuestMasterPlanDocument;

describe('quest export with legacy statuses on disk', () => {
  it('never throws on a retired token - every export stays available', () => {
    // The load-bearing property. An export that crashed would strand the user with no way to
    // get their plan out, which is far worse than a cosmetically wrong status cell.
    expect(() => questPlanToMarkdown(legacyPlan)).not.toThrow();
    expect(() => questPlanToJSON(legacyPlan)).not.toThrow();
    expect(() => questPlanToCSV(legacyPlan)).not.toThrow();
  });

  it('round-trips the retired token verbatim in JSON rather than inventing a value', () => {
    const parsed = JSON.parse(questPlanToJSON(legacyPlan));
    const statuses = parsed.quests[0].subQuests.map((sq: { status: string }) => sq.status);

    // JSON is the archival format, so silently rewriting a status here would destroy the only
    // evidence of what the row actually held.
    expect(statuses).toEqual(['completed', 'in-progress', 'pending', 'blocked']);
  });

  it('falls back to the raw token as its own label rather than rendering blank', () => {
    const csv = questPlanToCSV(legacyPlan);

    // getStatusLabel's `?? status` arm. Unlabelled is better than mislabelled: the user sees
    // that the row is odd instead of being told it is Not Started.
    expect(csv).toContain('in-progress');
    expect(csv).toContain('pending');
    expect(csv).toContain('blocked');
  });

  it('emits no icon for a retired token instead of a wrong one', () => {
    const md = questPlanToMarkdown(legacyPlan);
    const legacyLine = md.split('\n').find(line => line.includes('Retired hyphenated row'));

    expect(legacyLine).toBeDefined();
    // Canonical rows get a glyph; a retired one deliberately gets none.
    expect(legacyLine).not.toContain('✓');
    expect(legacyLine).not.toContain('\u{1F504}');
    expect(md.split('\n').find(line => line.includes('Canonical completed row'))).toContain('✓');
  });

  it('keeps every sub-quest present in every format - none is dropped for being unrecognized', () => {
    const md = questPlanToMarkdown(legacyPlan);
    const csv = questPlanToCSV(legacyPlan);

    for (const title of [
      'Canonical completed row',
      'Retired hyphenated row',
      'Retired pending row',
      'Retired blocked row',
    ]) {
      expect(md).toContain(title);
      expect(csv).toContain(title);
    }
  });
});
