import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ listAiAbuseAdvisories: vi.fn() }));
vi.mock('@server/admin/aiAdvisory/aiAbuseAdvisories', () => ({ listAiAbuseAdvisories: h.listAiAbuseAdvisories }));

import { adminUsersPipeline } from './listAdminUsers';

const NOW = new Date('2026-11-05T12:00:00.000Z');

beforeEach(() => h.listAiAbuseAdvisories.mockReset());

describe('adminUsersPipeline aiVerdict cohort', () => {
  it('reads the advisory without linked-account discovery', async () => {
    h.listAiAbuseAdvisories.mockResolvedValue({ advisories: [{ userId: 'a'.repeat(24) }] });

    await adminUsersPipeline({ aiVerdict: 'abuse' } as never, NOW);

    expect(h.listAiAbuseAdvisories).toHaveBeenCalledWith(NOW, { includeLinkedAccounts: false });
  });
});
