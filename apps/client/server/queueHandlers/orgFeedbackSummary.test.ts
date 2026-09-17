import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The org feedback summary worker. Two things here are worth a test rather than a reading:
 * what reaches the LLM (counts, never text or member names), and that a failure tells the waiting
 * browser before it rethrows - the rethrow is what sends the message to SQS retries and then to
 * the quest-export DLQ, and neither of those is visible from the client.
 */

const h = vi.hoisted(() => ({
  findOne: vi.fn(),
  updateOne: vi.fn(async () => ({})),
  orgFeedbackReport: vi.fn(),
  findMemberUserIds: vi.fn(async () => ({ userIds: ['u1'], aclOnly: [], stampOnly: [] })),
  complete: vi.fn(),
  upload: vi.fn(async () => undefined),
  sendToClient: vi.fn(async () => undefined),
}));

vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, { get: () => new Proxy({}, { get: () => 'mock' }) }),
}));

vi.mock('@bike4mind/common', () => ({
  ChatModels: { CLAUDE_4_5_HAIKU_BEDROCK: 'claude-haiku' },
  ORG_FEEDBACK_SUMMARY_JOB_TYPE: 'orgFeedbackSummary',
}));

vi.mock('@bike4mind/database', () => ({
  OrgFeedbackSummaryJob: { findOne: h.findOne, updateOne: h.updateOne },
  orgFeedbackReport: h.orgFeedbackReport,
  apiKeyRepository: {},
  adminSettingsRepository: {},
}));

vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { findMemberUserIds: h.findMemberUserIds },
}));

vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));
vi.mock('@bike4mind/observability', () => ({ Logger: class {} }));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: vi.fn(async () => ({ anthropic: 'k' })) },
}));
vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: vi.fn(async () => [{ id: 'claude-haiku' }]),
  getLlmByModel: vi.fn(() => ({ complete: h.complete })),
}));
vi.mock('@bike4mind/fab-pipeline', () => ({
  S3Storage: class {
    upload = h.upload;
  },
}));
vi.mock('@server/websocket/utils', () => ({ sendToClient: h.sendToClient }));

import { runOrgFeedbackSummary, summaryS3Key } from './orgFeedbackSummary';

const SUMMARY_JOB_ID = 'job-1';
const ORG_ID = 'org-1';
const MEMBER_NAME = 'Casey Member';

const message = {
  jobType: 'orgFeedbackSummary' as const,
  summaryJobId: SUMMARY_JOB_ID,
  organizationId: ORG_ID,
  startDate: '2026-08-01T00:00:00.000Z',
  endDate: '2026-08-31T23:59:59.999Z',
  userId: 'requester-1',
};

const makeLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the worker takes the real Logger
const run = (logger = makeLogger()) => runOrgFeedbackSummary(message, logger as any);

const frames = () => h.sendToClient.mock.calls.map(call => call[2] as { status: string; errorMessage?: string });

beforeEach(() => {
  vi.clearAllMocks();
  h.findOne.mockResolvedValue({ summaryJobId: SUMMARY_JOB_ID, status: 'pending' });
  h.orgFeedbackReport.mockResolvedValue({
    range: { from: message.startDate, to: message.endDate },
    totals: { count: 7 },
    byDay: [{ day: '2026-08-02', count: 7 }],
    bySubject: [{ key: 'chat', count: 7 }],
    byType: [{ key: 'bug', count: 5 }],
    byStatus: [{ key: 'open', count: 6 }],
    byTag: [{ key: 'slow', count: 3 }],
    byMember: [{ userId: 'u1', displayName: MEMBER_NAME, count: 7 }],
    membership: { memberCount: 1, aclOnly: [], stampOnly: [] },
  });
  h.complete.mockImplementation(async (_model, _messages, _opts, onText) => {
    await onText(['Feedback was steady across the window.']);
  });
});

describe('runOrgFeedbackSummary', () => {
  it('sends the LLM counts only - no member names', async () => {
    await run();

    const prompt = JSON.stringify(h.complete.mock.calls[0][1]);
    expect(prompt).toContain('bug: 5');
    expect(prompt).toContain('Total items: 7');
    expect(prompt).not.toContain(MEMBER_NAME);
    expect(prompt).not.toContain('u1');
  });

  it('writes the artifact and releases the window on success', async () => {
    await run();

    const [payload, key] = h.upload.mock.calls[0];
    expect(key).toBe(summaryS3Key(ORG_ID, SUMMARY_JOB_ID));
    expect(JSON.parse(payload as string)).toMatchObject({
      summaryJobId: SUMMARY_JOB_ID,
      summary: 'Feedback was steady across the window.',
      counts: { totals: { count: 7 } },
    });
    // activeKey moving to the job's own id is what frees this window for a re-run.
    expect(h.updateOne).toHaveBeenLastCalledWith(
      { summaryJobId: SUMMARY_JOB_ID },
      { status: 'completed', s3Key: key, activeKey: SUMMARY_JOB_ID }
    );
    expect(frames().map(f => f.status)).toEqual(['processing', 'processing', 'completed']);
  });

  it('reports the failure to the client before rethrowing to SQS', async () => {
    h.complete.mockRejectedValue(new Error('bedrock unavailable'));

    await expect(run()).rejects.toThrow('bedrock unavailable');

    const failed = frames().at(-1);
    expect(failed).toMatchObject({ status: 'failed', errorMessage: 'bedrock unavailable' });
    expect(h.updateOne).toHaveBeenLastCalledWith(
      { summaryJobId: SUMMARY_JOB_ID },
      { status: 'failed', errorMessage: 'bedrock unavailable', activeKey: SUMMARY_JOB_ID }
    );
  });

  it('drops a redelivery whose job row has aged out', async () => {
    h.findOne.mockResolvedValue(null);
    const logger = makeLogger();

    await run(logger);

    expect(logger.warn).toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.sendToClient).not.toHaveBeenCalled();
  });

  it('re-emits completion instead of paying for a second LLM pass', async () => {
    h.findOne.mockResolvedValue({ summaryJobId: SUMMARY_JOB_ID, status: 'completed' });

    await run();

    expect(h.complete).not.toHaveBeenCalled();
    expect(frames()).toEqual([
      {
        summaryJobId: SUMMARY_JOB_ID,
        organizationId: ORG_ID,
        status: 'completed',
        progress: 100,
        action: 'org_feedback_summary_progress',
      },
    ]);
  });
});
