import { describe, expect, it } from 'vitest';
import { CreditHolderType, type IUsageDashboardResponse } from '@bike4mind/common';
import { usageCsv } from './usageCsv';

describe('usageCsv', () => {
  it('exports the selected period and all breakdowns without inventing project attribution or key COGS', () => {
    const bucket = { requests: 1, cogsUsd: 0.01, creditsCharged: 10 };
    const data: IUsageDashboardResponse = {
      ownerId: 'org-1',
      ownerType: CreditHolderType.Organization,
      days: 7,
      totals: bucket,
      overTime: [{ day: '2026-11-01', ...bucket }],
      byMember: [{ userId: 'u1', userName: '=SUM(1,2)', ...bucket }],
      byModel: [{ provider: 'provider', model: 'model', ...bucket }],
      byFeature: [{ feature: 'chat', ...bucket }],
      byProject: [
        { projectId: null, ...bucket },
        { projectId: 'p1', ...bucket },
      ],
      byApiKey: [
        { apiKeyId: 'k1', keyName: 'Key, "one"', requests: 2, creditsSpent: 20, inputTokens: 100, outputTokens: 50 },
      ],
      bySource: [{ source: 'web', requests: 2, creditsSpent: 20 }],
      ledger: { creditsCharged: 20, transactions: 2 },
    };
    const csv = usageCsv(data);
    expect(csv).toContain('"org-1","7","project","","Unassigned","1","10","0.01"');
    expect(csv).toContain('"project","p1","p1"');
    expect(csv).toContain('"api_key_ledger","k1","Key, ""one""","2","20","","100","50"');
    expect(csv).toContain('"\'=SUM(1,2)"');
    expect(csv).toContain('"day","2026-11-01"');
    expect(csv).toContain('"model","provider/model"');
    expect(csv).toContain('"source_ledger","web","web","2","20",""');
  });
});
