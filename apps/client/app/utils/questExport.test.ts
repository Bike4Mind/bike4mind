import { describe, expect, it } from 'vitest';
import type { IQuestMasterPlanDocument } from '@bike4mind/common';
import { questPlanToCSV } from './questExport';

const plan = (title: string) =>
  ({
    quests: [{ title, complexity: 'low', subQuests: [{ title: '\t=cmd', status: 'pending' }] }],
  }) as unknown as IQuestMasterPlanDocument;

describe('questPlanToCSV', () => {
  it('prefixes cells that start with formula characters', () => {
    const csv = questPlanToCSV(plan('=SUM(A1)\nnext'));
    expect(csv).toContain(`"'=SUM(A1)\nnext"`);
    expect(csv).toContain(`"'\t=cmd"`);
  });
});
