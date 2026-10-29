import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import dayjs from 'dayjs';

const h = vi.hoisted(() => ({
  generateDailyReport: vi.fn(),
  formatWeeklySlackMessage: vi.fn(),
  axiosPost: vi.fn(),
}));

vi.mock('sst', () => ({ Resource: { App: { stage: 'production' } } }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://x/%STAGE%' } }));
vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn(),
  counterLogRepository: {},
  adminSettingsRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  counterService: {
    generateDailyReport: h.generateDailyReport,
    generateAgnosticAiInsights: vi.fn().mockResolvedValue(null),
    formatWeeklySlackMessage: h.formatWeeklySlackMessage,
    formatCustomSlackMessage: vi.fn().mockReturnValue('daily'),
  },
}));
vi.mock('@bike4mind/utils', () => ({ getSettingsMap: vi.fn().mockResolvedValue({}) }));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  getEffectiveApiKeyByBackend: vi.fn(),
  OperationsModelService: { getOperationsModel: vi.fn().mockRejectedValue(new Error('no model')) },
}));
vi.mock('@server/integrations/slack/slack', () => ({ resolveSlackWebhookUrl: () => 'https://hooks.example.com/x' }));
vi.mock('axios', () => ({ default: { post: h.axiosPost } }));

import { handler, previousIsoWeek } from './userActivityReport';

const context = { awsRequestId: 'req', functionName: 'fn', functionVersion: '1' } as Parameters<typeof handler>[1];

describe('previousIsoWeek', () => {
  it.each([
    ['Monday 05:00 UTC, when the cron fires', '2026-10-26T05:00:00Z'],
    ['Monday 00:00 UTC', '2026-10-26T00:00:00Z'],
    ['Sunday 23:59 UTC', '2026-11-01T23:59:59Z'],
  ])('returns the last completed Monday..Sunday on %s', (_label, now) => {
    expect(previousIsoWeek(dayjs(now))).toEqual({ startDate: '2026-10-19', endDate: '2026-10-25' });
  });
});

describe('weekly user activity report handler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T05:00:00Z'));
    h.generateDailyReport.mockResolvedValue({ metrics: {}, userActivity: undefined });
    h.formatWeeklySlackMessage.mockReturnValue('weekly');
    h.axiosPost.mockResolvedValue({});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('reports the week that just ended, not the one that started at midnight', async () => {
    const result = await handler({ reportType: 'weekly' }, context);

    expect(h.generateDailyReport).toHaveBeenCalledWith(
      { date: '2026-10-19', startDate: '2026-10-19', endDate: '2026-10-25' },
      expect.anything()
    );
    expect(h.formatWeeklySlackMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ weekStart: '2026-10-19', weekEnd: '2026-10-25' })
    );
    expect(result).toEqual({ status: 'success', reportType: 'weekly', date: '2026-10-19 to 2026-10-25' });
  });
});
