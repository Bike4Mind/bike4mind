import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZodError } from 'zod';

// Spy on the extracted logic functions - the merged handler's job is purely to
// validate + route, so the handlers themselves are mocked out.
const mockRunSreAnalysis = vi.fn();
const mockAccounting = { attribution: { executionId: 'test-execution' } };
vi.mock('@bike4mind/services/sreAgentService', () => ({
  isSreAccountingError: (error: unknown) => error instanceof Error && 'reason' in error,
}));
vi.mock('./sreQueueAccounting', () => ({ createSreQueueAccounting: () => mockAccounting }));
const mockRunSreRevision = vi.fn();

vi.mock('./sreAnalysis', () => ({
  runSreAnalysis: (...args: unknown[]) => mockRunSreAnalysis(...args),
}));
vi.mock('./sreRevision', () => ({
  runSreRevision: (...args: unknown[]) => mockRunSreRevision(...args),
}));

// Passthrough so `dispatch` is the raw (event, ctx, logger) handler.
vi.mock('@bike4mind/server-utils/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
}));

// Intentionally NOT mocking @bike4mind/common - we want the real
// SreJobMessageSchema discriminated union to validate/route here.

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  log: vi.fn(),
  updateMetadata: vi.fn(),
} as never;

import { dispatch } from './sreJob';
import { SreSourceType, SreClassification } from '@bike4mind/common';

function makeSqsEvent(body: Record<string, unknown>) {
  return { Records: [{ body: JSON.stringify(body) }] } as never;
}

const analysisBody = {
  jobType: 'analysis',
  source: SreSourceType.CLOUDWATCH,
  fingerprint: 'fp-1',
  classification: SreClassification.MEDIUM,
  errorMessage: 'boom',
};

const revisionBody = {
  jobType: 'revision',
  trackingId: 'track-1',
  fingerprint: 'fp-1',
  branchName: 'sre-fix/abc',
  prNumber: 42,
  originalDiagnosis: {
    rootCause: 'rc',
    proposedFix: 'pf',
    confidence: 80,
    riskAssessment: 'low',
    affectedFiles: [],
  },
  source: SreSourceType.GITHUB_ISSUE,
};

describe('sreJob handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes jobType: 'analysis' to runSreAnalysis", async () => {
    await dispatch(makeSqsEvent(analysisBody), { getRemainingTimeInMillis: () => 480000 } as never, mockLogger);

    expect(mockRunSreAnalysis).toHaveBeenCalledTimes(1);
    expect(mockRunSreRevision).not.toHaveBeenCalled();
    const [payload] = mockRunSreAnalysis.mock.calls[0];
    expect(payload.jobType).toBe('analysis');
    expect(payload.fingerprint).toBe('fp-1');
  });

  it("routes jobType: 'revision' to runSreRevision", async () => {
    await dispatch(makeSqsEvent(revisionBody), { getRemainingTimeInMillis: () => 480000 } as never, mockLogger);

    expect(mockRunSreRevision).toHaveBeenCalledTimes(1);
    expect(mockRunSreAnalysis).not.toHaveBeenCalled();
    const [request] = mockRunSreRevision.mock.calls[0];
    expect(request.jobType).toBe('revision');
    expect(request.prNumber).toBe(42);
  });

  it('rejects an unknown jobType discriminator', async () => {
    await expect(
      dispatch(
        makeSqsEvent({ ...analysisBody, jobType: 'bogus' }),
        { getRemainingTimeInMillis: () => 480000 } as never,
        mockLogger
      )
    ).rejects.toThrow(ZodError);
    expect(mockRunSreAnalysis).not.toHaveBeenCalled();
    expect(mockRunSreRevision).not.toHaveBeenCalled();
  });

  it('rejects a message missing required payload fields', async () => {
    await expect(
      dispatch(makeSqsEvent({ jobType: 'analysis' }), { getRemainingTimeInMillis: () => 480000 } as never, mockLogger)
    ).rejects.toThrow(ZodError);
    expect(mockRunSreAnalysis).not.toHaveBeenCalled();
  });
});

it.each(['analysis', 'revision'])('propagates %s accounting failures to the queue', async jobType => {
  const error = new Error('accounting pending');
  const handler = jobType === 'analysis' ? mockRunSreAnalysis : mockRunSreRevision;
  handler.mockRejectedValueOnce(error);
  await expect(
    dispatch(
      makeSqsEvent(jobType === 'analysis' ? analysisBody : revisionBody),
      { getRemainingTimeInMillis: () => 480000 } as never,
      mockLogger
    )
  ).rejects.toBe(error);
});
